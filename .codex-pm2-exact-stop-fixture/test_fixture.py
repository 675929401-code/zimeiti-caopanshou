"""Real PM2 daemon/RPC/PUB, real Linux pidfd + production one-shot stop.
Only activity data and owner are fixture controlled. No production inputs.
"""
import contextlib,json,os,select,selectors,signal,socket,struct,subprocess,sys,time,traceback
from pathlib import Path
from types import SimpleNamespace
HOME=Path(os.environ['PM2_HOME']);ROOT=Path(os.environ['FIXTURE_ROOT']);NODE=os.environ['FIXTURE_NODE'];PM2=os.environ['FIXTURE_PM2']
if not (str(HOME).startswith('/tmp/pm2-exact-stop-repro-') and str(ROOT).startswith('/tmp/pm2-exact-stop-repro-') and sys.platform=='linux' and os.geteuid()==0 and os.environ.get('FIXTURE_ISOLATED')=='1'):raise SystemExit('FIXTURE_REFUSED')
STAGE=ROOT/'closure'/'linux-owner-implementation-61e9'/'worker-provider';sys.path.insert(0,str(STAGE));sys.path.insert(0,str(ROOT/'closure'/'worker-stop-bind-61e9'))
import continuous_watch as w,exact_stop as ex,slot_monitor as sm
probe=w.load_parser();sm.RPC_PATH=str(HOME/'rpc.sock')
original_parse_slots=sm.parse_slots
def inspect_slots(items):
 try:
  slots=original_parse_slots(items)
 except sm.SlotError:
  shape=[]
  if type(items) is list:
   for x in items:
    if type(x) is dict and x.get('name')=='agent-hub-media-worker':
     e=x.get('pm2_env') if type(x.get('pm2_env')) is dict else {}
     u=e.get('unique_id')
     shape.append({'pmId':x.get('pm_id') if type(x.get('pm_id')) is int else None,'envPmId':e.get('pm_id') if type(e.get('pm_id')) is int else None,'pidPositive':type(x.get('pid')) is int and x['pid']>1,'uniqueString':type(u) is str,'uniqueFormat':type(u) is str and bool(sm.re.fullmatch(r'[A-Za-z0-9_-]{1,128}',u)),'status':e.get('status') if e.get('status') in ('online','stopped') else 'other'})
  print(json.dumps({'slotShape':shape},sort_keys=True),flush=True)
  raise
 print(json.dumps({'slotsOnline':sorted(i for i,x in slots.items() if x['status']=='online')},sort_keys=True),flush=True)
 return slots
sm.parse_slots=inspect_slots
class Owner:
 def __init__(self):self.unknown=False;self.events=[];self.fd=os.open(ROOT/'journal.jsonl',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_APPEND,0o600)
 def assert_live(self):
  if self.unknown:raise RuntimeError('FIXTURE_OWNER_LOST')
 def checkpoint(self,phase,details):
  self.assert_live();self.events.append(phase);raw=(json.dumps({'phase':phase},separators=(',',':'))+'\n').encode();os.write(self.fd,raw);os.fsync(self.fd)
  if phase=='worker-exact-stop-observed' and os.environ.get('FIXTURE_DELAY')=='1':time.sleep(5.3)
 def mark_unknown(self):self.unknown=True
 def close(self):os.close(self.fd)
class Inner:
 def __init__(self):
  self.probe=probe;self.binding={'daemon':int((HOME/'pm2.pid').read_text().strip())};self.start=ex._start(self.binding['daemon']);self.pidfd=os.pidfd_open(self.binding['daemon'],0)
  self.identity={str(HOME/name):(os.lstat(HOME/name).st_dev,os.lstat(HOME/name).st_ino) for name in ('pub.sock','rpc.sock')}
 def _assert_daemon(self):
  if select.select([self.pidfd],[],[],0)[0] or ex._start(self.binding['daemon'])!=self.start:raise RuntimeError('FIXTURE_DAEMON_LOST')
  for name,identity in self.identity.items():
   s=os.lstat(name)
   if (s.st_dev,s.st_ino)!=identity:raise RuntimeError('FIXTURE_SOCKET_DRIFT')
 def close(self):os.close(self.pidfd)
