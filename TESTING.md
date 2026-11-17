# Developer Testing Guide

Exact steps to verify the **whole Docker stack**, the **Next.js frontend**, the **automated test suite**, and the **mobile dev client**.

---

## 1. Whole Docker Setup Verification

### Step 1 — Validate & Start the Full Stack

Ensure `.env` exists (copied from `.env.example` with `GATEWAY_PORT=8080` if not using port `80`). Stop `docker-compose.dev.yml` first if it is running so ports don't collide:

```bash
# Validate both Compose files
docker compose config -q && docker compose -f docker-compose.dev.yml config -q

# Ensure dev stack is down, then build and launch all 7 containers
docker compose -f docker-compose.dev.yml down
docker compose up -d --build
```

### Step 2 — Check Container Health & Startup Logs

```bash
docker compose ps
```

All 7 containers must be `Up` (with `lovedones-postgres` and `lovedones-redis` showing `(healthy)`):
- `lovedones-gateway` (`0.0.0.0:8080->80/tcp`)
- `lovedones-web-dashboard` (`3000/tcp` internal)
- `lovedones-auth-admin` (`4001/tcp` internal)
- `lovedones-realtime` (`4002/tcp` internal)
- `lovedones-map-service` (`8080/tcp` internal)
- `lovedones-postgres` (`5432/tcp` internal)
- `lovedones-redis` (`6379/tcp` internal)

Check startup logs for clean listeners and zero Redis/Postgres errors:

```bash
docker compose logs --tail=30 auth-admin-service realtime-service map-service web-dashboard gateway
```

Expected lines:
- `auth-admin-service listening` (`port: 4001`)
- `realtime-service listening` (`port: 4002`)
- `map-service listening` (`port: 8080`)
- `web-dashboard` → `✓ Ready`

### Step 3 — Verify Every Caddy Gateway Route (`http://localhost:8080`)

Run these checks against Caddy ([infra/caddy/Caddyfile](infra/caddy/Caddyfile)):

```bash
# 1. Next.js HTML pages return 200 OK
curl -sI http://localhost:8080/
curl -sI http://localhost:8080/join
curl -sI http://localhost:8080/admin
curl -sI http://localhost:8080/admin/invites

# 2. Next.js CSS/JS static bundle resolves via standalone server
ASSET=$(curl -s http://localhost:8080/ | grep -oE "/_next/static/[^\"']+" | head -n 1)
curl -sI "http://localhost:8080${ASSET}"

# 3. Map service serves style.json and HTTP 206 Partial Content byte ranges
curl -sI http://localhost:8080/tiles/style.json
curl -sSi -H "Range: bytes=0-7" http://localhost:8080/tiles/region.pmtiles | head -n 12
# Expect: HTTP/1.1 206 Partial Content, Accept-Ranges: bytes, Content-Range: bytes 0-7/...

# 4. Caddy -> auth-admin-service proxy works (expects JSON 404 from Fastify)
curl -sSi http://localhost:8080/api/auth/invites/nonexistent

# 5. Caddy -> realtime-service Socket.io handshake works (expects HTTP 200)
curl -sSi "http://localhost:8080/socket.io/?EIO=4&transport=polling"
```

### Step 4 — Verify Persistence & Cloudflare Tunnel (Optional)

- **Restart persistence:** After creating a user/group in Section 2, run `docker compose restart`, refresh `http://localhost:8080/`, and confirm your account/group/messages persist via the `pgdata` volume.
- **Reset to a fresh empty DB (if needed before a clean test):**
  ```bash
  docker compose down -v
  docker compose up -d --build
  ```
  *(Warning: `-v` deletes all database, Redis, and Caddy data volumes.)*
- **Cloudflare Tunnel check:** If `CLOUDFLARE_TUNNEL_TOKEN` and `PUBLIC_SERVER_URL=https://<your-domain>` are set in `.env`, run `docker compose --profile tunnel up -d` and check `docker compose logs --tail=20 cloudflared` for registered tunnel connections, then open `https://<your-domain>/` in a browser.

---

## 2. Exact Frontend Testing Steps (`http://localhost:8080`)

Use **two browser sessions** side by side:
- **Window A (Normal browser):** Host Admin
- **Window B (Incognito / Private browser):** Invited Member

### Step 1 — Register the First Host Admin & Create a Group (Window A)

1. Open `http://localhost:8080/` (or your Cloudflare domain).
2. Click **`Need an account? Register here`** to switch to registration mode (**`Create your LovedOnes account`**).
3. Enter Email (`admin@example.com`), Username (`HostAdmin`), Password (at least 8 characters), and submit.
4. Confirm the top bar shows `HostAdmin` with badge **`HOST_ADMIN`** and navigation links **`Live Map & Chat`**, **`Admin Telemetry`**, and **`QR Invites`**.
5. In the left sidebar under Groups, type `Family` into **`New group name...`** and click **`Add`**. Confirm `Family` becomes selected.

