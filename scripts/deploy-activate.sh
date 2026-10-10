#!/bin/bash
# deploy-activate.sh —— 服务器端候选验收与原子切换（三轨制 A 轨执行器）
# 用法: bash deploy-activate.sh <release_id> <package_tar_path>
# 原则: 候选先验,同身份 env(继承当前生产进程),原子指针切换,失败零生产影响,绝不触碰业务数据。
set -euo pipefail

log() { echo "[activate] $*"; }
fail() { echo "[activate] FATAL: $*" >&2; exit 1; }

require_uint() {
  local label="$1" value="$2" minimum="$3"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$label must be an unsigned integer"
  (( 10#$value >= minimum )) || fail "$label is below the built-in safety floor ($minimum)"
}

require_root_controlled_file() {
  local file="$1" label="$2" metadata owner mode kind
  [ -f "$file" ] && [ ! -L "$file" ] || fail "$label must be a regular non-symlink file: $file"
  metadata=$(stat -c '%u %a %F' -- "$file") || fail "cannot stat $label: $file"
  read -r owner mode kind <<< "$metadata"
  [ "$owner" = "0" ] || fail "$label must be owned by root: $file"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "$label has an invalid mode: $file"
  (( (8#$mode & 8#022) == 0 )) || fail "$label must not be group/other writable: $file"
  [ "$kind" = "regular file" ] || fail "$label is not a regular file: $file"
}

require_root_controlled_directory() {
  local directory="$1" label="$2" metadata owner mode kind
  [ -d "$directory" ] && [ ! -L "$directory" ] || fail "$label must be an existing non-symlink directory: $directory"
  metadata=$(stat -c '%u %a %F' -- "$directory") || fail "cannot stat $label: $directory"
  read -r owner mode kind <<< "$metadata"
  [ "$owner" = "0" ] || fail "$label must be owned by root: $directory"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "$label has an invalid mode: $directory"
  (( (8#$mode & 8#022) == 0 )) || fail "$label must not be group/other writable: $directory"
  [ "$kind" = "directory" ] || fail "$label is not a directory: $directory"
}

load_storage_contract() {
  local config="$1" raw key value
  require_root_controlled_file "$config" "storage contract"
  DATA_MOUNT_SOURCE=""
  DATA_MOUNT_UUID=""
  DATA_MARKER_SHA256=""
  MIN_AVAILABLE_BYTES=""
  MIN_AVAILABLE_INODES=""
  declare -A seen=()
  while IFS= read -r raw || [ -n "$raw" ]; do
    raw="${raw%$'\r'}"
    [[ -z "$raw" || "$raw" == \#* ]] && continue
    [[ "$raw" =~ ^([A-Z_][A-Z0-9_]*)=([^[:space:]]+)$ ]] || fail "invalid storage contract line"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [ -z "${seen[$key]:-}" ] || fail "duplicate storage contract key: $key"
    seen[$key]=1
    case "$key" in
      DATA_MOUNT_SOURCE) DATA_MOUNT_SOURCE="$value" ;;
      DATA_MOUNT_UUID) DATA_MOUNT_UUID="$value" ;;
      DATA_MARKER_SHA256) DATA_MARKER_SHA256="$value" ;;
      MIN_AVAILABLE_BYTES) MIN_AVAILABLE_BYTES="$value" ;;
      MIN_AVAILABLE_INODES) MIN_AVAILABLE_INODES="$value" ;;
      *) fail "unsupported storage contract key: $key" ;;
    esac
  done < "$config"
  [[ "$DATA_MOUNT_SOURCE" =~ ^/dev/[A-Za-z0-9._/+:-]+$ ]] || fail "invalid DATA_MOUNT_SOURCE"
  [[ "$DATA_MOUNT_UUID" =~ ^[A-Za-z0-9._:-]{4,128}$ ]] || fail "invalid DATA_MOUNT_UUID"
  [[ "$DATA_MARKER_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "invalid DATA_MARKER_SHA256"
  require_uint MIN_AVAILABLE_BYTES "$MIN_AVAILABLE_BYTES" 5368709120
  require_uint MIN_AVAILABLE_INODES "$MIN_AVAILABLE_INODES" 50000
}

findmnt_field() {
  local field="$1" target="$2"
  findmnt -n -o "$field" --target "$target" 2>/dev/null | head -n 1
}

assert_on_data_mount() {
  local path="$1" data_root="$2" data_device="$3" resolved path_device
  resolved=$(readlink -f -- "$path") || fail "path is missing or unreadable: $path"
  case "$resolved" in
    "$data_root"|"$data_root"/*) ;;
    *) fail "path escaped the data mount: $path -> $resolved" ;;
  esac
  case "$resolved" in /srv|/srv/*) fail "legacy /srv/system-disk path is forbidden: $resolved" ;; esac
  path_device=$(findmnt_field 'MAJ:MIN' "$resolved")
  [ -n "$path_device" ] && [ "$path_device" = "$data_device" ] || fail "path is not backed by the configured data device: $resolved"
}

verify_storage_contract() {
  local data_root="$1" web_root="$2" config="$3" fstab="$4"
  local marker actual_source actual_uuid root_device data_device mount_target web_target
  local configured_fstab_source marker_hash available_bytes available_inodes
  for command_name in findmnt mountpoint stat df sha256sum readlink tar; do
    command -v "$command_name" >/dev/null 2>&1 || fail "required storage guard command missing: $command_name"
  done
  [ "$data_root" = "/data" ] || [ "${DEPLOY_ACTIVATE_LIBRARY_ONLY:-0}" = "1" ] || fail "production data root must remain /data"
  [ "$web_root" = "$data_root/web" ] || fail "web root must be directly under the data mount"
  case "$data_root $web_root" in *"/srv"*) fail "legacy /srv/system-disk path is forbidden" ;; esac

  load_storage_contract "$config"
  mountpoint -q -- "$data_root" || fail "$data_root is not a real mountpoint"
  [ "$(readlink -f -- "$data_root")" = "$data_root" ] || fail "$data_root must not be a symlink or redirected path"
  mount_target=$(findmnt_field TARGET "$data_root")
  [ "$mount_target" = "$data_root" ] || fail "findmnt target mismatch for $data_root"
  actual_source=$(findmnt_field SOURCE "$data_root")
  actual_uuid=$(findmnt_field UUID "$data_root")
  data_device=$(findmnt_field 'MAJ:MIN' "$data_root")
  root_device=$(findmnt_field 'MAJ:MIN' /)
  [ -n "$actual_source" ] && [ "$actual_source" = "$DATA_MOUNT_SOURCE" ] || fail "data mount source mismatch"
  [ -n "$actual_uuid" ] && [ "$actual_uuid" = "$DATA_MOUNT_UUID" ] || fail "data mount UUID mismatch"
  [ -n "$data_device" ] && [ -n "$root_device" ] && [ "$data_device" != "$root_device" ] || fail "$data_root resolves to the system root device"

  require_root_controlled_file "$fstab" "fstab"
  configured_fstab_source=$(findmnt --fstab -n -o SOURCE --target "$data_root" 2>/dev/null | head -n 1)
  case "$configured_fstab_source" in
    "UUID=$DATA_MOUNT_UUID"|"/dev/disk/by-uuid/$DATA_MOUNT_UUID") ;;
    *) fail "$data_root is not persistently configured by the expected UUID" ;;
  esac

  [ -d "$web_root" ] && [ ! -L "$web_root" ] || fail "web root must be an existing non-symlink directory: $web_root"
  require_root_controlled_directory "$web_root" "web root"
  web_target=$(findmnt_field TARGET "$web_root")
  [ "$web_target" = "$data_root" ] || fail "$web_root is not located on the dedicated data mount"
  assert_on_data_mount "$web_root" "$data_root" "$data_device"

  marker="$data_root/.zimeiti-storage-root"
  require_root_controlled_file "$marker" "storage identity marker"
  marker_hash=$(sha256sum -- "$marker" | awk '{print $1}')
  [ "$marker_hash" = "$DATA_MARKER_SHA256" ] || fail "storage identity marker hash mismatch"

  available_bytes=$(df -P -B1 --output=avail "$data_root" | awk 'NR == 2 {print $1}')
  available_inodes=$(df -P -i --output=iavail "$data_root" | awk 'NR == 2 {print $1}')
  require_uint available_bytes "$available_bytes" "$MIN_AVAILABLE_BYTES"
  require_uint available_inodes "$available_inodes" "$MIN_AVAILABLE_INODES"
  STORAGE_DATA_DEVICE="$data_device"
  STORAGE_AVAILABLE_BYTES="$available_bytes"
  STORAGE_AVAILABLE_INODES="$available_inodes"
  log "storage guard OK: mount=$data_root source=$actual_source uuid=$actual_uuid availableBytes=$available_bytes availableInodes=$available_inodes"
}

normalize_archive_path() {
  local path="$1"
  while [[ "$path" == ./* ]]; do path="${path#./}"; done
  [ "$path" = "." ] && path=""
  while [[ "$path" == */ ]]; do path="${path%/}"; done
  printf '%s' "$path"
}

validate_archive_path() {
  local raw="$1" path component
  [[ "$raw" != *$'\r'* && "$raw" != *$'\n'* && "$raw" != *$'\t'* && "$raw" != *'\\'* ]] || fail "archive contains a control/backslash path"
  [[ "$raw" != /* ]] || fail "archive contains an absolute path: $raw"
  path=$(normalize_archive_path "$raw")
  [ -n "$path" ] || return 0
  [[ "$path" != */./* && "$path" != */. && "$path" != *//* ]] || fail "archive contains a non-canonical path: $raw"
  IFS='/' read -r -a components <<< "$path"
  for component in "${components[@]}"; do
    [ -n "$component" ] || fail "archive contains an empty path component: $raw"
    [ "$component" != ".." ] || fail "archive contains parent traversal: $raw"
  done
  [ "${#path}" -le 4096 ] || fail "archive path exceeds 4096 bytes"
}

preflight_archive() {
  local pkg="$1" node_bin="$2" available_bytes="$3" available_inodes="$4"
  local names verbose raw normalized line type size regular_count=0 regular_bytes=0
  local manifest_member="" manifest_count=0 manifest_size=0 metadata required_bytes required_inodes entry_count=0 archive_bytes
  declare -A seen_paths=()
  require_root_controlled_file "$pkg" "release archive"
  tar --help 2>/dev/null | grep -q -- '--restrict' || fail "GNU tar with --restrict support is required"
  archive_bytes=$(stat -c '%s' -- "$pkg") || fail "cannot stat release archive size"
  [[ "$archive_bytes" =~ ^[0-9]+$ ]] && [ "$archive_bytes" -gt 0 ] || fail "release archive size is invalid"
  names=$(LC_ALL=C tar --list --gzip --file="$pkg" --quoting-style=escape) || fail "release archive cannot be listed"
  [ -n "$names" ] || fail "release archive is empty"
  while IFS= read -r raw || [ -n "$raw" ]; do
    validate_archive_path "$raw"
    normalized=$(normalize_archive_path "$raw")
    [ -n "$normalized" ] || continue
    entry_count=$((entry_count + 1))
    [ "$entry_count" -le 250000 ] || fail "archive entry count exceeds the safety ceiling"
    [ -z "${seen_paths[$normalized]:-}" ] || fail "archive contains a duplicate path: $normalized"
    seen_paths[$normalized]=1
    if [ "$normalized" = "release-manifest.json" ]; then
      manifest_member="$raw"
      manifest_count=$((manifest_count + 1))
    fi
  done <<< "$names"
  [ "$manifest_count" -eq 1 ] || fail "archive must contain exactly one root release-manifest.json"

  verbose=$(LC_ALL=C tar --list --verbose --gzip --numeric-owner --full-time --quoting-style=escape --file="$pkg") || fail "release archive metadata cannot be listed"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    type="${line:0:1}"
    case "$type" in
      -|d) ;;
      l|h) fail "archive links are forbidden (type=$type)" ;;
      b|c|p|s) fail "archive special files are forbidden (type=$type)" ;;
      *) fail "archive contains an unsupported entry type: $type" ;;
    esac
    if [ "$type" = "-" ]; then
      set -- $line
      size="${3:-}"
      [[ "$size" =~ ^[0-9]+$ ]] || fail "archive regular-file size is unreadable"
      regular_count=$((regular_count + 1))
      regular_bytes=$((regular_bytes + size))
    fi
  done <<< "$verbose"

  metadata=$(tar --extract --to-stdout --gzip --file="$pkg" -- "$manifest_member" | "$node_bin" -e '
const fs = require("fs");
const crypto = require("crypto");
const manifest = JSON.parse(fs.readFileSync(0, "utf8"));
if (manifest.schemaVersion !== 2 || manifest.kind !== "immutable-standalone-service-artifact") throw new Error("invalid manifest identity");
if (!Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount !== manifest.files.length) throw new Error("invalid manifest fileCount");
if (manifest.fileCount > 250000) throw new Error("manifest fileCount exceeds the safety ceiling");
if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0) throw new Error("invalid manifest totalBytes");
if (!/^[0-9a-f]{64}$/.test(manifest.artifactDigest || "")) throw new Error("invalid manifest artifactDigest");
process.stdout.write(`${manifest.fileCount} ${manifest.totalBytes}`);
') || fail "embedded release inventory metadata is invalid"
  read -r MANIFEST_FILE_COUNT MANIFEST_TOTAL_BYTES <<< "$metadata"
  manifest_size=$(printf '%s\n' "$names" | awk '$0 == "./release-manifest.json" || $0 == "release-manifest.json" { found=1 } END { if (!found) exit 1 }' >/dev/null && tar --extract --to-stdout --gzip --file="$pkg" -- "$manifest_member" | wc -c) || fail "cannot measure release manifest"
  [ "$regular_count" -eq $((MANIFEST_FILE_COUNT + 1)) ] || fail "archive regular-file count does not match embedded inventory"
  [ "$regular_bytes" -eq $((MANIFEST_TOTAL_BYTES + manifest_size)) ] || fail "archive byte total does not match embedded inventory"
  required_bytes=$((MIN_AVAILABLE_BYTES + MANIFEST_TOTAL_BYTES + MANIFEST_TOTAL_BYTES / 10 + 67108864))
  required_inodes=$((MIN_AVAILABLE_INODES + MANIFEST_FILE_COUNT + 1024))
  [ "$available_bytes" -ge "$required_bytes" ] || fail "data mount free-byte waterline would be crossed by this release"
  [ "$available_inodes" -ge "$required_inodes" ] || fail "data mount free-inode waterline would be crossed by this release"
  ARCHIVE_SHA256=$(sha256sum -- "$pkg" | awk '{print $1}')
  log "archive preflight OK: files=$MANIFEST_FILE_COUNT bytes=$MANIFEST_TOTAL_BYTES sha256=$ARCHIVE_SHA256"
}

verify_extracted_inventory() {
  local target="$1" node_bin="$2" pkg="$3" before_sha="$4" after_sha
  after_sha=$(sha256sum -- "$pkg" | awk '{print $1}')
  [ "$after_sha" = "$before_sha" ] || fail "release archive changed during extraction"
  "$node_bin" - "$target" <<'NODEEOF'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = fs.realpathSync(process.argv[2]);
const manifestPath = path.join(root, 'release-manifest.json');
const manifestStat = fs.lstatSync(manifestPath);
if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('release-manifest.json must be a regular file');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 2 || manifest.kind !== 'immutable-standalone-service-artifact') throw new Error('invalid release manifest identity');
if (!Array.isArray(manifest.files) || manifest.fileCount !== manifest.files.length) throw new Error('invalid release inventory count');
const expected = new Map();
let previous = '';
for (const entry of manifest.files) {
  if (!entry || typeof entry.path !== 'string' || path.posix.normalize(entry.path) !== entry.path || path.posix.isAbsolute(entry.path)
    || entry.path.split('/').includes('..') || entry.path === 'release-manifest.json' || previous && previous.localeCompare(entry.path, 'en') >= 0
    || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')) throw new Error(`invalid release inventory entry: ${entry?.path || '<unknown>'}`);
  expected.set(entry.path, entry);
  previous = entry.path;
}
const actual = [];
function walk(directory) {
  for (const dirent of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const absolute = path.join(directory, dirent.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`extracted tree contains a symlink: ${relative}`);
    if (stat.isDirectory()) walk(absolute);
    else if (stat.isFile()) {
      if (relative === 'release-manifest.json') continue;
      const hashState = crypto.createHash('sha256');
      const descriptor = fs.openSync(absolute, 'r');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      try {
        for (;;) {
          const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
          if (read === 0) break;
          hashState.update(buffer.subarray(0, read));
        }
      } finally { fs.closeSync(descriptor); }
      const hash = hashState.digest('hex');
      actual.push({path: relative, bytes: stat.size, sha256: hash});
    } else throw new Error(`extracted tree contains a special file: ${relative}`);
  }
}
walk(root);
actual.sort((a, b) => a.path.localeCompare(b.path, 'en'));
if (actual.length !== expected.size) throw new Error('extracted file count differs from release inventory');
for (const file of actual) {
  const pinned = expected.get(file.path);
  if (!pinned || pinned.bytes !== file.bytes || pinned.sha256 !== file.sha256) throw new Error(`extracted file mismatch: ${file.path}`);
}
const totalBytes = actual.reduce((sum, file) => sum + file.bytes, 0);
const digest = crypto.createHash('sha256').update(actual.map(file => `${file.sha256}  ${file.path}\n`).join('')).digest('hex');
if (manifest.fileCount !== actual.length || manifest.totalBytes !== totalBytes || manifest.artifactDigest !== digest) throw new Error('extracted aggregate inventory mismatch');
process.stdout.write(`inventory OK: files=${actual.length} bytes=${totalBytes} digest=${digest}\n`);
NODEEOF
}

if [ "${DEPLOY_ACTIVATE_LIBRARY_ONLY:-0}" = "1" ]; then
  [ "${BASH_SOURCE[0]}" != "$0" ] || fail "library-only mode is valid only when sourced by the offline verifier"
  return 0 2>/dev/null || exit 0
fi

RELEASE_ID="${1:?missing release_id}"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo '[activate] FATAL: invalid release_id' >&2; exit 1; }
PKG="${2:?missing package path}"
RELEASES=/data/web/releases
CURRENT=/data/web/current-web
TARGET_DIR="$RELEASES/$RELEASE_ID"
TARGET="$TARGET_DIR/web"
TOOLCHAIN_NODE=/data/direct-deploy/toolchain/bin/node
CANDIDATE_PORT=5100
RECEIPTS=/data/direct-deploy/receipts
EXPECTED_SOURCE_VERSION="${EXPECTED_SOURCE_VERSION:?missing EXPECTED_SOURCE_VERSION}"
STORAGE_CONTRACT=/etc/zimeiti/deploy-storage.conf
umask 077

# ─── 0. 前置检查 ─────────────────────────────────────────
[ -f "$PKG" ] || fail "package missing: $PKG"
[ -x "$TOOLCHAIN_NODE" ] || fail "toolchain node missing"
verify_storage_contract /data /data/web "$STORAGE_CONTRACT" /etc/fstab
require_root_controlled_directory /data/direct-deploy "deployment root"
require_root_controlled_directory /data/direct-deploy/incoming "deployment incoming directory"
require_root_controlled_directory "$RELEASES" "release root"
require_root_controlled_directory "$RECEIPTS" "deployment receipt directory"
require_root_controlled_file "$TOOLCHAIN_NODE" "deployment Node runtime"
assert_on_data_mount /data/direct-deploy /data "$STORAGE_DATA_DEVICE"
assert_on_data_mount "$TOOLCHAIN_NODE" /data "$STORAGE_DATA_DEVICE"
assert_on_data_mount "$RECEIPTS" /data "$STORAGE_DATA_DEVICE"
PKG_REAL=$(readlink -f -- "$PKG") || fail "package path unreadable"
case "$PKG_REAL" in /data/direct-deploy/incoming/*) ;; *) fail "package must be inside /data/direct-deploy/incoming" ;; esac
assert_on_data_mount "$PKG_REAL" /data "$STORAGE_DATA_DEVICE"
assert_on_data_mount "$RELEASES" /data "$STORAGE_DATA_DEVICE"
[ -L "$CURRENT" ] || fail "current-web must be a symlink"
[ -e "$TARGET_DIR" ] && fail "target already exists: $TARGET_DIR"
CURRENT_TARGET=$(readlink -f "$CURRENT") || fail "current-web unreadable"
case "$CURRENT_TARGET" in "$RELEASES"/*/web) ;; *) fail "current-web escaped the immutable release root: $CURRENT_TARGET" ;; esac
assert_on_data_mount "$CURRENT_TARGET" /data "$STORAGE_DATA_DEVICE"
preflight_archive "$PKG_REAL" "$TOOLCHAIN_NODE" "$STORAGE_AVAILABLE_BYTES" "$STORAGE_AVAILABLE_INODES"
log "current=$CURRENT_TARGET -> new=$TARGET"

