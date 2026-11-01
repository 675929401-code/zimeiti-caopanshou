import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync('src/lib/user-content-retention-worker.ts','utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
function fixture(flag,options={}){
 const counts={client:0,rpc:[],thumbnails:0,sourceChecks:0,loopOptions:null};
 const db={rpc:async(name,args)=>{counts.rpc.push({name,args});if(name==='purge_expired_user_content')return{data:{has_more:false},error:null};if(options.error)return{data:null,error:options.error};const ids=Array.from({length:500},(_,index)=>'owned-fixture-'+counts.rpc.length+'-'+index);return{data:{deletedCount:500,deletedIds:ids,hasMore:options.hasMore!==false},error:null};}};
 class Queue{constructor(config){counts.loopOptions=config;}start(){return true;}stop(){return true;}snapshot(){return{};}}
 const deps={'server-only':{},'node:path':path,'@/lib/durable-queue-loop':{DurableQueueLoop:Queue},'@/storage/database/supabase-client':{getSupabaseAdminClient:()=>{counts.client++;return db;}},'@/lib/image-provider-delivery':{checkImageProviderSourcesBatch:async()=>{counts.sourceChecks++;}},'@/lib/runtime-paths':{resolveAppRuntimeDir:()=>'/fixture/runtime'},'@/lib/video-thumbnail-cache':{removeVideoThumbnailCacheFiles:async(_root,ids)=>{counts.thumbnails++;return ids.length;}}};
 const output={};vm.runInNewContext(compiled,{exports:output,require:name=>{assert.ok(name in deps,'UNMOCKED_DEPENDENCY:'+name);return deps[name];},process:{env:flag===undefined?{}:{VIDEO_HISTORY_HARD_PURGE_ENABLED:flag}},console:{info(){},warn(){}},path,Promise,Array});return{counts,output};
}
let cases=0;
for(const flag of [undefined,'','0','false','true','yes','01',' 1','1 ']){const f=fixture(flag);const result=await f.output.purgeExpiredVideoHistoryBatch();assert.equal(JSON.stringify(result),JSON.stringify({deletedRows:0,deletedThumbnails:0,batches:0}));assert.equal(f.counts.client,0);assert.equal(f.counts.rpc.length,0);assert.equal(f.counts.thumbnails,0);cases++;}
const enabled=fixture('1');const result=await enabled.output.purgeExpiredVideoHistoryBatch();assert.equal(result.batches,5);assert.equal(result.deletedRows,2500);assert.equal(result.deletedThumbnails,2500);assert.equal(enabled.counts.rpc.length,5);for(const call of enabled.counts.rpc){assert.equal(call.name,'purge_expired_video_history');assert.equal(JSON.stringify(call.args),JSON.stringify({p_retention_days:5,p_limit:500}));}assert.equal(enabled.counts.thumbnails,5);cases++;
const short=fixture('1',{hasMore:false});assert.equal((await short.output.purgeExpiredVideoHistoryBatch()).batches,1);assert.equal(short.counts.rpc.length,1);cases++;
const missing=fixture('1',{error:{code:'PGRST202'}});assert.equal((await missing.output.purgeExpiredVideoHistoryBatch()).deletedRows,0);assert.equal(missing.counts.thumbnails,0);cases++;
const error=fixture('1',{error:{code:'XX000'}});await assert.rejects(error.output.purgeExpiredVideoHistoryBatch(),/VIDEO_HISTORY_PURGE_RPC_FAILED/);assert.equal(error.counts.thumbnails,0);cases++;
const oldWorker=fixture(undefined);assert.equal(oldWorker.output.startUserContentRetentionWorker(),true);await oldWorker.counts.loopOptions.runOnce();assert.equal(oldWorker.counts.sourceChecks,1);assert.equal(oldWorker.counts.rpc.length,1);assert.equal(oldWorker.counts.rpc[0].name,'purge_expired_user_content');assert.equal(oldWorker.counts.rpc[0].args.p_conversation_days,30);assert.equal(oldWorker.counts.rpc[0].args.p_extraction_days,10);assert.equal(oldWorker.counts.thumbnails,0);cases++;
console.log(JSON.stringify({passed:true,cases,actualWorkerCompiled:true,networkRequests:0,databaseWrites:0,thumbnailFilesWritten:0}));
