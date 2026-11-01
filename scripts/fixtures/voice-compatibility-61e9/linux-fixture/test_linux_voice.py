"""NON-PRODUCTION Linux mount-namespace fixture. Never point at real data.

The writer opens the synthetic database in a separate exec process. The reader
parent never opens SQLite and confirms it has no inherited database handles.
"""
import errno
import json
import os
import pathlib
import re
import select
import signal
import subprocess
import sys
import time
import types
import uuid

ROOT = pathlib.Path(__file__).resolve().parent
WRITER = r'''
import json,sqlite3,sys
path,contract_path=sys.argv[1:]
contract=json.load(open(contract_path,encoding='utf8'))
def q(value): return '"'+value.replace('"','""')+'"'
db=None
def emit(state): print(json.dumps({'state':state}),flush=True)
def create():
 global db
 db=sqlite3.connect(path); db.execute('PRAGMA journal_mode=WAL')
 for table, columns in contract['VOICE_SCHEMA_CONTRACT'].items():
  defs=[q(name)+' '+rules[0][0]+(' PRIMARY KEY' if rules[1] else '') for name,rules in columns.items()]
  db.execute('CREATE TABLE IF NOT EXISTS '+q(table)+' ('+','.join(defs)+')')
  for n,keys in enumerate(contract['REQUIRED_UNIQUE_COLUMN_SETS'].get(table,[])):
   db.execute('CREATE UNIQUE INDEX IF NOT EXISTS '+q(table+'_fixture_'+str(n))+' ON '+q(table)+' ('+','.join(q(k) for k in keys)+')')
 db.execute('INSERT OR IGNORE INTO "User" ("id","email") VALUES (?,?)',('synthetic','fixture@example.invalid')); db.commit()
try:
 create(); emit('READY')
 for line in sys.stdin:
  cmd=line.strip()
  if cmd=='CLOSE': db.close();db=None;emit('CLOSED')
  elif cmd=='REOPEN': create();emit('REOPENED')
  elif cmd=='EXIT':
   if db is not None: db.close()
   emit('EXITED');break
  else: raise RuntimeError('invalid fixture command')
except Exception: emit('ERROR');raise SystemExit(1)
'''

def recv(fd, timeout=10, limit=16384):
    deadline = time.monotonic() + timeout
    out = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]: raise RuntimeError('E_FIXTURE_TIMEOUT')
        char = os.read(fd, 1)
        if not char: raise RuntimeError('E_FIXTURE_EOF')
        if char == b'\n': return bytes(out)
        out.extend(char)
        if len(out) > limit: raise RuntimeError('E_FIXTURE_LIMIT')

def send(fd, data):
    while data:
        size = os.write(fd, data)
        if not size: raise RuntimeError('E_FIXTURE_PIPE')
        data = data[size:]

def writer_command(writer, command, expected):
    send(writer.stdin.fileno(), command.encode('ascii') + b'\n')
    if json.loads(recv(writer.stdout.fileno())) != {'state': expected}: raise RuntimeError('E_WRITER_CONTRACT')

def database_handles(database, proc=pathlib.Path('/proc/self')):
    prefix = str(database); fds = maps = 0
    for entry in (proc/'fd').iterdir():
        try: target = os.readlink(entry)
        except FileNotFoundError: continue
        if target.removesuffix(' (deleted)').startswith(prefix): fds += 1
    for line in (proc/'maps').read_bytes().splitlines():
        fields = line.split(None, 5)
        if len(fields) < 6: continue
        path = re.sub(rb'\\([0-7]{3})', lambda m: bytes([int(m.group(1), 8)]), fields[5])
        if os.fsdecode(path).removesuffix(' (deleted)').startswith(prefix): maps += 1
    return {'database_fds': fds, 'database_mappings': maps}

def no_database_handles(database):
    value = database_handles(database)
    if value != {'database_fds': 0, 'database_mappings': 0}: raise RuntimeError('E_INHERITED_HANDLES')
    return value

def wait_owned(pid, timeout=10):
    deadline = time.monotonic()+timeout
    while True:
        found, status = os.waitpid(pid, os.WNOHANG)
        if found: return status
        if time.monotonic() >= deadline: raise RuntimeError('E_CHILD_TIMEOUT')
        time.sleep(0.02)

