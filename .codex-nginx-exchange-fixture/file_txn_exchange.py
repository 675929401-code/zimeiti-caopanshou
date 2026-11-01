"""Linux-only file primitive for a sealed single-owner controller.

No CLI, no service calls, no network. This module does not authenticate an
owner, prove candidate correctness, perform nginx -t/reload, or authorize its
own use. A closed production provider must remain closed until those exist.
"""
import hashlib
import errno
import ctypes
import os
import re
import stat

LIVE = '/synthetic/live'
JOURNAL_BASE = '/synthetic/transactions'
FILES = {'hub':('hub.conf','0'*64),'target':('target.conf','1'*64)}


class Refuse(RuntimeError):pass


def digest(data):return hashlib.sha256(data).hexdigest()


def identity(info):
    return (info.st_dev,info.st_ino,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)


def _no_xattrs(target):
    try:names=os.listxattr(target)
    except (AttributeError,OSError):raise Refuse('XATTR_UNKNOWN') from None
    if names:raise Refuse('XATTR_PRESENT')
    for name in ('system.posix_acl_access','system.posix_acl_default','security.selinux',
                 'security.SMACK64','security.capability','security.ima','security.evm'):
        try:os.getxattr(target,name)
        except OSError as exc:
            if exc.errno==errno.ENODATA:continue
            raise Refuse('XATTR_UNKNOWN') from None
        raise Refuse('XATTR_PRESENT')


def _trusted_directory_chain(path):
    if not os.path.isabs(path) or os.path.normpath(path)!=path:raise Refuse('DIRECTORY_IDENTITY')
    current='/'
    for part in ['']+path.strip('/').split('/'):
        if part:current=os.path.join(current,part)
        info=os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise Refuse('DIRECTORY_IDENTITY')
        _no_xattrs(current)


def _read(dirfd,name):
    fd=os.open(name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=dirfd)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_mode&0o022 or before.st_nlink!=1 or before.st_size>1048576:raise Refuse('FILE_IDENTITY')
        _no_xattrs(fd)
        chunks=[];total=0
        while True:
            chunk=os.read(fd,65536)
            if not chunk:break
            total+=len(chunk)
            if total>1048576:raise Refuse('FILE_LIMIT')
            chunks.append(chunk)
        after=os.fstat(fd)
        _no_xattrs(fd)
        if identity(before)!=identity(after):raise Refuse('FILE_DRIFT')
        return b''.join(chunks),identity(before)
    finally:os.close(fd)


def _create(dirfd,name,data,mode,gid):
    fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_CLOEXEC|os.O_NOFOLLOW,0o600,dir_fd=dirfd)
    try:
        view=memoryview(data)
        while view:
            n=os.write(fd,view)
            if n<=0:raise Refuse('WRITE_FAILED')
            view=view[n:]
        os.fchown(fd,0,gid);os.fchmod(fd,mode);_no_xattrs(fd);os.fsync(fd)
        result=identity(os.fstat(fd))
    finally:os.close(fd)
    os.fsync(dirfd)
    return result


def _exchange(dirfd,live_name,stage_name):
    """Atomic same-directory name exchange; no unlink or rename fallback."""
    match=re.fullmatch(r'\.codex-hold-[a-f0-9]{32}-(hub|target)\.(?:next|restore)',stage_name)
    if not match or live_name!=FILES[match[1]][0]:raise Refuse('EXCHANGE_NAME')
    libc=ctypes.CDLL(None,use_errno=True)
    try:fn=libc.renameat2
    except AttributeError:raise Refuse('EXCHANGE_UNAVAILABLE') from None
    fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    fn.restype=ctypes.c_int
    if fn(dirfd,os.fsencode(live_name),dirfd,os.fsencode(stage_name),2)!=0:
        raise Refuse('EXCHANGE_FAILED')