WEB_PID=""
# next-server 会改写进程标题，按 cwd（符号链接解析后=当前 release）匹配
for p in $(pgrep -f 'next-server' 2>/dev/null); do
  [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$CURRENT_TARGET" ] && { WEB_PID=$p; break; }
done
[ -n "$WEB_PID" ] || fail "cannot find running web process (cwd=$CURRENT_TARGET)"
log "production web pid=$WEB_PID"

# ─── 1. 解包新 release ───────────────────────────────────
mkdir -p "$TARGET"
tar --extract --gzip --file="$PKG_REAL" --directory="$TARGET" --no-same-owner --no-same-permissions --delay-directory-restore --restrict
verify_extracted_inventory "$TARGET" "$TOOLCHAIN_NODE" "$PKG_REAL" "$ARCHIVE_SHA256"
[ -f "$TARGET/server.js" ] || fail "server.js missing in package"
[ -f "$TARGET/release-manifest.json" ] || fail "release-manifest.json missing in package"

chmod -R a-w "$TARGET" || true
log "unpacked: $(du -sh "$TARGET" | awk '{print $1}')"

# ─── 2. 继承 runtime-tools（ffmpeg/ffprobe/backup-data.sh，服务器端复制零传输） ───
NEW_BUILD_ID=$("$TOOLCHAIN_NODE" - "$TARGET" "$RELEASE_ID" <<'NODEEOF'
const fs = require('fs');
const path = require('path');
const [target, releaseId] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(target, 'release-manifest.json'), 'utf8'));
if (manifest.releaseId !== releaseId || manifest.service !== 'web') throw new Error('package release/service mismatch');
if (manifest.deployable !== true || manifest.rehearsal !== false) throw new Error('only deployable non-rehearsal artifacts may activate');
if (typeof manifest.buildId !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(manifest.buildId)) throw new Error('invalid buildId');
if (typeof manifest.commitSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(manifest.commitSha)) throw new Error('invalid commitSha');
if (fs.readFileSync(path.join(target, '.next', 'BUILD_ID'), 'utf8').trim() !== manifest.buildId) throw new Error('embedded BUILD_ID mismatch');
process.stdout.write(manifest.buildId);
NODEEOF
)
NEW_COMMIT_SHA=$("$TOOLCHAIN_NODE" - "$TARGET/release-manifest.json" <<'NODEEOF'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).commitSha);
NODEEOF
)
log "new BUILD_ID=$NEW_BUILD_ID commit=$NEW_COMMIT_SHA"
# The candidate tree is immutable evidence. The packager must materialize all
# runtime dependencies and code-track public files before the archive is
# created. B-track assets stay in their separately pinned PUBLIC_ASSET_ROOT;
# nothing from the previous release or shared asset tree may be copied or
# hard-linked into this release after inventory verification.
verify_extracted_inventory "$TARGET" "$TOOLCHAIN_NODE" "$PKG_REAL" "$ARCHIVE_SHA256"
log "candidate tree remains identical to the signed artifact inventory"

