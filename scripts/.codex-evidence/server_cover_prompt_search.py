import os,json,re,hashlib,time

roots=['/data/web/releases','/data/direct-deploy/build-r888-4d92a5eee1f6','/data/direct-deploy/artifacts','/data/builds/zimeiti-f5299d2','/data/agent-hub/repo','/data/build-artifacts','/data/web/cleanup-preserved-20261007']
pruned={'node_modules','.git','env','secrets','uploads','logs','voice-platform','assets','avatars','model-brands','cover-presets','.pnpm-store','cache'}
pattern=re.compile('好运降临|哈尼有话讲|文案核心摘要|标题提炼规则|拆解口播|内在逻辑|VIRAL_TITLE_RULE|buildFunnyCartoonPrompt|extractCoreSummary')
out={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'readOnly':True,'roots':roots,'filesInspected':0,'bytesInspected':0,'matches':[],'errors':[]}
seen={}
for root in roots:
 if not os.path.isdir(root):continue
 for base,dirs,files in os.walk(root,followlinks=False):
  dirs[:]=[d for d in dirs if d not in pruned and not os.path.islink(os.path.join(base,d))]
  for name in files:
   if not name.endswith(('.js','.mjs','.cjs','.tsx','.ts','.json','.md','.txt','.map','.html')):continue
   if any(v in name.lower() for v in ['.env','secret','credential','token','ecosystem','package-lock','pnpm-lock']):continue
   p=os.path.join(base,name)
   if os.path.islink(p):continue
   try:
    size=os.path.getsize(p)
    if size>12000000:continue
    data=open(p,'rb').read();out['filesInspected']+=1;out['bytesInspected']+=len(data)
    if not any(x in data for x in [k.encode() for k in ['好运降临','哈尼有话讲','文案核心摘要','标题提炼规则','拆解口播','内在逻辑','VIRAL_TITLE_RULE','buildFunnyCartoonPrompt','extractCoreSummary']]):continue
    digest=hashlib.sha256(data).hexdigest()
    if digest in seen:out['matches'][seen[digest]]['identicalPaths'].append(p);continue
    text=data.decode('utf-8',errors='replace');matches=list(pattern.finditer(text));snips=[]
    for m in matches[:8]:
     snippet=text[max(0,m.start()-100):m.end()+600]
     snippet=re.sub(r'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[REDACTED_JWT]',snippet)
     snippet=re.sub(r'\bsk-[A-Za-z0-9_-]{12,}','[REDACTED_KEY]',snippet)
     snippet=re.sub(r'(?i)((?:api_?key|password|secret|token)\s*[:=]\s*[\"\x27])[^\"\x27\n]*',r'\1[REDACTED]',snippet)
     snips.append({'term':m.group(),'offset':m.start(),'line':text.count('\n',0,m.start())+1,'text':snippet})
    seen[digest]=len(out['matches']);out['matches'].append({'path':p,'identicalPaths':[],'bytes':size,'sha256':digest,'terms':sorted(set(m.group() for m in matches)),'hitCount':len(matches),'snippets':snips})
   except Exception as e:out['errors'].append({'path':p,'errorType':type(e).__name__})
print(json.dumps(out,ensure_ascii=False))
