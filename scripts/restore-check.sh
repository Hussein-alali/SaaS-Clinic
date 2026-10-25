#!/usr/bin/env bash
# Proves the newest backup can be restored (docs/06 S1, NFR-008): restores
# its db.dump into a second, empty database and compares the row count of
# every table with the counts the backup recorded; checks the files archive.
# cPanel cron, e.g. Sundays 04:00:
#
#   0 4 * * 0  cd ~/clinicsys/current && scripts/restore-check.sh >> ~/clinicsys-backups/restore-check.log 2>&1
#
# Environment: RESTORE_DATABASE_URL (required: a database created once in
# cPanel for this, e.g. <account>_clinicsys_restore — NEVER the live one),
# BACKUP_DIR (default $HOME/clinicsys-backups), DATABASE_URL (only used to
# refuse a restore over the live database).
#
# Output: one line per table "<schema.table>  <expected>  <restored>  ok|DIFF".
# Exit codes: 0 every count matches · 1 a difference or a failed restore ·
# 2 bad usage/environment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '%s restore-check: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { local code=$1; shift; say "$*"; exit "$code"; }

[ -n "${RESTORE_DATABASE_URL:-}" ] || die 2 "RESTORE_DATABASE_URL is not set"
[ "${RESTORE_DATABASE_URL}" != "${DATABASE_URL:-}" ] || die 2 "RESTORE_DATABASE_URL is the live database"
command -v pg_restore >/dev/null || die 2 "pg_restore is not installed"
BACKUP_DIR="${BACKUP_DIR:-$HOME/clinicsys-backups}"

latest=""
for d in "$BACKUP_DIR"/[0-9]*T*Z; do [ -f "$d/manifest.json" ] && latest="$d"; done
[ -n "$latest" ] || die 2 "no backup in $BACKUP_DIR"
say "checking $(basename "$latest")"

PGOPTIONS="${PGOPTIONS:-} -c app.system=on" pg_restore --clean --if-exists --no-owner --no-privileges \
  --exit-on-error --dbname="$RESTORE_DATABASE_URL" "$latest/db.dump" || die 1 "pg_restore failed"

if [ -f "$latest/files.tar.gz" ]; then
  tar -tzf "$latest/files.tar.gz" >/dev/null || die 1 "the files archive is damaged"
fi

restored="$(node "$ROOT/db/backup-tools.js" counts "$RESTORE_DATABASE_URL")" || die 1 "could not count the restored tables"
MANIFEST="$latest/manifest.json" RESTORED="$restored" node -e '
  const expected = JSON.parse(require("fs").readFileSync(process.env.MANIFEST, "utf8")).counts;
  const restored = JSON.parse(process.env.RESTORED);
  let bad = 0;
  for (const name of [...new Set([...Object.keys(expected), ...Object.keys(restored)])].sort()) {
    const e = expected[name], r = restored[name];
    const ok = e === r;
    if (!ok) bad++;
    console.log(`${name.padEnd(40)} ${String(e ?? "-").padStart(8)} ${String(r ?? "-").padStart(8)}  ${ok ? "ok" : "DIFF"}`);
  }
  process.exit(bad ? 1 : 0);' || die 1 "the restored database differs from the backup"
say "ok: $(basename "$latest") restores completely"
