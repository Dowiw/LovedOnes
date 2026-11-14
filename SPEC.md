# Project Specification: Self-Hosted Group Location & Messaging Platform
**License:** GNU Affero General Public License v3.0 (AGPLv3)
**Target Architectures:** `linux/amd64` (Windows WSL2 / x86 VPS) and `linux/arm64` (Raspberry Pi 5)
**Monorepo Tooling:** `pnpm` workspaces + `Turborepo`

---

## 1. System Architecture & Services

The system is a decoupled microservices appliance orchestrated via Docker Compose. All internal services communicate over an isolated Docker bridge network (`internal_net`) and a shared Redis instance.

### 1.1 Infrastructure & Ingress Containers
* **`gateway` (Caddy 2 Alpine):** Single HTTP/WebSocket entry point. Routes traffic by path or subdomain:
  * `/api/auth/*` and `/api/admin/*` -> `auth-admin-service:4001`
  * `/api/realtime/*` and `/socket.io/*` -> `realtime-service:4002`
  * `/tiles/*` -> `map-service:8080`
  * `/*` -> `web-dashboard:3000`
* **`cloudflared` (Optional Profile):** Official `cloudflare/cloudflared` container for zero-port-forward residential/Raspberry Pi 5 hosting. Connects directly to `http://gateway:80`.
* **`postgres` (`postgis/postgis:16-3.4-alpine`):** Primary relational and spatial datastore.
* **`redis` (`redis:7-alpine`):** Pub/Sub message broker, Socket.io adapter, live log ring-buffer, and per-user telemetry counter store.

### 1.2 Application Microservices & Clients (Monorepo Packages)
1. **`packages/shared`:** Shared TypeScript interfaces, Zod validation schemas, Socket.io event payloads, and Pino logger configuration.
2. **`apps/auth-admin-service` (Node.js 22 + Fastify + TypeScript):**
   * User authentication (JWT access + refresh tokens, Argon2id password hashing).
   * Role-Based Access Control (RBAC) group management (`ADMIN`, `MEMBER`, `SPECTATOR`).
   * One-time invite token & QR onboarding payload generator.
   * System & per-user telemetry engine (disk space, log sizes, DB size per user, Redis memory & compute load per user).
3. **`apps/realtime-service` (Node.js 22 + Fastify + Socket.io + TypeScript):**
   * Stateless, horizontally scalable WebSocket + REST ingestion service using `@socket.io/redis-adapter`.
   * Ingests live GPS batches and chat messages, persists to PostGIS, and broadcasts to authorized group rooms.
   * Enforces privacy modes per group (`ACTIVE`, `GHOST`, `FUZZED_1KM`).
4. **`apps/map-service` (Caddy / Go Static Range Server):**
   * Serves static `.pmtiles` OpenStreetMap archives and MapLibre `style.json` / glyphs via HTTP Range Requests (`Accept-Ranges: bytes`) with CORS enabled.
5. **`apps/web-dashboard` (Next.js + Tailwind CSS + TypeScript + MapLibre GL JS):**
   * **User Portal:** Browser-accessible live map (using the `pmtiles` JS protocol plugin), group chat, and optional foreground Web Geolocation sharing (designed for iOS Safari / desktop users).
   * **Admin Portal (`/admin`):** QR invite generator, live scrolling `STDOUT` log terminal via WebSockets, storage alerts, and per-user compute/memory breakdown.
6. **`apps/mobile-app` (React Native + Expo SDK 58 + TypeScript):**
   * Native Android & iOS client using `expo-dev-client`, `expo-location`, `expo-task-manager`, and `@maplibre/maplibre-react-native` (v11+ New Architecture).
   * Supports QR code onboarding scan, offline SQLite location queue when disconnected, native PMTiles map rendering (`pmtiles://https://...` and local cached `pmtiles://file://...`), and OTA updates via `expo-updates`.

---

## 2. Monorepo Directory Structure

```text
/
├── apps/
│   ├── auth-admin-service/     # Fastify REST API: Auth, Groups, Invites, Telemetry
│   ├── realtime-service/       # Fastify + Socket.io: GPS Ingestion & Group Chat
│   ├── map-service/            # Static HTTP Range Request server for PMTiles & styles
│   ├── web-dashboard/          # Next.js App Router: User Map UI + Admin Console
│   └── mobile-app/             # Expo React Native App (Android & iOS)
├── packages/
│   ├── shared/                 # Shared Zod schemas, TS types, Pino logger transport
│   └── db/                     # Drizzle ORM schema & PostGIS migrations
├── infra/
│   ├── caddy/Caddyfile         # Reverse proxy & PMTiles static range-request server
│   └── tiles/                  # Mounted volume for regional .pmtiles files & fonts
├── logs/                       # Mounted host volume (/var/log/app) for rotating logs
├── docker-compose.yml          # Production & Pi 5 multi-arch stack
├── docker-compose.dev.yml      # Local WSL2 dev overrides (Postgres, Redis, Caddy)
├── turbo.json
└── pnpm-workspace.yaml
```

