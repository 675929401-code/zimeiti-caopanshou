import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {spawnSync} from 'node:child_process';
import {Archive,bytesHash,hash,safeFailure,validatePortable} from './agent-catalog-release-core.mjs';
import {PRODUCTION_ORIGIN,checkedAuthority,verifyVersion} from './agent-catalog-release-readers.mjs';
import {validateReleaseManifest,validateProductionIndex,expectedManifestIndex} from './agent-catalog-release-gate.mjs';
const CREDENTIAL_ROOT='F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/controlled-credentials';
const CREDENTIAL_FILE=path.join(CREDENTIAL_ROOT,'platform-admin-675929401.v1.credential.clixml');
const METADATA_FILE=path.join(CREDENTIAL_ROOT,'platform-admin-675929401.v1.metadata.json');
const ACCOUNT_HASH='302f8567f281fe324eadff8d8b184c6252e72f575671905887f9157c0cb4e8e2';
const OWNER_ID='b5cccb94-1d77-4e14-9391-fb3e6f823486';
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,160}$/u,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
function demand(ok,code){if(!ok)throw new Error(code);}
function exactQuery(url,keys){demand(url.searchParams.size===keys.length&&keys.every(k=>url.searchParams.getAll(k).length===1)&&[...url.searchParams.keys()].every(k=>keys.includes(k)),'OWNER_UNAPPROVED_QUERY');}
export function createCatalogRequestPolicy(options){
 const o=JSON.parse(JSON.stringify(options));checkedAuthority(o.authority);demand(['read','publish'].includes(o.mode)&&Array.isArray(o.scopeIds)&&new Set(o.scopeIds).size===o.scopeIds.length&&o.scopeIds.every(id=>ID.test(id)),'OWNER_EXACT_SCOPE_REQUIRED');
 const ids=new Set(o.scopeIds),receipts=new Set(o.pendingKeys??[]),previews=new Map(),used=new Set();demand([...receipts].every(k=>UUID.test(k)),'OWNER_PENDING_KEYS_INVALID');
 if(o.mode==='publish')validateReleaseManifest(o.manifest,{expectedHash:o.expectedManifestHash,approval:o.approval,scopeIds:o.scopeIds,requireWrite:true});
 function validate(req){
  demand(req&&Object.keys(req).every(k=>['method','path','body'].includes(k))&&typeof req.path==='string'&&req.path.startsWith('/api/')&&!req.path.startsWith('//'),'OWNER_UNAPPROVED_REQUEST');
  const u=new URL(req.path,PRODUCTION_ORIGIN);demand(u.origin===PRODUCTION_ORIGIN&&!u.username&&!u.password&&!u.hash,'OWNER_UNAPPROVED_ORIGIN');
  if(req.method==='GET'){
   demand(req.body===undefined,'OWNER_GET_BODY_FORBIDDEN');
   if(['/api/version','/api/auth/me','/api/admin/access-control/self'].includes(u.pathname)){exactQuery(u,[]);return;}
   demand(u.pathname==='/api/admin/agent-catalog-publications','OWNER_UNAPPROVED_READ_ROUTE');
   if(u.searchParams.get('view')==='index'){exactQuery(u,['view']);return;}
   if(u.searchParams.has('requestKey')){exactQuery(u,['requestKey']);demand(receipts.has(u.searchParams.get('requestKey')),'OWNER_UNAPPROVED_RECEIPT_KEY');return;}
   exactQuery(u,['agentId','view']);demand(ids.has(u.searchParams.get('agentId'))&&['source','hashes'].includes(u.searchParams.get('view')),'OWNER_UNAPPROVED_CARD_READ');return;
  }
  demand(o.mode==='publish'&&req.method==='POST'&&u.pathname==='/api/admin/agent-catalog-publications'&&!u.search,'OWNER_CONFIGURATION_WRITES_DISABLED');
  const raw=req.body;demand(raw&&['plan','apply'].includes(raw.action),'OWNER_NATIVE_PUBLICATION_ONLY');
  const parsed=validatePortable(raw.source,raw.baseline,raw.requestKey,raw.audience,raw.lifecycle??'executable',raw.stripPortability??[]);
  const action=o.manifest.actions.find(a=>a.id===parsed.source.id);
  demand(ids.has(parsed.source.id)&&action&&['create','update'].includes(action.operation)&&action.local.revision===parsed.source.revision&&action.local.hash===parsed.source.sourceHash&&action.audience===parsed.audience&&(action.lifecycle??'executable')===parsed.lifecycle&&hash(action.stripPortability??[])===hash(parsed.stripPortability??[])&&hash(action.production)===hash(parsed.baseline),'OWNER_FROZEN_MANIFEST_MISMATCH');
  demand(Object.keys(raw).every(k=>['action','source','baseline','requestKey','audience','lifecycle','stripPortability','planHash'].includes(k)),'OWNER_UNAPPROVED_BODY_FIELDS');
  if(raw.action==='apply'){
   const p=previews.get(raw.requestKey);demand(p&&!used.has(raw.requestKey)&&p.planHash===raw.planHash&&p.bodyHash===hash({...raw,action:'plan',planHash:undefined}),'OWNER_PREVIEW_TOKEN_REQUIRED');
   used.add(raw.requestKey);receipts.add(raw.requestKey);
  }else demand(!Object.hasOwn(raw,'planHash')&&!previews.has(raw.requestKey)&&!used.has(raw.requestKey),'OWNER_DUPLICATE_PLAN_KEY');
 }
 function observe(req,response){
  if(req.method==='GET'&&new URL(req.path,PRODUCTION_ORIGIN).searchParams.has('requestKey')&&response.status===200&&response.body?.receipt)demand(ids.has(response.body.receipt.id),'OWNER_UNAPPROVED_RECEIPT_SCOPE');
  if(req.method==='POST'&&req.body.action==='plan'&&response.status===200&&response.body?.ok===true){
   const p=response.body.plan;demand(p?.eligible===true&&p.id===req.body.source.id&&p.requestKey===req.body.requestKey&&p.sourceHash===req.body.source.sourceHash&&/^[a-f0-9]{64}$/u.test(p.planHash),'OWNER_NATIVE_PREVIEW_INVALID');
   previews.set(req.body.requestKey,{planHash:p.planHash,bodyHash:hash(req.body)});receipts.add(req.body.requestKey);
  }
 }
 return {validate,observe};
}
export function verifyCatalogOwnerSelf(body,mode,now=Date.now()){
 const a=body?.access,s=body?.stepUp,required=['backups.manage','agents.view','prompts.view','models.manage','internal_tools.manage',...(mode==='publish'?['agents.manage','prompts.edit']:[])];
 demand(a?.adminLevel==='super_admin'&&a.authorityStatus==='ready'&&a.integrityValid===true&&a.profileActive===true&&Number.isSafeInteger(a.revision)&&a.revision>0&&typeof a.checksum==='string'&&a.checksum!=='legacy-schema-absent'&&a.checksum.length>0,'NORMAL_LEGITIMATE_OWNER_REQUIRED');
 demand(Array.isArray(a.permissionKeys)&&required.every(p=>a.permissionKeys.includes(p)),'NORMAL_OWNER_CAPABILITY_MISSING');
 demand(body.maintenanceLock?.status==='ready'&&body.maintenanceLock.enabled===false,'NORMAL_OWNER_MAINTENANCE_LOCKED');
 demand(s?.status==='ready'&&s.authMethod==='login_password'&&typeof s.sessionId==='string'&&s.sessionId.length>0&&Date.parse(s.expiresAt)>now+60000,'NORMAL_OWNER_STEPUP_REQUIRED');
 return {ownerVerified:true,adminLevel:'super_admin',authorityRevision:a.revision,stepUpExpiresAt:s.expiresAt};
}
function regular(file){const s=fs.lstatSync(file);demand(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'REGISTERED_CREDENTIAL_FILE_REQUIRED');}
async function loadRegisteredOwnerCredentials(){
 regular(METADATA_FILE);regular(CREDENTIAL_FILE);const metadata=JSON.parse(fs.readFileSync(METADATA_FILE,'utf8').replace(/^\uFEFF/u,''));
 demand(bytesHash(metadata.account??'')===ACCOUNT_HASH&&metadata.encryption==='Windows DPAPI CurrentUser'&&path.resolve(metadata.credentialPath??'')===path.resolve(CREDENTIAL_FILE),'REGISTERED_CREDENTIAL_METADATA_MISMATCH');
 const file=CREDENTIAL_FILE.replace(/'/gu,"''"),script=`$ErrorActionPreference='Stop';$c=Import-Clixml -LiteralPath '${file}';@{username=$c.UserName;password=$c.GetNetworkCredential().Password}|ConvertTo-Json -Compress`;
 const env={...process.env,PSModulePath:path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')};
 const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,encoding:'utf8',windowsHide:true,maxBuffer:65536});
 let value;try{demand(child.status===0,'REGISTERED_DPAPI_READ_FAILED');value=JSON.parse(child.stdout.replace(/^\uFEFF/u,''));}catch{throw new Error('REGISTERED_DPAPI_READ_FAILED');}finally{child.stdout='';child.stderr='';}
 if(bytesHash(value.username??'')!==ACCOUNT_HASH||typeof value.password!=='string'||!value.password){if(value)value.password='';throw new Error('REGISTERED_CREDENTIAL_IDENTITY_MISMATCH');}return value;
}
function createCatalogHttpsRequester(){
 const cookies=new Map();let closed=false;
 async function request({method,path:route,body}){
  demand(!closed,'OWNER_SESSION_CLOSED');const u=new URL(route,PRODUCTION_ORIGIN);demand(u.origin===PRODUCTION_ORIGIN&&!u.username&&!u.password&&!u.hash,'OWNER_UNAPPROVED_ORIGIN');
  const text=body===undefined?undefined:JSON.stringify(body),headers={Accept:'application/json','Cache-Control':'no-store',Origin:PRODUCTION_ORIGIN,Referer:PRODUCTION_ORIGIN+'/admin','Sec-Fetch-Site':'same-origin'};
  if(text!==undefined){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(text);}if(cookies.size)headers.Cookie=[...cookies].map(([k,v])=>k+'='+v).join('; ');
  return new Promise((resolve,reject)=>{
   const req=https.request({hostname:'zyuani8.com',servername:'zyuani8.com',port:443,path:u.pathname+u.search,method,headers,rejectUnauthorized:true,agent:false},response=>{
    if(response.statusCode>=300&&response.statusCode<400){response.resume();reject(new Error('OWNER_REDIRECT_FORBIDDEN'));return;}
    const chunks=[];let length=0;response.on('data',chunk=>{length+=chunk.length;if(length>8*1024*1024){req.destroy();reject(new Error('OWNER_RESPONSE_TOO_LARGE'));return;}chunks.push(chunk);});
    response.on('error',()=>reject(new Error('HTTP_OUTCOME_UNKNOWN_NO_RETRY')));
    response.on('end',()=>{for(const raw of response.headers['set-cookie']??[]){const first=raw.split(';',1)[0],n=first.indexOf('='),key=first.slice(0,n);if(n>0&&['auth_token','zimeiti_admin_step_up'].includes(key))cookies.set(key,first.slice(n+1));}
     let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reject(new Error('OWNER_RESPONSE_UNREADABLE_NO_RETRY'));return;}resolve({status:response.statusCode,body:result});});
   });req.setTimeout(25000,()=>req.destroy(new Error('OWNER_TIMEOUT_NO_RETRY')));req.on('error',()=>reject(new Error('HTTP_OUTCOME_UNKNOWN_NO_RETRY')));if(text!==undefined)req.write(text);req.end();
  });
 }
 return {request,hasAuthCookie:()=>cookies.has('auth_token'),close(){closed=true;cookies.clear();}};
}
function responseDemand(response,predicate,code){
 if(response?.status===200&&predicate(response.body))return;
 const error=new Error(code);error.httpStatus=response?.status;
 if(typeof response?.body?.code==='string'&&/^[A-Z][A-Z0-9_]{2,100}$/u.test(response.body.code))error.officialCode=response.body.code;throw error;
}
export function createCatalogOwnerFactory({loadCredentials=loadRegisteredOwnerCredentials,requesterFactory=createCatalogHttpsRequester,clock=()=>Date.now()}={}){
 demand((loadCredentials===loadRegisteredOwnerCredentials)===(requesterFactory===createCatalogHttpsRequester),'OWNER_TEST_DEPENDENCIES_MUST_BE_PAIRED');
 return async function withCatalogOwner(options,execute){
  const frozen=JSON.parse(JSON.stringify(options)),policy=createCatalogRequestPolicy(frozen),http=requesterFactory();let credentials,open=false,owner;
  const pending=[],stats={loginRequests:0,stepUpRequests:0,configurationApplyRequests:0,providerCalls:0,billingEvidence:'configuration-only'};
  try{
   const expected=frozen.mode==='publish'?expectedManifestIndex({state:new Archive(frozen.archiveRoot).load(),manifest:frozen.manifest,manifestHash:frozen.expectedManifestHash}):null;
   if(expected)demand(hash(checkedAuthority(frozen.authority))===hash(expected.identity),'OWNER_MANIFEST_AUTHORITY_MISMATCH');
   await verifyVersion(http.request,frozen.authority);credentials=await loadCredentials();stats.loginRequests++;
   let login=await http.request({method:'POST',path:'/api/auth/login',body:{username:credentials.username,password:credentials.password}});
   responseDemand(login,b=>b.success===true&&b.user?.id===OWNER_ID&&b.user?.role==='admin'&&http.hasAuthCookie(),'NORMAL_REGISTERED_OWNER_LOGIN_NOT_CONFIRMED');login=null;
   const me=await http.request({method:'GET',path:'/api/auth/me'});responseDemand(me,b=>(b.user?.id??b.id)===OWNER_ID,'NORMAL_OWNER_IDENTITY_MISMATCH');
   stats.stepUpRequests++;const unlock=await http.request({method:'POST',path:'/api/admin/access-control/unlock',body:{password:credentials.password,mode:'login',durationMinutes:10}});credentials.password='';credentials=null;
   responseDemand(unlock,b=>b.success===true&&b.authMethod==='login_password','NORMAL_OWNER_STEPUP_NOT_CONFIRMED');
   const self=await http.request({method:'GET',path:'/api/admin/access-control/self'});responseDemand(self,()=>true,'NORMAL_OWNER_SELF_UNAVAILABLE');owner=verifyCatalogOwnerSelf(self.body,frozen.mode,clock());
   const index=await http.request({method:'GET',path:'/api/admin/agent-catalog-publications?view=index'});responseDemand(index,b=>b.ok===true,'NORMAL_OWNER_INDEX_PREFLIGHT_FAILED');validateProductionIndex(index.body.index);
   demand(clock()-Date.parse(index.body.index.observedAt)<=600000,'NORMAL_OWNER_COMPLETE_INDEX_EXPIRED');
   if(expected)demand(index.body.index.inventoryHash===expected.inventoryHash,'OWNER_MANIFEST_COMPLETE_INDEX_DRIFT');
   open=true;
   const request=req=>{const bound=JSON.parse(JSON.stringify(req));const operation=(async()=>{
    demand(open&&Date.parse(owner.stepUpExpiresAt)>clock()+30000,'EXISTING_OWNER_SESSION_EXPIRED_NO_REAUTH');policy.validate(bound);
    if(bound.method==='POST'&&bound.body.action==='apply')stats.configurationApplyRequests++;
    const result=await http.request(bound);policy.observe(bound,result);return result;
   })();pending.push(operation);operation.catch(()=>{});return operation;};
   const result=await execute(request,owner);open=false;await Promise.allSettled(pending);await verifyVersion(http.request,frozen.authority);
   return result&&typeof result==='object'?{...result,ownerSession:stats}:{result,ownerSession:stats};
  }catch(error){const safe=safeFailure(error),out=new Error(safe.code);out.httpStatus=safe.httpStatus;out.officialCode=safe.officialCode;out.safeStatus=stats;throw out;}
  finally{open=false;await Promise.allSettled(pending);if(credentials)credentials.password='';http.close();}
 };
}
export const withCatalogOwner=createCatalogOwnerFactory();
