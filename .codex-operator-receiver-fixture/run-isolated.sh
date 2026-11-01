#!/bin/bash
set -euo pipefail
[[ $EUID == 0 && $# == 4 ]] || exit 2
fixture_dir="$(readlink -f -- "$1")"
output_dir="$(readlink -f -- "$2")"
outer_mount="$3"
outer_network="$4"
[[ -d "$fixture_dir" && -d "$output_dir" && ! -L "$fixture_dir" && ! -L "$output_dir" ]] || exit 2
[[ "$(readlink /proc/self/ns/mnt)" != "$outer_mount" && "$(readlink /proc/self/ns/net)" != "$outer_network" ]] || exit 2
mount --make-rprivate /
private_root="$(mktemp -d /tmp/zimeiti-operator-receiver-XXXXXX)"
[[ "$private_root" =~ ^/tmp/zimeiti-operator-receiver-[A-Za-z0-9]+$ && "$(readlink -f -- "$private_root")" == "$private_root" ]] || exit 2
cleanup() { umount -R -- "$private_root" 2>/dev/null || true; }
trap cleanup EXIT
mkdir -p "$private_root/usr" "$private_root/proc" "$private_root/fixture" "$private_root/data" "$private_root/etc" "$private_root/tmp" "$private_root/dev"
mount --rbind /usr "$private_root/usr"
mount --make-rslave "$private_root/usr"
mount -o remount,bind,ro "$private_root/usr"
for name in bin sbin lib lib64; do
  if [[ -L "/$name" ]]; then
    ln -s "$(readlink "/$name")" "$private_root/$name"
  elif [[ -d "/$name" ]]; then
    mkdir "$private_root/$name"
    mount --rbind "/$name" "$private_root/$name"
    mount --make-rslave "$private_root/$name"
    mount -o remount,bind,ro "$private_root/$name"
  fi
done
mount -t proc proc "$private_root/proc"
mount --bind "$fixture_dir" "$private_root/fixture"
mount -o remount,bind,ro "$private_root/fixture"
printf 'operator-receiver-private-root-v1\n' > "$private_root/.operator-receiver-private-root"
chmod 0444 "$private_root/.operator-receiver-private-root"
chroot "$private_root" /usr/bin/timeout --signal=TERM --kill-after=5s 90s /usr/bin/python3 -I -B /fixture/linux-receiver-test.py "$outer_mount" "$outer_network" | tee "$output_dir/report.json"
