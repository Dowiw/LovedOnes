# AGENTS.md — Development Rules & Execution Guide

Read `SPEC.md` at the repository root as the single source of truth for schemas, services, logging, telemetry, and monorepo boundaries.

## Windows + WSL2 Development Rules

Building a Dockerized microservices stack alongside React Native on Windows works best when you split the workload across **WSL2** and **Windows Native** properly:

1. **Keep the Repository Inside the WSL2 Filesystem:** Clone and run code inside your Linux home directory (e.g., `~/project_repos/LovedOnes`), **never** inside `/mnt/c/Users/...`. Running Docker volume mounts and `pnpm install` across the Windows-to-Linux 9P filesystem bridge causes massive I/O bottlenecks and breaks file-watching (`inotify`) for hot reload.
2. **Docker Desktop WSL2 Backend:** Enable the WSL2 integration in Docker Desktop so `docker compose` runs natively inside your Linux distro while exposing ports to `localhost` on Windows.
3. **Mobile Testing from WSL2 (Android + Expo Dev Client):** Because `@maplibre/maplibre-react-native` (v11+) includes custom native C++ code, it cannot run inside the standard Expo Go app. Compile a custom **Development Build APK** (`eas build --platform android --profile development` or locally via Android Studio on Windows) once, install it on your Android phone, and connect it to the Metro bundler running in WSL2 using `npx expo start --dev-client --tunnel` (or via LAN with WSL2 mirrored networking enabled in `.wslconfig`).

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
