"""Current PM2 worker identity candidate. No standalone production authority.

The internal builder assumes an already-authenticated serialized owner and
exclusive control of the existing daemon; it does not establish either one.
It never sends a stop or changes any process/socket/configuration.
"""
import copy,hashlib,os,re,select,selectors,socket,struct,sys,time,types
from pathlib import Path

WORK=Path(__file__).resolve().parents[2]
LIVE=WORK/'live-drain-provider-61e9/live_drain.py'
PROBE=WORK/'worker-quiescence-plan-61e9/release-window/service-detail-v2/bus_probe.py'
WATCH=WORK/'linux-owner-implementation-61e9/worker-provider/continuous_watch.py'
SLOT=WORK/'worker-stop-bind-61e9/slot_monitor.py'
PINS={LIVE:'3bd540de652eac7dce11d5eba3dcdc61fbebb09a2917d2a0700ac628a7b6ae47',PROBE:'cf2246ace14989c6212b5d63f10c23acc2459928989b9346633de38223f3d32e',WATCH:'31791ed62783a0519e87f3d72f5ab7e93add2ec34d39318007ccadb35650116a',SLOT:'78a470a13641f473eabe8d0307b5ee3e60d5a4862a3613afd3e1fd7c7aa85620'}
CURRENT=Path('/data/web/current-web');RPC='/root/.pm2/rpc.sock'
# The reviewed event parser, stop implementation, and slot monitor currently
# support only these IDs. Values still come from live observation first.
SUPPORTED_IDS=frozenset((18,19))
KEYS=frozenset((b'name',b'MEDIA_QUEUE_WORKER_PROCESS',b'RELEASE_ID',b'DEPLOY_COMMIT_SHA',b'pm_id',b'shutdown_with_message',b'COMMERCE_DATA_DIR'))
class CurrentIdentityError(RuntimeError):pass
def fail(code):raise CurrentIdentityError(code) from None
def load(path,name):
 raw=path.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=PINS[path]:fail('CURRENT_DEPENDENCY_DRIFT')
 module=types.ModuleType(name);module.__file__=str(path);exec(compile(raw,str(path),'exec',dont_inherit=True),module.__dict__);return module
def parse_env(raw):
 out={}
 for item in raw.split(b'\0'):
  key,sep,value=item.partition(b'=')
  if sep and key in KEYS:
   if key in out:fail('CURRENT_ENV_DUPLICATE')
   out[key]=value
 return out
def stat_fields(raw):
 try:
  suffix=raw.rsplit(b')',1)[1].split();state=suffix[0];parent=int(suffix[1]);start=int(suffix[19])
  if state in (b'Z',b'X') or parent<=1 or start<=0:fail('CURRENT_PROCESS_INVALID')
  return parent,start
 except (IndexError,ValueError):fail('CURRENT_STAT_INVALID')
def _data(probe,path,limit):return probe.read(str(path),limit,True)
def _namespaces():return tuple((n,os.stat('/proc/self/ns/'+n).st_dev,os.stat('/proc/self/ns/'+n).st_ino) for n in ('pid','user','mnt','net'))
def scan(probe):
 """Bounded root /proc scan. Returns only two fixed-role workers' identity."""
 current=str(CURRENT.resolve(strict=True));rows=[];scanned=0;budget=16*1024*1024
 for entry in Path('/proc').iterdir():
  if not entry.name.isdigit():continue
  scanned+=1
  if scanned>8192 or budget<=0:fail('CURRENT_PROC_LIMIT')
  try:
   try:exe=os.readlink(entry/'exe')
   except FileNotFoundError:continue
   if not re.search(r'/node(?:-v[0-9.]+)?$',exe):continue
   raw=_data(probe,entry/'environ',262144);budget-=len(raw);env=parse_env(raw);del raw
   if env.get(b'name')!=b'agent-hub-media-worker':continue
   pid=int(entry.name)
   if os.stat(entry).st_uid!=0:fail('CURRENT_WORKER_OWNER')
   parent,start=stat_fields(_data(probe,entry/'stat',8192))
   path=str((entry/'cwd').resolve(strict=True))
   pmid=env.get(b'pm_id',b'');release=env.get(b'RELEASE_ID',b'');commit=env.get(b'DEPLOY_COMMIT_SHA',b'');commerce=env.get(b'COMMERCE_DATA_DIR',b'')
   if (not re.fullmatch(rb'[0-9]{1,8}',pmid) or env.get(b'MEDIA_QUEUE_WORKER_PROCESS')!=b'1' or
       env.get(b'shutdown_with_message') not in (b'true',b'1') or path!=current or
       not re.fullmatch(rb'[A-Za-z0-9][A-Za-z0-9._-]{7,127}',release) or
       not re.fullmatch(rb'[a-f0-9]{40}(?:[a-f0-9]{24})?',commit) or
       not commerce.startswith(b'/data/web/shared/runtime/') or b'..' in commerce.split(b'/')):fail('CURRENT_WORKER_METADATA')
   rows.append((pid,start,int(pmid),parent,path,release,commit,commerce))
   if len(rows)>2:fail('CURRENT_WORKER_COUNT')
  except (FileNotFoundError,ProcessLookupError):fail('CURRENT_SCAN_RACE')
 return tuple(sorted(rows)),current

