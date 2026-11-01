"""Review candidate: fixed-role process identity and isolated Voice schema metadata.

CLI is permanently disabled. A separately reviewed transport/integration must
bind its exact bytes and dependencies before any production use.
"""
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import time
import types
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
ISOLATOR = ROOT.parent / 'worker-quiescence-plan-61e9/observation/commerce-detail/probe.py'
ISOLATOR_SHA = 'a927db616e2790269337586a402837901c64d17a490141cd0ecc0f226d0c158d'
CONTRACT = ROOT / 'voice-schema-contract.json'
CONTRACT_SHA = '427139b83268880d6c08ecfa23d1c7a0c0b541d63619e0db64ba8bf3128c029c'
ROLES = {b'agent-hub-web': 'web', b'agent-hub-voice': 'voice'}
SAFE_FIELDS = {b'name', b'VOICE_SQLITE_PATH', b'DATABASE_URL', b'RELEASE_ID', b'DEPLOY_COMMIT_SHA'}
VOICE_ROOT = Path('/data/web/shared/voice')
ERRORS = {'E_PLATFORM', 'E_ISOLATOR_PIN', 'E_CONTRACT_PIN', 'E_PROCESS_SCAN', 'E_PROCESS_IDENTITY',
          'E_PROCESS_COUNT', 'E_PATH', 'E_NOT_SHARED', 'E_PROCESS_DRIFT', 'E_PARENT_DRIFT',
          'E_SCHEMA', 'E_SQLITE', 'E_ISOLATION', 'E_UNVERIFIED'}

class Failure(Exception):
    pass

def fail(code):
    raise Failure(code)

def read_pinned(path, expected, maximum=300000):
    data = path.read_bytes()
    if len(data) > maximum or hashlib.sha256(data).hexdigest() != expected:
        fail('E_ISOLATOR_PIN' if path == ISOLATOR else 'E_CONTRACT_PIN')
    return data

def load_isolator():
    data = read_pinned(ISOLATOR, ISOLATOR_SHA)
    module = types.ModuleType('voice_pinned_isolator')
    module.__file__ = str(ISOLATOR)
    exec(compile(data, '<pinned-isolator>', 'exec', dont_inherit=True), module.__dict__)
    return module

def contract():
    return json.loads(read_pinned(CONTRACT, CONTRACT_SHA))

def environment(data):
    selected = {}
    for item in data.split(b'\0'):
        name, sep, value = item.partition(b'=')
        if sep and name in SAFE_FIELDS:
            if name in selected:
                fail('E_PROCESS_IDENTITY')
            selected[name] = value
    return selected

def database_path(value, *, prisma=False):
    try:
        text = value.decode('utf-8', errors='strict')
    except (UnicodeError, AttributeError):
        fail('E_PATH')
    if prisma:
        if not text.startswith('file:'):
            fail('E_PATH')
        text = text[5:]
    if not text.startswith('/') or any(x in text for x in ('?', '#', '%', '\0')):
        fail('E_PATH')
    path = Path(text)
    if '..' in path.parts or path.parent != VOICE_ROOT or path.name != 'voice.db':
        fail('E_PATH')
    return path

def read_bounded(path, maximum):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        chunks = bytearray()
        while len(chunks) <= maximum:
            part = os.read(fd, min(65536, maximum + 1 - len(chunks)))
            if not part:
                return bytes(chunks)
            chunks.extend(part)
        fail('E_PROCESS_SCAN')
    finally:
        os.close(fd)

