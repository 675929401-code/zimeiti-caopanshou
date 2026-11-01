"""Exclusive external-operator installation only. Never activates services."""
import hashlib,io,json,os,re,stat,sys,tarfile
from pathlib import Path,PurePosixPath
EXPECTED_ARCHIVE_SHA='ARCHIVE_SHA_PLACEHOLDER'
EXPECTED_MANIFEST_SHA='MANIFEST_SHA_PLACEHOLDER'
ORIGINAL={'/etc/nginx/conf.d/agent-hub.conf':'62740bb5b8dc62437044e340d64583e6fd8d6a1f335aa2bb8f4625edeb523595','/etc/nginx/conf.d/zyuani8.com.conf':'0f2661afa3b8d7bdc32f0993b1a6746427980047878e32f506442cf5454f4f6d'}
def fail(code):raise ValueError(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def body(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode('ascii')
def pairs(items):
 out={}
 for key,value in items:
  if key in out:fail('DUPLICATE_JSON')
  out[key]=value
 return out
def parse(raw):return json.loads(raw.decode('utf8'),object_pairs_hook=pairs)
def validate_archive(raw,allow_synthetic=False):
 if not isinstance(raw,bytes) or len(raw)>4194304 or sha(raw)!=EXPECTED_ARCHIVE_SHA:fail('ARCHIVE_DIGEST')
 entries={}
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:') as tar:
  for item in tar:
   path=PurePosixPath(item.name)
   if not item.isfile() or item.issym() or item.islnk() or item.name in entries or path.is_absolute() or '..' in path.parts or str(path)!=item.name or item.size>2097152 or item.uid!=0 or item.gid!=0:fail('ARCHIVE_ENTRY')
   if len(entries)>32:fail('ARCHIVE_LIMIT')
   data=tar.extractfile(item).read(item.size+1)
   if len(data)!=item.size:fail('ARCHIVE_ENTRY')
   entries[item.name]=(data,item.mode)
 if 'manifest.json' not in entries or sha(entries['manifest.json'][0])!=EXPECTED_MANIFEST_SHA:fail('MANIFEST_DIGEST')
 m=parse(entries['manifest.json'][0]);root=m.get('operatorRoot')
 if m.get('schemaVersion')!=1 or m.get('kind')!='zimeiti-external-operator-package.v1' or not re.fullmatch(r'/data/direct-deploy/worker-window/V[1-9][0-9]*\.[0-9]+-[a-f0-9]{12}',root or '') or (m.get('syntheticOnly') is not False and not allow_synthetic) or len(m.get('files',[]))!=23:fail('MANIFEST_INVALID')
 if set(entries)!={'manifest.json',*(x['path'] for x in m['files'])}:fail('ARCHIVE_SCOPE')
 targets=set()
 for item in m['files']:
  name=item['path'];target=item['remotePath'];data,mode=entries[name]
  if name.startswith('operator/'):
   if target!=root+'/'+name[len('operator/'):]:fail('TARGET_SCOPE')
  elif name!='worker-prestop-descriptor.json' or target!='/data/direct-deploy/worker-prestop-descriptor.json':fail('TARGET_SCOPE')
  if target in targets or item['mode'] not in ('0444','0500','0555','0600') or mode!=int(item['mode'],8) or len(data)!=item['bytes'] or sha(data)!=item['sha256']:fail('ENTRY_MISMATCH')
  if name.startswith('operator/') and mode&0o222:fail('OPERATOR_WRITABLE')
  targets.add(target)
 worker=parse(entries['worker-prestop-descriptor.json'][0]);window=parse(entries['operator/window-descriptor.json'][0])
 if worker['operatorRoot']!=root or window['operatorRoot']!=root or worker['transactionId']!=m['transactionId'] or window['transactionId']!=m['transactionId'] or worker['artifactSha256']!=m['artifactSha256'] or window['artifactSha256']!=m['artifactSha256']:fail('DESCRIPTION_BINDING')
 factory=entries['operator/root_window_factory.py'][0]
 expected=sha(entries['worker-prestop-descriptor.json'][0])
 if factory.count(('EXPECTED_DESCRIPTOR_SHA='+repr(expected)).encode())!=1 or b'EXPECTED_DESCRIPTOR_SHA=None' in factory or sha(factory)!=window['workerFactorySha256']:fail('FACTORY_BINDING')
 for role,key in [('main','window-main.mjs'),('maintenance','minimal-maintenance.py')]:
  if role=='maintenance' and sha(entries['operator/'+key][0])!=window['maintenanceSha256']:fail('DESCRIPTION_BINDING')
 return m,entries,worker,window
def parent_chain(path):
 current=Path(path)
 for item in (current,*current.parents):
  st=os.lstat(item)
  if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid!=0 or st.st_gid!=0 or st.st_mode&0o022:fail('PARENT_UNSAFE')
def digest_remote(file,expected,system=False):
 p=Path(file);parent_chain(p.parent);named=os.lstat(p)
 if stat.S_ISLNK(named.st_mode):
  if not system or named.st_uid!=0:fail('FILE_REDIRECTED')
  p=Path(os.path.realpath(p));parent_chain(p.parent)
 st=os.lstat(p)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_gid!=0 or st.st_mode&0o022 or (not system and st.st_nlink!=1) or st.st_size>2147483648:fail('FILE_UNSAFE')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC);h=hashlib.sha256()
 try:
  start=os.fstat(fd)
  if (start.st_dev,start.st_ino)!=(st.st_dev,st.st_ino):fail('FILE_CHANGED')
  while True:
   chunk=os.read(fd,1048576)
   if not chunk:break
   h.update(chunk)
  end=os.fstat(fd);last=os.stat(p)
  if (start.st_dev,start.st_ino,start.st_size,start.st_mtime_ns)!=(end.st_dev,end.st_ino,end.st_size,end.st_mtime_ns) or (start.st_dev,start.st_ino,start.st_size,start.st_mtime_ns)!=(last.st_dev,last.st_ino,last.st_size,last.st_mtime_ns) or h.hexdigest()!=expected:fail('FILE_CHANGED')
 finally:os.close(fd)
 return {'path':file,'sha256':expected,'dev':st.st_dev,'ino':st.st_ino,'bytes':st.st_size,'mtimeNs':st.st_mtime_ns}
def plan(m,worker,window):
 if sys.platform!='linux' or os.geteuid()!=0:fail('LINUX_ROOT_REQUIRED')
 parent_chain('/data/direct-deploy')
 target=Path(m['operatorRoot']);base=target.parent
 if base.exists():parent_chain(base)
 if target.exists() or target.is_symlink() or os.path.lexists('/data/direct-deploy/worker-prestop-descriptor.json'):fail('DESTINATION_EXISTS_RECONCILE')
 observations=[]
 for role in ('python','node','pm2','sudo','env','psql','ss'):
  e=worker['files'][role];observations.append(digest_remote(e['path'],e['sha256'],True))
 for role in ('controller','hook','config','verifier','receipt','controlDescriptor','bundle','artifact'):
  observations.append(digest_remote(window[role+'Path'],window[role+'Sha256']))
 for file,pin in ORIGINAL.items():observations.append(digest_remote(file,pin))
 value={'schemaVersion':1,'manifestSha256':EXPECTED_MANIFEST_SHA,'archiveSha256':EXPECTED_ARCHIVE_SHA,'operatorRoot':m['operatorRoot'],'transactionId':m['transactionId'],'destinationsAbsent':True,'observations':observations}
 return value,sha(body(value))
def sync_directory(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def execute(m,entries,worker,window,expected_plan):
 _,actual=plan(m,worker,window)
 if actual!=expected_plan:fail('PLAN_CHANGED')
 root=Path(m['operatorRoot']);base=root.parent
 try:os.mkdir(base,0o755);sync_directory(base.parent)
 except FileExistsError:parent_chain(base)
 os.mkdir(root,0o700);sync_directory(base)
 directories={root}
 for item in m['files']:
  if not item['path'].startswith('operator/'):continue
  p=Path(item['remotePath']);current=root
  for part in p.relative_to(root).parts[:-1]:
   current/=part
   if current not in directories:os.mkdir(current,0o700);directories.add(current)
  raw=entries[item['path']][0];fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
  with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fchmod(stream.fileno(),int(item['mode'],8));os.fsync(stream.fileno())
  digest_remote(str(p),item['sha256'])
 for directory in sorted(directories,key=lambda p:len(p.parts),reverse=True):os.chmod(directory,0o555);sync_directory(directory)
 raw=entries['worker-prestop-descriptor.json'][0];p=Path('/data/direct-deploy/worker-prestop-descriptor.json')
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
 with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fchmod(stream.fileno(),0o600);os.fsync(stream.fileno())
 digest_remote(str(p),sha(raw));sync_directory(p.parent)
 return {'installed':True,'operatorRoot':m['operatorRoot'],'transactionId':m['transactionId'],'manifestSha256':EXPECTED_MANIFEST_SHA,'files':len(m['files']),'serviceOperations':0,'databaseWrites':0}
def verify_installed(m):
 if sys.platform!='linux' or os.geteuid()!=0:fail('LINUX_ROOT_REQUIRED')
 root=Path(m['operatorRoot']);parent_chain(root)
 expected={x['remotePath'] for x in m['files'] if x['path'].startswith('operator/')};found=set()
 for current,dirs,files in os.walk(root,followlinks=False):
  st=os.lstat(current)
  if st.st_uid!=0 or st.st_gid!=0 or stat.S_IMODE(st.st_mode)!=0o555:fail('INSTALLED_DIRECTORY_MODE')
  for name in dirs:
   if (Path(current)/name).is_symlink():fail('INSTALLED_LINK')
  found.update(str(Path(current)/name) for name in files)
 if found!=expected:fail('INSTALLED_FILE_SET')
 for item in m['files']:
  digest_remote(item['remotePath'],item['sha256'])
  if stat.S_IMODE(os.lstat(item['remotePath']).st_mode)!=int(item['mode'],8):fail('INSTALLED_FILE_MODE')
 return {'verified':True,'operatorRoot':m['operatorRoot'],'transactionId':m['transactionId'],'manifestSha256':EXPECTED_MANIFEST_SHA,'files':len(m['files']),'serverWrites':0}
if __name__=='__main__':
 try:
  if sys.argv[1:] not in (['--plan'],['--verify-installed']) and not (len(sys.argv)==3 and sys.argv[1]=='--execute' and re.fullmatch('[a-f0-9]{64}',sys.argv[2])):fail('ARGUMENTS')
  raw=sys.stdin.buffer.read(4194305);m,entries,worker,window=validate_archive(raw)
  if sys.argv[1]=='--plan':value,fingerprint=plan(m,worker,window);print(json.dumps({'plan':value,'planFingerprint':fingerprint},separators=(',',':')))
  elif sys.argv[1]=='--verify-installed':print(json.dumps(verify_installed(m),separators=(',',':')))
  else:print(json.dumps(execute(m,entries,worker,window,sys.argv[2]),separators=(',',':')))
 except BaseException:print('OPERATOR_PACKAGE_REJECTED',file=sys.stderr);raise SystemExit(1)
