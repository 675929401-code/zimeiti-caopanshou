import fcntl,json,os,sys,time
from pathlib import Path
R=Path('/tmp/codex-window-fixture-only');mode=(R/'scenario').read_text().strip();tx=json.loads((R/'descriptor.json').read_text())['transactionId'];a=['a'*64,'b'*64];b=['c'*64,'d'*64]
def log(s):
 with (R/'events').open('a') as f:f.write(s+'\n');f.flush();os.fsync(f.fileno())
def send(seq,op,outcome):print(json.dumps({'seq':seq,'transactionId':tx,'op':op,'outcome':outcome,'sourceSha256':a,'candidateSha256':b},separators=(',',':')),flush=True)
fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB);(R/'maintenance.pid').write_text(str(os.getpid()));log('hold-ready')
if mode=='maintenance-close-input':os.close(0)
send(0,'ready','READY')
if mode=='maintenance-close-input':time.sleep(5);sys.exit(1)
for seq,op in [(1,'install'),(2,'verify'),(3,'restore')]:
 line=sys.stdin.readline()
 if not line:sys.exit(1)
 if json.loads(line)!={'seq':seq,'transactionId':tx,'op':op}:sys.exit(1)
 if op=='restore':
  if mode=='restore-failure' or not (R/'success').is_file():sys.exit(1)
  log('restore');(R/'held').unlink();send(seq,op,'RESTORED_FILES_ONLY')
 else:
  if op=='install':(R/'held').write_text('held');log('hold-install')
  else:log('hold-verify')
  send(seq,op,'HELD_FILES_ONLY')
if sys.stdin.read()!='':sys.exit(1)