### Step 2 — Create & Redeem an Invite (Window A → Window B)

1. In Window A, click **`QR Invites`** in the top nav (`/admin/invites`).
2. Select Group **`Family`**, keep Role `MEMBER`, and click **`Create QR Invite`**.
3. Confirm both a QR image and **`Web Invite Link`** appear (check that the URL host matches `PUBLIC_SERVER_URL` in `.env`, e.g., `http://localhost:8080/join?token=inv_...` or your `https://` tunnel domain).
4. Click **`Copy`** on **`Web Invite Link`**.
5. Paste and open that URL in **Window B (Incognito)** (`/join?token=inv_...`).
6. Verify the **`Group Invite`** card displays `Family` and role `MEMBER`.
7. Fill in Email (`member@example.com`), Username (`Alex`), Password, and click **`Register & Join Group`**.
8. Confirm Window B redirects to `/` showing `Alex` (`USER` badge — no `Admin Telemetry` or `QR Invites` nav tabs) with `Family` selected.

### Step 3 — Verify Live Location Pings, Privacy Modes & Chat

1. In **Window A**, click **`Send Test GPS Ping`** under **Foreground Web Beacon** (or click **`Start Web Geolocation`** and allow browser location access).
2. Verify in **Window B** (without refreshing):
   - **`Visible Members`** increments and lists `HostAdmin` with coordinates and a green **`EXACT`** badge.
   - A marker appears on the MapLibre canvas (click the member card to center on it).
3. In **Window A**, switch **Privacy Mode** from **`EXACT`** → **`FUZZED`**, then click **`Send Test GPS Ping`** again.
   - Verify **Window B** updates `HostAdmin`'s badge to amber **`FUZZED`** and shifts the coordinates to the ~1 km snapped grid cell.
4. In **Window A**, switch **Privacy Mode** to **`GHOST`**, then click **`Send Test GPS Ping`**.
   - Verify `HostAdmin`'s coordinates do not appear in Window B (and reloading Window B keeps `HostAdmin` hidden in **`Visible Members`**).
5. In **Window B**, type `Hello from Alex` in **`Message group...`** and click the send button.
   - Verify the message appears immediately in **Window A** and persists in both windows after a page refresh.

### Step 4 — Verify Admin Telemetry & Live Log Stream (Window A)

1. In **Window A**, click **`Admin Telemetry`** (`/admin`).
2. Verify the cards populate: **`Log Disk Usage`** (showing `Limit` and `%`), database size, total location points, active sockets, and the per-user breakdown table showing `HostAdmin` and `Alex`.
3. Confirm the **Live Log Terminal** connects via WebSocket and displays recent NDJSON logs; trigger a **`Send Test GPS Ping`** or chat message in **Window B** and confirm new log entries stream into `/admin` automatically.
4. Confirm **Window B (`Alex`)** gets **`HOST_ADMIN Access Required`** if navigating directly to `http://localhost:8080/admin`.

### Step 5 — Browser DevTools Check (`F12`)

With DevTools → **Network** open on `/` and `/admin`:
- Filter **WS**: confirm a `101 Switching Protocols` connection to `/socket.io/?EIO=4&transport=websocket` on `/`, and `/api/admin/logs/stream?token=...` on `/admin`.
- Filter **Fetch/XHR**: confirm `/tiles/region.pmtiles` requests receive `206 Partial Content` (or `200` on `style.json`) with no `404`/`500` console or asset errors.

---

## 3. Automated Test Suite (`pnpm test`)

### Fast In-Process Unit & Domain Tests (No Docker Needed)

```bash
pnpm --filter @loved-ones/shared test                                                                  # 6 tests
pnpm --filter @loved-ones/auth-admin-service exec vitest run src/__tests__/auth-group-module.test.ts   # 6 tests
pnpm --filter @loved-ones/realtime-service exec vitest run src/__tests__/realtime-module.test.ts       # 3 tests
pnpm --filter @loved-ones/map-service test                                                             # 1 test
pnpm --filter @loved-ones/web-dashboard test                                                           # 2 tests
pnpm --filter @loved-ones/mobile-app test                                                              # 4 tests
```

### Full Build, Typecheck & Postgres/Redis Integration Tests

Integration tests in `@loved-ones/db`, `auth-admin.test.ts`, and `realtime.test.ts` connect to `localhost:5432` and `localhost:6379` (which are only exposed by `docker-compose.dev.yml`, not the production `docker-compose.yml`):

