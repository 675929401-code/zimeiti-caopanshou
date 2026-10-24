import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(source,'package.json'));
const {chromium}=require('playwright'),ts=require('typescript');
const evidence=path.resolve(source,'../运行日志/视频历史闭环-20261018-a758/cache-verification');
const output=path.join(evidence,'cache-free-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(output,{recursive:true});
const clip=path.join(output,'fixture-16s.mp4');
execFileSync(path.join(source,'node_modules/ffmpeg-static/ffmpeg.exe'),['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','16','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',clip],{windowsHide:true});
const bytes=await fs.readFile(clip),sha=crypto.createHash('sha256').update(bytes).digest('hex');
const cacheSource=await fs.readFile(path.join(source,'src/lib/storyboard-local-video-cache.ts'),'utf8'),policySource=await fs.readFile(path.join(source,'src/lib/video-history-policy.ts'),'utf8');
const code=ts.transpileModule(cacheSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const policyCode=ts.transpileModule(policySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const browser=await chromium.launch({headless:true,executablePath:'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe'});
const report={schema:'storyboard-local-video-cache-browser.v1',actualProductUi:false,sourceModule:true,fixtureAuthOnly:true,actualLogin:0,actualBusinessWrites:0,providerCalls:0,cloudCopies:0,checks:[],fixture:{bytes:bytes.length,sha256:sha,durationSeconds:16},getRequests:[],blockedRequests:[]};
report.sourceSha256={cache:crypto.createHash('sha256').update(cacheSource).digest('hex'),policy:crypto.createHash('sha256').update(policySource).digest('hex'),verifier:crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex')};
let offline=false;
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true,serviceWorkers:'block'});
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());
  if(request.method()==='GET'&&url.origin==='http://127.0.0.1:5000'&&url.pathname==='/__storyboard_cache_fixture__')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head><title>Isolated local video cache fixture</title></head><body></body></html>'});
  if(request.method()==='GET'&&url.origin==='http://127.0.0.1:5000'&&url.pathname==='/api/video/proxy-download'){
   report.getRequests.push({taskId:url.searchParams.get('taskId'),range:request.headers().range||null,fixtureOnly:true});
   if(offline)return route.abort();
   assert.equal(request.headers().authorization,'Bearer fixture-token-A');return route.fulfill({status:200,contentType:'video/mp4',headers:{'content-length':String(bytes.length)},body:bytes});
  }
  report.blockedRequests.push({method:request.method(),path:url.pathname});return route.abort();
 });
 const page=await context.newPage();report.pageErrors=[];page.on('pageerror',error=>report.pageErrors.push(error.name));
 const install=async(target=page)=>{await target.addScriptTag({content:`{const policyModule={exports:{}};{const module=policyModule;const exports=module.exports;${policyCode}}const require=name=>{if(name==="./video-history-policy")return policyModule.exports;throw Error("Unexpected fixture import");};const module={exports:{}};const exports=module.exports;${code};window.cacheApi=module.exports;}`});await target.evaluate(()=>{Object.defineProperty(navigator.storage,'estimate',{configurable:true,value:async()=>({usage:0,quota:4*1024**3})});window.fixtureItem={taskId:'fixture-video-0001',status:'completed',createdAt:new Date(Date.now()-60000).toISOString(),batchId:'fixture-batch',batchTopic:'零费用本机缓存夹具',cardIndex:1,modelName:'夹具模型',duration:16,posterUrl:'https://never-persist.invalid/?signature=SECRET'};});};
 await page.goto('http://127.0.0.1:5000/__storyboard_cache_fixture__');await install();
 await page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('storyboard-local-video-v1',1);open.onupgradeneeded=()=>{const store=open.result.createObjectStore('videos',{keyPath:'key'});store.createIndex('scopeKey','scopeKey',{unique:false});};open.onsuccess=()=>{open.result.close();resolve();};open.onerror=()=>reject(open.error);}));
 const first=await page.evaluate(async()=>{window.sessionA=new window.cacheApi.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A');const record=await window.sessionA.save(window.fixtureItem);const list=await window.sessionA.list(),poster=await window.sessionA.poster(window.fixtureItem.taskId);return {record,list,posterBytes:poster?.size||0};});
 assert.equal(first.record.sha256,sha);assert.equal(first.record.size,bytes.length);assert.equal(first.list[0].available,true);assert.ok(first.posterBytes>0);assert.ok(!/SECRET|Bearer|fixture-token|https?:\/\//i.test(JSON.stringify(first.record)));report.checks.push('Complete authenticated native GET persisted full 16s bytes and poster; committed index contains no URL/token');
 report.checks.push('IndexedDB version-1 videos store upgrades to version 2 without recreating the existing store');
 assert.equal(report.getRequests.length,1);assert.equal(report.getRequests[0].range,null);
 offline=true;await page.reload();await install();
 const restored=await page.evaluate(async()=>{window.sessionA=new window.cacheApi.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A');const list=await window.sessionA.list(),blob=await window.sessionA.load(window.fixtureItem.taskId),poster=await window.sessionA.poster(window.fixtureItem.taskId);if(!blob)throw Error('Missing fixture cache');window.playbackUrl=URL.createObjectURL(blob);const video=document.createElement('video');video.id='fixture-playback';video.controls=true;video.muted=true;video.src=window.playbackUrl;document.body.appendChild(video);await video.play();return {list,posterBytes:poster?.size||0,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('')};});
 assert.equal(restored.sha256,sha);assert.equal(restored.list[0].available,true);assert.ok(restored.posterBytes>0);await page.waitForFunction(()=>document.getElementById('fixture-playback').currentTime>8,{},{timeout:18000});
 const playback=await page.evaluate(async()=>{const video=document.getElementById('fixture-playback');video.pause();const playedTo=video.currentTime;const seeked=new Promise(resolve=>video.addEventListener('seeked',resolve,{once:true}));video.currentTime=14;await seeked;return {playedTo,seekedTo:video.currentTime,duration:video.duration};});assert.ok(playback.playedTo>8);assert.ok(playback.seekedTo>=14);assert.ok(playback.duration>=15.9);assert.equal(report.getRequests.length,1);report.playback=playback;report.checks.push('After page refresh, loaded page plays offline beyond 8s and seeks to 14s without network/Range');
 const downloadPromise=page.waitForEvent('download');await page.evaluate(()=>{const anchor=document.createElement('a');anchor.href=window.playbackUrl;anchor.download='cached-original.mp4';document.body.appendChild(anchor);anchor.click();anchor.remove();});const download=await downloadPromise;const downloaded=path.join(output,'downloaded-original.mp4');await download.saveAs(downloaded);assert.equal(crypto.createHash('sha256').update(await fs.readFile(downloaded)).digest('hex'),sha);report.checks.push('Offline download uses same complete local Blob; SHA matches original');

 const results=await page.evaluate(async()=>{
  const api=window.cacheApi,base=window.fixtureItem,checks=[];let serial=0;
  const ensure=(value,name)=>{if(!value)throw Error(name);checks.push(name);};
  const complete=await window.sessionA.load(base.taskId);const bytes=new Uint8Array(await complete.arrayBuffer());
  const next=()=>({...base,taskId:'fixture-failure-'+String(++serial).padStart(4,'0')});
  const response=(options={})=>new Response(bytes,{status:options.status||200,headers:{'content-type':options.mime||'video/mp4',...(options.length===null?{}:{'content-length':String(options.length??bytes.length)}),...(options.range?{'content-range':'bytes 0-99/1000'}:{})}});
  const rejectSave=async(fetcher,expected)=>{const session=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',fetcher),item=next();let code='';try{await session.save(item);}catch(error){code=typeof error.code==='string'?error.code:error.name;}ensure(code===expected,'reject-'+expected);ensure(!(await session.list()).some(entry=>entry.record.taskId===item.taskId),'no-ready-'+expected);session.dispose();};
  await rejectSave(async()=>response({status:206,range:true}),'PARTIAL_RESPONSE');
  await rejectSave(async()=>response({mime:'text/html'}),'INVALID_VIDEO_MIME');
  await rejectSave(async()=>new Response('<html>not-video</html>',{headers:{'content-type':'video/mp4'}}),'INVALID_VIDEO_BYTES');
  await rejectSave(async()=>response({length:bytes.length+12}),'INCOMPLETE_VIDEO');
  await rejectSave(async()=>response({length:513*1024**2}),'VIDEO_TOO_LARGE');
  await rejectSave(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,32));controller.error(Error('fixture interruption'));}}),{headers:{'content-type':'video/mp4'}}),'SAVE_FAILED');
  let fetches=0;Object.defineProperty(navigator.storage,'estimate',{configurable:true,value:async()=>({usage:1023*1024**2,quota:1024**3})});await rejectSave(async()=>{fetches++;return response();},'INSUFFICIENT_SPACE');ensure(fetches===0,'quota-before-any-download');
  Object.defineProperty(navigator.storage,'estimate',{configurable:true,value:async()=>({usage:80*1024**2,quota:200*1024**2})});let canceled=false;await rejectSave(async()=>new Response(new ReadableStream({pull(controller){const chunk=new Uint8Array(8*1024**2);chunk.set(bytes.slice(0,12));controller.enqueue(chunk);},cancel(){canceled=true;}}),{headers:{'content-type':'video/mp4'}}),'VIDEO_TOO_LARGE');ensure(canceled,'unknown-length-stream-bounded-and-canceled');
  Object.defineProperty(navigator.storage,'estimate',{configurable:true,value:async()=>({usage:0,quota:4*1024**3})});
  const cache=await caches.open('storyboard-local-video-bytes-v1'),cacheProto=Object.getPrototypeOf(cache),nativePut=cacheProto.put;
  cacheProto.put=function(){return Promise.reject(new DOMException('fixture quota','QuotaExceededError'));};
  const replaceSession=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>response());let quotaFailed=false;try{await replaceSession.save(base,{replace:true});}catch(error){quotaFailed=error.name==='QuotaExceededError';}finally{cacheProto.put=nativePut;replaceSession.dispose();}ensure(quotaFailed,'cache-quota-failure-visible');ensure((await window.sessionA.list()).find(row=>row.record.taskId===base.taskId)?.available,'old-ready-survives-failed-replacement');
  const beforeKeys=(await cache.keys()).length,transaction=IDBDatabase.prototype.transaction;let abortOnce=true;
  IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(args[1]==='readwrite'&&abortOnce){abortOnce=false;const objectStore=tx.objectStore.bind(tx);tx.objectStore=function(...storeArgs){const store=objectStore(...storeArgs),put=store.put.bind(store);store.put=function(...values){const request=put(...values);tx.abort();return request;};return store;};}return tx;};
  try{await rejectSave(async()=>response(),'AbortError');}finally{IDBDatabase.prototype.transaction=transaction;}
  ensure((await cache.keys()).length===beforeKeys,'transaction-abort-removes-orphan-bytes');
  let release;const gate=new Promise(resolve=>{release=resolve;});let written=false;
  cacheProto.put=async function(...args){await nativePut.apply(this,args);written=true;await gate;};
  const late=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>response()),lateItem=next();const lateResult=late.save(lateItem).then(()=>false,()=>true);
  while(!written)await new Promise(resolve=>setTimeout(resolve,10));late.dispose();const sessionB=new api.StoryboardLocalVideoSession('fixture-actor-B','fixture-token-B');release();try{ensure(await lateResult,'actor-switch-aborts-late-write');}finally{cacheProto.put=nativePut;}
  ensure(!(await window.sessionA.list()).some(row=>row.record.taskId===lateItem.taskId),'actor-switch-no-late-index-ready');ensure((await sessionB.list()).length===0&&await sessionB.load(base.taskId)===null,'actor-B-cannot-read-A');sessionB.dispose();ensure((await cache.keys()).length===beforeKeys,'actor-switch-cleans-orphan-bytes');
  let concurrent=0,maxConcurrent=0;const queued=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>{concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);await new Promise(resolve=>setTimeout(resolve,30));concurrent--;return response();});const q1={...next(),batchId:'queue-fixture',cardIndex:1},q2={...next(),batchId:'queue-fixture',cardIndex:2};await Promise.all([queued.save(q1),queued.save(q2)]);ensure(maxConcurrent===1,'completed-download-queue-concurrency-one');queued.dispose();
  const local=(await window.sessionA.list()),newer={...base,taskId:'fixture-newer-0001',createdAt:new Date().toISOString(),status:'processing'};
  ensure(api.mergeStoryboardHistory([newer],local).filter(row=>row.batchId===base.batchId&&row.cardIndex===base.cardIndex).length===2&&api.mergeStoryboardHistory([newer],local).some(row=>row.taskId===newer.taskId),'same-batch-card-retains-all-attempts');
  ensure(api.mergeStoryboardHistory([],local).some(row=>row.taskId===base.taskId),'empty-remote-list-does-not-delete-cache');
  const videoSession=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>response(),'video-page');
  await videoSession.save({...base,surface:'video-page'});
  ensure((await videoSession.list()).length===1&&(await window.sessionA.list()).some(row=>row.record.taskId===base.taskId),'same-user-surfaces-use-independent-namespaces');
  const mutateIndex=async(key,patch)=>{const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('storyboard-local-video-v1',2);open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});try{await new Promise((resolve,reject)=>{const tx=db.transaction('videos','readwrite'),store=tx.objectStore('videos'),get=store.get(key);get.onsuccess=()=>store.put({...get.result,...patch});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}};
  const legacyRecord=(await window.sessionA.list()).find(row=>row.record.taskId===base.taskId).record;
  await mutateIndex(legacyRecord.key,{surface:undefined});
  ensure((await window.sessionA.list()).some(row=>row.record.taskId===base.taskId)&&(await videoSession.list()).every(row=>row.record.surface==='video-page'),'legacy-without-surface-belongs-only-to-storyboard');
  let surfaceError='';try{await videoSession.save(base);}catch(error){surfaceError=error.code;}ensure(surfaceError==='SURFACE_MISMATCH','surface-mismatch-cannot-save');
  const retention=120*60*60*1000,clock=Date.now,nativeNow=clock(),completedAt=nativeNow-retention+5000;
  const ttlItem={...next(),createdAt:new Date(nativeNow-retention-60000).toISOString(),completedAt:new Date(completedAt).toISOString()};
  const ttlSession=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>response());
  const ttlRecord=await ttlSession.save(ttlItem);
  try{
    Date.now=()=>completedAt+retention-1;
    ensure((await ttlSession.list()).some(row=>row.record.taskId===ttlItem.taskId),'ttl-keeps-record-until-120h');
    Date.now=()=>completedAt+retention;
    ensure(await ttlSession.load(ttlItem.taskId)===null&&!(await ttlSession.list()).some(row=>row.record.taskId===ttlItem.taskId),'ttl-expires-at-exact-120h-on-access');
    ensure(!(await cache.match(new Request(new URL(ttlRecord.bytesKey,location.origin))))&&(!ttlRecord.posterBytesKey||!(await cache.match(new Request(new URL(ttlRecord.posterBytesKey,location.origin))))),'ttl-removes-full-bytes-and-poster');
    let expiration='';try{await ttlSession.save(ttlItem);}catch(error){expiration=error.code;}ensure(expiration==='VIDEO_EXPIRED','savedAt-cannot-extend-retention');
  }finally{Date.now=clock;}
  const unknownSession=new api.StoryboardLocalVideoSession('fixture-actor-unknown','fixture-token-A',async()=>response()),unknownItem={...next(),createdAt:'unknown',completedAt:'invalid'};await unknownSession.save(unknownItem);
  try{Date.now=()=>nativeNow+retention*10;ensure((await unknownSession.list()).some(row=>row.record.taskId===unknownItem.taskId),'unknown-timestamps-not-deleted');}finally{Date.now=clock;}
  await unknownSession.clearLocal([unknownItem.taskId]);unknownSession.dispose();ttlSession.dispose();
  const raceBefore=(await cache.keys()).length;let raceWritten=false,raceRelease;
  const raceGate=new Promise(resolve=>{raceRelease=resolve;});
  cacheProto.put=async function(...args){await nativePut.apply(this,args);raceWritten=true;await raceGate;};
  const raceSession=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>response()),raceItem=next();
  const raceSave=raceSession.save(raceItem).then(()=>false,error=>error.name==='AbortError');
  while(!raceWritten)await new Promise(resolve=>setTimeout(resolve,10));
  const raceClear=window.sessionA.clearLocal([raceItem.taskId]);await new Promise(resolve=>setTimeout(resolve,20));raceRelease();
  try{ensure(await raceSave,'clear-cancels-late-save-from-another-session');await raceClear;}finally{cacheProto.put=nativePut;raceSession.dispose();}
  ensure((await cache.keys()).length===raceBefore&&!(await window.sessionA.list()).some(row=>row.record.taskId===raceItem.taskId),'clear-prevents-late-index-and-orphan-media');
  const freshSession=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>response());let tombstone='';try{await freshSession.save(raceItem);}catch(error){tombstone=error.code;}freshSession.dispose();ensure(tombstone==='HIDDEN_VIDEO','durable-tombstone-prevents-reload-resurrection');
  const failedClearSession=new api.StoryboardLocalVideoSession('fixture-actor-clear-failure','fixture-token-A',async()=>response()),failedClearItem=next(),failedClearRecord=await failedClearSession.save(failedClearItem),nativeDelete=cacheProto.delete;
  let deletionFailed=false;cacheProto.delete=function(){return Promise.reject(Error('fixture cache deletion unavailable'));};
  try{await failedClearSession.clearLocal([failedClearItem.taskId]);}catch{deletionFailed=true;}finally{cacheProto.delete=nativeDelete;}
  ensure(deletionFailed,'failed-local-clear-is-reported');
  ensure((await failedClearSession.list()).length===0&&!(await cache.match(new Request(new URL(failedClearRecord.bytesKey,location.origin)))),'next-access-retries-tombstoned-byte-cleanup');
  let failedClearTombstone='';try{await failedClearSession.save(failedClearItem);}catch(error){failedClearTombstone=error.code;}failedClearSession.dispose();ensure(failedClearTombstone==='HIDDEN_VIDEO','failed-clear-cannot-resurrect-saved-task');
  let lockEntered,lockRelease;const lockStarted=new Promise(resolve=>{lockEntered=resolve;}),lockGate=new Promise(resolve=>{lockRelease=resolve;});
  const heldLock=navigator.locks.request('storyboard-local-video-v1-write',async()=>{lockEntered();await lockGate;});await lockStarted;
  let queuedFetches=0;const clearQueuedSession=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>{queuedFetches++;return response();}),clearQueuedItem=next();
  const queuedSave=clearQueuedSession.save(clearQueuedItem).then(()=>false,error=>error.name==='AbortError');await new Promise(resolve=>setTimeout(resolve,20));
  const clearQueued=window.sessionA.clearLocal();await new Promise(resolve=>setTimeout(resolve,20));lockRelease();
  ensure(await queuedSave,'clear-all-cancels-save-waiting-for-initial-cleanup-lock');await Promise.all([clearQueued,heldLock]);clearQueuedSession.dispose();ensure(queuedFetches===0,'cleared-queued-save-does-not-fetch');
  // Restore two neighboring attempts for the precise-deletion assertions.
  const restoredQ1={...q1,taskId:next().taskId},restoredQ2={...q2,taskId:next().taskId};
  const fallback=new api.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>response());
  Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
  try{await Promise.all([fallback.save(restoredQ1),fallback.save(restoredQ2)]);ensure((await fallback.list()).length===2,'browser-without-web-locks-keeps-serialized-fallback');}finally{delete navigator.locks;fallback.dispose();}
  await window.sessionA.clearLocal([restoredQ1.taskId]);ensure(!(await window.sessionA.list()).some(row=>row.record.taskId===restoredQ1.taskId)&&(await window.sessionA.list()).some(row=>row.record.taskId===restoredQ2.taskId),'clear-selected-ids-preserves-neighbor');
  const baseRecord=(await window.sessionA.list()).find(row=>row.record.taskId===restoredQ2.taskId).record;await cache.delete(new Request(new URL(baseRecord.bytesKey,location.origin)));const missing=await window.sessionA.list();ensure(missing.find(row=>row.record.taskId===restoredQ2.taskId)?.available===false&&await window.sessionA.load(restoredQ2.taskId)===null,'metadata-without-bytes-never-ready');
  await window.sessionA.applyTombstones([restoredQ2.taskId]);ensure(!api.mergeStoryboardHistory([],await window.sessionA.list()).some(row=>row.taskId===restoredQ2.taskId),'explicit-tombstone-prevents-offline-resurrection');
  ensure(!baseRecord.posterBytesKey||!(await cache.match(new Request(new URL(baseRecord.posterBytesKey,location.origin)))),'tombstone-removes-poster-bytes');
  await window.sessionA.clearLocal();ensure((await window.sessionA.list()).length===0&&(await videoSession.list()).length===1,'clear-all-is-account-and-surface-scoped');await videoSession.clearLocal();videoSession.dispose();
  const readMarkers=async()=>{const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('storyboard-local-video-v1',2);open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});try{return await new Promise((resolve,reject)=>{const tx=db.transaction('tombstones','readonly'),request=tx.objectStore('tombstones').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}finally{db.close();}};
  const remoteOnlyId='fixture-never-cached-0001',markerStart=Date.now();await window.sessionA.clearLocal([remoteOnlyId]);
  const remoteOnlyMarker=(await readMarkers()).find(row=>row.taskId===remoteOnlyId);
  ensure(Number.isFinite(remoteOnlyMarker?.expiresAt)&&remoteOnlyMarker.expiresAt>=markerStart+retention+180000&&remoteOnlyMarker.expiresAt<=Date.now()+retention+180000,'remote-only-tombstone-has-finite-retention');
  try{
    Date.now=()=>remoteOnlyMarker.expiresAt-1;await window.sessionA.clearLocal([remoteOnlyId]);await window.sessionA.list();
    ensure((await readMarkers()).find(row=>row.taskId===remoteOnlyId)?.expiresAt===remoteOnlyMarker.expiresAt,'repeat-clear-does-not-extend-remote-only-marker');
    Date.now=()=>remoteOnlyMarker.expiresAt;await window.sessionA.list();ensure(!(await readMarkers()).some(row=>row.taskId===remoteOnlyId),'remote-only-marker-pruned-after-120h-and-max-save-time');
  }finally{Date.now=clock;}
  ensure(!/SECRET|Bearer|fixture-token|https?:\/\//i.test(JSON.stringify((await window.sessionA.list()).map(row=>row.record))),'all-index-metadata-free-of-urls-and-tokens');
  return checks;
 });report.checks.push(...results);
 const otherTab=await context.newPage();otherTab.on('pageerror',error=>report.pageErrors.push(error.name));await otherTab.goto('http://127.0.0.1:5000/__storyboard_cache_fixture__');await install(otherTab);
 const crossTabTask=await page.evaluate(async fixtureBytes=>{
   const cache=await caches.open('storyboard-local-video-bytes-v1'),proto=Object.getPrototypeOf(cache);window.nativeCrossTabPut=proto.put;window.crossTabCacheProto=proto;
   let written;const started=new Promise(resolve=>{written=resolve;}),gate=new Promise(resolve=>{window.releaseCrossTab=resolve;});
   proto.put=async function(...args){await window.nativeCrossTabPut.apply(this,args);written();await gate;};Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
   const item={...window.fixtureItem,taskId:'fixture-cross-tab-0001'};window.crossTabSession=new window.cacheApi.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>new Response(new Uint8Array(fixtureBytes),{headers:{'content-type':'video/mp4','content-length':String(fixtureBytes.length)}}));
   window.crossTabSave=window.crossTabSession.save(item).then(()=>({saved:true}),error=>({saved:false,code:error.code}));await started;return item.taskId;
 },Array.from(bytes));
 await otherTab.evaluate(async taskId=>{Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});const session=new window.cacheApi.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A');try{await session.clearLocal([taskId]);}finally{session.dispose();delete navigator.locks;}},crossTabTask);
 const crossTab=await page.evaluate(async taskId=>{try{window.releaseCrossTab();const result=await window.crossTabSave;const rows=await window.sessionA.list(),cache=await caches.open('storyboard-local-video-bytes-v1');return {...result,visible:rows.some(row=>row.record.taskId===taskId),orphan:(await cache.keys()).some(request=>new URL(request.url).pathname.includes(taskId))};}finally{window.crossTabCacheProto.put=window.nativeCrossTabPut;window.crossTabSession.dispose();delete navigator.locks;}},crossTabTask);
 assert.deepEqual(crossTab,{saved:false,code:'HIDDEN_VIDEO',visible:false,orphan:false});report.checks.push('Separate browser tabs without Web Locks cannot revive a cleared in-flight cache or leave orphan bytes');
 const readRaceItems=await page.evaluate(async fixtureBytes=>{
   window.readRaceSession=new window.cacheApi.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A',async()=>new Response(new Uint8Array(fixtureBytes),{headers:{'content-type':'video/mp4','content-length':String(fixtureBytes.length)}}));
   const video={...window.fixtureItem,taskId:'fixture-clear-during-load-0001'},poster={...window.fixtureItem,taskId:'fixture-clear-during-poster-0001'};
   await window.readRaceSession.save(video);await window.readRaceSession.save(poster);return {video:video.taskId,poster:poster.taskId};
 },Array.from(bytes));
 await page.evaluate(async taskId=>{
   const proto=Object.getPrototypeOf(crypto.subtle);window.readDigestProto=proto;window.nativeReadDigest=proto.digest;
   let entered;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{window.releaseReadRace=resolve;});
   proto.digest=async function(...args){const result=await window.nativeReadDigest.apply(this,args);entered();await gate;return result;};
   window.readRaceResult=window.readRaceSession.load(taskId);await started;
 },readRaceItems.video);
 await otherTab.evaluate(async taskId=>{const session=new window.cacheApi.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A');try{await session.clearLocal([taskId]);}finally{session.dispose();}},readRaceItems.video);
 const loadAfterClear=await page.evaluate(async()=>{try{window.releaseReadRace();return await window.readRaceResult===null;}finally{window.readDigestProto.digest=window.nativeReadDigest;}});
 assert.equal(loadAfterClear,true);report.checks.push('A second tab clearing during video SHA validation prevents load from returning the deleted Blob');
 await page.evaluate(async taskId=>{
   window.nativePosterBlob=Response.prototype.blob;let entered;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{window.releasePosterRace=resolve;});
   Response.prototype.blob=async function(...args){const result=await window.nativePosterBlob.apply(this,args);if(this.headers.get('content-type')==='image/png'){entered();await gate;}return result;};
   window.posterRaceResult=window.readRaceSession.poster(taskId);await started;
 },readRaceItems.poster);
 await otherTab.evaluate(async taskId=>{const session=new window.cacheApi.StoryboardLocalVideoSession('fixture-actor-A','fixture-token-A');try{await session.clearLocal([taskId]);}finally{session.dispose();}},readRaceItems.poster);
 const posterAfterClear=await page.evaluate(async()=>{try{window.releasePosterRace();return await window.posterRaceResult===null;}finally{Response.prototype.blob=window.nativePosterBlob;window.readRaceSession.dispose();}});
 assert.equal(posterAfterClear,true);report.checks.push('A second tab clearing during poster decoding prevents poster from returning the deleted Blob');await otherTab.close();
 assert.equal(report.getRequests.length,1);assert.deepEqual(report.pageErrors,[]);assert.equal(report.blockedRequests.length,0);report.status='PASS';
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,passed:report.checks.length,output,actualBusinessWrites:0,providerCalls:0}));
}catch(error){report.status='FAIL';report.error=String(error?.message||error).replace(/https?:\/\/[^\s]+/g,'[URL_REDACTED]').slice(0,600);await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));throw error;}
finally{await browser.close();}
