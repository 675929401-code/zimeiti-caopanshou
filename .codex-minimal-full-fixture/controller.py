import fcntl,json,os,sys,time
from pathlib import Path
R=Path('/tmp/codex-window-fixture-only');mode=(R/'scenario').read_text().strip();tx=json.loads((R/'descriptor.json').read_text())['transactionId'];td=R/'control'/'transactions'/tx;fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
def log(s):
 with (R/'events').open('a') as f:f.write(s+'\n');f.flush();os.fsync(f.fileno())
def wait_gate():
 deadline=time.monotonic()+10
 while not (R/'continue').exists():
  if time.monotonic()>deadline:sys.exit(1)
  time.sleep(.01)
if sys.argv[1:]==['--plan']:
 log('plan')
 if mode=='stdout-plan':wait_gate() 
 sys.exit(1 if mode=='plan-failure' else 0)
if sys.argv[1:]!=['--execute'] or not (td/'migration-confirmed.json').is_file():sys.exit(1)
log('controller-start')
if mode=='controller-failure':sys.exit(1)
s=json.loads((td/'media-worker-state.json').read_bytes());s['status']='persisted';s['persistedAt']='2026-01-01T00:00:00Z';s['next']={'cwd':str(R/'web'/'releases'/'fixture-release'/'web'),'releaseId':'fixture-release','commitSha':'1'*40,'buildId':'fixture-build','sourceVersion':'fixture-source','buildOutputDigest':'2'*64,'assetDigest':'3'*64,'assetManifestSha256':'4'*64}
with (td/'media-worker-state.json').open('w') as f:json.dump(s,f,separators=(',',':'));f.flush();os.fsync(f.fileno())
link=R/'web'/'current-web';os.symlink(str(R/'web'/'releases'/'fixture-release'/'web'),link)
if mode!='missing-success':
 with (R/'success').open('x') as f:f.write('SUCCESS\n');f.flush();os.fsync(f.fileno())
 log('controller-success')
 if mode=='stdout-controller':wait_gate()
else:log('controller-no-success')