def scan_processes(proc=Path('/proc'), release_root=Path('/data/web')):
    """No output includes environment values, PIDs, cwd or executable paths."""
    if not proc.is_dir():
        fail('E_PROCESS_SCAN')
    boot = read_bounded(proc / 'sys/kernel/random/boot_id', 128).strip()
    rows = {}
    count = 0
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        count += 1
        if count > 8192:
            fail('E_PROCESS_SCAN')
        try:
            executable = os.readlink(entry / 'exe')
            if not re.search(r'/node(?:-v[0-9.]+)?$', executable):
                continue
            selected = environment(read_bounded(entry / 'environ', 262144))
            role = ROLES.get(selected.get(b'name', b''))
            if role is None:
                continue
            if role in rows or os.stat(entry).st_uid != 0:
                fail('E_PROCESS_COUNT')
            raw = read_bounded(entry / 'stat', 8192)
            fields = raw.rsplit(b')', 1)[1].split()
            start = int(fields[19])
            cwd = os.path.realpath(entry / 'cwd')
            current = os.path.realpath(release_root / ('current-' + role))
            if cwd != current or not current.startswith(str(release_root) + os.sep):
                fail('E_PROCESS_IDENTITY')
            mount_namespace = os.readlink(entry / 'ns/mnt')
            if mount_namespace != os.readlink(proc / 'self/ns/mnt'):
                fail('E_PROCESS_IDENTITY')
            root = os.stat(entry / 'root')
            local_root = os.stat('/')
            if (root.st_dev, root.st_ino) != (local_root.st_dev, local_root.st_ino):
                fail('E_PROCESS_IDENTITY')
            db = database_path(selected.get(b'VOICE_SQLITE_PATH'))
            if role == 'voice' and database_path(selected.get(b'DATABASE_URL'), prisma=True) != db:
                fail('E_NOT_SHARED')
            # This digest is private comparison state, not a release attestation.
            identity = hashlib.sha256(b'\0'.join([boot, entry.name.encode(), str(start).encode(),
                                                 os.fsencode(cwd), os.fsencode(executable),
                                                 os.fsencode(mount_namespace),
                                                 selected.get(b'VOICE_SQLITE_PATH', b''),
                                                 selected.get(b'DATABASE_URL', b''),
                                                 selected.get(b'RELEASE_ID', b''),
                                                 selected.get(b'DEPLOY_COMMIT_SHA', b'')])).hexdigest()
            rows[role] = {'identity': identity, 'db': db, 'cwd': cwd}
        except FileNotFoundError:
            continue
        except (OSError, ValueError, IndexError):
            fail('E_PROCESS_SCAN')
    if set(rows) != {'web', 'voice'}:
        fail('E_PROCESS_COUNT')
    return rows

def affinity(declared):
    text = declared.upper()
    if 'INT' in text: return 'INTEGER'
    if any(x in text for x in ('CHAR', 'CLOB', 'TEXT')): return 'TEXT'
    if not text or 'BLOB' in text: return 'BLOB'
    if any(x in text for x in ('REAL', 'FLOA', 'DOUB')): return 'REAL'
    return 'NUMERIC'

def ident(name):
    if not isinstance(name, str) or len(name) > 256 or '\0' in name:
        fail('E_SCHEMA')
    return '"' + name.replace('"', '""') + '"'

def schema_only(database, schema):
    """Call only within the pinned private readonly mount; no table rows read."""
    conn = sqlite3.connect('file:' + quote(str(database), safe='/') + '?mode=ro&cache=private', uri=True, timeout=2)
    try:
        conn.enable_load_extension(False)
        for pragma in ('query_only=ON', 'trusted_schema=OFF', 'busy_timeout=2000', 'temp_store=MEMORY', 'mmap_size=0'):
            conn.execute('PRAGMA ' + pragma)
        if conn.execute('PRAGMA query_only').fetchone() != (1,): fail('E_SCHEMA')
        deadline = time.monotonic() + 8
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        allowed_pragma = {'table_info', 'index_list', 'index_info'}
        def authorizer(action, p1, p2, db, trigger):
            if action == sqlite3.SQLITE_SELECT: return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_READ and db == 'main' and p1 in {'sqlite_master', 'sqlite_schema'}: return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_PRAGMA and p1 in allowed_pragma: return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_TRANSACTION and p1 in {'BEGIN', 'ROLLBACK'}: return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY
        conn.set_authorizer(authorizer)
        conn.execute('BEGIN')
        table_results, unique_results = {}, {}
        for table, columns in schema['VOICE_SCHEMA_CONTRACT'].items():
            kind = conn.execute('SELECT type FROM sqlite_schema WHERE name=?', (table,)).fetchone()
            if kind != ('table',):
                table_results[table] = False
                unique_results[table] = False
                continue
            info = {row[1]: row for row in conn.execute('PRAGMA table_info(' + ident(table) + ')')}
            actual_pk = tuple(row[1] for row in sorted(info.values(), key=lambda row: row[5]) if row[5])
            expected_pk = tuple(name for name, rules in columns.items() if rules[1])
            table_results[table] = all(name in info and affinity(str(info[name][2])) in rules[0]
                                       and (not rules[1] or info[name][5] == 1)
                                       for name, rules in columns.items()) and actual_pk == expected_pk
            unique_sets = set()
            for row in conn.execute('PRAGMA index_list(' + ident(table) + ')'):
                if row[2] and not row[4]:
                    parts = tuple(r[2] for r in conn.execute('PRAGMA index_info(' + ident(row[1]) + ')'))
                    unique_sets.add(parts)
            unique_results[table] = all(tuple(cols) in unique_sets for cols in schema['REQUIRED_UNIQUE_COLUMN_SETS'].get(table, []))
        override = conn.execute('SELECT type FROM sqlite_schema WHERE name=?', ('VoiceCatalogOverride',)).fetchone()
        if override is None:
            override_state = 'absent'
        elif override == ('table',):
            names = {row[1] for row in conn.execute('PRAGMA table_info("VoiceCatalogOverride")')}
            override_state = 'compatible' if {'speakerId','isActive','isRecommended','name','description','updatedAt'} <= names else 'incompatible'
        else:
            override_state = 'incompatible'
        conn.execute('ROLLBACK')
        return {'tables_compatible': all(table_results.values()), 'uniques_compatible': all(unique_results.values()),
                'override': override_state, 'business_rows_read': 0}
    finally:
        conn.close()

