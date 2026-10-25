#!/usr/bin/env bash
# Builds a release tarball for scripts/deploy.sh (docs/06 S2):
#
#   scripts/package-release.sh [out.tar.gz]   (default: release-<git sha>.tar.gz)
#
# Runs the production build (dist/ needs esbuild, a dev dependency, so it is
# built here and not on the server) and packs what the server runs: api/,
# db/, dist/, scripts/ and the root package files — no node_modules, tests,
# outboxes or local env files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
OUT="$(realpath -m "${1:-$ROOT/release-$sha.tar.gz}")"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
BUILD_OUT="$stage/dist" node "$ROOT/scripts/build.mjs" >/dev/null

tar -C "$ROOT" -cf - \
  --exclude=node_modules --exclude='api/test' --exclude='db/test' --exclude='api/.outbox*' \
  --exclude='.env' --exclude='*.log' \
  api db scripts package.json | tar -C "$stage" -xf -
tar -C "$stage" -czf "$OUT" .
echo "$OUT"
