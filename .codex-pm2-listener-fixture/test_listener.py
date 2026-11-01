import importlib.util,os,socket,struct,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
SOURCE=HERE/'live_drain.py'
spec=importlib.util.spec_from_file_location('live_under_test',SOURCE);live=importlib.util.module_from_spec(spec);spec.loader.exec_module(live)
PATH='/fixture/rpc.sock'
HEADER=b'Num RefCount Protocol Flags Type St Inode Path\n'
def row(flags=b'00010000',kind=b'0001',state=b'01',inode=b'42',path=PATH.encode()):
 return b'000: 00000002 00000000 '+flags+b' '+kind+b' '+state+b' '+inode+b' '+path+b'\n'
class Probe:
 def __init__(self,data):self.data=data
 def trusted(self,path,kind):
  if kind!='socket':raise AssertionError()
  return ('stat',path)
 def stamp(self,metadata):return metadata
 def read(self,path,limit,proc):
  assert path=='/proc/net/unix' and proc and limit==2097152
  return self.data
class Synthetic(unittest.TestCase):
 def listener(self,data):
  o=live.LinuxContinuousDrain.__new__(live.LinuxContinuousDrain);o.probe=Probe(HEADER+data);return o._listener(PATH)
 def test_only_listener(self):self.assertEqual(self.listener(row()),(('stat',PATH),42))
 def test_duplicate_listener_rejected(self):
  with self.assertRaises(live.DrainError):self.listener(row()+row(inode=b'43'))
 def test_no_listener_rejected(self):
  with self.assertRaises(live.DrainError):self.listener(b'')
 def test_foreign_path_ignored(self):self.assertEqual(self.listener(row(path=b'/other')+row()),(('stat',PATH),42))
 def test_accepted_connected_row_does_not_replace_listener(self):
  connected=row(flags=b'00000000',state=b'03',inode=b'77')
  self.assertEqual(self.listener(connected+row()),(('stat',PATH),42))
  with self.assertRaises(live.DrainError):self.listener(connected)
 def test_unexpected_flags_type_state_or_inode_rejected(self):
  for bad in (row(flags=b'00020000'),row(kind=b'0002'),row(state=b'03'),row(flags=b'00000000',state=b'01'),row(inode=b'0'),row(inode=b'not-a-number')):
   with self.subTest(row=bad):
    with self.assertRaises(live.DrainError):self.listener(row()+bad)
 def test_connected_and_two_listeners_rejected(self):
  with self.assertRaises(live.DrainError):self.listener(row(flags=b'00000000',state=b'03',inode=b'77')+row()+row(inode=b'43'))
class Closure(unittest.TestCase):
 def test_updated_dependency_pins_match_exact_bytes(self):
  import hashlib
  provider=HERE/'linux-owner-implementation-61e9/worker-provider'
  def load(file,name):
   sp=importlib.util.spec_from_file_location(name,file);mod=importlib.util.module_from_spec(sp);sp.loader.exec_module(mod);return mod
  def digest(file):return hashlib.sha256(Path(file).read_bytes()).hexdigest()
  watch=load(provider/'continuous_watch.py','watch_test');current=load(provider/'current_identity.py','current_test');slot=load(HERE/'worker-stop-bind-61e9/slot_monitor.py','slot_test')
  self.assertEqual(digest(watch.LIVE),watch.LIVE_SHA)
  self.assertEqual(digest(slot.WATCH_FILE),slot.WATCH_SHA)
  for file,pin in current.PINS.items():self.assertEqual(digest(file),pin)
@unittest.skipUnless(sys.platform=='linux','requires native Linux /proc/net/unix')
class Native(unittest.TestCase):
 def test_actual_listener_connected_peers_and_peercred(self):
  with tempfile.TemporaryDirectory(prefix='fixture-unix-') as d:
   p=str(Path(d)/'rpc.sock');server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);accepted=None
   try:
    server.bind(p);server.listen(4);client.connect(p);accepted,_=server.accept()
    rows=[r.split() for r in Path('/proc/net/unix').read_bytes().splitlines()[1:] if len(r.split())==8 and r.split()[7]==p.encode()]
    self.assertTrue(any(x[3]==b'00010000' and x[4]==b'0001' for x in rows));self.assertTrue(any(x[3]!=b'00010000' for x in rows))
    class RealProbe:
     def trusted(self,path,kind):
      st=os.lstat(path);self_case.assertTrue(stat.S_ISSOCK(st.st_mode));return st
     def stamp(self,st):return(st.st_dev,st.st_ino,st.st_uid,st.st_gid,st.st_mode)
     def read(self,path,limit,proc):return Path(path).read_bytes()
    import stat
    self_case=self;o=live.LinuxContinuousDrain.__new__(live.LinuxContinuousDrain);o.probe=RealProbe()
    _stamp,inode=o._listener(p)
    listener=[int(x[6]) for x in rows if x[3]==b'00010000' and x[4]==b'0001'];self.assertEqual([inode],listener)
    self.assertEqual(os.readlink('/proc/self/fd/'+str(server.fileno())),'socket:[%d]'%inode)
    peer=struct.unpack('3i',client.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));self.assertEqual(peer[0],os.getpid());self.assertEqual(peer[1],os.geteuid())
   finally:
    client.close()
    if accepted:accepted.close()
    server.close()
if __name__=='__main__':unittest.main()
