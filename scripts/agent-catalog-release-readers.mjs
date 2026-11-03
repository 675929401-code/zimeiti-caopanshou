import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {Archive,PROJECT,hash,fields,bytesHash,exactDecimals,portableNested} from './agent-catalog-release-core.mjs';
const require=createRequire(path.join(PROJECT,'package.json'));
const RUNTIME='F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const PROJECTION=path.join(PROJECT,'supabase/migrations/20261103010000_agent_catalog_publications.sql');
export const PRODUCTION_ORIGIN='https://zyuani8.com';
export const VERSION_KEYS=Object.freeze(['sourceVersion','buildId','releaseId','deployCommitSha']);
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,160}$/u;
function demand(ok,code){if(!ok)throw new Error(code);}
export const inventoryFingerprint=cards=>hash(cards.map(c=>({id:c.id,revision:c.revision,deleted:Boolean(c.deleted),hash:c.sourceHash,portability:[...(c.portability??[])].sort()})).sort((a,b)=>a.id.localeCompare(b.id)));
export function localQuery(){
 // Reuse the authoritative read-only function body without requiring an undeployed local migration.
 // Protected columns are only inspected by its presence checks; no values leave PostgreSQL.
 const source=fs.readFileSync(PROJECTION,'utf8').replace(/\r\n/gu,'\n');
 const match=source.match(/CREATE FUNCTION public\.read_agent_catalog_publication_v1\(p_agent_id text\)[\s\S]*?AS \$\$\s*([\s\S]*?)\$\$;/u);
 demand(match&&/^SELECT jsonb_build_object/u.test(match[1].trim()),'AUTHORITATIVE_READ_PROJECTION_NOT_FOUND');
 const body=match[1].trim(),projection="jsonb_build_object("+fields.map(k=>"'"+k+"',a.\""+k+"\"").join(',')+")";
 demand(body.split('public.agent_catalog_projection_v1(a)').length===2&&body.split('WHERE a.id=p_agent_id;').length===2,'AUTHORITATIVE_READ_PROJECTION_DRIFT');
 return body.replace('public.agent_catalog_projection_v1(a)',projection).replace('WHERE a.id=p_agent_id;','ORDER BY a.id COLLATE "C";');
}
export function decodeLocalRow(row){
 const r=row.jsonb_build_object;demand(r&&typeof r.id==='string'&&r.fields&&Array.isArray(r.portability),'LOCAL_READ_PROJECTION_INVALID');
 const portability=[...r.portability];if(!exactDecimals(r.fields,r.numericText))portability.push('DECIMAL_NOT_EXACT_IN_JSON');
 try{portableNested(r.fields);}catch{portability.push('RESTRICTED_CONTENT_NOT_ARCHIVED');}
 return {id:r.id,revision:Number(r.revision),deleted:r.deleted===true,fields:r.fields,sourceHash:hash(r.fields),portability};
}
export async function readFormalLocal(){
 const raw=fs.readFileSync(RUNTIME,'utf8').replace(/^\uFEFF/u,'');const config=JSON.parse(raw);const url=new URL(config.databaseUrl);
 demand(['postgres:','postgresql:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.port==='54322'&&decodeURIComponent(url.pathname)==='/zimeiti_local'&&url.search==='','REGISTERED_LOCAL_DATABASE_REQUIRED');
 const {Client}=require('pg'),db=new Client({connectionString:config.databaseUrl,statement_timeout:30000,connectionTimeoutMillis:10000});
 try{
  await db.connect();await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL TimeZone='UTC'; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='3s'");
  const identity=(await db.query("SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_setting('transaction_read_only') AS read_only,inet_server_port() AS port,transaction_timestamp() AS observed_at")).rows[0];
  demand(identity.database==='zimeiti_local'&&identity.oid==='16393'&&identity.port===54322&&identity.read_only==='on','LOCAL_DATABASE_AUTHORITY_MISMATCH');
  const query=localQuery(),result=await db.query(query);await db.query('COMMIT');
  const cards=result.rows.map(decodeLocalRow);
  demand(new Set(cards.map(c=>c.id)).size===cards.length&&cards.every(c=>idPattern.test(c.id)&&Number.isSafeInteger(c.revision)&&c.revision>0),'LOCAL_INVENTORY_INVALID');
  return {environment:'formal-local',readOnly:true,complete:true,observedAt:new Date(identity.observed_at).toISOString(),identity:{profileId:'formal-local-postgres-readonly-v1',database:'zimeiti_local',databaseOid:identity.oid,runtimeProfileSha256:bytesHash('formal-local-shared-v1|loopback:54322|zimeiti_local|16393'),querySha256:bytesHash(query),projectionSourceSha256:bytesHash(fs.readFileSync(PROJECTION))},coverage:{kind:'full',ids:cards.map(c=>c.id)},cards};
 }catch(error){if(/^[A-Z][A-Z0-9_]+$/u.test(error?.message??''))throw error;throw new Error('LOCAL_READ_FAILED_NO_SECRET_DETAILS');}
 finally{await db.end().catch(()=>{});}
}
export function checkedAuthority(authority){
 demand(authority?.origin===PRODUCTION_ORIGIN&&authority.profileId==='formal-production-owner-v1'&&VERSION_KEYS.every(k=>typeof authority.version?.[k]==='string'&&authority.version[k].length>3),'FROZEN_PRODUCTION_AUTHORITY_REQUIRED');
 demand(VERSION_KEYS.every(k=>/^[a-zA-Z0-9._-]{4,160}$/u.test(authority.version[k])),'SAFE_VERSION_IDENTITY_REQUIRED');
 return {profileId:authority.profileId,originSha256:bytesHash(authority.origin),version:Object.fromEntries(VERSION_KEYS.map(k=>[k,authority.version[k]]))};
}
export async function api(request,req){
 const result=await request(req);demand(result&&Number.isInteger(result.status),'CONTROLLED_HTTP_RESPONSE_REQUIRED');
 if(result.status!==200||result.body?.ok===false){const error=new Error('CATALOG_API_REQUEST_REJECTED');error.httpStatus=result.status;const code=result.body?.code??result.body?.error?.code;if(typeof code==='string'&&/^[A-Z][A-Z0-9_]+$/u.test(code))error.officialCode=code;throw error;}
 return result.body;
}
export async function verifyVersion(request,authority){
 const a=checkedAuthority(authority),b=await api(request,{method:'GET',path:'/api/version'});
 demand(VERSION_KEYS.every(k=>b?.[k]===a.version[k]),'PRODUCTION_VERSION_DRIFT');return a;
}
export async function readProductionCard(request,id){
 demand(idPattern.test(id),'STABLE_ID_REQUIRED');const body=await api(request,{method:'GET',path:`/api/admin/agent-catalog-publications?agentId=${encodeURIComponent(id)}&view=source`});
 demand(body?.ok===true&&Object.hasOwn(body,'source'),'CATALOG_SOURCE_RESPONSE_INVALID');
 demand(typeof body.deleted==='boolean'&&Array.isArray(body.portability),'CATALOG_LIFECYCLE_OR_PORTABILITY_REQUIRED');
 if(body.source===null)return body.deleted?{id,deleted:true,tombstone:true}:null;const s=body.source;
 demand(s.id===id&&Number.isSafeInteger(s.revision)&&s.revision>0&&s.fields&&s.sourceHash===hash(s.fields)&&fields.every(k=>Object.hasOwn(s.fields,k))&&Object.keys(s.fields).length===fields.length,'CATALOG_SOURCE_HASH_OR_ID_INVALID');
 return {...s,deleted:body.deleted===true,portability:body.portability};
}
export async function captureProduction({request,authority,ids}){
 const identity=await verifyVersion(request,authority);
 demand(Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>idPattern.test(id)),'EXPLICIT_READ_SCOPE_REQUIRED');
 const cards=[],tombstoneIds=[];for(const id of ids){const c=await readProductionCard(request,id);if(c?.tombstone)tombstoneIds.push(id);else if(c)cards.push(c);}
 await verifyVersion(request,authority);
 return {environment:'formal-production',readOnly:true,complete:false,observedAt:new Date().toISOString(),identity,coverage:{kind:'scope',ids:[...ids]},cards,tombstoneIds};
}
export async function refreshPublishedCache({archive,request,authority,ids,author,reason}){
 demand(archive instanceof Archive,'ARCHIVE_INSTANCE_REQUIRED');
 // Capture updates only the published cache branch. Baseline adoption is a separate explicit operation.
 return archive.capture(await captureProduction({request,authority,ids}),{author,reason});
}
