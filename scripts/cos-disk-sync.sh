#!/usr/bin/env bash
set -Eeuo pipefail

# Sync COS snapshots/media to the mounted data disk.
# Requires coscmd configured from protected env variables.

DATA_ROOT="${DATA_ROOT:-/data/agent-hub}"
ENV_FILE="${ENV_FILE:-$DATA_ROOT/env/.env.local}"
COS_LOCAL_DIR="${COS_LOCAL_DIR:-$DATA_ROOT/cos-mirror}"
COS_BUCKET="${COS_BUCKET:-}"
COS_REGION="${COS_REGION:-}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${COS_SECRET_ID:?COS_SECRET_ID is required}"
: "${COS_SECRET_KEY:?COS_SECRET_KEY is required}"
: "${COS_BUCKET:?COS_BUCKET is required}"
: "${COS_REGION:?COS_REGION is required}"

mkdir -p "$COS_LOCAL_DIR"

if ! command -v coscmd >/dev/null 2>&1; then
  echo "coscmd is not installed. Install it with: python3 -m pip install -U coscmd"
  exit 1
fi

coscmd config -a "$COS_SECRET_ID" -s "$COS_SECRET_KEY" -b "$COS_BUCKET" -r "$COS_REGION" >/dev/null

case "${1:-pull}" in
  pull)
    coscmd download -r / "$COS_LOCAL_DIR"
    ;;
  push)
    echo "Push is disabled by default. Use: ALLOW_COS_PUSH=YES $0 push"
    [ "${ALLOW_COS_PUSH:-}" = "YES" ] || exit 1
    coscmd upload -r "$COS_LOCAL_DIR" /
    ;;
  *)
    echo "Usage: $0 pull|push"
    exit 2
    ;;
esac
