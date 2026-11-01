import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const checks = [];
const globals = { Response, Headers, ReadableStream, Uint8Array, URL, setTimeout, clearTimeout, process: { env: {} }, console: { log() {}, warn() {}, error() {} } };
function load(file, imports, extra = {}) {
 const source = fs.readFileSync(file, 'utf8');
 const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
 assert.equal((compiled.diagnostics || []).filter(x => x.category === ts.DiagnosticCategory.Error).length, 0, file);
 const exports = {}; vm.runInNewContext(compiled.outputText, { ...globals, ...extra, exports, require(name) { if (!(name in imports)) throw new Error('UNMOCKED_IMPORT:' + name); return imports[name]; } }, { filename: file });
 return exports;
}
const historyPolicy = load('src/lib/video-history-policy.ts', {});
const archivePolicy = load('src/lib/storyboard-video-archive-policy.ts', {});
const types = load('src/lib/video-content-type.ts', {});
const stream = load('src/lib/video-stream-prefix.ts', { '@/lib/video-content-type': types });
const mp4 = Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]);
const documentMedia = await stream.resolveVideoStreamContentType({ response: new Response('{"error":"failed"}', { headers: { 'content-type': 'application/json' } }), sourceUrl: 'https://media.example.test/fake.mp4' });
assert.equal(documentMedia.contentType, null); assert.equal(documentMedia.body, null); checks.push('explicit error document cannot use a video extension to bypass MIME rejection');
const mov = Uint8Array.from([0,0,0,24,102,116,121,112,113,116,32,32,0,0,0,0]);
const webm = Uint8Array.from([26,69,223,163,0,0,0,0,0,0,0,0,0,0,0,0]);
for (const [name, bytes, mime] of [['mp4',mp4,'video/mp4'],['mov',mov,'video/quicktime'],['webm',webm,'video/webm']]) {
 const media = await stream.resolveVideoStreamContentType({ response: new Response(bytes, { headers: {'content-type':'application/octet-stream'} }), sourceUrl: 'https://media.example.test/opaque' });
 assert.equal(media.contentType,mime); assert.deepEqual(new Uint8Array(await new Response(media.body).arrayBuffer()),bytes); checks.push(name+' prefix replay');
}
let reads = 0;
const peek = await stream.peekStreamPrefix(new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(1024*1024)); } }));
assert.equal(peek.prefix.length,16); await peek.replayBody.cancel(); checks.push('16 byte bounded prefix allocation and cancellation');
const timedStream = load('src/lib/video-stream-prefix.ts', { '@/lib/video-content-type': types }, { setTimeout(fn) { queueMicrotask(fn); return 1; }, clearTimeout() {} });
let timedCancelled=false;
const timed = await timedStream.resolveVideoStreamContentType({response:new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){timedCancelled=true;}})),sourceUrl:'https://media.example.test/opaque'});
assert.equal(timed.contentType,null); assert.equal(timed.body,null); assert.equal(timedCancelled,true); checks.push('stalled prefix bounded timeout cancels stream');
let emptyReads=0, emptyCancelled=false;
const empty = await stream.resolveVideoStreamContentType({response:new Response(new ReadableStream({pull(controller){emptyReads++;controller.enqueue(new Uint8Array());},cancel(){emptyCancelled=true;}})),sourceUrl:'https://media.example.test/opaque'});
assert.equal(empty.contentType,null);assert.equal(empty.body,null);assert.equal(emptyCancelled,true);assert.ok(emptyReads<=65);checks.push('empty-chunk source is bounded and cancelled');
class NextResponse extends Response { static json(body, init) { return new NextResponse(JSON.stringify(body), { ...init, headers: {'content-type':'application/json'} }); } static redirect(url,status) { return new NextResponse(null,{status,headers:{location:url}}); } }
let task, model, plan, calls, authAllowed, contentAllowed, unsafe, expiryCalls;
const owner='owner';
const imports = {
 'next/server': {NextResponse},
 '@/lib/autodl-h3-owned-result': {resolveOwnedAutodlH3VideoResultJobId(){throw Error('H3_FORBIDDEN');}},
 '@/lib/video-autodl-comfyui-workflow': {isAutodlComfyuiHostedProtocol:()=>false},
 '@/storage/database/supabase-client': {getSupabaseClient:()=>({from(table){const predicates=[]; const query={select(){return query;},eq(key,value){predicates.push([key,value]);return query;},order(){return query;},async limit(){return {data: task && predicates.every(([k,v])=>task[k]===v)?[task]:[],error:null};},async maybeSingle(){return {data:table==='video_models'?model:task && predicates.every(([k,v])=>task[k]===v)?task:null,error:null};}};return query;}})},
 '@/lib/video-persistence': {isPersistentVideoUri:value=>String(value).startsWith('object://'),resolvePersistentVideoUri:async()=> 'https://bucket.supabase.co/owned.mp4'},
 '@/lib/video-provider-result-url': {trustedVideoProviderResultHostname:()=> 'media.example.test'},
 '@/lib/video-media-auth': {authorizeVideoMediaRequest:async()=>authAllowed?{ok:true,user:{userId:owner,role:'student'}}:{ok:false,response:NextResponse.json({error:'ticket rejected'},{status:401})}},
 '@/lib/video-access-ticket': {createVideoAccessTicket:()=>{throw Error('UNEXPECTED_REDIRECT_TICKET');}},
 '@/lib/server/member-content-authority': {authorizeMemberContentAccess:async()=>contentAllowed?{ok:true,deliveryIdentity:{userId:owner,role:'student'}}:{ok:false,response:NextResponse.json({error:'owner rejected'},{status:403})},authorizeMemberContentDiscovery:()=>{throw Error('CROSS_MEMBER_FORBIDDEN');}},
 '@/lib/safe-fetch': {SafeFetchError:class extends Error {},validateSafeUrl:async()=>{if(unsafe)throw Error('SSRF_REJECTED');}},
 '@/lib/safe-media-fetch': {trustedRelayHostnamesFromEnv:()=>[],safeMediaFetch:async(url,options)=>{calls.push({url,options});assert.ok(plan.length,'unexpected fetch '+url);return {response:await plan.shift()(url,options),finalUrl:url};}},
 '@/lib/provider-secret': {resolveProviderSecret:()=> 'mock-only-secret'},
 '@/lib/video-source-expiry': {markVideoUpstreamSourceExpired:async()=>{expiryCalls++;}},
 '@/lib/video-stream-prefix': stream,
 '@/lib/storyboard-video-archive-policy': archivePolicy,
 '@/lib/video-history-policy':historyPolicy,
 '@/lib/video-delivery-persistence': {scheduleVideoDeliveryPersistence(){}},
 '@/lib/autodl-h3-selfhost': {AUTODL_H3_SELFHOST_PROTOCOL:'autodl_h3_selfhost',AUTODL_H3_SELFHOST_GATEWAY_ORIGIN:'http://127.0.0.1:9999',AUTODL_H3_SELFHOST_VIDEO_ENDPOINT:'http://127.0.0.1:9999/v1/videos',isAutodlH3Selfhost:()=>false,assertAutodlH3SelfhostModelBinding(){},fetchAutodlH3SelfhostResult(){throw Error('H3_FORBIDDEN');},resolveAutodlH3SelfhostResultUrl(){throw Error('H3_FORBIDDEN');},redactAutodlH3SelfhostResultUrl(){throw Error('H3_FORBIDDEN');}},
};
const proxy = load('src/app/api/video/proxy/route.ts',imports);
const download = load('src/app/api/video/proxy-download/route.ts',imports);
function reset() { task={id:'owned',user_id:owner,status:'completed',video_url:'https://media.example.test/opaque',task_id_external:'external',model_id:'model'}; model={protocol_type:'gaorui_video',api_endpoint:'https://api.example.test/v1',api_key:'mock-reference'};plan=[];calls=[];authAllowed=true;contentAllowed=true;unsafe=false;expiryCalls=0; }
function request(download=false,range) {const url=new URL('https://local.example.test/api/video/'+(download?'proxy-download?taskId=owned&name=clip.webm':'proxy?id=owned'));return {url:url.toString(),nextUrl:url,headers:new Headers(range?{range}:{})};}
function ranged(bytes,range='bytes 75-99/100',etag) {return new Response(bytes,{status:206,headers:{'content-type':'application/octet-stream','content-range':range,...(etag?{etag}:{})}});}
for (const range of ['bytes=0-9', 'bytes=40-', 'bytes=-25']) {
 reset();task.video_url+='?ignored='+encodeURIComponent(range);
 plan=[()=>new Response(mp4,{status:200,headers:{'content-type':'application/octet-stream','content-length':String(mp4.length),'accept-ranges':'bytes'}})];
 const response=await proxy.GET(request(false,range));assert.equal(response.status,200);
 assert.equal(response.headers.get('content-range'),null);assert.equal(response.headers.get('accept-ranges'),null);
 assert.equal(response.headers.get('content-length'),String(mp4.length));assert.equal(response.headers.get('content-type'),'video/mp4');
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),mp4);assert.equal(calls.length,1);
 checks.push('ignored '+range+' streams complete 200 with original bytes and no fabricated partial headers');
}
for (const range of ['bytes=-25','bytes=40-49']) {
 reset(); const payload=new Uint8Array(range==='bytes=-25'?25:10).fill(77);plan=[()=>ranged(payload,range==='bytes=-25'?'bytes 75-99/100':'bytes 40-49/100'),()=>ranged(mp4,'bytes 0-15/100')];
 // Use a new final URL to keep each case a true cold MIME cache.
 task.video_url+='?cold='+encodeURIComponent(range);
 const result=await proxy.GET(request(false,range));assert.equal(result.status,206);assert.equal(result.headers.get('content-type'),'video/mp4');assert.equal(result.headers.get('content-length'),String(payload.length));assert.deepEqual(new Uint8Array(await result.arrayBuffer()),payload);assert.equal(calls.length,2);assert.equal(calls[1].options.headers.Range,'bytes=0-15');assert.deepEqual(Array.from(calls[1].options.trustedHostnames),['media.example.test']);checks.push('cold '+range+' preserves original bytes and probes bounded header');
}
for(const bad of ['total','etag','html']) {
 reset();task.video_url+='?bad='+bad;plan=[()=>ranged(new Uint8Array(25),'bytes 75-99/100','"original"'),()=>bad==='html'?new Response('<html>error</html>',{headers:{etag:'"original"','content-type':'text/html'}}):ranged(mp4,bad==='total'?'bytes 0-15/101':'bytes 0-15/100',bad==='etag'?'"different"':'"original"')];
 const result=await proxy.GET(request(false,'bytes=-25'));assert.equal(result.status,502);checks.push('probe '+bad+' rejected');
}
for (const [name,handler,isDownload] of [['proxy',proxy,false],['download',download,true]]) {
 for(const flag of ['source_expired_at','history_hidden_at']) {reset();task[flag]='2026-10-12';const result=await handler.GET(request(isDownload));assert.equal(result.status,410);assert.equal(calls.length,0);checks.push(name+' '+flag+' rejects old ticket');}
 reset();authAllowed=false;assert.equal((await handler.GET(request(isDownload))).status,401);assert.equal(calls.length,0);checks.push(name+' ticket denial');
 reset();task.user_id='other';assert.equal((await handler.GET(request(isDownload))).status,404);assert.equal(calls.length,0);checks.push(name+' foreign owner denial');
}
reset();Object.assign(task,{task_label:'分镜工作台:test',completed_at:new Date().toISOString(),storage_url:'object://tencent_cos/videos/scoped/storyboard-delivery/owner/owned.mp4',source_expired_at:'upstream-only'});
assert.equal((await proxy.GET(request())).status,302);assert.equal(calls.length,0);checks.push('owned unexpired storyboard archive survives upstream expiry');
reset();Object.assign(task,{task_label:'分镜工作台:test',completed_at:'2020-01-01T00:00:00Z',storage_url:'object://tencent_cos/videos/scoped/storyboard-delivery/owner/owned.mp4'});
assert.equal((await proxy.GET(request())).status,410);assert.equal(calls.length,0);checks.push('storyboard archive expires at completion plus 72 hours before fetch');
reset();Object.assign(task,{task_label:'分镜工作台:test',completed_at:new Date().toISOString(),storage_url:'object://tencent_cos/videos/scoped/storyboard-delivery/owner/owned.mp4',source_expired_at:'2026-10-23T01:00:00Z',history_hidden_at:'2026-10-23T01:00:00Z'});
plan=[()=>new Response(mp4,{headers:{'content-type':'application/octet-stream'}})];const ownedDownload=await download.GET(request(true));assert.equal(ownedDownload.status,200);assert.equal(ownedDownload.headers.get('content-type'),'video/mp4');assert.equal(ownedDownload.headers.get('content-disposition'),'attachment; filename="clip.mp4"');assert.deepEqual(new Uint8Array(await ownedDownload.arrayBuffer()),mp4);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://bucket.supabase.co/owned.mp4');checks.push('owned unexpired storyboard download survives upstream expiry and legacy automatic hide');
reset();Object.assign(task,{task_label:'分镜工作台:test',completed_at:'2020-01-01T00:00:00Z',storage_url:'object://tencent_cos/videos/scoped/storyboard-delivery/owner/owned.mp4'});
assert.equal((await download.GET(request(true))).status,410);assert.equal(calls.length,0);checks.push('old download ticket cannot bypass 72h expiry before media fetch');
reset();unsafe=true;assert.equal((await proxy.GET(request())).status,502);assert.equal(calls.length,0);checks.push('proxy SSRF validation denies before fetch');
reset();plan=[()=>new Response(mp4,{headers:{'content-type':'application/octet-stream'}})];assert.equal((await proxy.GET(request())).status,200);task.history_hidden_at='now';assert.equal((await proxy.GET(request())).status,410);assert.equal(calls.length,1);checks.push('proxy rereads hidden state after prior successful delivery');
for(const [label,bytes,mime] of [['mp4',mp4,'video/mp4'],['webm',webm,'video/webm'],['mov',mov,'video/quicktime']]) {reset();plan=[()=>new Response(bytes,{headers:{'content-type':'application/octet-stream'}})];const response=await download.GET(request(true));assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),mime);assert.equal(response.headers.get('content-disposition'),'attachment; filename="clip.'+label+'"');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);checks.push('download opaque '+label+' detects container and keeps matching attachment extension');}
reset();plan=[()=>new Response('unavailable',{status:503}),()=>new Response(webm,{headers:{'content-type':'application/octet-stream'}})];const fallback=await download.GET(request(true));assert.equal(fallback.status,200);assert.equal(fallback.headers.get('content-type'),'video/webm');assert.equal(calls[1].url,'https://api.example.test/v1/videos/external/content');assert.equal(calls[1].options.authorization.origin,'https://api.example.test/v1');checks.push('download direct failure falls back through scoped provider content');
// Exhaust every actual route candidate; one expired path cannot turn another
// path's forbidden, network failure or timeout rejection into confirmed expiry.
const nonExpiryFailures = [
 ['HTTP 403',()=>new Response('forbidden',{status:403}),403],
 ['network throw',()=>{throw new Error('fixture network failure');},502],
 ['timeout reject',async()=>{throw Object.assign(new Error('fixture timeout'),{name:'TimeoutError'});},502],
];
for(const [name,handler,isDownload] of [['proxy',proxy,false],['download',download,true]]) {
 for(const [failure,fail,proxyStatus] of nonExpiryFailures) {
  for(const scenario of ['all candidates fail','direct 404 fallback fails','direct fails fallback 404']) {
   reset();Object.assign(task,{source_expired_at:null,history_hidden_at:null,provider_result_url:task.video_url,content_url:task.video_url,thumbnail_url:'https://media.example.test/thumbnail.jpg'});
   const before=structuredClone(task),direct=task.provider_result_url,content='https://api.example.test/v1/videos/external/content';
   const gone=()=>new Response('gone',{status:404});
   const directFailure=scenario==='direct 404 fallback fails'?gone:fail;
   const fallbackFailure=scenario==='direct fails fallback 404'?gone:fail;
   plan=isDownload?[directFailure,fallbackFailure,directFailure]:[directFailure,fallbackFailure];
   const result=await handler.GET(request(isDownload));
   assert.equal(result.status,isDownload?502:scenario==='direct fails fallback 404'?404:proxyStatus);
   assert.deepEqual(calls.map(call=>call.url),isDownload?[direct,content,direct]:[direct,content]);
   assert.equal(plan.length,0,'every planned failed source must actually execute');
   assert.equal(expiryCalls,0,'non-definitive failure must not invoke source expiry');
   assert.deepEqual(task,before,'failed delivery must preserve history visibility and all source URLs');
   checks.push(name+' '+failure+' '+scenario+' preserves source and history without expiry');
  }
 }
 reset();plan=isDownload?[()=>new Response('gone',{status:404}),()=>new Response('gone',{status:410}),()=>new Response('gone',{status:404})]:[()=>new Response('gone',{status:404}),()=>new Response('gone',{status:410})];
 assert.equal((await handler.GET(request(isDownload))).status,410);assert.equal(expiryCalls,1);assert.equal(plan.length,0);
 assert.deepEqual(calls.map(call=>call.url),isDownload?[task.video_url,'https://api.example.test/v1/videos/external/content',task.video_url]:[task.video_url,'https://api.example.test/v1/videos/external/content']);
 checks.push(name+' confirmed direct 404 and fallback 410 expiry marks once');
}
const report={ok:true,tests:checks.length,checks,productionDatabaseCalls:0,realNetworkCalls:0,modelCalls:0,realBrowserDecodeTested:false,formatBytes:'synthetic container headers, not codec media',reads};
if(process.env.VIDEO_TEST_EVIDENCE_DIR){fs.mkdirSync(process.env.VIDEO_TEST_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.VIDEO_TEST_EVIDENCE_DIR,'proxy-stream-download-report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
