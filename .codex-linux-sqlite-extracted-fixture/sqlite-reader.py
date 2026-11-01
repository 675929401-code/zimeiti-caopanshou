"""SQLite-only extraction. No production release authority."""
import ctypes,errno,hashlib,json,os,re,select,signal,stat,sys,time
from pathlib import Path
SOURCE=b"# SQLite-only runtime, extracted from the pinned observation.\nimport json,os,stat\nfrom pathlib import Path\n\nclass ProbeError(Exception):pass\n\ndef fail(code):raise ProbeError(code)\n\ndef trusted(path,directory=False):\n    path=Path(path);cursor=Path(path.anchor)\n    for part in path.parts[1:]:\n        cursor/=part;info=os.lstat(cursor)\n        if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:fail('E_TRUST')\n    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):fail('E_TRUST')\n    return info\n\nGROUPS='ordinary_jobs media_edits frames depth hot_remix voice voice_replace rolling_jobs'.split()\n\nMETRICS='total unfinished active_states unknown_states candidates_before_batch_limits candidates_without_live_record_lease'.split()\n\ndef exact(v,ks):\n if type(v) is not dict or set(v)!=set(ks):raise ValueError('E_SCHEMA')\n\ndef counts(v,ks):\n exact(v,ks)\n if any(type(x) is not int or not 0<=x<=9007199254740991 for x in v.values()):raise ValueError('E_SCHEMA')\n\ndef fixed(v,k,b):\n if type(v[k]) is not bool or v[k] is not b:raise ValueError('E_SCHEMA')\n\ndef sqlite_schema(v):\n exact(v,'read_only groups leases maintenance_coverage_complete claimability_guaranteed atomic_quiescence_proven'.split());fixed(v,'read_only',True)\n for k in ['maintenance_coverage_complete','claimability_guaranteed','atomic_quiescence_proven']:fixed(v,k,False)\n exact(v['groups'],GROUPS)\n for row in v['groups'].values():\n  counts(row,METRICS)\n  if row['candidates_without_live_record_lease']>row['candidates_before_batch_limits'] or row['candidates_before_batch_limits']>row['total']:raise ValueError('E_SCHEMA')\n counts(v['leases'],'ordinary_active rolling_active ordinary_expired rolling_expired maintenance_pending_not_measured'.split())\n if v['leases']['maintenance_pending_not_measured']!=1:raise ValueError('E_SCHEMA')\n return v\n\ndef no_duplicates(pairs):\n v={}\n for k,x in pairs:\n  if k in v:raise ValueError('E_SCHEMA')\n  v[k]=x\n return v\n\ndef load_json(raw):return json.loads(raw,object_pairs_hook=no_duplicates)\n"
SOURCE_SHA='788e5f76e65f1999b9c12cb35796178e764a300dd821de784c0d379bb1bebe4b'