# ─── 3. 构造同身份候选 env（从当前生产进程 /proc 提取） ───
CAND_ENV=/tmp/candidate-env-$$.json
"$TOOLCHAIN_NODE" - "$WEB_PID" "$CANDIDATE_PORT" "$RELEASE_ID" "$CAND_ENV" "$NEW_BUILD_ID" "$NEW_COMMIT_SHA" <<'NODEEOF'
const fs = require('fs');
const [pid, port, releaseId, outFile, buildId, commitSha] = process.argv.slice(2);
const raw = fs.readFileSync(`/proc/${pid}/environ`);
const skip = /^(PM2_|pm2_|NODE_CHANNEL_|BASH_FUNC_|PWD$|OLDPWD$|SHLVL$|_$|PORT$|HOSTNAME$)/;
const env = {
  PATH: '/data/direct-deploy/toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/root',
  NODE_ENV: 'production',
};
for (const line of raw.toString('utf8').split('\0')) {
  if (!line) continue;
  const i = line.indexOf('=');
  if (i < 1) continue;
  const k = line.slice(0, i);
  if (skip.test(k)) continue;
  env[k] = line.slice(i + 1);
}
env.PORT = port;
env.HOSTNAME = '127.0.0.1';
env.RELEASE_ID = releaseId;
// RELEASE_ROOT 参与 .env.local 查找；与正式激活一样保留生产原值（缺省时不注入）。
env.EXPECTED_BUILD_ID = buildId;
env.DEPLOY_COMMIT_SHA = commitSha;
env.COZE_PROJECT_ENV = 'PROD';
fs.writeFileSync(outFile, JSON.stringify(env));
NODEEOF
log "candidate env prepared from production pid $WEB_PID"

