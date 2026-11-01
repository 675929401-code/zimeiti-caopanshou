import fcntl,hashlib,json,os,signal,sys,time
from pathlib import Path
R=Path('/tmp/codex-window-fixture-only');mode=(R/'scenario').read_text().strip();tx=json.loads((R/'descriptor.json').read_text())['transactionId'];td=R/'control'/'transactions'/tx;config=R/'control'/'config';fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)
def log(s):
 with (R/'events').open('a') as f:f.write(s+'\n');f.flush();os.fsync(f.fileno())
if mode=='prestop-failure':log('prestop-failure');sys.exit(1)
td.mkdir(parents=True);cs=hashlib.sha256(config.read_bytes()).hexdigest();s={'schemaVersion':'fixture-media-worker-transaction.v1','workerName':'fixture-worker','preparedAt':'2026-01-01T00:00:00Z','configPath':str(config),'configSha256':cs,'previous':{'releaseId':'old-fixture'},'status':'prepared'}
raw=(json.dumps(s,separators=(',',':'))+'\n').encode();fd=os.open(td/'media-worker-state.json',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.write(fd,raw);os.fsync(fd);os.close(fd);ds=hashlib.sha256(raw).hexdigest();log('prestop-ready')
if mode=='prestop-close-input':os.close(0)
print(json.dumps({'outcome':'PRESTOP_READY','transactionId':tx,'stateSha256':ds,'configSha256':cs,'evidenceSha256':'e'*64,'releaseReady':True,'maintenanceMustRemain':True,'automaticRetry':False},separators=(',',':')),flush=True)
if mode=='prestop-close-input':time.sleep(5);sys.exit(1)
if sys.stdin.readline()!='{"op":"handoff"}\n' or sys.stdin.read()!='':sys.exit(1)
if mode=='handoff-failure' or not (td/'migration-confirmed.json').is_file():sys.exit(1)
if mode=='maintenance-during-handoff':
 os.kill(int((R/'maintenance.pid').read_text()),signal.SIGTERM);time.sleep(.2)
log('prestop-handoff');print(json.dumps({'outcome':'HANDOFF_READY','transactionId':tx},separators=(',',':')),flush=True)