COMMERCE_SQL = r'''
WITH clock AS (SELECT :now_ms AS now), candidates(kind,id,owner,status,updated,lease_key) AS (
 SELECT 'ordinary_jobs',r.id,r.owner,json_extract(r.value,'$.status'),r.updated,'job:'||r.id
 FROM records r,clock WHERE r.bucket='jobs' AND json_extract(r.value,'$.input.rollingPlan') IS NULL
 AND ((coalesce(json_extract(r.value,'$.input.rollingChild'),0)=0 AND
  (json_extract(r.value,'$.status')='queued' OR (json_extract(r.value,'$.status') IN ('running','processing','unknown','saving') AND r.updated<=clock.now-5000)
   OR (json_extract(r.value,'$.status') IN ('succeeded','failed') AND EXISTS(SELECT 1 FROM records billing WHERE billing.bucket='billing' AND billing.id=r.id AND billing.owner=r.owner AND json_extract(billing.value,'$.status') IN ('charge_pending','refund_pending','revenue_pending','reconciliation_required')))))
  OR (coalesce(json_extract(r.value,'$.input.rollingChild'),0)=1 AND json_extract(r.value,'$.status')='saving' AND r.updated<=clock.now-5000))
 UNION ALL SELECT 'media_edits',id,owner,json_extract(value,'$.status'),updated,'media-edit:'||id FROM records,clock WHERE bucket='media-edits' AND (json_extract(value,'$.status')='queued' OR (json_extract(value,'$.status')='running' AND updated<=clock.now-600000))
 UNION ALL SELECT 'frames',id,owner,json_extract(value,'$.status'),updated,'frame-extraction:'||id FROM records WHERE bucket='frame-extractions' AND json_extract(value,'$.status')='queued'
 UNION ALL SELECT 'depth',id,owner,json_extract(value,'$.preparation.status'),updated,'depth-preparation:'||id||':'||json_extract(value,'$.preparation.id') FROM records,clock WHERE bucket='depth-video-clones' AND coalesce(json_extract(value,'$.preparation.id'),'')<>'' AND (json_extract(value,'$.preparation.status')='queued' OR (json_extract(value,'$.preparation.status')='running' AND coalesce(json_extract(value,'$.preparation.leaseUntil'),0)<=clock.now))
 UNION ALL SELECT 'hot_remix',id,owner,json_extract(value,'$.status'),updated,'hot-video-remix:'||id FROM records,clock WHERE bucket='hot-video-remix-jobs' AND (json_extract(value,'$.status')='queued' OR (json_extract(value,'$.status')='running' AND updated<=clock.now-600000))
 UNION ALL SELECT 'voice',id,owner,json_extract(value,'$.status'),updated,'voice-synthesis:'||id FROM records,clock WHERE bucket='voice-jobs' AND ((json_extract(value,'$.status')='queued' AND json_extract(value,'$.billingState')='charged') OR (json_extract(value,'$.status') IN ('running','saving') AND json_extract(value,'$.billingState')='charged' AND updated<=clock.now-600000) OR (json_extract(value,'$.status')='succeeded' AND json_extract(value,'$.billingState') IN ('charged','revenue_pending')) OR (json_extract(value,'$.status')='failed' AND json_extract(value,'$.billingState') IN ('charged','refund_pending','reconciliation_required')))
 UNION ALL SELECT 'voice_replace',id,owner,json_extract(value,'$.status'),updated,'voice-replacement:'||id FROM records,clock WHERE bucket='voice-replace-jobs' AND (json_extract(value,'$.status')='queued' OR (json_extract(value,'$.status')='running' AND updated<=clock.now-600000))
 UNION ALL SELECT 'rolling_jobs',id,owner,json_extract(value,'$.status'),updated,id FROM records,clock WHERE bucket='jobs' AND json_extract(value,'$.input.rollingPlan') IS NOT NULL AND coalesce(json_extract(value,'$.input.rollingChild'),0)=0
 AND (json_extract(value,'$.status') IN ('queued','running','processing','unknown','saving') OR (json_extract(value,'$.status')='save_failed' AND coalesce(json_extract(value,'$.rollingState.restitchAttempts'),0)<3 AND coalesce(json_extract(value,'$.rollingState.restitchRetryAt'),0)<=clock.now) OR (json_extract(value,'$.status')='succeeded' AND json_extract(value,'$.rollingState.temporaryAssetsCleanupStatus') IN ('pending','failed') AND coalesce(json_extract(value,'$.rollingState.temporaryAssetsCleanupRetryAt'),0)<=clock.now))
), metrics(kind,total,unfinished,active_states,unknown_states,candidates_before_batch_limits,candidates_without_live_record_lease) AS (
 SELECT kinds.kind,
 (SELECT count(*) FROM records r WHERE r.bucket=kinds.bucket AND (kinds.kind<>'ordinary_jobs' OR json_extract(r.value,'$.input.rollingPlan') IS NULL) AND (kinds.kind<>'rolling_jobs' OR (json_extract(r.value,'$.input.rollingPlan') IS NOT NULL AND coalesce(json_extract(r.value,'$.input.rollingChild'),0)=0))),
 (SELECT count(*) FROM records r WHERE r.bucket=kinds.bucket AND (kinds.kind<>'ordinary_jobs' OR json_extract(r.value,'$.input.rollingPlan') IS NULL) AND (kinds.kind<>'rolling_jobs' OR (json_extract(r.value,'$.input.rollingPlan') IS NOT NULL AND coalesce(json_extract(r.value,'$.input.rollingChild'),0)=0)) AND coalesce(json_extract(r.value,kinds.status_path),'') NOT IN ('succeeded','failed','cancelled','completed')),
 (SELECT count(*) FROM records r WHERE r.bucket=kinds.bucket AND (kinds.kind<>'ordinary_jobs' OR json_extract(r.value,'$.input.rollingPlan') IS NULL) AND (kinds.kind<>'rolling_jobs' OR (json_extract(r.value,'$.input.rollingPlan') IS NOT NULL AND coalesce(json_extract(r.value,'$.input.rollingChild'),0)=0)) AND json_extract(r.value,kinds.status_path) IN ('running','processing','saving')),
 (SELECT count(*) FROM records r WHERE r.bucket=kinds.bucket AND (kinds.kind<>'ordinary_jobs' OR json_extract(r.value,'$.input.rollingPlan') IS NULL) AND (kinds.kind<>'rolling_jobs' OR (json_extract(r.value,'$.input.rollingPlan') IS NOT NULL AND coalesce(json_extract(r.value,'$.input.rollingChild'),0)=0)) AND json_extract(r.value,kinds.status_path)='unknown'),
 (SELECT count(*) FROM candidates c WHERE c.kind=kinds.kind),
 (SELECT count(*) FROM candidates c,clock WHERE c.kind=kinds.kind AND NOT EXISTS(SELECT 1 FROM records l WHERE l.bucket=CASE WHEN c.kind='rolling_jobs' THEN 'rolling-job-leases' ELSE 'commerce-ordinary-worker-leases' END AND l.id=c.lease_key AND l.owner=c.owner AND json_extract(l.value,'$.expiresAt')>clock.now))
 FROM (SELECT 'ordinary_jobs' kind,'jobs' bucket,'$.status' status_path UNION ALL SELECT 'media_edits','media-edits','$.status' UNION ALL SELECT 'frames','frame-extractions','$.status' UNION ALL SELECT 'depth','depth-video-clones','$.preparation.status' UNION ALL SELECT 'hot_remix','hot-video-remix-jobs','$.status' UNION ALL SELECT 'voice','voice-jobs','$.status' UNION ALL SELECT 'voice_replace','voice-replace-jobs','$.status' UNION ALL SELECT 'rolling_jobs','jobs','$.status') kinds
)
SELECT json_group_object(kind,json_object('total',total,'unfinished',unfinished,'active_states',active_states,'unknown_states',unknown_states,'candidates_before_batch_limits',candidates_before_batch_limits,'candidates_without_live_record_lease',candidates_without_live_record_lease)) FROM metrics
'''

