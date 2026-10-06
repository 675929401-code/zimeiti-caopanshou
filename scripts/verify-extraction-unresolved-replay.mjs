import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the real wrapper with an isolated in-memory database. No credentials,
// network, provider, real wallet or real database can be reached by this test.
const source = readFileSync('src/lib/extraction-exactly-once.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture(state, charged, options = {}) {
  let row; let handlerCalls = 0; let recoveryCalls = 0; let deletes = 0;
  const db = {
    async rpc(name, args) {
      if (name === 'claim_extraction_attempt_atomic') {
        if (row && row.payload_fingerprint !== args.p_payload_fingerprint) return {error:{message:'EXTRACTION_ATTEMPT_CONFLICT'}};
        const created = !row;
        if (!row) row={record_id:args.p_record_id,user_id:args.p_user_id,client_request_id:args.p_client_request_id,
          request_kind:args.p_request_kind,payload_fingerprint:args.p_payload_fingerprint,state:'running',
          created_at:new Date().toISOString(),updated_at:new Date().toISOString(),provider_checkpoint:{},provider_evidence:{},billing_evidence:{}};
        return {data:{created,record:structuredClone(row)}};
      }
      if (name === 'checkpoint_extraction_provider_atomic') {
        row.provider_checkpoint = { ...(row.provider_checkpoint || {}), result: structuredClone(args.p_provider_result) };
        return {data:{record:structuredClone(row)}};
      }
      if (name === 'checkpoint_extraction_request_atomic') {
        if (options.snapshotMigrationMissing) return {error:{message:'Could not find the function public.checkpoint_extraction_request_atomic in the schema cache'}};
        row.request_snapshot = structuredClone(args.p_request_snapshot);
        return {data:{record:structuredClone(row)}};
      }
      assert.equal(name,'finalize_extraction_attempt_atomic');
      Object.assign(row,{state:args.p_state,http_status:args.p_http_status,response:args.p_response,
        provider_evidence:args.p_provider_evidence,billing_evidence:args.p_billing_evidence});
      return {data:{record:structuredClone(row)}};
    },
    from(table) {
      assert.equal(table,'extraction_attempts');
      const filters=[];
      const q={delete(){deletes++;return q;},eq(key,value){filters.push([key,value]);return q;},
        then(resolve){if(row&&filters.every(([k,v])=>row[k]===v))row=undefined;return Promise.resolve({error:null}).then(resolve);}};
      return q;
    },
  };
  const modules={
    'node:crypto':{createHash},'node:async_hooks':{AsyncLocalStorage},
    'next/server':{NextRequest:Request,NextResponse:{json:(body,init)=>Response.json(body,init)}},
    '@/lib/extraction-auth':{authorizeExtractionRequest:async()=>({ok:true,userId:'fixture-user'})},
    '@/lib/extraction-history':{sanitizeOwnedExtractionResponse:value=>value},
    '@/lib/extraction-provider-error':{sanitizeExtractionErrorFields:value=>value},
    '@/storage/database/supabase-client':{getSupabaseAdminClient:()=>db},
  };
  const module={exports:{}};
  runInNewContext(compiled,{module,exports:module.exports,Buffer,Response,Request,Headers,URL,TextEncoder,TextDecoder,setTimeout,
    require(id){assert.ok(id in modules,'Unstubbed dependency '+id);return modules[id];}});
  const lib=module.exports;
  const body={links:['https://example.invalid/video'],extraction_mode:'text',client_request_id:'fixture-request-001'};
  if(state)row={record_id:createHash('sha256').update('fixture-user\0fixture-request-001').digest('hex'),user_id:'fixture-user',
    client_request_id:body.client_request_id,request_kind:'single',payload_fingerprint:lib.extractionPayloadFingerprint('single',body),
    state,http_status:state==='succeeded'?200:503,response:state==='succeeded'?{success:true,texts:['cached']} : null,
    provider_task_id:'original-provider-task',provider_checkpoint:structuredClone(options.providerCheckpoint || {}),provider_evidence:{provider_call_started:true},billing_evidence:{charged},
    created_at:'2026-09-13T00:00:00Z',updated_at:'2026-09-13T00:00:00Z'};
  const handler=lib.withExtractionExactlyOnce('single',async()=>{
    handlerCalls++;
    if (options.handlerResponse) {
      return Response.json(structuredClone(options.handlerResponse.body), { status: options.handlerResponse.status || 200, headers: options.handlerResponse.headers });
    }
    if (options.holdForRecovery) {
      await lib.checkpointExtractionProviderResult({schema:'fixture-provider-result.v1',videos:[{url:'https://media.invalid/video.mp4'}]});
      const recoveryCharged = Object.hasOwn(options, 'recoveryCharged') ? options.recoveryCharged : false;
      return Response.json({success:false,recovery_pending:true,upstream_completed:true,provider_call_started:true,charged:recoveryCharged,
        billing_unknown:recoveryCharged !== false,retry_safe:false},{status:503});
    }
    return Response.json({success:true,texts:['fresh'],charged:false});
  }, options.enableRecovery ? {recoverFromProviderCheckpoint:async(_request,record)=>{
    recoveryCalls++;
    assert.equal(record.providerCheckpoint.result.schema,'fixture-provider-result.v1');
    return Response.json({success:true,videos:[{asset_id:'fixture-owned-asset'}],charged:false});
  }} : undefined);
  return {send:(changes={},headers={})=>handler(new Request('http://fixture.invalid/api/extract',{method:'POST',headers:{Authorization:'Bearer fixture-session','Content-Type':'application/json','Idempotency-Key':body.client_request_id,...headers},body:JSON.stringify({...body,...changes})})),
    snapshot:()=>structuredClone(row),counts:()=>({handlerCalls,recoveryCalls,deletes})};
}
let scenarios=0;
for(const charged of [true,false,undefined]){
  const f=fixture('failed_unknown',charged);const original=f.snapshot();
  const results=await Promise.all(Array.from({length:12},()=>f.send()));
  for(const response of results){assert.equal(response.status,409);const body=await response.json();assert.equal(body.retry_safe,false);assert.equal(body.attempt_id,original.record_id);}
  assert.deepEqual(f.snapshot(),original,'unresolved trace must remain intact');assert.deepEqual(f.counts(),{handlerCalls:0,recoveryCalls:0,deletes:0});scenarios++;
}
{
 const f=fixture('running');assert.equal((await f.send()).status,409);assert.equal(f.counts().handlerCalls,0);assert.equal(f.counts().recoveryCalls,0);scenarios++;
}
{
 const f=fixture('succeeded');const response=await f.send();assert.equal(response.status,200);assert.deepEqual((await response.json()).texts,['cached']);assert.equal(f.counts().handlerCalls,0);assert.equal(f.counts().recoveryCalls,0);scenarios++;
}
{
 const f=fixture();const responses=await Promise.all(Array.from({length:12},()=>f.send()));
 for(const response of responses){assert.equal(response.headers.get('X-Extraction-Recovery-Mode'),null);assert.equal(response.headers.get('X-Extraction-Provider-Handler'),null);}
 assert.deepEqual(f.counts(),{handlerCalls:1,recoveryCalls:0,deletes:0});assert.equal(f.snapshot().state,'succeeded');scenarios++;
}
{
 const f=fixture(undefined,undefined,{snapshotMigrationMissing:true});const response=await f.send();assert.equal(response.status,200);
 assert.equal(f.counts().handlerCalls,1,'an unactivated retry snapshot migration must not interrupt the existing exactly-once chain');
 assert.equal(f.snapshot().state,'succeeded');scenarios++;
}
{
 const fallback={success:false,fallback_delivered:true,retry_safe:true,charged:false,
   semantic_status:'invalid_result_refunded',result:{method:'semantic_fallback',segments:['规则结果']}};
 const f=fixture(undefined,undefined,{handlerResponse:{status:200,body:fallback}});
 const first=await f.send();assert.equal(first.status,200);assert.equal(f.snapshot().state,'failed');
 assert.deepEqual(await first.json(),fallback);assert.deepEqual(f.counts(),{handlerCalls:1,recoveryCalls:0,deletes:0});
 const replay=await f.send();assert.equal(replay.status,200);assert.equal(replay.headers.get('X-Extraction-Replayed'),'true');
 assert.deepEqual(await replay.json(),fallback);assert.deepEqual(f.counts(),{handlerCalls:1,recoveryCalls:0,deletes:0},
   'same request id must replay fallback without another provider call');scenarios++;
}
{
 const f=fixture('failed_unknown');assert.equal((await f.send({links:['https://example.invalid/changed']})).status,409);assert.deepEqual(f.counts(),{handlerCalls:0,recoveryCalls:0,deletes:0});scenarios++;
}
{
 const f=fixture(undefined,undefined,{enableRecovery:true,holdForRecovery:true});
 const pending=await f.send();assert.equal(pending.status,503);assert.equal((await pending.json()).recovery_pending,true);
 assert.equal(f.snapshot().state,'running','asset persistence pending must keep the provider checkpoint resumable');
 assert.equal(f.snapshot().provider_checkpoint.result.schema,'fixture-provider-result.v1');
 const recovered=await f.send();assert.equal(recovered.status,200);assert.equal((await recovered.json()).videos[0].asset_id,'fixture-owned-asset');
 assert.deepEqual(f.counts(),{handlerCalls:1,recoveryCalls:1,deletes:0},'checkpoint recovery must not call the provider handler again');
 assert.equal(f.snapshot().state,'succeeded');scenarios++;
}
for (const recoveryCharged of [null, true]) {
 const f=fixture(undefined,undefined,{enableRecovery:true,holdForRecovery:true,recoveryCharged});
 const pending=await f.send();assert.equal(pending.status,503);const pendingBody=await pending.json();
 assert.equal(pendingBody.recovery_pending,true);assert.equal(pendingBody.charged,recoveryCharged);
 assert.equal(f.snapshot().state,'running','settlement pending must keep the provider checkpoint resumable');
 const recovered=await f.send();assert.equal(recovered.status,200);
 assert.deepEqual(f.counts(),{handlerCalls:1,recoveryCalls:1,deletes:0},'settlement recovery must not call the provider handler again');
 assert.equal(f.snapshot().state,'succeeded');scenarios++;
}
{
 const f=fixture();
 const response=await f.send({}, {'X-Extraction-Recovery-Mode':'checkpoint-only'});
 const body=await response.json();
 assert.equal(response.status,409);assert.equal(body.error_code,'EXTRACTION_CHECKPOINT_REQUIRED');
 assert.equal(body.provider_call_started,false);assert.equal(body.charged,false);assert.equal(body.retry_safe,true);
 assert.equal(response.headers.get('X-Extraction-Recovery-Mode'),'checkpoint-only');
 assert.equal(response.headers.get('X-Extraction-Provider-Handler'),'skipped');
 assert.equal(response.headers.get('X-Extraction-Replayed'),'false');
 assert.equal(response.headers.get('X-Extraction-Attempt-Id'),f.snapshot().record_id);
 assert.deepEqual(f.counts(),{handlerCalls:0,recoveryCalls:0,deletes:0},'checkpoint-only creation must fail closed before the provider handler');
 assert.equal(f.snapshot().state,'failed');scenarios++;
}
{
 const f=fixture('running',false,{enableRecovery:true,providerCheckpoint:{result:{schema:'fixture-provider-result.v1',videos:[{url:'https://media.invalid/video.mp4'}]}}});
 const response=await f.send({}, {'X-Extraction-Recovery-Mode':'checkpoint-only'});
 const recoveredBody=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('X-Extraction-Recovery-Mode'),'checkpoint-only');
 assert.equal(response.headers.get('X-Extraction-Provider-Handler'),'skipped');
 assert.equal(response.headers.get('X-Extraction-Replayed'),'true');
 assert.equal(response.headers.get('X-Extraction-Attempt-Id'),f.snapshot().record_id);
 assert.deepEqual(f.counts(),{handlerCalls:0,recoveryCalls:1,deletes:0},'checkpoint-only recovery may run local recovery but never the provider handler');
 assert.equal(f.snapshot().state,'succeeded');
 const replay=await f.send({}, {'X-Extraction-Recovery-Mode':'checkpoint-only'});
 assert.equal(replay.status,200);assert.deepEqual(await replay.json(),recoveredBody);
 assert.equal(replay.headers.get('X-Extraction-Recovery-Mode'),'checkpoint-only');
 assert.equal(replay.headers.get('X-Extraction-Provider-Handler'),'skipped');
 assert.equal(replay.headers.get('X-Extraction-Replayed'),'true');
 assert.equal(replay.headers.get('X-Extraction-Attempt-Id'),f.snapshot().record_id);
 assert.deepEqual(f.counts(),{handlerCalls:0,recoveryCalls:1,deletes:0},'a recovered checkpoint must replay without another recovery or provider handler call');scenarios++;
}
{
 const f=fixture('succeeded');
 const response=await f.send({}, {'X-Extraction-Recovery-Mode':'checkpoint-only'});
 assert.equal(response.status,200);assert.equal(response.headers.get('X-Extraction-Recovery-Mode'),'checkpoint-only');
 assert.equal(response.headers.get('X-Extraction-Provider-Handler'),'skipped');
 assert.equal(response.headers.get('X-Extraction-Replayed'),'true');
 assert.equal(response.headers.get('X-Extraction-Attempt-Id'),f.snapshot().record_id);
 assert.deepEqual(f.counts(),{handlerCalls:0,recoveryCalls:0,deletes:0});scenarios++;
}
{
 const f=fixture();const response=await f.send({}, {'X-Extraction-Recovery-Mode':'checkpoint-only, normal'});
 assert.equal(response.status,400);assert.equal((await response.json()).error_code,'EXTRACTION_RECOVERY_MODE_INVALID');
 assert.equal(response.headers.get('X-Extraction-Recovery-Mode'),null);assert.equal(response.headers.get('X-Extraction-Provider-Handler'),null);
 assert.equal(f.snapshot(),undefined);assert.deepEqual(f.counts(),{handlerCalls:0,recoveryCalls:0,deletes:0});scenarios++;
}
{
 const f=fixture();const response=await f.send({}, {'X-Extraction-Recovery-Mode':'checkpoint-only',Authorization:''});
 assert.equal(response.status,401);assert.equal(response.headers.get('X-Extraction-Recovery-Mode'),'checkpoint-only');
 assert.equal(response.headers.get('X-Extraction-Provider-Handler'),'skipped');
 assert.equal(f.snapshot(),undefined);assert.deepEqual(f.counts(),{handlerCalls:0,recoveryCalls:0,deletes:0});scenarios++;
}
{
 const f=fixture(undefined,undefined,{handlerResponse:{status:200,body:{success:true,charged:false},headers:{
   'X-Extraction-Recovery-Mode':'checkpoint-only','X-Extraction-Provider-Handler':'skipped'}}});
 const response=await f.send();assert.equal(response.status,200);
 assert.equal(response.headers.get('X-Extraction-Recovery-Mode'),null);assert.equal(response.headers.get('X-Extraction-Provider-Handler'),null);
 assert.deepEqual(f.counts(),{handlerCalls:1,recoveryCalls:0,deletes:0});scenarios++;
}
console.log(JSON.stringify({passed:true,scenarios,realNetworkCalls:0,realDatabaseWrites:0}));
