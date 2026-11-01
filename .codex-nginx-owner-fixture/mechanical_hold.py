"""Memory-only, disabled-by-default maintenance candidate. NO production writer.

The coverage assertions are external inputs, not collected evidence. Even a
successful candidate is review material and can never authorize production.
"""
import hashlib
import re
import sys

from candidate import parser


class Refuse(ValueError):
    pass


PATHS = ('/synthetic/hub','/synthetic/target')
PINS = {'/synthetic/hub':'0'*64,'/synthetic/target':'1'*64}
MANIFEST = '4'*64
PATH_MANIFEST = '5'*64
PROOFS = frozenset(('all_http_ingress_and_default_vhosts', 'direct_web_and_db_paths',
                    'callback_effective_mapping_and_handler', 'loaded_graph_exact',
                    'all_async_inflight_writes_drained', 'unknown_controls_reviewed',
                    'server_5_preview_role_resolved', 'old_workers_retired'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fixed_snapshot(enabled=False):
    """Read fixed root-owned Linux disk graph only; no subprocess or network.

    Must be called by separately reviewed code, not exposed via CLI. Loaded
    configuration and live ingress are NOT established by this operation.
    """
    if enabled is not True or sys.platform != 'linux':
        raise Refuse('READER_DISABLED')
    p = parser(); graph = p.Graph(); tree = graph.load()
    manifest = sha(('\n'.join(sorted(v[0] for v in graph.files.values())) + '\n').encode('ascii'))
    paths_manifest = sha(''.join(f'{path} {graph.files[path][0]}\n' for path in sorted(graph.files)).encode('utf-8'))
    if manifest != MANIFEST or paths_manifest != PATH_MANIFEST or any(graph.files.get(path, (None,))[0] != pin for path, pin in PINS.items()):
        raise Refuse('GRAPH_DRIFT')
    verify_expanded_tree(tree, graph.server_sources)
    data = {path: graph.reader(path) for path in PATHS}
    if any(sha(data[path]) != PINS[path] for path in PATHS):
        raise Refuse('SOURCE_DRIFT')
    graph.unchanged()
    return data, tree, graph.server_sources


def verify_expanded_tree(tree, sources):
    """Check observed graph invariants; unknown control safety still unproven."""
    per_file = {path: 0 for path in PATHS}
    servers = 0
    def walk(nodes):
        nonlocal servers
        for name, args, children in nodes:
            if name in ('if', 'rewrite', 'error_page'):
                raise Refuse('UNEXPECTED_CONTROL')
            if name == 'server' and children is not None:
                servers += 1
                path = sources.get(id(children))
                if path in per_file: per_file[path] += 1
            if children is not None: walk(children)
    walk(tree)
    if servers != 8 or any(v != 2 for v in per_file.values()): raise Refuse('SERVER_COVERAGE')


def spans(raw):
    """Parse byte positions and require equality to pinned Nginx token parser."""
    try: text = raw.decode('utf-8', 'strict')
    except UnicodeError: raise Refuse('SOURCE_ENCODING') from None
    if len(raw) > 1048576 or '\x00' in text: raise Refuse('SOURCE_LIMIT')
    tokens = []; word = []; start = None; i = 0
    def flush():
        nonlocal start
        if word:
            tokens.append(('word', ''.join(word), start, i)); word.clear(); start = None
    while i < len(text):
        c = text[i]
        if c.isspace(): flush(); i += 1; continue
        if c == '#':
            flush(); end = text.find('\n', i); i = len(text) if end < 0 else end + 1; continue
        if c in '{};': flush(); tokens.append((c, c, i, i + 1)); i += 1; continue
        if start is None: start = i
        if c in '\"\'':
            quote = c; i += 1; word.append('')
            while i < len(text) and text[i] != quote:
                if text[i] == '\\':
                    i += 1
                    if i == len(text): raise Refuse('LEX')
                word.append(text[i]); i += 1
            if i == len(text): raise Refuse('LEX')
            i += 1; continue
        if c == '\\':
            i += 1
            if i == len(text): raise Refuse('LEX')
            word.append(text[i]); i += 1; continue
        if text.startswith('${', i):
            end = text.find('}', i + 2)
            if end < 0: raise Refuse('LEX')
            word.append(text[i:end + 1]); i = end + 1; continue
        word.append(c); i += 1
    flush()
    p = parser()
    if [(a, b) for a, b, _, _ in tokens] != p.nginx_tokens(text): raise Refuse('LEX_MISMATCH')
    index = 0
    def block(nested=False, depth=0):
        nonlocal index
        if depth > 32: raise Refuse('DEPTH')
        out = []; words = []
        while index < len(tokens):
            kind, value, _, end = tokens[index]; index += 1
            if kind == 'word': words.append(value); continue
            if kind == '}':
                if words or not nested: raise Refuse('PARSE')
                return out
            if not words: raise Refuse('PARSE')
            if kind == ';': out.append((words[0], words[1:], None, None)); words = []
            elif kind == '{':
                out.append((words[0], words[1:], block(True, depth + 1), end)); words = []
            else: raise Refuse('PARSE')
        if nested or words: raise Refuse('PARSE')
        return out
    result = block()
    def strip(nodes): return [(n, a, strip(c) if c is not None else None) for n, a, c, _ in nodes]
    if strip(result) != p.nginx_parse(text): raise Refuse('PARSE_MISMATCH')
    return text, result


def server_positions(raw, ports=(80, 443)):
    text, tree = spans(raw)
    top = [x for x in tree if x[0] == 'server' and x[2] is not None]
    def count(nodes):
        return sum((1 if n == 'server' and c is not None else 0) + (count(c) if c is not None else 0) for n, _, c, _ in nodes)
    if len(top) != 2 or count(tree) != 2: raise Refuse('SERVER_LAYOUT')
    found = []
    for _, args, children, end in top:
        if args: raise Refuse('SERVER_LAYOUT')
        listens = [a for n, a, c, _ in children if n == 'listen' and c is None]
        if len(listens) != 1 or not listens[0]: raise Refuse('LISTEN_LAYOUT')
        m = re.fullmatch(r'(?:\[[^]]+\]:|[^:]+:)?([0-9]{1,5})', listens[0][0])
        if not m: raise Refuse('LISTEN_LAYOUT')
        found.append((int(m[1]), end))
    if sorted(x[0] for x in found) != sorted(ports): raise Refuse('LISTEN_LAYOUT')
    return text, [end for _, end in found]


def rules(tx):
    v = '$hold_' + tx
    method = '$method_' + tx
    canonical = '$canonical_' + tx
    return ('\n        # maintenance candidate ' + tx + '\n'
            f'        set {v} 1;\n'
            f'        set {method} 0;\n'
            f'        set {canonical} "$uri$is_args$args";\n'
            f'        if ($request_uri = {canonical}) {{ set {v} 0; }}\n'
            f'        if ($uri != /api/payment/notify) {{ set {v} 1; }}\n'
            f'        if ($request_method = GET) {{ set {method} 1; }}\n'
            f'        if ($request_method = POST) {{ set {method} 1; }}\n'
            f'        if ({method} = 0) {{ set {v} 1; }}\n'
            f'        if ({v} = 1) {{ return 503; }}\n')


def preview(raw_files, pins, transaction, asserted_proofs, fixture_ports=(80, 443)):
    """Produce in-memory bytes for exact inputs only, never a deployment permit."""
    if not re.fullmatch('[a-f0-9]{32}', transaction): raise Refuse('TRANSACTION')
    if type(raw_files) is not dict or type(pins) is not dict or set(raw_files) != set(pins) or len(pins) != 2:
        raise Refuse('COVERAGE')
    if type(asserted_proofs) is not dict or set(asserted_proofs) != PROOFS or any(v is not True for v in asserted_proofs.values()):
        raise Refuse('UNPROVEN_COVERAGE')
    if any(type(raw_files[k]) is not bytes or sha(raw_files[k]) != pins[k] for k in pins): raise Refuse('SOURCE_DRIFT')
    originals = dict(raw_files); modified = {}
    for key in sorted(raw_files):
        text, positions = server_positions(raw_files[key], fixture_ports); var = '$hold_' + transaction
        if any(prefix + transaction in text for prefix in ('$hold_', '$method_', '$canonical_')): raise Refuse('VARIABLE_COLLISION')
        for offset in sorted(positions, reverse=True): text = text[:offset] + rules(transaction) + text[offset:]
        result = text.encode('utf-8'); spans(result)
        modified[key] = result
    return {'transaction': transaction, 'originals': originals, 'candidates': modified,
            'original_sha256': {k: sha(v) for k, v in originals.items()},
            'candidate_sha256': {k: sha(v) for k, v in modified.items()},
            'assertions_are_not_evidence': True, 'deployment_allowed': False}


def preview_fixed(raw_files, transaction, asserted_proofs):
    if set(raw_files) != set(PATHS): raise Refuse('COVERAGE')
    return preview(raw_files, PINS, transaction, asserted_proofs)


def restoration_bytes(receipt, current, transaction):
    if (receipt.get('transaction') != transaction or receipt.get('deployment_allowed') is not False
        or current != receipt.get('candidates') or set(current) != set(receipt.get('originals', {}))
        or any(sha(current[k]) != receipt['candidate_sha256'][k] or sha(receipt['originals'][k]) != receipt['original_sha256'][k] for k in current)):
        raise Refuse('RESTORE_DRIFT')
    return dict(receipt['originals'])


if __name__ == '__main__':
    print('DISABLED: fixture-only review interface; no production operation')
