#!/usr/bin/env bash
set -Eeuo pipefail

# LEGACY_DEPLOY_DISABLED
echo "This legacy Git backup entry is disabled."
echo "Code release: pnpm run release:publish"
echo "Business data backups must stay outside Git."
exit 1
