#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ACTIVATE="$ROOT/scripts/deploy-activate.sh"
NODE_BIN=$(command -v node)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export DEPLOY_ACTIVATE_LIBRARY_ONLY=1
# shellcheck source=deploy-activate.sh
source "$ACTIVATE"

PASS_COUNT=0
expect_pass() {
  local label="$1"
  shift
  if ( "$@" ) >"$TMP/$label.out" 2>"$TMP/$label.err"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    return
  fi
  echo "FAIL expected pass: $label" >&2
  cat "$TMP/$label.err" >&2 || true
  exit 1
}

expect_fail() {
  local label="$1"
  shift
  if ( "$@" ) >"$TMP/$label.out" 2>"$TMP/$label.err"; then
    echo "FAIL expected rejection: $label" >&2
    exit 1
  fi
  PASS_COUNT=$((PASS_COUNT + 1))
}

# The production contract requires root ownership. The fixture substitutes only
# stat ownership metadata; archive parsing, hashes and extracted inventory are real.
stat() {
  if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%u %a %F" ]; then
    local candidate="${!#}"
    if [ -d "$candidate" ]; then printf '0 700 directory\n'; else printf '0 600 regular file\n'; fi
    return 0
  fi
  command stat "$@"
}

DATA_ROOT="$TMP/data"
WEB_ROOT="$DATA_ROOT/web"
CONFIG="$TMP/deploy-storage.conf"
FSTAB="$TMP/fstab"
MARKER="$DATA_ROOT/.zimeiti-storage-root"
mkdir -p "$WEB_ROOT" "$DATA_ROOT/direct-deploy/incoming" "$DATA_ROOT/web/releases"
printf 'zimeiti-storage-fixture-v1\n' > "$MARKER"
MARKER_HASH=$(sha256sum "$MARKER" | awk '{print $1}')
cat > "$CONFIG" <<EOF
DATA_MOUNT_SOURCE=/dev/vdb
DATA_MOUNT_UUID=fixture-uuid-0001
DATA_MARKER_SHA256=$MARKER_HASH
MIN_AVAILABLE_BYTES=5368709120
MIN_AVAILABLE_INODES=50000
EOF
printf 'UUID=fixture-uuid-0001 %s ext4 defaults,noatime 0 2\n' "$DATA_ROOT" > "$FSTAB"

MOCK_MOUNTED=1
MOCK_ROOT_DEVICE='8:1'
MOCK_DATA_DEVICE='8:16'
MOCK_UUID='fixture-uuid-0001'
MOCK_SOURCE='/dev/vdb'
mountpoint() {
  [ "$MOCK_MOUNTED" = "1" ]
}
findmnt() {
  local fstab_mode=0 field='' target='' previous='' arg
  for arg in "$@"; do
    [ "$previous" = "-o" ] && field="$arg"
    [ "$previous" = "--target" ] && target="$arg"
    [ "$arg" = "--fstab" ] && fstab_mode=1
    previous="$arg"
  done
  if [ "$fstab_mode" = "1" ]; then
    printf 'UUID=%s\n' "$MOCK_UUID"
    return 0
  fi
  case "$field" in
    TARGET) printf '%s\n' "$DATA_ROOT" ;;
    SOURCE) printf '%s\n' "$MOCK_SOURCE" ;;
    UUID) printf '%s\n' "$MOCK_UUID" ;;
    MAJ:MIN)
      if [ "$target" = "/" ]; then printf '%s\n' "$MOCK_ROOT_DEVICE"; else printf '%s\n' "$MOCK_DATA_DEVICE"; fi ;;
    *) return 2 ;;
  esac
}
df() {
  case " $* " in
    *" --output=avail "*) printf 'Avail\n100000000000\n' ;;
    *" --output=iavail "*) printf 'IAvail\n1000000\n' ;;
    *) return 2 ;;
  esac
}

storage_check() {
  verify_storage_contract "$DATA_ROOT" "$WEB_ROOT" "$CONFIG" "$FSTAB"
}

expect_pass storage-normal storage_check
MOCK_MOUNTED=0
expect_fail storage-mount-missing storage_check
MOCK_MOUNTED=1
MOCK_DATA_DEVICE="$MOCK_ROOT_DEVICE"
expect_fail storage-root-device storage_check
MOCK_DATA_DEVICE='8:16'
sed "s/$MARKER_HASH/0000000000000000000000000000000000000000000000000000000000000000/" "$CONFIG" > "$CONFIG.bad"
CONFIG_GOOD="$CONFIG"
CONFIG="$CONFIG.bad"
expect_fail storage-marker-mismatch storage_check
CONFIG="$CONFIG_GOOD"
MOCK_UUID='wrong-persistent-uuid'
expect_fail storage-persistent-uuid-mismatch storage_check
MOCK_UUID='fixture-uuid-0001'

