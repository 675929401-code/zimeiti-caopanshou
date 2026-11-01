#!/bin/bash
set -euo pipefail
umask 077
[[ "${FIXTURE_ISOLATED:-}" == 1 && "$(id -u)" == 0 && -n "${FIXTURE_HOST_NET:-}" && "$(readlink /proc/self/ns/net)" != "$FIXTURE_HOST_NET" ]] || exit 2
[[ "$#" == 2 && "$1" == /* && "$2" == /* && -x "$1" && -f "$2/node_modules/pm2/bin/pm2" ]] || exit 2
node_bin="$1";source_dir="$2";pm2="$2/node_modules/pm2/bin/pm2";root=/tmp/native-hook-fixture
[[ ! -e "$root" && ! -L "$root" ]] || exit 2
cleanup(){
 if [[ -d "$root/pm2" && ! -L "$root/pm2" ]]; then
  /usr/bin/timeout --kill-after=3s 8s /usr/bin/env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$root" PM2_HOME="$root/pm2" PM2_DISABLE_VERSION_CHECK=1 "$node_bin" "$pm2" kill >/dev/null 2>&1 || true
 fi
 [[ "$root" == /tmp/native-hook-fixture && -d "$root" && ! -L "$root" ]] && rm -rf -- "$root"
}
trap cleanup EXIT
for mode in success missing-drain timeout; do
 mkdir -p "$root/closure/linux-owner-implementation-61e9/worker-provider" "$root/closure/live-drain-provider-61e9" "$root/closure/worker-quiescence-plan-61e9/release-window/service-detail-v2" "$root/closure/worker-stop-bind-61e9" "$root/web/releases/old/web" "$root/transactions" "$root/pm2" "$root/bin"
 cp "$source_dir/continuous_watch.py" "$source_dir/current_identity.py" "$source_dir/exact_stop.py" "$root/closure/linux-owner-implementation-61e9/worker-provider/"
 cp "$source_dir/live_drain.py" "$source_dir/rpc_stop.py" "$root/closure/live-drain-provider-61e9/"
 cp "$source_dir/bus_probe.py" "$root/closure/worker-quiescence-plan-61e9/release-window/service-detail-v2/"
 cp "$source_dir/slot_monitor.py" "$root/closure/worker-stop-bind-61e9/"
 cp "$source_dir/server.js" "$root/web/releases/old/web/server.js"
 cp "$source_dir/ecosystem.config.js" "$root/ecosystem.config.js"
 chmod 0600 "$root/ecosystem.config.js"
 ln -s "$root/web/releases/old/web" "$root/web/current-web"
 printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$node_bin" "$pm2" > "$root/bin/pm2"
 chmod 0700 "$root/bin/pm2"
 no_drain=0;delay_exit=0
 [[ "$mode" == missing-drain ]] && no_drain=1
 [[ "$mode" == timeout ]] && delay_exit=1
 /usr/bin/env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$root" PM2_HOME="$root/pm2" PM2_DISABLE_VERSION_CHECK=1 PM2_NO_USAGE_STATS=1 FIXTURE_NO_DRAIN="$no_drain" FIXTURE_DELAY_EXIT="$delay_exit" "$node_bin" "$pm2" start "$root/ecosystem.config.js" >/dev/null
 /usr/bin/env -i PATH=/usr/bin:/bin HOME="$root" PM2_HOME="$root/pm2" PM2_DISABLE_VERSION_CHECK=1 FIXTURE_ISOLATED=1 FIXTURE_SOURCE="$source_dir" FIXTURE_NODE="$node_bin" FIXTURE_MODE="$mode" /usr/bin/python3 -B "$source_dir/test_fixture.py"
 cleanup
 done
