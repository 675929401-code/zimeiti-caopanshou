"""SQLite window capture in an owned, clean subprocess; factory remains closed."""
import hashlib, json, os, selectors, signal, subprocess, sys, threading, time
from pathlib import Path, PurePosixPath

PROBE_SHA = 'a918f4fc68ad0eb8d630e5f45e660cab3e666074c2801fcea91e83deb29fa019'
class SQLiteWindowError(RuntimeError): pass
def _fail(code): raise SQLiteWindowError(code) from None
def _load_reader(path):
    raw = Path(path).read_bytes()
    if len(raw)>262144 or hashlib.sha256(raw).hexdigest()!=PROBE_SHA: _fail('SQLITE_READER_PIN_MISMATCH')
    source=raw.decode('ascii')
    ns={'__name__':'_sqlite_window_reader'}
    exec(compile(source,'<pinned-sqlite-window-reader>','exec'),ns)
    return ns

def _fixed_path(directory):
    path=PurePosixPath(directory)
    if not path.is_absolute() or '..' in path.parts or PurePosixPath('/data/web/shared/runtime') not in path.parents: _fail('SQLITE_DIRECTORY_INVALID')
    return path

def _capture_child(directory,reader):
    directory=_fixed_path(directory);ns=reader['runtime']()
    before_ns=os.readlink('/proc/self/ns/mnt');before_mounts=reader['bounded']('/proc/self/mountinfo',2097152)
    before=ns['trusted'](directory,True);result=reader['child_capture'](directory,ns);after=ns['trusted'](directory,True)
    if (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino): _fail('SQLITE_DIRECTORY_CHANGED')
    if before_ns!=os.readlink('/proc/self/ns/mnt') or before_mounts!=reader['bounded']('/proc/self/mountinfo',2097152): _fail('SQLITE_PARENT_NAMESPACE_CHANGED')
    if type(result) is not dict or result.get('ok') is not True or result.get('error')!='OK': _fail('SQLITE_CAPTURE_UNAVAILABLE')
    return ns['sqlite_schema'](result['sqlite'])

def _kill_group(child):
    try: os.killpg(child.pid,signal.SIGKILL)
    except OSError: pass
    for pipe in (child.stdin,child.stdout):
        if pipe is not None:
            try: pipe.close()
            except OSError: pass
    try: child.wait(timeout=.2)
    except subprocess.TimeoutExpired:
        # Never block the window on an uninterruptible child. The daemon reaper
        # owns only the child created here and does not authorize continuation.
        threading.Thread(target=child.wait,daemon=True).start()
    except OSError: pass

def _bounded_output(child,deadline):
    output=bytearray()
    selector=selectors.DefaultSelector()
    try:
        selector.register(child.stdout,selectors.EVENT_READ)
        while True:
            remaining=deadline-time.monotonic()
            if remaining<=0: _fail('SQLITE_CHILD_TIMEOUT')
            ready=selector.select(remaining)
            if not ready: _fail('SQLITE_CHILD_TIMEOUT')
            chunk=os.read(child.stdout.fileno(),4096)
            if not chunk: break
            output.extend(chunk)
            if len(output)>16384: _fail('SQLITE_CHILD_OUTPUT_LIMIT')
        remaining=deadline-time.monotonic()
        if remaining<=0: _fail('SQLITE_CHILD_TIMEOUT')
        child.wait(timeout=remaining)
        return bytes(output)
    finally:
        selector.close()

def _run_clean(python,helper,probe,directory,timeout):
    # Child owns its own process group; close all non-stdio FDs, and neither
    # Python nor its forked readonly reader inherit the watcher's sockets.
    child=None;completed=False;deadline=time.monotonic()+timeout
    try:
        raw=json.dumps({'probe':probe,'directory':str(directory)},separators=(',',':')).encode('ascii')
        if len(raw)>4096: _fail('SQLITE_CHILD_INPUT_LIMIT')
        child=subprocess.Popen([python,'-I','-S','-B',helper,'--child'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},cwd='/')
        child.stdin.write(raw);child.stdin.close();child.stdin=None
        stdout=_bounded_output(child,deadline)
        completed=True
        if child.returncode!=0: _fail('SQLITE_CHILD_FAILED')
        return json.loads(stdout)
    except BaseException:
        if child is not None and not completed:
            try: _kill_group(child)
            except BaseException: pass
        _fail('SQLITE_CHILD_FAILED')
    finally:
        if child is not None:
            for pipe in (child.stdin,child.stdout):
                if pipe is not None:
                    try: pipe.close()
                    except OSError: pass

class _SQLiteWindowObserver:
    def __init__(self,owner,directory,python,helper,probe,python_sha,helper_sha):
        if not callable(getattr(owner,'assert_bound',None)): _fail('SQLITE_OWNER_REQUIRED')
        self.owner,self.directory=owner,_fixed_path(directory)
        self.python,self.helper,self.probe=python,helper,probe
        self.python_sha,self.helper_sha=python_sha,helper_sha
        self.poisoned=False;self.serial=0
    def capture(self,deadline=None):
        if self.poisoned: _fail('SQLITE_SESSION_UNKNOWN')
        self.poisoned=True;started=time.monotonic_ns()
        if deadline is None:deadline=time.monotonic()+4.75
        try:
            self.owner.assert_bound()
            # verify_file is a private descriptor-backed capability of owner;
            # caller-provided paths/digests cannot make production factory open.
            self.owner.verify_file(self.python,self.python_sha)
            self.owner.verify_file(self.helper,self.helper_sha)
            remaining=deadline-time.monotonic()
            if remaining<=0:_fail('SQLITE_CAPTURE_EXPIRED')
            value=_run_clean(self.python,self.helper,self.probe,self.directory,min(4.5,remaining))
            self.owner.verify_file(self.python,self.python_sha)
            self.owner.verify_file(self.helper,self.helper_sha)
            self.owner.assert_bound()
            if time.monotonic_ns()-started>4_750_000_000 or time.monotonic()>=deadline: _fail('SQLITE_CAPTURE_EXPIRED')
            if type(value) is not dict or set(value)!={'ok','sqlite'} or value['ok'] is not True: _fail('SQLITE_CHILD_FAILED')
            self.serial+=1;self.poisoned=False
            return {'serial':self.serial,'sqlite':value['sqlite'],'maintenanceCoverageComplete':False,'releaseReady':False}
        except BaseException:
            _fail('SQLITE_CAPTURE_UNKNOWN')

def open_production_sqlite_window(*_args,**_kwargs): _fail('SQLITE_AUTHENTICATED_OWNER_DIRECTORY_NOT_CONNECTED')

def _child_main():
    try:
        raw=sys.stdin.buffer.read(4097)
        if len(raw)>4096: raise ValueError()
        value=json.loads(raw)
        if type(value) is not dict or set(value)!={'probe','directory'} or not all(type(v) is str for v in value.values()): raise ValueError()
        sqlite=_capture_child(value['directory'],_load_reader(value['probe']))
        output=json.dumps({'ok':True,'sqlite':sqlite},separators=(',',':')).encode('ascii')
        if len(output)>16384: raise ValueError()
        sys.stdout.buffer.write(output);sys.stdout.buffer.flush()
    except BaseException:
        raise SystemExit(1) from None
if __name__=='__main__':
    if sys.argv[1:]!=['--child']: raise SystemExit(1)
    _child_main()
