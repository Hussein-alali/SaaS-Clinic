# Shared by scripts/deploy.sh and scripts/rollback.sh (sourced, not run).
APP_HOME="${APP_HOME:-$HOME/clinicsys}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-3000}/api/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-2}"

log() { printf '%s release: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# The release `current` points to (folder name), or nothing.
current_release() {
  [ -L "$APP_HOME/current" ] && basename "$(readlink "$APP_HOME/current")" || true
}

# Atomic switch: a new symlink renamed over the old one.
switch_to() {
  ln -sfn "releases/$1" "$APP_HOME/current.tmp"
  mv -T "$APP_HOME/current.tmp" "$APP_HOME/current"
}

# Restart the app (Passenger restarts on tmp/restart.txt) and wait until
# HEALTH_URL answers 2xx, at most HEALTH_TIMEOUT seconds.
restart_and_check() {
  if [ -n "${RESTART_CMD:-}" ]; then
    bash -c "$RESTART_CMD"
  else
    mkdir -p "$APP_HOME/current/api/tmp" && touch "$APP_HOME/current/api/tmp/restart.txt"
  fi
  HEALTH_URL="$HEALTH_URL" HEALTH_TIMEOUT="$HEALTH_TIMEOUT" HEALTH_INTERVAL="$HEALTH_INTERVAL" node -e '
    const url = process.env.HEALTH_URL, until = Date.now() + Number(process.env.HEALTH_TIMEOUT) * 1000;
    const wait = Number(process.env.HEALTH_INTERVAL) * 1000;
    (async () => {
      for (;;) {
        try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok) process.exit(0); } catch {}
        if (Date.now() > until) process.exit(1);
        await new Promise((r) => setTimeout(r, wait));
      }
    })();'
}
