"""Read-only pinned Nginx inventory and deliberately restricted offline candidate.

Never installs, reloads, opens network sockets, or writes configuration files.
The production reader is unavailable by default. Candidate generation only
accepts a narrowly defined, include-free fixture, not arbitrary Nginx syntax.
"""
import hashlib
import re
import sys
import types
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_BUNDLED = _HERE / 'detail_body.py'
PARSER = _BUNDLED if _BUNDLED.is_file() else _HERE.parent / 'worker-quiescence-plan-61e9/release-window/service-detail/detail_body.py'
PARSER_SHA = 'ce01f0dceaadf6a9afe0d90df949ad868214c9bf6c249e455c800276be1d40d3'


class Refuse(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def parser():
    source = PARSER.read_bytes()
    if digest(source) != PARSER_SHA:
        raise Refuse('PARSER_DRIFT')
    module = types.ModuleType('pinned_parser')
    module.__file__ = str(PARSER)
    exec(compile(source, str(PARSER), 'exec', dont_inherit=True), module.__dict__)
    return module


def read_real_graph(enabled=False):
    """Explicit Linux-only, fixed paths, read only, redacted; no execution permit."""
    if enabled is not True or sys.platform != 'linux':
        raise Refuse('READER_DISABLED')
    p = parser()
    graph = p.Graph()
    tree = graph.load()
    summary = p.summaries(tree, graph.server_sources)
    graph.unchanged()
    return {'file_count': len(graph.files), 'server_count': len(summary),
            'disk_graph_only': True, 'loaded_graph_proven': False,
            'ingress_coverage_proven': False, 'deployment_allowed': False}


# This intentionally rigid input is a demonstrator, not a template claimed to
# match production. Refuse includes, rewrites, unknown directives, comments,
# extra locations, extra listeners, and all whitespace changes.
FIXTURE = (b'events {}\nhttp {\n    server {\n'
           b'        listen 8080;\n        server_name fixture.invalid;\n'
           b'        location = /api/payment/notify {\n'
           b'            proxy_pass http://127.0.0.1:5000;\n        }\n'
           b'        location / {\n            proxy_pass http://127.0.0.1:5000;\n'
           b'        }\n    }\n}\n')
ANCHOR = b'    server {\n'


def make_candidate(original, transaction, fixture_coverage):
    """Return bytes and receipt in memory only; refuses unproven or real inputs."""
    if not isinstance(original, bytes) or original != FIXTURE:
        raise Refuse('UNSUPPORTED_EXACT_CONFIG')
    if not re.fullmatch(r'[a-f0-9]{32}', transaction):
        raise Refuse('BAD_TRANSACTION')
    if fixture_coverage != {'all_listeners': True, 'direct_paths': True,
                            'callback_handler': True, 'loaded_config': True}:
        raise Refuse('FIXTURE_COVERAGE_INCOMPLETE')
    # Parsing checked bytes independently catches malformed fixture assumptions.
    tree = parser().nginx_parse(original.decode('ascii'))
    if len(tree) != 2 or [x[0] for x in tree] != ['events', 'http'] or original.count(ANCHOR) != 1:
        raise Refuse('PARSE_MISMATCH')
    var = '$hold_' + transaction
    method = '$method_' + transaction
    canonical = '$canonical_' + transaction
    rules = (f'        # fixture-only transaction {transaction}\n'
             f'        set {var} 1;\n'
             f'        set {method} 0;\n'
             f'        set {canonical} "$uri$is_args$args";\n'
             f'        if ($request_uri = {canonical}) {{ set {var} 0; }}\n'
             f'        if ($uri != /api/payment/notify) {{ set {var} 1; }}\n'
             f'        if ($request_method = GET) {{ set {method} 1; }}\n'
             f'        if ($request_method = POST) {{ set {method} 1; }}\n'
             f'        if ({method} = 0) {{ set {var} 1; }}\n'
             f'        if ({var} = 1) {{ return 503; }}\n').encode('ascii')
    candidate = original.replace(ANCHOR, ANCHOR + rules, 1)
    parser().nginx_parse(candidate.decode('ascii'))
    return {'transaction': transaction, 'original_sha256': digest(original),
            'candidate_sha256': digest(candidate), 'candidate': candidate,
            'original': original, 'synthetic_only': True, 'deployment_allowed': False}


def restore_candidate(receipt, current, transaction):
    """Return original bytes only if exact transaction and complete bytes match.

    This is an in-memory comparison, not an OS atomic CAS or a file operation.
    """
    if (receipt.get('synthetic_only') is not True or receipt.get('deployment_allowed') is not False
        or receipt.get('transaction') != transaction or not isinstance(current, bytes)
        or current != receipt.get('candidate') or digest(current) != receipt.get('candidate_sha256')
        or digest(receipt.get('original', b'')) != receipt.get('original_sha256')):
        raise Refuse('RESTORE_IDENTITY_UNKNOWN')
    return receipt['original']


if __name__ == '__main__':
    # No flag exposes the production reader or a writer via the CLI.
    print('DISABLED: import for offline fixture tests; no production operation')