LEASE_SQL = r'''SELECT json_object(
 'ordinary_active',(SELECT count(*) FROM records WHERE bucket='commerce-ordinary-worker-leases' AND json_extract(value,'$.expiresAt')>:now_ms),
 'rolling_active',(SELECT count(*) FROM records WHERE bucket='rolling-job-leases' AND json_extract(value,'$.expiresAt')>:now_ms),
 'ordinary_expired',(SELECT count(*) FROM records WHERE bucket='commerce-ordinary-worker-leases' AND coalesce(json_extract(value,'$.expiresAt'),0)<=:now_ms),
 'rolling_expired',(SELECT count(*) FROM records WHERE bucket='rolling-job-leases' AND coalesce(json_extract(value,'$.expiresAt'),0)<=:now_ms),
 'maintenance_pending_not_measured',1)
'''

CLONE_NEWNS=0x00020000

MS_RDONLY=1

MS_NOSUID=2

MS_NODEV=4

MS_NOEXEC=8

MS_REMOUNT=32

MS_BIND=4096

MS_REC=16384

MS_PRIVATE=1<<18

ERRORS={'E_PLATFORM','E_BINDING','E_NS_PERMISSION','E_NS_CREATE','E_NS_IDENTITY','E_NS_PRIVATE','E_NS_PROPAGATION','E_BIND_MOUNT','E_RO_REMOUNT','E_RO_VERIFY','E_MOUNT_FORMAT','E_NESTED_MOUNT','E_FILE_METADATA','E_SIDECARS_MISSING','E_SQLITE_HEADER','E_SQLITE_READ','E_SQLITE_SCHEMA','E_FILE_REPLACED','E_CHILD_TIMEOUT','E_CHILD_OUTPUT','E_CHILD_EXIT','E_PARENT_CHANGED','E_INTERNAL'}

class CaptureError(Exception):pass

def fail(code):raise CaptureError(code)

def runtime():
 if hashlib.sha256(SOURCE).hexdigest()!=SOURCE_SHA:fail('E_INTERNAL')
 ns={'__name__':'frozen_commerce_runtime'};exec(compile(SOURCE,'<pinned-observation>','exec'),ns);return ns

