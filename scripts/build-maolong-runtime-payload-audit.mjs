import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {maolongCaptureLabel,resolveMaolongMirrorRoots} from './maolong-mirror-capture-roots.mjs';

const roots=resolveMaolongMirrorRoots();
const docs=path.resolve('docs/带货Agent镜像融合-20260925');
const sha256=value=>crypto.createHash('sha256').update(value).digest('hex');
const writeAtomic=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;fs.writeFileSync(temporary,value);fs.renameSync(temporary,file);};
const uuidPattern=/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
const allowedQueryValues=new Set(['limit','source','tool_slug','offset','page','page_size']);

function safeEndpoint(raw){
 const url=new URL(raw);
 const pathname=url.pathname.replace(uuidPattern,'{id}').replace(/\/(?:[A-Za-z0-9_-]{20,})(?=\/|$)/gu,'/{id}');
 const query=[...url.searchParams.entries()].map(([key,value])=>[key,allowedQueryValues.has(key)?value:'{value}']).sort(([left],[right])=>left.localeCompare(right));
 return pathname+(query.length?`?${new URLSearchParams(query)}`:'');
}

function scalarType(value){
 if(value===null)return'null';
 if(Array.isArray(value))return'array';
 if(typeof value==='string'){
  if(uuidPattern.test(value)){uuidPattern.lastIndex=0;return'uuid-string';}
  uuidPattern.lastIndex=0;
  if(/^https?:\/\//iu.test(value))return'url-string';
  if(/^\d{4}-\d{2}-\d{2}T/iu.test(value))return'datetime-string';
  return'string';
 }
 return typeof value;
}

const safeEnumKey=/^(status|state|type|kind|role|tool_slug|skill_key|source)$/u;
function structuralProfile(value,maxDepth=7){
 const fields=new Map();
 const arrays=new Map();
 const enums=new Map();
 const visit=(current,fieldPath,depth)=>{
  const type=scalarType(current),row=fields.get(fieldPath)||{path:fieldPath,types:new Set(),observations:0};
  row.types.add(type);row.observations+=1;fields.set(fieldPath,row);
  if(depth>=maxDepth)return;
  if(Array.isArray(current)){
   const sizes=arrays.get(fieldPath)||[];sizes.push(current.length);arrays.set(fieldPath,sizes);
   for(const item of current.slice(0,200))visit(item,`${fieldPath}[]`,depth+1);
   return;
  }
  if(current&&typeof current==='object'){
   for(const [key,child] of Object.entries(current)){
    const childPath=fieldPath?`${fieldPath}.${key}`:key;
    if(safeEnumKey.test(key)&&['string','number','boolean'].includes(typeof child)){
     const values=enums.get(childPath)||new Set();
     if(values.size<50)values.add(String(child).slice(0,120));
     enums.set(childPath,values);
    }
    visit(child,childPath,depth+1);
   }
  }
 };
 visit(value,'$',0);
 return{
  fields:[...fields.values()].map(item=>({path:item.path,types:[...item.types].sort(),observations:item.observations})).sort((left,right)=>left.path.localeCompare(right.path)),
  arrays:[...arrays].map(([fieldPath,sizes])=>({path:fieldPath,observations:sizes.length,min:Math.min(...sizes),max:Math.max(...sizes),total:sizes.reduce((sum,size)=>sum+size,0)})).sort((left,right)=>left.path.localeCompare(right.path)),
  safeEnums:[...enums].map(([fieldPath,values])=>({path:fieldPath,values:[...values].sort()})).sort((left,right)=>left.path.localeCompare(right.path)),
 };
}

const grouped=new Map();
const documents=[];
for(const root of roots){
 const manifestPath=path.join(root,'manifest.json');
 if(!fs.existsSync(manifestPath))continue;
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 for(const response of manifest.responses||[]){
  if(Number(response.status)!==200||!response.savedPath)continue;
  const endpoint=safeEndpoint(response.url),target=path.join(root,response.savedPath);
  if(!fs.existsSync(target))continue;
  if(endpoint.startsWith('/canvas/')&&(response.contentType||'').includes('text/html'))documents.push({endpoint,captureRoot:maolongCaptureLabel(root),sha256:response.sha256,bytes:response.bytes});
  if(!endpoint.startsWith('/api/')||!(response.contentType||'').includes('application/json'))continue;
  const bytes=fs.readFileSync(target),digest=sha256(bytes),key=`${endpoint}|${digest}`;
  let body;
  try{body=JSON.parse(bytes.toString('utf8'));}catch{continue;}
  if(!grouped.has(key))grouped.set(key,{endpoint,sha256:digest,bytes:bytes.length,captureRoots:new Set(),profile:structuralProfile(body)});
  grouped.get(key).captureRoots.add(maolongCaptureLabel(root));
 }
}

const responses=[...grouped.values()].map(item=>({...item,captureRoots:[...item.captureRoots].sort()})).sort((left,right)=>left.endpoint.localeCompare(right.endpoint)||left.sha256.localeCompare(right.sha256));
const endpoints=new Set(responses.map(item=>item.endpoint));
const has=pattern=>[...endpoints].some(endpoint=>pattern.test(endpoint));
const batchDetails=[...endpoints].filter(endpoint=>/^\/api\/v1\/batches\/\{id\}$/u.test(endpoint)).length;
const canvasPageChunk=roots.some(root=>fs.existsSync(path.join(root,'responses','daai-static.da-ai.vip','_next','static','chunks','app','(workspace)','canvas','[canvasId]','page-c51169a83d03a317.js')));
const checklist=[
 ['agent conversation list',has(/^\/api\/v1\/agent\/conversations\?/u)],
 ['image-generation filtered batches',has(/^\/api\/v1\/batches\?.*tool_slug=image-generation/u)],
 ['ecommerce-image-set filtered batches',has(/^\/api\/v1\/batches\?.*tool_slug=ecommerce-image-set/u)],
 ['at least two saved batch details',batchDetails>=1&&responses.filter(item=>item.endpoint==='/api/v1/batches/{id}').length>=2],
 ['canvas list',has(/^\/api\/v1\/canvases\?/u)],
 ['canvas detail',has(/^\/api\/v1\/canvases\/\{id\}$/u)],
 ['current operation notice',has(/^\/api\/v1\/operation-notices\/current$/u)],
 ['recharge package list',has(/^\/api\/v1\/payments\/recharge-packages$/u)],
 ['usage ledger',has(/^\/api\/v1\/usage\/ledger\?/u)],
 ['usage summary',has(/^\/api\/v1\/usage\/summary$/u)],
 ['dynamic canvas document',documents.some(item=>item.endpoint==='/canvas/{id}')],
 ['dynamic canvas page chunk',canvasPageChunk],
].map(([name,passed])=>({name,passed:Boolean(passed)}));

const report={
 schemaVersion:'maolong.runtime-payload-structure-audit/v1',
 generatedAtUtc:new Date().toISOString(),
 scope:'Authorized saved GET response bodies and dynamic Canvas browser controller only. Values that could contain account IDs, prompts, user assets or generated content are excluded; the report retains field paths, types, counts, safe status enums and hashes.',
 safety:{businessWrites:0,paidGeneration:0,rawUserValuesPersistedInThisAudit:0,deployment:0},
 summary:{captureRoots:roots.length,uniqueEndpointBodies:responses.length,uniqueEndpoints:endpoints.size,dynamicCanvasDocuments:documents.length,checklistPassed:checklist.filter(item=>item.passed).length,checklistTotal:checklist.length},
 fixedPoint:{status:checklist.every(item=>item.passed)?'observable-readonly-payload-and-dynamic-controller-closure-passed':'incomplete',checklist,boundary:'Write-only behavior, paid generation, provider execution, private queue workers, database transactions and server-only prompt code remain outside browser GET evidence.'},
 dynamicCanvas:{documents,routeChunkCaptured:canvasPageChunk,newClientCapabilities:['node and edge graph editor','grouping and minimap/zoom controls','drag/drop media nodes','slash skill and mention affordances','share-link client contract','multi-track clip editor integration'],executionBoundary:'Canvas-only skill submission was not executed because it would create business state and can create paid media tasks.'},
 responses,
};

const jsonPath=path.join(docs,'运行载荷与动态Canvas结构审计.json');
const mdPath=path.join(docs,'运行载荷与动态Canvas结构审计.md');
writeAtomic(jsonPath,`${JSON.stringify(report,null,2)}\n`);
const md=['# 运行载荷与动态 Canvas 结构审计','',`生成时间：${report.generatedAtUtc}`,'',report.scope,'',`固定点：${report.fixedPoint.status}（${report.summary.checklistPassed}/${report.summary.checklistTotal}）`,'','## 核对项','',...checklist.map(item=>`- ${item.passed?'通过':'缺失'}｜${item.name}`),'','## 动态 Canvas','',...report.dynamicCanvas.newClientCapabilities.map(item=>`- ${item}`),`- 边界：${report.dynamicCanvas.executionBoundary}`,'','## 已保存响应结构','',...responses.map(item=>`- ${item.endpoint}｜${item.bytes} bytes｜字段 ${item.profile.fields.length}｜数组 ${item.profile.arrays.length}｜SHA256 ${item.sha256}`),'','## 证据边界','',`- ${report.fixedPoint.boundary}`,''];
writeAtomic(mdPath,`${md.join('\n')}\n`);
console.log(JSON.stringify({ok:true,summary:report.summary,fixedPoint:report.fixedPoint.status,outputs:[jsonPath,mdPath].map(file=>({file,bytes:fs.statSync(file).size,sha256:sha256(fs.readFileSync(file))}))},null,2));
