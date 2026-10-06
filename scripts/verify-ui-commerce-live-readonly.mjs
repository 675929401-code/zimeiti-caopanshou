#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const origin='http://127.0.0.1:5000';
const output=path.resolve(process.argv.find(value=>value.startsWith('--output='))?.slice(9)||'.codex-evidence/ui-commerce-live-readonly-20260923/report.json');
const bundled='F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
async function devSession(){
  const response=await fetch(origin+'/api/auth/dev-session',{headers:{'x-local-workbench':'ai-creation-studio-local'},signal:AbortSignal.timeout(15_000)});
  const body=await response.json();
  assert.ok(response.ok&&body.token&&body.user?.role==='admin','本地管理员验收会话不可用');
  return body;
}

async function launch(){
  try{await fs.access(bundled);return chromium.launch({headless:true,executablePath:bundled});}
  catch{return chromium.launch({headless:true});}
}

const fixtureSessionId='00000000-0000-4000-8000-000000000023';
const sessionFixture=()=>{const now=Date.now();return {
  id:fixtureSessionId,contextId:'00000000-0000-4000-8000-000000000024',revision:1,createdAt:now,updatedAt:now,
  sourceAssetId:null,sourceSha256:null,references:[],config:{modelId:'',duration:null,aspectRatio:'9:16',resolution:'720p',generateAudio:true,extraInstruction:'',mentions:{text:'',mentions:[]}},
  history:[],favoriteJobIds:[],assets:[],sourceAsset:null,jobs:[],nextCursor:null,historyTotal:0,
};};

const session=await devSession();
await fs.mkdir(path.dirname(output),{recursive:true});
const report={at:new Date().toISOString(),origin,identity:{role:session.user.role},viewports:{},home:null,storyboard:null,commerce:null,pageErrors:[],httpErrors:[],blockedWrites:[],blockedIncidentalWrites:[],allowedSessionBridges:0,mockedEmptyWorkspaceOpens:0,paidGenerationRequests:0};
const browser=await launch();
const context=await browser.newContext({viewport:{width:1920,height:1080},serviceWorkers:'block'});
await context.addCookies([{name:'auth_token',value:session.token,url:origin,httpOnly:true,sameSite:'Lax'}]);
await context.addInitScript(({expectedOrigin,token,user})=>{if(location.origin!==expectedOrigin)return;localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));sessionStorage.setItem('entered_app','1');},{expectedOrigin:origin,token:session.token,user:session.user});
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  if(url.origin===origin&&method==='GET'&&url.pathname==='/api/commerce/depth-video-clones'&&url.searchParams.get('id')===fixtureSessionId){
    await route.fulfill({status:200,contentType:'application/json; charset=utf-8',body:JSON.stringify({session:sessionFixture()})});
    return;
  }
  if(url.origin!==origin||['GET','HEAD','OPTIONS'].includes(method)){await route.continue();return;}
  let body={};try{body=request.postDataJSON()||{};}catch{}
  if(method==='POST'&&url.pathname==='/api/commerce/session'&&body.action==='main-bind'){report.allowedSessionBridges++;await route.continue();return;}
  if(method==='POST'&&url.pathname==='/api/commerce/depth-video-clones'&&body.action==='open'){
    report.mockedEmptyWorkspaceOpens++;
    await route.fulfill({status:200,contentType:'application/json; charset=utf-8',body:JSON.stringify({session:sessionFixture()})});
    return;
  }
  if(method==='POST'&&url.pathname==='/api/announcements/events'){
    report.blockedIncidentalWrites.push({method,path:url.pathname});
    await route.abort('blockedbyclient');
    return;
  }
  if(/quote|confirm|generate|jobs|prepare/u.test(`${url.pathname} ${JSON.stringify(body)}`))report.paidGenerationRequests++;
  report.blockedWrites.push({method,path:url.pathname,action:String(body.action||'')});
  await route.abort('blockedbyclient');
});
const page=await context.newPage();
page.on('pageerror',error=>report.pageErrors.push({path:new URL(page.url()).pathname,message:String(error.message).slice(0,300)}));
page.on('response',response=>{const url=new URL(response.url());if(url.origin===origin&&response.status()>=400)report.httpErrors.push({path:url.pathname,status:response.status(),method:response.request().method()});});

