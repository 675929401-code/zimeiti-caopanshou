SOURCE = b"import hashlib,os,re,stat\nfrom pathlib import Path\nAPP=Path('/data/web')\nCURRENT=APP/'current-web'\nRELEASE_ID=b'candidate-704b8278e562-r30'\nOLD_COMMIT=b'704b8278e562d1048526d1abdc35801500e904b0'\nENV_KEYS={b'name',b'MEDIA_QUEUE_WORKER_PROCESS',b'RELEASE_ID',b'DEPLOY_COMMIT_SHA',b'COMMERCE_DATA_DIR',b'pm_id',b'shutdown_with_message',b'kill_timeout',b'MEDIA_QUEUE_WORKER_DRAIN_MS'}\nclass ProbeError(Exception):pass\ndef fail(code):raise ProbeError(code)\ndef read_file(path,limit):\n    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))\n    with os.fdopen(fd,'rb') as f:\n        info=os.fstat(f.fileno())\n        if not stat.S_ISREG(info.st_mode) or info.st_size>limit:fail('E_READ')\n        data=f.read(limit+1)\n    if len(data)>limit:fail('E_LIMIT')\n    return data\ndef parse_env(raw):\n    result={}\n    for entry in raw.split(b'\\0'):\n        name,sep,value=entry.partition(b'=')\n        if sep and name in ENV_KEYS:\n            if name in result:fail('E_ENV_DUPLICATE')\n            result[name]=value\n    return result\ndef socket_counts(entry):\n    inodes=set();seen=0\n    for fd in (entry/'fd').iterdir():\n        seen+=1\n        if seen>4096:fail('E_FD_LIMIT')\n        try:target=os.readlink(fd)\n        except FileNotFoundError:continue\n        match=re.fullmatch(r'socket:\\[(\\d+)\\]',target)\n        if match:inodes.add(match[1])\n    established=set();listening=set()\n    for name in ('tcp','tcp6'):\n        data=read_file(entry/'net'/name,2097152)\n        for row in data.splitlines()[1:]:\n            parts=row.split()\n            if len(parts)<10:fail('E_SOCKET_FORMAT')\n            inode=parts[9].decode('ascii')\n            if inode in inodes:\n                if parts[3]==b'01':established.add(inode)\n                elif parts[3]==b'0A':listening.add(inode)\n    return len(inodes),len(established),len(listening)\ndef processes():\n    rows=[];identities=[];paths=set();errors=0;scanned=0;budget=16777216\n    current=Path(os.path.realpath(CURRENT))\n    boot=read_file(Path('/proc/sys/kernel/random/boot_id'),128).strip()\n    for entry in Path('/proc').iterdir():\n        if not entry.name.isdigit():continue\n        scanned+=1\n        if scanned>8192 or budget<=0:fail('E_PROC_LIMIT')\n        try:\n            try:exe=os.readlink(entry/'exe')\n            except FileNotFoundError:continue\n            if not re.search(r'/node(?:-v[0-9.]+)?$',exe):continue\n            env_raw=read_file(entry/'environ',262144);budget-=len(env_raw);env=parse_env(env_raw);del env_raw\n            if env.get(b'name')!=b'agent-hub-media-worker':continue\n            raw=read_file(entry/'stat',8192);fields=raw.rsplit(b')',1)[1].split();start=int(fields[19]);pid=int(entry.name)\n            cwd=Path(os.path.realpath(entry/'cwd'))\n            sockets,established,listening=socket_counts(entry)\n            env_dir=env.get(b'COMMERCE_DATA_DIR')\n            if env_dir:paths.add(os.fsdecode(env_dir))\n            ident=(pid,start,env.get(b'pm_id',b''),str(cwd),env.get(b'RELEASE_ID',b''))\n            identities.append(ident)\n            rows.append({'process_identity_sha':hashlib.sha256(boot+b'\\0'+repr(ident).encode('utf-8')).hexdigest(),\n                'role_flag_matches':env.get(b'MEDIA_QUEUE_WORKER_PROCESS')==b'1','release_matches':env.get(b'RELEASE_ID')==RELEASE_ID,\n                'commit_matches':env.get(b'DEPLOY_COMMIT_SHA')==OLD_COMMIT,'cwd_matches_current':cwd==current,\n                'pm2_id_present':bool(re.fullmatch(rb'[0-9]{1,8}',env.get(b'pm_id',b''))),\n                'process_sleeping':fields[0]==b'S','socket_fds':sockets,'tcp_established':established,'tcp_listening':listening,\n                'shutdown_message_enabled':env.get(b'shutdown_with_message') in (b'true',b'1'),\n                'runtime_inflight_observed':False,'fresh_drained_observed':False})\n            if len(rows)>2:fail('E_WORKER_COUNT')\n        except (FileNotFoundError,ProcessLookupError):errors+=1\n    rows.sort(key=lambda r:r['process_identity_sha'])\n    return {'worker_count':len(rows),'scan_races':errors,'scan_complete':errors==0,'workers':rows},sorted(identities),paths,str(current)\n"
PINS = {'package.json': 'a5db229cf8806fdb487cd0a09c85dd8e07ada7da360982ca2fb37da465105eec', 'lib/API.js': 'f1baa90fce2b07ede805b981b38efbe177e19b293bf626a20997e412aa93f581', 'lib/God/ForkMode.js': '20d39f6227dd6968f5a93e10f3c678bba98f35281d7862870277ff285c4d3be2', 'lib/God/ActionMethods.js': '4fc5442ff948a0e61d147629e8ff584de417b7fa6ba013791c7ada706ba2f96e', 'lib/Client.js': '535b4b98bdba8251ddd5480f71f327c89393dbfa28f00c568a74ba5984162a7b', 'modules/pm2-axon/lib/sockets/sub-emitter.js': 'd1ea077daf1968114fd834bbf2d354b7eea2529788d20cfdd117d9cdb17d5e1a', 'modules/pm2-axon/lib/sockets/sub.js': '6865c3a57f9dfdbe7ded63dccf4a3a56eff5dd673d8952b6bd1376c5214a6304', 'modules/pm2-axon/lib/sockets/sock.js': '50de3ac2b20647094ac06b4ccbf4bd3591778ac41e847cb167d2d1c342dfdd54', 'modules/pm2-axon/lib/sockets/pub-emitter.js': '9f8e94b8ce978c265b36a49a3b765e6cdf2d8f78ebbceff3b037f81b544c7a7b', 'modules/pm2-axon/lib/sockets/pub.js': 'c16de05ba9578e16c1c7741be56b00c36fc2accd0e362eb53d3385aaed8bd3ae', 'node_modules/amp-message/index.js': '7215025169eb555640d6de3e0b99a600d7af04d6fabf65389bec65afbc47142e', 'node_modules/amp/lib/encode.js': '6b3be5fd8f6ed5af1fb56f8cdf0b5d91eec515e6a9cca2ef117812753fb9aaf1', 'node_modules/amp/lib/decode.js': '53070d736cdc23c16e46e91ba2b78aa45d8d60131b52af2e25ee9525c30f76fa', 'node_modules/amp/lib/stream.js': '151e262054bb7435af73a0049190ed9e53d5055acbc336921089c5b5817474d5'}
"""Receive-only bounded PM2 pub observer. No PM2 module/API, RPC, send or retry."""
import hashlib,json,os,re,selectors,signal,socket,stat,struct,sys,time
from pathlib import Path

