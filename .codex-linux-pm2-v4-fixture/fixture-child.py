"""Disposable synthetic worker child. No PM2 endpoints or production paths."""
import importlib.util,os,pathlib,socket,subprocess,sys,time,types
HERE=pathlib.Path(__file__).resolve().parent
def module(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=module('identity','current_identity.py');owner=module('owner','journal-owner-child.py')._open_inherited_fd3()
children=[];fds={};sockets=[]
try:
 for _ in range(2):children.append(subprocess.Popen(['/usr/bin/python3','-I','-S','-B','-c','import sys;sys.stdin.read()'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True))
 rows=[]
 for child,pmid in zip(children,(18,19)):
  parent,start=m.stat_fields(pathlib.Path('/proc/%d/stat'%child.pid).read_bytes());assert parent==os.getpid()
  fd=os.pidfd_open(child.pid,0);fds[child.pid]=fd;assert m._pidfd_active(fd)
  rows.append((child.pid,start,pmid,parent,'/synthetic/current',b'synthetic-release-1',b'a'*40,b'/data/web/shared/runtime/synthetic'))
 rows=tuple(sorted(rows));slots={r[2]:{'pm_id':r[2],'pid':r[0],'unique_id':'synthetic_'+str(r[2]),'status':'online'} for r in rows}
 evidence=m._attest(owner,lambda:(rows,'/synthetic/current'),lambda:slots,fds,rows)
 assert evidence['releaseReady'] is False
 children[0].stdin.close();children[0].wait(timeout=5)
 try:m._attest(owner,lambda:(rows,'/synthetic/current'),lambda:slots,fds,rows)
 except m.CurrentIdentityError as exc:assert str(exc)=='CURRENT_SLOT_OR_PIDFD_CHANGED'
 else:raise RuntimeError('E_DEAD_PIDFD_ACCEPTED')
 children[1].stdin.close();children[1].wait(timeout=5)
 pub,pub_peer=socket.socketpair();rpc,rpc_peer=socket.socketpair();sockets=[pub,pub_peer,rpc,rpc_peer]
 class BrokenSelector:
  def close(self):raise OSError('synthetic selector failure')
 fd_values=list(fds.values())
 runtime=m._CurrentRuntime.__new__(m._CurrentRuntime);runtime.closed=False;runtime.monitor=None
 runtime.inner=types.SimpleNamespace(selector=BrokenSelector(),sock=pub,rpc_sock=rpc);runtime.pidfds=fds
 try:runtime.close()
 except m.CurrentIdentityError as exc:assert str(exc)=='CURRENT_CLOSE_UNKNOWN'
 else:raise RuntimeError('E_CLOSE_ERROR_IGNORED')
 assert pub.fileno()==-1 and rpc.fileno()==-1 and not runtime.pidfds
 for fd in fd_values:
  try:os.fstat(fd)
  except OSError:pass
  else:raise RuntimeError('E_PIDFD_LEAK')
 owner.checkpoint('worker-exact-stop-observed',{'syntheticPidfdExited':True,'ownedSocketsClosed':True,'releaseReady':False})
 while True:time.sleep(1)
finally:
 for sock in sockets:sock.close()
 for child in children:
  if child.stdin and not child.stdin.closed:child.stdin.close()
  if child.poll() is None:child.kill()
  child.wait(timeout=5)