async function homeAudit(width){
  await page.setViewportSize({width,height:width>=1800?1080:960});
  await page.goto(origin+'/',{waitUntil:'domcontentloaded',timeout:45_000});
  await page.locator('.marketplace-shell .nav-pill').first().waitFor({state:'visible',timeout:45_000});
  await page.locator('.marketplace-shell .category-tab').first().waitFor({state:'visible',timeout:45_000});
  await page.waitForTimeout(800);
  return page.evaluate(()=>{
    const number=value=>Number.parseFloat(String(value||'0'))||0;
    const visible=element=>{if(!element)return false;const box=element.getBoundingClientRect(),style=getComputedStyle(element);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none';};
    const measure=selector=>[...document.querySelectorAll(selector)].filter(visible).map(element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return {text:element.textContent?.trim().replace(/\s+/gu,' ').slice(0,40)||'',fontSize:number(style.fontSize),height:box.height,paddingLeft:number(style.paddingLeft),paddingRight:number(style.paddingRight)};});
    const avatars=[...document.querySelectorAll('[data-testid^="sidebar-history-avatar-"]')].map(element=>{const box=element.getBoundingClientRect(),image=element.querySelector('img'),fallback=[...element.querySelectorAll('span,svg')].some(node=>visible(node));return {width:box.width,height:box.height,imageLoaded:!!image&&image.complete&&image.naturalWidth>0,fallback};});
    const nav=document.querySelector('.nav-bar-container'),category=document.querySelector('.category-tab')?.parentElement;
    return {nav:measure('.marketplace-shell .nav-pill:not(.nav-pill-add)'),categories:measure('.marketplace-shell .category-tab'),navGap:number(nav&&getComputedStyle(nav).gap),categoryGap:number(category&&getComputedStyle(category).gap),
      history:{rows:document.querySelectorAll('.sidebar-conv-item').length,avatars,names:measure('.sidebar-conv-name'),times:measure('.sidebar-conv-time'),rowHeights:[...document.querySelectorAll('.sidebar-conv-item')].map(element=>element.getBoundingClientRect().height)},
      pageOverflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth+2};
  });
}

