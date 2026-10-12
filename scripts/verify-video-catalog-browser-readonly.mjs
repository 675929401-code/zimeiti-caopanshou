// Run through scripts/with-local-customer-session.mjs after the coordinator builds.
// --self-test exercises the installed route callback offline; never launches a browser.
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';
const product=process.cwd();
const approved=new Set(['/api/version','/api/auth/me','/api/member-permissions','/api/video/models','/api/cover-models','/api/settings/video-page','/api/cash/balance']);
function staticEntry(url) {
  if(['/video','/cover','/image-workbench'].includes(url.pathname) || url.pathname.startsWith('/_next/static/'))return true;
  if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/'))return false;
  try {
    const root=path.resolve(product,'public'),target=path.resolve(root,`.${decodeURIComponent(url.pathname)}`);
    return target.startsWith(`${root}${path.sep}`) && statSync(target).isFile();
  } catch {return false;}
}
function routeCallback(origin,report) {
  return async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){report.blockedExternal++;return route.abort('blockedbyclient');}
    if(request.method()!=='GET'){report.blockedWrites++;return route.abort('blockedbyclient');}
    // Explicit RAM empties prevent recovery/status polling. This probe makes no history verdict.
    if(['/api/video/active-tasks','/api/video/history','/api/cover/history','/api/cover/attempt','/api/image-workbench/history','/api/image-workbench/unresolved','/api/image-workbench/failure-history'].includes(url.pathname)) {
      report.emptyHistoryFixtureGets++;
      return route.fulfill({status:200,contentType:'application/json',headers:{'Cache-Control':'private, no-store'},body:JSON.stringify({success:true,activeAttempt:null,activeAttempts:[],activeTasks:[],tasks:[],records:[],nextOffset:null,nextPage:null,truncated:false})});
    }
    if(!approved.has(url.pathname) && !staticEntry(url)){report.blockedOtherGets++;return route.abort('blockedbyclient');}
    try {
      if(url.pathname==='/api/video/models') {
        assert.equal(url.searchParams.get('surface'),'video-page');assert.deepEqual([...url.searchParams.keys()],['surface']);
      }
      const response=await route.fetch({maxRedirects:0});
      assert.ok(response.ok() && response.status()<300,'FAILED_OR_REDIRECTED_READ');
      if(approved.has(url.pathname)) {
        const safe={path:url.pathname,status:response.status()};
        if(url.pathname==='/api/video/models') {
          const body=await response.json();assert.ok(Array.isArray(body.models),'CATALOG_SHAPE_INVALID');safe.count=body.models.length;
        }
        report.actualReads.push(safe);
      }
      return route.fulfill({response});
    } catch {
      report.failedApprovedReads++;return route.abort('blockedbyclient');
    }
  };
}
export async function main() {
  assert.equal(process.version,'v24.19.0','PINNED_NODE_REQUIRED');
  const origin=String(process.env.LOCAL_NAV_ORIGIN||'').replace(/\/$/u,'');assert.equal(origin,'http://127.0.0.1:5000');
  const token=process.env.R267_CUSTOMER_TOKEN,user=JSON.parse(process.env.LOCAL_NAV_READONLY_CUSTOMER||'null');
  assert.ok(token && user?.id && user.role==='student','VERIFIED_ORDINARY_WRAPPER_REQUIRED');
  assert.ok(process.env.VIDEO_CATALOG_PROBE_OUTPUT,'OUTPUT_REQUIRED');const output=path.resolve(process.env.VIDEO_CATALOG_PROBE_OUTPUT);await mkdir(output,{recursive:true});
  const report={schema:'video-catalog-readonly-current-browser.v1',passed:false,checkedAt:new Date().toISOString(),viewport:{width:1440,height:900},
    scope:'Actual ordinary authority, public video catalog and desktop UI shell only; no generation/paid/upstream/storage E2E',
    sessionBoundary:'Controlled wrapper may create and clean a temporary local auth session. Its effects and server internals of approved GET are outside browser routing audit.',
    historyBoundary:'Active tasks/history are explicitly empty RAM fixtures; no real history or task-recovery conclusion.',
    approvedGetPaths:[...approved].sort(),actualReads:[],blockedWrites:0,blockedOtherGets:0,blockedExternal:0,failedApprovedReads:0,emptyHistoryFixtureGets:0,adjacentPages:[]};
  let browser,context,page,stage='current runtime identity';
  try {
    report.runtimeBefore=await runtimeIdentity(origin);
    browser=await chromium.launch({channel:'msedge',headless:true});context=await browser.newContext({viewport:report.viewport,serviceWorkers:'block'});
    await context.addCookies([{name:'auth_token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
    await context.addInitScript(({token,user})=>{localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));sessionStorage.setItem('entered_app','1');},{token,user});
    await context.route('**/*',routeCallback(origin,report));page=await context.newPage();page.setDefaultTimeout(30000);
    stage='ordinary video authority';await page.goto(`${origin}/video`,{waitUntil:'domcontentloaded'});
    report.authority=await page.evaluate(async expected=>{
      const headers={Authorization:`Bearer ${localStorage.getItem('auth_token')||''}`};
      const [a,p]=await Promise.all([fetch('/api/auth/me',{headers,cache:'no-store',redirect:'error'}),fetch('/api/member-permissions',{headers,cache:'no-store',redirect:'error'})]);
      const identity=await a.json(),permission=(await p.json()).permission;
      return {authStatus:a.status,permissionStatus:p.status,ordinary:identity.user?.role==='student',ownerMatches:identity.user?.id===expected && permission?.userId===expected,
        ready:permission?.authorityStatus==='ready' && permission?.integrityValid===true,videoAllowed:permission?.featureNavigationKeys?.includes('create')===true,
        adjacentAllowed:['cover','image_workbench'].every(key=>permission?.featureNavigationKeys?.includes(key))};
    },user.id);
    assert.ok(report.authority.authStatus===200 && report.authority.permissionStatus===200 && report.authority.ordinary && report.authority.ownerMatches && report.authority.ready && report.authority.videoAllowed,'ORDINARY_PERMISSION_INSUFFICIENT');
    stage='actual public catalog loaded';await page.locator('[data-video-model-list]').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelectorAll('[data-video-model-list] button[data-video-model-id]').length>0
      && !/视频模型目录加载中|模型目录加载中|视频模型目录加载失败|视频模型目录暂时无法读取/u.test(document.body.innerText));
    report.layout=await page.evaluate(()=>({modelCardCount:document.querySelectorAll('[data-video-model-list] button[data-video-model-id]').length,
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
      loadingVisible:/视频模型目录加载中|模型目录加载中/u.test(document.body.innerText),catalogErrorVisible:/视频模型目录加载失败|视频模型目录暂时无法读取/u.test(document.body.innerText),
      routingSuffixVisible:[...document.querySelectorAll('[data-video-model-list] button[data-video-model-id] .line-clamp-2')].some(title=>/\s*[·|｜/]\s*高端渠道\s*$/u.test(title.textContent||'')),
      modelNamesPresent:[...document.querySelectorAll('[data-video-model-list] button[data-video-model-id]')].every(card=>Boolean(card.querySelector('.line-clamp-2')?.textContent?.trim()))}));
    assert.ok(report.layout.modelCardCount>0 && report.layout.modelNamesPresent);assert.equal(report.layout.horizontalOverflow,false);assert.equal(report.layout.loadingVisible,false);assert.equal(report.layout.catalogErrorVisible,false);
    assert.equal(report.layout.routingSuffixVisible,false,'PUBLIC_MODEL_ROUTING_SUFFIX_VISIBLE');
    assert.ok(report.actualReads.some(read=>read.path==='/api/video/models' && read.count>0),'REAL_CATALOG_NOT_READ');
    for(const name of ['/api/auth/me','/api/member-permissions','/api/settings/video-page','/api/cash/balance'])assert.ok(report.actualReads.some(read=>read.path===name),'REQUIRED_ACTUAL_GET_NOT_READ');
    assert.equal(report.failedApprovedReads,0);await page.screenshot({path:path.join(output,'video-catalog-current.png'),fullPage:false});
    assert.equal(report.authority.adjacentAllowed,true,'ORDINARY_ADJACENT_PERMISSION_INSUFFICIENT');
    for(const [route,selector] of [['/cover','.cover-rebuild-workspace [aria-label="封面生成参数"]'],['/image-workbench','#image-workbench-model']]) {
      stage=`readonly adjacent ${route}`;await page.goto(`${origin}${route}`,{waitUntil:'domcontentloaded'});await page.locator(selector).waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'ADJACENT_HORIZONTAL_OVERFLOW');
      await page.screenshot({path:path.join(output,`adjacent-${route.slice(1)}.png`),fullPage:false});
      report.adjacentPages.push({route,passed:true,scope:'Readonly desktop shell only; no generation or history conclusion'});
    }
    assert.equal(report.failedApprovedReads,0);
    stage='unchanged runtime identity';report.runtimeAfter=await runtimeIdentity(origin);assert.deepEqual(report.runtimeAfter,report.runtimeBefore);report.passed=true;
  } catch(error) {
    report.failure={stage,name:error?.name==='AssertionError'?'AssertionError':'ExecutionError'};
    if(page && !page.isClosed()) {
      report.failureMetrics=await page.evaluate(()=>({modelCardCount:document.querySelectorAll('[data-video-model-list] button[data-video-model-id]').length,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
        loadingVisible:/视频模型目录加载中|模型目录加载中/u.test(document.body.innerText),catalogErrorVisible:/视频模型目录加载失败|视频模型目录暂时无法读取/u.test(document.body.innerText)})).catch(()=>({unavailable:true}));
      await page.screenshot({path:path.join(output,'video-catalog-failed.png'),fullPage:false}).catch(()=>{});
    }
    process.exitCode=1;
  } finally {
    if(context)await context.close();if(browser)await browser.close();await writeFile(path.join(output,'summary.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:report.passed,stage:report.failure?.stage||'complete',modelCardCount:report.layout?.modelCardCount||0}));
  }
}

async function runtimeIdentity(origin) {
  const dist = process.env.LOCAL_VALIDATION_DIST_DIR?.trim() || ".next";
  assert.ok([".next", ".next-local-acceptance", ".next-local-acceptance-next"].includes(dist), "INVALID_BUILD_DIRECTORY");
  const [response, versionText, buildText, receiptText] = await Promise.all([
    fetch(`${origin}/api/version`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) }),
    readFile("public/version.json", "utf8"), readFile(path.join(dist, "BUILD_ID"), "utf8"),
    readFile(path.join(dist, "local-source-fingerprint.v1.json"), "utf8"),
  ]);
  assert.ok(response.ok, "VERSION_GET_FAILED");
  const runtime = await response.json(), disk = JSON.parse(versionText.replace(/^\uFEFF/u, ""));
  const receipt = JSON.parse(receiptText.replace(/^\uFEFF/u, "")), current = computeLocalBuildFingerprint(process.cwd());
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, "local-production-preview-source-fingerprint");
  assert.ok(runtime.sourceVersion && runtime.buildId, "PRODUCTION_BUILD_REQUIRED");
  assert.equal(runtime.sourceVersion, disk.sourceVersion, "SOURCE_VERSION_MISMATCH");
  assert.equal(runtime.buildId, buildText.trim(), "RUNTIME_BUILD_MISMATCH");
  assert.equal(receipt.buildId, runtime.buildId, "RECEIPT_BUILD_MISMATCH");
  assert.equal(receipt.fingerprint, current.fingerprint, "CURRENT_SOURCE_FINGERPRINT_MISMATCH");
  assert.equal(receipt.fileCount, current.fileCount, "CURRENT_SOURCE_COUNT_MISMATCH");
  return { sourceVersion: runtime.sourceVersion, buildId: runtime.buildId, fingerprint: current.fingerprint, runningLatest: true };
}
async function selfTest() {
  const origin='http://127.0.0.1:5000',report={actualReads:[],blockedWrites:0,blockedOtherGets:0,blockedExternal:0,failedApprovedReads:0,emptyHistoryFixtureGets:0};
  let checks=0,forwardedWrites=0;
  const invoke=async (url,method='GET',status=200,body={models:[{opaque:'not retained'}]})=>{
    let result;
    await routeCallback(origin,report)({request:()=>({url:()=>url.startsWith('http')?url:origin+url,method:()=>method}),
      fetch:async options=>{assert.deepEqual(options,{maxRedirects:0});if(method!=='GET')forwardedWrites++;if(status==='throw')throw Error('OFFLINE_FAILED_READ');return {ok:()=>status>=200&&status<300,status:()=>status,json:async()=>body};},
      fulfill:async response=>{result={kind:'fulfilled',...response};},abort:async()=>{result={kind:'blocked'};},continue:async()=>{throw Error('UNCONTROLLED_CONTINUE');}});
    return result;
  };
  for(const url of [...approved].map(url=>url==='/api/video/models'?`${url}?surface=video-page`:url).concat(['/video','/cover','/image-workbench','/_next/static/fixture.js'])) {
    assert.equal((await invoke(url)).kind,'fulfilled');checks++;
    for(const status of [301,302,307,308,401,403,500,'throw']) {assert.equal((await invoke(url,'GET',status)).kind,'blocked');checks++;}
  }
  for(const url of ['/api/video/active-tasks','/api/video/history','/api/cover/history','/api/cover/attempt','/api/image-workbench/history','/api/image-workbench/unresolved','/api/image-workbench/failure-history']) {
    const response=await invoke(url);assert.equal(response.status,200);const value=JSON.parse(response.body);
    assert.deepEqual(value.activeTasks,[]);assert.deepEqual(value.records,[]);assert.equal(value.activeAttempt,null);checks++;
  }
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) for(const url of ['/api/video/generate','/api/video/reference-upload','/api/settings/video-page','/api/cover/attempt','/api/auth/me']) {
    assert.equal((await invoke(url,method)).kind,'blocked');checks++;
  }
  for(const url of ['https://example.invalid/media','http://localhost:5000/api/auth/me','/api/video/status?taskId=not-owned','/api/video/access-ticket','/api/unknown','/uploads/private.png','/unknown-route']) {
    assert.equal((await invoke(url)).kind,'blocked');checks++;
  }
  for(const url of ['/api/video/models','/api/video/models?surface=other','/api/video/models?surface=video-page&extra=1']) {assert.equal((await invoke(url)).kind,'blocked');checks++;}
  assert.equal((await invoke('/api/video/models?surface=video-page','GET',200,{error:'not a catalog'})).kind,'blocked');checks++;
  assert.equal(forwardedWrites,0);assert.equal(JSON.stringify(report).includes('not retained'),false);checks+=2;
  assert.ok(report.actualReads.some(read=>read.path==='/api/video/models'&&read.count===1));checks++;
  console.log(JSON.stringify({passed:true,checks,scope:'Installed readonly route callback offline only; no browser/session/server/DB accessed'}));
}
if(process.argv.includes('--self-test'))await selfTest();
