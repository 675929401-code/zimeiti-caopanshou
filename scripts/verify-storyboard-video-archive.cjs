const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, deps = {}, globals = {}) {
  const moduleRecord = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module: moduleRecord, exports: moduleRecord.exports, require: name => name in deps ? deps[name] : require(name),
    process, console, Buffer, setInterval, clearInterval, setTimeout, clearTimeout, ...globals }, { filename: file });
  return moduleRecord.exports;
}
const policy = load('src/lib/storyboard-video-archive-policy.ts');
const now = Date.parse('2026-10-23T12:00:00Z');
const task = { task_label: '分镜工作台·段1', status: 'completed', completed_at: new Date(now - 71*3600000).toISOString(), storage_url: 'object://tencent_cos/'+encodeURIComponent(policy.STORYBOARD_ARCHIVE_PREFIX+'x.mp4'), source_expired_at: new Date(now).toISOString() };
assert.equal(policy.usableStoryboardArchive(task, now), true, 'owned archive survives upstream expiry');
assert.equal(policy.usableStoryboardArchive({...task,completed_at:null}, now), false, 'missing expiry never retains forever');
assert.equal(policy.usableStoryboardArchive({...task,status:'processing'}, now), false);
assert.equal(policy.isStoryboardArchiveExpired(task,now+3600000), true, '72-hour boundary is exclusive');
assert.equal(policy.storyboardVideoDeliveryState({...task,storage_url:null,storyboard_archive_state:'retry'},now), 'saving');
assert.equal(policy.storyboardArchiveObjectKey('object://tencent_cos/'+encodeURIComponent(policy.STORYBOARD_ARCHIVE_PREFIX+'../other.mp4')), null);
(async () => {
 let timerCallback, canceled='', boundedOptions=null, deleteError=null;
 const { TencentCOSProvider }=load('src/storage/object/providers/tencent-cos.ts',{'cos-nodejs-sdk-v5':{default:class {constructor(options){boundedOptions=options;} deleteObject(params,callback){callback(deleteError);}}}}, {setTimeout:fn=>{timerCallback=fn;return 1;},clearTimeout:()=>{}});
 const provider=new TencentCOSProvider();
 provider.cos={putObject:params=>params.onTaskReady('sdk-task'),cancelTask:id=>{canceled=id;}};
 const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
 const reservedKey=policy.STORYBOARD_ARCHIVE_PREFIX+hash('u')+'/'+hash('t')+'/00000000-0000-0000-0000-000000000000.mp4';
 const put=provider.upload(Buffer.alloc(32),'t.mp4','video/mp4',{storyboardArchiveKey:reservedKey,userId:'u',category:'video',strictProvider:true,requireOwnershipRecord:true,meta:{taskId:'t',archivePolicy:'storyboard-video-72h-v1'}});
 timerCallback();await assert.rejects(put,/STORYBOARD_ARCHIVE_UPLOAD_TIMEOUT/);assert.equal(canceled,'sdk-task','timeout cancels SDK upload instead of only abandoning promise');
 await assert.rejects(provider.upload(Buffer.alloc(32),'t.mp4','video/mp4',{storyboardArchiveKey:reservedKey,userId:'other',category:'video',strictProvider:true,requireOwnershipRecord:true,meta:{taskId:'t',archivePolicy:'storyboard-video-72h-v1'}}),/STORYBOARD_ARCHIVE_UPLOAD_INVALID/);
 provider.config={secretId:'fixture',secretKey:'fixture'};
 assert.equal(await provider.deleteStoryboardArchiveObjectOnly(reservedKey),true);assert.equal(boundedOptions.Timeout,10000,'DELETE transport deadline is configured on an isolated SDK client');
 deleteError={statusCode:503};await assert.rejects(provider.deleteStoryboardArchiveObjectOnly(reservedKey),/STORYBOARD_ARCHIVE_DELETE_UNKNOWN/);
 deleteError={statusCode:404};assert.equal(await provider.deleteStoryboardArchiveObjectOnly(reservedKey),true);
 let claimed=[], actions=[], object=null, downloads=0, failDelete=false, deletion=0;
 const db={rpc:async(name,args)=>{
  if(name==='claim_storyboard_video_archive')return {data:claimed,error:null};
  actions.push(args.p_action);
  return {data:{ok:true},error:null};
 },from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{protocol_type:'test',api_endpoint:'https://provider.example',api_key:'ref'},error:null})})})})};
 const worker=load('src/lib/storyboard-video-archive-worker.ts',{
  'server-only':{}, '@/storage/database/supabase-client':{getSupabaseAdminClient:()=>db},
  '@/storage/object':{storageManager:{headStoryboardArchiveObjectOnly:async()=>object,deleteStoryboardArchiveObjectOnly:async()=>{deletion++;return !failDelete;}}},
  '@/lib/video-persistence':{persistStableVideoFromUrl:async()=>{downloads++;object={size:32,contentType:'video/mp4'};throw Error('metadata transaction unavailable');}},
  '@/lib/provider-secret':{resolveProviderSecret:()=>''},'@/lib/video-provider-result-url':{trustedVideoProviderResultHostname:()=> 'provider.example'},
  '@/lib/durable-queue-loop':{},'@/lib/storyboard-video-archive-policy':policy,
 });
 const job={task_id:'t',user_id:'u',model_id:'m',lease_token:'token',source_url:'https://provider.example/v.mp4',expires_at:new Date(now+3600000).toISOString(),cleanup:false,object_key:null};
 claimed=[job];await worker.reconcileStoryboardVideoArchiveBatch();assert.equal(downloads,1);assert(actions.includes('prepare'));assert(actions.includes('fail'));
 actions=[];await worker.reconcileStoryboardVideoArchiveBatch();assert.equal(downloads,1,'recover uploaded object without second download');assert(actions.includes('complete'));
 actions=[];job.cleanup=true;failDelete=true;await worker.reconcileStoryboardVideoArchiveBatch();assert(!actions.includes('cleaned'),'failed COS deletion preserves metadata');assert(actions.includes('fail'));
 actions=[];failDelete=false;await worker.reconcileStoryboardVideoArchiveBatch();assert(actions.includes('cleaned'));assert.equal(deletion,2);
 console.log('PASS: policy expiry/owned-source isolation and worker upload recovery/deletion failure/success (zero network)');
})().catch(error=>{console.error(error);process.exitCode=1;});
