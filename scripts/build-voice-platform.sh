#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_ROOT="$PROJECT_ROOT/voice-platform"
SYNC_DB=0

for argument in "$@"; do
  case "$argument" in
    --sync-db) SYNC_DB=1 ;;
    *) printf 'Unknown argument: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js is required.' >&2; exit 1; }
[ -f "$VOICE_ROOT/package.json" ] || { printf '%s\n' 'voice-platform/package.json is required.' >&2; exit 1; }
[ -f "$VOICE_ROOT/pnpm-lock.yaml" ] || { printf '%s\n' 'voice-platform/pnpm-lock.yaml is required.' >&2; exit 1; }
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf 'voice-platform production build requires Node.js >=22; found %s\n' "$(node -v)" >&2
  exit 1
fi

export NEXT_TELEMETRY_DISABLED=1

# voice-platform intentionally owns an independent package.json and lockfile.
# The explicit CLI flag is required: pnpm configuration files do not reliably
# override a parent pnpm-workspace.yaml for this command path.
corepack pnpm --dir "$VOICE_ROOT" install --frozen-lockfile --ignore-workspace
node -e "const version=require(process.argv[1]).version;if(!version.startsWith('15.')){throw new Error('voice-platform must resolve Next.js 15, got '+version)};console.log('voice-platform Next.js '+version)" "$VOICE_ROOT/node_modules/next/package.json"
corepack pnpm --dir "$VOICE_ROOT" --ignore-workspace exec prisma generate

if [ "$SYNC_DB" = "1" ]; then
  [ -n "${DATABASE_URL:-}" ] || { printf '%s\n' 'DATABASE_URL is required with --sync-db.' >&2; exit 1; }
  corepack pnpm --dir "$VOICE_ROOT" --ignore-workspace exec prisma db push
else
  printf '%s\n' 'voice-platform database synchronization skipped (default).'
fi

corepack pnpm --dir "$VOICE_ROOT" --ignore-workspace exec tsc --noEmit
corepack pnpm --dir "$VOICE_ROOT" --ignore-workspace run build
