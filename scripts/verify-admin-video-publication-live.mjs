import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const origin = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
assert.ok(['http://127.0.0.1:5000','http://127.0.0.1:5002'].includes(origin));
const config = JSON.parse(await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json','utf8'));
assert.ok(config.localOnly && config.ownerConnection.host === '127.0.0.1' && config.ownerConnection.port === 54322);
const token = process.env.LOCAL_NAV_ADMIN_TOKEN; assert.ok(token);
const headers = { Authorization:'Bearer '+token,'Content-Type':'application/json' };
const api = async (path,options={}) => {const response=await fetch(origin+path,{...options,headers,signal:AbortSignal.timeout(60000)});return {status:response.status,body:await response.json()};};
const actor=await api('/api/auth/me'); assert.equal(actor.body.user.role,'admin');
const modelId='minimax-h3-autodl-hosted-first-last';
const dispatch=JSON.parse(await fs.readFile('.codex-evidence/hidden-video-real-e2e-20260902/hidden-bindings-canary-v2-20260902/'+modelId+'/dispatch.json','utf8'));
const query=new URLSearchParams({modelId,validationKey:dispatch.clientRequestId,configurationHash:dispatch.configurationHash,healthEpoch:dispatch.healthEpoch});
const restored=await api('/api/admin/video-models/validation?'+query); assert.equal(restored.status,200); assert.equal(restored.body.existingTask.status,'completed');
const dto=restored.body;
const attempt={version:1,userId:actor.body.user.id,proof:{validationKey:dispatch.clientRequestId,configurationHash:dispatch.configurationHash,healthEpoch:dispatch.healthEpoch,confirmation:dto.confirmation,model:{id:modelId,publicId:dto.model.publicId,displayName:dto.model.displayName,upstreamModel:dto.model.upstreamModel}},createdAt:dispatch.at,status:'unknown',taskId:'',businessTaskId:'',error:'',errorCode:''};
const directory='.codex-evidence/admin-video-publication-live-20260903'; await fs.mkdir(directory,{recursive:true});
const report={at:new Date().toISOString(),origin,modelId,taskId:dto.existingTask.businessTaskId,newGenerationRequests:0,uiPublishRequests:0};
if (process.argv.includes('--resume-original-publication')) {
  const previous=JSON.parse(await fs.readFile(directory+'/dispatch.json','utf8'));
  assert.equal(previous.modelId,modelId);assert.equal(previous.taskId,report.taskId);
  report.resumedOriginalPublication=true;
} else await fs.writeFile(directory+'/dispatch.json',JSON.stringify({modelId,taskId:report.taskId,at:report.at}),{flag:'wx'});
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:1500,height:1000}});
  await context.addInitScript(({origin,token,user,attempt})=>{if(location.origin===origin){localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));localStorage.setItem(`admin-video-validation:v1:${user.id}:${attempt.proof.model.id}`,JSON.stringify(attempt));}},{origin,token,user:actor.body.user,attempt});
  await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(!['GET','HEAD'].includes(request.method())){if(url.origin===origin&&url.pathname==='/api/admin/video-models/validation/publish'&&report.uiPublishRequests===0){report.uiPublishRequests++;return route.continue();}return route.abort();}return route.continue();});
  const page=await context.newPage(); await page.goto(origin+'/admin?tab=models',{waitUntil:'load'});
  const card=page.locator(`[data-model-id="${modelId}"]`);await card.getByRole('button',{name:'真实生成验证',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'视频模型真实验证'});await dialog.getByText('验证生成已完成',{exact:true}).waitFor({timeout:30000});
  const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/video-models/validation/publish'&&response.request().method()==='POST');
  await dialog.getByRole('button',{name:'启用此配置',exact:true}).click();const response=await responsePromise;const published=await response.json();
  report.publication={http:response.status(),success:published.success,modelId:published.modelId,taskId:published.taskId,code:published.code};
  assert.equal(response.status(),200);assert.equal(published.success,true);assert.equal(published.taskId,report.taskId);
  await page.waitForFunction(({userId,modelId})=>JSON.parse(localStorage.getItem(`admin-video-validation:v1:${userId}:${modelId}`)||'null')?.status==='published',{userId:actor.body.user.id,modelId});
  report.uiPublishedState=true;
  const visible=await api('/api/video/models?surface=video-page');assert.ok(visible.body.models.some(m=>m.id===dto.model.publicId));report.publicCatalogVisible=true;
  const replay=await api('/api/admin/video-models/validation/publish',{method:'POST',body:JSON.stringify({modelId,validationKey:dispatch.clientRequestId,configurationHash:dispatch.configurationHash,healthEpoch:dispatch.healthEpoch,clientRequestId:dispatch.clientRequestId,taskId:report.taskId,confirmation:'PUBLISH_VALIDATED_VIDEO_MODEL'})});
  report.replay={http:replay.status,success:replay.body.success,alreadyPublished:replay.body.alreadyPublished,taskId:replay.body.taskId,code:replay.body.code};
  assert.equal(replay.status,200);assert.equal(replay.body.alreadyPublished,true);assert.equal(replay.body.taskId,report.taskId);
  report.passed=true;await page.screenshot({path:directory+'/published-ui.png'});
} catch(error){report.passed=false;report.error=String(error.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,600);}
finally{await browser.close();await fs.writeFile(directory+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
