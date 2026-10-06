#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const origin=String(process.env.LOCAL_NAV_ORIGIN||'http://127.0.0.1:5000').replace(/\/$/u,'');
const token=String(process.env.LOCAL_NAV_ADMIN_TOKEN||'');
const output=path.resolve(process.argv.find(value=>value.startsWith('--output='))?.slice(9)||'.codex-evidence/commerce-depth-parity-20260924/live-report.json');
const bundled='F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const fixtureSessionId='00000000-0000-4000-8000-000000000091';

assert.ok(token,'LOCAL_NAV_ADMIN_TOKEN is required; use scripts/with-local-admin-session.mjs');

async function jsonGet(route){
  const response=await fetch(origin+route,{headers:{Authorization:`Bearer ${token}`,Cookie:`auth_token=${token}`},signal:AbortSignal.timeout(20_000)});
  let body={};try{body=await response.json();}catch{}
  assert.ok(response.ok,`${route} returned ${response.status}: ${body.error||body.code||'invalid response'}`);
  return body;
}

async function launch(){
  try{await fs.access(bundled);return chromium.launch({headless:true,executablePath:bundled});}
  catch{return chromium.launch({headless:true});}
}

function fixtureSession(){const now=Date.now();return {
  id:fixtureSessionId,contextId:'00000000-0000-4000-8000-000000000092',revision:1,createdAt:now,updatedAt:now,
  sourceAssetId:null,sourceSha256:null,references:[],config:{modelId:'',duration:null,aspectRatio:'9:16',resolution:'720p',generateAudio:true,extraInstruction:'',mentions:{text:'',mentions:[]}},
  history:[],favoriteJobIds:[],assets:[],sourceAsset:null,jobs:[],nextCursor:null,historyTotal:0,
};}

const admin=await jsonGet('/api/admin/commerce');
const currentReleaseId=String(admin.current?.releaseId||admin.current?.id||'');
const currentRelease=(admin.releases||[]).find(item=>String(item.id)===currentReleaseId||item.is_current===true);
const manifest=currentRelease?.manifest||{};
const routeIds=new Set(Array.isArray(manifest.operationRouteIds)?manifest.operationRouteIds.map(String):[]);
const currentRoutes=(admin.routes||[]).filter(route=>routeIds.has(String(route.id)));
const depthRoute=currentRoutes.find(route=>String(route.operation_id||route.operationId)==='depth-video-clone.generate');
let modelCatalog={};
let profiles=[];
let models=[];
let readyModels=[];
let readyProfileIds=new Set();

const report={
  schema:'commerce-depth-clone-live/v1',at:new Date().toISOString(),origin,
  configuration:{releaseId:currentReleaseId||null,routeId:depthRoute?.id||null,primaryModelId:depthRoute?.primary_model_id||depthRoute?.primaryModelId||null,fallbackModelIds:depthRoute?.fallback_model_ids||depthRoute?.fallbackModelIds||[]},
  catalog:null,
  desktop:null,mobile:null,pageErrors:[],httpErrors:[],businessWrites:[],allowedSessionBridges:0,mockedWorkspaceOpens:0,paidGenerationRequests:0,passed:false,
};

