"""One owned worker observation session. Production entry remains closed.

The private entry must be called only by an authenticated installed launcher.
No request can supply an owner, module, PID, callback, or authorization flag.
"""
import hashlib,importlib.util,json,os,re,select,socket,struct,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
PINS={
 '../journal-owner-child.py':'f7e909a8b65133e23f0f27329b5c7b965276345c7522b971030bf511947b0552',
 'continuous_watch.py':'5c81401ddfc1fbcfa0ed2a220c098c2cd6eb2fde69d15d0632a5d8a34c9b61ac',
 # Updated by the frozen build after the one-line dependency pin adjustment.
 'current_identity.py':'d31b44d06672976aa9b6eb1e5041ddb90b0445af9b3346dddd0b2b6e90c17048',
}
MAX=4096
class SessionError(RuntimeError):pass
def fail():raise SessionError('WORKER_SESSION_UNKNOWN') from None
def load(name,filename):
 path=HERE/filename;raw=path.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=PINS[filename]:fail()
 spec=importlib.util.spec_from_loader(name,loader=None);module=importlib.util.module_from_spec(spec);module.__file__=str(path)
 exec(compile(raw,str(path),'exec',dont_inherit=True),module.__dict__);return module

def pairs(items):
 out={}
 for key,value in items:
  if key in out:fail()
  out[key]=value
 return out

def parse_request(raw,tx,expected_seq,state):
 if type(raw) is not bytes or len(raw)>MAX or not raw.endswith(b'\n') or raw.count(b'\n')!=1:fail()
 try:
  value=json.loads(raw[:-1].decode('ascii'),object_pairs_hook=pairs)
  if type(value) is not dict or list(value)!=['seq','transactionId','op'] or type(value['seq']) is not int or value['seq']!=expected_seq or value['transactionId']!=tx:fail()
  if value['op'] not in (('open',) if state=='created' else ('check','finish')):fail()
  if raw!=(json.dumps(value,ensure_ascii=True,separators=(',',':'))+'\n').encode('ascii'):fail()
  return value
 except BaseException:fail()

def response(request,outcome):
 return (json.dumps({'seq':request['seq'],'transactionId':request['transactionId'],'op':request['op'],'outcome':outcome},ensure_ascii=True,separators=(',',':'))+'\n').encode('ascii')

class _UnixChannel:
 def __init__(self,owner,fd=4):
  if sys.platform!='linux' or os.geteuid()!=0:fail()
  self.owner=owner;self.pid=os.getpid();self.sock=None
  try:
   self.sock=socket.socket(fileno=fd);self.sock.setblocking(False);self.check()
  except BaseException:
   if self.sock is not None:
    try:self.sock.close()
    except OSError:pass
   fail()
 def check(self):
  if os.getpid()!=self.pid or os.getppid()!=self.owner.parent:fail()
  peer=struct.unpack('3i',self.sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if peer[0]!=self.owner.parent or peer[1]!=0:fail()
 def live_and_idle(self):
  self.check()
  try:
   raw=self.sock.recv(1,socket.MSG_PEEK)
   if not raw:fail()
   # Requests cannot be pipelined. A sender must await the preceding response.
   fail()
  except BlockingIOError:pass
 def receive(self,on_idle):
  data=bytearray();deadline=None
  while True:
   self.check();on_idle()
   if deadline is not None and time.monotonic()>=deadline:fail()
   ready,_,_=select.select([self.sock],[],[],0.2)
   if not ready:continue
   chunk=self.sock.recv(MAX+1-len(data))
   if not chunk:fail()
   if not data:deadline=time.monotonic()+5
   data.extend(chunk)
   if len(data)>MAX:fail()
   if b'\n' in data:
    if data.count(b'\n')!=1 or data[-1:]!=b'\n':fail()
    self.live_and_idle();return bytes(data)
 def send(self,data):
  self.check();self.sock.settimeout(2)
  try:self.sock.sendall(data)
  finally:self.sock.setblocking(False)
  self.check()
 def close(self):self.sock.close()

def terminal(owner,watch):
 # Serialize against the watcher pump and stop sender. The patched pump checks
 # _stop after acquiring the mutex, so it cannot touch FD3 after terminal ACK.
 if not watch._send_gate.acquire(timeout=2):fail()
 try:
  with watch._mutex:
   watch._check();watch._sample()
   with owner._lock:
    owner._owner.finish_reviewed()
    watch._stop.set();watch._close_requested.set()
 finally:watch._send_gate.release()
 watch.close()

def _send_live(channel,owner,watch,request,outcome):
 # Serialize the final proof/response boundary with the running pump. A
 # transport failure or owner loss is UNKNOWN; the parent must also bind its
 # received response to the still-live FD3 session.
 with watch._mutex:
  watch._check()
  if not watch._thread or not watch._thread.is_alive():fail()
  watch._sample();owner.assert_live();channel.live_and_idle()
  channel.send(response(request,outcome));watch._check()

def _serve(channel,owner,open_watch):
 """Internal. Dependency injection is for closed synthetic tests only."""
 tx=owner._owner.transaction;expected=1;state='created';watch=None;finished=False;request=None
 try:
  while True:
   def idle():
    owner.assert_live()
    if watch is not None:
     watch._check()
     if not watch._thread or not watch._thread.is_alive():fail()
   request=parse_request(channel.receive(idle),tx,expected,state)
   owner.assert_live();channel.live_and_idle()
   if request['op']=='open':
    watch,slot=open_watch(owner);watch.assert_continuity();owner.assert_live();channel.live_and_idle()
    state='active';outcome='WATCH_OPEN'
   elif request['op']=='check':
    watch.assert_continuity();owner.assert_live();channel.live_and_idle();outcome='WATCH_OK'
   else:
    channel.live_and_idle();terminal(owner,watch);finished=True;state='finished';outcome='WATCH_FINISHED'
   if finished:channel.send(response(request,outcome))
   else:_send_live(channel,owner,watch,request,outcome)
   expected+=1;request=None
   if finished:return
 except BaseException:
  try:owner.mark_unknown()
  except BaseException:pass
  if request is not None:
   try:channel.send(response(request,'UNKNOWN'))
   except BaseException:pass
  fail()
 finally:
  if watch is not None and not finished:
   try:watch.close()
   except BaseException:pass
  try:channel.close()
  except BaseException:pass

def _run_owned_from_inherited_fds():
 """Private capability: caller must already authenticate this launcher.
 Uses only inherited fd3 owner and fd4 control channel, and fixed source pins.
 """
 owner_module=load('worker_owned_fd3','../journal-owner-child.py')
 watch_module=load('worker_owned_watch','continuous_watch.py')
 identity=load('worker_owned_identity','current_identity.py')
 raw_owner=owner_module._open_inherited_fd3()
 owner=watch_module.SerializedOwner(raw_owner)
 try:
  channel=_UnixChannel(raw_owner)
  return _serve(channel,owner,lambda same:identity._open_owned_current_watch(same,watch_module))
 except BaseException:
  try:owner.mark_unknown()
  except BaseException:pass
  fail()

def open_production_worker_session(*_args,**_kwargs):fail()
if __name__=='__main__':raise SystemExit('DISABLED')