```bash
# 1. Stop production stack cleanly (keep pgdata) and start dev Postgres + Redis
docker compose down
docker compose -f docker-compose.dev.yml up -d --wait postgres redis

# 2. Build, typecheck, and run all 9 test files (25 tests)
pnpm build
pnpm typecheck
pnpm test

# 3. Restore the production stack on :8080
docker compose -f docker-compose.dev.yml down
docker compose up -d
```

> **Database isolation note:** `auth-admin.test.ts` drops and recreates `lovedones_test_auth` (Redis DB `/1`) and `realtime.test.ts` drops and recreates `lovedones_test_realtime` (Redis DB `/2`). `db.test.ts` uses `DATABASE_URL` (default `lovedones`) and deletes its synthetic test rows after running.

### Test Inventory

| Package | Test File | Tests | Dependencies | Coverage |
| :--- | :--- | :---: | :--- | :--- |
| `@loved-ones/shared` | [`shared.test.ts`](packages/shared/src/__tests__/shared.test.ts) | 6 | In-process | Zod schemas, `normalizePrivacyMode`, `applyPrivacyFuzzing`, `pino-roll`, strict `jose` `access` vs `refresh` JWT |
| `@loved-ones/db` | [`db.test.ts`](packages/db/src/__tests__/db.test.ts) | 1 | Postgres (`:5432`) | PostGIS migrations, `insertLocationBatch`, `getLatestGroupLocations`, `getDatabaseTelemetry` |
| `@loved-ones/map-service` | [`map-service.test.ts`](apps/map-service/src/__tests__/map-service.test.ts) | 1 | Local `infra/tiles` | `style.json` and `HTTP 206` byte ranges on `region.pmtiles` |
| `@loved-ones/auth-admin-service` | [`auth-group-module.test.ts`](apps/auth-admin-service/src/__tests__/auth-group-module.test.ts) | 6 | In-process | First-user `HOST_ADMIN`, atomic invite rollback, refresh token rejection of access JWTs, RBAC `403`, non-downgrading `joinByInvite`, `PUBLIC_SERVER_URL` precedence, telemetry thresholds |
| `@loved-ones/auth-admin-service` | [`auth-admin.test.ts`](apps/auth-admin-service/src/__tests__/auth-admin.test.ts) | 1 | Postgres + Redis | End-to-end Argon2id registration, refresh, QR invites, `/api/admin/telemetry`, `/api/admin/logs/stream` WS |
| `@loved-ones/realtime-service` | [`realtime-module.test.ts`](apps/realtime-service/src/__tests__/realtime-module.test.ts) | 3 | In-process | `EXACT`/`FUZZED`/`GHOST`/`SPECTATOR` rules, `recordedAt` fuzzing stability, `403` guards, single-counted telemetry |
| `@loved-ones/realtime-service` | [`realtime.test.ts`](apps/realtime-service/src/__tests__/realtime.test.ts) | 1 | Postgres + Redis | Live Socket.io + Redis adapter GPS ingestion, privacy switches, chat, and socket/point telemetry |
| `@loved-ones/web-dashboard` | [`api-helpers.test.ts`](apps/web-dashboard/src/__tests__/api-helpers.test.ts) | 2 | In-process | Byte formatting, relative gateway URL resolution, log WebSocket URL builder |
| `@loved-ones/mobile-app` | [`mobile.test.ts`](apps/mobile-app/src/__tests__/mobile.test.ts) | 4 | In-process | QR JSON & `/join?token=...` parsing, `SecureStore` binding, offline queue batch flush, `pmtiles://` styles |

---

## 4. Testing the Mobile App (`apps/mobile-app`)

Standard **Expo Go** cannot load `@maplibre/maplibre-react-native` because it contains custom native C++ code.

1. **Build & install the Development Client APK once:**
   ```bash
   cd apps/mobile-app
   eas build --platform android --profile development
   ```
2. **Start Metro from WSL2** (use `--tunnel` if your phone is not on WSL2 mirrored LAN):
   ```bash
   pnpm --filter @loved-ones/mobile-app start
   # or: npx expo start --dev-client --tunnel
   ```
3. **Test end-to-end on device:**
   - Scan the QR code from `/admin/invites` on `QrOnboardingScreen` and verify `serverUrl` binds automatically.
   - Verify MapLibre renders tiles from `/tiles/region.pmtiles` (swap [`infra/tiles/region.pmtiles`](infra/tiles/region.pmtiles) with a regional Protomaps extract for street-level detail).
   - Enable background tracking, turn on **Airplane Mode** for 1–2 minutes to buffer points in SQLite, then reconnect and confirm the queued batch flushes to `POST /api/realtime/locations`.
