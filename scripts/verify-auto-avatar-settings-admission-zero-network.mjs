#!/usr/bin/env node
import assert from'node:assert/strict';import{readFileSync,mkdirSync,writeFileSync}from'node:fs';import{createHash,randomUUID}from'node:crypto';
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
const outputArgs = process.argv.slice(2);
assert.ok(outputArgs.every(value => value.startsWith('--output-dir=')), 'UNSUPPORTED_EVIDENCE_ARGUMENT');
const outputOptions = outputArgs.filter(value => value.startsWith('--output-dir='));
assert.ok(outputOptions.length <= 1, 'ONE_OUTPUT_DIRECTORY_REQUIRED');
assert.ok(!outputOptions.length || outputOptions[0].length > '--output-dir='.length, 'OUTPUT_DIRECTORY_REQUIRED');
const evidenceRoot = path.resolve('.codex-evidence');
const outputDirectory = path.resolve(outputOptions[0]?.slice('--output-dir='.length) || `.codex-evidence/auto-avatar-settings-admission/run-${randomUUID()}`);
const outputRelative = path.relative(evidenceRoot, outputDirectory);
assert.ok(outputRelative && outputRelative !== '..' && !outputRelative.startsWith('..' + path.sep) && !path.isAbsolute(outputRelative), 'OUTPUT_MUST_STAY_INSIDE_IGNORED_EVIDENCE');
// Match the existing unique-run evidence convention; reject path aliases before any test runs.
let outputAncestor = path.parse(outputDirectory).root;
for (const part of path.relative(outputAncestor, path.dirname(outputDirectory)).split(path.sep).filter(Boolean)) {
  outputAncestor = path.join(outputAncestor, part);
  try { mkdirSync(outputAncestor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const metadata = lstatSync(outputAncestor);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && path.relative(outputAncestor, realpathSync.native(outputAncestor)) === '', 'OUTPUT_ANCESTOR_MUST_BE_PHYSICAL_DIRECTORY');
}
try { mkdirSync(outputDirectory); } catch (error) { if (error.code === 'EEXIST') throw Error('EVIDENCE_RUN_DIRECTORY_EXISTS:' + outputDirectory); throw error; }
const {createHarness} = await import("./verify-platform-settings-runtime-consumers-zero-network.mjs");
const checks=[],observed=[];const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};const settle=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function fixture(options={}){const calls=[];const h=createHarness({avatarRequest:async(...args)=>{calls.push(args);return{success:false,images:[],error:'RAM_CAPTURE_ONLY'};},...options});h.state.agent={id:'avatar-agent',avatar:null,config_revision:1};h.state.coverModels=[{id:'fixture-model',name:'Fixture',model_name:'fixture',provider:'openai',api_endpoint:'https://avatar.invalid/images',api_key:'fixture-key',is_active:true,is_hidden:false}];return{h,calls,index:h.load('src/lib/auto-avatar/index.ts'),settings:h.load('src/lib/auto-avatar/settings.ts'),trigger(){this.index.triggerAutoAvatar('avatar-agent','摄影师','拍摄作品',null);}};}
for(const surface of['admin','legacy']){
 const f=fixture();assert.equal((await f.h.save(surface,{auto_avatar_enabled:'true',auto_avatar_model_id:'fixture-model'})).status,200);f.trigger();await settle();assert.equal(f.calls.length,1);
 assert.equal((await f.h.save(surface,{auto_avatar_enabled:'false'})).status,200);f.trigger();await settle();assert.equal(f.calls.length,1,'true->false immediately blocks');
 assert.equal((await f.h.save(surface,{auto_avatar_enabled:'true'})).status,200);f.trigger();await settle();assert.equal(f.calls.length,2,'false->true immediately permits');checks.push(`${surface}: immediate true->false->true`);
 for(const mode of['success','throw','error-result']){
  const r=fixture();assert.equal((await r.h.save(surface,{auto_avatar_enabled:'true',auto_avatar_model_id:'fixture-model'})).status,200);
  const pause={started:deferred(),release:deferred(),source:'consumer',table:'platform_settings',key:'auto_avatar_enabled',fail:mode==='throw',returnError:mode==='error-result'};r.h.state.pauseReads.push(pause);r.trigger();await pause.started.promise;
  assert.equal((await r.h.save(surface,{auto_avatar_enabled:'false'})).status,200);pause.release.resolve();await settle();assert.equal(r.calls.length,0,'stale successful/fallback true cannot admit');assert.ok(r.h.state.queries.filter(q=>q.source==='consumer'&&q.keys?.includes('auto_avatar_enabled')).length>=2,'old read must actively re-read after invalidation');assert.equal(await r.settings.isAutoAvatarEnabled(),false);checks.push(`${surface}: old ${mode} read across save must re-read false`);
 }
 for(const mode of['throw','error-result']){
  const unavailable=fixture();assert.equal((await unavailable.h.save(surface,{auto_avatar_enabled:'true',auto_avatar_model_id:'fixture-model'})).status,200);unavailable.trigger();await settle();assert.equal(unavailable.calls.length,1);
  assert.equal((await unavailable.h.save(surface,{auto_avatar_enabled:'false'})).status,200);const failed={started:deferred(),release:deferred(),source:'consumer',table:'platform_settings',key:'auto_avatar_enabled',fail:mode==='throw',returnError:mode==='error-result'};failed.release.resolve();unavailable.h.state.pauseReads.push(failed);unavailable.trigger();await settle();assert.equal(unavailable.calls.length,1,'new epoch DB failure must not reuse last true');assert.equal(await unavailable.settings.isAutoAvatarEnabled(),false,'warm failed read remains conservatively disabled');
  unavailable.h.state.clock+=1001;assert.equal(await unavailable.settings.isAutoAvatarEnabled(),false);assert.equal((await unavailable.h.save(surface,{auto_avatar_enabled:'true'})).status,200);unavailable.trigger();await settle();assert.equal(unavailable.calls.length,2);checks.push(`${surface}: saved disable plus fresh ${mode} fails closed and recovers`);
 }
 const disabled=fixture();assert.equal((await disabled.h.save(surface,{auto_avatar_enabled:'false',auto_avatar_model_id:'fixture-model'})).status,200);assert.equal(await disabled.settings.isAutoAvatarEnabled(),false);
 for(const mode of['throw','error-result']){disabled.settings.invalidateAutoAvatarSettingsCache();const pause={started:deferred(),release:deferred(),source:'consumer',table:'platform_settings',key:'auto_avatar_enabled',fail:mode==='throw',returnError:mode==='error-result'};pause.release.resolve();disabled.h.state.pauseReads.push(pause);assert.equal(await disabled.settings.isAutoAvatarEnabled(),false,'last valid disabled state survives read failure');}
 checks.push(`${surface}: current throw/error-result retains last disabled state`);
 const reads=disabled.h.state.queries.length;disabled.h.state.failUpsert=true;assert.equal((await disabled.h.save(surface,{auto_avatar_enabled:'true'})).status,500);const afterWrite=disabled.h.state.queries.length;assert.equal(await disabled.settings.isAutoAvatarEnabled(),false);assert.equal(disabled.h.state.queries.length,afterWrite,'failed write keeps warm cache');assert.ok(afterWrite>=reads);checks.push(`${surface}: failed save does not invalidate or enable`);
 // The explicit/manual generator entry remains separate from the automatic switch.
 await disabled.h.load('src/lib/auto-avatar/generator.ts').generateAndUpdateAvatar('avatar-agent','摄影师','拍摄作品');assert.equal(disabled.calls.length,1);checks.push(`${surface}: explicit generator still works with automatic switch disabled`);
 const provider=deferred(),started=deferred();let completed=false;const admitted=fixture({avatarRequest:async()=>{started.resolve();const result=await provider.promise;completed=true;return result;}});assert.equal((await admitted.h.save(surface,{auto_avatar_enabled:'true',auto_avatar_model_id:'fixture-model'})).status,200);admitted.trigger();await started.promise;assert.equal((await admitted.h.save(surface,{auto_avatar_enabled:'false'})).status,200);assert.equal(completed,false);provider.resolve({success:false,images:[],error:'RAM_CAPTURE_ONLY'});await settle();assert.equal(completed,true);checks.push(`${surface}: already-admitted provider operation completes after disable`);
 for(const mode of['throw','error-result']){
  const cold=fixture();const failure={started:deferred(),release:deferred(),source:'consumer',table:'platform_settings',key:'auto_avatar_enabled',fail:mode==='throw',returnError:mode==='error-result'};failure.release.resolve();cold.h.state.pauseReads.push(failure);assert.equal(await cold.settings.isAutoAvatarEnabled(),false,'cold unverified read failure fails closed');cold.h.state.clock+=1001;assert.equal(await cold.settings.isAutoAvatarEnabled(),true,'normal absence (no DB error) preserves default enabled contract');checks.push(`${surface}: cold ${mode} false; healthy missing record defaults true`);
 }
 const hard=fixture({runtimeEnv:{AUTO_AVATAR_ENABLED:'false'}});const before=hard.h.state.queries.length;hard.trigger();await settle();assert.equal(hard.calls.length,0);assert.equal(hard.h.state.queries.length,before);checks.push(`${surface}: environment hard disable skips DB and generation`);
 assert.equal(f.h.state.networkAttempts,0);observed.push({surface,actualProviderCalls:0,actualDatabaseWrites:0,actualPaidCalls:0});
}
const manual=readFileSync('src/app/api/admin/agents/batch-avatar/route.ts','utf8');assert.match(manual,/from "@\/lib\/auto-avatar\/generator"/);assert.doesNotMatch(manual,/isAutoAvatarEnabled|triggerAutoAvatar/);checks.push('manual batch route imports explicit generator, not automatic switch');
const files=['src/lib/auto-avatar/index.ts','src/lib/auto-avatar/settings.ts','src/lib/server/platform-settings-runtime-cache.ts'];const report={passed:true,checks,observed,realNetworkCalls:0,realPaidCalls:0,realDatabaseWrites:0,limits:['Single VM/process invalidation only; another process retains the 1-second TTL.','No real generation/storage/CAS success or complete batch-avatar HTTP authorization/RPC execution.','Healthy missing rows preserve default true; cold errors and invalidated epochs remain false until a successful read.'],sha256:Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]))};report.outputDirectory=outputDirectory;writeFileSync(path.join(outputDirectory,'avatar-admission-after-fix.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
