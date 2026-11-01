"""Persistent, no-takeover journal adapter for a separately sealed guard.

Guard authentication/exclusive-writer coordination are not implemented here.
No CLI, fixed side effects only within an already-bound private journal FD.
"""
import hashlib
import json
import os
import re
import stat
from file_txn import JOURNAL_BASE, Refuse, _no_xattrs, _trusted_directory_chain

JOURNAL='nginx-hold-events.jsonl'


def _ident(st):
    return (st.st_dev,st.st_ino,st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode),st.st_nlink,st.st_size,st.st_mtime_ns,st.st_ctime_ns)


class JournalOwner:
    def __init__(self,guard,journal_fd,transaction_id,plan):
        import fcntl
        self.guard=guard;self.dirfd=journal_fd;self.tx=transaction_id;self.plan=plan;self.pid=os.getpid()
        self.seq=0;self.previous='0'*64;self.failed=False
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}',transaction_id):raise Refuse('TRANSACTION')
        self.dir_path=os.path.join(JOURNAL_BASE,transaction_id)
        if os.readlink(f'/proc/self/fd/{journal_fd}')!=self.dir_path:raise Refuse('JOURNAL_DIRECTORY')
        _trusted_directory_chain(self.dir_path)
        guard.assert_live();guard.assert_exclusive_config_writer()
        info=os.fstat(journal_fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077:raise Refuse('JOURNAL_DIRECTORY')
        _no_xattrs(journal_fd)
        self.dir_identity=(info.st_dev,info.st_ino,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))
        self.fd=os.open(JOURNAL,os.O_RDWR|os.O_APPEND|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC|os.O_NOFOLLOW,0o600,dir_fd=journal_fd)
        try:
            fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB);_no_xattrs(self.fd);os.fsync(self.fd);os.fsync(journal_fd)
            st=os.fstat(self.fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or st.st_size!=0:raise Refuse('JOURNAL_FILE')
            self.expected=_ident(st)
        except BaseException:self.failed=True;os.close(self.fd);raise

    def _file(self):
        a=os.fstat(self.fd);b=os.stat(JOURNAL,dir_fd=self.dirfd,follow_symlinks=False)
        if _ident(a)!=self.expected or _ident(b)!=self.expected:raise Refuse('JOURNAL_DRIFT')
        _no_xattrs(self.fd)
        d=os.fstat(self.dirfd)
        if (d.st_dev,d.st_ino,d.st_uid,d.st_gid,stat.S_IMODE(d.st_mode))!=self.dir_identity:raise Refuse('JOURNAL_DRIFT')
        _trusted_directory_chain(self.dir_path)
        actual=os.stat(self.dir_path,follow_symlinks=False)
        if (actual.st_dev,actual.st_ino,actual.st_uid,actual.st_gid,stat.S_IMODE(actual.st_mode))!=self.dir_identity:raise Refuse('JOURNAL_DRIFT')
        _no_xattrs(self.dirfd)

    def assert_live(self):
        if self.failed or os.getpid()!=self.pid:raise Refuse('OWNER_LOST')
        self.guard.assert_live();self._file()

    def assert_exclusive_config_writer(self):
        self.guard.assert_exclusive_config_writer();self.assert_live()

    def assert_candidate_prevalidated(self,staged):
        self.assert_live();self.guard.assert_candidate_prevalidated()
        if set(staged)!={'hub','target'}:raise Refuse('CANDIDATE')
        for key in ('hub','target'):
            if staged[key]['sha256']!=self.plan['identities'][key]['candidate_sha256']:raise Refuse('CANDIDATE')

    def assert_install_allowed(self):
        self.assert_live();self.guard.assert_install_allowed()

    def assert_restore_allowed(self):
        self.assert_live();self.guard.assert_restore_allowed()

    def checkpoint(self,phase,details):
        self.assert_live()
        try:
            value={'sequence':self.seq+1,'transactionId':self.tx,'phase':phase,'previous':self.previous,'details':details}
            encoded=(json.dumps(value,separators=(',',':'),sort_keys=True,ensure_ascii=True)+'\n').encode('ascii')
            if len(encoded)>16384:raise Refuse('JOURNAL_LIMIT')
            view=memoryview(encoded)
            while view:
                written=os.write(self.fd,view)
                if written<=0:raise Refuse('JOURNAL_WRITE')
                view=view[written:]
            os.fsync(self.fd);os.fsync(self.dirfd)
            after=os.fstat(self.fd);current=os.stat(JOURNAL,dir_fd=self.dirfd,follow_symlinks=False)
            expected_size=self.expected[6]+len(encoded)
            if (after.st_dev,after.st_ino)!=(self.expected[0],self.expected[1]) or after.st_size!=expected_size or _ident(current)!=_ident(after):raise Refuse('JOURNAL_DRIFT')
            _no_xattrs(self.fd);self.expected=_ident(after);self.seq+=1;self.previous=hashlib.sha256(encoded).hexdigest()
            self.guard.assert_live()
        except BaseException:self.failed=True;raise

    def mark_unknown(self):self.failed=True
    def close(self):os.close(self.fd)


if __name__=='__main__':print('DISABLED: sealed guard not installed')
