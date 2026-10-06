import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin=process.env.LOCAL_NAV_ORIGIN||'http://127.0.0.1:5002';
assert.ok(['http://127.0.0.1:5000','http://127.0.0.1:5002'].includes(origin),'LOCAL_PREVIEW_REQUIRED');
const adminToken=process.env.LOCAL_NAV_ADMIN_TOKEN,secondToken=process.env.LOCAL_NAV_SECOND_TOKEN;
assert.ok(adminToken&&secondToken,'NORMAL_ADMIN_AND_SECOND_USER_SESSIONS_REQUIRED');
const runId=process.argv.find(value=>value.startsWith('--run-id='))?.slice(9);
assert.match(runId||'',/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u,'FRESH_RUN_ID_REQUIRED');
const directory=`.codex-evidence/general-script-user-scope-20260903/${runId}`;
await mkdir(directory,{recursive:true});
const reportPath=`${directory}/report.json`;
const report={at:new Date().toISOString(),origin,normalAdmin:false,normalSecondUser:false,isolatedBrowserContext:true,serverProjectWrites:0,generationRequests:0,blockedMutations:[],externalRequestsBlocked:0,pageErrors:[],apiErrors:[],cases:[],passed:false};
await writeFile(reportPath,JSON.stringify(report),{flag:'wx'});
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2));
let browser;
const safeError=error=>({name:String(error?.name||'Error').slice(0,60),message:String(error?.message||error).split(adminToken).join('[redacted]').split(secondToken).join('[redacted]').replace(/https?:\/\/\S+/gu,'[url]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,'[redacted]').slice(0,350)});
async function getUser(token){const response=await fetch(`${origin}/api/auth/me`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});const data=await response.json();assert.ok(response.ok&&typeof data.user?.id==='string','NORMAL_SESSION_REQUIRED');return data.user;}
try{
  const [admin,other]=await Promise.all([getUser(adminToken),getUser(secondToken)]);
  assert.equal(admin.role,'admin','ADMIN_SESSION_REQUIRED');assert.notEqual(other.role,'admin','ORDINARY_SECOND_USER_REQUIRED');assert.notEqual(admin.id,other.id,'DISTINCT_ACCOUNTS_REQUIRED');
  report.normalAdmin=true;report.normalSecondUser=true;
  browser=await chromium.launch({headless:true});
  for(const pageCase of [
    {path:'/tools/text/general-script',base:'general_script_official_draft_v1',selector:'#general-script-requirements'},
    {path:'/youcai/tools/text/general-script',base:'youcai_general_script_draft_v1',selector:'#youcai-general-script-requirements'},
    {path:'/youcai/tools/film-studio/create/general-script',base:'youcai_general_script_draft_v1',selector:'#youcai-general-script-requirements'},
  ]){
    const result={path:pageCase.path,checks:[],passed:false};report.cases.push(result);
    const context=await browser.newContext();const page=await context.newPage();
    page.setDefaultTimeout(20000);page.on('pageerror',error=>report.pageErrors.push({path:pageCase.path,name:error.name,message:safeError(error).message}));
    page.on('response',response=>{const url=new URL(response.url());if(url.origin===origin&&url.pathname.startsWith('/api/')&&response.status()>=400)report.apiErrors.push({path:url.pathname,status:response.status()});});
    await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin){report.externalRequestsBlocked++;return route.abort();}if(!['GET','HEAD'].includes(request.method())){if(/generate|\/short-drama\/script/u.test(url.pathname))report.generationRequests++;report.blockedMutations.push({method:request.method(),path:url.pathname});return route.abort();}return route.continue();});
    const aKey=`${pageCase.base}:user:${encodeURIComponent(admin.id)}`,bKey=`${pageCase.base}:user:${encodeURIComponent(other.id)}`;
    const pendingKey=`${pageCase.base}:pending-request:user:${encodeURIComponent(admin.id)}`;
    const unknown=JSON.stringify({requestId:`${runId}-unsubmitted-fixture`,fingerprint:'synthetic browser record, never submitted'});
    const legacy=JSON.stringify({schemaVersion:1,requirements:`${runId}_OWNERLESS_PRIVATE`,sourceMaterial:`${runId}_OWNERLESS_SOURCE`,episodesToGenerate:1});
    await context.addInitScript(({token,user,aKey,bKey,base,pendingKey,unknown,legacy,runId})=>{if(localStorage.getItem('general-script-scope-fixture-initialized'))return;localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));localStorage.setItem(aKey,JSON.stringify({schemaVersion:1,requirements:`${runId}_A_PRIVATE`,sourceMaterial:`${runId}_A_SOURCE`,episodesToGenerate:1}));localStorage.setItem(bKey,JSON.stringify({schemaVersion:1,requirements:`${runId}_B_PRIVATE`,sourceMaterial:`${runId}_B_SOURCE`,episodesToGenerate:1}));localStorage.setItem(base,legacy);localStorage.setItem(pendingKey,unknown);localStorage.setItem('general-script-scope-fixture-initialized','true');},{token:adminToken,user:admin,aKey,bKey,base:pageCase.base,pendingKey,unknown,legacy,runId});
    async function load(){const response=await page.goto(`${origin}${pageCase.path}`,{waitUntil:'load',timeout:45000});assert.equal(response?.status(),200,'PAGE_MUST_RETURN_200');await page.getByRole('button',{name:'下一步：输入内容',exact:true}).click();await page.locator(pageCase.selector).waitFor();}
    async function waitValue(expected){await page.waitForFunction(({selector,expected})=>document.querySelector(selector)?.value===expected,{selector:pageCase.selector,expected});}
    async function changeActor(token,user){await page.evaluate(({token,user})=>{if(token){localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));}else{localStorage.removeItem('auth_token');localStorage.removeItem('auth_user');}},{token,user});}
    await load();await waitValue(`${runId}_A_PRIVATE`);
    assert.ok(!(await page.locator('input,textarea').evaluateAll(elements=>elements.map(element=>element.value))).some(value=>value.includes('_B_PRIVATE')||value.includes('_OWNERLESS_')));
    await page.locator(pageCase.selector).fill(`${runId}_A_EDITED`);await page.waitForFunction(({key,value})=>JSON.parse(localStorage.getItem(key)||'null')?.requirements===value,{key:aKey,value:`${runId}_A_EDITED`});
    result.checks.push('normal admin loads and edits only own browser draft');await save();
    await changeActor(secondToken,other);await load();await waitValue(`${runId}_B_PRIVATE`);
    assert.ok(!(await page.locator('input,textarea').evaluateAll(elements=>elements.map(element=>element.value))).some(value=>value.includes('_A_EDITED')||value.includes('_A_SOURCE')||value.includes('_OWNERLESS_')));
    await page.locator(pageCase.selector).fill(`${runId}_B_EDITED`);await page.waitForFunction(({key,value})=>JSON.parse(localStorage.getItem(key)||'null')?.requirements===value,{key:bKey,value:`${runId}_B_EDITED`});
    result.checks.push('normal ordinary account cannot see A draft or source material');await save();
    await changeActor(null,null);await page.goto(`${origin}${pageCase.path}`,{waitUntil:'load',timeout:45000});await page.getByRole('status').filter({hasText:'请先登录后查看自己的剧本草稿'}).waitFor();assert.equal(await page.locator(pageCase.selector).count(),0);
    result.checks.push('logout removes private editor contents');await save();
    await changeActor(adminToken,admin);await load();await waitValue(`${runId}_A_EDITED`);
    const preserved=await page.evaluate(({aKey,bKey,base,pendingKey,unknown,legacy,runId})=>({a:JSON.parse(localStorage.getItem(aKey)).requirements===`${runId}_A_EDITED`,b:JSON.parse(localStorage.getItem(bKey)).requirements===`${runId}_B_EDITED`,legacy:localStorage.getItem(base)===legacy,pending:localStorage.getItem(pendingKey)===unknown}),{aKey,bKey,base:pageCase.base,pendingKey,unknown,legacy,runId});
    assert.deepEqual(preserved,{a:true,b:true,legacy:true,pending:true});
    result.checks.push('return to A restores own edit; B, ownerless and unresolved request bytes retained');
    result.passed=true;await save();await context.close();
  }
  assert.equal(report.generationRequests,0);assert.equal(report.blockedMutations.length,0);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.apiErrors,[]);report.passed=true;
}catch(error){report.failure=safeError(error);process.exitCode=1;}finally{await save();if(browser)await browser.close();console.log(JSON.stringify({passed:report.passed,cases:report.cases.map(({path,passed,checks})=>({path,passed,checks:checks.length})),generationRequests:report.generationRequests,blockedMutations:report.blockedMutations.length,pageErrors:report.pageErrors.length,apiErrors:report.apiErrors.length,report:reportPath}));}
