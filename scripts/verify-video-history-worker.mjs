import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, modules, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, URLSearchParams, Date, console, require(id) { assert.ok(id in modules, id); return modules[id]; }, ...globals });
  return module.exports;
}
const presentation = load('src/lib/video-history-presentation.ts', {});
const submitted = [{ id:'old-active', createdAt:'2026-09-01T00:00:00Z', status:'processing' }, { id:'new-failed', createdAt:'2026-09-14T00:00:00Z', status:'failed' }, { id:'middle', createdAt:'2026-09-10T00:00:00Z', status:'completed' }];
assert.equal(presentation.sortVideoHistoryBySubmission(submitted).map(t => t.id).join(','), 'new-failed,middle,old-active');
assert.equal(presentation.compactPublicVideoModelName('Wan 3.0 · 480P 0.25元/秒 · 分组40'), 'Wan 3.0');
assert.equal(presentation.compactPublicVideoModelName('MiniMax H3 电商优化 · 720P · 36'), 'MiniMax H3 电商优化 · 720P');
assert.equal(presentation.compactPublicVideoModelName('Seedance 2.5 · 旗舰 · 4–30秒 · 1080p待开放'), 'Seedance 2.5 · 旗舰 · 4–30秒 · 1080p');
assert.equal(presentation.canRetryVideoHistoryTask({ status:'failed', billing_state:'failed' }), true);
for (const row of [{ status:'processing', billing_state:'failed' }, { status:'failed', billing_state:'billing_pending' }, { status:'failed', billing_state:'failed', provider_result_url:'private-result' }, { status:'failed', billing_state:'failed', submission_error_code:'VIDEO_SUBMIT_OUTCOME_UNKNOWN' }]) assert.equal(presentation.canRetryVideoHistoryTask(row), false);

let calls = [], rows = [{ id:'task', user_id:'owner', model_id:'model', task_id_external:'provider-task' }];
const filters = [];
const db = { from(table) { const query = { select:()=>query, in:(...args)=>{filters.push(args);return query;}, not:(...args)=>{filters.push(args);return query;}, neq:(...args)=>{filters.push(args);return query;}, or:()=>query, order:()=>query, eq:(k,v)=>{assert.equal(k,'id');assert.equal(v,'owner');return query;}, range:async()=>({data:rows}), maybeSingle:async()=>({data:{id:'owner',role:'student'}}) }; return query; } };
const worker = load('src/lib/video-history-worker.ts', {
  'server-only': {}, '@/storage/database/supabase-client': { getSupabaseAdminClient:()=>db },
  '@/lib/video-task-status': { refreshOwnedVideoTaskStatus:async(owner,params)=>{calls.push({owner,params});return new Response('{}');} },
  '@/lib/video-submission-reconciliation': { reconcileStaleVideoSubmissionBatch:async()=>({expiredCount:0,taskIds:[],scannedUserCount:0,failedUserCount:0}) },
  '@/lib/durable-queue-loop': { DurableQueueLoop: class {} },
});
await worker.reconcileVideoHistoryBatch();
assert.equal(calls.length,1);assert.equal(calls[0].owner.userId,'owner');assert.equal(calls[0].owner.role,'student');assert.equal(calls[0].params.get('taskId'),'provider-task');
assert.ok(filters.some(f=>f[0]==='task_id_external'&&f[1]==='is'&&f[2]===null));
assert.ok(filters.some(f=>f[0]==='task_id_external'&&f[1]===''));
rows=[{...rows[0],task_id_external:'h3q_owned-worker'}];await worker.reconcileVideoHistoryBatch();assert.equal(calls.length,1);

