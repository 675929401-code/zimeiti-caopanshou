"""Fixed read-only config/source analysis. No child processes or network APIs."""
import fnmatch,hashlib,json,os,re,stat,sys
from pathlib import Path,PurePosixPath

MAIN='/www/server/nginx/conf/nginx.conf'
MAIN_SHA='7e92401fa9def89c44b4d865652ba7f39c375aa06c643a2437e4aabf03ff5192'
EXE='/www/server/nginx/sbin/nginx'
EXE_SHA='43d42476bf43e0d02352027d1d6df477308dba07ea172208de06ed6be9319a4c'
PM2='/usr/local/lib/node_modules/pm2'
PINS={'package.json':'a5db229cf8806fdb487cd0a09c85dd8e07ada7da360982ca2fb37da465105eec','lib/API.js':'f1baa90fce2b07ede805b981b38efbe177e19b293bf626a20997e412aa93f581','lib/God/ForkMode.js':'20d39f6227dd6968f5a93e10f3c678bba98f35281d7862870277ff285c4d3be2','lib/God/ActionMethods.js':'4fc5442ff948a0e61d147629e8ff584de417b7fa6ba013791c7ada706ba2f96e'}
ROOTS=('/www/server/nginx/conf','/www/server/panel/vhost/nginx','/www/server/panel/vhost/rewrite','/etc/nginx')
EXPECTED={'30cf8a49d038f2fcdcd264a870f97e63c323da57633049422fd06f76c3d1700e','607d349a373b4aa51d648d6c75365006cd4c148bd4a931859941f5d128eaa953'}
ERRORS={'E_PLATFORM','E_BINDING','E_PIN','E_PATH','E_FILE','E_LIMIT','E_LEX','E_PARSE','E_INCLUDE','E_CYCLE','E_DRIFT','E_INTERNAL'}
class Failure(Exception):pass
def fail(code):raise Failure(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def safe_path(value,pattern=False):
    allowed=r'/[A-Za-z0-9_./+@*?\[\]-]{1,240}' if pattern else r'/[A-Za-z0-9_./+@-]{1,240}'
    if not isinstance(value,str) or not re.fullmatch(allowed,value) or '..' in PurePosixPath(value).parts:fail('E_PATH')
    return value
def trusted(path,directory=False):
    path=Path(safe_path(str(path)));cur=Path('/')
    for part in path.parts[1:]:
        cur/=part;m=os.lstat(cur)
        if stat.S_ISLNK(m.st_mode) or m.st_uid!=0 or m.st_mode&0o022:fail('E_FILE')
    if not (stat.S_ISDIR(m.st_mode) if directory else stat.S_ISREG(m.st_mode)):fail('E_FILE')
def read(path,limit=1048576):
    trusted(path);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        a=os.fstat(f.fileno())
        if not stat.S_ISREG(a.st_mode) or a.st_size>limit:fail('E_LIMIT')
        raw=f.read(limit+1);b=os.fstat(f.fileno())
    if len(raw)>limit:fail('E_LIMIT')
    if (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)!=(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns):fail('E_DRIFT')
    return raw

def nginx_tokens(text):
    if len(text)>1048576:fail('E_LIMIT')
    out=[];word=[];i=0
    def flush():
        if word:out.append(('word',''.join(word)));word.clear()
    while i<len(text):
        c=text[i]
        if c=='\x00':fail('E_LEX')
        if c.isspace():flush();i+=1;continue
        if c=='#':flush();j=text.find('\n',i);i=len(text) if j<0 else j+1;continue
        if c in '{};':flush();out.append((c,c));i+=1;continue
        if c in '\"\'':
            quote=c;i+=1;word.append('')
            while i<len(text) and text[i]!=quote:
                if text[i]=='\\':
                    i+=1
                    if i==len(text):fail('E_LEX')
                word.append(text[i]);i+=1
            if i==len(text):fail('E_LEX')
            i+=1;continue
        if c=='\\':
            i+=1
            if i==len(text):fail('E_LEX')
            word.append(text[i]);i+=1;continue
        if text.startswith('${',i):
            end=text.find('}',i+2)
            if end<0:fail('E_LEX')
            word.append(text[i:end+1]);i=end+1;continue
        word.append(c);i+=1
        if len(out)>100000:fail('E_LIMIT')
    flush();return out

def nginx_parse(text):
    tokens=nginx_tokens(text);index=0
    def parse(block=False,depth=0):
        nonlocal index
        if depth>32:fail('E_LIMIT')
        result=[];words=[]
        while index<len(tokens):
            kind,value=tokens[index];index+=1
            if kind=='word':words.append(value);continue
            if kind=='}':
                if words or not block:fail('E_PARSE')
                return result
            if not words:fail('E_PARSE')
            if kind==';':result.append((words[0],words[1:],None));words=[]
            elif kind=='{':result.append((words[0],words[1:],parse(True,depth+1)));words=[]
        if words or block:fail('E_PARSE')
        return result
    return parse()

def include_pattern(value):
    if not value.startswith('/'):value=str(PurePosixPath(MAIN).parent/value)
    safe_path(value,True)
    if not any(value.startswith(root+'/') for root in ROOTS):fail('E_PATH')
    return value

def expand_glob(pattern):
    # Bound enumeration before materializing glob results; never recurse via **.
    if '**' in pattern:fail('E_INCLUDE')
    parts=PurePosixPath(pattern).parts[1:]
    if len(parts)>20:fail('E_LIMIT')
    candidates=['/'];examined=0
    for part in parts:
        nxt=[]
        for base in candidates:
            if any(c in part for c in '*?['):
                trusted(base,True)
                with os.scandir(base) as entries:
                    for e in entries:
                        examined+=1
                        if examined>16384:fail('E_LIMIT')
                        if fnmatch.fnmatchcase(e.name,part):
                            if e.is_symlink():fail('E_PATH')
                            nxt.append(str(PurePosixPath(base)/e.name))
                            if len(nxt)>256:fail('E_LIMIT')
            else:nxt.append(str(PurePosixPath(base)/part))
        candidates=nxt
    return sorted(candidates)

class Graph:
    def __init__(self,reader=read,globber=expand_glob):
        self.reader=reader;self.globber=globber;self.files={};self.edges=[];self.patterns={};self.server_sources={};self.budget=0;self.expansions=0
    def load(self,path=MAIN,stack=()):
        safe_path(path)
        if path in stack:fail('E_CYCLE')
        if len(stack)>16:fail('E_LIMIT')
        self.expansions+=1
        if self.expansions>512:fail('E_LIMIT')
        raw=self.reader(path)
        if len(raw)>1048576:fail('E_LIMIT')
        if path not in self.files:
            self.budget+=len(raw)
            if len(self.files)>=256 or self.budget>4194304:fail('E_LIMIT')
            self.files[path]=(sha(raw),len(raw))
        elif self.files[path]!=(sha(raw),len(raw)):fail('E_DRIFT')
        if path==MAIN and sha(raw)!=MAIN_SHA:fail('E_PIN')
        tree=nginx_parse(raw.decode('utf-8','strict'))
        def expand(nodes):
            out=[]
            for name,args,children in nodes:
                if name=='include':
                    if len(args)!=1 or children is not None:fail('E_INCLUDE')
                    pattern=include_pattern(args[0]);matches=self.globber(pattern)
                    if pattern in self.patterns and self.patterns[pattern]!=matches:fail('E_DRIFT')
                    self.patterns[pattern]=matches
                    if len(matches)>256:fail('E_LIMIT')
                    if not matches and not any(c in pattern for c in '*?['):fail('E_INCLUDE')
                    for match in matches:
                        if include_pattern(match)!=match:fail('E_PATH')
                        self.edges.append((path,match))
                        if len(self.edges)>1024:fail('E_LIMIT')
                        out.extend(self.load(match,stack+(path,)))
                else:
                    expanded=expand(children) if children is not None else None
                    if name=='server' and expanded is not None:self.server_sources[id(expanded)]=path
                    out.append((name,args,expanded))
            return out
        return expand(tree)
    def unchanged(self):
        for pattern,matches in self.patterns.items():
            if self.globber(pattern)!=matches:fail('E_DRIFT')
        for path,(digest,size) in self.files.items():
            raw=self.reader(path)
            if (sha(raw),len(raw))!=(digest,size):fail('E_DRIFT')

def summaries(tree,sources=None):
    servers=[]
    def walk(nodes):
        for name,args,children in nodes:
            if name=='server' and children is not None:servers.append(children)
            elif children is not None:walk(children)
    walk(tree)
    if len(servers)>256:fail('E_LIMIT')
    result=[]
    for nodes in servers:
        counts=dict.fromkeys(['locations','location_root','location_api','location_commerce','location_gateway','location_payment_notify','location_voice','regex_locations','proxy_loopback_web','proxy_loopback_voice','proxy_other_or_upstream','returns_503','includes_after_expansion'],0)
        names=[];ports=[]
        def each(items):
            for name,args,children in items:
                if name=='server_name':names.extend(args)
                if name=='listen' and args:
                    m=re.fullmatch(r'(?:[0-9.]+:|\[::\]:)?([0-9]{1,5})',args[0])
                    if m and 1<=int(m[1])<=65535:ports.append(int(m[1]))
                if name=='location':
                    counts['locations']+=1
                    if args and args[0] in ['~','~*']:counts['regex_locations']+=1
                    value=args[-1] if args else ''
                    key={'/':'location_root','/api/':'location_api','/api/commerce/':'location_commerce','/api/commerce-model-gateway':'location_gateway','/api/payment/notify':'location_payment_notify','/voice-platform/':'location_voice'}.get(value)
                    if key:counts[key]+=1
                if name=='proxy_pass':
                    target=args[0] if len(args)==1 else ''
                    key='proxy_loopback_web' if re.fullmatch(r'http://(?:127\.0\.0\.1|localhost):5000/?',target) else 'proxy_loopback_voice' if re.fullmatch(r'http://(?:127\.0\.0\.1|localhost):5001/?',target) else 'proxy_other_or_upstream'
                    counts[key]+=1
                if name=='return' and args and args[0]=='503':counts['returns_503']+=1
                if name=='include':counts['includes_after_expansion']+=1
                if children is not None:each(children)
        each(nodes)
        result.append({'config_file':(sources or {}).get(id(nodes),MAIN),'target_domain':any(n in ['zyuani8.com','www.zyuani8.com'] for n in names),'ports':sorted(set(ports)),'counts':counts})
    return result

def js_tokens(text):
    # Comments and quoted strings are distinct tokens: text in them cannot
    # impersonate a God.bus.emit expression. Template bodies are opaque.
    out=[];i=0;word_re=re.compile(r'[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+')
    while i<len(text):
        c=text[i]
        if c.isspace():i+=1;continue
        if text.startswith('//',i):j=text.find('\n',i);i=len(text) if j<0 else j+1;continue
        if text.startswith('/*',i):
            j=text.find('*/',i+2)
            if j<0:fail('E_LEX')
            i=j+2;continue
        if c=='/':
            prev=out[-1] if out else None
            can_regex=(prev is None or (prev[0]=='p' and prev[1] in '=(:,[!&|?{};~+*-%^<>') or
                       (prev[0]=='id' and prev[1] in ['return','throw','case','yield','await','else','do','typeof','void','delete','in','of','instanceof']))
            if can_regex:
                i+=1;in_class=False;closed=False
                while i<len(text):
                    if text[i] in '\r\n':fail('E_LEX')
                    if text[i]=='\\':i+=2;continue
                    if text[i]=='[':in_class=True
                    elif text[i]==']':in_class=False
                    elif text[i]=='/' and not in_class:i+=1;closed=True;break
                    i+=1
                if not closed:fail('E_LEX')
                while i<len(text) and text[i].isalpha():i+=1
                out.append(('regex',''));continue
        if c in '\"\'`':
            quote=c;buf=[];i+=1
            while i<len(text) and text[i]!=quote:
                if text[i]=='\\':
                    # Escape-bearing literal isn't accepted as a fixed event/key.
                    buf.append('\\');i+=1
                    if i==len(text):fail('E_LEX')
                buf.append(text[i]);i+=1
            if i==len(text):fail('E_LEX')
            out.append(('s' if quote!='`' else 'template',''.join(buf)));i+=1;continue
        m=word_re.match(text,i)
        if m:out.append(('id',m[0]));i+=len(m[0])
        else:out.append(('p',c));i+=1
        if len(out)>200000:fail('E_LIMIT')
    return out

def has_sequence(tokens,pattern):
    return any(tokens[i:i+len(pattern)]==pattern for i in range(len(tokens)-len(pattern)+1))
def syntax(pattern):return js_tokens(pattern)
def balanced(tokens,start):
    pairs={'{':'}','(':')','[':']'};opening=tokens[start][1]
    if tokens[start][0]!='p' or opening not in pairs:fail('E_PARSE')
    stack=[pairs[opening]]
    for i in range(start+1,len(tokens)):
        kind,value=tokens[i]
        if kind!='p':continue
        if value in pairs:stack.append(pairs[value])
        elif value in '})]':
            if not stack or stack.pop()!=value:fail('E_PARSE')
            if not stack:return i
    fail('E_PARSE')
def properties(tokens):
    if tokens[0]!=('p','{') or tokens[-1]!=('p','}'):fail('E_PARSE')
    props={};i=1
    while i<len(tokens)-1:
        if tokens[i]==('p',','):i+=1;continue
        kind,key=tokens[i]
        if kind not in ('id','s') or i+1>=len(tokens) or tokens[i+1]!=('p',':') or key in props:fail('E_PARSE')
        start=i+2;i=start
        while i<len(tokens)-1 and tokens[i]!=('p',','):
            if tokens[i] in [('p','{'),('p','('),('p','[')]:i=balanced(tokens,i)+1
            else:i+=1
        props[key]=tokens[start:i]
    return props
def bus_shape(source):
    tokens=js_tokens(source);prefix=syntax("God.bus.emit('log:out',")
    calls=[];pids=[]
    for i in range(len(tokens)-len(prefix)+1):
        if tokens[i:i+len(prefix)]!=prefix:continue
        start=i+len(prefix)
        if start>=len(tokens) or tokens[start]!=('p','{'):calls.append(False);continue
        end=balanced(tokens,start)
        if end+1>=len(tokens) or tokens[end+1]!=('p',')'):calls.append(False);continue
        try:
            outer=properties(tokens[start:end+1]);proc=properties(outer.get('process',[]))
            calls.append(all(proc.get(k)==syntax('pm2_env.'+k) for k in ['pm_id','name']) and 'data' in outer)
            pids.append('pid' in proc)
        except (Failure,IndexError):calls.append(False)
    return {'log_out_emit_count':len(calls),'all_log_out_pm_id_bound':bool(calls) and all(calls),'pid_directly_in_event':any(pids),'runtime_bus_observed':False,'bus_protocol_complete':False}

def function_body(source,name):
    tokens=js_tokens(source);prefix=syntax(name+' = function');found=[]
    for i in range(len(tokens)-len(prefix)):
        if tokens[i:i+len(prefix)]!=prefix:continue
        j=i+len(prefix)
        if tokens[j]!=('p','('):continue
        j=balanced(tokens,j)+1
        if tokens[j]!=('p','{'):continue
        end=balanced(tokens,j);found.append(tokens[j:end+1])
    return found[0] if len(found)==1 else []

def collect(ns):
    before,idents,paths,current=ns['processes']()
    if not before['scan_complete'] or before['worker_count']!=2 or {r['process_identity_sha'] for r in before['workers']}!=EXPECTED:fail('E_BINDING')
    if not all(all(r[k] for k in ['role_flag_matches','release_matches','commit_matches','cwd_matches_current','pm2_id_present']) for r in before['workers']):fail('E_BINDING')
    def nginx_identity():
        raw=ns['read_file']('/proc/810/stat',8192);start=int(raw.rsplit(b')',1)[1].split()[19])
        if start!=797 or os.path.realpath('/proc/810/exe')!=EXE or sha(read(EXE,67108864))!=EXE_SHA:fail('E_BINDING')
        return ns['read_file']('/proc/810/cmdline',65536)
    cmd=nginx_identity()
    if not cmd.startswith(b'nginx: master process '):fail('E_BINDING')
    graph=Graph();tree=graph.load();servers=summaries(tree,graph.server_sources)
    source={};source_rows=[]
    for name in list(PINS)+['lib/Client.js']:
        raw=read(PM2+'/'+name)
        if name in PINS and sha(raw)!=PINS[name]:fail('E_PIN')
        source[name]=raw.decode('utf-8','strict');source_rows.append({'file':name,'sha256':sha(raw),'previously_pinned':name in PINS})
    bus=bus_shape(source['lib/God/ForkMode.js'])
    api=function_body(source['lib/API.js'],'API.prototype.launchBus')
    client=function_body(source['lib/Client.js'],'Client.launchBus')
    bus.update(api_launchbus_body_found=bool(api),api_delegates_client=has_sequence(api,syntax('Client.launchBus(')),client_launchbus_body_found=bool(client),client_connects_pub_socket=has_sequence(client,syntax('this.sub.connect(this.pub_socket_file')),client_daemon_launch_marker=any(has_sequence(client,syntax(k+'(')) for k in ['launchDaemon','startDaemon','connectToDaemon']))
    graph.unchanged()
    for row in source_rows:
        if sha(read(PM2+'/'+row['file']))!=row['sha256']:fail('E_DRIFT')
    after,again,again_paths,again_current=ns['processes']()
    if not after['scan_complete'] or idents!=again or paths!=again_paths or current!=again_current or nginx_identity()!=cmd:fail('E_DRIFT')
    return {'files':[{'path':p,'sha256':h,'bytes':n} for p,(h,n) in sorted(graph.files.items())],'include_edges':len(graph.edges),'config_bytes':graph.budget,'servers':servers,'source_files':source_rows,'bus':bus,'instances_stable':True,'disk_include_graph_complete':True,'loaded_config_equals_disk_proven':False,'effective_ingress_verified':False,'safe_to_stop':False,'business_rows':0,'business_writes':0,'media_requests':0,'service_actions':0}

def main():
    if sys.platform!='linux':return {'available':False,'error':'E_PLATFORM','detail':None}
    try:
        ns={'__name__':'fixed_service_detail_proc'};exec(compile(SOURCE,'<fixed-proc>','exec'),ns)
        return {'available':True,'error':'OK','detail':collect(ns)}
    except Exception as exc:return {'available':False,'error':str(exc) if isinstance(exc,Failure) and str(exc) in ERRORS else 'E_INTERNAL','detail':None}
if __name__=='__main__':print(json.dumps(main(),sort_keys=True))
