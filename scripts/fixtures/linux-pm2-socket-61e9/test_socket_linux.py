"""Real non-production AF_UNIX regression. Temporary socket, independent child.

Never calls probe.main/instance_binding/source_check or connects /root/.pm2.
Run on Linux with python3 -I -S -B test_socket_linux.py. No external network.
"""
import importlib.util,json,os,re,selectors,signal,socket,struct,subprocess,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent

def emit(value):print(json.dumps(value,sort_keys=True),flush=True)
def server(path):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as listener:
        listener.bind(path);listener.listen(2)
        inode=int(re.fullmatch(r'socket:\[([0-9]+)\]',os.readlink('/proc/self/fd/'+str(listener.fileno())))[1])
        emit({'pid':os.getpid(),'inode':inode})
        with listener.accept()[0] as accepted:
            accepted_inode=int(re.fullmatch(r'socket:\[([0-9]+)\]',os.readlink('/proc/self/fd/'+str(accepted.fileno())))[1])
            emit({'accepted_inode':accepted_inode})
            assert sys.stdin.readline()=='close-listener\n'
            listener.close();emit({'listener_closed':True})
            assert sys.stdin.readline()=='finish\n'

def line(child):
    with selectors.DefaultSelector() as sel:
        sel.register(child.stdout,selectors.EVENT_READ)
        if not sel.select(5):raise AssertionError('E_FIXTURE_TIMEOUT')
        raw=child.stdout.readline(4097)
    if not raw or len(raw)>4096:raise AssertionError('E_FIXTURE_OUTPUT')
    return json.loads(raw)

def fixture():
    if sys.platform!='linux' or not hasattr(socket,'AF_UNIX'):
        emit({'available':False,'error':'E_LINUX_REQUIRED'});return 77
    signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(TimeoutError('E_FIXTURE_TIMEOUT')));signal.alarm(30)
    spec=importlib.util.spec_from_file_location('offline_socket_probe',ROOT/'bus_probe.py');probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
    with tempfile.TemporaryDirectory(prefix='pm2-pub-fixture-') as directory:
        target=str(Path(directory)/'pub.sock')
        assert target!=probe.PUB and target.startswith(directory+'/')
        child=subprocess.Popen([sys.executable,'-I','-S','-B',str(Path(__file__).resolve()),'--fixture-server',target],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},close_fds=True)
        try:
            first=line(child);pid=first['pid'];inode=first['inode']
            assert pid==child.pid and pid!=os.getpid()
            raw=Path('/proc/net/unix').read_bytes()
            assert probe.listener_inode(raw,target)==inode
            assert probe.daemon_owns_inode(pid,inode)
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
                client.settimeout(2);client.connect(target)
                peer_pid,peer_uid,_=struct.unpack('3i',client.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))
                assert peer_pid==pid and peer_uid==os.getuid()
                second=line(child);accepted_inode=second['accepted_inode']
                assert accepted_inode!=inode
                raw=Path('/proc/net/unix').read_bytes()
                rows=[r.split() for r in raw.splitlines()[1:] if r.split()[-1:]==[target.encode()]]
                assert len(rows)>=2
                assert any(r[3]==b'00010000' and int(r[6])==inode for r in rows)
                assert any(r[3]==b'00000000' and int(r[6])==accepted_inode for r in rows)
                assert probe.listener_inode(raw,target)==inode
                assert probe.daemon_owns_inode(pid,inode)
                assert not probe.daemon_owns_inode(os.getpid(),inode)
                # Reproduce the exact old bug against real kernel rows.
                old_would_reject=any(r[3]!=b'00010000' or r[4]!=b'0001' for r in rows)
                assert old_would_reject
                # Remove only the synthetic listener, keep accepted stream alive.
                child.stdin.write('close-listener\n');child.stdin.flush();assert line(child)=={'listener_closed':True}
                raw=Path('/proc/net/unix').read_bytes()
                try:probe.listener_inode(raw,target)
                except probe.Failure as exc:assert str(exc)=='E_SOCKET_LISTENER_NONE'
                else:raise AssertionError('E_ACCEPTED_WAS_LISTENER')
                child.stdin.write('finish\n');child.stdin.flush()
            assert child.wait(timeout=5)==0
            emit({'available':True,'real_listener_accepted_overlap':True,'old_bug_reproduced':True,'new_filter_passed':True,'accepted_only_rejected':True,'daemon_inode_ownership_verified':True,'wrong_owner_rejected':True,'peer_credentials_verified':True,'production_connections':0,'external_network_requests':0})
        finally:
            if child.poll() is None:child.kill();child.wait()
            child.stdin.close();child.stdout.close()
            signal.alarm(0)
    return 0

if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--fixture-server':server(sys.argv[2])
    elif len(sys.argv)==1:raise SystemExit(fixture())
    else:raise SystemExit(2)
