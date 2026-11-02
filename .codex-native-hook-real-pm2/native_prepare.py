"""One-shot standard hook prepare with independently observed old worker drain.
Requires the already constructed fixed root lease; no standalone CLI or retries.
"""
import hashlib,json,os,re,select,subprocess,time
from pathlib import Path

IDS=(18,19)
class NativePrepareError(RuntimeError): pass
def fail(code): raise NativePrepareError(code) from None
def _sha(b):return hashlib.sha256(b).hexdigest()
def _read_state(ctx):
 p=Path(ctx.transaction_root)/'media-worker-state.json'
 fd=os.open(str(p),os.O_RDONLY|os.O_NOFOLLOW)
 try:
  a=os.fstat(fd);b=os.lstat(p);data=os.read(fd,262145);c=os.fstat(fd)
  if len(data)>262144 or a.st_uid!=0 or a.st_gid!=0 or a.st_nlink!=1 or a.st_mode&0o777!=0o600 or (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)!=(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns) or (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)!=(c.st_dev,c.st_ino,c.st_size,c.st_mtime_ns,c.st_ctime_ns):fail('NATIVE_STATE_INVALID')
 finally:os.close(fd)
 try: state=json.loads(data)
 except BaseException:fail('NATIVE_STATE_INVALID')
 return str(p),data,state

def _activity(ctx,pmid,phase):
 a=time.monotonic_ns();value=ctx.activities[pmid].activity('%s-stop-%d'%(phase,pmid));b=time.monotonic_ns()
 exact=ctx.prestop.exact;keys={'sessionId','bindingSha256','phase','observedAtNs','counts','evidenceSha256'}
 if (type(value) is not dict or set(value)!=keys or value['sessionId']!=ctx.session_id or value['bindingSha256']!=ctx.watch.binding_sha256 or value['phase']!='%s-stop-%d'%(phase,pmid) or type(value['observedAtNs']) is not int or not a<=value['observedAtNs']<=b or b-a>5_000_000_000 or type(value['counts']) is not dict or set(value['counts'])!=exact.ZERO_KEYS|exact.HISTORY_KEYS or any(type(v) is not int or v<0 for v in value['counts'].values()) or any(value['counts'][k]!=0 for k in exact.ZERO_KEYS) or not re.fullmatch(r'[a-f0-9]{64}',value['evidenceSha256'] or '')):fail('NATIVE_ACTIVITY_INVALID')
 ctx.owner.assert_live();return value['evidenceSha256']

def _baseline_entries(ctx):
 entries=ctx.prestop._entries(ctx);expected={row[2]:(row[0],row[1]) for row in ctx.watch.baseline};found={};limits={}
 for e in entries:
  i=e.get('pm_id');env=e.get('pm2_env')
  if type(i) is not int or i not in expected or i in found or type(env) is not dict or env.get('pm_id')!=i or e.get('pid')!=expected[i][0] or env.get('status')!='online' or env.get('unique_id')!=ctx.watch.runtime.unique[i]:fail('NATIVE_BASELINE_INVALID')
  timeout=env.get('kill_timeout')
  if env.get('shutdown_with_message') not in (True,'true',1,'1'):fail('NATIVE_SHUTDOWN_MODE_INVALID')
  if type(timeout) is not int or not 1<=timeout<=120000:fail('NATIVE_KILL_TIMEOUT_INVALID')
  limits[i]=timeout/1000;found[i]=True
 if set(found)!=set(IDS):fail('NATIVE_BASELINE_INVALID')
 return limits

