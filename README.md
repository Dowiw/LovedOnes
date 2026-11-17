# LovedOnes

Share your live location and chat with family or close friends on a server you own — no third-party tracking, no subscriptions, and no selling your location history.

Runs anywhere Docker runs — cloud VMs, bare-metal Linux servers, home servers, single-board `arm64` devices, or local Linux/macOS/WSL2 machines — and scales horizontally behind any reverse proxy or load balancer.

---

## What It Does

- **Private location sharing & group chat:** See where your groups are on a live map and message each other in real time.
- **Privacy per group:** Choose whether each group sees your **Exact** location, an **Approximate (~1 km)** area, or **Ghost** mode (hidden).
- **Easy QR code invites:** Generate an invite link or QR code from the admin page — family members scan it to connect automatically without typing server URLs or settings.
- **Self-hosted maps:** Map tiles live on your own server ([`infra/tiles/`](infra/tiles/)) instead of relying on commercial map APIs.
- **Works in browsers & on mobile:** Use the web dashboard from any desktop or phone browser, or run the Expo mobile app with background tracking and offline location caching when signal drops.
- **Admin console:** Monitor server health, disk/database usage, and live server logs right in your browser at `/admin`.

---

## Quick Start (Docker)

You'll need **Docker** and **Docker Compose** installed.

### 1. Create your config file

```bash
cp .env.example .env
```

Open `.env` and update these essentials:

- **`JWT_SECRET`** and **`JWT_REFRESH_SECRET`** — set each to a long random string (at least 32 characters).
- **`GATEWAY_PORT`** — the port you want the web app on locally (use `8080`, or `80` if nothing else uses port 80).
- **`PUBLIC_SERVER_URL`** — the address people use to open the app (e.g. `http://localhost:8080` for local testing, or `https://track.yourdomain.com` if using a domain).
- **`POSTGIS_IMAGE`** *(optional, for native `arm64` hosts)* — set `POSTGIS_IMAGE=imresamu/postgis:16-3.4-alpine` instead of the default `amd64` image.

### 2. Start everything

```bash
docker compose up -d --build
```

### 3. Create your admin account

Open `http://localhost:8080` (or `http://localhost` if using port 80) in your browser and register your first account.

> The very first account created on a fresh database automatically becomes the **Host Admin**, giving you access to `/admin` and `/admin/invites`.

---

## Accessing It Outside Your Home (Cloudflare Tunnel)

If you don't want to open ports on your router, you can put LovedOnes behind a Cloudflare Tunnel:

- **If you already run `cloudflared` on your host:**
  1. Point your domain/subdomain in Cloudflare Zero Trust to `http://localhost:8080` (matching `GATEWAY_PORT=8080`).
  2. Set `PUBLIC_SERVER_URL=https://your-subdomain.example.com` in `.env` so QR codes and invite links use your public address.
  3. Apply the `.env` change:
     ```bash
     docker compose up -d auth-admin-service
     ```

- **If you want Docker to run `cloudflared` for you:**
  1. Paste your tunnel token into `CLOUDFLARE_TUNNEL_TOKEN` in `.env` and set `PUBLIC_SERVER_URL=https://your-subdomain.example.com`.
  2. In Cloudflare Zero Trust, point the tunnel's Public Hostname to `http://gateway:80`.
  3. Start with the tunnel profile enabled:
     ```bash
     docker compose --profile tunnel up -d
     ```

---

## Adding Real Map Data

The [`infra/tiles/region.pmtiles`](infra/tiles/region.pmtiles) file checked into git is intentionally a **264-byte stub** (a minimal valid PMTiles v3 header for CI and range-request tests). Until you replace it, the map displays a dark background with pins but no streets or buildings.

To drop in a real regional `.pmtiles` extract (for example **Berlin/Brandenburg** via [Protomaps](https://docs.protomaps.com/pmtiles/cli)):

1. Install the `pmtiles` CLI (`brew install pmtiles` on macOS, or grab a binary from [protomaps/go-pmtiles](https://github.com/protomaps/go-pmtiles/releases)), check the latest build date at [maps.protomaps.com/builds](https://maps.protomaps.com/builds/), and extract your region directly to `infra/tiles/region.pmtiles`:
   ```bash
   # Berlin/Brandenburg (replace YYYYMMDD with the latest build date)
   pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles infra/tiles/region.pmtiles \
     --bbox=11.2,51.3,14.8,53.6
   ```
   *(For Berlin only, use `--bbox=13.0883,52.3382,13.7612,52.6755`; for other regions, look up `MIN_LON,MIN_LAT,MAX_LON,MAX_LAT` via [bboxfinder.com](http://bboxfinder.com/).)*

2. **Match your tile schema in [`infra/tiles/style.json`](infra/tiles/style.json):** The bundled `style.json` targets OpenMapTiles layer names (`transportation`, `building`, `boundary`). If your `.pmtiles` uses Protomaps v4 basemap layers, update those `source-layer` names in `infra/tiles/style.json` (e.g., `roads`, `buildings`, `boundaries`).

3. **Reload without rebuilding:** `infra/tiles/` is bind-mounted into `map-service`, so no Docker rebuild is needed — hard-refresh your browser (`Ctrl+Shift+R`).

4. **Avoid committing large map files:** Keep git from staging your local extract with:
   ```bash
   git update-index --assume-unchanged infra/tiles/region.pmtiles
   ```

---

## Mobile App (`apps/mobile-app`)

Because the mobile app uses native MapLibre maps, it needs a custom **Expo Development Build** instead of the standard Expo Go app:

1. Build the Android development APK once:
   ```bash
   cd apps/mobile-app
   eas build --platform android --profile development
   ```
2. Install the APK on your phone, start Metro from the repo root, and scan the QR code from `/admin/invites`:
   ```bash
   pnpm --filter @loved-ones/mobile-app start
   ```

---

## Developing Locally

If you're modifying the code (Node.js 22+ and `pnpm` 11+ required):

> **Note (Windows WSL2):** Keep the repo inside your Linux home directory (e.g. `~/project_repos/LovedOnes`), not `/mnt/c/...`, so Docker mounts and file watching stay fast. See [AGENTS.md](AGENTS.md).

```bash
# 1. Install packages
pnpm install

# 2. Start only Postgres, Redis, and the dev Caddy proxy
docker compose -f docker-compose.dev.yml up -d --wait

# 3. Load .env and start all dev servers (uses ports 3000, 4001, 4002)
set -a && source .env && set +a
pnpm dev
```

Useful workspace checks:

```bash
pnpm build
pnpm typecheck
pnpm test
```

---

## Under the Hood

Everything sits behind a single **Caddy** reverse proxy (`gateway`), so only one port is exposed:

- **Web App (`apps/web-dashboard`):** Next.js user map, `/join` invite page, and `/admin` console.
- **Auth & Admin (`apps/auth-admin-service`):** Accounts, Argon2id passwords, JWT sessions, group permissions, QR invites, and system telemetry.
- **Live Tracking & Chat (`apps/realtime-service`):** Socket.io + Redis real-time location updates, privacy filtering, and chat.
- **Map Tiles (`apps/map-service`):** Byte-range server for `.pmtiles` and map styles.
- **Database (`packages/db` & PostGIS):** PostgreSQL + PostGIS spatial storage and Redis pub/sub.

For deeper technical details, see [SPEC.md](SPEC.md), [GLOSSARY.md](GLOSSARY.md), and [AGENTS.md](AGENTS.md). Licensed under the [MIT License](LICENSE).