STAGE="$TMP/stage"
mkdir -p "$STAGE/.next"
printf 'fixture server\n' > "$STAGE/server.js"
printf 'fixture-build-id\n' > "$STAGE/.next/BUILD_ID"
"$NODE_BIN" - "$STAGE" <<'NODEEOF'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = process.argv[2];
const files = ['.next/BUILD_ID', 'server.js'].map(relative => {
  const bytes = fs.readFileSync(path.join(root, relative));
  return {path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
}).sort((a, b) => a.path.localeCompare(b.path, 'en'));
const artifactDigest = crypto.createHash('sha256').update(files.map(file => `${file.sha256}  ${file.path}\n`).join('')).digest('hex');
const manifest = {schemaVersion: 2, kind: 'immutable-standalone-service-artifact', files,
  fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), artifactDigest};
fs.writeFileSync(path.join(root, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
NODEEOF

BASE_TAR="$TMP/base.tar"
NORMAL_TAR="$TMP/normal.tar.gz"
tar -cf "$BASE_TAR" -C "$STAGE" .
gzip -c "$BASE_TAR" > "$NORMAL_TAR"
MIN_AVAILABLE_BYTES=5368709120
MIN_AVAILABLE_INODES=50000

archive_preflight() {
  preflight_archive "$1" "$NODE_BIN" 100000000000 1000000
}
expect_pass archive-normal archive_preflight "$NORMAL_TAR"

EXTRACTED="$TMP/extracted"
mkdir -p "$EXTRACTED"
tar --extract --gzip --file="$NORMAL_TAR" --directory="$EXTRACTED" --no-same-owner --no-same-permissions --delay-directory-restore --restrict
NORMAL_SHA=$(sha256sum "$NORMAL_TAR" | awk '{print $1}')
expect_pass inventory-normal verify_extracted_inventory "$EXTRACTED" "$NODE_BIN" "$NORMAL_TAR" "$NORMAL_SHA"
printf 'tampered\n' >> "$EXTRACTED/server.js"
expect_fail inventory-tamper verify_extracted_inventory "$EXTRACTED" "$NODE_BIN" "$NORMAL_TAR" "$NORMAL_SHA"

printf 'escape\n' > "$TMP/escape"
cp "$BASE_TAR" "$TMP/traversal.tar"
tar --append --file="$TMP/traversal.tar" --transform='s|^|../|' -C "$TMP" escape 2>/dev/null
gzip -c "$TMP/traversal.tar" > "$TMP/traversal.tar.gz"
expect_fail archive-traversal archive_preflight "$TMP/traversal.tar.gz"

cp "$BASE_TAR" "$TMP/absolute.tar"
tar --append --file="$TMP/absolute.tar" --transform='s|^|/absolute/|' -C "$TMP" escape 2>/dev/null
gzip -c "$TMP/absolute.tar" > "$TMP/absolute.tar.gz"
expect_fail archive-absolute archive_preflight "$TMP/absolute.tar.gz"

mkdir -p "$TMP/hardlinks"
printf 'linked\n' > "$TMP/hardlinks/source"
ln "$TMP/hardlinks/source" "$TMP/hardlinks/alias"
cp "$BASE_TAR" "$TMP/hardlink.tar"
tar --append --file="$TMP/hardlink.tar" -C "$TMP/hardlinks" source alias
gzip -c "$TMP/hardlink.tar" > "$TMP/hardlink.tar.gz"
expect_fail archive-hardlink archive_preflight "$TMP/hardlink.tar.gz"

cp "$TMP/hardlink.tar" "$TMP/symlink.tar"
"$NODE_BIN" - "$TMP/symlink.tar" <<'NODEEOF'
const fs = require('fs');
const file = process.argv[2];
const archive = fs.readFileSync(file);
for (let offset = 0; offset + 512 <= archive.length;) {
  const header = archive.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
  const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
  if (name === 'alias') {
    header[156] = '2'.charCodeAt(0);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const encoded = checksum.toString(8).padStart(6, '0');
    header.write(encoded, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    fs.writeFileSync(file, archive);
    process.exit(0);
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
throw new Error('hardlink fixture entry not found');
NODEEOF
gzip -c "$TMP/symlink.tar" > "$TMP/symlink.tar.gz"
expect_fail archive-symlink archive_preflight "$TMP/symlink.tar.gz"

mkdir -p "$TMP/special"
mkfifo "$TMP/special/pipe"
cp "$BASE_TAR" "$TMP/fifo.tar"
tar --append --file="$TMP/fifo.tar" -C "$TMP/special" pipe
gzip -c "$TMP/fifo.tar" > "$TMP/fifo.tar.gz"
expect_fail archive-fifo archive_preflight "$TMP/fifo.tar.gz"

grep -Eq 'l\|h\).*archive links are forbidden' "$ACTIVATE"
grep -Eq 'b\|c\|p\|s\).*archive special files are forbidden' "$ACTIVATE"
PASS_COUNT=$((PASS_COUNT + 2))

echo "deploy storage guard zero-network verifier: PASS ($PASS_COUNT checks; network=0 writes=temporary-fixtures-only)"
