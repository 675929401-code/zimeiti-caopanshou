#!/usr/bin/env bash
# LEGACY_DEPLOY_DISABLED

echo "BLOCKED: voice-platform/deploy.sh is a retired development installer." >&2
echo "It must not clone an old repository, mutate a database, seed accounts, or run a dev server during deployment." >&2
echo "Use the reviewed vNext immutable artifact pipeline under deploy/ and scripts/deploy-artifact-vnext.sh." >&2
exit 2
