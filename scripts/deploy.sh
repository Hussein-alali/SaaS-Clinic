#!/usr/bin/env bash
# Deploys a release on the hosting.com server with an automatic way back
# (docs/06 S2, runbook in docs/08):
#
#   scripts/deploy.sh <release.tar.gz | release-directory>
#
# Layout under APP_HOME (default $HOME/clinicsys):
#   releases/<stamp>-<id>/   one folder per release (api/, db/, dist/, scripts/)
#   current -> releases/...  what cPanel «Setup Node.js App» runs
#                            (application root: APP_HOME/current/api)
#   shared/                  what outlives releases (clinic files, env file)
#
# Steps: backup of the database (abort on failure; on the first deploy it
# comes from the new release, after its install) → copy the release →
# npm ci --omit=dev in api/ and db/ → migrations (NODE_ENV defaults to
# production: db/migrate.js then insists on that fresh backup) → atomic switch of
# `current` → restart (Passenger: current/api/tmp/restart.txt) → health
# check → on failure, switch back to the previous release and restart.
# The database is never rolled back here: migrations are expand/contract
# (the previous release keeps working); a bad migration is undone by
# restoring the pre-deploy dump (runbook).
#
# Environment: APP_HOME, RELEASE_ID (default: the source name), KEEP_RELEASES
# (5), HEALTH_URL (http://127.0.0.1:$PORT/api/health), HEALTH_TIMEOUT (60 s),
# HEALTH_INTERVAL (2 s), and for tests or special set-ups BACKUP_CMD,
# MIGRATE_CMD, RESTART_CMD, SKIP_INSTALL=1, DEPLOY_STAMP.
#
# Exit codes: 0 deployed and healthy · 1 stopped before the switch (nothing
# changed) · 2 unhealthy, switched back to the previous release.
set -euo pipefail

SRC="${1:-}"
[ -n "$SRC" ] && [ -e "$SRC" ] || { echo "usage: $0 <release.tar.gz | release-directory>" >&2; exit 1; }
SRC="$(realpath "$SRC")"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-lib.sh
. "$SCRIPTS/release-lib.sh"

KEEP="${KEEP_RELEASES:-5}"
STAMP="${DEPLOY_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
ID="${RELEASE_ID:-$(basename "$SRC" | sed -E 's/\.tar\.gz$//; s/[^A-Za-z0-9._-]+/-/g')}"
NAME="$STAMP-$ID"
NEW="$APP_HOME/releases/$NAME"
mkdir -p "$APP_HOME/releases" "$APP_HOME/shared"
[ ! -e "$NEW" ] || { log "release $NAME already exists"; exit 1; }
PREV="$(current_release)"

abort() { log "$1 — nothing was switched"; rm -rf "$NEW"; exit 1; }

# 1. Backup first, from the release that is running now.
backed_up=0
if [ -n "${BACKUP_CMD:-}" ]; then
  bash -c "$BACKUP_CMD" || abort "the backup failed"
  backed_up=1
elif [ -n "$PREV" ] && [ -x "$APP_HOME/current/scripts/backup.sh" ]; then
  "$APP_HOME/current/scripts/backup.sh" --db-only || abort "the backup failed"
  backed_up=1
fi

# 2. The new release.
mkdir -p "$NEW"
if [ -d "$SRC" ]; then cp -a "$SRC/." "$NEW/"; else tar -xzf "$SRC" -C "$NEW" || abort "could not unpack $SRC"; fi
echo "$NAME" > "$NEW/RELEASE"
if [ "${SKIP_INSTALL:-0}" != 1 ]; then
  for d in api db; do
    [ -f "$NEW/$d/package.json" ] || continue
    (cd "$NEW/$d" && npm ci --omit=dev --no-audit --no-fund >/dev/null) || abort "npm ci failed in $d/"
  done
fi
# No running release took the backup (first deploy): the new one does, still
# before its migrations.
if [ "$backed_up" = 0 ] && [ -x "$NEW/scripts/backup.sh" ]; then
  "$NEW/scripts/backup.sh" --db-only || abort "the backup failed"
fi

# 3. Migrations (expand/contract: the running release keeps working).
if [ -n "${MIGRATE_CMD:-}" ]; then
  (cd "$NEW" && bash -c "$MIGRATE_CMD") || abort "the migrations failed"
else
  (cd "$NEW" && NODE_ENV="${NODE_ENV:-production}" node db/migrate.js) || abort "the migrations failed"
fi

# 4–5. Switch, restart, check.
switch_to "$NAME"
log "switched to $NAME"
if restart_and_check; then
  log "deployed $NAME"
else
  touch "$NEW/.failed"
  if [ -n "$PREV" ]; then
    switch_to "$PREV"
    restart_and_check || log "WARNING: the previous release $PREV is not healthy either"
    log "$NAME was not healthy — back on $PREV"
  else
    log "$NAME was not healthy and there is no previous release"
  fi
  exit 2
fi

# 6. Keep the newest releases (never the current one).
mapfile -t all < <(ls -1 "$APP_HOME/releases" | sort -r)
cur="$(current_release)"
for old in "${all[@]:$KEEP}"; do
  [ "$old" = "$cur" ] && continue
  rm -rf "${APP_HOME:?}/releases/$old"
done
