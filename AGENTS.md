# AGENTS.md — Development Rules & Execution Guide

Read `SPEC.md` at the repository root as the single source of truth for schemas, services, logging, telemetry, and monorepo boundaries.

## Cross-Platform Development & Scaling Rules

The stack targets Linux, macOS, and Windows (WSL2) workstations as well as `amd64` and `arm64` servers and cloud hosts:

1. **Multi-Arch & External Backing Stores:** Both Compose stacks default to `postgis/postgis:16-3.4-alpine` (`amd64`), support overriding `POSTGIS_IMAGE=imresamu/postgis:16-3.4-alpine` for native `arm64` hosts (Apple Silicon, AWS Graviton, ARM SBCs), and accept external `DATABASE_URL` / `REDIS_URL` endpoints for managed or horizontally scaled deployments.
2. **Filesystem Hygiene (Windows WSL2 Note):** On Linux and macOS, run directly on the native filesystem. On Windows WSL2, keep the repository inside the Linux home directory (e.g., `~/project_repos/LovedOnes`) rather than `/mnt/c/...` so Docker mounts and file-watching (`inotify`) stay fast.
3. **Mobile Testing Across Host OSes (Android & iOS Expo Dev Client):** Because `@maplibre/maplibre-react-native` (v11+) includes custom native C++ code, it cannot run inside the standard Expo Go app. Compile a custom **Development Build** (`eas build --platform android --profile development`, `eas build --platform ios --profile development`, or locally via Android Studio / Xcode) once, install it on a device, and connect to Metro using `npx expo start --dev-client --tunnel` (or direct LAN).

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