class FileTransaction:
    """Only owned by the already-authenticated controller and one process.

    `owner.assert_live()` must throw on session/lock loss; `owner.checkpoint`
    must persist and fsync intent/result. No caller value is accepted as proof.
    """
    def __init__(self,owner,live_fd,journal_fd,transaction,candidates):
        if os.name!='posix' or not hasattr(os,'O_NOFOLLOW') or not re.fullmatch('[a-f0-9]{32}',transaction):raise Refuse('PLATFORM_OR_ID')
        if set(candidates)!=set(FILES) or any(type(x) is not bytes or not x or len(x)>1048576 for x in candidates.values()):raise Refuse('CANDIDATE')
        self.owner,self.live,self.journal,self.tx=owner,live_fd,journal_fd,transaction
        self.candidates=dict(candidates);self.originals={};self.staged={};self.installed={};self.state='NEW'
        self.pid=os.getpid()
        if os.readlink(f'/proc/self/fd/{live_fd}')!=LIVE:raise Refuse('LIVE_DIRECTORY')
        journal_path=os.readlink(f'/proc/self/fd/{journal_fd}')
        name=os.path.basename(journal_path)
        if os.path.dirname(journal_path)!=JOURNAL_BASE or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}',name):raise Refuse('JOURNAL_DIRECTORY')
        if hashlib.sha256(name.encode('ascii')).hexdigest()[:32]!=transaction:raise Refuse('TRANSACTION_BINDING')
        self.journal_path=journal_path
        _trusted_directory_chain(LIVE);_trusted_directory_chain(journal_path)
        for fd in (live_fd,journal_fd):
            d=os.fstat(fd)
            if not stat.S_ISDIR(d.st_mode) or d.st_uid!=0 or d.st_mode&0o022:raise Refuse('DIRECTORY_IDENTITY')
        self.live_identity=identity(os.fstat(live_fd));self.journal_identity=identity(os.fstat(journal_fd))
        if self.journal_identity[4]&0o077 or self.live_identity[:2]==self.journal_identity[:2]:raise Refuse('JOURNAL_PERMISSIONS')

    def _live(self):
        if os.getpid()!=self.pid or self.state=='UNKNOWN':raise Refuse('OWNER_LOST')
        self.owner.assert_live();self.owner.assert_exclusive_config_writer()
        _trusted_directory_chain(LIVE);_trusted_directory_chain(self.journal_path)
        _no_xattrs(self.live);_no_xattrs(self.journal)
        current=os.stat(LIVE,follow_symlinks=False)
        if identity(current)[:5]!=self.live_identity[:5] or identity(os.fstat(self.live))[:5]!=self.live_identity[:5]:raise Refuse('DIRECTORY_DRIFT')
        current_journal=os.stat(self.journal_path,follow_symlinks=False)
        if identity(current_journal)[:5]!=self.journal_identity[:5] or identity(os.fstat(self.journal))[:5]!=self.journal_identity[:5]:raise Refuse('JOURNAL_DRIFT')

    def _point(self,phase,details):
        self._live();self.owner.checkpoint(phase,details);self._live()

    def stage(self):
        if self.state!='NEW':raise Refuse('PHASE')
        try:
            self._live();self.owner.assert_staging_not_included();self._live()
            self._point('file-stage-intent',{'transaction':self.tx,'live_directory_identity':self.live_identity,'journal_directory_identity':self.journal_identity})
            for key,(name,expected) in FILES.items():
                self._live();old,ident=_read(self.live,name)
                if digest(old)!=expected:raise Refuse('ORIGINAL_DRIFT')
                new=self.candidates[key]
                if digest(new)==expected:raise Refuse('NO_CHANGE')
                backup=f'{key}.original';temp=f'.codex-hold-{self.tx}-{key}.next'
                backup_identity=_create(self.journal,backup,old,0o600,0)
                saved,saved_identity=_read(self.journal,backup)
                if saved_identity!=backup_identity or saved!=old:raise Refuse('BACKING_DRIFT')
                staged_identity=_create(self.live,temp,new,ident[4],ident[3])
                check,observed=_read(self.live,temp)
                if observed!=staged_identity or check!=new:raise Refuse('STAGE_DRIFT')
                self.originals[key]={'identity':ident,'sha256':expected,'backup':backup,'backup_identity':backup_identity,'temp':temp}
                self.staged[key]={'identity':observed,'sha256':digest(new)}
                self._point('file-stage-one',{'key':key,'original_sha256':expected,'original_identity':ident,
                    'backup_identity':backup_identity,'candidate_sha256':digest(new),'staged_identity':observed})
            self.state='STAGED';self._point('file-stage-complete',{'transaction':self.tx})
        except BaseException:self.state='UNKNOWN';raise

    def install(self):
        if self.state!='STAGED':raise Refuse('PHASE')
        try:
            self._live();self.owner.assert_candidate_prevalidated(dict(self.staged));self._live()
            for key,(name,_) in FILES.items():
                self._point('file-install-intent',{'key':key,'original_identity':self.originals[key]['identity'],
                    'staged_identity':self.staged[key]['identity'],'candidate_sha256':self.staged[key]['sha256']})
                original,original_id=_read(self.live,name);candidate,candidate_id=_read(self.live,self.originals[key]['temp'])
                if original_id!=self.originals[key]['identity'] or digest(original)!=self.originals[key]['sha256']:raise Refuse('ORIGINAL_DRIFT')
                if candidate_id!=self.staged[key]['identity'] or digest(candidate)!=self.staged[key]['sha256']:raise Refuse('STAGE_DRIFT')
                self._live();_exchange(self.live,name,self.originals[key]['temp']);os.fsync(self.live)
                installed,installed_id=_read(self.live,name)
                displaced,displaced_id=_read(self.live,self.originals[key]['temp'])
                # rename changes ctime on some kernels; device/inode and bytes are bound.
                if installed_id[:2]!=candidate_id[:2] or digest(installed)!=self.staged[key]['sha256']:raise Refuse('INSTALL_DRIFT')
                if displaced_id[:8]!=original_id[:8] or digest(displaced)!=self.originals[key]['sha256']:raise Refuse('DISPLACED_DRIFT')
                self.installed[key]={'identity':installed_id,'sha256':digest(installed),'displaced_identity':displaced_id}
                self._point('file-install-one',{'key':key,'candidate_sha256':digest(installed),'installed_identity':installed_id,
                    'displaced_identity':displaced_id,'displaced_sha256':digest(displaced)})
            self.state='INSTALLED';self._point('file-install-complete',{'transaction':self.tx})
        except BaseException:self.state='UNKNOWN';raise

    def verify_files(self):
        if self.state!='INSTALLED':raise Refuse('PHASE')
        try:
            self._live()
            for key,(name,_) in FILES.items():
                data,ident=_read(self.live,name)
                if ident!=self.installed[key]['identity'] or digest(data)!=self.installed[key]['sha256']:raise Refuse('INSTALLED_DRIFT')
            self._live()
        except BaseException:self.state='UNKNOWN';raise

    def restore(self):
        if self.state!='INSTALLED':raise Refuse('PHASE')
        try:
            self._live();self.owner.assert_restore_allowed();self._live()
            self.verify_files()
            for key,(name,_) in FILES.items():
                self._point('file-restore-intent',{'key':key,'original_sha256':self.originals[key]['sha256'],
                    'installed_identity':self.installed[key]['identity'],'backup_identity':self.originals[key]['backup_identity']})
                current,current_id=_read(self.live,name);original,backup_id=_read(self.journal,self.originals[key]['backup'])
                if current_id!=self.installed[key]['identity'] or digest(current)!=self.installed[key]['sha256']:raise Refuse('INSTALLED_DRIFT')
                if backup_id!=self.originals[key]['backup_identity'] or digest(original)!=self.originals[key]['sha256']:raise Refuse('BACKING_DRIFT')
                temp=f'.codex-hold-{self.tx}-{key}.restore'
                old_id=self.originals[key]['identity'];staged=_create(self.live,temp,original,old_id[4],old_id[3])
                self._point('file-restore-stage',{'key':key,'restore_staged_identity':staged,'installed_identity':current_id})
                # Recheck immediately before rename. This is not a kernel CAS;
                # the owner must coordinate all privileged writers externally.
                _,again=_read(self.live,name)
                if again!=current_id:raise Refuse('INSTALLED_DRIFT')
                self._live();_exchange(self.live,name,temp);os.fsync(self.live)
                restored,restored_id=_read(self.live,name)
                displaced,displaced_id=_read(self.live,temp)
                if restored_id[:2]!=staged[:2] or digest(restored)!=self.originals[key]['sha256']:raise Refuse('RESTORE_DRIFT')
                if displaced_id[:8]!=current_id[:8] or digest(displaced)!=self.installed[key]['sha256']:raise Refuse('DISPLACED_DRIFT')
                self._point('file-restore-one',{'key':key,'original_sha256':digest(restored),'restored_identity':restored_id,
                    'displaced_identity':displaced_id,'displaced_sha256':digest(displaced)})
            self.state='RESTORED';self._point('file-restore-complete',{'transaction':self.tx})
        except BaseException:self.state='UNKNOWN';raise


if __name__=='__main__':print('DISABLED: no standalone production executor')
