"""LOCAL LINUX FIXTURE ONLY. Never run on production.
Writer is a separate exec process. The reader parent never opens SQLite, so fork
cannot inherit the writer's database descriptors or writable mappings.
"""
import errno,json,os,pathlib,re,select,signal,subprocess,sys,time,uuid
ROOT=pathlib.Path(__file__).resolve().parent
WRITER_SOURCE=r"""
import json,sqlite3,sys
connection=None
path=sys.argv[1]
def emit(state,count=None):
 value={'state':state}
 if count is not None:value['count']=count
 print(json.dumps(value),flush=True)
def open_database():
 c=sqlite3.connect(path)
 c.execute('PRAGMA journal_mode=WAL')
 c.execute('CREATE TABLE IF NOT EXISTS records(bucket TEXT,id TEXT,owner TEXT,value TEXT,updated INTEGER)')
 return c
def insert():
 n=connection.execute('SELECT count(*) FROM records').fetchone()[0]+1
 connection.execute('INSERT INTO records VALUES(?,?,?,?,?)',('jobs','fixture-'+str(n),'owner','{"status":"queued","input":{}}',0));connection.commit();return n
try:
 connection=open_database();emit('READY',insert())
 for line in sys.stdin:
  command=line.strip()
  if command=='INSERT':emit('WRITTEN',insert())
  elif command=='CLOSE':connection.close();connection=None;emit('CLOSED')
  elif command=='REOPEN_INSERT':connection=open_database();emit('WRITTEN',insert())
  elif command=='EXIT':
   if connection is not None:connection.close()
   emit('EXITED');break
  else:raise RuntimeError('invalid fixed command')
except Exception:emit('ERROR');raise SystemExit(1)
"""
def receive(fd,timeout=10,limit=16384):
 deadline=time.monotonic()+timeout;data=bytearray()
 while True:
  left=deadline-time.monotonic()
  if left<=0 or not select.select([fd],[],[],left)[0]:raise RuntimeError('E_FIXTURE_TIMEOUT')
  chunk=os.read(fd,1)
  if not chunk:raise RuntimeError('E_FIXTURE_EOF')
  if chunk==b'\n':return bytes(data)
  data.extend(chunk)
  if len(data)>limit:raise RuntimeError('E_FIXTURE_LIMIT')
def send(fd,data):
 while data:
  n=os.write(fd,data);data=data[n:]
def inherited_database_handles(database,proc_root=pathlib.Path('/proc/self')):
 prefix=str(database);fds=0;maps=0
 for entry in (proc_root/'fd').iterdir():
  try:target=os.readlink(entry)
  except FileNotFoundError:continue
  if target.removesuffix(' (deleted)').startswith(prefix):fds+=1
 for line in (proc_root/'maps').read_bytes().splitlines():
  parts=line.split(None,5)
  if len(parts)<6:continue
  path=re.sub(rb'\\([0-7]{3})',lambda m:bytes([int(m.group(1),8)]),parts[5])
  if os.fsdecode(path).removesuffix(' (deleted)').startswith(prefix):maps+=1
 return {'database_fds':fds,'database_mappings':maps}
def assert_no_database_handles(database):
 value=inherited_database_handles(database)
 if value!={'database_fds':0,'database_mappings':0}:raise RuntimeError('E_INHERITED_DATABASE_HANDLES')
 return value
def writer_command(writer,command,expected,count=None):
 send(writer.stdin.fileno(),command.encode('ascii')+b'\n');value=json.loads(receive(writer.stdout.fileno()))
 if value.get('state')!=expected or (count is not None and value.get('count')!=count):raise RuntimeError('E_WRITER_CONTRACT')
 return value
def wait_owned(pid,timeout=10):
 deadline=time.monotonic()+timeout
 while True:
  found,status=os.waitpid(pid,os.WNOHANG)
  if found:return status
  if time.monotonic()>deadline:
   raise RuntimeError('E_READER_TIMEOUT')
  time.sleep(0.02)