def validate_pair(rows,current):
 if len(rows)!=2 or len({r[0] for r in rows})!=2 or len({r[2] for r in rows})!=2:fail('CURRENT_WORKER_COUNT')
 if {r[2] for r in rows}!=SUPPORTED_IDS:fail('CURRENT_UNSUPPORTED_SLOT')
 if len({r[3] for r in rows})!=1 or len({r[4] for r in rows})!=1 or any(r[4]!=current for r in rows):fail('CURRENT_PARENT_OR_PATH')
 if len({r[5] for r in rows})!=1 or len({r[6] for r in rows})!=1 or len({r[7] for r in rows})!=1:fail('CURRENT_RELEASE_CONFLICT')

def _pidfd_active(fd):return not select.select([fd],[],[],0)[0]
def _attest(owner,read,slot,pidfds,baseline):
 """Durable baseline plus repeated owner, scan, PIDFD and slot checks.
 Internal dependency interfaces are not authentication proof.
 """
 def check():
  owner.assert_live();rows,current=read();validate_pair(rows,current)
  if rows!=baseline:fail('CURRENT_WORKERS_CHANGED')
  slots=slot()
  if type(slots) is not dict or set(slots)!=SUPPORTED_IDS:fail('CURRENT_SLOT_SET')
  again,again_current=read();validate_pair(again,again_current)
  if again!=baseline:fail('CURRENT_WORKERS_CHANGED')
  for pid,start,pmid,*_ in again:
   row=slots.get(pmid)
   if not row or row['pid']!=pid or row['status']!='online' or not _pidfd_active(pidfds[pid]):fail('CURRENT_SLOT_OR_PIDFD_CHANGED')
  owner.assert_live();return slots
 first=check()
 evidence={'generations':[[r[0],r[1],r[2]] for r in baseline],
           'uniqueIds':{str(k):first[k]['unique_id'] for k in sorted(first)},'releaseReady':False}
 owner.checkpoint('worker-current-baseline',copy.deepcopy(evidence))
 second=check()
 if first!=second:fail('CURRENT_SLOT_CHANGED')
 return evidence