def run_reader(probe, isolator, directory, database, writer, *, race=False):
    result_r, result_w = os.pipe(); ready_r, ready_w = os.pipe(); go_r, go_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        for fd in (result_r, ready_r, go_w, writer.stdin.fileno(), writer.stdout.fileno()): os.close(fd)
        try:
            inherited = no_database_handles(database)
            original_runtime = isolator.runtime
            def runtime():
                ns = original_runtime()
                def fixture_trust(path, directory_expected=False):
                    path = pathlib.Path(path)
                    if not path.resolve().is_relative_to(directory.resolve()): raise RuntimeError('E_FIXTURE_PATH')
                    return os.lstat(path)
                ns['trusted'] = fixture_trust
                return ns
            isolator.runtime = runtime
            original_isolate = isolator.isolate
            def fixture_isolate(path, backend):
                value = original_isolate(path, backend)
                blocked = 0
                for target, flags in ((directory/'forbidden', os.O_CREAT|os.O_EXCL|os.O_WRONLY),
                                      (database, os.O_RDWR),
                                      (pathlib.Path(str(database)+'-wal'), os.O_RDWR),
                                      (pathlib.Path(str(database)+'-shm'), os.O_RDWR)):
                    try:
                        fd = os.open(target, flags, 0o600); os.close(fd); raise RuntimeError('E_WRITE_ALLOWED')
                    except OSError as exc:
                        if exc.errno != errno.EROFS: raise
                        blocked += 1
                if blocked != 4: raise RuntimeError('E_EROFS_COUNT')
                return value
            isolator.isolate = fixture_isolate
            if race:
                original_files = isolator.files; calls = 0
                def racing_files(db, ns):
                    nonlocal calls
                    value = original_files(db, ns); calls += 1
                    if calls == 1:
                        send(ready_w, b'PREFLIGHT_COMPLETE\n')
                        if recv(go_r) != b'SIDECARS_REMOVED': raise RuntimeError('E_RACE_PROTOCOL')
                    return value
                isolator.files = racing_files
                try:
                    probe.isolated_schema(directory, isolator, probe.contract())
                except Exception as exc:
                    import sqlite3
                    code = getattr(exc, 'sqlite_errorcode', 0) & 255
                    sidecars_missing = isinstance(exc, isolator.CaptureError) and str(exc) == 'E_SIDECARS_MISSING'
                    if code not in (sqlite3.SQLITE_READONLY, sqlite3.SQLITE_CANTOPEN) and not sidecars_missing: raise
                else: raise RuntimeError('E_RACE_ALLOWED')
                if any(pathlib.Path(str(database)+suffix).exists() for suffix in ('-wal', '-shm')):
                    raise RuntimeError('E_SIDECARS_CREATED')
                value = {'passed': True, 'readonly_race_rejected': True, 'sidecars_not_created': True,
                         'kernel_EROFS_count': 4, **inherited}
            else:
                result = probe.isolated_schema(directory, isolator, probe.contract())
                if result != {'tables_compatible': True, 'uniques_compatible': True,
                              'override': 'absent', 'business_rows_read': 0}:
                    raise RuntimeError('E_SCHEMA')
                value = {'passed': True, 'schema_verified': True, 'kernel_EROFS_count': 4, **inherited}
        except Exception as exc:
            value = {'passed': False, 'error': type(exc).__name__}
        send(result_w, json.dumps(value).encode('ascii') + b'\n')
        for fd in (result_w, ready_w, go_r): os.close(fd)
        os._exit(0)
    for fd in (result_w, ready_w, go_r): os.close(fd)
    reaped = False
    try:
        if race:
            if recv(ready_r) != b'PREFLIGHT_COMPLETE': raise RuntimeError('E_RACE_PROTOCOL')
            writer_command(writer, 'CLOSE', 'CLOSED')
            if any(pathlib.Path(str(database)+suffix).exists() for suffix in ('-wal', '-shm')): raise RuntimeError('E_SIDECARS_REMAIN')
            send(go_w, b'SIDECARS_REMOVED\n')
        result = json.loads(recv(result_r, timeout=20))
        status = wait_owned(pid); reaped = True
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0: raise RuntimeError('E_CHILD_EXIT')
        return result
    finally:
        for fd in (result_r, ready_r, go_w): os.close(fd)
        if not reaped:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(pid, 0)
            except ChildProcessError: pass

