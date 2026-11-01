"""Synthetic metadata, real receiver POSIX filesystem operations in private root."""
import hashlib,importlib.util,io,json,os,stat,sys,tarfile
from pathlib import Path

TEMPLATE_SHA='3769789b9e246a57eff479ae87c55552a88411911e34f98400e6d50bd6c69b73'
def sha(raw):return hashlib.sha256(raw).hexdigest()
def data(value):return (json.dumps(value,separators=(',',':'))+'\n').encode('ascii')
def require(value,message):
 if not value:raise AssertionError(message)

# Refuse any uncontained invocation before creating directories or fixture data.
require(sys.platform=='linux' and os.geteuid()==0,'LINUX_ROOT_REQUIRED')
require(Path('/.operator-receiver-private-root').read_text()=='operator-receiver-private-root-v1\n','PRIVATE_ROOT_REQUIRED')
require(len(sys.argv)==3 and os.readlink('/proc/self/ns/mnt')!=sys.argv[1] and os.readlink('/proc/self/ns/net')!=sys.argv[2],'PRIVATE_NAMESPACES_REQUIRED')
template=Path('/fixture/receiver-template.py').read_bytes();require(sha(template)==TEMPLATE_SHA,'TEMPLATE_SHA')
spec=importlib.util.spec_from_file_location('actual_receiver','/fixture/receiver-template.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

base=Path('/data/direct-deploy');base.mkdir(parents=True,mode=0o755)
fixture=Path('/data/fixture');fixture.mkdir(mode=0o755)
external=fixture/'external';external.mkdir()
system=fixture/'system';system.mkdir()
forbidden=[]
def audit(event,args):
 if event in ('subprocess.Popen','os.system','os.posix_spawn','os.exec','os.fork','socket.connect','socket.bind'):
  forbidden.append(event);raise AssertionError('UNEXPECTED_PROCESS_OR_NETWORK:'+event)
sys.addaudithook(audit)

worker_files={}
for role in ('python','node','pm2','sudo','env','psql','ss'):
 p=system/role;p.write_bytes(('fixture-system-'+role+'\n').encode());p.chmod(0o555)
 worker_files[role]={'path':str(p),'sha256':sha(p.read_bytes())}
window={}
for role in ('controller','hook','config','verifier','receipt','controlDescriptor','bundle','artifact'):
 p=external/role;p.write_bytes(('fixture-external-'+role+'\n').encode());p.chmod(0o444)
 window[role+'Path']=str(p);window[role+'Sha256']=sha(p.read_bytes())
nginx=Path('/etc/nginx/conf.d');nginx.mkdir(parents=True)
synthetic_original={}
for name in ('agent-hub.conf','zyuani8.com.conf'):
 p=nginx/name;p.write_bytes(('EXPLICIT SYNTHETIC CONFIG '+name+'\n').encode());p.chmod(0o444);synthetic_original[str(p)]=sha(p.read_bytes())
# This is the only fact substitution: fixture files cannot have production
# Nginx hashes. No plan/execute/fsync/open/verify functions are substituted.
r.ORIGINAL=synthetic_original
root='/data/direct-deploy/worker-window/V1.0-0123456789ab'
tx='fixture-receiver-'+window['artifactSha256'][:12]
worker={'schemaVersion':1,'operatorRoot':root,'transactionId':tx,'artifactSha256':window['artifactSha256'],'files':worker_files}
worker_bytes=data(worker)
window.update({'schemaVersion':1,'operatorRoot':root,'transactionId':tx,'artifactSha256':window['artifactSha256'],'maintenanceSha256':sha(b'fixture-maintenance\n')})
factory=('EXPECTED_DESCRIPTOR_SHA='+repr(sha(worker_bytes))+'\n').encode();window['workerFactorySha256']=sha(factory)
payload={
 'operator/window-main.mjs':(b'fixture-main\n','0444'),
 'operator/dispatch-deadline.mjs':(b'fixture-dispatch\n','0444'),
 'operator/operator-launcher.sh':(b'fixture-launcher\n','0555'),
 'operator/minimal-maintenance.py':(b'fixture-maintenance\n','0500'),
 'operator/root_window_factory.py':(factory,'0500'),
 'operator/window-descriptor.json':(data(window),'0444'),
 'worker-prestop-descriptor.json':(worker_bytes,'0600')}
for i in range(16):payload['operator/closure/nested/module-%02d.py'%i]=(('fixture-module-%d\n'%i).encode(),'0444')
records=[]
for name,(raw,mode) in payload.items():records.append({'path':name,'remotePath':root+'/'+name[9:] if name.startswith('operator/') else '/data/direct-deploy/worker-prestop-descriptor.json','mode':mode,'bytes':len(raw),'sha256':sha(raw)})
manifest={'schemaVersion':1,'kind':'zimeiti-external-operator-package.v1','syntheticOnly':True,'operatorRoot':root,'transactionId':tx,'artifactSha256':window['artifactSha256'],'files':sorted(records,key=lambda x:x['path'])}
manifest_bytes=data(manifest);buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode='w',format=tarfile.USTAR_FORMAT) as archive:
 for name,(raw,mode) in dict(payload,**{'manifest.json':(manifest_bytes,'0444')}).items():
  info=tarfile.TarInfo(name);info.size=len(raw);info.mode=int(mode,8);info.uid=info.gid=0;info.mtime=0;archive.addfile(info,io.BytesIO(raw))
