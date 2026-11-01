#!/bin/sh
set -eu
# Run ONLY inside the image-pinned, --network none fixture container.
[ "$(ls /sys/class/net | tr '\n' ' ')" = 'lo ' ] || { echo 'unexpected network interface' >&2; exit 1; }
[ -r /fixture/original.conf ] && [ -r /fixture/hold.conf ] || exit 1
nginx -V 2>&1
nginx -t -p /tmp/ -c /fixture/original.conf
nginx -t -p /tmp/ -c /fixture/hold.conf

request() {
    port="$1"; host="$2"; path="$3"; status="$4"
    : > /tmp/headers; : > /tmp/body
    wget -q -S -O /tmp/body --header="Host: $host" "http://127.0.0.1:$port$path" 2>/tmp/headers || true
    grep -Eq "HTTP/1\.[01] $status( |$)" /tmp/headers || { cat /tmp/headers >&2; echo 'unexpected status' >&2; exit 1; }
}
request_post() {
    port="$1"; host="$2"; path="$3"; status="$4"
    : > /tmp/headers; : > /tmp/body
    wget -q -S -O /tmp/body --post-data='synthetic' --header="Host: $host" "http://127.0.0.1:$port$path" 2>/tmp/headers || true
    grep -Eq "HTTP/1\.[01] $status( |$)" /tmp/headers || { cat /tmp/headers >&2; echo 'unexpected POST status' >&2; exit 1; }
}

nginx -p /tmp/ -c /fixture/original.conf
request 18080 fixturea.test / 301
request 18080 fixtureb.test / 301
nginx -p /tmp/ -c /fixture/original.conf -s quit
n=0
while [ -e /tmp/fixture-nginx.pid ]; do
    n=$((n + 1)); [ "$n" -lt 100 ] || { echo 'fixture shutdown timeout' >&2; exit 1; }
    sleep 0.1
done
nginx -p /tmp/ -c /fixture/hold.conf
for port in 18080 18443; do
    for host in fixturea.test fixtureb.test; do
        request "$port" "$host" /api/admin/models 503
        request "$port" "$host" / 503
        request "$port" "$host" '/api/payment/%6eotify' 503
        request "$port" "$host" '/api/payment/notify?out_trade_no=synthetic&trade_status=ok' 200
        if [ "$host" = fixturea.test ]; then
            grep -Fx 'backend|fixturea|/api/payment/notify?out_trade_no=synthetic&trade_status=ok' /tmp/body >/dev/null
        else
            grep -Fx 'backend|payment|/api/payment/notify?out_trade_no=synthetic&trade_status=ok' /tmp/body >/dev/null
        fi
        request "$port" "$host" '/api/payment/notify' 200
        if [ "$host" = fixturea.test ]; then
            grep -Fx 'backend|fixturea|/api/payment/notify' /tmp/body >/dev/null
        else
            grep -Fx 'backend|payment|/api/payment/notify' /tmp/body >/dev/null
        fi
        request_post "$port" "$host" '/api/payment/notify' 200
        request_post "$port" "$host" '/api/payment/notify?provider=synthetic' 200
        request_post "$port" "$host" '/api/admin/models' 503
    done
done
nginx -p /tmp/ -c /fixture/hold.conf -s quit
echo 'synthetic fixture passed'
