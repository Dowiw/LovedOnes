#!/bin/sh
set -e

DEFAULT_JWT_SECRET="dev-jwt-secret-key-minimum-32-characters-long"
DEFAULT_JWT_REFRESH_SECRET="dev-jwt-refresh-secret-key-min-32-chars"

if [ "${NODE_ENV:-}" = "production" ]; then
  insecure_secret=0
  if [ -n "${JWT_SECRET:-}" ]; then
    if [ "${JWT_SECRET}" = "$DEFAULT_JWT_SECRET" ] || [ "${#JWT_SECRET}" -lt 32 ]; then
      insecure_secret=1
    fi
  fi
  if [ -n "${JWT_REFRESH_SECRET:-}" ]; then
    if [ "${JWT_REFRESH_SECRET}" = "$DEFAULT_JWT_REFRESH_SECRET" ] || [ "${#JWT_REFRESH_SECRET}" -lt 32 ]; then
      insecure_secret=1
    fi
  fi

  if [ "$insecure_secret" -eq 1 ]; then
    if [ "${ALLOW_INSECURE_DEFAULTS:-false}" = "true" ]; then
      echo "WARNING: Running with default/short JWT secrets because ALLOW_INSECURE_DEFAULTS=true. Never use this on a public host." >&2
    else
      echo "ERROR: Refusing to start in production with default or <32-char JWT secrets. Run ./bin/start or set strong JWT_SECRET / JWT_REFRESH_SECRET in .env (or ALLOW_INSECURE_DEFAULTS=true for local-only testing)." >&2
      exit 1
    fi
  fi
fi

if [ -n "${LOG_DIR:-}" ]; then
  mkdir -p "$LOG_DIR" 2>/dev/null || true
fi

if [ "$(id -u)" -eq 0 ] && command -v su-exec >/dev/null 2>&1; then
  if [ -n "${LOG_DIR:-}" ] && [ -d "$LOG_DIR" ]; then
    chown -R node:node "$LOG_DIR" 2>/dev/null || true
  fi
  if [ -n "${TILES_DIR:-}" ] && [ -d "$TILES_DIR" ]; then
    chown -R node:node "$TILES_DIR" 2>/dev/null || true
  fi
  exec su-exec node "$@"
fi

exec "$@"
