# Project Specification: Self-Hosted Group Location & Messaging Platform
**Target Architectures:** `linux/amd64` and `linux/arm64` (cloud VMs, bare-metal Linux servers, macOS/Linux/WSL2 workstations, and ARM64 edge/SBC hosts)
**Monorepo Tooling:** `pnpm` workspaces + `Turborepo`

---

## 1. System Architecture & Services

The system is a decoupled microservices platform orchestrated via containers or local workspace processes and designed to run either as a single-node appliance or scaled horizontally behind any reverse proxy or load balancer. All application services are stateless and coordinate through a spatial SQL database and Redis-compatible pub/sub store.

### 1.1 Infrastructure & Ingress Services
* **`gateway` (Reverse Proxy):** Single HTTP/WebSocket entry point (bundled with Caddy 2, or replaceable by any external reverse proxy / cloud load balancer). Routes traffic by path or subdomain:
  * `/api/auth/*`, `/api/admin/*`, and `/api/maps/*` -> `auth-admin-service:4001`
  * `/api/realtime/*` and `/socket.io/*` -> `realtime-service:4002`
  * `/tiles/*` -> served directly from `/srv/tiles` with `Accept-Ranges: bytes` + CORS (`apps/map-service` remains available via optional `standalone-maps` profile)
  * `/*` -> `web-dashboard:3000`
* **`tunnel` (Optional Profile):** Optional encrypted ingress connector for zero-port-forward hosting on NATted or firewalled networks (bundled example uses `cloudflared`), forwarding directly to `http://gateway:80`.
* **`postgres` (Spatial Relational Store):** Primary PostgreSQL/PostGIS datastore (supports multi-arch container images or any external `DATABASE_URL`).
* **`redis` (Broker & Cache):** Pub/Sub message broker, WebSocket adapter, live log ring-buffer, session store, and per-user telemetry counter store (supports local container or external `REDIS_URL`).

### 1.2 Application Microservices & Clients (Monorepo Packages)
1. **`packages/shared`:** Shared TypeScript interfaces, Zod validation schemas, Socket.io event payloads, and Pino logger configuration.
2. **`apps/auth-admin-service` (Node.js 22 + Fastify + TypeScript):**
   * User authentication (JWT access + refresh tokens, Argon2id password hashing, optional backup recovery-email verification and password reset).
   * Registration approval queue (`registration_requests`: uninvited onboarding requests expire after 24h unless approved/denied by `HOST_ADMIN`).
   * Role-Based Access Control (RBAC) group management (`ADMIN`, `MEMBER`, `SPECTATOR`), group creation (`POST /api/auth/groups`), and scoped HTTP `TrackerToken` management.
   * One-time invite token & QR onboarding payload generator (`HOST_ADMIN` or Group `ADMIN` via `requireAdmin`).
   * System & per-user telemetry engine (disk space, log sizes & retention/pruning, DB size per user, Redis memory & compute load per user), dynamic city PMTiles downloader/region management, and optional remote `system-updater` control (`HOST_ADMIN`).
3. **`apps/realtime-service` (Node.js 22 + Fastify + Socket.io + TypeScript):**
   * Stateless, horizontally scalable WebSocket + REST ingestion service using `@socket.io/redis-adapter`.
   * Ingests live GPS batches (interactive JWT + scoped `TrackerToken` via native/OwnTracks/Overland endpoints), persists to PostGIS, evaluates geofenced `group_places` enter/exit transitions, and broadcasts to authorized group rooms.
   * Enforces privacy modes per group (`EXACT`, `FUZZED`, `GHOST`) plus temporary check-in `EXACT` overrides (`privacy_override_until`).
   * Manages group chat (`messages`), Web Push VAPID notifications (`push_subscriptions`), and isolated public temporary share links (`/api/realtime/share-links` + `/api/realtime/public/share/:token`).
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
* **Mandatory User & Admin Action Auditing:** Every state-changing action performed by any user, guest, Group `ADMIN`, or `HOST_ADMIN` across every backend service MUST emit a structured `logger.info({ action, ... }, humanReadableMessage)` audit record through this 3-way logger so `/admin` operators have a complete live audit trail—while redacting secrets, passwords, raw tokens, and encryption keys.

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

