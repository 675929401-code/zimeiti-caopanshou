import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ffprobe from 'ffprobe-static';
import vm from 'node:vm';
import ts from 'typescript';
import { chromium } from 'playwright';

const origin=process.env.LOCAL_NAV_ORIGIN||'http://127.0.0.1:5002';
assert.ok(['http://127.0.0.1:5000','http://127.0.0.1:5002'].includes(origin),'LOCAL_PREVIEW_REQUIRED');
const token=process.env.LOCAL_NAV_ADMIN_TOKEN;assert.ok(token,'NORMAL_ADMIN_TOKEN_REQUIRED');
const runId=process.argv.find(value=>value.startsWith('--run-id='))?.slice(9);assert.match(runId||'',/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u,'FRESH_RUN_ID_REQUIRED');
const projectId='5c9786fe-64a9-4123-96a1-ddbca89e7108',finalJobId='sdj_73884a982e262c2348e78d6d355765ec';
const endpoint=`/api/short-drama/projects/${projectId}`,pagePath=`/youcai/tools/film-studio/projects/${projectId}`;
const directory=`.codex-evidence/film-subtitle-download-20260903/${runId}`;await mkdir(directory,{recursive:true});
const reportPath=`${directory}/report.json`,report={at:new Date().toISOString(),origin,projectId,originalFinalJobId:finalJobId,normalAdmin:false,stages:[],pageErrors:[],apiErrors:[],blockedMutations:[],downloads:[],generationRequests:0,assemblyRequests:0,passed:false};
await writeFile(reportPath,JSON.stringify(report),{flag:'wx'});
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2));
const hash=value=>createHash('sha256').update(value).digest('hex');
const redact=error=>({name:String(error?.name||'Error').slice(0,50),message:String(error?.message||error).split(token).join('[redacted]').replace(/https?:\/\/\S+/gu,'[url]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,'[redacted]').slice(0,280)});
const headers={Authorization:`Bearer ${token}`};
async function getJson(path){const response=await fetch(`${origin}${path}`,{headers,signal:AbortSignal.timeout(25000)});assert.equal(response.status,200,`READ_FAILED_${path}`);return response.json();}
function productionFingerprint(snapshot){return hash(JSON.stringify({shots:snapshot.shots.map(shot=>[shot.id,shot.revision,shot.updatedAt]),jobs:snapshot.jobs.map(job=>[job.id,job.publicJobId,job.state,job.updatedAt,job.completedAt]),assets:snapshot.assets.map(asset=>[asset.id,asset.jobId,asset.assetRole,asset.byteSize,asset.stableUri,asset.updatedAt])}));}
let browser,page,activeStage='preflight';
async function stage(name,work){activeStage=name;const item={name,passed:false};report.stages.push(item);try{Object.assign(item,await work());item.passed=true;}catch(error){item.error=redact(error);throw error;}finally{await save();console.log(JSON.stringify({stage:name,passed:item.passed}));}}
try{
 const identity=await getJson('/api/auth/me');assert.equal(identity.user?.role,'admin','NORMAL_ADMIN_REQUIRED');report.normalAdmin=true;
 const originalProject=(await getJson(endpoint)).project;assert.equal(originalProject.id,projectId);
 const originalProduction=await getJson(`${endpoint}/production`);
 const finalJob=originalProduction.jobs.find(job=>job.publicJobId===finalJobId&&job.stage==='final_assembly'&&job.state==='succeeded');assert.ok(finalJob,'ORIGINAL_FINAL_JOB_REQUIRED');
 assert.ok(!originalProduction.jobs.some(job=>['accepted','queued','running','result_staging','persisting','finalizing','retry_wait'].includes(job.state)),'ACTIVE_PROJECT_JOB_MUST_NOT_BE_POLLED_BY_THIS_READONLY_RUNNER');
 const finalAsset=originalProduction.assets.find(asset=>asset.assetRole==='export'&&asset.jobId===finalJob.id&&!asset.shotId);assert.ok(finalAsset,'ORIGINAL_FINAL_ASSET_REQUIRED');
 const subtitleAsset=originalProduction.assets.find(asset=>asset.id===finalAsset.metadata.subtitleAssetId&&asset.assetRole==='subtitle'&&asset.jobId===finalJob.id&&!asset.shotId);assert.ok(subtitleAsset,'ORIGINAL_PAIRED_SUBTITLE_REQUIRED');
 const beforeProjectHash=hash(JSON.stringify(originalProject)),beforeProductionHash=productionFingerprint(originalProduction);
 const previous=JSON.parse(await readFile('.codex-evidence/manju-production-e2e-20260902/final-export-verification.json','utf8'));assert.equal(previous.projectId,projectId);assert.equal(previous.bytes,finalAsset.byteSize);
 const originalFile=await readFile(previous.file);assert.equal(originalFile.length,previous.bytes);assert.equal(hash(originalFile),previous.sha256,'ORIGINAL_ARTIFACT_HASH_REQUIRED');
 const probe=spawnSync(ffprobe.path,['-v','error','-show_streams','-show_format','-of','json',previous.file],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1024*1024});assert.equal(probe.status,0,'ORIGINAL_ARTIFACT_FFPROBE_FAILED');
 const probeData=JSON.parse(probe.stdout),originalVideo=probeData.streams.find(stream=>stream.codec_type==='video');assert.ok(originalVideo,'ORIGINAL_VIDEO_STREAM_REQUIRED');
 const originalMedia={width:originalVideo.width,height:originalVideo.height,duration:Number(originalVideo.duration||probeData.format.duration)};assert.ok(originalMedia.width>0&&originalMedia.height>0&&Number.isFinite(originalMedia.duration)&&originalMedia.duration>0);report.originalMedia={...originalMedia,source:'previously downloaded and SHA256-verified original artifact'};
 const assemblyModule={exports:{}};vm.runInNewContext(ts.transpileModule(await readFile('src/lib/short-drama/final-assembly.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,assemblyModule);
 const expectedSrt=assemblyModule.exports.buildShortDramaSrt(originalProduction.shots);
 report.originalAssets={finalAssetId:finalAsset.id,subtitleAssetId:subtitleAsset.id,subtitleBytes:subtitleAsset.byteSize,jobCount:originalProduction.jobs.length,assetCount:originalProduction.assets.length,shotCount:originalProduction.shots.length};
 const anonymous=await fetch(`${origin}${endpoint}/production/download?assetId=${encodeURIComponent(subtitleAsset.id)}`,{signal:AbortSignal.timeout(25000)});assert.equal(anonymous.status,401,'ANONYMOUS_SUBTITLE_DOWNLOAD_MUST_FAIL');report.anonymousDownloadStatus=anonymous.status;
 await save();
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1450,height:1100},acceptDownloads:true,serviceWorkers:'block'});page=await context.newPage();page.setDefaultTimeout(25000);
 await context.addInitScript(({token,user})=>{localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));},{token,user:identity.user});
 page.on('pageerror',error=>report.pageErrors.push({stage:activeStage,...redact(error)}));
 page.on('response',response=>{const url=new URL(response.url());if(url.origin===origin&&url.pathname.startsWith('/api/')&&response.status()>=400)report.apiErrors.push({stage:activeStage,path:url.pathname,status:response.status()});});
 await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){let action;try{action=request.postDataJSON()?.action;}catch{/* no body */}if(action==='assemble_final')report.assemblyRequests++;if(action==='generate_image'||action==='generate_video'||/\/generate$/u.test(url.pathname))report.generationRequests++;report.blockedMutations.push({stage:activeStage,method:request.method(),path:url.pathname,action});return route.abort();}return route.continue();});
 async function openStep(step){const response=await page.goto(`${origin}${pagePath}?step=${step}`,{waitUntil:'load',timeout:45000});assert.equal(response?.status(),200);await page.getByTestId('film-project-workbench').waitFor();}
 const scriptTitle=()=>page.getByTestId('film-project-script-step').getByLabel('内容标题',{exact:true});
 const waitTitle=value=>page.waitForFunction(value=>document.querySelector('[data-testid="film-project-script-step"] input')?.value===value,value);
 await stage('script-input-discard-and-refresh',async()=>{
   await openStep('script');await scriptTitle().waitFor();const original=await scriptTitle().inputValue();assert.ok(original.length>0);assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
   await scriptTitle().fill(`${runId}-UNSAVED`);assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isEnabled(),true);await page.getByRole('button',{name:'放弃修改',exact:true}).click();await waitTitle(original);
   await scriptTitle().fill(`${runId}-CANCEL_REFRESH`);let promptType;page.once('dialog',async dialog=>{promptType=dialog.type();await dialog.dismiss();});await page.getByRole('button',{name:'刷新',exact:true}).click();await waitTitle(`${runId}-CANCEL_REFRESH`);assert.equal(promptType,'confirm');
   page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'刷新',exact:true}).click();await waitTitle(original);assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
   return {editedInBrowserOnly:true,discardRestoresOriginal:true,cancelRefreshRetainsDraft:true,confirmRefreshReadsOriginal:true,projectSaveRequests:0};
 });
 const master=()=>page.getByTestId('film-studio-final-master');
 async function readyFinal(){await master().waitFor();await master().getByRole('button',{name:'下载整片',exact:true}).waitFor();await master().getByRole('button',{name:'下载字幕 SRT',exact:true}).waitFor();await page.waitForFunction(()=>{const video=document.querySelector('[data-testid="film-studio-final-master"] video');return video&&video.readyState>=1&&video.videoWidth>0&&!video.error;},null,{timeout:45000});return master().locator('video').evaluate(video=>({width:video.videoWidth,height:video.videoHeight,duration:video.duration,mediaError:video.error?.code||null}));}
 await stage('original-final-and-srt-visible',async()=>{await openStep('final');const media=await readyFinal();assert.equal(media.width,originalMedia.width);assert.equal(media.height,originalMedia.height);assert.ok(Math.abs(media.duration-originalMedia.duration)<0.2);assert.equal(await master().getByText('统一成片 · 已持久化',{exact:true}).count(),1);return {...media,pairedSubtitleAvailable:true};});
 async function download(name,extension,assetId){const received=page.waitForEvent('download',{timeout:60000});await master().getByRole('button',{name,exact:true}).click();const item=await received;assert.equal(await item.failure(),null,'BROWSER_DOWNLOAD_FAILED');assert.ok(item.suggestedFilename().endsWith(`.${extension}`));assert.equal(new URL(page.url()).origin,origin);const file=`${directory}/original-film.${extension}`;await item.saveAs(file);const bytes=await readFile(file);const entry={assetId,extension,bytes:bytes.length,sha256:hash(bytes),filename:item.suggestedFilename(),file};report.downloads.push(entry);return {entry,bytes};}
 await stage('download-original-paired-srt',async()=>{const {entry,bytes}=await download('下载字幕 SRT','srt',subtitleAsset.id);assert.equal(bytes.length,subtitleAsset.byteSize);const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);assert.equal(text,expectedSrt,'SRT_MUST_MATCH_ORIGINAL_PROJECT_NARRATION_AND_TIMELINE');if(subtitleAsset.checksumSha256)assert.equal(entry.sha256,subtitleAsset.checksumSha256);return {bytes:entry.bytes,sha256:entry.sha256,cueCount:(text.match(/ --> /gu)||[]).length,originalNarrationAndTimingMatch:true};});
 await stage('download-unchanged-final-mp4',async()=>{const {entry}=await download('下载整片','mp4',finalAsset.id);assert.equal(entry.bytes,previous.bytes);assert.equal(entry.sha256,previous.sha256,'MUST_BE_PREVIOUSLY_DECODED_ORIGINAL_FINAL');return {bytes:entry.bytes,sha256:entry.sha256,identicalToPreviouslyDecodedFinal:true};});
 await stage('refresh-keeps-original-final-and-subtitle',async()=>{await page.reload({waitUntil:'load',timeout:45000});const media=await readyFinal();const video=master().locator('video');await video.evaluate(async node=>{node.muted=true;await node.play();});await page.waitForFunction(()=>document.querySelector('[data-testid="film-studio-final-master"] video')?.currentTime>0.15,null,{timeout:15000});await video.evaluate(node=>node.pause());const refreshed=await getJson(`${endpoint}/production`);assert.equal(productionFingerprint(refreshed),beforeProductionHash);assert.equal(hash(JSON.stringify((await getJson(endpoint)).project)),beforeProjectHash);return {...media,playbackAdvanced:true,originalProjectUnchanged:true,jobAndAssetRecordsUnchanged:true};});
 assert.deepEqual(report.blockedMutations,[]);assert.equal(report.generationRequests,0);assert.equal(report.assemblyRequests,0);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.apiErrors,[]);report.passed=true;
}catch(error){report.failure={stage:activeStage,...redact(error)};process.exitCode=1;}finally{await save();if(browser)await browser.close();console.log(JSON.stringify({passed:report.passed,stages:report.stages.map(({name,passed})=>({name,passed})),generationRequests:report.generationRequests,assemblyRequests:report.assemblyRequests,blockedMutations:report.blockedMutations.length,pageErrors:report.pageErrors.length,report:reportPath}));}
