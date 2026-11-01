#!/usr/bin/env bash
set -euo pipefail
# This fixture is allowed only in the dedicated CI namespace and creates an
# isolated tmpfs after ensuring the host-visible mountpoint did not exist.
test "${SQLITE_FIXTURE_ONLY:-}" = github-isolated-v1
test ! -e /data
test ! -L /data
mount --make-rprivate /
mkdir -m 0755 /data
cleanup() {
  umount /data 2>/dev/null || true
  rmdir /data 2>/dev/null || true
}
trap cleanup EXIT
mount -t tmpfs -o mode=0755,nosuid,nodev,noexec tmpfs /data
test "$(findmnt -n -o FSTYPE --target /data)" = tmpfs
printf synthetic > /data/.synthetic-fixture-mount
/usr/bin/timeout --signal=TERM --kill-after=5s 30s /usr/bin/python3 -I -S -B .codex-linux-sqlite-extracted-fixture/test_kernel.py
