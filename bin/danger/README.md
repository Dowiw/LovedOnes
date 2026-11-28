# `bin/danger/` — Destructive Local Maintenance Scripts

> **WARNING:** Scripts in this directory **permanently delete local Docker volumes and data** (accounts, groups, location pings, chat messages, sessions, and tracker tokens). They are intentionally separated from top-level `bin/` (`bin/start`, `bin/dev`) to prevent accidental execution or tab-completion.

## `reset-localhost`

Wipes PostgreSQL and Redis Docker volumes and rebuilds a clean localhost stack so you can register a brand-new Host Admin account from scratch.

```sh
./bin/danger/reset-localhost
```

You will be prompted to type `RESET` (all caps) before any destructive command executes.

### Common Flags
- `--confirm-reset` — Skip the interactive `RESET` prompt (for explicit scripted resets).
- `--dev` — Target `docker-compose.dev.yml` instead of the full `docker-compose.yml` stack.
- `--fresh-env` — Back up `.env` (if present) and recreate clean localhost defaults from `.env.example` with newly generated `JWT_SECRET` / `JWT_REFRESH_SECRET` and `arm64`/`amd64` `POSTGIS_IMAGE` detection.
- `--wipe-logs` — Remove log files under `./logs/` (preserving `.gitkeep`).
- `--wipe-tiles` — Remove downloaded regional city extracts under `./infra/tiles/regions/` while preserving tracked styles, fonts, sprites, and the placeholder stub.
- `--dry-run` — Preview all commands without touching containers, volumes, or files.
