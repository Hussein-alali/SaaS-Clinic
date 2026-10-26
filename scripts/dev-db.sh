#!/usr/bin/env bash
# Local PostgreSQL that behaves like a cPanel database: the app connects as
# an ordinary owner role (no superuser, no CREATEROLE, no CREATEDB), so any
# migration that needs more privileges than hosting.com grants fails here
# first.
#
#   scripts/dev-db.sh start [port] [datadir]   → prints DATABASE_URL
#   scripts/dev-db.sh stop  [port] [datadir]
#   scripts/dev-db.sh reset [port] [datadir]   → drop + recreate the database
#
# Defaults: port 54329, datadir /tmp/clinicsys-pg-<port>. Use a different
# port per parallel test run. Needs the PostgreSQL server binaries
# (initdb/pg_ctl); run as root or as a user that can start a cluster.
set -euo pipefail

CMD="${1:-start}"
PORT="${2:-54329}"
DATA="${3:-/tmp/clinicsys-pg-$PORT}"
DB="clinicsys"
OWNER="clinic_owner"
PASS="clinic_owner_dev"

BIN="$(dirname "$(command -v pg_ctl 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/pg_ctl 2>/dev/null | sort -V | tail -1)")"
[ -x "$BIN/pg_ctl" ] || { echo "dev-db: pg_ctl not found" >&2; exit 1; }

# initdb/pg_ctl refuse to run as root; use the postgres OS user when we are root.
as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}
psql_super() { as_pg "$BIN/psql" -h /tmp -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

url() { echo "postgres://$OWNER:$PASS@127.0.0.1:$PORT/$DB"; }

create_db() {
  psql_super -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null
  psql_super -d postgres -c "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$OWNER') THEN CREATE ROLE $OWNER LOGIN PASSWORD '$PASS' NOSUPERUSER NOCREATEROLE NOCREATEDB; END IF; END\$\$" >/dev/null
  psql_super -d postgres -c "CREATE DATABASE $DB OWNER $OWNER" >/dev/null
  # cPanel databases have the public schema owned by the account user.
  psql_super -d "$DB" -c "ALTER SCHEMA public OWNER TO $OWNER" >/dev/null
  # An empty second database for scripts/restore-check.sh (docs/06 S1).
  psql_super -d postgres -c "DROP DATABASE IF EXISTS ${DB}_restore" >/dev/null
  psql_super -d postgres -c "CREATE DATABASE ${DB}_restore OWNER $OWNER" >/dev/null
  psql_super -d "${DB}_restore" -c "ALTER SCHEMA public OWNER TO $OWNER" >/dev/null
}

case "$CMD" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      mkdir -p "$DATA"; chown postgres:postgres "$DATA" 2>/dev/null || true
      as_pg "$BIN/initdb" -D "$DATA" -U postgres -A trust --locale=C.UTF-8 -E UTF8 >/dev/null
    fi
    if ! as_pg "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      as_pg "$BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w \
        -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" start >/dev/null
    fi
    if [ "$(psql_super -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$DB'")" != "1" ]; then create_db; fi
    url
    ;;
  reset)
    "$0" start "$PORT" "$DATA" >/dev/null
    create_db
    url
    ;;
  stop)
    as_pg "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop|reset [port] [datadir]" >&2; exit 2 ;;
esac
