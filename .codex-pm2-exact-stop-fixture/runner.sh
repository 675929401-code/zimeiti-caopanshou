#!/bin/bash
set -euo pipefail
umask 077
[[ "${FIXTURE_ISOLATED:-}" == 1 && "$(id -u)" == 0 && -n "${FIXTURE_HOST_NET:-}" && "$(readlink /proc/self/ns/net)" != "$FIXTURE_HOST_NET" ]] || exit 2
[[ "$#" == 2 && "$1" == /* && "$2" == /* && -x "$1" && -f "$2/node_modules/pm2/bin/pm2" ]] || exit 2
node_bin="$1";source_dir="$2";pm2="$2/node_modules/pm2/bin/pm2"
root="$(mktemp -d /tmp/pm2-exact-stop-repro-XXXXXXXXXXXX)"
[[ "$root" == /tmp/pm2-exact-stop-repro-* && -d "$root" && ! -L "$root" ]] || exit 2
pm2home=''
cleanup(){
 if [[ -n "$pm2home" && "$pm2home" == "$root"/* && -d "$pm2home" ]]; then
  /usr/bin/timeout --kill-after=3s 8s /usr/bin/env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$root" PM2_HOME="$pm2home" PM2_DISABLE_VERSION_CHECK=1 "$node_bin" "$pm2" kill >/dev/null 2>&1 || true
 fi
 [[ "$root" == /tmp/pm2-exact-stop-repro-* && -d "$root" && ! -L "$root" ]] && rm -rf -- "$root"
}
trap cleanup EXIT
mkdir -p "$root/closure/linux-owner-implementation-61e9/worker-provider" "$root/closure/live-drain-provider-61e9" "$root/closure/worker-quiescence-plan-61e9/release-window/service-detail-v2" "$root/closure/worker-stop-bind-61e9"
cp "$source_dir/continuous_watch.py" "$source_dir/current_identity.py" "$source_dir/exact_stop.py" "$root/closure/linux-owner-implementation-61e9/worker-provider/"
cp "$source_dir/live_drain.py" "$source_dir/rpc_stop.py" "$root/closure/live-drain-provider-61e9/"
cp "$source_dir/bus_probe.py" "$root/closure/worker-quiescence-plan-61e9/release-window/service-detail-v2/"
cp "$source_dir/slot_monitor.py" "$root/closure/worker-stop-bind-61e9/"
cp "$source_dir/fake-worker.cjs" "$source_dir/ecosystem.cjs" "$root/"
for delay in 0 1; do
 pm2home="$root/pm2-$delay";mkdir -m 0700 "$pm2home"
 /usr/bin/env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$root" PM2_HOME="$pm2home" PM2_DISABLE_VERSION_CHECK=1 PM2_NO_USAGE_STATS=1 "$node_bin" "$pm2" start "$root/ecosystem.cjs" >/dev/null
 /usr/bin/env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$root" PM2_HOME="$pm2home" PM2_DISABLE_VERSION_CHECK=1 FIXTURE_ISOLATED=1 FIXTURE_ROOT="$root" FIXTURE_NODE="$node_bin" FIXTURE_PM2="$pm2" FIXTURE_DELAY="$delay" /usr/bin/python3 -B "$source_dir/test_fixture.py"
 /usr/bin/timeout --kill-after=3s 8s /usr/bin/env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$root" PM2_HOME="$pm2home" PM2_DISABLE_VERSION_CHECK=1 "$node_bin" "$pm2" kill >/dev/null
 rm -f -- "$root/journal.jsonl"
done
