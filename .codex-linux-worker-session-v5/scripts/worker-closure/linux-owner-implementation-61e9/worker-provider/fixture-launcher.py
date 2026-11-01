"""CI-only synthetic worker session; does not connect to PM2 or production."""
import importlib.util,os,socket,subprocess,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
session=load('synthetic_session',HERE/'worker-session.py');watchmod=load('synthetic_watch',HERE/'continuous_watch.py');identity=load('synthetic_identity',HERE/'current_identity.py');ownermod=load('synthetic_owner',HERE.parent/'journal-owner-child.py')
raw=ownermod._open_inherited_fd3();owner=watchmod.SerializedOwner(raw);channel=session._UnixChannel(raw)
class SyntheticRuntime:
 def __init__(self,owner):
  self.children=[];self.fds={};self.closed=False
  try:
   for _ in range(2):self.children.append(subprocess.Popen(['/usr/bin/python3','-I','-S','-B','-c','import sys;sys.stdin.read()'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True))
   rows=[]
   for child,pmid in zip(self.children,(18,19)):
    parent,start=identity.stat_fields(Path('/proc/%d/stat'%child.pid).read_bytes());assert parent==os.getpid()
    self.fds[child.pid]=os.pidfd_open(child.pid,0)
    rows.append((child.pid,start,pmid,parent,'/synthetic/current',b'synthetic-release-1',b'a'*40,b'/data/web/shared/runtime/synthetic'))
   rows=tuple(sorted(rows));slots={r[2]:{'pm_id':r[2],'pid':r[0],'unique_id':'synthetic_'+str(r[2]),'status':'online'} for r in rows}
   identity._attest(owner,lambda:(rows,'/synthetic/current'),lambda:slots,self.fds,rows)
   self.baseline=tuple((r[0],r[1],r[2]) for r in rows)
  except BaseException:self.close();raise
 def sample(self):
  if self.closed or any(not identity._pidfd_active(fd) for fd in self.fds.values()):raise RuntimeError('synthetic worker changed')
  return self.baseline
 def receive(self,timeout):time.sleep(min(timeout,.01))
 def counters(self):return {i:{'drained_true':0,'drained_false':0,'invalid_stop_marker':0} for i in (18,19)}
 def partial(self):return False
 def close(self):
  if self.closed:return
  self.closed=True
  for fd in self.fds.values():os.close(fd)
  self.fds.clear()
  for child in self.children:
   if child.stdin and not child.stdin.closed:child.stdin.close()
   try:child.wait(timeout=1)
   except subprocess.TimeoutExpired:child.kill();child.wait(timeout=1)
def start(same_owner):
 runtime=SyntheticRuntime(same_owner)
 try:return watchmod._ContinuousWatch(same_owner,runtime,sample_interval=.01,max_seconds=90,max_stale_seconds=5),None
 except BaseException:runtime.close();raise
try:session._serve(channel,owner,start)
except BaseException:raise SystemExit(1) from None