---

## 5. Actors, Role Hierarchy & Permissions

### 5.1 System Infrastructure Summary

- **Ingress (`gateway` Caddy 2):** Terminates public/LAN HTTP(S) and routes `/api/auth/*` + `/api/admin/*` + `/api/maps/*` -> `auth-admin-service:4001`, `/api/realtime/*` + `/socket.io/*` -> `realtime-service:4002`, `/tiles/*` -> static `/srv/tiles` Byte-Range serving (or `map-service:8080`), and all UI pages (`/`, `/admin`, `/admin/invites`, `/join`, `/share/[token]`) -> `web-dashboard:3000`.
- **Backing Stores:** Shared PostgreSQL + PostGIS (`users`, `groups`, `group_memberships`, `group_invites`, `location_history`, `messages`, `location_requests`, `group_places`, `group_place_states`, `group_place_events`, `registration_requests`, `push_vapid_config`, `push_subscriptions`, `location_share_links`, `location_share_guests`) plus Redis (Socket.io adapter, session/revocation state, `logs:ring` / `logs:stream`, `telemetry:user:<id>`, tracker tokens, email verification challenges, log retention settings).

### 5.2 Role Layers & Priority Hierarchy

Permissions operate across **two independent layers** (system-wide vs. per-group) plus **two scoped non-member actors**:

1. **System Roles (`users.role`) — `HOST_ADMIN` > `USER`**
   - **`HOST_ADMIN` (Server / Home Admin):** Automatically granted to the **first registered account** (`users` count == 0); all later accounts register as `USER`. Exercises server-wide authority (`requireHostAdmin`) for `/admin` telemetry, live/recent audit logs, log retention/pruning, registration request approve/deny, account deletion, map region deletion, and remote system updates, and satisfies `requireAdmin` across any group for invites and role changes. Still requires Group membership/role to view or post in private Groups.
   - **`USER` (Standard Account):** Can manage own profile/avatar/halo colors, password, recovery email, personal HTTP `TrackerToken`, Web Push subscriptions, join Groups by invite, and create new Groups (`POST /api/auth/groups`, automatically becoming `ADMIN` of the created Group). Cannot access `/admin` host endpoints.
   - **Standalone Account (`USER` with 0 memberships):** May operate authenticated self-service settings, create a Group, or redeem an Invite; does not see other users' private Groups until joining or creating one.

2. **Group Roles (`group_memberships.role`, scoped per Group) — `ADMIN` > `MEMBER` > `SPECTATOR`**
   - **Group `ADMIN`:** Assigned automatically on Group creation (`createGroup`) or via Invite/promotion (`updateMemberRole`). Can manage Geofenced `group_places` (`POST`/`DELETE`), promote/demote members in that Group, and create/delete Invites for that Group (`requireAdmin`), in addition to full `MEMBER` capabilities.
   - **Group `MEMBER`:** Shares GPS locations & trails into the Group (strictly filtered by per-Group `PrivacyMode`: `EXACT`, `FUZZED`, or `GHOST`), participates in Group chat, requests/responds to `CheckInRequest` temporary `EXACT` overrides, and creates/revokes temporary `ShareLink`s.
   - **Group `SPECTATOR`:** Read-only observer inside that Group. Views live Group map pins, chat, trails, and places, but is suppressed from location broadcasts, snapshots, and trails, cannot request or accept `EXACT` check-ins, and cannot create `ShareLink`s for that Group.

3. **Scoped & External Actors (Lowest Privilege)**
   - **Public `ShareLink` Guest (`/share/[token]`):** Unauthenticated participant possessing a valid non-revoked, non-expired share token. Sees **only** the creator's `PrivacyMode`-filtered location and (when `allowGuestSharing` is enabled) peer guests holding `(guestId, guestSecret)` on that exact token—never any private Group member or Group data.
   - **Scoped HTTP Tracker Client (`TrackerToken` `trk_...`):** Authenticates only location ingestion endpoints (`OwnTracks`, `Overland`, or `/api/realtime/locations`) for its owning Account without access to REST/Admin/Chat/UI routes.
