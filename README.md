# LovedOnes

Self-hosted, privacy-first group location sharing and real-time messaging platform built as a TypeScript monorepo and orchestrated via Docker Compose. Designed to run on both `linux/amd64` (VPS / Windows WSL2) and `linux/arm64` (Raspberry Pi 5) behind Caddy and an optional Cloudflare Tunnel.

## Features

- **Private Group Location & Chat:** Live location updates and group chat powered by Fastify, Socket.io + Redis Pub/Sub adapter, and PostgreSQL/PostGIS (`GEOGRAPHY(Point, 4326)`).
- **Per-Group Privacy Modes:** Members can switch visibility per group between `EXACT`, `FUZZED` (~1 km grid hashed deterministically per 10-minute `recordedAt` bucket), and `GHOST`.
- **Role-Based Access & Zero-Config QR Invites:** First registered account is promoted to `HOST_ADMIN`. Admins generate single- or multi-use QR/web invites (`/admin/invites` -> `/join?token=...`) with `ADMIN`, `MEMBER`, or `SPECTATOR` roles.
- **Self-Hosted Vector Maps (PMTiles):** Serves regional `.pmtiles` archives and MapLibre styles over HTTP `206 Partial Content` range requests (`map-service`), rendered in browsers via MapLibre GL JS and natively on mobile via `@maplibre/maplibre-react-native`.
- **Host Observability:** Unified `jose` JWT auth (`access` / `refresh`), rotating NDJSON logs (`STDOUT` + `pino-roll` + Redis `logs:ring` / `logs:stream`), WebSocket live log terminal (`/admin`), and per-account storage/compute telemetry.
- **Offline-Resilient Mobile Client:** Expo SDK 58 app with `expo-secure-store` server binding, `expo-task-manager` background location, SQLite offline point queue, and cached offline `.pmtiles` support.

## Architecture & Workspace Layout

```text
├── apps/
│   ├── auth-admin-service/   # Fastify REST + WS (:4001): Argon2id auth, JWT, RBAC, QR invites, telemetry, log stream
│   ├── realtime-service/     # Fastify + Socket.io (:4002): GPS batch ingestion, privacy filtering, group chat
│   ├── map-service/          # Fastify static range server (:8080 internal): .pmtiles, style.json, glyphs
│   ├── web-dashboard/        # Next.js App Router (:3000 internal): live map UI, /join flow, /admin console
│   └── mobile-app/           # Expo SDK 58 React Native client (Android & iOS)
├── packages/
│   ├── shared/               # Zod schemas, privacy fuzzing, ./auth (jose + Fastify hooks), ./logger, ./telemetry
│   └── db/                   # PostGIS SQL migrations (0001_init.sql), Drizzle schema, spatial/telemetry queries
├── infra/
│   ├── caddy/                # Caddyfile (production) and Caddyfile.dev (WSL2 hot-reload)
│   └── tiles/                # Regional region.pmtiles archive and style.json
├── docker-compose.yml        # Full production stack (Caddy, PostGIS, Redis, 4 app services, optional cloudflared)
└── docker-compose.dev.yml    # Local dev backing services (PostGIS :5432, Redis :6379, Caddy dev :8080)
```

All external HTTP and WebSocket traffic enters through **Caddy (`gateway`)**:

| Path | Upstream | Purpose |
| :--- | :--- | :--- |
| `/api/auth/*`, `/api/admin/*` | `auth-admin-service:4001` | Auth, groups, invites, telemetry, `/api/admin/logs/stream` WS |
| `/api/realtime/*`, `/socket.io/*` | `realtime-service:4002` | GPS ingestion, location/message snapshots, Socket.io |
| `/tiles/*` | `map-service:8080` | `.pmtiles` byte-range requests & MapLibre `style.json` |
| `/*` | `web-dashboard:3000` | Next.js web portal & admin console |

## Quick Start (Docker Compose)

### Prerequisites
- Docker & Docker Compose v2
- *(Optional)* Regional `.pmtiles` extract placed at [`infra/tiles/region.pmtiles`](infra/tiles/region.pmtiles) (a minimal placeholder archive and [`style.json`](infra/tiles/style.json) are included for initial startup)

### 1. Configure Environment
```bash
cp .env.example .env
```
Update `.env` with strong random values and your host settings:

- `JWT_SECRET` and `JWT_REFRESH_SECRET` — minimum 32 characters each
- `GATEWAY_PORT` — host port for Caddy HTTP (defaults to `80`; set `GATEWAY_PORT=8080` if `80` is occupied or proxied by a local tunnel)
- `PUBLIC_SERVER_URL` — public origin embedded in QR codes and `/join` links (e.g. `http://localhost:8080` locally or `https://track.example.com` behind Cloudflare)
- `CLOUDFLARE_TUNNEL_TOKEN` — *(only if running the bundled `cloudflared` container)*

### 2. Start the Stack
```bash
docker compose up -d --build
```
Open `http://localhost:8080` (or `http://localhost` if `GATEWAY_PORT` is unset) and register the first account — the first user in an empty database is automatically promoted to `HOST_ADMIN`.

### 3. Exposing via Cloudflare Tunnel (No Port Forwarding)
- **Option A — Bundled `cloudflared` container:** Set `CLOUDFLARE_TUNNEL_TOKEN` and `PUBLIC_SERVER_URL=https://track.example.com` in `.env`, configure the Public Hostname in Cloudflare Zero Trust to point to `http://gateway:80`, and run:
  ```bash
  docker compose --profile tunnel up -d
  ```
- **Option B — Existing `cloudflared` daemon on host/Pi 5:** Point your tunnel's Public Hostname to `http://localhost:8080` (matching `GATEWAY_PORT=8080`), set `PUBLIC_SERVER_URL=https://track.example.com` in `.env`, and recreate `auth-admin-service` if `.env` changed:
  ```bash
  docker compose up -d auth-admin-service
  ```

## Local Development (Node 22 + pnpm 11)

> **Windows WSL2 note:** Keep the repository inside your Linux filesystem (e.g., `~/project_repos/LovedOnes`), not `/mnt/c/...`, to avoid 9P filesystem bottlenecks and broken file watching. See [AGENTS.md](AGENTS.md).

1. **Install dependencies:**
   ```bash
   pnpm install
   ```
2. **Start PostGIS, Redis, and the dev Caddy gateway:**
   ```bash
   docker compose -f docker-compose.dev.yml up -d --wait
   ```
3. **Run dev servers** (requires host ports `3000`, `4001`, `4002` free):
   ```bash
   set -a && source .env && set +a
   pnpm dev
   ```
4. **Build, typecheck, and run tests** (with `docker-compose.dev.yml` PostGIS & Redis up on `:5432` and `:6379`):
   ```bash
   pnpm build
   pnpm typecheck
   pnpm test
   ```

## Mobile Client Setup (`apps/mobile-app`)

Because `@maplibre/maplibre-react-native` includes custom native C++ code, standard Expo Go cannot run it. Compile a custom **Development Build APK** once:

```bash
cd apps/mobile-app
eas build --platform android --profile development
```

Install the APK on your device, start Metro in the repo, and scan a QR code generated on `/admin/invites` to configure the server URL automatically:

```bash
pnpm --filter @loved-ones/mobile-app start
# or: npx expo start --dev-client --tunnel
```

## Documentation & License

- [SPEC.md](SPEC.md) — System specification and database schema
- [AGENTS.md](AGENTS.md) — Monorepo ownership and WSL2 development rules
- [GLOSSARY.md](GLOSSARY.md) — Canonical domain vocabulary
- [LICENSE](LICENSE) — MIT License
