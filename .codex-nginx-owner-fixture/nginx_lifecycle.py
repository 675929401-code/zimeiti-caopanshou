"""Fixed Nginx test/reload lifecycle for a continuously owned Linux session.

This library cannot authenticate the caller or prove effective HTTP behavior.
No CLI is exposed. A sealed controller must supply a trusted owner and prevent
restore until migration and the new release are independently verified.
"""
import hashlib
import os
import signal
import stat
import subprocess
import time
from pathlib import Path
from file_txn import _no_xattrs, _trusted_directory_chain

EXE = '/synthetic/nginx'
EXE_SHA = '2'*64
MAIN = '/synthetic/nginx.conf'
MAIN_SHA = '3'*64


class Refuse(RuntimeError):pass


def proc_stat(pid):
    with open(f'/proc/{pid}/stat','rb') as f:raw=f.read(16385)
    if len(raw)>16384:raise Refuse('PROC_LIMIT')
    fields=raw.decode('ascii').rsplit(') ',1)[1].split()
    return int(fields[1]),int(fields[19])


def proc_cmd(pid):
    with open(f'/proc/{pid}/cmdline','rb') as f:raw=f.read(65537)
    if len(raw)>65536:raise Refuse('PROC_LIMIT')
    return raw


def read_sha(path):
    _trusted_directory_chain(str(Path(path).parent))
    current=Path('/')
    for part in Path(path).parts[1:]:
        current=current/part;info=os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise Refuse('PIN_IDENTITY')
    fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_mode&0o022 or before.st_nlink!=1 or before.st_size>33554432:raise Refuse('PIN_IDENTITY')
        if (before.st_dev,before.st_ino)!=(info.st_dev,info.st_ino):raise Refuse('PIN_DRIFT')
        _no_xattrs(fd)
        digest=hashlib.sha256();total=0
        while True:
            data=os.read(fd,65536)
            if not data:break
            total+=len(data)
            if total>33554432:raise Refuse('PIN_LIMIT')
            digest.update(data)
        after=os.fstat(fd)
        _no_xattrs(fd)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise Refuse('PIN_DRIFT')
        return digest.hexdigest()
    finally:os.close(fd)


def processes():
    result=[]
    with os.scandir('/proc') as it:
        for entry in it:
            if entry.name.isdecimal():
                result.append(int(entry.name))
                if len(result)>16384:raise Refuse('PROC_LIMIT')
    return result


def capture_master():
    if read_sha(EXE)!=EXE_SHA or read_sha(MAIN)!=MAIN_SHA:raise Refuse('NGINX_PIN')
    masters=[]
    for pid in processes():
        try:
            cmd=proc_cmd(pid)
            if not cmd.startswith(b'nginx: master process '):continue
            _,start=proc_stat(pid)
            if os.stat(f'/proc/{pid}').st_uid!=0 or os.readlink(f'/proc/{pid}/exe')!=EXE:raise Refuse('MASTER_IDENTITY')
            masters.append((pid,start))
        except FileNotFoundError:continue
        except PermissionError:raise Refuse('MASTER_VISIBILITY') from None
    if len(masters)!=1:raise Refuse('MASTER_COUNT')
    return masters[0]


def check_master(master):
    pid,start=master
    if proc_stat(pid)[1]!=start or os.readlink(f'/proc/{pid}/exe')!=EXE or not proc_cmd(pid).startswith(b'nginx: master process '):raise Refuse('MASTER_CHANGED')
    if read_sha(EXE)!=EXE_SHA or read_sha(MAIN)!=MAIN_SHA:raise Refuse('NGINX_PIN')


