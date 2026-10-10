#!/usr/bin/env bash
set -Eeuo pipefail

cat >&2 <<'EOF'
BLOCKED: scripts/package-local-release.sh is a retired release path.

It cannot produce the immutable, link-free, fully inventoried schemaVersion=2
artifact required by the production activation gate. Use the single vNext path:

  node scripts/package-standalone-artifact.mjs \
    --service web \
    --output <new-artifact-directory> \
    --release-id <release-id> \
    --commit <clean-git-head> \
    --archive \
    --archive-path <new-tar-gz-path>

Production artifacts must come from the locked Linux builder with clean-Git
build provenance. Local Windows builds remain rehearsal-only.
EOF

exit 2
