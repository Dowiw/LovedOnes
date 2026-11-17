# Contributing to LovedOnes

Thanks for helping improve LovedOnes! Whether it's a bug fix, doc tweak, or new feature, here's the shortest path from clone to pull request.

## Get Oriented

- **[README.md](README.md)** — Setup and what each piece does.
- **[GLOSSARY.md](GLOSSARY.md)** — Shared names for core concepts (`Account`, `Group`, `Membership`, `PrivacyMode`, etc.).
- **[SPEC.md](SPEC.md)** — System architecture and SQL schema.
- **[TESTING.md](TESTING.md)** — How to run unit, integration, Docker, and UI checks.

## Local Setup

```bash
cp .env.example .env
pnpm install
docker compose -f docker-compose.dev.yml up -d --wait
set -a && source .env && set +a
pnpm dev
```

Only working on the web UI against the full Docker stack (`:8080`)? Run Next.js on a free port with hot reload:

```bash
NEXT_PUBLIC_GATEWAY_URL=http://localhost:8080 pnpm --filter @loved-ones/web-dashboard exec next dev -p 3002
```

## Working in the Code

- **Put business rules in `domain/` modules, not HTTP/Socket handlers.** Keep Fastify and Socket.io shells thin.
- **Test behavior through module interfaces** using in-memory adapters where possible so tests stay fast.
- **Never bypass Zod schemas or privacy modes (`EXACT`, `FUZZED`, `GHOST`)** on any client or backend path.
- **Keep PRs small and focused.** Avoid unrelated formatting churn.

## Before You Open a PR

1. Run the checks (with dev Postgres & Redis up for integration tests — see [TESTING.md](TESTING.md)):
   ```bash
   pnpm build
   pnpm typecheck
   pnpm test
   ```
2. Write clear commit messages describing *why* the change matters.
3. By contributing, you agree your changes are licensed under the [MIT License](LICENSE).
