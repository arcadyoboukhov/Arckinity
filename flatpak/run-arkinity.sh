#!/usr/bin/env sh
set -eu

APP_BIN="/app/arkinity/Arkinity"

if [ ! -x "$APP_BIN" ]; then
  echo "Arkinity binary not found at: $APP_BIN" >&2
  exit 1
fi

exec zypak-wrapper "$APP_BIN" --no-sandbox "$@"