def run_reader(ns,fixture,database,writer,race=False):
 result_r,result_w=os.pipe();ready_r,ready_w=os.pipe();go_r,go_w=os.pipe();pid=os.fork()
 if pid==0:
  os.close(result_r);os.close(ready_r);os.close(go_w)
  # The reader inherits only control pipes from the writer launcher, not DB FDs.
  os.close(writer.stdin.fileno());os.close(writer.stdout.fileno())
  try:
   inherited=assert_no_database_handles(database)
   ns['isolate'](fixture,ns['LinuxMount']())
   blocked=0
   for target,flags in [(fixture/('forbidden-'+('race' if race else 'normal')),os.O_CREAT|os.O_EXCL|os.O_WRONLY),(database,os.O_RDWR),(pathlib.Path(str(database)+'-wal'),os.O_RDWR),(pathlib.Path(str(database)+'-shm'),os.O_RDWR)]:
    try:
     fd=os.open(target,flags,0o600);os.close(fd);raise AssertionError('E_RO_WRITE_ALLOWED')
    except OSError as exc:
     if exc.errno!=errno.EROFS:raise
     blocked+=1
   runtime=ns['runtime']()
   def fixture_trust(path,*args):
    path=pathlib.Path(path)
    if not path.resolve().is_relative_to(fixture.resolve()):raise RuntimeError('E_FIXTURE_PATH')
    return os.lstat(path)
   runtime['trusted']=fixture_trust
   if race:
    original=ns['files'];calls=[0]
    def pause_after_sidecar_preflight(db,rt):
     value=original(db,rt);calls[0]+=1
     if calls[0]==1:
      send(ready_w,b'PREFLIGHT_COMPLETE\n')
      if receive(go_r)!=b'SIDECARS_REMOVED':raise RuntimeError('E_RACE_PROTOCOL')
     return value
    ns['files']=pause_after_sidecar_preflight
    import sqlite3
    rejected=False
    try:ns['sqlite_read'](database,runtime)
    except sqlite3.DatabaseError as exc:
     if getattr(exc,'sqlite_errorcode',0)&255 not in (sqlite3.SQLITE_READONLY,sqlite3.SQLITE_CANTOPEN):raise
     rejected=True
    if not rejected:raise RuntimeError('E_RACE_NOT_REJECTED')
    if any(pathlib.Path(str(database)+x).exists() for x in ['-wal','-shm']):raise RuntimeError('E_SIDECAR_CREATED')
    result={'passed':True,'readonly_race_rejected':True,'sidecars_not_created':True,'kernel_EROFS_count':blocked,**inherited}
   else:
    value=ns['sqlite_read'](database,runtime)
    if value['groups']['ordinary_jobs']['unfinished']!=1:raise RuntimeError('E_AGGREGATE')
    result={'passed':True,'aggregate_valid':True,'kernel_EROFS_count':blocked,**inherited}
  except Exception as exc:result={'passed':False,'error':str(exc) if isinstance(exc,ns['CaptureError']) else type(exc).__name__}
  send(result_w,json.dumps(result).encode('ascii')+b'\n')
  for fd in [result_w,ready_w,go_r]:os.close(fd)
  os._exit(0)
 os.close(result_w);os.close(ready_w);os.close(go_r);reaped=False
 try:
  if race:
   if receive(ready_r)!=b'PREFLIGHT_COMPLETE':raise RuntimeError('E_RACE_PROTOCOL')
   writer_command(writer,'CLOSE','CLOSED')
   if any(pathlib.Path(str(database)+x).exists() for x in ['-wal','-shm']):raise RuntimeError('E_SIDECARS_REMAIN')
   send(go_w,b'SIDECARS_REMOVED\n')
  result=json.loads(receive(result_r,timeout=20));status=wait_owned(pid);reaped=True
  if not os.WIFEXITED(status) or os.WEXITSTATUS(status)!=0:raise RuntimeError('E_READER_EXIT')
  return result
 finally:
  for fd in [result_r,ready_r,go_w]:os.close(fd)
  if not reaped:
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
   try:os.waitpid(pid,0)
   except ChildProcessError:pass

def main():
 if sys.platform!='linux' or os.geteuid()!=0:raise SystemExit('E_LOCAL_LINUX_ROOT_REQUIRED')
 ns={'__name__':'commerce_fixture_import'};exec(compile((ROOT/'probe.py').read_bytes(),str(ROOT/'probe.py'),'exec'),ns)
 fixture=ROOT/('linux-fixture-'+uuid.uuid4().hex);fixture.mkdir(mode=0o700)
 if not fixture.resolve().is_relative_to(ROOT.resolve()):raise RuntimeError('E_FIXTURE_PATH')
 database=fixture/'commerce.sqlite';parent_ns=os.readlink('/proc/self/ns/mnt');mounts=pathlib.Path('/proc/self/mountinfo').read_bytes()
 writer=subprocess.Popen([sys.executable,'-I','-S','-B','-c',WRITER_SOURCE,str(database)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,close_fds=True,bufsize=0,cwd=ROOT)
 report={'passed':False,'production_connected':False,'writer_is_separate_exec_process':True}
 try:
  if json.loads(receive(writer.stdout.fileno()))!={'state':'READY','count':1}:raise RuntimeError('E_WRITER_START')
  report['parent_before']=assert_no_database_handles(database)
  report['normal_reader']=run_reader(ns,fixture,database,writer)
  if not report['normal_reader'].get('passed'):raise RuntimeError('E_NORMAL_READER_FAILED')
  writer_command(writer,'INSERT','WRITTEN',2);report['writer_writes_after_reader_exit']=True
  report['race_reader']=run_reader(ns,fixture,database,writer,race=True)
  if not report['race_reader'].get('passed'):raise RuntimeError('E_RACE_READER_FAILED')
  writer_command(writer,'REOPEN_INSERT','WRITTEN',3);report['writer_writes_after_sidecar_race']=True
  report['parent_after']=assert_no_database_handles(database)
  report['parent_namespace_unchanged']=parent_ns==os.readlink('/proc/self/ns/mnt')
  report['parent_mounts_unchanged']=mounts==pathlib.Path('/proc/self/mountinfo').read_bytes()
  if not report['parent_namespace_unchanged'] or not report['parent_mounts_unchanged']:raise RuntimeError('E_PARENT_MOUNTS_CHANGED')
  report['passed']=True
 except Exception as exc:report['error']=type(exc).__name__
 finally:
  if writer.poll() is None:
   try:writer_command(writer,'EXIT','EXITED');writer.wait(timeout=5)
   except Exception:writer.kill();writer.wait(timeout=5)
  writer.stdin.close();writer.stdout.close()
  (fixture/'result.json').write_text(json.dumps(report,sort_keys=True)+'\n');print(json.dumps(report,sort_keys=True))
 return 0 if report['passed'] else 1
if __name__=='__main__':raise SystemExit(main())