def workers(master):
    result=[]
    for pid in processes():
        try:
            cmd=proc_cmd(pid)
            if not cmd.startswith(b'nginx: worker process'):continue
            ppid,start=proc_stat(pid)
            if ppid==master[0]:
                if os.readlink(f'/proc/{pid}/exe')!=EXE:raise Refuse('WORKER_IDENTITY')
                result.append((pid,start))
        except FileNotFoundError:continue
        except PermissionError:raise Refuse('WORKER_VISIBILITY') from None
    if len(result)>256:raise Refuse('WORKER_COUNT')
    return frozenset(result)


def old_workers_gone(old):
    for pid,start in old:
        try:
            if proc_stat(pid)[1]==start:return False
        except FileNotFoundError:continue
        except PermissionError:raise Refuse('WORKER_VISIBILITY') from None
    return True


class Lifecycle:
    def __init__(self,owner,file_transaction):
        if os.name!='posix' or not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):raise Refuse('PIDFD_UNAVAILABLE')
        self.owner=owner;self.files=file_transaction;self.state='NEW';self.master=capture_master();self.pidfd=os.pidfd_open(self.master[0],0)
        check_master(self.master)

    def _live(self):
        if self.state=='UNKNOWN':raise Refuse('UNKNOWN')
        self.owner.assert_live();self.owner.assert_exclusive_config_writer();check_master(self.master)

    def _point(self,phase,data):
        self._live();self.owner.checkpoint(phase,data);self._live()

    def _test(self):
        self._point('nginx-test-intent',{})
        try:
            child=subprocess.Popen([EXE,'-t','-c',MAIN],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                   shell=False,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},close_fds=True)
            try:status=child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill();child.wait();raise Refuse('NGINX_TEST_UNKNOWN') from None
        except OSError:raise Refuse('NGINX_TEST_UNKNOWN') from None
        if status!=0:raise Refuse('NGINX_TEST_FAILED')
        self._point('nginx-test-complete',{})

    def _reload(self):
        self._live();old=workers(self.master)
        if not old:raise Refuse('WORKERS_MISSING')
        self._point('nginx-reload-intent',{'master_identity':list(self.master),
            'old_worker_identities':[list(x) for x in sorted(old)]})
        self._live();signal.pidfd_send_signal(self.pidfd,signal.SIGHUP)
        deadline=time.monotonic()+30;previous=None;stable=0
        while time.monotonic()<deadline:
            self._live();current=workers(self.master)
            if current and not (old&current) and old_workers_gone(old):
                stable=stable+1 if current==previous else 1
                if stable>=2:
                    self._point('nginx-reload-workers-observed',{'master_identity':list(self.master),
                        'new_worker_identities':[list(x) for x in sorted(current)]})
                    return
            else:stable=0
            previous=current;time.sleep(0.25)
        raise Refuse('RELOAD_OR_OLD_WORKERS_UNKNOWN')

    def install(self):
        if self.state!='NEW':raise Refuse('PHASE')
        try:
            self.owner.assert_install_allowed();self.files.stage();self.files.install();self.files.verify_files()
            self._test();self._reload();self.files.verify_files();self.state='HELD_FILES_ONLY'
            return {'outcome':'HELD_FILES_ONLY','effective_gate_proven':False}
        except BaseException:self.state='UNKNOWN';raise

    def verify(self):
        if self.state!='HELD_FILES_ONLY':raise Refuse('PHASE')
        try:
            self._live();self.files.verify_files()
            if not workers(self.master):raise Refuse('WORKERS_MISSING')
            return {'outcome':'HELD_FILES_ONLY','effective_gate_proven':False}
        except BaseException:self.state='UNKNOWN';raise

    def restore(self):
        if self.state!='HELD_FILES_ONLY':raise Refuse('PHASE')
        try:
            self.owner.assert_restore_allowed();self.files.restore();self._test();self._reload()
            self.state='RESTORED_FILES_ONLY'
            return {'outcome':'RESTORED_FILES_ONLY','public_route_proven':False}
        except BaseException:self.state='UNKNOWN';raise

    def close(self):
        os.close(self.pidfd)


if __name__=='__main__':print('DISABLED: no standalone production executor')
