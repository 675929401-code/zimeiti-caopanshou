import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import {request as playwrightRequest} from 'playwright';

dotenv.config({path:path.resolve('.env.local'),quiet:true});
const sha=value=>crypto.createHash('sha256').update(String(value||'')).digest('hex').slice(0,12);
const outputArg=process.argv.find(value=>value.startsWith('--output='));
const output=outputArg?path.resolve(outputArg.slice('--output='.length)):null;
const localRuntimePath='F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const local=JSON.parse(await fs.readFile(localRuntimePath,'utf8'));
const sources=[
  {name:'shared-cloud',url:String(process.env.SHARED_CONFIGURATION_SUPABASE_URL||''),key:String(process.env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY||''),proxy:process.env.MAOLONG_CAPTURE_PROXY||'http://127.0.0.1:7897'},
  {name:'local-acceptance',url:String(local.supabaseUrl||''),key:String(local.serviceRoleKey||''),proxy:null},
];

async function inspect(source){
  const identity={name:source.name,urlOriginHash:sha(new URL(source.url).origin),keyHash:sha(source.key)};
  if(!source.url||!source.key)return {...identity,reachable:false,error:'credentials-missing',releases:[],counts:{total:0,draft:0,current:0,published:0},duplicateCurrent:false};
  let client;
  try{
    client=await playwrightRequest.newContext({baseURL:source.url,...(source.proxy?{proxy:{server:source.proxy}}:{})});
    const response=await client.get('/rest/v1/commerce_config_releases?select=id,release_version,status,is_current,manifest_sha256,created_at,published_at&order=release_version.desc',{headers:{apikey:source.key,Authorization:`Bearer ${source.key}`,Accept:'application/json'},timeout:30_000});
    const body=await response.json().catch(()=>null);
    if(!response.ok()||!Array.isArray(body))return {...identity,reachable:false,httpStatus:response.status(),error:'read-only-query-failed',releases:[],counts:{total:0,draft:0,current:0,published:0},duplicateCurrent:false};
    const releases=body.map(row=>({id:String(row.id),releaseVersion:Number(row.release_version),status:String(row.status),isCurrent:row.is_current===true,manifestSha256:String(row.manifest_sha256||''),createdAt:row.created_at||null,publishedAt:row.published_at||null}));
    const current=releases.filter(row=>row.isCurrent);
    return {...identity,reachable:true,releases,counts:{total:releases.length,draft:releases.filter(row=>row.status==='draft').length,current:current.length,published:releases.filter(row=>row.status==='published').length},duplicateCurrent:current.length>1};
  }catch(error){return {...identity,reachable:false,error:String(error?.message||error).replace(source.url,'[SOURCE_URL]').slice(0,300),releases:[],counts:{total:0,draft:0,current:0,published:0},duplicateCurrent:false};}
  finally{await client?.dispose().catch(()=>{});}
}

const inspected=[];
for(const source of sources)inspected.push(await inspect(source));
const report={
  schemaVersion:1,
  kind:'commerce-configuration-identity-readonly-audit',
  checkedAt:new Date().toISOString(),
  sources:inspected,
  identityConclusion:'shared-cloud 与 local-acceptance 是不同持久化身份；只能分别报告，不能把 release 数量串成同一时间线。',
  writes:0,
  providerCalls:0,
  paidGenerationCalls:0,
};
if(output){await fs.mkdir(path.dirname(output),{recursive:true});const temp=`${output}.${crypto.randomUUID()}.tmp`;await fs.writeFile(temp,`${JSON.stringify(report,null,2)}\n`,{encoding:'utf8',flag:'wx'});await fs.rename(temp,output);}
console.log(JSON.stringify(report,null,2));