---

## 3. Database Schema (PostgreSQL + PostGIS)

Enable extensions on initialization:

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
```

### 3.1 Core Tables

```sql
CREATE TYPE system_role AS ENUM ('HOST_ADMIN', 'USER');
CREATE TYPE group_role AS ENUM ('ADMIN', 'MEMBER', 'SPECTATOR');
CREATE TYPE privacy_mode AS ENUM ('EXACT', 'FUZZED', 'GHOST');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(64) NOT NULL,
    password_hash TEXT NOT NULL,
    role system_role DEFAULT 'USER',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE group_memberships (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    role group_role DEFAULT 'MEMBER',
    privacy privacy_mode DEFAULT 'EXACT',
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, group_id)
);

CREATE TABLE group_invites (
    token VARCHAR(128) PRIMARY KEY,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    assigned_role group_role DEFAULT 'MEMBER',
    created_by UUID REFERENCES users(id) ON DELETE CASCADE,
    max_uses INT DEFAULT 1,
    uses INT DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE location_history (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    coords GEOGRAPHY(Point, 4326) NOT NULL,
    altitude DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    battery_level SMALLINT,
    recorded_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_location_user_time ON location_history (user_id, recorded_at DESC);
CREATE INDEX idx_location_gist ON location_history USING GIST (coords);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_group_time ON messages (group_id, created_at DESC);
```

---

## 4. Onboarding, Logging & Telemetry Specifications

### 4.1 Zero-Config QR Invite Flow

1. Host Admin opens `/admin/invites` on `web-dashboard` (accessible via LAN IP or Cloudflare Tunnel URL).
2. Admin selects a Group, Role, and Expiration, triggering `POST /api/admin/invites`.
3. `auth-admin-service` returns a JSON payload and deep link:
```json
{
  "v": 1,
  "serverUrl": "https://track.example.com",
  "inviteToken": "inv_9f8a7d6c5b4a3f2e1d",
  "groupName": "Family Group"
}
```
4. Dashboard renders both a scannable QR code and a copyable web invite URL (`https://track.example.com/join?token=inv_...`).
5. Scanning the QR code in `mobile-app` automatically sets the dynamic backend base URL in `expo-secure-store` and completes registration.

### 4.2 Dual Logging (`STDOUT` + Rotating Disk File + Live Admin Stream)

Every microservice must use the shared logger in `packages/shared/logger`:

* **Format:** Structured NDJSON via `pino`.
* **Target 1 (`STDOUT`):** Standard output for Docker container logs.
* **Target 2 (Physical Rotating File):** `pino-roll` writing to `/var/log/app/service.log` (rotated daily or at `50MB`, max 10 files retained).
* **Target 3 (Live Redis Stream):** Custom Pino transport pushes each serialized log entry into Redis list `logs:ring` (`LPUSH` + `LTRIM 0 499`) and publishes to Redis channel `logs:stream`. The Admin Dashboard subscribes to `logs:stream` to display a live terminal feed.

### 4.3 Storage & Per-User Compute/RAM Telemetry

`auth-admin-service` exposes `GET /api/admin/telemetry` (polled every 5s or streamed via WebSocket):

1. **Disk & Log Storage:**
   * Reads `/var/log/app` total directory size via `fs.promises.stat` and compares against `MAX_LOG_STORAGE_MB` env var.
   * Queries PostgreSQL total database size (`pg_database_size(current_database())`).
2. **Per-User Database Footprint:**
```sql
SELECT u.id, u.username,
  COALESCE(SUM(pg_column_size(lh.*)), 0) AS location_bytes,
  COUNT(lh.id) AS location_points
FROM users u
LEFT JOIN location_history lh ON lh.user_id = u.id
GROUP BY u.id;
```
3. **Per-User Compute & Memory Attribution:**
   * A Fastify/Socket.io middleware wraps every authenticated request and WebSocket event with `performance.now()`.
   * Increments Redis hash counters per user (`HINCRBYFLOAT telemetry:user:<id> cpu_ms <elapsed>`, `HINCRBY telemetry:user:<id> events_count 1`) and measures Redis state size (`MEMORY USAGE session:user:<id>`).
   * Admin UI renders a table of active users ranked by `cpu_ms/min`, `pings/min`, active socket count, and storage consumed.
