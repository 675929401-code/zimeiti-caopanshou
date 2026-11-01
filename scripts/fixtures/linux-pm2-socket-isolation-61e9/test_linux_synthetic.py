"""Nonproduction feasibility test only. Never imports a production executor."""
import os,socket,stat,subprocess,sys,tempfile,unittest
from pathlib import Path
CLIENT="""import os,socket,sys
os.setgroups([0]);os.setgid(0);os.setuid(60001)
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(3)
try:s.connect(sys.argv[1])
except PermissionError:print('DENIED');raise SystemExit(0)
if sys.argv[2]=='existing':
 assert s.recv(2)==b'ok';print('DELIVERED')
else:print('CONNECTED')
s.close()
"""
@unittest.skipUnless(sys.platform=='linux' and hasattr(os,'geteuid') and os.geteuid()==0,'Requires nonproduction Linux root fixture')
class LinuxTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='socket-isolation-synthetic-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);os.chmod(self.root,0o750);self.path=self.root/'fixture.sock'
        self.server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.server.bind(str(self.path));self.server.listen(5);self.server.settimeout(4);self.addCleanup(self.server.close);os.chmod(self.path,0o775)
        self.anchor=os.open(self.path,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC);self.addCleanup(os.close,self.anchor)
        self.anchor_path='/proc/self/fd/'+str(self.anchor)
    def child(self,mode):
        return subprocess.Popen([sys.executable,'-I','-S','-B','-c',CLIENT,str(self.path),mode],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,close_fds=True)
    def finish(self,child):
        try:out,_=child.communicate(timeout=5)
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=3)
        self.assertEqual(child.returncode,0);return out.strip()
    def test_restriction_does_not_revoke_existing_peer(self):
        child=self.child('existing')
        try:
            connection,_=self.server.accept()
            with connection:
                os.chmod(self.anchor_path,0o600)
                self.assertEqual(stat.S_IMODE(os.fstat(self.anchor).st_mode),0o600)
                self.assertEqual(self.finish(self.child('new')),b'DENIED')
                # Previously accepted nonroot GID0 peer remains able to receive.
                connection.sendall(b'ok');self.assertEqual(self.finish(child),b'DELIVERED')
            root_client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            with root_client:
                root_client.settimeout(3);root_client.connect(str(self.path));accepted,_=self.server.accept();accepted.close()
            os.chmod(self.anchor_path,0o775)
            self.assertEqual(self.finish(self.child('new')),b'CONNECTED');accepted,_=self.server.accept();accepted.close()
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=3)
    def test_anchor_does_not_chmod_replacement_path(self):
        old_inode=os.fstat(self.anchor).st_ino;self.path.unlink()
        replacement=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        with replacement:
            replacement.bind(str(self.path));replacement.listen(1);os.chmod(self.path,0o770);new_inode=self.path.lstat().st_ino;self.assertNotEqual(old_inode,new_inode)
            os.chmod(self.anchor_path,0o600)
            self.assertEqual(stat.S_IMODE(os.fstat(self.anchor).st_mode),0o600);self.assertEqual(stat.S_IMODE(self.path.lstat().st_mode),0o770)
            # Demonstrates inode anchoring only, NOT atomic compare-and-swap of mode.
            os.chmod(self.anchor_path,0o775);self.assertEqual(stat.S_IMODE(self.path.lstat().st_mode),0o770)
if __name__=='__main__':unittest.main()
