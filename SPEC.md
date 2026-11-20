# Project Specification: Self-Hosted Group Location & Messaging Platform
**Target Architectures:** `linux/amd64` and `linux/arm64` (cloud VMs, bare-metal Linux servers, macOS/Linux/WSL2 workstations, and ARM64 edge/SBC hosts)
**Monorepo Tooling:** `pnpm` workspaces + `Turborepo`

---

## 1. System Architecture & Services

The system is a decoupled microservices platform orchestrated via containers or local workspace processes and designed to run either as a single-node appliance or scaled horizontally behind any reverse proxy or load balancer. All application services are stateless and coordinate through a spatial SQL database and Redis-compatible pub/sub store.

### 1.1 Infrastructure & Ingress Services
* **`gateway` (Reverse Proxy):** Single HTTP/WebSocket entry point (bundled with Caddy 2, or replaceable by any external reverse proxy / cloud load balancer). Routes traffic by path or subdomain:
  * `/api/auth/*` and `/api/admin/*` -> `auth-admin-service:4001`
  * `/api/realtime/*` and `/socket.io/*` -> `realtime-service:4002`
  * `/tiles/*` -> served directly from `/srv/tiles` with `Accept-Ranges: bytes` + CORS (`apps/map-service` remains available via optional `standalone-maps` profile)
  * `/*` -> `web-dashboard:3000`
* **`tunnel` (Optional Profile):** Optional encrypted ingress connector for zero-port-forward hosting on NATted or firewalled networks (bundled example uses `cloudflared`), forwarding directly to `http://gateway:80`.
* **`postgres` (Spatial Relational Store):** Primary PostgreSQL/PostGIS datastore (supports multi-arch container images or any external `DATABASE_URL`).
* **`redis` (Broker & Cache):** Pub/Sub message broker, WebSocket adapter, live log ring-buffer, session store, and per-user telemetry counter store (supports local container or external `REDIS_URL`).

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
4. **`apps/map-service` (Optional Standalone Range Server / `standalone-maps` Profile):**
   * Serves static `.pmtiles` vector archives and map styles/glyphs via HTTP Range Requests (`Accept-Ranges: bytes`) with CORS enabled for custom/standalone deployments (`gateway` serves `/tiles/*` directly in the default stack).
5. **`apps/web-dashboard` (Web Portal):**
   * **User Portal:** Browser-accessible live map, group chat, check-in requests, geofenced places, and optional foreground Web Geolocation sharing across desktop and mobile web browsers.
   * **Admin Portal (`/admin`):** QR invite generator, live scrolling `STDOUT` log terminal via WebSockets, storage alerts, and per-user compute/memory breakdown.
6. **`apps/mobile-app` (Native Mobile Client):**
   * Native Android & iOS client with QR onboarding, offline SQLite location queue when disconnected, native PMTiles map rendering (`pmtiles://https://...` and local cached `pmtiles://file://...`), and OTA updates.

### 1.3 Scaling Across Systems & Topologies
* **Stateless Horizontal Scaling:** Multiple replicas of `auth-admin-service` (stateless JWTs + Redis sessions) and `realtime-service` (`@socket.io/redis-adapter`) can run behind any L7 load balancer or reverse proxy without sticky state in process memory.
* **Edge & Cloud Storage Options:** Static `.pmtiles` archives served via HTTP Byte-Range requests can sit behind CDN caching or object storage proxies for multi-region clients.

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
├── docker-compose.yml          # Multi-arch production stack (amd64 / arm64)
├── docker-compose.dev.yml      # Local dev backing services (Postgres, Redis, Caddy)
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

1. Host Admin opens `/admin/invites` on `web-dashboard` (accessible via local network IP or public HTTPS origin).
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
