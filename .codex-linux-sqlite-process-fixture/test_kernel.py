import json,os,pathlib,signal,socket,sys,tempfile,threading,time,unittest
import process
if sys.platform!='linux':raise SystemExit('Linux required')
PYTHON='/usr/bin/python3'
class KernelFixture(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def helper(self,name,script):
  p=self.root/name;p.write_text(script,encoding='utf8');return str(p)
 def test_fd_closed_success(self):
  a,b=socket.socketpair();os.set_inheritable(a.fileno(),True);target=os.readlink('/proc/self/fd/%d'%a.fileno())
  ns=os.readlink('/proc/self/ns/mnt');mounts=pathlib.Path('/proc/self/mountinfo').read_bytes()
  done=threading.Event();t=threading.Thread(target=lambda:done.wait(5));t.start()
  code='import os,json,sys\nsys.stdin.buffer.read()\ntarget='+repr(target)+'\ntry:v=os.readlink("/proc/self/fd/'+str(a.fileno())+'")\nexcept OSError:v="missing"\np=os.fork()\nif p==0:\n try:w=os.readlink("/proc/self/fd/'+str(a.fileno())+'")\n except OSError:w="missing"\n os._exit(1 if w==target else 0)\n_,s=os.waitpid(p,0)\nprint(json.dumps({"inherited":v==target,"grandchild_clean":os.WIFEXITED(s) and os.WEXITSTATUS(s)==0}))\n'
  try:
   self.assertEqual(process._run_clean(PYTHON,self.helper('fd.py',code),'unused','unused',2),{'inherited':False,'grandchild_clean':True})
   self.assertEqual(ns,os.readlink('/proc/self/ns/mnt'));self.assertEqual(mounts,pathlib.Path('/proc/self/mountinfo').read_bytes())
  finally:done.set();t.join(2);a.close();b.close()
 def test_oversized_stdout_rejected(self):
  code='import sys\nsys.stdin.buffer.read()\nsys.stdout.write("x"*200000);sys.stdout.flush()\n'
  with self.assertRaisesRegex(process.SQLiteWindowError,'SQLITE_CHILD_FAILED'):process._run_clean(PYTHON,self.helper('huge.py',code),'unused','unused',2)
 def test_timeout_kills_owned_process_group(self):
  pidfile=self.root/'child.json'
  code='import json,os,sys,time\nsys.stdin.buffer.read()\np=os.fork()\nif p==0:\n stat=open("/proc/self/stat").read().rsplit(")",1)[1].split()\n open('+repr(str(pidfile))+',"w").write(json.dumps({"pid":os.getpid(),"start":stat[19],"group":os.getpgrp(),"parent":os.getppid()}))\n while True:time.sleep(1)\nwhile True:time.sleep(1)\n'
  try:
   start=time.monotonic()
   with self.assertRaisesRegex(process.SQLiteWindowError,'SQLITE_CHILD_FAILED'):process._run_clean(PYTHON,self.helper('hung.py',code),'unused','unused',1)
   self.assertLess(time.monotonic()-start,3);self.assertTrue(pidfile.exists());identity=json.loads(pidfile.read_text());pid=identity['pid']
   deadline=time.monotonic()+2
   while time.monotonic()<deadline:
    try:stat=pathlib.Path('/proc/%d/stat'%pid).read_text().rsplit(')',1)[1].split()
    except FileNotFoundError:break
    if stat[0]=='Z':break
    time.sleep(.02)
   else:self.fail('owned descendant remains running')
  finally:
   # Independent fallback: only an extant original fixture child in its own
   # distinct process group, matched by start ticks, is eligible for cleanup.
   try:
    identity=json.loads(pidfile.read_text());pid=identity['pid'];group=identity['group']
    fd=os.pidfd_open(pid,0)
    try:
     stat=pathlib.Path('/proc/%d/stat'%pid).read_text().rsplit(')',1)[1].split()
     if stat[0]!='Z' and stat[19]==identity['start'] and os.getpgid(pid)==group and group==identity['parent'] and group!=os.getpgrp():os.killpg(group,signal.SIGKILL)
    finally:os.close(fd)
   except (OSError,ValueError,KeyError,json.JSONDecodeError):pass
if __name__=='__main__':unittest.main()