raw=buffer.getvalue();r.EXPECTED_ARCHIVE_SHA=sha(raw);r.EXPECTED_MANIFEST_SHA=sha(manifest_bytes)
try:r.validate_archive(raw)
except ValueError:pass
else:raise AssertionError('SYNTHETIC_PACKAGE_REACHED_PRODUCTION_VALIDATOR')
m,entries,w,d=r.validate_archive(raw,allow_synthetic=True)

def snapshot():
 values=[]
 for top in ('/data','/etc/nginx'):
  for current,dirs,files in os.walk(top,followlinks=False):
   for name in sorted(dirs+files):
    p=Path(current)/name;s=p.lstat();values.append((str(p),s.st_dev,s.st_ino,stat.S_IMODE(s.st_mode),s.st_size if p.is_file() else 0,sha(p.read_bytes()) if p.is_file() else 'directory'))
 return values

before=snapshot();plan,fingerprint=r.plan(m,w,d);require(snapshot()==before,'PLAN_WROTE_FILES')
try:r.execute(m,entries,w,d,'0'*64)
except ValueError as error:require(str(error)=='PLAN_CHANGED','WRONG_PLAN_FAILURE')
else:raise AssertionError('BAD_PLAN_ACCEPTED')
require(snapshot()==before,'BAD_PLAN_WROTE_FILES')

descriptor=Path('/data/direct-deploy/worker-prestop-descriptor.json')
descriptor.write_bytes(b'collision-sentinel\n');descriptor.chmod(0o600)
try:r.plan(m,w,d)
except ValueError as error:require(str(error)=='DESTINATION_EXISTS_RECONCILE','WRONG_COLLISION_FAILURE')
else:raise AssertionError('GLOBAL_COLLISION_ACCEPTED')
require(descriptor.read_bytes()==b'collision-sentinel\n','GLOBAL_COLLISION_OVERWRITTEN');descriptor.unlink()

Path(root).mkdir(parents=True);sentinel=Path(root)/'preserve';sentinel.write_bytes(b'keep\n')
try:r.plan(m,w,d)
except ValueError as error:require(str(error)=='DESTINATION_EXISTS_RECONCILE','WRONG_DIRECTORY_COLLISION_FAILURE')
else:raise AssertionError('DIRECTORY_COLLISION_ACCEPTED')
require(sentinel.read_bytes()==b'keep\n','DIRECTORY_COLLISION_OVERWRITTEN');sentinel.unlink();Path(root).rmdir()

counts={'fsync':0,'exclusiveOpen':0,'noFollowOpen':0};original_fsync=os.fsync;original_open=os.open
def traced_fsync(fd):counts['fsync']+=1;return original_fsync(fd)
def traced_open(file,flags,*args,**kwargs):
 if flags&os.O_EXCL:counts['exclusiveOpen']+=1
 if flags&os.O_NOFOLLOW:counts['noFollowOpen']+=1
 return original_open(file,flags,*args,**kwargs)
os.fsync=traced_fsync;os.open=traced_open
try:
 _,fingerprint=r.plan(m,w,d)
 installed=r.execute(m,entries,w,d,fingerprint);require(installed['installed'],'INSTALL_NOT_CONFIRMED')
 verified=r.verify_installed(m);require(verified['verified'] and verified['files']==23,'VERIFY_NOT_CONFIRMED')
 installed_snapshot=snapshot()
 try:r.execute(m,entries,w,d,fingerprint)
 except ValueError as error:require(str(error)=='DESTINATION_EXISTS_RECONCILE','REPEAT_FAILURE')
 else:raise AssertionError('REPEAT_INSTALL_ACCEPTED')
 require(snapshot()==installed_snapshot,'REPEAT_INSTALL_OVERWROTE_FILES')
finally:os.fsync=original_fsync;os.open=original_open

require(counts['fsync']>=26 and counts['exclusiveOpen']==23 and counts['noFollowOpen']>=23,'POSIX_CALLS_NOT_OBSERVED')
require(not forbidden,'FORBIDDEN_OPERATIONS')
print(json.dumps({'passed':True,'kind':'synthetic-operator-receiver-linux-filesystem','templateSha256':TEMPLATE_SHA,'privateMountNamespace':True,'privateNetworkNamespace':True,'privateRoot':True,'syntheticMetadata':True,'productionAuthenticationProven':False,'planWrites':0,'badPlanWrites':0,'installedFiles':23,'readbackVerified':True,'collisionOverwrites':0,'repeatOverwrites':0,'actualPosixCalls':counts,'serviceOperations':0,'databaseWrites':0,'networkConnections':0,'pythonVersion':sys.version.split()[0]},sort_keys=True,separators=(',',':')))