def bounded(path,limit):
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
 try:
  if not stat.S_ISREG(os.fstat(fd).st_mode):fail('E_FILE_METADATA')
  data=bytearray()
  while True:
   chunk=os.read(fd,min(65536,limit+1-len(data)))
   if not chunk:break
   data.extend(chunk)
   if len(data)>limit:fail('E_CHILD_OUTPUT')
  return bytes(data)
 finally:os.close(fd)

def mount_rows(raw):
 if type(raw) is not bytes or len(raw)>2097152:fail('E_MOUNT_FORMAT')
 rows=[]
 for line in raw.splitlines():
  fields=line.split();sep=fields.index(b'-') if b'-' in fields else -1
  if sep<6 or len(fields)<sep+4:fail('E_MOUNT_FORMAT')
  point=re.sub(rb'\\([0-7]{3})',lambda m:bytes([int(m.group(1),8)]),fields[4])
  rows.append((os.fsdecode(point),set(fields[5].decode('ascii').split(',')),fields[6:sep]))
 return rows

class LinuxMount:
 def __init__(self):
  self.lib=ctypes.CDLL(None,use_errno=True)
  self.lib.unshare.argtypes=[ctypes.c_int];self.lib.unshare.restype=ctypes.c_int
  self.lib.mount.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_ulong,ctypes.c_void_p];self.lib.mount.restype=ctypes.c_int
 def identity(self):return os.readlink('/proc/self/ns/mnt')
 def rows(self):return mount_rows(bounded('/proc/self/mountinfo',2097152))
 def unshare(self):
  if self.lib.unshare(CLONE_NEWNS)!=0:fail('E_NS_PERMISSION' if ctypes.get_errno() in (errno.EPERM,errno.EACCES) else 'E_NS_CREATE')
 def mount(self,source,target,flags,code):
  src=None if source is None else os.fsencode(source)
  if self.lib.mount(src,os.fsencode(target),None,flags,None)!=0:fail(code)

def isolate(directory,backend):
 original=backend.identity();backend.unshare()
 if backend.identity()==original:fail('E_NS_IDENTITY')
 backend.mount(None,'/',MS_REC|MS_PRIVATE,'E_NS_PRIVATE')
 rows=backend.rows()
 if any(any(x.startswith((b'shared:',b'master:',b'propagate_from:')) for x in extra) for _,_,extra in rows):fail('E_NS_PROPAGATION')
 path=str(directory)
 if any(point.startswith(path.rstrip('/')+'/') for point,_,_ in rows):fail('E_NESTED_MOUNT')
 backend.mount(path,path,MS_BIND,'E_BIND_MOUNT')
 backend.mount(None,path,MS_BIND|MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV|MS_NOEXEC,'E_RO_REMOUNT')
 matches=[(opts,extra) for point,opts,extra in backend.rows() if point==path]
 if len(matches)!=1 or not {'ro','nosuid','nodev','noexec'}<=matches[0][0] or matches[0][1]:fail('E_RO_VERIFY')
 if not os.statvfs(directory).f_flag & os.ST_RDONLY:fail('E_RO_VERIFY')
 return True

def files(database,ns):
 result={}
 for path in [database,Path(str(database)+'-wal'),Path(str(database)+'-shm')]:
  try:meta=ns['trusted'](path)
  except FileNotFoundError:fail('E_SIDECARS_MISSING')
  except Exception:fail('E_FILE_METADATA')
  if meta.st_nlink!=1:fail('E_FILE_METADATA')
  result[str(path)]=(meta.st_dev,meta.st_ino)
 return result

