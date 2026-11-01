import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const historyExports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/video-history-policy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:historyExports,Date});
const policyExports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storyboard-video-archive-policy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:policyExports,Date});
const source=fs.readFileSync('src/app/api/video/thumbnail/[taskId]/route.ts','utf8');
class NextResponse extends Response {static json(body,init){return new NextResponse(JSON.stringify(body),{...init,headers:{'content-type':'application/json',...init?.headers}});}}
let allowed=true,contentAllowed=true,extractions=0,active=0,maxActive=0,fail=false;
let taskOverride={};
let fakeClock=false;const fakeTimers=[];const started=[];
function timer(fn,ms){if(!fakeClock)return setTimeout(fn,ms);const handle={fn,ms};fakeTimers.push(handle);return handle;}
function cancelTimer(handle){if(handle&&typeof handle==='object'&&'fn' in handle){const index=fakeTimers.indexOf(handle);if(index>=0)fakeTimers.splice(index,1);}else clearTimeout(handle);}
const pending=[];const cached=new Map();const checks=[];
const imports={
 'path':path,'next/server':{NextResponse},
 '@/lib/storyboard-video-archive-policy':policyExports,
 '@/lib/video-history-policy':historyExports,
 '@/lib/runtime-paths':{resolveAppRuntimeDir:()=>'/isolated-test-runtime'},
 '@/lib/video-access-ticket':{createVideoAccessUrl:async({taskId})=>'/api/video/proxy?id='+taskId+'&media_ticket=synthetic'},
 '@/lib/video-media-auth':{authorizeVideoMediaRequest:async()=>allowed?{ok:true,user:{userId:'owner',role:'student'}}:{ok:false,response:NextResponse.json({error:'denied'},{status:401})}},
 '@/lib/video-postprocess':{extractVideoThumbnail:async(url,options)=>{assert.equal(new URL(url).origin,'http://127.0.0.1:5000');assert.equal(options.trustedInternalOrigin,'http://127.0.0.1:5000');started.push(new URL(url).searchParams.get('id'));extractions++;active++;maxActive=Math.max(maxActive,active);try{if(fail)throw Error('TEMPORARY_MEDIA_ERROR');return await new Promise(resolve=>pending.push(()=>resolve(Buffer.from('synthetic-jpeg'))));}finally{active--;}}},
 '@/lib/video-thumbnail-cache':{readVideoThumbnailCacheFile:async(_,id)=>cached.get(id),readVideoThumbnailCachePolicy:()=>({ttlMs:1000}),resolveVideoThumbnailCacheFile:(_,id)=>'/cache/'+id,scheduleVideoThumbnailCachePrune(){},writeVideoThumbnailCacheFile:async(_,id,buffer)=>cached.set(id,buffer)},
 '@/lib/server/member-content-authority':{authorizeMemberContentAccess:async()=>contentAllowed?{ok:true,deliveryIdentity:{userId:'owner',role:'student'}}:{ok:false,response:NextResponse.json({error:'denied'},{status:403})},authorizeMemberContentDiscovery(){throw Error('DISCOVERY_FORBIDDEN');}},
 '@/storage/database/supabase-client':{getSupabaseAdminClient:()=>({from(){let id='';const query={select(){return query;},or(value){id=value.split(',')[0].slice(6);return query;},eq(){return query;},async limit(){return {data:[{id,user_id:'owner',status:'completed',...taskOverride}],error:null};}};return query;}})},
};
const exports={};const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
vm.runInNewContext(js,{exports,require(name){assert.ok(name in imports,'unmocked '+name);return imports[name];},globalThis:{},Buffer,URL,Date,process:{env:{}},setTimeout:timer,clearTimeout:cancelTimer,console:{warn(){}}});
const get=id=>exports.GET({}, {params:Promise.resolve({taskId:id})});const flush=()=>new Promise(resolve=>setImmediate(resolve));
const batch=Array.from({length:28},(_,i)=>get('clip-'+i));await flush();await flush();assert.equal(active,2);assert.equal(maxActive,2);
while(pending.length){pending.splice(0).forEach(resolve=>resolve());await flush();await flush();}
const responses=await Promise.all(batch);assert.equal(responses.filter(row=>row.status===200).length,26);assert.equal(responses.filter(row=>row.status===503).length,2);assert.equal(maxActive,2);checks.push('28 concurrent distinct thumbnails cap extraction at 2 and queue at 24; overload is retryable 503');
const before=extractions;const duplicate=[get('same'),get('same'),get('same')];await flush();assert.equal(extractions,before+1);pending.splice(0).forEach(resolve=>resolve());assert.ok((await Promise.all(duplicate)).every(row=>row.status===200));checks.push('same-task requests share one extraction');
fail=true;const failure=await get('fails');assert.equal(failure.status,503);assert.equal(failure.headers.get('retry-after'),'30');const afterFailure=extractions;assert.equal((await get('fails')).status,503);assert.equal(extractions,afterFailure);checks.push('temporary extraction failure has 30 second retry hint and cooldown without repeated download');
allowed=false;assert.equal((await get('same')).status,401);allowed=true;contentAllowed=false;assert.equal((await get('same')).status,403);checks.push('cached cover does not bypass current authentication or ownership authorization');
contentAllowed=true;taskOverride={task_label:'分镜工作台:test',completed_at:'2020-01-01T00:00:00Z'};assert.equal((await get('same')).status,410);
taskOverride={task_label:'分镜工作台:test',completed_at:new Date().toISOString(),source_expired_at:'upstream-only',storage_url:'object://tencent_cos/videos/scoped/storyboard-delivery/owner/same.mp4'};assert.equal((await get('same')).status,200);checks.push('72h expiry checked before cached thumbnail, owned current archive survives upstream expiry');
taskOverride={};fail=false;fakeClock=true;const startIndex=started.length;
const slow=Array.from({length:9},(_,i)=>get('slow-'+i));await flush();await flush();assert.deepEqual(started.slice(startIndex),['slow-0','slow-1']);
const queueTimeouts=fakeTimers.filter(handle=>handle.ms===20000);assert.equal(queueTimeouts.length,7);for(const handle of queueTimeouts){cancelTimer(handle);handle.fn();}await flush();
assert.ok((await Promise.all(slow.slice(2))).every(row=>row.status===503));
const recovered=get('slow-2');await flush();assert.equal(fakeTimers.filter(handle=>handle.ms===20000).length,1,'queue timeout must not create per-task 30s failure cooldown');
pending.splice(0).forEach(resolve=>resolve());await flush();await flush();assert.equal(started.at(-1),'slow-2');pending.splice(0).forEach(resolve=>resolve());assert.equal((await recovered).status,200);assert.ok((await Promise.all(slow.slice(0,2))).every(row=>row.status===200));
checks.push('nine-card history: slow first two retain FIFO slots, later seven timeout retryably and can requeue immediately without task cooldown');
const report={ok:true,tests:checks.length,checks,realNetworkCalls:0,modelCalls:0,productionDatabaseCalls:0,maxActive};
fs.mkdirSync('.codex-evidence/storyboard-history-20261023',{recursive:true});fs.writeFileSync('.codex-evidence/storyboard-history-20261023/thumbnail-queue-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
