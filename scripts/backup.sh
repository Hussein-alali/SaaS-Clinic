#!/usr/bin/env bash
# Nightly backup on the hosting.com server (docs/06 S1, docs/08 «النسخ
# الاحتياطي»): a consistent pg_dump of the whole database, an archive of the
# clinic files and a manifest (sha256 + the row count of every table, from
# the same snapshot as the dump). cPanel cron, e.g. 02:15 every night:
#
#   15 2 * * *  cd ~/clinicsys/current && scripts/backup.sh >> ~/clinicsys-backups/backup.log 2>&1
#
#   scripts/backup.sh [--db-only]
#
# Environment: DATABASE_URL (required), FILES_DIR (the clinic files; skipped
# with --db-only), BACKUP_DIR (default $HOME/clinicsys-backups — never inside
# public_html or FILES_DIR), BACKUP_KEEP_DAILY (7), BACKUP_KEEP_WEEKLY (4;
# Sunday backups are weekly), BACKUP_KEEP_DB_ONLY (5: the --db-only backups
# deploy.sh takes, kind "db-only"), BACKUP_MIN_FREE_MB (1024: the disk must keep at
# least this much free AFTER the backup), RELEASE (written to the manifest),
# BACKUP_STAMP (UTC YYYYMMDDTHHMMSSZ; tests only).
#
# Exit codes: 0 done · 1 failed · 2 bad usage/environment · 3 not enough free
# space · 4 unsafe BACKUP_DIR. A failed run leaves no partial backup behind.
set -euo pipefail
# Every clinic's records and the password hashes: readable by this account
# only (0700 / 0600), whatever its umask on the shared server.
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_ONLY=0
[ "${1:-}" = "--db-only" ] && DB_ONLY=1

say() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { local code=$1; shift; say "$*"; exit "$code"; }

[ -n "${DATABASE_URL:-}" ] || die 2 "DATABASE_URL is not set"
[ "$DB_ONLY" = 1 ] || [ -d "${FILES_DIR:-}" ] || die 2 "FILES_DIR is not a directory (use --db-only to skip the files)"
command -v pg_dump >/dev/null || die 2 "pg_dump is not installed"

BACKUP_DIR="${BACKUP_DIR:-$HOME/clinicsys-backups}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
KEEP_DB_ONLY="${BACKUP_KEEP_DB_ONLY:-5}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-1024}"
STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die 2 "bad BACKUP_STAMP $STAMP"

# A backup next to the public web root could be downloaded; one inside the
# clinic files would end up inside its own next archive.
dest="$(realpath -m "$BACKUP_DIR")"
case "/$dest/" in */public_html/*) die 4 "BACKUP_DIR must not be inside public_html: $dest" ;; esac
if [ "$DB_ONLY" = 0 ] || [ -n "${FILES_DIR:-}" ]; then
  if [ -n "${FILES_DIR:-}" ]; then
    files="$(realpath -m "$FILES_DIR")"
    case "$dest/" in "$files"/*) die 4 "BACKUP_DIR must not be inside FILES_DIR: $dest" ;; esac
  fi
fi

mkdir -p "$dest"
chmod 700 "$dest"   # a folder made before umask 077 (or by hand)

# Free space: the estimated backup size plus BACKUP_MIN_FREE_MB must fit.
need_kb=$(node -e '
  const { Client } = require(process.argv[1]);
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect().then(() => c.query("select pg_database_size(current_database()) as b"))
    .then((r) => { console.log(Math.ceil(Number(r.rows[0].b) / 1024)); return c.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });' "$ROOT/db/node_modules/pg")
if [ "$DB_ONLY" = 0 ]; then
  need_kb=$(( need_kb + $(du -sk "$FILES_DIR" | cut -f1) ))
fi
free_kb=$(df -Pk "$dest" | awk 'NR==2 {print $4}')
if [ $(( free_kb - need_kb )) -lt $(( MIN_FREE_MB * 1024 )) ]; then
  rmdir "$dest" 2>/dev/null || true
  die 3 "not enough free space / المساحة الحرة لا تكفي: ${free_kb} KB free, backup needs ~${need_kb} KB and ${MIN_FREE_MB} MB must stay free"
fi

work="$dest/.tmp-$STAMP"
rm -rf "$work"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

node "$ROOT/db/backup-tools.js" dump "$work/db.dump" "$work/counts.json" || die 1 "database dump failed"
if [ "$DB_ONLY" = 0 ]; then
  tar -czf "$work/files.tar.gz" -C "$FILES_DIR" . || die 1 "files archive failed"
fi

dow=$(date -u -d "${STAMP:0:8}" +%u)   # 7 = Sunday
kind=daily
[ "$dow" = 7 ] && kind=weekly
# The deploys' database-only backups never take a nightly backup's slot.
[ "$DB_ONLY" = 1 ] && kind=db-only

STAMP="$STAMP" KIND="$kind" WORK="$work" node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path");
  const w = process.env.WORK;
  const part = (f) => fs.existsSync(path.join(w, f))
    ? { file: f, bytes: fs.statSync(path.join(w, f)).size,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(w, f))).digest("hex") }
    : null;
  const manifest = {
    stamp: process.env.STAMP, kind: process.env.KIND, created_at: new Date().toISOString(),
    release: process.env.RELEASE || null, db: part("db.dump"), files: part("files.tar.gz"),
    counts: JSON.parse(fs.readFileSync(path.join(w, "counts.json"), "utf8")),
  };
  fs.writeFileSync(path.join(w, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.unlinkSync(path.join(w, "counts.json"));'

rm -rf "${dest:?}/$STAMP"
mv "$work" "$dest/$STAMP"
trap - EXIT
say "done: $dest/$STAMP ($kind)"

# Rotation: the newest KEEP_DAILY daily, KEEP_WEEKLY weekly and KEEP_DB_ONLY
# db-only backups stay, each kind on its own.
for k in daily weekly db-only; do
  keep=$KEEP_DAILY; [ "$k" = weekly ] && keep=$KEEP_WEEKLY; [ "$k" = db-only ] && keep=$KEEP_DB_ONLY
  mapfile -t snaps < <(for d in "$dest"/[0-9]*T*Z; do
    [ -f "$d/manifest.json" ] || continue
    grep -q "\"kind\": \"$k\"" "$d/manifest.json" && basename "$d"
  done | sort -r)
  for old in "${snaps[@]:$keep}"; do rm -rf "${dest:?}/$old"; say "removed old $k backup $old"; done
done