# ─── 4. 候选端口启动与验收 ────────────────────────────────
CAND_LOG=/tmp/candidate-$$.log
CAND_PID_FILE=/tmp/candidate-$$.pid
"$TOOLCHAIN_NODE" - "$TARGET" "$CAND_ENV" "$CAND_PID_FILE" <<'NODEEOF' > "$CAND_LOG" 2>&1 &
const fs = require('fs');
const { spawn } = require('child_process');
const [target, envFile, pidFile] = process.argv.slice(2);
const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
const child = spawn('/data/direct-deploy/toolchain/bin/node', ['server.js'], {
  cwd: target, env, stdio: 'inherit',
});
fs.writeFileSync(pidFile, String(child.pid));
child.on('exit', (code) => process.exit(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { try { child.kill(sig); } catch {} });
NODEEOF
WRAPPER_PID=$!

cleanup_candidate() {
  [ -f "$CAND_PID_FILE" ] && kill "$(cat "$CAND_PID_FILE")" 2>/dev/null || true
  if [ -n "${WRAPPER_PID:-}" ]; then
    kill "$WRAPPER_PID" 2>/dev/null || true
    wait "$WRAPPER_PID" 2>/dev/null || true
    WRAPPER_PID=""
  fi
  rm -f "$CAND_ENV" "$CAND_PID_FILE"
}
trap cleanup_candidate EXIT

READY=""
for i in $(seq 1 24); do
  sleep 5
  if ! kill -0 "$WRAPPER_PID" 2>/dev/null; then
    echo "[activate] candidate process exited early; last log:" >&2
    tail -30 "$CAND_LOG" >&2 || true
    chmod -R u+w "$TARGET_DIR" || true
    rm -rf "$TARGET_DIR"
    fail "candidate crashed on start; release removed, production untouched"
  fi
  VERSION_JSON=$(curl --noproxy '*' -fsS --connect-timeout 2 --max-time 6 "http://127.0.0.1:$CANDIDATE_PORT/api/version" 2>/dev/null) && { READY=1; break; } || true
done
if [ -z "$READY" ]; then
  echo "[activate] candidate failed to become ready; last log:" >&2
  tail -30 "$CAND_LOG" >&2 || true
  cleanup_candidate
  chmod -R u+w "$TARGET_DIR" || true
  rm -rf "$TARGET_DIR"
  fail "candidate readiness timeout; release removed, production untouched"
fi
check_version() {
  "$TOOLCHAIN_NODE" -e '
const [sourceVersion, buildId, deployCommitSha, releaseId] = process.argv.slice(1);
let data = "";
process.stdin.on("data", chunk => data += chunk).on("end", () => {
  try {
    const body = JSON.parse(data);
    for (const [key, expected] of Object.entries({sourceVersion, buildId, deployCommitSha, releaseId})) {
      if (body[key] !== expected) throw new Error(`${key} mismatch`);
    }
    process.stdout.write(`${sourceVersion} ${buildId} ${deployCommitSha} ${releaseId}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});' "$EXPECTED_SOURCE_VERSION" "$NEW_BUILD_ID" "$NEW_COMMIT_SHA" "$RELEASE_ID"
}
CAND_SOURCE=$(printf '%s' "$VERSION_JSON" | check_version) || fail "candidate source/build/commit/release identity mismatch"
log "candidate ready: $CAND_SOURCE"
READINESS_JSON=$(curl --noproxy '*' -fsS --connect-timeout 2 --max-time 8 "http://127.0.0.1:$CANDIDATE_PORT/api/release-readiness") \
  || fail "release-readiness failed; production untouched"
printf '%s' "$READINESS_JSON" | "$TOOLCHAIN_NODE" -e '
const [releaseId, commitSha, buildId] = process.argv.slice(1);
let data = "";
process.stdin.on("data", chunk => data += chunk).on("end", () => {
  try {
    const body = JSON.parse(data);
    if (body.ready !== true || body.service !== "web" || body.releaseId !== releaseId || body.commitSha !== commitSha || body.buildId !== buildId) throw new Error("readiness identity mismatch");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});' "$RELEASE_ID" "$NEW_COMMIT_SHA" "$NEW_BUILD_ID" || fail "release-readiness identity mismatch; production untouched"
log "release-readiness OK"
cleanup_candidate
log "candidate stopped"

# ─── 5. 快照实际配置；按 ID 重建 fork 进程，避免 reload 遗留固定旧路径 ───
PM2_BIN=$(command -v pm2) || fail "pm2 missing"
PM2_MODULE=$(dirname "$(dirname "$(readlink -f "$PM2_BIN")")")
TX_DIR=$(mktemp -d /tmp/activate-XXXXXX)
TX_HELPER="$TX_DIR/pm2-transaction.cjs"
TX_SNAPSHOT="$TX_DIR/processes.json"
TX_HTTP_SNAPSHOT="$TX_DIR/http-identities.json"
mkdir -p "$RECEIPTS"
TX_LOG="$RECEIPTS/$RELEASE_ID-pm2-transaction.log"
POINTER_SWITCHED=0
ACTIVATION_COMMITTED=0
ROLLBACK_FAILED=0
cat > "$TX_HELPER" <<'NODEEOF'
const fs = require('fs');
const path = require('path');
const [action, modulePath, snapshotFile, target, releaseId, buildId, commitSha, sourceVersion] = process.argv.slice(2);
const pm2 = require(modulePath);
const names = new Set(['agent-hub-web', 'agent-hub-media-worker']);
const call = (method, ...args) => new Promise((resolve, reject) => pm2[method](...args, (error, result) => error ? reject(error) : resolve(result)));
const portOf = entry => String(entry.pm2_env?.env?.PORT ?? entry.pm2_env?.PORT ?? '');
const entries = async () => (await call('list')).filter(entry => names.has(entry.name));
function actualEnv(pid) {
  const env = {};
  for (const line of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index);
    // A legacy PM2 restart polluted /proc/<pid>/environ with flattened
    // supervisor fields (unique_id, pm_uptime, time, and many peers). Runtime
    // configuration is an uppercase-only contract; PM2/IPC keys are rebuilt
    // by the supervisor and must never participate in environment equality.
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /^(PM2_|NODE_CHANNEL_|NODE_UNIQUE_ID$)/.test(key)) continue;
    env[key] = line.slice(index + 1);
  }
  return env;
}
function configuration(entry, env) {
  const e = entry.pm2_env;
  // pm2_env also flattens every process environment variable and internal
  // runtime field. Replaying that object as an app declaration lets values
  // such as `time="..."` or `autorestart="true"` collide with PM2's typed
  // options. Build a small, typed declaration from an explicit allowlist.
  const config = {name: entry.name,
    cwd: fs.realpathSync(`/proc/${entry.pid}/cwd`), script: fs.realpathSync(e.pm_exec_path),
    interpreter: fs.realpathSync(`/proc/${entry.pid}/exe`), out_file: e.pm_out_log_path, error_file: e.pm_err_log_path,
    exec_mode: 'fork', instances: 1, force: true,
    autorestart: typeof e.autorestart === 'boolean' ? e.autorestart : String(e.autorestart) !== 'false',
    autostart: typeof e.autostart === 'boolean' ? e.autostart : String(e.autostart) !== 'false',
    treekill: typeof e.treekill === 'boolean' ? e.treekill : String(e.treekill) !== 'false',
    windowsHide: typeof e.windowsHide === 'boolean' ? e.windowsHide : String(e.windowsHide) === 'true',
    instance_var: `ACTIVATION_PM2_INSTANCE_${entry.pm_id}`, env};
  for (const key of ['merge_logs', 'watch', 'wait_ready']) {
    if (typeof e[key] === 'boolean') config[key] = e[key];
  }
  for (const key of ['kill_retry_time', 'restart_delay', 'kill_timeout', 'listen_timeout', 'max_restarts']) {
    if (typeof e[key] === 'number' && Number.isFinite(e[key])) config[key] = e[key];
  }
  for (const key of ['max_memory_restart', 'min_uptime', 'namespace', 'log_date_format']) {
    if (typeof e[key] === 'string' || typeof e[key] === 'number') config[key] = e[key];
  }
  if (Array.isArray(e.node_args)) config.node_args = [...e.node_args];
  if (Array.isArray(e.args)) config.args = [...e.args];
  else if (typeof e.args === 'string') config.args = e.args;
  return config;
}
function assertState(live, saved, newRelease) {
  if (live.length !== saved.length) throw new Error('managed process count mismatch');
  for (const original of saved) {
    const matches = live.filter(entry => entry.name === original.config.name && portOf(entry) === original.env.PORT);
    if (matches.length !== 1) throw new Error('managed process/port mapping mismatch');
    const entry = matches[0], e = entry.pm2_env;
    const cwd = newRelease ? target : original.actualCwd;
    const script = newRelease ? path.join(target, 'server.js') : original.actualScript;
    if (!entry.pid || e.status !== 'online' || e.exec_mode !== 'fork_mode'
      || fs.realpathSync(e.pm_cwd) !== cwd || fs.realpathSync(`/proc/${entry.pid}/cwd`) !== cwd
      || fs.realpathSync(e.pm_exec_path) !== script
      || fs.realpathSync(`/proc/${entry.pid}/exe`) !== original.actualInterpreter) throw new Error('PM2/actual process path mismatch');
    const env = actualEnv(entry.pid);
    const expected = {...original.env};
    delete expected.PWD;
    if (newRelease) Object.assign(expected, {RELEASE_ID: releaseId, EXPECTED_BUILD_ID: buildId, EXPECTED_SOURCE_VERSION: sourceVersion, DEPLOY_COMMIT_SHA: commitSha, COZE_PROJECT_ENV: 'PROD'});
    for (const [key, value] of Object.entries(expected)) {
      if (env[key] !== value) throw new Error(`process environment mismatch: ${key}`);
    }
  }
}
async function waitStarted(original, newRelease, config) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const live = await entries();
      const matches = live.filter(entry => entry.name === config.name && portOf(entry) === config.env.PORT);
      assertState(matches, [original], newRelease);
      const peers = live.filter(entry => entry.name === config.name && entry.pm2_env.pm_exec_path === config.script);
      if (peers.some(entry => !entry.pid || entry.pm2_env.status !== 'online' || entry.pm2_env.exec_mode !== 'fork_mode')) throw new Error('peer not online');
      if (new Set(peers.map(portOf)).size !== peers.length) throw new Error('duplicate peer port');
      return;
    } catch (error) {
      if (attempt === 29) throw new Error(`started process did not become ready: ${config.name}/${config.env.PORT}: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
async function main() {
  await call('connect');
  try {
    if (action === 'snapshot') {
      const live = await entries();
      const web = live.filter(entry => entry.name === 'agent-hub-web');
      const workers = live.filter(entry => entry.name === 'agent-hub-media-worker');
      if (web.length !== 1 || workers.length !== 2 || portOf(web[0]) !== '5000'
        || workers.map(portOf).sort().join(',') !== '5102,5103') throw new Error('unsupported managed process topology; production untouched');
      const saved = live.map(entry => {
        const e = entry.pm2_env;
        if (!entry.pid || e.status !== 'online' || e.exec_mode !== 'fork_mode') throw new Error('only healthy fork processes supported');
        const env = actualEnv(entry.pid);
        if (env.PORT !== portOf(entry)) throw new Error('PM2/actual PORT mismatch');
        const actualCwd = fs.realpathSync(`/proc/${entry.pid}/cwd`);
        const actualScript = fs.realpathSync(e.pm_exec_path);
        const actualInterpreter = fs.realpathSync(`/proc/${entry.pid}/exe`);
        if (path.basename(actualScript) !== 'server.js' || actualScript !== path.join(actualCwd, 'server.js')
          || fs.realpathSync(e.exec_interpreter) !== actualInterpreter) throw new Error('unsupported process script/interpreter');
        return {id: entry.pm_id, config: configuration(entry, env), env, actualCwd, actualScript, actualInterpreter};
      });
      fs.writeFileSync(snapshotFile, JSON.stringify(saved), {mode: 0o600});
      console.log('snapshot: web=1 workers=2 ports=5000,5102,5103');
      return;
    }
    const saved = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    if (action === 'verify' || action === 'verify-rollback') {
      assertState(await entries(), saved, action === 'verify');
      console.log(`${action}: PM2 paths and per-process environments match`);
      return;
    }
    if (action !== 'activate' && action !== 'rollback') throw new Error('invalid transaction action');
    // 不按同名批量删除，避免把两个 worker 的环境/端口合并。
    if (action === 'activate') {
      const live = await entries();
      if (live.length !== saved.length || saved.some(original => !live.some(entry => entry.pm_id === original.id && entry.name === original.config.name && portOf(entry) === original.env.PORT))) throw new Error('process list changed after snapshot');
    }
    const prepared = saved.map(original => {
      const config = {...original.config, env: {...original.env}};
      if (action === 'activate') {
        config.cwd = target;
        config.script = path.join(target, 'server.js');
        Object.assign(config.env, {RELEASE_ID: releaseId, EXPECTED_BUILD_ID: buildId, EXPECTED_SOURCE_VERSION: sourceVersion, DEPLOY_COMMIT_SHA: commitSha, COZE_PROJECT_ENV: 'PROD'});
      }
      config.env.PWD = config.cwd;
      return {original, config};
    });
    const liveBeforeStart = await entries();
    const allowedPairs = new Set(saved.map(original => `${original.config.name}\0${original.env.PORT}`));
    const observedPairs = new Set();
    for (const entry of liveBeforeStart) {
      const pair = `${entry.name}\0${portOf(entry)}`;
      if (!allowedPairs.has(pair) || observedPairs.has(pair)) throw new Error('unsafe managed process topology before replacement');
      observedPairs.add(pair);
    }
    for (const entry of liveBeforeStart) await call('delete', entry.pm_id);
    if ((await entries()).length !== 0) throw new Error('managed processes remained after exact deletion');
    // Pass every declaration together through PM2's JSON-configuration path.
    // The script/options overload drops snake_case fields such as exec_mode,
    // while separate object calls collapse the two same-name media workers.
    await call('start', prepared.map(item => item.config));
    for (const {original, config} of prepared) {
      await waitStarted(original, action === 'activate', config);
      console.log(`${action}: ${config.name} port=${config.env.PORT} cwd=${config.cwd}`);
    }
  } finally { pm2.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
NODEEOF
pm2_transaction() {
  "$TOOLCHAIN_NODE" "$TX_HELPER" "$1" "$PM2_MODULE" "$TX_SNAPSHOT" "$TARGET" "$RELEASE_ID" "$NEW_BUILD_ID" "$NEW_COMMIT_SHA" "$EXPECTED_SOURCE_VERSION" >> "$TX_LOG" 2>&1
}
http_identity_transaction() {
  local action="$1"
  for port in 5000 5102 5103; do
    curl --noproxy '*' -fsS --connect-timeout 2 --max-time 6 "http://127.0.0.1:$port/api/version" \
      > "$TX_DIR/http-$action-$port.json" 2>> "$TX_LOG" || return 1
  done
  "$TOOLCHAIN_NODE" - "$action" "$TX_DIR" "$TX_HTTP_SNAPSHOT" <<'NODEEOF' >> "$TX_LOG" 2>&1
const fs = require('fs');
const path = require('path');
const [action, directory, snapshotFile] = process.argv.slice(2);
const keys = ['sourceVersion', 'buildId', 'deployCommitSha', 'releaseId'];
const current = {};
for (const port of [5000, 5102, 5103]) {
  const body = JSON.parse(fs.readFileSync(path.join(directory, `http-${action}-${port}.json`), 'utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid version object');
  current[port] = keys.map(key => Object.hasOwn(body, key) ? {key, present: true, value: body[key]} : {key, present: false});
}
if (action === 'snapshot') {
  // 保留旧端口原始身份，包括字段缺省和已存在的源码/release 错配；不套用新发布合同。
  fs.writeFileSync(snapshotFile, JSON.stringify(current), {mode: 0o600});
} else if (action === 'verify-rollback') {
  const saved = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  for (const port of [5000, 5102, 5103]) {
    if (JSON.stringify(current[port]) !== JSON.stringify(saved[port])) throw new Error(`rollback HTTP identity mismatch: ${port}`);
  }
} else throw new Error('invalid HTTP identity transaction');
console.log(`${action}: HTTP identities captured/matched on 5000,5102,5103`);
NODEEOF
}
cleanup_activation() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_candidate
  if [ "$POINTER_SWITCHED" = 1 ] && [ "$ACTIVATION_COMMITTED" = 0 ]; then
    log "activation failed; restoring pointer and original web/worker configurations (log=$TX_LOG)"
    if ln -sfn "$CURRENT_TARGET" "$CURRENT.tmp.$$" && mv -T "$CURRENT.tmp.$$" "$CURRENT"; then
      if pm2_transaction rollback; then
        local restored=0
        for i in $(seq 1 12); do
          if pm2_transaction verify-rollback && http_identity_transaction verify-rollback; then restored=1; break; fi
          sleep 2
        done
        if [ "$restored" != 1 ]; then
          ROLLBACK_FAILED=1
          log "FATAL: rollback verification failed; manual recovery required (log=$TX_LOG)"
        fi
      else
        ROLLBACK_FAILED=1
        log "FATAL: rollback process restoration failed; manual recovery required (log=$TX_LOG)"
      fi
    else
      ROLLBACK_FAILED=1
      log "FATAL: rollback pointer restoration failed; manual recovery required (log=$TX_LOG)"
    fi
    status=1
  fi
  rm -f "$CURRENT.tmp.$$"
  if [ "$ROLLBACK_FAILED" = 0 ]; then
    rm -rf "$TX_DIR"
  else
    log "protected recovery configuration retained: $TX_SNAPSHOT"
  fi
  exit "$status"
}
trap cleanup_activation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pm2_transaction snapshot || fail "cannot snapshot supported production configuration; production untouched (log=$TX_LOG)"
http_identity_transaction snapshot || fail "cannot snapshot original HTTP identities; production untouched (log=$TX_LOG)"

# ─── 6. 原子切换指针并重建 web 和两个 worker；不触碰 voice ───
ln -sfn "$TARGET" "$CURRENT.tmp.$$"
POINTER_SWITCHED=1
mv -T "$CURRENT.tmp.$$" "$CURRENT"
log "current switched -> $(readlink -f "$CURRENT")"
pm2_transaction activate || fail "production process activation failed (log=$TX_LOG)"

# ─── 7. 三个实际进程和三端四项身份严格验收；失败由 EXIT trap 回滚 ───
PRODUCTION_READY=0
for i in $(seq 1 24); do
  ALL_MATCH=1
  if ! pm2_transaction verify; then ALL_MATCH=0; fi
  for port in 5000 5102 5103; do
    if VERSION_JSON=$(curl --noproxy '*' -fsS --connect-timeout 2 --max-time 6 "http://127.0.0.1:$port/api/version" 2>/dev/null) \
      && SUMMARY=$(printf '%s' "$VERSION_JSON" | check_version 2>> "$TX_LOG"); then
      [ "$port" = 5000 ] && PROD_SUMMARY="$SUMMARY"
    else
      ALL_MATCH=0
    fi
  done
  if [ "$ALL_MATCH" = 1 ]; then PRODUCTION_READY=1; break; fi
  sleep 5
done
[ "$PRODUCTION_READY" = 1 ] || fail "production web/worker path or source/build/commit/release mismatch (log=$TX_LOG)"
log "production after switch: $PROD_SUMMARY"
PM2_STATE="agent-hub-web:online,agent-hub-media-worker:online,agent-hub-media-worker:online"

mkdir -p "$RECEIPTS"
cat > "$RECEIPTS/$RELEASE_ID-activate.json" <<EOF
{
  "releaseId": "$RELEASE_ID",
  "previousCurrent": "$CURRENT_TARGET",
  "newCurrent": "$(readlink -f "$CURRENT")",
  "candidate": "$CAND_SOURCE",
  "production": "$PROD_SUMMARY",
  "pm2": "$PM2_STATE",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
ACTIVATION_COMMITTED=1
log "receipt: $RECEIPTS/$RELEASE_ID-activate.json"
log "DONE production=$PROD_SUMMARY"
