#!/usr/bin/env bash
set -Eeuo pipefail

# LEGACY_DEPLOY_DISABLED
echo "This legacy sync deploy entry is disabled."
echo "Use: pnpm run release:publish"
echo "Server-side deploy must use: pnpm run release:deploy"
exit 1