def sqlite_read(database,ns):
 # Called only after isolate returned true; no immutable or fallback path exists.
 import sqlite3
 from urllib.parse import quote
 before=files(database,ns)
 fd=os.open(database,os.O_RDONLY|os.O_NOFOLLOW)
 try:header=os.read(fd,100)
 finally:os.close(fd)
 if len(header)!=100 or header[:16]!=b'SQLite format 3\0' or header[18:20]!=b'\x02\x02':fail('E_SQLITE_HEADER')
 conn=sqlite3.connect('file:'+quote(str(database),safe='/')+'?mode=ro&cache=private',uri=True,timeout=2)
 try:
  conn.enable_load_extension(False)
  for pragma in ['query_only=ON','trusted_schema=OFF','busy_timeout=2000','temp_store=MEMORY','mmap_size=0']:conn.execute('PRAGMA '+pragma)
  if conn.execute('PRAGMA query_only').fetchone()!=(1,) or conn.execute('PRAGMA temp_store').fetchone()!=(2,):fail('E_SQLITE_SCHEMA')
  if conn.execute("SELECT type FROM sqlite_schema WHERE name='records'").fetchone()!=('table',):fail('E_SQLITE_SCHEMA')
  if {r[1] for r in conn.execute('PRAGMA table_info(records)')}!={'bucket','id','owner','value','updated'}:fail('E_SQLITE_SCHEMA')
  allowed={sqlite3.SQLITE_SELECT,sqlite3.SQLITE_READ,sqlite3.SQLITE_FUNCTION,sqlite3.SQLITE_TRANSACTION,sqlite3.SQLITE_RECURSIVE}
  def auth(action,p1,p2,db,trigger):
   if action not in allowed:return sqlite3.SQLITE_DENY
   if action==sqlite3.SQLITE_FUNCTION and str(p2).lower() not in {'json_group_object','json_object','json_extract','count','coalesce'}:return sqlite3.SQLITE_DENY
   if action==sqlite3.SQLITE_TRANSACTION and p1 not in ('BEGIN','ROLLBACK'):return sqlite3.SQLITE_DENY
   if action==sqlite3.SQLITE_READ and (db!='main' or p1!='records'):return sqlite3.SQLITE_DENY
   return sqlite3.SQLITE_OK
  deadline=time.monotonic()+8;conn.set_authorizer(auth);conn.set_progress_handler(lambda:1 if time.monotonic()>deadline else 0,1000)
  conn.execute('BEGIN');params={'now_ms':int(time.time()*1000)}
  groups=ns['load_json'](conn.execute(COMMERCE_SQL,params).fetchone()[0]);leases=ns['load_json'](conn.execute(LEASE_SQL,params).fetchone()[0]);conn.execute('ROLLBACK')
  if files(database,ns)!=before:fail('E_FILE_REPLACED')
  return ns['sqlite_schema']({'read_only':True,'groups':groups,'leases':leases,'maintenance_coverage_complete':False,'claimability_guaranteed':False,'atomic_quiescence_proven':False})
 finally:conn.close()

def child_read(directory,ns,backend=None):
 import resource
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_FSIZE,(0,0));resource.setrlimit(resource.RLIMIT_CPU,(15,15));resource.setrlimit(resource.RLIMIT_AS,(536870912,536870912))
 before=ns['trusted'](directory,True)
 isolate(directory,LinuxMount() if backend is None else backend)
 after=ns['trusted'](directory,True)
 if (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino):fail('E_BINDING')
 return sqlite_read(directory/'commerce.sqlite',ns)

def child_capture(directory,ns):
 readfd,writefd=os.pipe();pid=os.fork()
 if pid==0:
  os.close(readfd)
  try:
   try:value={'ok':True,'error':'OK','sqlite':child_read(directory,ns)}
   except Exception as exc:value={'ok':False,'error':str(exc) if isinstance(exc,CaptureError) and str(exc) in ERRORS else 'E_SQLITE_READ','sqlite':None}
   raw=json.dumps(value,sort_keys=True).encode('ascii')
   if len(raw)>16384:raw=b'{"ok":false,"error":"E_CHILD_OUTPUT","sqlite":null}'
   while raw:
    written=os.write(writefd,raw);raw=raw[written:]
  finally:os.close(writefd);os._exit(0)
 os.close(writefd);output=bytearray();deadline=time.monotonic()+4;reaped=False
 try:
  while True:
   remaining=deadline-time.monotonic()
   if remaining<=0:fail('E_CHILD_TIMEOUT')
   ready,_,_=select.select([readfd],[],[],remaining)
   if not ready:fail('E_CHILD_TIMEOUT')
   chunk=os.read(readfd,4096)
   if not chunk:break
   output.extend(chunk)
   if len(output)>16384:fail('E_CHILD_OUTPUT')
  _,status=os.waitpid(pid,0);reaped=True
  if not os.WIFEXITED(status) or os.WEXITSTATUS(status)!=0:fail('E_CHILD_EXIT')
  return ns['load_json'](bytes(output))
 finally:
  os.close(readfd)
  if not reaped:
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
   os.waitpid(pid,0)
