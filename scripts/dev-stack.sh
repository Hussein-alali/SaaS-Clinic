#!/usr/bin/env bash
# Whole stack on one machine for development and browser tests:
# PostgreSQL (cPanel-like, via dev-db.sh) → migrations → dev seed →
# npm run build → API serving /api and dist/ on one port.
#
#   scripts/dev-stack.sh start [dbport] [apiport]   → prints the app URL
#   scripts/dev-stack.sh stop  [dbport] [apiport]
#
# start always resets the database (the seed refuses a non-empty one), so
# every run begins from the same two demo clinics (docs/05 "Migration and
# seed data"; password Dev@12345). Open the app at
#   http://localhost:<apiport>/?org=demo-physio   (clinic)
#   http://localhost:<apiport>/?platform=1        (Super Admin)
# or http://demo-physio.localhost:<apiport>/ — Chromium resolves *.localhost.
# E-mails (invitations, password resets) land in api/.outbox-<apiport>/.
# Defaults: dbport 54329, apiport 3100. Use distinct ports per parallel run.
set -euo pipefail

CMD="${1:-start}"
DBPORT="${2:-54329}"
APIPORT="${3:-3100}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="/tmp/clinicsys-api-$APIPORT.pid"
LOG="/tmp/clinicsys-api-$APIPORT.log"

stop_api() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$PIDFILE"
}

case "$CMD" in
  start)
    stop_api
    [ -d "$ROOT/db/node_modules" ] || npm --prefix "$ROOT/db" install --silent
    [ -d "$ROOT/api/node_modules" ] || npm --prefix "$ROOT/api" install --silent
    URL="$("$ROOT/scripts/dev-db.sh" reset "$DBPORT" 2>/dev/null)"
    DATABASE_URL="$URL" node "$ROOT/db/migrate.js" >/dev/null
    psql "$URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/db/seed/dev.sql" >/dev/null
    (cd "$ROOT" && npm run build --silent >/dev/null)
    rm -rf "$ROOT/api/.outbox-$APIPORT" "/tmp/clinicsys-files-$APIPORT"
    # exec + full redirection: the API must not hold this script's stdout,
    # or callers doing URL=$(dev-stack.sh start) would wait forever.
    (cd "$ROOT/api" && exec env \
      DATABASE_URL="$URL" PORT="$APIPORT" APP_BASE_DOMAIN=localhost \
      MAIL_TRANSPORT=file MAIL_OUTBOX_DIR="$ROOT/api/.outbox-$APIPORT" \
      FILES_DIR="/tmp/clinicsys-files-$APIPORT" DIST_DIR="$ROOT/dist" \
      node app.js) </dev/null >"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    for _ in $(seq 1 50); do
      if curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
           "http://127.0.0.1:$APIPORT/api/orgs/resolve?slug=demo-physio" | grep -q 200; then
        echo "http://localhost:$APIPORT"; exit 0
      fi
      sleep 0.2
    done
    echo "dev-stack: API did not come up; see $LOG" >&2; exit 1
    ;;
  stop)
    stop_api
    "$ROOT/scripts/dev-db.sh" stop "$DBPORT"
    ;;
  *) echo "usage: $0 start|stop [dbport] [apiport]" >&2; exit 2 ;;
esac