def isolated_schema(directory, isolator, schema, backend=None):
    """Must be called in a child process; pinned isolation has no writable fallback."""
    ns = isolator.runtime()
    before_dir = ns['trusted'](directory, True)
    isolator.isolate(directory, isolator.LinuxMount() if backend is None else backend)
    after_dir = ns['trusted'](directory, True)
    if (before_dir.st_dev, before_dir.st_ino) != (after_dir.st_dev, after_dir.st_ino): fail('E_ISOLATION')
    database = directory / 'voice.db'
    before = isolator.files(database, ns)
    fd = os.open(database, os.O_RDONLY | os.O_NOFOLLOW)
    try: header = os.read(fd, 100)
    finally: os.close(fd)
    if len(header) != 100 or header[:16] != b'SQLite format 3\0' or header[18:20] != b'\x02\x02': fail('E_SQLITE')
    result = schema_only(database, schema)
    if isolator.files(database, ns) != before: fail('E_ISOLATION')
    return result

def capture_reviewed():
    """Internal, fail-closed collector; never invoked by this file's CLI."""
    result = {'available': False, 'error': 'E_UNVERIFIED', 'sqlite': None,
              'configured_database_path_shared': False, 'observer_database_inode_stable': False, 'processes_stable': False,
              'private_namespace_destroyed': False, 'parent_mounts_unchanged': False,
              'manifest_identity_verified': False, 'cross_service_compatibility_proven': False,
              'business_rows_returned': 0, 'business_writes': 0, 'media_requests': 0}
    if sys.platform != 'linux' or not hasattr(os, 'fork'):
        result['error'] = 'E_PLATFORM'
        return result
    try:
        isolator = load_isolator()
        schema = contract()
        before = scan_processes()
        if before['web']['db'] != before['voice']['db']:
            fail('E_NOT_SHARED')
        database = before['web']['db']
        namespace = isolator.runtime()
        disk_before = isolator.files(database, namespace)
        mount_before = isolator.bounded('/proc/self/mountinfo', 2097152)
        namespace_before = os.readlink('/proc/self/ns/mnt')
        def child_reader(directory, unused):
            import resource
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
            resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
            resource.setrlimit(resource.RLIMIT_AS, (536870912, 536870912))
            return isolated_schema(directory, isolator, schema)
        # Reuse the audited bounded fork/wait/kill-own-child implementation.
        isolator.child_read = child_reader
        child = isolator.child_capture(database.parent, namespace)
        result['parent_mounts_unchanged'] = (namespace_before == os.readlink('/proc/self/ns/mnt') and
                                             mount_before == isolator.bounded('/proc/self/mountinfo', 2097152))
        after = scan_processes()
        result['processes_stable'] = before == after
        disk_after = isolator.files(database, namespace)
        if not result['processes_stable'] or not result['parent_mounts_unchanged'] or disk_before != disk_after:
            fail('E_PROCESS_DRIFT')
        if child.get('ok') is not True or not isinstance(child.get('sqlite'), dict):
            fail('E_ISOLATION')
        result['private_namespace_destroyed'] = True
        value = child['sqlite']
        if (set(value) != {'tables_compatible', 'uniques_compatible', 'override', 'business_rows_read'} or
            type(value['tables_compatible']) is not bool or type(value['uniques_compatible']) is not bool or
            value['override'] not in {'absent', 'compatible', 'incompatible'} or value['business_rows_read'] != 0):
            fail('E_SCHEMA')
        result.update(available=True, error='OK', sqlite=value, configured_database_path_shared=True,
                      observer_database_inode_stable=True)
    except Exception as exc:
        result['error'] = str(exc) if isinstance(exc, Failure) and str(exc) in ERRORS else 'E_ISOLATION'
    return result

def capture():
    # Integration intentionally absent: only a reviewed parent/child wrapper may
    # call isolated_schema. No process or database read on the default path.
    return {'available': False, 'error': 'E_UNVERIFIED', 'manifest_identity_verified': False,
            'cross_service_compatibility_proven': False, 'business_rows_returned': 0,
            'business_writes': 0, 'media_requests': 0}

if __name__ == '__main__':
    print(json.dumps(capture(), sort_keys=True))
    raise SystemExit(2)
