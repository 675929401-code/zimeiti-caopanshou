#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "$EUID" == 0 ]] || { echo 'ROOT_REQUIRED'; exit 2; }
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
base=/data/release-automation
repo=/data/git/zimeiti-caopanshou-source-vnext-clean-20260905.git
node=/data/toolchains/node-v24.19.0-linux-x64/bin/node
[[ -d "$repo" && -x "$node" ]] || exit 2
mkdir -p "$base" "$base/jobs" "$base/logs" "$base/authorizations" "$base/backups"
chmod 700 "$base" "$base/jobs" "$base/logs" "$base/authorizations" "$base/backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
for file in server-release-queue.mjs server-release-driver.sh; do
  [[ -f "$source_dir/$file" ]] || exit 2
  if [[ -f "$base/$file" ]]; then cp -p "$base/$file" "$base/backups/$file-$stamp"; fi
  install -m 700 "$source_dir/$file" "$base/$file"
done
if [[ -f "$repo/hooks/post-receive" ]]; then
  grep -q 'zimeiti-release-queue-managed-v1' "$repo/hooks/post-receive" || { echo 'UNMANAGED_EXISTING_HOOK_PRESERVED'; exit 2; }
  cp -p "$repo/hooks/post-receive" "$base/backups/post-receive-$stamp"
fi
cat >"$base/config.json" <<JSON
{"repository":"$repo","stateRoot":"$base","driver":"$base/server-release-driver.sh"}
JSON
cat >"$repo/hooks/post-receive" <<HOOK
#!/usr/bin/env bash
# zimeiti-release-queue-managed-v1
set -Eeuo pipefail
$node $base/server-release-queue.mjs receive $base/config.json
systemctl start --no-block zimeiti-release-queue.service
HOOK
chmod 700 "$repo/hooks/post-receive"
cat >/etc/systemd/system/zimeiti-release-queue.service <<UNIT
[Unit]
Description=Zimeiti immutable Git release queue
After=network-online.target
[Service]
Type=oneshot
User=root
UMask=0077
WorkingDirectory=$base
Environment=PATH=/data/toolchains/node-v24.19.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$node $base/server-release-queue.mjs run $base/config.json
TimeoutStartSec=3700
Nice=10
CPUQuota=150%
UNIT
cat >/etc/systemd/system/zimeiti-release-queue.path <<UNIT
[Unit]
Description=Watch Zimeiti release jobs and local acceptance authorizations
[Path]
PathChanged=$base/jobs
PathChanged=$base/authorizations
Unit=zimeiti-release-queue.service
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now zimeiti-release-queue.path
echo 'QUEUE_INSTALLED: push queues exact commits; deploy waits for matching local acceptance'
