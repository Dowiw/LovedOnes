<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web-dashboard/public/icons/icon-dark-192.png" />
    <source media="(prefers-color-scheme: light)" srcset="apps/web-dashboard/public/icons/icon-192.png" />
    <img src="apps/web-dashboard/public/icons/icon-192.png" alt="LovedOnes icon" width="96" height="96" />
  </picture>
  <h1>LovedOnes</h1>
  <p>
    <a href="https://github.com/Dowiw/LovedOnes/actions/workflows/ci.yml">
      <img src="https://github.com/Dowiw/LovedOnes/actions/workflows/ci.yml/badge.svg" alt="CI" />
    </a>
  </p>
</div>

Share your live location and chat with family or close friends on a server you own — no third-party tracking, no subscriptions, and no selling your location history.

Runs on any container host or server — cloud VMs, bare-metal Linux servers, home servers, `arm64` devices, or local workstations — and scales horizontally behind any reverse proxy or load balancer.

---

## What It Does

- **Private location sharing & group chat:** See where your groups are on a live map and message each other in real time.
- **Privacy per group:** Choose whether each group sees your **Exact** location, an **Approximate (~1 km)** area, or **Ghost** mode (hidden).
- **Easy QR code invites:** Generate an invite link or QR code from the admin page — family members scan it to connect automatically without typing server URLs or settings.
- **Self-hosted maps:** Map tiles live on your own server ([`infra/tiles/`](infra/tiles/)) instead of relying on commercial map APIs.
- **Works in browsers & on mobile:** Use the web dashboard from any desktop or mobile browser, or run the mobile app with background tracking and offline location caching when signal drops.
- **Admin console:** Monitor server health, disk/database usage, and live server logs right in your browser at `/admin`.

---

## Quick Start

You'll need **Docker** (or a compatible container runtime) and **Compose** installed.

1. Clone the repository and start everything with one command:

   ```bash
   ./bin/start
   ```

   *(Or run `docker compose up -d` directly — `.env` is optional for local use, and `./bin/start` automatically generates random JWT secrets in `.env` and selects an `arm64`-compatible database image when needed.)*

2. Open **`http://localhost:8080`** and register your first account.

> The very first account created on a fresh database automatically becomes the **Host Admin**, giving you access to `/admin` and `/admin/invites`.
>
> For local hot-reload development, run `./bin/dev`.

---

## Accessing It Remotely

To access LovedOnes outside your local network, place the gateway port (`GATEWAY_PORT`, default `8080`) behind any TLS-terminating reverse proxy, VPN, or encrypted tunnel, and set `PUBLIC_SERVER_URL=https://your-subdomain.example.com` in `.env` so QR codes and invite links resolve to your public origin. Apply `.env` updates by restarting `auth-admin-service` (`docker compose up -d auth-admin-service`).

### Using Cloudflare

If you prefer zero-port-forward ingress via Cloudflare:

- **Host-installed connector:**
  1. Route your public hostname to `http://localhost:8080` (matching `GATEWAY_PORT`).
  2. Set `PUBLIC_SERVER_URL=https://your-subdomain.example.com` in `.env` and restart `auth-admin-service`.

- **Bundled container connector:**
  1. Set `CLOUDFLARE_TUNNEL_TOKEN` and `PUBLIC_SERVER_URL=https://your-subdomain.example.com` in `.env`, and point the tunnel ingress to `http://gateway:80`.
  2. Start with the tunnel profile enabled:
     ```bash
     docker compose --profile tunnel up -d
     ```

---

## Adding Real Map Data

The [`infra/tiles/region.pmtiles`](infra/tiles/region.pmtiles) file checked into git is intentionally a **264-byte stub** (a minimal valid PMTiles v3 header for CI and range-request tests). Until you replace it, the map displays a dark background with pins but no streets or buildings.

To use real map data, place any regional `.pmtiles` vector archive at `infra/tiles/region.pmtiles`:

1. **Match your tile schema in [`infra/tiles/style.json`](infra/tiles/style.json):** The bundled `style.json` uses `earth`, `water`, `landuse`, `roads`, `buildings`, and `boundaries` layers. If your `.pmtiles` archive uses different layer names (such as `transportation`, `building`, `boundary`), update `source-layer` in `infra/tiles/style.json`.
2. **Reload without rebuilding:** `infra/tiles/` is bind-mounted into the gateway container, so no rebuild is needed — hard-refresh your browser (`Ctrl+Shift+R`).
3. **Avoid committing large map files:** Keep git from staging your local extract with:
   ```bash
   git update-index --assume-unchanged infra/tiles/region.pmtiles
   ```

