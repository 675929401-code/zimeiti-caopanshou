"""Isolated v2 rule draft; no live input, writer, network, or authorization."""
import re


class Refuse(ValueError): pass


def rules(transaction, site, port):
    if not re.fullmatch('[a-f0-9]{32}', transaction): raise Refuse('TRANSACTION')
    if site not in ('target', 'hub') or type(port) is not int or port not in (80, 443): raise Refuse('SERVER')
    v = '$hold_' + transaction
    method = '$method_' + transaction
    canonical = '$canonical_' + transaction
    path = '$path_' + transaction
    combined = '$path_method_' + transaction
    version_rule = f'        if ($uri = /api/version) {{ set {path} 1; }}\n' if (site, port) == ('target', 443) else ''
    return ('\n        # isolated v2 candidate ' + transaction + '\n'
            f'        set {v} 1;\n'
            f'        set {method} 0;\n'
            f'        set {path} 0;\n'
            f'        set {canonical} "$uri$is_args$args";\n'
            f'        if ($request_uri = {canonical}) {{ set {v} 0; }}\n'
            f'        if ($uri = /api/payment/notify) {{ set {path} 1; }}\n'
            + version_rule +
            f'        if ({path} = 0) {{ set {v} 1; }}\n'
            f'        if ($request_method = GET) {{ set {method} 1; }}\n'
            f'        if ($request_method = POST) {{ set {method} 1; }}\n'
            f'        if ({method} = 0) {{ set {v} 1; }}\n'
            f'        set {combined} "$uri|$request_method";\n'
            f'        if ({combined} = "/api/version|POST") {{ set {v} 1; }}\n'
            f'        if ({v} = 1) {{ return 503; }}\n')


def decision(method, raw_target, normalized_uri, site, port):
    """Abstract prediction only; Nginx behavior requires separate real test."""
    if site not in ('target','hub') or port not in (80,443): raise Refuse('SERVER')
    if not all(isinstance(x,str) for x in (method,raw_target,normalized_uri)): raise Refuse('INPUT')
    path, sep, query = raw_target.partition('?')
    canonical = path == normalized_uri and (not sep or bool(query))
    if not canonical: return 'HOLD'
    if normalized_uri == '/api/payment/notify' and method in ('GET','POST'): return 'CALLBACK'
    if (site,port,normalized_uri,method) == ('target',443,'/api/version','GET'): return 'VERSION'
    return 'HOLD'


def fixture_source(site):
    if site not in ('target','hub'): raise Refuse('SERVER')
    host = 'fixturea' if site == 'target' else 'fixtureb'
    def block(port):
        return (f'server {{\n    listen 127.0.0.1:{port};\n'
                f'    server_name ~^({host})[.]test$;\n'
                '    location /api/ { proxy_pass http://127.0.0.1:19090; }\n'
                '    location ~ ^/api/(payment)/notify$ { proxy_pass http://127.0.0.1:19090; }\n'
                '    location / { return 301 /landing; }\n}\n')
    return (block(18080) + block(18443)).encode('ascii')


def fixture_preview(site, raw, transaction):
    """Only accepts its own fixed synthetic input; no production writer."""
    from mechanical_hold import spans
    if raw != fixture_source(site): raise Refuse('FIXTURE_ONLY')
    text, nodes = spans(raw)
    if len(nodes) != 2 or any(n != 'server' or c is None for n, a, c, o in nodes): raise Refuse('FIXTURE_LAYOUT')
    inserts = []
    for _, _, children, offset in nodes:
        listens = [a for n,a,c,o in children if n=='listen' and c is None]
        if len(listens) != 1 or len(listens[0]) != 1: raise Refuse('FIXTURE_LAYOUT')
        fixture_port = {'127.0.0.1:18080':80,'127.0.0.1:18443':443}.get(listens[0][0])
        if fixture_port is None: raise Refuse('FIXTURE_LAYOUT')
        inserts.append((offset,rules(transaction,site,fixture_port)))
    if len(inserts) != 2 or len({o for o,_ in inserts}) != 2: raise Refuse('FIXTURE_LAYOUT')
    for offset, gate in sorted(inserts,reverse=True): text=text[:offset]+gate+text[offset:]
    data=text.encode('ascii'); spans(data)
    return {'candidate':data,'synthetic':True,'deployment_allowed':False}


if __name__ == '__main__': print('DISABLED: isolated v2 draft only')
