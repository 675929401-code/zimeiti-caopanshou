import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const origin=String(process.env.LOCAL_NAV_ORIGIN||'http://127.0.0.1:5000').replace(/\/$/u,'');
const out=path.resolve('.codex-evidence/benchmark-action-loop-20260928/live-ui');
await fs.mkdir(out,{recursive:true});

const report={
 checkedAt:new Date().toISOString(),
 origin,
 viewport:{width:1440,height:900},
 pageErrors:[],
 consoleErrors:[],
 serverErrors:[],
 paidRequests:[],
 checks:{},
};

let browser;
try{
 const sessionResponse=await fetch(`${origin}/api/auth/dev-session`,{
  headers:{'x-local-workbench':'ai-creation-studio-local'},
  signal:AbortSignal.timeout(20_000),
 });
 const session=await sessionResponse.json().catch(()=>({}));
 const token=sessionResponse.ok?String(session.token||'').trim():'';
 report.sessionMode=token?'local-admin':'public-readonly';

 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:report.viewport});
 await context.addInitScript(value=>{
  if(value)localStorage.setItem('auth_token',value);
  localStorage.setItem('active_view','marketplace');
  sessionStorage.setItem('entered_app','1');
 },token);
 if(token)await context.addCookies([{name:'auth_token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();
 page.on('pageerror',error=>report.pageErrors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
 page.on('response',response=>{if(response.status()>=500)report.serverErrors.push({status:response.status(),url:response.url()});});
 page.on('request',request=>{
  if(/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u.test(request.url()))report.paidRequests.push(request.url());
 });

 const navigation=await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60_000});
 assert.equal(navigation?.status(),200,'主页未返回200');
 await page.locator('.marketplace-category-bar').waitFor({state:'visible',timeout:30_000});
 const announcementClose=page.getByRole('button',{name:'关闭',exact:true});
 if(await announcementClose.count()&&await announcementClose.last().isVisible())await announcementClose.last().click();
 await page.locator('.marketplace-category-bar').getByRole('button',{name:'商业IP',exact:true}).click();

 const expectedOrder=['商业IP定位','账号主页包装','对标账号拆解','内容选题策划','短视频文案成稿','咨询回复与跟进','运营数据复盘'];
 const cardOrder=await page.locator('[aria-label^="打开智能体："]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')?.replace('打开智能体：','')));
 assert.deepEqual(cardOrder,expectedOrder,'商业IP卡片顺序异常');

 const benchmarkCard=page.getByLabel('打开智能体：对标账号拆解');
 await benchmarkCard.waitFor({state:'visible',timeout:30_000});
 assert.match(await benchmarkCard.innerText(),/真正有价值、适合你学习的方法/u,'卡片简介未更新');
 await benchmarkCard.click();
 const dialog=page.getByTestId('business-ip-intake');
 await dialog.waitFor({state:'visible',timeout:30_000});
 await dialog.getByText('对标账号拆解 · 看懂价值，学会变成自己的方法',{exact:true}).waitFor();
 const benchmarkText=await dialog.innerText();
 for(const expected of [
  '智能判断','选题文案','拍摄表达','商业承接',
  '快速10条','标准20条','深度30条',
  '你的账号/业务，以及现在最迷茫的地方','你能做到的方式和限制',
  '最值得学的一件事','3个原创练习题','72小时行动清单','7—14天验证计划',
 ])assert.ok(benchmarkText.includes(expected),`目标接收卡缺少：${expected}`);
 assert.match(await dialog.getByLabel('本环节主要资料').getAttribute('placeholder'),/字幕与截图/u);
 assert.match(await dialog.getByLabel('本环节主要资料').getAttribute('placeholder'),/我有点迷茫/u);

 const dialogMetrics=await dialog.evaluate(element=>{
  const rect=element.getBoundingClientRect();
  const style=getComputedStyle(element);
  return {
   rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height},
   clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,
   color:style.color,backgroundColor:style.backgroundColor,fontSize:style.fontSize,lineHeight:style.lineHeight,
  };
 });
 assert.ok(dialogMetrics.rect.left>=0&&dialogMetrics.rect.right<=report.viewport.width,'目标弹窗横向越界');
 assert.ok(dialogMetrics.rect.top>=0&&dialogMetrics.rect.bottom<=report.viewport.height,'目标弹窗纵向越界');
 assert.ok(dialogMetrics.scrollWidth<=dialogMetrics.clientWidth,'目标弹窗存在横向溢出');

 await dialog.getByRole('button',{name:'智能判断',exact:true}).click();
 await dialog.getByRole('button',{name:'标准20条',exact:true}).click();
 await dialog.getByLabel('本环节主要资料').fill('https://v.douyin.com/example/');
 await dialog.getByLabel('你的账号/业务，以及现在最迷茫的地方').fill('宠物知识账号，不知道应该先学选题还是表达');
 await dialog.getByLabel('你能做到的方式和限制').fill('每周能做3条，有真实养狗素材，不方便真人出镜');
 assert.equal(await dialog.getByRole('button',{name:'智能判断',exact:true}).getAttribute('aria-pressed'),'true','智能判断未进入选中态');
 assert.equal(await dialog.getByRole('button',{name:'标准20条',exact:true}).getAttribute('aria-pressed'),'true','标准20条未进入选中态');
 assert.equal(await dialog.getByRole('button',{name:'发给智能体',exact:true}).isEnabled(),true,'完整示例填写后发送按钮未启用');
 await page.screenshot({path:path.join(out,'benchmark-intake-1440x900.png'),fullPage:false});

 await page.keyboard.press('Escape');
 await dialog.waitFor({state:'hidden'});
 const adjacent=[];
 for(const check of [
  {name:'账号主页包装',title:'账号主页包装 · 把定位变成主页',expected:'生成整套包装'},
  {name:'内容选题策划',title:'内容选题策划 · 只决定拍什么、先拍什么',expected:'从头规划'},
 ]){
  await page.getByLabel(`打开智能体：${check.name}`).click();
  const adjacentDialog=page.getByTestId('business-ip-intake');
  await adjacentDialog.waitFor({state:'visible'});
  await adjacentDialog.getByText(check.title,{exact:true}).waitFor();
  assert.equal(await adjacentDialog.getByRole('button',{name:check.expected,exact:true}).count(),1,`${check.name}主要动作缺失`);
  const metrics=await adjacentDialog.evaluate(element=>{
   const rect=element.getBoundingClientRect();
   return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth};
  });
  assert.ok(metrics.left>=0&&metrics.right<=report.viewport.width,`${check.name}横向越界`);
  assert.ok(metrics.top>=0&&metrics.bottom<=report.viewport.height,`${check.name}纵向越界`);
  assert.ok(metrics.scrollWidth<=metrics.clientWidth,`${check.name}存在横向溢出`);
  adjacent.push({name:check.name,metrics});
  await page.screenshot({path:path.join(out,`${check.name==='账号主页包装'?'packaging':'topics'}-adjacent-1440x900.png`),fullPage:false});
  await page.keyboard.press('Escape');
  await adjacentDialog.waitFor({state:'hidden'});
 }

 const version=await page.evaluate(()=>fetch('/api/version',{cache:'no-store'}).then(response=>response.json()));
 const diskBuildId=(await fs.readFile('.next/BUILD_ID','utf8')).trim();
 assert.equal(version.buildId,diskBuildId,'浏览器构建与磁盘构建不一致');
 assert.deepEqual(report.paidRequests,[],'只读验收触发了付费请求');
 assert.deepEqual(report.pageErrors,[],'页面出现运行错误');
 assert.deepEqual(report.consoleErrors,[],'页面出现控制台错误');
 assert.deepEqual(report.serverErrors,[],'页面请求出现服务端错误');
 report.checks={
  runningLatestBuildId:version.buildId,
  sourceVersion:version.sourceVersion,
  cardOrder:true,
  benchmarkCopy:true,
  smartChoice:true,
  depthChoice:true,
  userContextFields:true,
  actionPromise:true,
  desktopBounds:true,
  horizontalOverflow:false,
  adjacentPages:adjacent,
  noPaidRequests:true,
 };
 report.targetDialog=dialogMetrics;
 report.passed=true;
}catch(error){
 report.passed=false;
 report.failure=error instanceof Error?error.message:String(error);
 throw error;
}finally{
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 if(browser)await browser.close();
 console.log(JSON.stringify(report));
}
