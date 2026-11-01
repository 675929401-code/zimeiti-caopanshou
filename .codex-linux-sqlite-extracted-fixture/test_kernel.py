"""Synthetic Linux kernel fixture; no production connections or host data."""
import errno,hashlib,importlib.util,json,os,pathlib,select,signal,subprocess,sys,time,unittest
ROOT=pathlib.Path(__file__).resolve().parent
FIXTURE=pathlib.Path('/data/web/shared/runtime/sqlite-extracted-fixture')
PYTHON='/usr/bin/python3'
if sys.platform!='linux' or os.geteuid()!=0 or os.environ.get('SQLITE_FIXTURE_ONLY')!='github-isolated-v1':raise SystemExit('E_FIXTURE_SCOPE')
if not pathlib.Path('/data/.synthetic-fixture-mount').is_file():raise SystemExit('E_FIXTURE_MOUNT')
spec=importlib.util.spec_from_file_location('provider',ROOT/'sqlite-window-provider.py');provider=importlib.util.module_from_spec(spec);spec.loader.exec_module(provider)
reader=provider._load_reader(ROOT/'sqlite-reader.py')
WRITER=r'''
import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL')
c.execute('CREATE TABLE records(bucket TEXT,id TEXT,owner TEXT,value TEXT,updated INTEGER)')
c.execute('INSERT INTO records VALUES(?,?,?,?,?)',('jobs','test','synthetic','{"status":"queued","input":{}}',0));c.commit()
print('READY',flush=True)
for line in sys.stdin:
 if line.strip()=='close':c.close();print('CLOSED',flush=True);break
'''
def receive(pipe,timeout=8):
 out=bytearray();deadline=time.monotonic()+timeout
 while True:
  remaining=deadline-time.monotonic()
  if remaining<=0 or not select.select([pipe],[],[],remaining)[0]:raise RuntimeError('E_TIMEOUT')
  b=os.read(pipe.fileno(),1)
  if not b:raise RuntimeError('E_EOF')
  if b==b'\n':return out.decode('ascii')
  out.extend(b)
  if len(out)>1024:raise RuntimeError('E_OVERFLOW')
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
class FixtureOwner:
 """Fixture callback only; not an authenticated production owner."""
 def assert_bound(self):pass
 def verify_file(self,path,pin):
  if sha(pathlib.Path(path))!=pin:raise ValueError('E_FILE')
class KernelFixture(unittest.TestCase):
 def test_actual_clean_child_reader_and_unknown(self):
  FIXTURE.mkdir(mode=0o700,parents=True,exist_ok=False)
  db=FIXTURE/'commerce.sqlite'; sidecars=[db,pathlib.Path(str(db)+'-wal'),pathlib.Path(str(db)+'-shm')]
  writer=subprocess.Popen([PYTHON,'-I','-S','-B','-c',WRITER,str(db)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
  try:
   self.assertEqual(receive(writer.stdout),'READY');self.assertTrue(all(p.is_file() for p in sidecars))
   source_ns=os.readlink('/proc/self/ns/mnt');source_mounts=pathlib.Path('/proc/self/mountinfo').read_bytes()
   # No SQLite descriptors or mappings are inherited by the reader parent.
   self.assertFalse(any(str(db) in os.readlink(p) for p in pathlib.Path('/proc/self/fd').iterdir() if p.exists()))
   self.assertNotIn(os.fsencode(str(db)),pathlib.Path('/proc/self/maps').read_bytes())
   # Exercise the exact reader's isolation in a separate kernel child. The
   # process exits immediately; the bind mount never exists in the parent.
   readfd,writefd=os.pipe();pid=os.fork()
   if pid==0:
    os.close(readfd)
    try:
     reader['isolate'](FIXTURE,reader['LinuxMount']());blocked=0
     for p,flags in [(FIXTURE/'forbidden',os.O_CREAT|os.O_EXCL|os.O_WRONLY)]+[(p,os.O_RDWR) for p in sidecars]:
      try:
       fd=os.open(p,flags,0o600);os.close(fd);raise RuntimeError('E_WRITE_ALLOWED')
      except OSError as e:
       if e.errno!=errno.EROFS:raise
       blocked+=1
     os.write(writefd,str(blocked).encode('ascii'))
    except BaseException:os.write(writefd,b'FAILED')
    finally:os.close(writefd);os._exit(0)
   os.close(writefd)
   try:
    self.assertTrue(select.select([readfd],[],[],5)[0]);self.assertEqual(os.read(readfd,32),b'4');_,status=os.waitpid(pid,0);self.assertTrue(os.WIFEXITED(status) and os.WEXITSTATUS(status)==0);pid=None
   finally:
    os.close(readfd)
    if pid is not None:
     try:os.kill(pid,signal.SIGKILL)
     except ProcessLookupError:pass
     os.waitpid(pid,0)
   observer=provider._SQLiteWindowObserver(FixtureOwner(),str(FIXTURE),PYTHON,str(ROOT/'sqlite-window-provider.py'),str(ROOT/'sqlite-reader.py'),sha(pathlib.Path(PYTHON)),sha(ROOT/'sqlite-window-provider.py'))
   got=observer.capture();self.assertFalse(got['releaseReady']);self.assertFalse(got['maintenanceCoverageComplete']);self.assertTrue(got['sqlite']['read_only']);self.assertFalse(got['sqlite']['atomic_quiescence_proven']);self.assertEqual(got['sqlite']['groups']['ordinary_jobs']['unfinished'],1)
   self.assertEqual(source_ns,os.readlink('/proc/self/ns/mnt'));self.assertEqual(source_mounts,pathlib.Path('/proc/self/mountinfo').read_bytes())
   writer.stdin.write(b'close\n');writer.stdin.flush();self.assertEqual(receive(writer.stdout),'CLOSED');writer.wait(timeout=5)
   self.assertFalse(pathlib.Path(str(db)+'-wal').exists());self.assertFalse(pathlib.Path(str(db)+'-shm').exists())
   with self.assertRaisesRegex(provider.SQLiteWindowError,'^SQLITE_CAPTURE_UNKNOWN$'):observer.capture()
   with self.assertRaisesRegex(provider.SQLiteWindowError,'^SQLITE_SESSION_UNKNOWN$'):observer.capture()
   self.assertEqual(source_ns,os.readlink('/proc/self/ns/mnt'));self.assertEqual(source_mounts,pathlib.Path('/proc/self/mountinfo').read_bytes())
  finally:
   if writer.poll() is None:
    try:os.killpg(writer.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    writer.wait(timeout=2)
   writer.stdin.close();writer.stdout.close()
if __name__=='__main__':unittest.main(verbosity=2)