### Extracting Regional Tiles (Protomaps Example)

1. Install the [`pmtiles` CLI](https://github.com/protomaps/go-pmtiles/releases) and find a build date from your preferred PMTiles basemap distribution.
2. Extract a bounding box (`MIN_LON,MIN_LAT,MAX_LON,MAX_LAT`) directly to `infra/tiles/region.pmtiles`:
   ```bash
   pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles infra/tiles/region.pmtiles \
     --bbox=11.2,51.3,14.8,53.6
   ```

---

## Mobile App (`apps/mobile-app`)

Because the mobile app bundles native map rendering, install a custom **Development Build** rather than a generic sandbox runner:

1. Build and install a development client for your target mobile OS from `apps/mobile-app`.
2. Start the bundler from the repository root, then scan the QR code from `/admin/invites`:
   ```bash
   pnpm --filter @loved-ones/mobile-app start
   ```

### Third-Party HTTP Trackers

You can also stream background GPS from compatible HTTP tracker clients (such as **OwnTracks** or **Overland**):

1. Sign in to the web dashboard and open the **Tracker Setup** panel in the left sidebar.
2. Pick a token expiration (`7 days`, `30 days`, `90 days`, or `1 year`) and click **Generate Token**.
3. Copy the generated endpoint URL (`/api/realtime/owntracks?token=...` or `/api/realtime/overland?token=...`) into your tracker client. (You can rotate or revoke the token anytime from the dashboard.)

---

## Developing Locally

If you're modifying the code (Node.js 22+ and `pnpm` 11+ required):

> **Note:** On virtualized filesystems (such as WSL2 on Windows), keep the repository inside the native Linux filesystem rather than a host-mounted path so container mounts and file watching stay fast. See [AGENTS.md](AGENTS.md).

```bash
# Install dependencies and start backing services + all dev servers
pnpm install
./bin/dev
```

Useful workspace checks:

```bash
pnpm build
pnpm typecheck
pnpm test
```

---

## Architecture Overview

Traffic enters through a single reverse proxy gateway (`gateway`), so only one port is exposed:

- **Web App (`apps/web-dashboard`):** User map UI, `/join` invite page, `/admin` telemetry & logs console.
- **Auth & Admin (`apps/auth-admin-service`):** Accounts, password hashing, JWT sessions, group permissions, QR invites, and system telemetry.
- **Live Tracking & Chat (`apps/realtime-service`):** WebSocket + REST location ingestion, privacy filtering, check-in requests, geofenced places, and group chat.
- **Map Tiles (`gateway` / optional `apps/map-service`):** Static HTTP byte-range server for `.pmtiles` archives and map styles (`apps/map-service` remains available via the `standalone-maps` profile or standalone Node).
- **Database (`packages/db`):** Spatial SQL database and pub/sub message broker.

For deeper technical details, see [SPEC.md](SPEC.md), [GLOSSARY.md](GLOSSARY.md), and [AGENTS.md](AGENTS.md).

---

## License

LovedOnes — self-hosted, privacy-first family and friends group map, trails, and chat.
Copyright (C) 2026 Kabuñiang Buhawi (KB) Monjardin

This program is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [`LICENSE`](LICENSE) or <https://www.gnu.org/licenses/> for the full license terms.

---

## Credits & Attribution

- **Map POI Icons:** [Mapbox Maki](https://github.com/mapbox/maki) (`CC0 1.0`, bundled into self-hosted sprites under [`infra/tiles/sprites/`](infra/tiles/sprites/CREDITS.md)) packed with [`spreet`](https://github.com/flother/spreet) (`MIT`).
- **Map Typography:** [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) (`SIL Open Font License 1.1`, self-hosted SDF glyphs under [`infra/tiles/fonts/`](infra/tiles/fonts/OFL.txt)).
- **Basemap & Vector Data:** Built for [Protomaps](https://protomaps.com) PMTiles extracts derived from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (`ODbL`).
