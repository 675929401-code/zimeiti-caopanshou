"""Create only synthetic Nginx config under a new local fixture directory."""
import argparse
import json
import os
from pathlib import Path
import re

import mechanical_hold as h


def source(host, exact):
    if host not in ('fixturea', 'fixtureb'): raise ValueError('invalid fixture host')
    callback = ('''location = /api/payment/notify {
        proxy_set_header X-Server-Capture $1;
        proxy_pass http://127.0.0.1:19090;
    }
    location ~ ^/api/(payment)/notify$ { return 599; }''' if exact else '''
    location ~ ^/api/(payment)/notify$ {
        proxy_set_header X-Server-Capture $1;
        proxy_pass http://127.0.0.1:19090;
    }''')
    def server(port):
        return f'''server {{
    listen 127.0.0.1:{port};
    server_name ~^({host})[.]test$;
    {callback}
    location ~ ^/api/.* {{ return 217; }}
    location = /landing {{ return 200 "landing"; }}
    location / {{ return 301 /landing; }}
}}
'''
    return (server(18080) + server(18443)).encode('ascii')


def write_exclusive(path, content):
    with path.open('xb') as f: f.write(content)
    path.chmod(0o644)


def prepare(destination):
    if destination.exists(): raise ValueError('fixture directory must be new')
    destination.mkdir(mode=0o755, parents=False)
    destination.chmod(0o755)
    raw = {'a': source('fixturea', True), 'b': source('fixtureb', False)}
    pins = {k: h.sha(v) for k, v in raw.items()}
    # Synthetic assertions allow exercising transformation only; they certify
    # nothing about production and the candidate still forbids deployment.
    result = h.preview(raw, pins, 'a' * 32, {x: True for x in h.PROOFS}, fixture_ports=(18080, 18443))
    if result['deployment_allowed'] is not False: raise RuntimeError('unexpected authorization')
    for kind, files in (('original', raw), ('hold', result['candidates'])):
        for key, data in files.items(): write_exclusive(destination / f'{kind}-{key}.conf', data)
    header = ('''pid /tmp/fixture-nginx.pid;
error_log stderr notice;
events { worker_connections 64; }
http {
    access_log off;
    client_body_temp_path /tmp/client;
    proxy_temp_path /tmp/proxy;
    fastcgi_temp_path /tmp/fastcgi;
    uwsgi_temp_path /tmp/uwsgi;
    scgi_temp_path /tmp/scgi;
    server { listen 127.0.0.1:19090;
        location / { return 200 "backend|$http_x_server_capture|$request_uri"; }
    }
''')
    for kind in ('original', 'hold'):
        config = header + f'    include /fixture/{kind}-a.conf;\n    include /fixture/{kind}-b.conf;\n' + '}\n'
        write_exclusive(destination / f'{kind}.conf', config.encode('ascii'))
    write_exclusive(destination / 'fixture-manifest.json', (json.dumps({'synthetic': True, 'deployment_allowed': False,
        'original_sha256': pins, 'hold_sha256': result['candidate_sha256']}, sort_keys=True) + '\n').encode())


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('new_fixture_directory', type=Path)
    args = ap.parse_args(); prepare(args.new_fixture_directory)
