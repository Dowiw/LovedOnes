# AGENTS.md — Development Rules & Execution Guide

Read `SPEC.md` at the repository root as the single source of truth for schemas, services, actor/role hierarchy, logging, telemetry, and monorepo boundaries, and `GLOSSARY.md` for canonical domain terminology.

## Cross-Platform Development & Scaling Rules

The stack targets Linux, macOS, and Windows (WSL2) workstations as well as `amd64` and `arm64` servers and cloud hosts:

1. **Multi-Arch & External Backing Stores:** Both Compose stacks default to `postgis/postgis:16-3.4-alpine` (`amd64`), support overriding `POSTGIS_IMAGE=imresamu/postgis:16-3.4-alpine` for native `arm64` hosts (ARM workstations, cloud instances, and SBCs), and accept external `DATABASE_URL` / `REDIS_URL` endpoints for managed or horizontally scaled deployments.
2. **Filesystem Hygiene:** Keep the repository on the host's native Linux filesystem rather than a virtualized host share (e.g., `/mnt/c/...` on WSL2) so container mounts and file-watching stay fast.
3. **Mobile Testing Across Host OSes:** Because `@maplibre/maplibre-react-native` (v11+) includes custom native C++ code, it cannot run inside a generic sandbox runner. Compile a custom **Development Build** once via cloud or local native build tooling, install it on a device, and connect to the dev bundler over LAN or tunnel.

## Monorepo Architecture & Package Ownership

- `packages/shared` (`@loved-ones/shared`): Zod validation schemas, TypeScript types, privacy fuzzing (`EXACT`, `FUZZED`, `GHOST`), 3-way Pino logger (`STDOUT`, `pino-roll`, Redis `logs:ring` + `logs:stream`), and Redis telemetry helpers.
- `packages/db` (`@loved-ones/db`): PostGIS SQL migrations (`0001_init.sql`), Drizzle ORM schema, and PostGIS spatial + telemetry query helpers.
- `apps/auth-admin-service`: Fastify REST + WebSocket service (`:4001`) handling Argon2id auth, JWT tokens, group RBAC, QR invite payloads, `/api/admin/telemetry`, and live log streaming.
- `apps/realtime-service`: Fastify + Socket.io + Redis adapter (`:4002`) handling GPS batch ingestion, privacy enforcement, and group chat.
- `apps/map-service`: HTTP Range Request (`Accept-Ranges: bytes`) server for `.pmtiles` archives, MapLibre styles, and glyphs (`:8080` internal / `:8085` local dev).
- `apps/web-dashboard`: Next.js App Router web portal + `/admin` console + `/join` invite flow (`:3000`).
- `apps/mobile-app`: Expo React Native app with QR onboarding, SQLite offline location queue, background location tasks, and MapLibre native PMTiles rendering.

## Commit & Verification Discipline

- Run `pnpm typecheck`, `pnpm build`, and `pnpm test` before committing changes across packages.
- Do not bypass Zod validation or privacy mode filtering (`EXACT`, `FUZZED`, `GHOST`) in any client or service layer.

## Audit Logging Discipline (`/admin` Live Log Terminal)

- **Record Every User & Admin Action:** Every state-changing user action, guest action, and admin action across all services—including `HOST_ADMIN` and Group `ADMIN` actions (auth/onboarding, profile/password/recovery changes, invites, registration approvals/denials, account removals, group/role/privacy changes, tracker tokens, GPS ingestion, chat, check-ins, geofenced places, guest share links, Web Push subscriptions/tests, map downloads/deletions, log retention/pruning, and system updates)—MUST emit a structured `logger.info({ action, userId, username, ... }, humanReadableMessage)` entry through the shared 3-way Pino logger (`@loved-ones/shared/logger`).
- **Live Admin Visibility:** Entries logged this way automatically write to `STDOUT`, rotate to disk (`pino-roll`), and stream via Redis `logs:ring` + `logs:stream` to the Host Admin `/admin` Live Log Terminal.
- **No Secrets in Logs:** Never log passwords, raw JWTs, tracker/invite/share-link secret tokens, recovery codes, `guestSecret`, or push encryption keys (`p256dh`/`auth`).