EXPECTED={'30cf8a49d038f2fcdcd264a870f97e63c323da57633049422fd06f76c3d1700e','607d349a373b4aa51d648d6c75365006cd4c148bd4a931859941f5d128eaa953'}
EXPECTED_IDS={(1078213,23507424,b'18'),(1078214,23507425,b'19')}
PUB='/root/.pm2/pub.sock'
MODULE='/usr/local/lib/node_modules/pm2'
ERRORS={'E_PLATFORM','E_PIN','E_METADATA','E_BINDING','E_DAEMON','E_SOCKET','E_PEER','E_CONNECT','E_DISCONNECT','E_FRAME','E_LIMIT','E_DRIFT','E_INTERNAL'}
class Failure(Exception):pass
def fail(code):raise Failure(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def stamp(m):return (m.st_dev,m.st_ino,m.st_mode,m.st_uid,m.st_gid,m.st_size,m.st_mtime_ns,m.st_ctime_ns)
def trusted(path,kind='file'):
    path=Path(path);cur=Path('/');private=False
    for part in path.parts[1:]:
        cur/=part;m=os.lstat(cur)
        if stat.S_ISLNK(m.st_mode) or m.st_uid!=0:fail('E_METADATA')
        if cur!=path or kind!='socket':
            if m.st_mode&0o022:fail('E_METADATA')
        if stat.S_ISDIR(m.st_mode) and m.st_mode&0o077==0:private=True
    if kind=='socket':
        if not stat.S_ISSOCK(m.st_mode) or not (private or m.st_mode&0o077==0):fail('E_SOCKET')
    elif not stat.S_ISREG(m.st_mode):fail('E_METADATA')
    return m
def read(path,limit,proc=False):
    if not proc:trusted(path)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        a=os.fstat(f.fileno())
        if not stat.S_ISREG(a.st_mode) or a.st_size>limit:fail('E_LIMIT')
        raw=f.read(limit+1);b=os.fstat(f.fileno())
    if len(raw)>limit:fail('E_LIMIT')
    if stamp(a)!=stamp(b):fail('E_DRIFT')
    return raw
def source_check():
    for name,digest in PINS.items():
        if sha(read(MODULE+'/'+name,1048576))!=digest:fail('E_PIN')
def proc_fields(pid):
    tail=read('/proc/'+str(pid)+'/stat',8192,True).rsplit(b')',1)[1].split()
    return int(tail[1]),int(tail[19])
def instance_binding(ns):
    info,idents,paths,current=ns['processes']()
    if not info['scan_complete'] or info['worker_count']!=2 or {r['process_identity_sha'] for r in info['workers']}!=EXPECTED:fail('E_BINDING')
    if {(x[0],x[1],x[2]) for x in idents}!=EXPECTED_IDS:fail('E_BINDING')
    if not all(all(r[k] for k in ['role_flag_matches','release_matches','commit_matches','cwd_matches_current','pm2_id_present','shutdown_message_enabled']) for r in info['workers']):fail('E_BINDING')
    parents={proc_fields(x[0])[0] for x in idents}
    if len(parents)!=1:fail('E_DAEMON')
    daemon=next(iter(parents))
    if daemon<=1 or os.stat('/proc/'+str(daemon)).st_uid!=0:fail('E_DAEMON')
    _,start=proc_fields(daemon)
    cmd=read('/proc/'+str(daemon)+'/cmdline',65536,True).rstrip(b'\0')
    if cmd!=b'PM2 v7.0.1: God Daemon (/root/.pm2)':fail('E_DAEMON')
    meta=trusted(PUB,'socket')
    rows=[]
    for line in read('/proc/net/unix',2097152,True).splitlines()[1:]:
        fields=line.split()
        if len(fields)==8 and fields[7]==PUB.encode():
            if fields[3]!=b'00010000' or fields[4]!=b'0001':fail('E_SOCKET')
            rows.append(int(fields[6]))
    if len(rows)!=1:fail('E_SOCKET')
    inode=rows[0];owns=False;count=0
    for fd in Path('/proc/'+str(daemon)+'/fd').iterdir():
        count+=1
        if count>4096:fail('E_LIMIT')
        try:target=os.readlink(fd)
        except FileNotFoundError:continue
        if target=='socket:['+str(inode)+']':owns=True
    if not owns:fail('E_SOCKET')
    return {'idents':idents,'paths':paths,'current':current,'daemon':daemon,'start':start,'cmd_sha':sha(cmd),'socket_stat':stamp(meta),'kernel_inode':inode}

class Frames:
    def __init__(self):self.buffer=bytearray();self.total=0;self.frames=0
    def feed(self,data):
        self.total+=len(data)
        if self.total>4194304 or len(self.buffer)+len(data)>1114112:fail('E_LIMIT')
        self.buffer.extend(data);result=[]
        while self.buffer:
            header=self.buffer[0];argc=header&15
            if header>>4!=1:fail('E_FRAME')
            pos=1;parts=[];incomplete=False
            for _ in range(argc):
                if len(self.buffer)<pos+4:incomplete=True;break
                length=int.from_bytes(self.buffer[pos:pos+4],'big');pos+=4
                if length>1048576 or pos+length>1048576:fail('E_LIMIT')
                if len(self.buffer)<pos+length:incomplete=True;break
                parts.append(bytes(self.buffer[pos:pos+length]));pos+=length
            if incomplete:break
            self.frames+=1
            if self.frames>10000:fail('E_LIMIT')
            result.append(parts);del self.buffer[:pos]
        return result

def no_duplicates(items):
    out={}
    for k,v in items:
        if k in out:fail('E_FRAME')
        out[k]=v
    return out
def parse_json(raw):return json.loads(raw,object_pairs_hook=no_duplicates,parse_constant=lambda _:fail('E_FRAME'))
class Events:
    def __init__(self):
        self.rows={i:{'log_chunks':0,'drained_true':0,'drained_false':0,'invalid_stop_marker':0,'process_events':0} for i in (18,19)}
        self.carry={18:'',19:''};self.discarding={18:False,19:False};self.ignored=0
    def line(self,pmid,line):
        marker='[MediaQueueWorker] stopped'
        if marker not in line:return
        # Only this fixed runtime-generated suffix can be a stop observation.
        match=re.fullmatch(r"(?:[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.,][0-9]{1,3})?(?:Z|[+-][0-9]{2}:?[0-9]{2})?: )?\[MediaQueueWorker\] stopped \{ reason: 'pm2-shutdown', drained: (true|false) \}\s*",line)
        if match:self.rows[pmid]['drained_'+match[1]]+=1
        else:self.rows[pmid]['invalid_stop_marker']+=1
    def accept(self,parts):
        if len(parts)!=2 or parts[0] not in (b's:log:out',b's:process:event'):
            self.ignored+=1;return
        if not parts[1].startswith(b'j:'):fail('E_FRAME')
        try:packet=parse_json(parts[1][2:])
        except (ValueError,RecursionError,UnicodeError):fail('E_FRAME')
        if type(packet) is not dict or type(packet.get('process')) is not dict:fail('E_FRAME')
        proc=packet['process'];pmid=proc.get('pm_id')
        if type(pmid) is not int or pmid not in (18,19) or proc.get('name')!='agent-hub-media-worker':self.ignored+=1;return
        if parts[0]==b's:process:event':self.rows[pmid]['process_events']+=1;return
        data=packet.get('data')
        if type(data) is not str or len(data)>262144:fail('E_FRAME')
        self.rows[pmid]['log_chunks']+=1
        # PM2 json formatting wraps each original chunk in one JSON envelope.
        if data.lstrip().startswith('{'):
            try:wrapped=parse_json(data)
            except (ValueError,RecursionError,UnicodeError):wrapped=None
            if type(wrapped) is dict and type(wrapped.get('message')) is str:data=wrapped['message']
        for chunk in data.splitlines(keepends=True):
            newline=chunk.endswith(('\n','\r'))
            if self.discarding[pmid]:
                if newline:self.discarding[pmid]=False
                continue
            text=self.carry[pmid]+chunk
            if len(text)>8192:
                self.carry[pmid]='';self.discarding[pmid]=not newline;continue
            if newline:self.line(pmid,text.rstrip('\r\n'));self.carry[pmid]=''
            else:self.carry[pmid]=text

def observe(binding,binding_check,socket_factory=socket.socket,selector_factory=selectors.DefaultSelector,clock=time.monotonic):
    frames=Frames();events=Events();sock=socket_factory(socket.AF_UNIX,socket.SOCK_STREAM)
    connected=False;peer_ok=False;started=clock();deadline=started+20;next_check=started
    try:
        sock.settimeout(2)
        try:sock.connect(PUB)
        except OSError:fail('E_CONNECT')
        connected=True
        peer=sock.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i'))
        peer_pid,peer_uid,peer_gid=struct.unpack('3i',peer)
        if peer_pid!=binding['daemon'] or peer_uid!=0:fail('E_PEER')
        peer_ok=True
        if binding_check()!=binding:fail('E_DRIFT')
        sock.setblocking(False)
        with selector_factory() as selector:
            selector.register(sock,selectors.EVENT_READ)
            while clock()<deadline:
                if clock()>=next_check:
                    if binding_check()!=binding:fail('E_DRIFT')
                    next_check=clock()+2
                for _,_mask in selector.select(min(.25,max(0,deadline-clock()))):
                    try:data=sock.recv(65536)
                    except BlockingIOError:continue
                    if not data:fail('E_DISCONNECT')
                    for parts in frames.feed(data):events.accept(parts)
        if binding_check()!=binding:fail('E_DRIFT')
        # An unfinished frame or line cannot count as any drain receipt.
        return {'connected':connected,'peer_verified':peer_ok,'identity_stable':True,'observation_complete':True,
                'bytes_received':frames.total,'frames_received':frames.frames,'ignored_frames':events.ignored,
                'partial_frame_at_end':bool(frames.buffer),'partial_log_at_end':any(events.carry.values()),
                'workers':[{'pm_id':i,**row} for i,row in events.rows.items()],
                'bytes_sent':0,'service_actions':0,'business_writes':0,'media_requests':0,
                'fresh_requested_drain_proven':False,'safe_to_stop':False}
    finally:sock.close()

def main():
    if sys.platform!='linux':return {'available':False,'error':'E_PLATFORM','observation':None}
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_FSIZE,(0,0))
        resource.setrlimit(resource.RLIMIT_AS,(268435456,268435456));resource.setrlimit(resource.RLIMIT_CPU,(10,10))
        signal.signal(signal.SIGALRM,lambda *_:fail('E_LIMIT'));signal.alarm(35)
        source_check();ns={'__name__':'fixed_bus_proc'};exec(compile(SOURCE,'<pinned-proc>','exec'),ns)
        binding=instance_binding(ns)
        result=observe(binding,lambda:instance_binding(ns));source_check()
        return {'available':True,'error':'OK','observation':result}
    except Exception as exc:
        return {'available':False,'error':str(exc) if isinstance(exc,Failure) and str(exc) in ERRORS else 'E_INTERNAL','observation':None}
    finally:signal.alarm(0)
if __name__=='__main__':print(json.dumps(main(),sort_keys=True))
