#!/bin/sh
set -e

DEFAULT_JWT_SECRET="dev-jwt-secret-key-minimum-32-characters-long"
DEFAULT_JWT_REFRESH_SECRET="dev-jwt-refresh-secret-key-min-32-chars"

if [ "${NODE_ENV:-}" = "production" ]; then
  if [ "${JWT_SECRET:-}" = "$DEFAULT_JWT_SECRET" ] || [ "${JWT_REFRESH_SECRET:-}" = "$DEFAULT_JWT_REFRESH_SECRET" ]; then
    echo "WARNING: Running with default JWT secrets. Set JWT_SECRET and JWT_REFRESH_SECRET in .env before exposing publicly." >&2
  fi
fi

if [ -n "${LOG_DIR:-}" ]; then
  mkdir -p "$LOG_DIR" 2>/dev/null || true
fi

exec "$@"
