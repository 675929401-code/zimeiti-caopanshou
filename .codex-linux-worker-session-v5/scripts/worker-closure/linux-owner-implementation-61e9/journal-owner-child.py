"""Child-side owner protocol; created only by a verified Node parent.

No public production constructor exists. Socket fd is inherited from the
parent; peer credentials, parent PID and strict sequence bind this process.
"""
import json,os,re,socket,struct,time
class OwnerChannelError(RuntimeError):pass
def fail(code):raise OwnerChannelError(code) from None
def _pairs(pairs):
 obj={}
 for key,value in pairs:
  if key in obj:fail('OWNER_RESPONSE_INVALID')
  obj[key]=value
 return obj
class _ChildJournalOwner:
 def __init__(self,sock,transaction,parent_pid,nonce):
  if type(parent_pid) is not int or parent_pid<=1 or type(nonce) is not str or not re.fullmatch('[a-f0-9]{64}',nonce):fail('OWNER_BINDING_INVALID')
  if type(transaction) is not str or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}',transaction):fail('OWNER_BINDING_INVALID')
  self.sock,self.transaction,self.parent,self.nonce=sock,transaction,parent_pid,nonce
  self.child=os.getpid();self.seq=0;self.poisoned=False;self.deadline=None
  self._peer()
 def _peer(self):
  if self.poisoned or os.getpid()!=self.child or os.getppid()!=self.parent:fail('OWNER_SESSION_LOST')
  peer=struct.unpack('3i',self.sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if peer[0]!=self.parent or peer[1]!=0:fail('OWNER_PEER_INVALID')
 def _call(self,op,body):
  if self.poisoned:fail('OWNER_SESSION_LOST')
  try:
   self._peer();self.seq+=1;seq=self.seq
   request={'seq':seq,'transactionId':self.transaction,'nonce':self.nonce,'op':op,'body':body}
   data=(json.dumps(request,separators=(',',':'),ensure_ascii=True)+'\n').encode('ascii')
   if len(data)>8192:fail('OWNER_INPUT_LIMIT')
   deadline=min(time.monotonic()+5,self.deadline) if self.deadline is not None else time.monotonic()+5
   remaining=deadline-time.monotonic()
   if remaining<=0:fail('OWNER_DEADLINE')
   self.sock.settimeout(remaining);self.sock.sendall(data);self._peer()
   buf=bytearray()
   while True:
    remaining=deadline-time.monotonic()
    if remaining<=0:fail('OWNER_DEADLINE')
    self.sock.settimeout(remaining)
    chunk=self.sock.recv(8193-len(buf))
    if not chunk:fail('OWNER_EOF')
    buf.extend(chunk)
    if len(buf)>8192:fail('OWNER_OUTPUT_LIMIT')
    i=buf.find(b'\n')
    if i<0:continue
    if i!=len(buf)-1:fail('OWNER_TRAILING_OUTPUT')
    response=json.loads(bytes(buf[:i]).decode('utf8'),object_pairs_hook=_pairs)
    if type(response) is not dict or set(response)!={'seq','transactionId','nonce','op','outcome'} or type(response['seq']) is not int or response!={'seq':seq,'transactionId':self.transaction,'nonce':self.nonce,'op':op,'outcome':'OK'}:fail('OWNER_RESPONSE_INVALID')
    self._peer()
    self.sock.setblocking(False)
    try:
     if self.sock.recv(1,socket.MSG_PEEK)!=b'':fail('OWNER_TRAILING_OUTPUT')
     fail('OWNER_EOF')
    except BlockingIOError:pass
    if time.monotonic()>=deadline:fail('OWNER_DEADLINE')
    self._peer();return None
  except BaseException:
   self.poisoned=True
   try:self.sock.close()
   except OSError:pass
   fail('OWNER_OUTCOME_UNKNOWN')
 def set_deadline(self,deadline):
  if deadline is not None and (type(deadline) not in (int,float) or not 0<deadline<=time.monotonic()+5):fail('OWNER_DEADLINE_INVALID')
  self.deadline=deadline
 def assert_live(self):return self._call('assert_live',{})
 def assert_bound(self):return self._call('assert_bound',{})
 def verify_file(self,path,sha256):return self._call('verify_file',{'path':path,'sha256':sha256})
 def checkpoint(self,phase,details):return self._call('checkpoint',{'phase':phase,'details':details})
 def mark_unknown(self):return self._call('mark_unknown',{})
 def finish_reviewed(self):
  self._call('terminal',{})
  self.poisoned=True
  self.sock.close()

def _open_inherited_fd3():
 if os.getppid()<=1:fail('OWNER_PARENT_INVALID')
 sock=None
 try:
  sock=socket.socket(fileno=3);deadline=time.monotonic()+5;buf=bytearray()
  while True:
   remaining=deadline-time.monotonic()
   if remaining<=0:fail('OWNER_HELLO_TIMEOUT')
   sock.settimeout(remaining);raw=sock.recv(1025-len(buf))
   if not raw:fail('OWNER_HELLO_EOF')
   buf.extend(raw)
   if len(buf)>1024:fail('OWNER_HELLO_LIMIT')
   i=buf.find(b'\n')
   if i>=0:
    if i!=len(buf)-1:fail('OWNER_HELLO_INVALID')
    value=json.loads(bytes(buf[:i]).decode('utf8'),object_pairs_hook=_pairs)
    if type(value) is not dict or set(value)!={'type','transactionId','nonce'} or value['type']!='owner-ready':fail('OWNER_HELLO_INVALID')
    return _ChildJournalOwner(sock,value['transactionId'],os.getppid(),value['nonce'])
 except BaseException:
  if sock is not None:
   try:sock.close()
   except OSError:pass
  fail('OWNER_HELLO_UNKNOWN')

def open_production_child_owner(*_args,**_kwargs):fail('OWNER_AUTHENTICATED_PARENT_NOT_CONNECTED')