class Runtime:
 def __init__(self):
  self.inner=Inner();self.boot=ex._boot();self.frames=probe.Frames();self.events=probe.Events();self.inner.frames=self.frames;self.reader=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.reader.settimeout(5);self.reader.connect(str(HOME/'pub.sock'))
  peer=struct.unpack('3i',self.reader.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if peer[0]!=self.inner.binding['daemon'] or peer[1]!=0:raise RuntimeError('FIXTURE_PUB_PEER')
  self.reader.setblocking(False);self.selector=selectors.DefaultSelector();self.selector.register(self.reader,selectors.EVENT_READ);self.monitor=sm.LinuxMonitorRpc(self.inner);slots=self.monitor.monitor()
  self.baseline=tuple(sorted((x['pid'],ex._start(x['pid']),i) for i,x in slots.items()));self.unique={i:x['unique_id'] for i,x in slots.items()}
  if {x[2] for x in self.baseline}!={18,19}:raise RuntimeError('FIXTURE_SLOT_IDS')
 def sample(self):
  self.inner._assert_daemon();rows=[]
  for pid,start,pmid in self.baseline:
   try:
    if ex._start(pid)!=start:raise RuntimeError('FIXTURE_PID_REUSED')
    rows.append((pid,start,pmid))
   except (FileNotFoundError,ProcessLookupError):pass
   except ex.StopError as e:
    if str(e)!='STOP_ORIGINAL_ALREADY_EXITED':raise
  return tuple(rows)
 def receive(self,timeout):
  for _,_ in self.selector.select(timeout):
   try:data=self.reader.recv(65536)
   except BlockingIOError:continue
   if not data:raise RuntimeError('FIXTURE_PUB_DISCONNECTED')
   for parts in self.frames.feed(data):self.events.accept(parts)
 def counters(self):return {i:dict(self.events.rows[i]) for i in (18,19)}
 def partial(self):return bool(self.frames.buffer or any(self.events.carry.values()))
 def close(self):self.monitor.close();self.selector.close();self.reader.close();self.inner.close()
class Cap:
 def __init__(self,owner,watch,runtime):self.owner,self.watch,self.runtime,self.session_id=owner,watch,runtime,'fixture-session'
 def assert_exclusive(self):self.owner.assert_live()
 def slot(self,pmid):
  row=self.runtime.monitor.monitor()[pmid]
  if row['status']=='online':row['start_ticks']=ex._start(row['pid'])
  return row
 def activity(self,phase):
  return {'sessionId':self.session_id,'bindingSha256':self.watch.binding_sha256,'phase':phase,'observedAtNs':time.monotonic_ns(),'counts':{k:0 for k in ex.ZERO_KEYS|ex.HISTORY_KEYS},'evidenceSha256':'a'*64}
 def assert_activity_live(self,_):self.owner.assert_live()
 def open_pidfd(self,pid,start):return ex.LinuxPidfd(pid,start,self.runtime.boot)
 def open_rpc(self,pmid,unique):
  self.runtime.inner._assert_daemon();s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(5);s.connect(str(HOME/'rpc.sock'));peer=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if peer[0]!=self.runtime.inner.binding['daemon'] or peer[1]!=0:s.close();raise RuntimeError('FIXTURE_RPC_PEER')
  return ex._SocketRpc(s,self.runtime.inner._assert_daemon,pmid,unique)
trace=[]
def tracer(frame,event,arg):
 if event=='exception':
  _,value,_=arg;code=str(value)
  if code in ('WATCH_SAMPLE_GAP','STOP_DEADLINE_UNKNOWN','STOP_FINAL_RPC_INCOMPLETE','STOP_RPC_TRAILING_REPLY','WATCH_UNAVAILABLE','STOP_OUTCOME_UNKNOWN_NO_RETRY') and (not trace or trace[-1]!=code):trace.append(code)
 return tracer
owner=Owner();serial=w.SerializedOwner(owner);runtime=Runtime();watch=None
try:
 watch=w._ContinuousWatch(serial,runtime,sample_interval=.05,max_seconds=90,max_stale_seconds=5);cap=Cap(serial,watch,runtime);stop=ex._ExactStop(watch,cap,timeout=60)
 sys.settrace(tracer)
 try:proof=stop.stop_once(18);outcome='PROOF_RETURNED'
 except Exception:outcome='UNKNOWN'
 finally:sys.settrace(None)
 print(json.dumps({'mode':'delayed' if os.environ.get('FIXTURE_DELAY')=='1' else 'normal','outcome':outcome,'postProofRecorded':'worker-exact-stop-observed' in owner.events,'trace':trace,'drained':runtime.counters()[18]['drained_true']},sort_keys=True))
 if 'worker-exact-stop-observed' not in owner.events:raise RuntimeError('FIXTURE_DID_NOT_REACH_POSTPROOF')
 if os.environ.get('FIXTURE_DELAY')=='1' and (outcome!='UNKNOWN' or 'WATCH_SAMPLE_GAP' not in trace):raise RuntimeError('FIXTURE_EXPECTED_STALE_GUARD')
 if os.environ.get('FIXTURE_DELAY')!='1' and outcome!='PROOF_RETURNED':raise RuntimeError('FIXTURE_UNEXPECTED_NORMAL_UNKNOWN')
finally:
 if watch:
  try:watch.close()
  except Exception:pass
 else:runtime.close()
 owner.close()