class _CurrentRuntime:
 """Private candidate matching the existing continuous watch runtime surface."""
 def __init__(self,owner):
  if sys.platform!='linux' or os.geteuid()!=0 or not hasattr(os,'pidfd_open'):fail('CURRENT_LINUX_REQUIRED')
  self.owner=owner;self.inner=None;self.monitor=None;self.pidfds={};self.closed=False
  try:
   owner.assert_live();self.probe=load(PROBE,'current_pinned_bus');live=load(LIVE,'current_pinned_live');slot=load(SLOT,'current_pinned_slot');self.probe.source_check()
   self.boot=_data(self.probe,Path('/proc/sys/kernel/random/boot_id'),128).strip();self.namespaces=_namespaces()
   rows,current=scan(self.probe);validate_pair(rows,current)
   for pid,start,pmid,*_ in rows:
    fd=os.pidfd_open(pid,0);self.pidfds[pid]=fd
    if not _pidfd_active(fd) or self.probe.proc_fields(pid)[1]!=start:fail('CURRENT_PIDFD_BINDING')
   daemon=rows[0][3];dstart=self.probe.proc_fields(daemon)[1]
   cmd=_data(self.probe,Path('/proc')/str(daemon)/'cmdline',65536).rstrip(b'\0')
   if os.stat('/proc/'+str(daemon)).st_uid!=0 or cmd!=b'PM2 v7.0.1: God Daemon (/root/.pm2)':fail('CURRENT_DAEMON_INVALID')
   inner=live.LinuxContinuousDrain.__new__(live.LinuxContinuousDrain);self.inner=inner
   inner.probe=self.probe;inner.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);inner.rpc_sock=None;inner.selector=None
   inner.frames=self.probe.Frames();inner.events=self.probe.Events();inner.binding={}
   pub_stamp,pub_inode=inner._listener(self.probe.PUB);inner.rpc_stamp,inner.rpc_inode=inner._listener(RPC)
   inner.binding={'daemon':daemon,'start':dstart,'cmd_sha':hashlib.sha256(cmd).hexdigest(),'socket_stat':pub_stamp,'kernel_inode':pub_inode,
                  'idents':[(r[0],r[1],str(r[2]).encode(),r[4],r[5]) for r in rows],'paths':{os.fsdecode(r[7]) for r in rows},'current':current}
   inner.sock.settimeout(2);inner.sock.connect(self.probe.PUB)
   peer=struct.unpack('3i',inner.sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
   if peer[0]!=daemon or peer[1]!=0:fail('CURRENT_BUS_PEER')
   inner.sock.setblocking(False);inner.selector=selectors.DefaultSelector();inner.selector.register(inner.sock,selectors.EVENT_READ);inner._assert_daemon()
   self.monitor=slot.LinuxMonitorRpc(inner);self.rows=rows;self.current=current;self.baseline=tuple(sorted((r[0],r[1],r[2]) for r in rows))
   evidence=_attest(owner,lambda:scan(self.probe),self.monitor.monitor,self.pidfds,rows)
   self.unique={int(k):v for k,v in evidence['uniqueIds'].items()};owner.assert_live();self.sample()
  except BaseException:
   try:owner.mark_unknown()
   except BaseException:pass
   try:self.close()
   except BaseException:pass
   fail('CURRENT_BASELINE_UNKNOWN')
 def sample(self):
  if self.closed:fail('CURRENT_CLOSED')
  self.owner.assert_live();self.inner._assert_daemon()
  if self.namespaces!=_namespaces() or self.boot!=_data(self.probe,Path('/proc/sys/kernel/random/boot_id'),128).strip():fail('CURRENT_NAMESPACE_CHANGED')
  rows,current=scan(self.probe)
  if current!=self.current or any(row not in self.rows for row in rows):fail('CURRENT_WORKER_CHANGED')
  for pid,start,*_ in rows:
   if not _pidfd_active(self.pidfds[pid]) or self.probe.proc_fields(pid)[1]!=start:fail('CURRENT_PIDFD_CHANGED')
  self.inner._assert_daemon();self.owner.assert_live()
  return tuple(sorted((r[0],r[1],r[2]) for r in rows))
 def receive(self,timeout):self.inner._receive(timeout)
 def counters(self):return {i:dict(self.inner.events.rows[i]) for i in SUPPORTED_IDS}
 def partial(self):return bool(self.inner.frames.buffer or any(self.inner.events.carry.values()))
 def close(self):
  if self.closed:return
  self.closed=True;failed=False
  if self.monitor is not None:
   try:self.monitor.close()
   except BaseException:
    failed=True
    # The monitor may have failed before it closed its own RPC socket.
    sock=getattr(self.monitor,'sock',None)
    if sock is not None:
     try:sock.close()
     except BaseException:failed=True
  # LinuxContinuousDrain.close() stops on its first exception. Close each
  # owned resource separately so a failing selector cannot strand sockets.
  if self.inner is not None:
   for name in ('selector','sock','rpc_sock'):
    resource=getattr(self.inner,name,None)
    if resource is not None:
     try:resource.close()
     except BaseException:failed=True
  for fd in self.pidfds.values():
   try:os.close(fd)
   except BaseException:failed=True
  self.pidfds.clear()
  if failed:fail('CURRENT_CLOSE_UNKNOWN')

class _CurrentSlotMonitor:
 """Same watcher mutex/session; read-only, not exclusion or stop authority."""
 def __init__(self,owner,watch):self.owner=owner;self.watch=watch;self.failed=False
 def slot(self,pmid):
  if self.failed or type(pmid) is not int or pmid not in SUPPORTED_IDS:fail('CURRENT_SLOT_UNAVAILABLE')
  with self.watch._mutex:
   try:
    self.watch._check();self.watch._sample();runtime=self.watch.runtime;slots=runtime.monitor.monitor()
    if {i:slots[i]['unique_id'] for i in SUPPORTED_IDS}!=runtime.unique:fail('CURRENT_SLOT_GENERATION')
    baseline={row[2]:row for row in self.watch.baseline}
    for key,row in slots.items():
     pid,start,_=baseline[key]
     if row['status']=='online':
      if row['pid']!=pid or key in self.watch._observations or not _pidfd_active(runtime.pidfds[pid]) or runtime.probe.proc_fields(pid)[1]!=start:fail('CURRENT_SLOT_CHANGED')
     elif key not in self.watch._intents:fail('CURRENT_UNINTENDED_STOP')
    self.watch._check();self.watch._sample();result=dict(slots[pmid])
    if result['status']=='online':result['start_ticks']=baseline[pmid][1]
    return result
   except BaseException:
    self.failed=True
    try:self.watch._poison('CURRENT_SLOT_UNKNOWN',asynchronous=True)
    except BaseException:pass
    fail('CURRENT_SLOT_UNKNOWN')

def _open_owned_current_watch(owner,watch_module):
 """Internal only. Supplying fake modules/owners does not grant authority."""
 if hashlib.sha256(WATCH.read_bytes()).hexdigest()!=PINS[WATCH] or Path(getattr(watch_module,'__file__','')).resolve()!=WATCH.resolve():fail('CURRENT_WATCH_SOURCE')
 if type(owner) is not watch_module.SerializedOwner:fail('CURRENT_SERIALIZED_OWNER_REQUIRED')
 runtime=_CurrentRuntime(owner)
 try:
  watch=watch_module._ContinuousWatch(owner,runtime)
  return watch,_CurrentSlotMonitor(owner,watch)
 except BaseException:
  try:runtime.close()
  except BaseException:pass
  try:owner.mark_unknown()
  except BaseException:pass
  fail('CURRENT_WATCH_UNKNOWN')

def open_production_current_watch(*_args,**_kwargs):fail('CURRENT_AUTHENTICATED_OWNER_AND_EXCLUSIVITY_NOT_CONNECTED')
if __name__=='__main__':raise SystemExit('DISABLED')