const browser=await launch();
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
await context.addCookies([{name:'auth_token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
await context.addInitScript(({expectedOrigin,authToken,sessionId})=>{
  if(location.origin!==expectedOrigin)return;
  localStorage.setItem('auth_token',authToken);
  localStorage.setItem('ca-depth-owner:readonly-fixture:session',sessionId);
  sessionStorage.setItem('entered_app','1');
},{expectedOrigin:origin,authToken:token,sessionId:fixtureSessionId});
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  if(url.origin===origin&&method==='GET'&&url.pathname==='/api/commerce/depth-video-clones'&&url.searchParams.get('id')===fixtureSessionId){
    await route.fulfill({status:200,contentType:'application/json; charset=utf-8',body:JSON.stringify({session:fixtureSession()})});return;
  }
  if(url.origin!==origin||['GET','HEAD','OPTIONS'].includes(method)){await route.continue();return;}
  let body={};try{body=request.postDataJSON()||{};}catch{}
  if(method==='POST'&&url.pathname==='/api/commerce/session'&&body.action==='main-bind'){
    report.allowedSessionBridges++;await route.continue();return;
  }
  if(method==='POST'&&url.pathname==='/api/commerce/depth-video-clones'&&body.action==='open'){
    report.mockedWorkspaceOpens++;await route.fulfill({status:200,contentType:'application/json; charset=utf-8',body:JSON.stringify({session:fixtureSession()})});return;
  }
  if(method==='POST'&&url.pathname==='/api/announcements/events'){await route.abort('blockedbyclient');return;}
  if(/quote|confirm|generate|prepare|jobs/u.test(`${url.pathname} ${JSON.stringify(body)}`))report.paidGenerationRequests++;
  report.businessWrites.push({method,path:url.pathname,action:String(body.action||'')});
  await route.abort('blockedbyclient');
});
const page=await context.newPage();
page.on('pageerror',error=>report.pageErrors.push(String(error.message).slice(0,300)));
page.on('response',response=>{const url=new URL(response.url());if(url.origin===origin&&response.status()>=400)report.httpErrors.push({path:url.pathname,status:response.status(),method:response.request().method()});});

try{
  await page.goto(origin+'/commerce/toolbox/video-generation',{waitUntil:'domcontentloaded',timeout:45_000});
  await page.locator('[data-testid="commerce-workspace"][data-tab="video"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('button.ca-depth-entry[aria-label="上传原视频并替换人物、服装、商品或环境"]').waitFor({state:'visible',timeout:45_000});
  const pagesBefore=context.pages().length;
  await page.locator('button.ca-depth-entry[aria-label="上传原视频并替换人物、服装、商品或环境"]').click();
  await page.waitForURL(origin+'/commerce/toolbox/depth-video-clone',{timeout:20_000});
  await page.locator('[aria-label="深度复刻工作区"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('[aria-label="上传或从素材库选择原视频"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('[aria-label="深度复刻模型"]').waitFor({state:'visible',timeout:45_000});
  await page.waitForTimeout(700);
  modelCatalog=await page.evaluate(async()=>{
    const response=await fetch('/api/commerce/models?kind=video&operationId=depth-video-clone.generate&sourceVideos=1&referenceImages=1&referenceAudios=1&generateAudioToggle=1');
    const body=await response.json();
    if(!response.ok)throw new Error(`MODEL_CATALOG_${response.status}:${body.error||body.code||''}`);
    return body;
  });
  profiles=Array.isArray(modelCatalog.depthCloneProfiles)?modelCatalog.depthCloneProfiles:[];
  models=Array.isArray(modelCatalog.models)?modelCatalog.models:[];
  readyModels=models.filter(model=>model.depthCloneProfileId&&model.selectionCompatible!==false&&model.modeCompatible!==false&&model.generationReady===true);
  readyProfileIds=new Set(readyModels.map(model=>String(model.depthCloneProfileId)));
  report.catalog={count:models.length,compatibleCount:Number(modelCatalog.compatibleCount||0),generationReadyCount:Number(modelCatalog.generationReadyCount||0),defaultCompatibleModelId:String(modelCatalog.defaultCompatibleModelId||''),readyModelIds:readyModels.map(model=>model.id),profiles:profiles.map(profile=>({id:profile.id,status:profile.status,boundModelId:profile.boundModelId}))};
  await page.locator('.ca-depth-capability-details > summary').click();
  report.desktop=await page.evaluate(()=>{
    const select=document.querySelector('[aria-label="深度复刻模型"]');
    const submit=document.querySelector('.ca-depth-editor footer button.primary');
    const visible=node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return box.width>0&&box.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
    const cards=[...document.querySelectorAll('.ca-depth-model-list > button')].filter(visible);
    return {path:location.pathname,selectedModelId:String(select?.value||''),modelSelectDisabled:Boolean(select?.disabled),modelOptions:select?.querySelectorAll('option').length||0,selectableCards:cards.filter(card=>!card.disabled).length,modelCards:cards.length,submitDisabled:Boolean(submit?.disabled),submitText:submit?.textContent?.replace(/\s+/gu,' ').trim()||'',pageOverflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth+2};
  });
  report.desktop.pageCount=context.pages().length;
  await page.screenshot({path:path.join(path.dirname(output),'depth-desktop.png'),fullPage:false});
  await page.locator('[aria-label="上传或从素材库选择原视频"]').click();
  const dialog=page.locator('[role="dialog"][aria-label="选择或上传素材"]');
  await dialog.waitFor({state:'visible',timeout:20_000});
  report.desktop.uploadAccept=await dialog.locator('input[type="file"]').getAttribute('accept');
  await page.locator('[aria-label="关闭素材选择"]').click();

  await page.setViewportSize({width:390,height:844});
  await page.goto(origin+'/commerce/toolbox/video-generation',{waitUntil:'domcontentloaded',timeout:45_000});
  await page.locator('[data-testid="commerce-workspace"][data-tab="video"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('button.ca-depth-entry[aria-label="上传原视频并替换人物、服装、商品或环境"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('button.ca-depth-entry[aria-label="上传原视频并替换人物、服装、商品或环境"]').click();
  await page.waitForURL(origin+'/commerce/toolbox/depth-video-clone',{timeout:20_000});
  await page.locator('[aria-label="深度复刻工作区"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('[aria-label="深度复刻模型"]').waitFor({state:'visible',timeout:45_000});
  await page.waitForTimeout(700);
  report.mobile=await page.evaluate(()=>{
    const n=value=>Number.parseFloat(String(value||'0'))||0;
    const visible=node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return box.width>0&&box.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
    const fonts=selector=>[...document.querySelectorAll(selector)].filter(visible).map(node=>n(getComputedStyle(node).fontSize));
    const railFonts=fonts('.ca-rail nav button'),labelFonts=fonts('.ca-depth-slots label,.ca-depth-settings label'),bodyFonts=fonts('.ca-depth-guidance span,.ca-depth-meta,.ca-depth-editor footer button');
    const panels=[...document.querySelectorAll('.ca-depth-studio,.ca-depth-editor,.ca-depth-preview')].filter(visible).map(node=>{const box=node.getBoundingClientRect();return {className:node.className,left:Math.round(box.left),right:Math.round(box.right),width:Math.round(box.width),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,overflows:node.scrollWidth>node.clientWidth+2||box.left<-2||box.right>innerWidth+2};});
    const select=document.querySelector('[aria-label="深度复刻模型"]');
    return {path:location.pathname,selectedModelId:String(select?.value||''),modelSelectDisabled:Boolean(select?.disabled),railMinFont:railFonts.length?Math.min(...railFonts):0,labelMinFont:labelFonts.length?Math.min(...labelFonts):0,bodyMinFont:bodyFonts.length?Math.min(...bodyFonts):0,panels,pageOverflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth+2};
  });
  await page.screenshot({path:path.join(path.dirname(output),'depth-mobile-390.png'),fullPage:false});

  assert.ok(currentReleaseId,'当前带货配置发布不存在');
  assert.ok(depthRoute,'当前发布未包含 depth-video-clone.generate 路由');
  assert.deepEqual(profiles.map(profile=>profile.id),['benchmark-seedance-2-5','value-minimax-h3-ref2va'],'深度复刻方案不是固定的 Seedance 2.5 + MiniMax H3 Ref2VA');
  assert.ok(readyModels.length>=1&&Number(modelCatalog.compatibleCount)>=1,'深度复刻没有已验收且可选的源视频模型');
  assert.ok(profiles.some(profile=>profile.status==='ready'&&profile.boundModelId&&readyProfileIds.has(String(profile.id))),'深度复刻方案未绑定到真实可生成模型');
  assert.equal(report.desktop.path,'/commerce/toolbox/depth-video-clone','复刻入口没有在站内进入独立工作流');
  assert.equal(report.desktop.pageCount,pagesBefore,'复刻入口错误打开了新窗口');
  assert.equal(report.desktop.modelSelectDisabled,false,'深度复刻模型选择仍被禁用');
  assert.ok(report.desktop.modelOptions>=2&&report.desktop.selectableCards>=1,'页面没有可选执行模型');
  assert.ok(report.catalog.readyModelIds.includes(report.desktop.selectedModelId),'桌面页当前选择不是已验收且可生成的深度复刻模型');
  assert.equal(report.desktop.selectedModelId,report.catalog.defaultCompatibleModelId,'桌面页没有采用后台返回的默认兼容模型');
  assert.equal(report.desktop.submitDisabled,true,'未上传原片时提交按钮必须禁用');
  assert.match(report.desktop.submitText,/立即生成视频/u,'未找到当前深度复刻提交按钮');
  assert.equal(report.desktop.uploadAccept,'video/mp4,video/webm,video/quicktime','原视频上传格式不正确');
  assert.equal(report.desktop.pageOverflow,false,'深度复刻桌面页横向溢出');
  assert.equal(report.mobile.path,'/commerce/toolbox/depth-video-clone','390px 没有进入深度复刻工作流');
  assert.equal(report.mobile.modelSelectDisabled,false,'390px 深度复刻模型选择仍被禁用');
  assert.ok(report.catalog.readyModelIds.includes(report.mobile.selectedModelId),'390px 当前选择不是已验收且可生成的深度复刻模型');
  assert.ok(report.mobile.railMinFont>=11,'390px 带货导航字号仍小于 11px');
  assert.ok(report.mobile.labelMinFont>=12,'390px 深度复刻字段字号仍小于 12px');
  assert.ok(report.mobile.bodyMinFont>=12,'390px 深度复刻说明或按钮字号仍小于 12px');
  assert.equal(report.mobile.panels.some(panel=>panel.overflows),false,'390px 深度复刻内部面板溢出');
  assert.equal(report.mobile.pageOverflow,false,'390px 深度复刻页横向溢出');
  assert.ok(report.allowedSessionBridges<=1,'只读验收期间出现重复鉴权桥写入');
  assert.equal(report.paidGenerationRequests,0,'只读验收期间出现付费生成请求');
  assert.deepEqual(report.businessWrites,[],'只读验收期间页面尝试了业务写入');
  assert.deepEqual(report.pageErrors,[],'浏览器页面运行错误');
  assert.deepEqual(report.httpErrors,[],'浏览器接口错误');
  report.passed=true;
}catch(error){report.failure=String(error?.stack||error);throw error;}
finally{await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));await browser.close();}

console.log(JSON.stringify({passed:report.passed,configuration:report.configuration,catalog:report.catalog,desktop:report.desktop,mobile:report.mobile,paidGenerationRequests:report.paidGenerationRequests,businessWrites:report.businessWrites.length,evidence:output},null,2));
