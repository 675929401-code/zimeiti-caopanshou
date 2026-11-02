import fcntl,hashlib,importlib.util,json,os,select,selectors,socket,struct,subprocess,sys,time
from pathlib import Path
from types import SimpleNamespace
ROOT=Path('/tmp/native-hook-fixture');HOME=ROOT/'pm2';NODE=os.environ['FIXTURE_NODE'];SOURCE=Path(os.environ['FIXTURE_SOURCE']);MODE=os.environ['FIXTURE_MODE']
if sys.platform!='linux' or os.geteuid()!=0 or os.environ.get('FIXTURE_ISOLATED')!='1' or MODE not in ('success','missing-drain','timeout'):raise SystemExit('FIXTURE_REFUSED')
stage=ROOT/'closure'/'linux-owner-implementation-61e9'/'worker-provider';sys.path.insert(0,str(stage));sys.path.insert(0,str(ROOT/'closure'/'worker-stop-bind-61e9'))
import continuous_watch as w,exact_stop as ex,slot_monitor as sm
probe=w.load_parser();sm.RPC_PATH=str(HOME/'rpc.sock')
spec=importlib.util.spec_from_file_location('native_fixture',SOURCE/'fixture-native-prepare.py');native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
ENV={'PATH':str(ROOT/'bin')+':/usr/bin:/bin','HOME':str(ROOT),'PM2_HOME':str(HOME),'LC_ALL':'C'}
class Owner:
 def __init__(self):self.unknown=False;self.phases=[];self.fd=os.open(ROOT/'journal.jsonl',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 def assert_live(self):
  if self.unknown:raise RuntimeError('FIXTURE_OWNER_LOST')
 def checkpoint(self,phase,details):
  self.assert_live();self.phases.append(phase);os.write(self.fd,(json.dumps({'phase':phase})+'\n').encode());os.fsync(self.fd)
 def mark_unknown(self):self.unknown=True
 def verify_file(self,*_):self.assert_live();return True
 def close(self):os.close(self.fd)
class Inner:
 def __init__(self):
  self.probe=probe;self.binding={'daemon':int((HOME/'pm2.pid').read_text())};self.start=ex._start(self.binding['daemon']);self.pidfd=os.pidfd_open(self.binding['daemon'],0);self.identity={str(HOME/n):(os.lstat(HOME/n).st_dev,os.lstat(HOME/n).st_ino) for n in ('pub.sock','rpc.sock')}
 def _assert_daemon(self):
  if select.select([self.pidfd],[],[],0)[0] or ex._start(self.binding['daemon'])!=self.start:raise RuntimeError('FIXTURE_DAEMON_LOST')
  for name,identity in self.identity.items():
   s=os.lstat(name)
   if (s.st_dev,s.st_ino)!=identity:raise RuntimeError('FIXTURE_SOCKET_CHANGED')
 def close(self):os.close(self.pidfd)
class Runtime:
 def __init__(self):
  self.inner=Inner();self.frames=probe.Frames();self.events=probe.Events();self.reader=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.reader.settimeout(5);self.reader.connect(str(HOME/'pub.sock'))
  peer=struct.unpack('3i',self.reader.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if peer[0]!=self.inner.binding['daemon'] or peer[1]!=0:raise RuntimeError('FIXTURE_PUB_PEER')
  self.reader.setblocking(False);self.selector=selectors.DefaultSelector();self.selector.register(self.reader,selectors.EVENT_READ);self.inner.selector=self.selector;self.monitor=sm.LinuxMonitorRpc(self.inner);slots=self.monitor.monitor();self.baseline=tuple(sorted((r['pid'],ex._start(r['pid']),i) for i,r in slots.items()));self.unique={i:r['unique_id'] for i,r in slots.items()};self.pidfds={r[0]:os.pidfd_open(r[0],0) for r in self.baseline}
 def sample(self):
  self.inner._assert_daemon();rows=[]
  for pid,start,pmid in self.baseline:
   try:
    if ex._start(pid)!=start:raise RuntimeError('FIXTURE_PID_CHANGED')
    rows.append((pid,start,pmid))
   except (FileNotFoundError,ProcessLookupError):pass
   except ex.StopError as e:
    if str(e)!='STOP_ORIGINAL_ALREADY_EXITED':raise
  return tuple(rows)
 def receive(self,timeout):
  for _,_ in self.selector.select(timeout):
   try:data=self.reader.recv(65536)
   except BlockingIOError:continue
   if not data:raise RuntimeError('FIXTURE_PUB_CLOSED')
   for parts in self.frames.feed(data):self.events.accept(parts)
 def counters(self):return {i:dict(self.events.rows[i]) for i in (18,19)}
 def partial(self):return bool(self.frames.buffer or any(self.events.carry.values()))
 def close(self):
  self.monitor.close();self.selector.close();self.reader.close();self.inner.close()
  for fd in self.pidfds.values():os.close(fd)
class Activity:
 def __init__(self,owner,watch,session):self.owner=owner;self.watch=watch;self.session=session
 def assert_activity_live(self,_):self.owner.assert_live()
 def activity(self,phase):return {'sessionId':self.session,'bindingSha256':self.watch.binding_sha256,'phase':phase,'observedAtNs':time.monotonic_ns(),'counts':{k:0 for k in ex.ZERO_KEYS|ex.HISTORY_KEYS},'evidenceSha256':'a'*64}
class Prestop:
 exact=ex
 def trusted_parent(self,ctx):return ROOT/'transactions'
 def write_new(self,path,data):
  fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
  try:os.write(fd,data);os.fsync(fd)
  finally:os.close(fd)
 def canon(self,v):return (json.dumps(v,sort_keys=True,separators=(',',':'))+'\n').encode()
 def snapshot(self,ctx):return json.loads(subprocess.check_output([NODE,str(SOURCE/'snapshot.mjs')],env=ENV,timeout=15))
 def _entries(self,ctx):
  rows=json.loads(subprocess.check_output([str(ROOT/'bin'/'pm2'),'jlist'],env=ENV,timeout=15));return [r for r in rows if r.get('name')=='agent-hub-media-worker']
 def _verify_prepared(self,path,raw):
  if Path(path).read_bytes()!=raw:raise RuntimeError('FIXTURE_STATE_CHANGED')
lock=os.open(ROOT/'web'/'.deploy.lock',os.O_CREAT|os.O_RDWR,0o600);os.dup2(lock,9);os.close(lock);fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
owner=Owner();serial=w.SerializedOwner(owner);runtime=Runtime();watch=w._ContinuousWatch(serial,runtime,sample_interval=.05,max_seconds=180)
try:
 tx='candidate-fixture-r60-aaaaaaaaaaaa';config=ROOT/'ecosystem.config.js';sha=hashlib.sha256(config.read_bytes()).hexdigest()
 ctx=SimpleNamespace(owner=serial,watch=watch,transaction_id=tx,transaction_root=str(ROOT/'transactions'/tx),session_id=tx,assert_exclusive=serial.assert_live,prestop=Prestop(),node=NODE,hook=str(SOURCE/'fixture-hook.mjs'),pm2=str(ROOT/'bin'/'pm2'),config=str(config),ss='/usr/bin/ss',node_sha256='a'*64,hook_sha256='a'*64,pm2_sha256='a'*64,config_sha256=sha,ss_sha256='a'*64)
 ctx.activities={i:Activity(serial,watch,tx) for i in (18,19)};lease=SimpleNamespace(used=False,ctx=ctx,owner=serial,watch=watch)
 result=native.native_prepare_once(lease);statepath=Path(ctx.transaction_root)/'media-worker-state.json';state=json.loads(statepath.read_bytes()) if statepath.exists() else {};rows=ctx.prestop._entries(ctx);counts=watch.runtime.counters();expected='PRESTOP_READY' if MODE=='success' else 'UNKNOWN'
 print(json.dumps({'mode':MODE,'outcome':result['outcome'],'prepared':state.get('status')=='prepared','workerSlotsRemaining':len(rows),'drained18':counts[18]['drained_true'],'drained19':counts[19]['drained_true'],'unknown':owner.unknown,'databaseCalls':0,'controllerCalls':0},sort_keys=True),flush=True)
 if result['outcome']!=expected:raise RuntimeError('FIXTURE_RESULT_MISMATCH')
 if MODE=='success' and (state.get('status')!='prepared' or rows or counts[18]['drained_true']!=1 or counts[19]['drained_true']!=1):raise RuntimeError('FIXTURE_PREPARE_INVALID')
 if MODE!='success' and not owner.unknown:raise RuntimeError('FIXTURE_UNKNOWN_INVALID')
finally:
 try:watch.close()
 except BaseException:pass
 owner.close();os.close(9)