// The browser and worker execute the exact same ownership-scoped status service.
function statusFixture(task, providerStatus = 'processing') {
  let polls=0, finalized=0;
  const db={from(table){const q={select:()=>q,eq:()=>q,order:()=>q,limit:async()=>({data:table==='video_tasks'?[task]:[]}),single:async()=>({data:{id:'model',name:'fixture',api_endpoint:'https://provider.invalid',api_key:'fixture',protocol_type:'fixture'}}),maybeSingle:async()=>({data:task}),update:()=>q,neq:async()=>({})};return q;}};
  const deps={
    '@/lib/digital-video-dispatch':{},'@/lib/digital-video-queue-worker':{},'@/lib/digital-human-task':{},
    'next/server':{NextResponse:{json:(data,init)=>Response.json(data,init)}},
    '@/storage/database/supabase-client':{getSupabaseClient:()=>db},
    '@/lib/video-adapter':{pollVideoTask:async()=>{polls++;return{status:providerStatus,videoUrl:'https://result.invalid/video.mp4'};}},
    '@/lib/production-data-source':{getProductionVideoModelById:async()=>null},
    '@/lib/public-model-dto':{},'@/lib/video-error-policy':{classifyVideoProviderError:()=>({publicMessage:'fixture',code:'fixture'})},
    '@/lib/video-terminal-accounting':{recordVideoTerminalOutcome:async()=>{}},
    '@/lib/video-submission-reconciliation':{reconcileStaleVideoSubmissionsForUser:async()=>({expiredCount:0,taskIds:[]})},
    '@/lib/video-routing-snapshot':{parseVideoRoutingSnapshot:()=>null,resolveVideoRoutingCredential:async()=>'',videoModelConfigFromRoutingSnapshot:()=>null},
    '@/lib/provider-secret':{resolveProviderSecret:()=> 'fixture'},
    '@/lib/video-access-ticket':{createVideoAccessUrl:async()=>'/owned-result'},
    '@/lib/video-history-presentation':presentation,
    '@/lib/autodl-h3-selfhost':{assertAutodlH3SelfhostModelBinding:()=>{}},
    '@/lib/autodl-h3-lifecycle':{},
    '@/lib/video-terminal-finalizer':{videoTerminalErrorResponse:()=>null,finalizeVideoGenerationSuccess:async input=>{assert.equal(input.userId,'owner');assert.equal(input.taskIdInternal,task.id);finalized++;return{state:'completed',playbackUrl:'/owned-result',priceCharged:0};}},
  };
  const service=load('src/lib/video-task-status.ts',deps);
  const params=()=>new URLSearchParams({taskId:task.task_id_external||task.id,modelId:'model'});
  return{
    read:()=>service.readOwnedVideoTaskStatus({userId:'owner',role:'student'},params()),
    refresh:()=>service.refreshOwnedVideoTaskStatus({userId:'owner',role:'student'},params()),
    polls:()=>polls,finalized:()=>finalized,
  };
}
const unknown=statusFixture({id:'vt_'+'a'.repeat(40),status:'pending',model_id:'model',task_id_external:'',submission_error_code:'VIDEO_SUBMIT_OUTCOME_UNKNOWN'});
assert.equal((await (await unknown.read()).json()).processingStage,'confirming_submission');assert.equal(unknown.polls(),0);
const running=statusFixture({id:'vt_'+'b'.repeat(40),status:'processing',model_id:'model',task_id_external:'provider-task'},'success');
const passive=await (await running.read()).json();assert.equal(passive.status,'processing');assert.equal(running.polls(),0);assert.equal(running.finalized(),0);
const completed=await (await running.refresh()).json();assert.equal(completed.status,'completed');assert.equal(running.polls(),1);assert.equal(running.finalized(),1);
let authorized=false, serviceCalls=0;
const route=load('src/app/api/video/status/route.ts',{'next/server':{},'@/lib/current-api-user':{authorizeCurrentApiUser:async()=>authorized?{ok:true,user:{userId:'owner',role:'student'}}:{ok:false,response:new Response(null,{status:401})}},'@/lib/video-task-status':{readOwnedVideoTaskStatus:async()=>{serviceCalls++;return new Response('{}');}}},{URL});
assert.equal((await route.GET({url:'http://local.invalid/?taskId=id&modelId=model'})).status,401);assert.equal(serviceCalls,0);
authorized=true;await route.GET({url:'http://local.invalid/?taskId=id&modelId=model'});assert.equal(serviceCalls,1);
const streamSource=fs.readFileSync('src/app/api/video/stream/route.ts','utf8');
assert.ok(streamSource.includes('readOwnedVideoTaskStatus'));
assert.ok(!streamSource.includes('pollVideoTask'));
assert.ok(!streamSource.includes('finalizeVideoGenerationSuccess'));
console.log(JSON.stringify({passed:true,scenarios:16,actualWorker:true,passiveBrowserStatus:true,passiveSse:true,providerSubmissions:0,realDatabaseWrites:0}));
