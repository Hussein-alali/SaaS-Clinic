#!/usr/bin/env bash
# Goes back to an earlier release (docs/06 S2, runbook in docs/08):
#
#   scripts/rollback.sh [release-name]
#
# Without a name: the newest release older than `current` that did not fail
# a deploy (no .failed marker). Restarts the app and waits for the health
# check. Code only: the database stays as it is (migrations are
# expand/contract; restore the pre-deploy dump for a bad migration).
#
# Same environment as scripts/deploy.sh. Exit codes: 0 back and healthy ·
# 1 no such release · 2 switched but not healthy.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/release-lib.sh
. "$SCRIPTS/release-lib.sh"

cur="$(current_release)"
target="${1:-}"
if [ -z "$target" ]; then
  while read -r r; do
    [ "$r" \< "$cur" ] || continue
    [ -e "$APP_HOME/releases/$r/.failed" ] && continue
    target="$r"; break
  done < <(ls -1 "$APP_HOME/releases" | sort -r)
fi
[ -n "$target" ] && [ -d "$APP_HOME/releases/$target" ] || { log "no release to go back to (${target:-none})"; exit 1; }

switch_to "$target"
log "switched from ${cur:-nothing} to $target"
restart_and_check || { log "$target is not healthy"; exit 2; }
log "rolled back to $target"
