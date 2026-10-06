import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
const base='http://127.0.0.1:5000',directory='.codex-evidence/manju-production-e2e-20260902';
const token=process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();if(!token)throw new Error('NORMAL_ADMIN_TOKEN_REQUIRED');
const runtime=JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json','utf8'));
if(!runtime.localOnly||runtime.ownerConnection.host!=='127.0.0.1'||runtime.ownerConnection.port!==54322||runtime.ownerConnection.database!=='zimeiti_local')throw new Error('LOCAL_ONLY');
const headers={authorization:`Bearer ${token}`};
const identity=await fetch(`${base}/api/auth/me`,{headers});const me=await identity.json();if(!identity.ok||me.user?.role!=='admin')throw new Error('NORMAL_ADMIN_LOGIN_REQUIRED');
const manifest=JSON.parse(await readFile(`${directory}/manifest.json`,'utf8'));
if(manifest.projectId!=='5c9786fe-64a9-4123-96a1-ddbca89e7108')throw new Error('OWN_TEST_PROJECT_REQUIRED');
const endpoint=`${base}/api/short-drama/projects/${manifest.projectId}`;
const productionResponse=await fetch(`${endpoint}/production`,{headers});const production=await productionResponse.json();
if(!productionResponse.ok)throw new Error('PRODUCTION_READ_FAILED');
const job=production.jobs.find(item=>item.publicJobId==='sdj_128e7b358d4f58f010a36c078dd2a0de'&&item.state==='succeeded'&&item.modelPublicId==='pm_O31GjpRvlTXjWUM1Ha9FG0N2');
if(!job)throw new Error('KNOWN_VIDEO_NOT_SUCCEEDED');
const finalMode=process.argv.includes('--final');
const finalAsset=production.assets.find(item=>item.assetRole==='export'&&!item.shotId);
if(finalMode&&!finalAsset)throw new Error('FINAL_ASSET_REQUIRED');
const response=finalMode
 ?await fetch(`${endpoint}/production/download?assetId=${encodeURIComponent(finalAsset.id)}`,{headers,signal:AbortSignal.timeout(120000)})
 :await fetch(`${endpoint}/production/export`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jobId:job.publicJobId,targetDurationSeconds:10}),signal:AbortSignal.timeout(120000)});
if(!response.ok){const e=await response.json().catch(()=>({}));throw new Error(`EXPORT_FAILED_${e.code||response.status}`);}
if(!response.headers.get('content-type')?.startsWith('video/mp4'))throw new Error('EXPORT_TYPE_INVALID');
const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>50*1024*1024)throw new Error('EXPORT_TOO_LARGE');chunks.push(chunk);}
const content=Buffer.concat(chunks),file=`${directory}/${finalMode?'film-final':'film-one-shot'}.mp4`;if(content.length<1000)throw new Error('EXPORT_EMPTY');await writeFile(file,content);
const decoded=spawnSync(ffmpeg,['-v','error','-i',file,'-f','null','-'],{encoding:'utf8',timeout:90000,windowsHide:true});
const report={normalAdmin:true,projectId:manifest.projectId,publicJobId:job.publicJobId,modelPublicId:job.modelPublicId,httpStatus:response.status,contentType:response.headers.get('content-type'),bytes,sha256:createHash('sha256').update(content).digest('hex'),ffmpegDecodeExit:decoded.status,ffmpegErrorCount:(decoded.stderr||'').trim()?1:0,providerGenerationCalls:0,file};
await writeFile(`${directory}/${finalMode?'final-export':'export'}-verification.json`,JSON.stringify({...report,finalMode},null,2));console.log(JSON.stringify({...report,finalMode}));
if(decoded.status!==0)process.exitCode=1;