def test_capture_failures(isolator):
    """Exercise actual pinned child_capture failure and timeout; no database."""
    namespace = isolator.runtime()
    original = isolator.child_read
    def run(mode):
        created = []; original_fork = os.fork
        def tracked_fork():
            pid = original_fork()
            if pid: created.append(pid)
            return pid
        def reader(*unused):
            if mode == 'timeout': time.sleep(45)
            raise RuntimeError('SYNTHETIC_CHILD_FAILURE')
        isolator.child_read = reader; isolator.os.fork = tracked_fork
        try:
            if mode == 'failure':
                result = isolator.child_capture(pathlib.Path('/unused'), namespace)
                if result.get('ok') is not False: raise RuntimeError('E_FAILURE_ACCEPTED')
            else:
                try: isolator.child_capture(pathlib.Path('/unused'), namespace)
                except isolator.CaptureError as exc:
                    if str(exc) != 'E_CHILD_TIMEOUT': raise
                else: raise RuntimeError('E_TIMEOUT_ACCEPTED')
        finally:
            isolator.child_read = original; isolator.os.fork = original_fork
        if len(created) != 1: raise RuntimeError('E_CHILD_IDENTITY')
        try: os.waitpid(created[0], os.WNOHANG)
        except ChildProcessError: return True
        raise RuntimeError('E_CHILD_NOT_REAPED')
    return {'failure_reaped': run('failure'), 'timeout_reaped': run('timeout')}

def main():
    if sys.platform != 'linux' or os.geteuid() != 0: raise SystemExit('E_LOCAL_LINUX_ROOT_REQUIRED')
    voice_path = ROOT.parent / 'probe.py'
    probe = types.ModuleType('voice_local_fixture'); probe.__file__ = str(voice_path)
    exec(compile(voice_path.read_bytes(), str(voice_path), 'exec'), probe.__dict__)
    isolator = probe.load_isolator()
    directory = ROOT / ('local-fixture-' + uuid.uuid4().hex); directory.mkdir(mode=0o700)
    if not directory.resolve().is_relative_to(ROOT.resolve()): raise RuntimeError('E_FIXTURE_PATH')
    database = directory/'voice.db'
    namespace = os.readlink('/proc/self/ns/mnt'); mounts = pathlib.Path('/proc/self/mountinfo').read_bytes()
    writer = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', WRITER, str(database), str(probe.CONTRACT)],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              close_fds=True, bufsize=0, cwd=ROOT)
    report = {'passed': False, 'production_connected': False, 'writer_separate_exec': True}
    try:
        if json.loads(recv(writer.stdout.fileno())) != {'state': 'READY'}: raise RuntimeError('E_WRITER_START')
        report['parent_before'] = no_database_handles(database)
        report['normal_reader'] = run_reader(probe, isolator, directory, database, writer)
        if not report['normal_reader'].get('passed'): raise RuntimeError('E_NORMAL_FAILED')
        report['race_reader'] = run_reader(probe, isolator, directory, database, writer, race=True)
        if not report['race_reader'].get('passed'): raise RuntimeError('E_RACE_FAILED')
        writer_command(writer, 'REOPEN', 'REOPENED')
        report['writer_reopened_after_readers'] = True
        report['child_lifecycle'] = test_capture_failures(isolator)
        report['parent_after'] = no_database_handles(database)
        report['parent_namespace_unchanged'] = namespace == os.readlink('/proc/self/ns/mnt')
        report['parent_mounts_unchanged'] = mounts == pathlib.Path('/proc/self/mountinfo').read_bytes()
        if not report['parent_namespace_unchanged'] or not report['parent_mounts_unchanged']: raise RuntimeError('E_PARENT_CHANGED')
        report['passed'] = True
    except Exception as exc:
        report['error'] = type(exc).__name__
    finally:
        if writer.poll() is None:
            try: writer_command(writer, 'EXIT', 'EXITED'); writer.wait(timeout=5)
            except Exception: writer.kill(); writer.wait(timeout=5)
        writer.stdin.close(); writer.stdout.close()
        print(json.dumps(report, sort_keys=True))
    return 0 if report['passed'] else 1

if __name__ == '__main__': raise SystemExit(main())
