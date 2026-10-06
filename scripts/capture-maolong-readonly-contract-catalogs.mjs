import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {request as playwrightRequest} from 'playwright';

const ORIGIN='https://maolong.da-ai.cc';
const SESSION_FILE='F:/总项目文件/Skill存储系统/01_网页开发项目/带货Agent/runtime/maolong-auth-session.json';
const OUTPUT_ROOT=process.env.MAOLONG_CAPTURE_ROOT;
const NETWORK_PROXY=process.env.MAOLONG_CAPTURE_PROXY||'http://127.0.0.1:7897';
const BODY_LIMIT=10*1024*1024;
const ENDPOINTS=[
  '/api/v1/tools/image-generation/skill-packs',
  '/api/v1/video-creator/skills',
  '/api/v1/model-routes/public',
  '/api/v1/agent/skills',
  '/api/v1/characters/tags',
  '/api/v1/voice-profiles/system-voices',
  '/api/v1/discover/home',
  '/api/v1/public/settings',
  '/api/v1/resources',
  '/api/v1/canvas-group-templates',
];
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();

function redactString(value){
  let result=value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu,'Bearer [REDACTED_TOKEN]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,'[REDACTED_EMAIL]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu,'[REDACTED_PHONE]');
  try{
    const url=new URL(result);
    if(url.search){const querySha256=sha256(url.search);url.search='';url.hash='';result=`${url.href}?query_sha256=${querySha256}`;}
  }catch{/* Ordinary text, not a URL. */}
  return result;
}

function sanitize(value,key=''){
  if(/token|password|secret|authorization|cookie|api[_-]?key|storage[_-]?key/iu.test(key))return '[REDACTED]';
  if(typeof value==='string')return redactString(value);
  if(Array.isArray(value))return value.map(item=>sanitize(item));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([childKey,child])=>[childKey,sanitize(child,childKey)]));
  return value;
}

async function writeAtomic(file,bytes){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=`${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary,bytes,{flag:'wx'});
  await fs.rename(temporary,file);
}

if(!OUTPUT_ROOT)throw Error('MAOLONG_CAPTURE_ROOT is required');
const root=path.resolve(OUTPUT_ROOT);
const manifestPath=path.join(root,'manifest.json');
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
if(manifest?.kind!=='authorized-readonly-live-client-mirror'||manifest?.origin!==ORIGIN)throw Error('OUTPUT_ROOT is not an authorized mirror root');
const session=JSON.parse(await fs.readFile(SESSION_FILE,'utf8'));
if(typeof session.accessToken!=='string'||!session.accessToken)throw Error('Authorized session access token is unavailable');

const client=await playwrightRequest.newContext({
  baseURL:ORIGIN,
  proxy:{server:NETWORK_PROXY},
  extraHTTPHeaders:{Authorization:`Bearer ${session.accessToken}`,Accept:'application/json'},
});
const captured=[];
try{
  for(const endpoint of ENDPOINTS){
    const response=await client.get(endpoint,{timeout:30_000});
    const bytes=await response.body();
    if(bytes.length>BODY_LIMIT)throw Error(`${endpoint}: body exceeds ${BODY_LIMIT} bytes`);
    let parsed;
    try{parsed=JSON.parse(bytes.toString('utf8'));}catch{parsed={nonJsonBody:redactString(bytes.toString('utf8').slice(0,20_000))};}
    const sanitized=sanitize(parsed);
    const output=Buffer.from(`${JSON.stringify(sanitized,null,2)}\n`);
    const name=endpoint.replace(/^\/api\/v1\//u,'').replace(/[^a-z0-9]+/giu,'-').replace(/^-|-$/gu,'');
    const relative=`supplemental-readonly/catalogs/${name}.json`;
    await writeAtomic(path.join(root,relative),output);
    captured.push({
      method:'GET',
      endpoint,
      status:response.status(),
      ok:response.ok(),
      contentType:String(response.headers()['content-type']||'').split(';')[0],
      savedPath:relative,
      bytes:output.length,
      sha256:sha256(output),
      capturedAt:now(),
    });
  }
}finally{await client.dispose();}

const receipt={
  schemaVersion:1,
  kind:'authorized-readonly-contract-catalog-capture',
  origin:ORIGIN,
  capturedAt:now(),
  requestMethods:['GET'],
  businessWriteRequestsAllowed:0,
  authenticationRefreshCount:0,
  bodyLimitBytes:BODY_LIMIT,
  catalogs:captured,
};
const receiptBytes=Buffer.from(`${JSON.stringify(receipt,null,2)}\n`);
await writeAtomic(path.join(root,'supplemental-readonly/catalog-receipt.json'),receiptBytes);
console.log(JSON.stringify({
  ok:captured.every(item=>item.ok),
  captured:captured.length,
  successful:captured.filter(item=>item.ok).length,
  failed:captured.filter(item=>!item.ok).map(item=>({endpoint:item.endpoint,status:item.status})),
  receiptSha256:sha256(receiptBytes),
  effects:{getRequests:captured.length,writeRequests:0,businessWrites:0,paidGeneration:0},
},null,2));
