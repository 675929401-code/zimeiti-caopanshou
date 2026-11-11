import os,re,json,time,urllib.request,urllib.parse,subprocess,hashlib
out={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'readOnly':True,'databaseWrites':0,'sources':[]}
ss=subprocess.run(['ss','-ltnp','sport = :5000'],capture_output=True,text=True,timeout=5).stdout
pids=re.findall(r'pid=(\d+)',ss)
if not pids:raise RuntimeError('VERIFIED_PORT_5000_PID_REQUIRED')
pid=pids[0];cwd=os.path.realpath('/proc/'+pid+'/cwd');out['process']={'pid':int(pid),'cwd':cwd}
if not cwd.startswith('/data/web/releases/'):raise RuntimeError('CURRENT_RELEASE_PROCESS_REQUIRED')
env={}
for item in open('/proc/'+pid+'/environ','rb').read().split(b'\0'):
 if b'=' in item:
  k,v=item.split(b'=',1);env[k.decode(errors='replace')]=v.decode(errors='replace')
needed=['COZE_SUPABASE_URL','COZE_SUPABASE_SERVICE_ROLE_KEY','SHARED_CONFIGURATION_ENABLED','SHARED_CONFIGURATION_SUPABASE_URL','SHARED_CONFIGURATION_SERVICE_ROLE_KEY']
if any(not env.get(k) for k in needed[:2]):
 for line in open('/data/web/shared/env/.env.local',encoding='utf-8'):
  m=re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$',line)
  if m and m.group(1) in needed and not env.get(m.group(1)):
   env[m.group(1)]=m.group(2).strip('"\x27')
bindings=[('business',env.get('COZE_SUPABASE_URL'),env.get('COZE_SUPABASE_SERVICE_ROLE_KEY'))]
if env.get('SHARED_CONFIGURATION_ENABLED')=='1':bindings.append(('shared_configuration',env.get('SHARED_CONFIGURATION_SUPABASE_URL'),env.get('SHARED_CONFIGURATION_SERVICE_ROLE_KEY')))
seen=set()
for label,base,key in bindings:
 if not base or not key:raise RuntimeError('CONTROLLED_DATABASE_BINDING_MISSING')
 identity=(base,key)
 if identity in seen:continue
 seen.add(identity)
 def read(table,select,filters=None):
  rows=[]
  for offset in range(0,15000,500):
   q={'select':select,'limit':'500','offset':str(offset),'order':'id.asc'};q.update(filters or {})
   url=base.rstrip('/')+'/rest/v1/'+table+'?'+urllib.parse.urlencode(q)
   req=urllib.request.Request(url,headers={'apikey':key,'Authorization':'Bearer '+key,'Cache-Control':'no-store'},method='GET')
   with urllib.request.urlopen(req,timeout=20) as response:part=json.load(response)
   rows.extend(part)
   if len(part)<500:return rows
  raise RuntimeError('READ_INVENTORY_BOUND_EXCEEDED')
 source={'label':label,'databaseHost':urllib.parse.urlparse(base).hostname,'candidates':[]}
 agents=read('agents','id,name,description,system_prompt')
 versions=read('prompt_versions','id,agent_id,prompt,created_at')
 names={x['id']:x['name'] for x in agents}
 source.update({'agentCount':len(agents),'promptVersionCount':len(versions)})
 for row,kind in [(dict(x,agent_id=x['id'],prompt=x.get('system_prompt','')),'agent') for x in agents]+[(dict(x,name=names.get(x['agent_id'])),'version') for x in versions]:
  prompt=str(row.get('prompt') or '');joined=str(row.get('name') or '')+'\n'+prompt
  if not re.search('好运降临|哈尼有话讲|封面|内在逻辑',joined):continue
  hits=list(re.finditer('好运降临|哈尼有话讲|封面|摘要|重点|内在逻辑|口播|标题',joined))
  focus=list(re.finditer('好运降临|哈尼有话讲|封面|内在逻辑',joined))
  snippets=[]
  for m in focus[:5]:
   s=joined[max(0,m.start()-70):m.end()+280]
   s=re.sub(r'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[REDACTED_JWT]',s)
   s=re.sub(r'\bsk-[A-Za-z0-9_-]{12,}','[REDACTED_KEY]',s)
   snippets.append(s)
  source['candidates'].append({'kind':kind,'id':row['id'],'agentId':row['agent_id'],'name':row.get('name'),'createdAt':row.get('created_at'),'length':len(prompt),'sha256':hashlib.sha256(prompt.encode()).hexdigest(),'terms':sorted(set(m.group() for m in hits)),'snippets':snippets})
 try:
  settings=read('platform_settings','id,setting_key,setting_value',{'or':'(setting_key.ilike.*cover*,setting_key.ilike.*prompt*,setting_key.ilike.*封面*)'})
  source['settings']=[{'key':x['setting_key'],'valueType':type(x.get('setting_value')).__name__,'textLength':len(str(x.get('setting_value'))),'containsBenchmark':bool(re.search('好运降临|哈尼有话讲',str(x.get('setting_value'))))} for x in settings]
 except Exception as e:source['settingsReadErrorType']=type(e).__name__
 out['sources'].append(source)
print(json.dumps(out,ensure_ascii=False))