try{
  report.viewports['1920']=await homeAudit(1920);
  await page.screenshot({path:path.join(path.dirname(output),'home-1920.png'),fullPage:false});
  report.viewports['1440']=await homeAudit(1440);
  const home=report.viewports['1440'];report.home=home;
  assert.ok(home.nav.length>=8,'主导航未完整渲染');
  assert.ok(home.nav.every(item=>item.fontSize>=14.5&&item.fontSize<=16.5&&item.height>=40&&item.paddingLeft<=10.5&&item.paddingRight<=10.5),'主导航字号或紧凑间距未生效');
  assert.ok(home.categories.length>=5&&home.categories.every(item=>item.fontSize>=15&&item.height>=40&&item.paddingLeft<=11.5&&item.paddingRight<=11.5),'分类栏字号或紧凑间距未生效');
  assert.ok(home.navGap<=2.5&&home.categoryGap<=12,'导航项目间距过大');
  assert.equal(home.pageOverflow,false,'首页产生横向页面溢出');
  assert.ok(home.history.rows>0&&home.history.avatars.length>0,'对话历史或头像没有渲染');
  assert.ok(home.history.avatars.every(item=>item.width>=32&&item.height>=32&&(item.imageLoaded||item.fallback)),'对话历史存在空白或过小头像');
  assert.ok(home.history.times.every(item=>item.fontSize>=12),'对话历史时间仍小于12px');
  assert.ok(home.history.rowHeights.every(value=>value>=48),'对话历史行高仍过密');
  await page.screenshot({path:path.join(path.dirname(output),'home-1440.png'),fullPage:false});

  await page.goto(origin+'/storyboard-workbench',{waitUntil:'domcontentloaded',timeout:45_000});
  await page.locator('.sbw-root').waitFor({state:'visible',timeout:45_000});
  await page.locator('.sbw-model-list > button').first().waitFor({state:'visible',timeout:45_000});
  await page.waitForTimeout(800);
  report.storyboard=await page.evaluate(()=>{
    const number=value=>Number.parseFloat(String(value||'0'))||0;
    const visible=element=>{const box=element.getBoundingClientRect(),style=getComputedStyle(element);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none';};
    const buttons=[...document.querySelectorAll('.sbw-model-list > button')].filter(visible);
    const names=[...document.querySelectorAll('.sbw-model-name')].filter(visible);
    const meta=[...document.querySelectorAll('.sbw-model-inline-meta,.sbw-model-copy small,.sbw-model-price')].filter(visible);
    const rail=document.querySelector('.sbw-model-rail')?.getBoundingClientRect();
    const columns=getComputedStyle(document.querySelector('.sbw-shot-grid')).gridTemplateColumns.split(' ').length;
    const badges=[...document.querySelectorAll('[data-model-badge]')].filter(visible).map(element=>{const box=element.getBoundingClientRect();return {width:box.width,height:box.height,source:element.getAttribute('data-model-badge-source'),selected:element.getAttribute('data-selected'),availability:element.getAttribute('data-availability')};});
    return {modelCards:buttons.length,cardMinHeight:Math.min(...buttons.map(node=>node.getBoundingClientRect().height)),nameFontMin:Math.min(...names.map(node=>number(getComputedStyle(node).fontSize))),metaFontMin:Math.min(...meta.map(node=>number(getComputedStyle(node).fontSize))),railWidth:rail?.width||0,columns,badges,pageOverflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth+2};
  });
  assert.ok(report.storyboard.modelCards>0&&report.storyboard.cardMinHeight>=76,'分镜模型卡未加载或仍过密');
  assert.ok(report.storyboard.nameFontMin>=14&&report.storyboard.metaFontMin>=12,'分镜模型文字仍过小');
  assert.ok(report.storyboard.railWidth>=311&&report.storyboard.railWidth<=313,'分镜模型栏不是312px');
  assert.equal(report.storyboard.columns,3,'1440px分镜卡片不是每行3张');
  assert.equal(report.storyboard.badges.length,report.storyboard.modelCards,'分镜模型徽章数量不完整');
  assert.ok(report.storyboard.badges.every(item=>item.width>=42&&item.width<=44&&item.height>=42&&item.height<=44&&['avatar','brand','initial'].includes(item.source)&&['true','false'].includes(item.selected)&&['ready','unavailable'].includes(item.availability)),'分镜模型徽章尺寸、来源或状态不符合规范');
  assert.equal(report.storyboard.pageOverflow,false,'分镜工作台产生横向页面溢出');
  await page.screenshot({path:path.join(path.dirname(output),'storyboard-1440.png'),fullPage:false});

  await page.goto(origin+'/commerce/toolbox/video-generation',{waitUntil:'domcontentloaded',timeout:45_000});
  await page.locator('[data-testid="commerce-workspace"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('.ca-depth-entry').waitFor({state:'visible',timeout:45_000});
  const pagesBefore=context.pages().length;
  await page.locator('.ca-depth-entry').click();
  await page.waitForURL(origin+'/commerce/toolbox/depth-video-clone',{timeout:20_000});
  await page.locator('[aria-label="深度复刻工作区"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('[aria-label="上传或从素材库选择原视频"]').waitFor({state:'visible',timeout:45_000});
  await page.locator('[aria-label="深度复刻模型"]').waitFor({state:'visible',timeout:45_000});
  await page.waitForTimeout(800);
  const first=await page.evaluate(async()=>{const visible=element=>{if(!element)return false;const box=element.getBoundingClientRect(),style=getComputedStyle(element);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none';};const response=await fetch('/api/commerce/models?kind=video&operationId=depth-video-clone.generate&sourceVideos=1&referenceImages=1&generateAudioToggle=1');let modelApiBody={};try{modelApiBody=await response.json();}catch{}const apiModels=Array.isArray(modelApiBody.models)?modelApiBody.models:[],profiles=Array.isArray(modelApiBody.depthCloneProfiles)?modelApiBody.depthCloneProfiles:[];return {path:location.pathname,pages:0,sourceVisible:visible(document.querySelector('[aria-label="上传或从素材库选择原视频"]')),modelOptions:document.querySelectorAll('[aria-label="深度复刻模型"] option').length,modelCards:[...document.querySelectorAll('.ca-depth-model-list button')].map(node=>({disabled:node.disabled,label:node.getAttribute('aria-label')||'',reason:node.querySelector('small')?.textContent?.trim()||''})),durationPlan:document.querySelector('[aria-label="20、60、70秒深度复刻处理规则"]')?.textContent?.replace(/\s+/gu,' ').trim()||'',durationDisabled:document.querySelector('[aria-label="深度复刻时长"]')?.disabled,generateDisabled:[...document.querySelectorAll('button')].find(node=>/查看费用|生成深度复刻/u.test(node.textContent||''))?.disabled??true,modelApi:{status:response.status,count:apiModels.length,compatibleCount:modelApiBody.compatibleCount??null,code:modelApiBody.code||'',message:modelApiBody.message||modelApiBody.error||'',profiles:profiles.map(profile=>({id:profile.id,status:profile.status,boundModelId:profile.boundModelId,executionConnected:profile.durationPolicy?.executionConnected,examples:profile.durationPolicy?.examples})),models:apiModels.map(model=>({id:model.id,name:model.displayName,profileId:model.depthCloneProfileId,compatible:model.modeCompatible,selectable:model.selectionCompatible,ready:model.generationReady,reasons:model.modeIncompatibleReasons,source:model.capabilities?.supportsSourceVideoInput,image:model.capabilities?.supportsImageInput,audioToggle:model.capabilities?.supportsGenerateAudioToggle,execution:model.capabilities?.executionSupported}))},workspaceText:document.querySelector('[aria-label="深度复刻工作区"]')?.textContent?.replace(/\s+/gu,' ').trim().slice(0,500)||''};});
  first.pages=context.pages().length;
  report.commerce={...first};
  const replacementLabels=['添加产品/商品','添加人物/服装','添加环境/背景','添加参考声音'];
  first.replacementSlotCount=0;
  for(const label of replacementLabels)first.replacementSlotCount+=await page.locator(`[aria-label="${label}"]`).count();
  assert.equal(first.replacementSlotCount,4,'人物、商品、环境或声音替换入口不完整');
  await page.screenshot({path:path.join(path.dirname(output),'commerce-depth-top-1440.png'),fullPage:false});
  assert.equal(first.path,'/commerce/toolbox/depth-video-clone','深度复刻没有使用 Commerce 站内地址');
  assert.equal(first.pages,pagesBefore,'深度复刻错误打开了新窗口');
  assert.ok(first.sourceVisible&&first.modelOptions>=1&&first.modelCards.length===2,'上传或两种深度复刻方案没有完整渲染');
  assert.deepEqual(first.modelApi.profiles.map(item=>item.id),['benchmark-seedance-2-5','value-minimax-h3-ref2va'],'深度复刻 API 未固定为 Seedance 2.5 与 MiniMax H3 Ref2VA 两种方案');
  assert.ok(first.modelApi.profiles.every(item=>item.executionConnected===false),'分段编排尚未接通时不得标记为可执行');
  assert.ok(first.modelApi.models.every(item=>item.selectable===false||['benchmark-seedance-2-5','value-minimax-h3-ref2va'].includes(item.profileId)),'Omni、Wan 或普通 H3 混入了深度复刻可选模型');
  assert.match(first.durationPlan,/20 秒/u,'20 秒边界没有展示');
  assert.match(first.durationPlan,/60 秒/u,'60 秒边界没有展示');
  assert.match(first.durationPlan,/70 秒/u,'70 秒边界没有展示');
  const selectableModels=page.locator('.ca-depth-model-list button:not(:disabled)');
  first.selectableModelCount=await selectableModels.count();
  if(first.selectableModelCount>0){await selectableModels.first().click();first.selectedModelId=await page.locator('[aria-label="深度复刻模型"]').inputValue();assert.ok(first.selectedModelId,'选择模型后没有写入当前工作区配置');}
  else{first.selectedModelId='';assert.ok(first.modelCards.every(item=>item.disabled&&item.reason.length>0),'当前无验收模型时必须显示禁用原因');}
  assert.ok(first.modelCards.filter(item=>item.disabled).every(item=>item.reason.length>0),'不兼容模型缺少可见原因');
  assert.equal(first.durationDisabled,true,'未上传原片时长选择不应开放');
  assert.equal(first.generateDisabled,true,'缺少原片和替换素材时不应开放生成');
  await page.locator('[aria-label="上传或从素材库选择原视频"]').click();
  await page.locator('[role="dialog"][aria-label="选择或上传素材"]').waitFor({state:'visible',timeout:20_000});
  const accept=await page.locator('[role="dialog"][aria-label="选择或上传素材"] input[type="file"]').getAttribute('accept');
  assert.equal(accept,'video/mp4,video/webm,video/quicktime','原视频上传控件格式不正确');
  await page.locator('[aria-label="关闭素材选择"]').click();
  await page.reload({waitUntil:'domcontentloaded',timeout:45_000});
  await page.locator('[aria-label="深度复刻工作区"]').waitFor({state:'visible',timeout:45_000});
  report.commerce={...first,reloadPath:new URL(page.url()).pathname,uploadAccept:accept,helpHref:await page.locator('.ca-admin-entry').getAttribute('href')};
  assert.equal(report.commerce.reloadPath,'/commerce/toolbox/depth-video-clone','刷新后没有保持深度复刻页面');
  assert.equal(report.commerce.helpHref,'/commerce/help','带货 Agent 帮助仍指向站外根路径');
  await page.screenshot({path:path.join(path.dirname(output),'commerce-depth-1440.png'),fullPage:false});

  assert.equal(report.paidGenerationRequests,0,'验收期间出现付费生成请求');
  assert.equal(report.blockedWrites.length,0,'页面在只读验收期间尝试了未授权写入');
  assert.equal(report.pageErrors.length,0,'页面存在运行时错误');
  report.passed=true;
}catch(error){report.passed=false;report.failure=String(error?.stack||error);throw error;}
finally{await fs.writeFile(output,JSON.stringify(report,null,2));await browser.close();}

console.log(JSON.stringify({passed:report.passed,home:{navFont:Math.min(...(report.home?.nav||[]).map(item=>item.fontSize)),categoryFont:Math.min(...(report.home?.categories||[]).map(item=>item.fontSize)),historyAvatars:report.home?.history?.avatars?.length||0},storyboard:report.storyboard,commerce:report.commerce&&{path:report.commerce.path,pages:report.commerce.pages,sourceVisible:report.commerce.sourceVisible,replacementSlotCount:report.commerce.replacementSlotCount,modelOptions:report.commerce.modelOptions,selectableModelCount:report.commerce.selectableModelCount,selectedModelId:report.commerce.selectedModelId,modelApiStatus:report.commerce.modelApi?.status,modelApiCount:report.commerce.modelApi?.count,reloadPath:report.commerce.reloadPath,uploadAccept:report.commerce.uploadAccept,helpHref:report.commerce.helpHref,generateDisabled:report.commerce.generateDisabled},paidGenerationRequests:report.paidGenerationRequests,blockedWrites:report.blockedWrites.length,evidence:output},null,2));