def native_prepare_once(lease):
 if lease.used:fail('NATIVE_REPLAY_FORBIDDEN')
 lease.used=True;ctx=lease.ctx;watch=lease.watch;owner=lease.owner;child=None
 try:
  if ctx.owner is not owner or watch.owner is not owner or any(ctx.activities[i].owner is not owner for i in IDS):fail('NATIVE_OWNER_INVALID')
  owner.assert_live();ctx.assert_exclusive();watch.assert_continuity();parent=ctx.prestop.trusted_parent(ctx)
  ctx.prestop.write_new(str(parent/(ctx.transaction_id+'.prestop-attempt')),ctx.prestop.canon({'transactionId':ctx.transaction_id,'phase':'attempted'}))
  previous=ctx.prestop.snapshot(ctx);before={i:_activity(ctx,i,'before') for i in IDS};limits=_baseline_entries(ctx)
  for role in ('node','hook','pm2','config','ss'):
   if owner.verify_file(getattr(ctx,role),getattr(ctx,role+'_sha256')) is not True:fail('NATIVE_FILE_UNVERIFIED')
  with watch._mutex:
   watch._check();watch._sample()
   # Consume already queued bus frames before taking the counters/intents.
   for _ in range(256):
    if not watch.runtime.inner.selector.select(0):break
    watch.runtime.receive(0)
   else:fail('NATIVE_BUS_BACKLOG')
   if watch.runtime.partial():fail('NATIVE_BUS_PARTIAL')
   for i in IDS:watch.record_stop_intent(i)
   stamps={};exits={};original_receive=watch.runtime.receive;original_sample=watch.runtime.sample;start_box=[None]
   def receive(timeout):
    old=watch.runtime.counters();original_receive(timeout);now=time.monotonic();new=watch.runtime.counters()
    for i in IDS:
     if new[i]['drained_true']!=old[i]['drained_true']:
      if i in stamps:fail('NATIVE_DUPLICATE_DRAIN')
      stamps[i]=now
   watch.runtime.receive=receive
   def sample():
    rows=original_sample();now=time.monotonic()
    for pid,_,i in watch.baseline:
     if i not in exits and not any(row[2]==i for row in rows) and select.select([watch.runtime.pidfds[pid]],[],[],0)[0]:exits[i]=now
    return rows
   watch.runtime.sample=sample
  owner.checkpoint('worker-native-hook-intent',{'transactionId':ctx.transaction_id,'bindingSha256':watch.binding_sha256,'releaseReady':False})
  for i in IDS:ctx.activities[i].assert_activity_live(time.monotonic()+5)
  owner.assert_live();watch.assert_continuity()
  if _baseline_entries(ctx)!=limits:fail('NATIVE_KILL_TIMEOUT_CHANGED')
  env={'PATH':'/usr/local/bin:/usr/bin:/bin','LC_ALL':'C','HOME':'/root','PM2_HOME':'/root/.pm2','DIRECT_HOOK_SERVICE':'web','DIRECT_HOOK_RELEASE_ROOT':'/data/web','DIRECT_HOOK_PM2_CONFIG_PATH':ctx.config,'DIRECT_HOOK_PM2_CONFIG_SHA256':ctx.config_sha256}
  start_box[0]=time.monotonic();child=subprocess.Popen([ctx.node,ctx.hook,'prepare',ctx.transaction_root],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,close_fds=True,pass_fds=(9,))
  try:out,_=child.communicate(timeout=90)
  except subprocess.TimeoutExpired:child.kill();child.communicate(timeout=3);fail('NATIVE_HOOK_TIMEOUT')
  if child.returncode!=0 or len(out)>8192:fail('NATIVE_HOOK_FAILED')
  try: reply=json.loads(out)
  except BaseException:fail('NATIVE_HOOK_REPLY_INVALID')
  if reply!={'ok':True,'phase':'prepare','releaseId':previous['releaseId'],'ports':[5102,5103]}:fail('NATIVE_HOOK_REPLY_INVALID')
  owner.assert_live();watch.assert_continuity()
  with watch._mutex:
   watch._check();watch._sample()
   if watch.runtime.partial():fail('NATIVE_BUS_PARTIAL')
   counts=watch.runtime.counters()
   for i in IDS:
    old=watch._intents[i]['counters'];row=counts[i]
    if row['drained_true']!=old['drained_true']+1 or row['drained_false']!=old['drained_false'] or row['invalid_stop_marker']!=old['invalid_stop_marker'] or i not in stamps or not start_box[0]<=stamps[i]<start_box[0]+limits[i] or i not in exits or not start_box[0]<=exits[i]<start_box[0]+limits[i]:fail('NATIVE_DRAIN_UNPROVEN')
    pid=next(row[0] for row in watch.baseline if row[2]==i)
    if not select.select([watch.runtime.pidfds[pid]],[],[],0)[0]:fail('NATIVE_PID_STILL_ALIVE')
  for i in IDS:watch.observe_stopped_generation(i)
  if ctx.prestop._entries(ctx):fail('NATIVE_SLOT_REMAINS')
  for port in (5102,5103):
   p=subprocess.run([ctx.ss,'-H','-ltnp','sport = :%d'%port],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,check=False,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},pass_fds=(9,))
   if p.returncode!=0 or p.stdout.strip():fail('NATIVE_PORT_NOT_EMPTY')
  after={i:_activity(ctx,i,'after') for i in IDS}
  path,raw,state=_read_state(ctx)
  if type(state) is not dict or set(state)!={'schemaVersion','workerName','preparedAt','configPath','configSha256','previous','status'} or state['schemaVersion']!='zimeiti-media-worker-transaction.v1' or state['workerName']!='agent-hub-media-worker' or state['status']!='prepared' or state['configPath']!=ctx.config or state['configSha256']!=ctx.config_sha256 or state['previous']!=previous or type(state['preparedAt']) is not str:fail('NATIVE_PREPARED_MISMATCH')
  ctx.prestop._verify_prepared(path,raw);owner.assert_live();watch.assert_continuity()
  evidence={'transactionId':ctx.transaction_id,'bindingSha256':watch.binding_sha256,'stateSha256':_sha(raw),'before':before,'after':after,'drainIdentityProven':False,'detachedWorkProvenAbsent':False}
  ev=_sha(ctx.prestop.canon(evidence));owner.checkpoint('worker-prestop-observed',{'transactionId':ctx.transaction_id,'evidenceSha256':ev,'stateSha256':_sha(raw),'releaseReady':False})
  owner.assert_live();watch.assert_continuity();ctx.prestop._verify_prepared(path,raw)
  lease.result={'outcome':'PRESTOP_READY','evidenceSha256':ev,'stateSha256':_sha(raw),'configSha256':ctx.config_sha256,'drainIdentityProven':False,'detachedWorkProvenAbsent':False,'releaseReady':True,'maintenanceMustRemain':True,'automaticRetry':False}
  return lease.result
 except BaseException:
  try:owner.mark_unknown()
  except BaseException:pass
  if child is not None and child.poll() is None:
   try:child.kill();child.wait(timeout=3)
   except BaseException:pass
  lease.result={'outcome':'UNKNOWN','releaseReady':False,'maintenanceMustRemain':True,'automaticRetry':False};return lease.result
