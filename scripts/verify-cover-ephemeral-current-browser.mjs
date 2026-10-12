#!/usr/bin/env node
// Import main through with-local-customer-session.mjs after the coordinator builds.
// --self-test exercises the same route callback offline; it never launches a browser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { chromium } from "playwright";
import sharp from "sharp";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const approvedApiGets = new Set(["/api/version", "/api/auth/me", "/api/member-permissions", "/api/cover-models"]);
const uiPaths = new Set(["/cover"]);
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
function staticEntry(url) {
  if (uiPaths.has(url.pathname) || url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return false;
  try {
    const root = path.resolve("public"), target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    return target.startsWith(`${root}${path.sep}`) && statSync(target).isFile();
  } catch { return false; }
}
function assertMetadata(value) {
  if (typeof value === "string") assert.equal(/^(?:blob:|data:[^,]+;base64,)/iu.test(value), false, "PERSISTED_MEDIA_URL");
  else if (Array.isArray(value)) {
    assert.equal(value.length > 0 && value.every(item => typeof item === "number"), false, "PERSISTED_BYTE_ARRAY");
    value.forEach(assertMetadata);
  } else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    assert.equal(/^(?:base64|bytes|buffer|dataUrl|transientDelivery)$/iu.test(key), false, "PERSISTED_BINARY_FIELD");
    assertMetadata(item);
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
function counters() { return { claimCount:0, generationCount:0, blockedWrites:0, blockedGets:0, blockedExternal:0, fixtureErrors:0, actualReads:{} }; }
function fixture() { return { armed:false, models:new Set(), attempt:null, receipt:null, png:null, recordId:sha('cover-browser-synthetic-inline-v1') }; }
async function approvedRead(route,state,report) {
  const response=await route.fetch({maxRedirects:0});
  if(!response.ok() || response.status()>=300) { report.fixtureErrors++; return route.abort('blockedbyclient'); }
  if(new URL(route.request().url()).pathname==='/api/cover-models') {
    const body=await response.json(); assert.ok(Array.isArray(body.models),'REAL_CATALOG_INVALID');
    state.models=new Set(body.models.filter(model=>typeof model.id==='string' && model.id.startsWith('pm_') && typeof model.displayName==='string'
      && model.capabilities?.available!==false && model.capabilities?.priceReady!==false).map(model=>model.id));
  }
  return route.fulfill({response});
}
// The installed callback is also exercised offline, including actual forwarding failures.
function routeCallback(origin,state,report) {
  return async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method();
    if(url.origin!==origin) { report.blockedExternal++; return route.abort('blockedbyclient'); }
    try {
      if(url.pathname==='/api/cover/attempt') {
        if(method==='POST') {
          const body=request.postDataJSON();
          assert.ok(state.armed,'UNARMED_COVER_WRITE');
          if(body.action==='claim') {
            assert.equal(state.attempt,null,'SECOND_CLAIM');
            assert.ok(state.models.has(body.payload?.modelId),'UNAVAILABLE_REAL_MODEL');
            assert.equal(body.payload.historySurface,'cover-studio');
            assert.equal(body.payload.resumeDeliveryOnly,undefined);
            assert.deepEqual(body.payload.referenceImageUrls,[]); assert.equal(body.referenceCount,0);
            assert.ok(body.clientIdempotencyKey && body.clientTraceId && body.task?.renderPlan,'MISSING_IDENTITY_OR_PLAN');
            state.attempt={clientIdempotencyKey:body.clientIdempotencyKey,clientTraceId:body.clientTraceId,
              state:'claimed',updatedAt:Date.now(),task:body.task,canDispatch:true,requiresReferenceReupload:false,dispatchInput:body.payload};
            report.claimCount++;
            return json(route,{success:true,completed:false,activeAttempt:state.attempt});
          }
          assert.equal(body.action,'dispatch','UNKNOWN_ACTION'); assert.ok(state.attempt && !state.receipt,'SECOND_DISPATCH');
          assert.equal(body.clientIdempotencyKey,state.attempt.clientIdempotencyKey); assert.equal(body.clientTraceId,state.attempt.clientTraceId);
          assert.deepEqual(body.payload,state.attempt.dispatchInput,'DISPATCH_PAYLOAD_CHANGED');
          const dimensions={'4:3':[256,192],'3:4':[192,256],'16:9':[320,180],'9:16':[180,320],'1:1':[256,256]}[state.attempt.task.ratio];
          assert.ok(dimensions,'UNSUPPORTED_RATIO'); const [width,height]=dimensions;
          state.png=await sharp({create:{width,height,channels:4,background:'#7654bc'}}).png().toBuffer();
          state.receipt={success:true,completed:true,generationCompleted:true,state:'completed',deliveryMode:'inline_ephemeral',
            recordId:state.recordId,cashCharged:0.01,billingReferenceId:'image:synthetic_cover',mediaAvailable:false,canRecover:false,
            retention:'current_page_only',sha256:sha(state.png),byteLength:state.png.length,contentType:'image/png',width,height};
          state.armed=false; report.generationCount++;
          return json(route,{...state.receipt,mediaAvailable:true,activeAttempt:null,
            images:[{recordId:state.recordId,deliveryMode:'inline_ephemeral',url:`data:image/png;base64,${state.png.toString('base64')}`,width,height}]});
        }
        if(method==='GET') {
          // The real unkeyed endpoint only discovers active attempts, never completed receipts.
          if(!url.searchParams.size) return json(route,{success:true,activeAttempt:state.receipt?null:state.attempt});
          if(url.searchParams.size) {
            assert.ok(state.attempt,'UNKNOWN_ATTEMPT');
            assert.deepEqual([...url.searchParams.keys()].sort(),['clientIdempotencyKey','clientTraceId']);
            for(const key of ['clientIdempotencyKey','clientTraceId']) assert.equal(url.searchParams.get(key),state.attempt[key]);
          }
          return json(route,state.receipt?{...state.receipt,images:[],activeAttempt:null}:{success:true,completed:false,activeAttempt:state.attempt});
        }
      }
      if(method!=='GET') { report.blockedWrites++; return route.abort('blockedbyclient'); }
      const ram={'/api/cover/render':{ready:true},'/api/cash/balance':{balance:1000},'/api/cover/history':{records:[],activeAttempts:[],nextPage:null}};
      if(Object.hasOwn(ram,url.pathname)) return json(route,ram[url.pathname]);
      if(approvedApiGets.has(url.pathname)) { report.actualReads[url.pathname]=(report.actualReads[url.pathname]||0)+1; return await approvedRead(route,state,report); }
      if(staticEntry(url)) return await approvedRead(route,state,report);
      report.blockedGets++; return route.abort('blockedbyclient');
    } catch { report.fixtureErrors++; return json(route,{error:'Synthetic cover contract failed'},500); }
  };
}
async function storageReceipt(page,state) {
  const raw=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('cover-generation:v1:')));
  let found;
  for(const [,value] of raw) {
    const parsed=JSON.parse(value); assertMetadata(parsed);
    found ||= parsed.receipts?.find(task=>task.imageDeliveryReceipt?.recordId===state.recordId);
  }
  assert.ok(found,'COVER_RECEIPT_MISSING'); assert.equal(found.status,'done'); assert.equal(found.url,undefined);
  assert.equal(found.imageDeliveryReceipt.cashCharged,0.01); assert.equal(found.billing.chargedAmount,0.01);
  assert.equal(found.imageDeliveryReceipt.canRecover,false); assert.equal(found.imageDeliveryReceipt.mediaAvailable,false);
  return {receipt:found.imageDeliveryReceipt,billing:found.billing,storageSha256:sha(JSON.stringify(raw))};
}
export async function main() {
  assert.equal(process.version,'v24.19.0'); const origin=String(process.env.LOCAL_NAV_ORIGIN||'').replace(/\/$/u,'');
  assert.equal(origin,'http://127.0.0.1:5000'); const token=process.env.R267_CUSTOMER_TOKEN,user=JSON.parse(process.env.LOCAL_NAV_READONLY_CUSTOMER||'null');
  assert.ok(token && user?.id && user.role==='student','VERIFIED_ORDINARY_WRAPPER_REQUIRED');
  assert.ok(process.env.COVER_EPHEMERAL_ACCEPTANCE_OUTPUT,'OUTPUT_DIRECTORY_REQUIRED');
  const output=path.resolve(process.env.COVER_EPHEMERAL_ACCEPTANCE_OUTPUT); await mkdir(output,{recursive:true});
  const report={schema:'cover-ephemeral-current-browser.v1',passed:false,checkedAt:new Date().toISOString(),
    scope:'Actual ordinary cover UI; one RAM claim/dispatch, synthetic PNG only; no paid/storage E2E',
    authorityScope:'Real auth/permission/catalog GET and controlled wrapper effects; server internals not audited',viewport:{width:1440,height:900},...counters()};
  const state=fixture(); let browser,context,page,stage='current build gate';
  try {
    report.runtimeBefore=await runtimeIdentity(origin); browser=await chromium.launch({channel:'msedge',headless:true});
    context=await browser.newContext({viewport:report.viewport,acceptDownloads:true,serviceWorkers:'block'});
    await context.addCookies([{name:'auth_token',value:token,url:origin,httpOnly:true,sameSite:'Lax'}]);
    await context.addInitScript(({token,user})=>{
      localStorage.setItem('auth_token',token); localStorage.setItem('auth_user',JSON.stringify(user)); sessionStorage.setItem('entered_app','1');
      window.__coverDiagnostics={blobFetches:0,violations:[]}; const original=window.fetch;
      window.fetch=function(input,options){if(String(typeof input==='string'?input:input?.url||'').startsWith('blob:'))window.__coverDiagnostics.blobFetches++;return original.call(this,input,options);};
      document.addEventListener('securitypolicyviolation',event=>window.__coverDiagnostics.violations.push({directive:event.effectiveDirective,scheme:String(event.blockedURI||'').split(':')[0]}));
    },{token,user});
    await context.route('**/*',routeCallback(origin,state,report)); page=await context.newPage(); page.setDefaultTimeout(30000);
    stage='actual ordinary authority'; await page.goto(`${origin}/cover`,{waitUntil:'domcontentloaded'});
    report.authority=await page.evaluate(async expected=>{
      const headers={Authorization:`Bearer ${localStorage.getItem('auth_token')||''}`};
      const [a,p]=await Promise.all([fetch('/api/auth/me',{headers,cache:'no-store'}),fetch('/api/member-permissions',{headers,cache:'no-store'})]);
      const identity=await a.json(),permission=(await p.json()).permission;
      return {authStatus:a.status,permissionStatus:p.status,ordinary:identity.user?.role==='student',ownerMatches:identity.user?.id===expected && permission?.userId===expected,
        ready:permission?.authorityStatus==='ready' && permission?.integrityValid===true,coverAllowed:permission?.featureNavigationKeys?.includes('cover')===true};
    },user.id);
    assert.ok(report.authority.authStatus===200 && report.authority.permissionStatus===200 && report.authority.ordinary && report.authority.ownerMatches && report.authority.ready && report.authority.coverAllowed,'ORDINARY_PERMISSION_INSUFFICIENT');
    stage='real catalog and brief'; const model=page.locator('.cover-flagship-models button:not([disabled])').first(); await model.waitFor({state:'visible'}); await model.click();
    await page.getByRole('group',{name:'创作依据',exact:true}).getByRole('button',{name:/文案直出/u}).click();
    await page.getByRole('textbox',{name:'输入文案',exact:true}).fill('Synthetic acceptance only: a purple landscape with a clear title. No real generation.');
    await page.getByRole('button',{name:'拆解文案',exact:true}).click();
    const generate=page.locator('.cover-generate-submit'); await generate.waitFor({state:'visible'}); assert.ok(await generate.isEnabled(),'REAL_MODEL_NOT_GENERATABLE');
    stage='one explicit cover generation'; state.armed=true; await generate.click();
    const image=page.locator('.cover-result-image-button img'); await image.waitFor({state:'visible'});
    report.decoded=await image.evaluate(async element=>{await element.decode();return {blob:element.src.startsWith('blob:'),width:element.naturalWidth,height:element.naturalHeight};});
    assert.equal(report.decoded.blob,true); assert.equal(report.decoded.width,state.receipt.width); assert.equal(report.decoded.height,state.receipt.height);
    stage='explicit preview'; await page.getByRole('button',{name:'放大查看封面',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'封面大图预览',exact:true}); await dialog.waitFor({state:'visible'});
    assert.ok(await dialog.locator('img').evaluate(async element=>{await element.decode();return element.naturalWidth>0;}));
    await page.getByRole('button',{name:'关闭封面大图预览',exact:true}).click();
    stage='explicit single download event'; const pending=page.waitForEvent('download'); await page.locator('.cover-result-actions').getByRole('button',{name:'下载',exact:true}).click(); const download=await pending;
    try {
      stage='explicit download bytes'; const stream=await download.createReadStream(); assert.ok(stream); const chunks=[];let length=0;
      for await(const chunk of stream) {length+=chunk.length; assert.ok(length<=2*1024*1024);chunks.push(chunk);}
      assert.equal(length,state.receipt.byteLength); assert.equal(sha(Buffer.concat(chunks)),state.receipt.sha256); report.downloadVerified=true;
    } finally {await download.delete();}
    report.diagnostics=await page.evaluate(()=>window.__coverDiagnostics); assert.equal(report.diagnostics.blobFetches,0); assert.equal(report.diagnostics.violations.filter(item=>item.scheme==='blob').length,0);
    stage='strict receipt before refresh'; report.beforeReload=await storageReceipt(page,state); await page.screenshot({path:path.join(output,'cover-current.png'),fullPage:false});
    stage='refresh receipt without regeneration'; await page.reload({waitUntil:'domcontentloaded'}); await page.locator('.cover-rebuild-workspace').waitFor({state:'visible'}); await page.waitForTimeout(3500);
    assert.equal(await page.locator('.cover-result-image-button img').count(),0,'INLINE_IMAGE_RESTORED');
    assert.equal(await page.locator('.cover-result-actions').getByRole('button',{name:'下载',exact:true}).isEnabled(),false);
    report.afterReload=await storageReceipt(page,state); assert.equal(report.claimCount,1);assert.equal(report.generationCount,1); assert.equal(report.fixtureErrors,0);
    for(const key of ['/api/auth/me','/api/member-permissions','/api/cover-models']) assert.ok(report.actualReads[key]);
    await page.screenshot({path:path.join(output,'cover-refreshed.png'),fullPage:false});
    stage='unchanged current build gate'; report.runtimeAfter=await runtimeIdentity(origin);assert.deepEqual(report.runtimeAfter,report.runtimeBefore);report.passed=true;
  } catch(error) {
    report.failure={stage,name:error?.name==='AssertionError'?'AssertionError':'ExecutionError'};
    if(page && !page.isClosed()) {
      report.failureMetrics=await page.evaluate(()=>({dialogs:document.querySelectorAll('[role="dialog"]').length,images:[...document.querySelectorAll('.cover-result-image-button img')].map(image=>({scheme:image.src.split(':')[0],width:image.naturalWidth,height:image.naturalHeight})),diagnostics:window.__coverDiagnostics})).catch(()=>({unavailable:true}));
      await page.screenshot({path:path.join(output,'cover-failed.png'),fullPage:false}).catch(()=>{});
    }
    process.exitCode=1;
  } finally {
    if(context)await context.close(); if(browser)await browser.close(); await writeFile(path.join(output,'summary.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:report.passed,stage:report.failure?.stage||'complete',claimCount:report.claimCount,generationCount:report.generationCount}));
  }
}
async function producerConsumerSelfTest() {
  // Real serialization and receipt projection feed the same browser consumer, not a hand-made route response.
  const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const load=async (file,deps)=>{
    const module={exports:{}};
    runInNewContext(compile(await readFile(file,'utf8')),{module,exports:module.exports,
      require:name=>{assert.ok(Object.hasOwn(deps,name),`UNEXPECTED_PRODUCER_DEPENDENCY:${name}`);return deps[name];},
      Blob,Response,URL,URLSearchParams,Uint8Array,atob,fetch:()=>{throw Error('PRODUCER_NETWORK_FORBIDDEN');}});
    return module.exports;
  };
  const refs=await load('src/lib/generated-image-reference.ts',{zod:{z}});
  const client=await load('src/lib/generated-image-client-delivery.ts',{'@/lib/generated-image-reference':refs});
  const guard=await load('src/lib/image-workbench-attempt-guard.ts',{});
  const cover=await load('src/lib/cover-generation-attempt.ts',{'@/lib/image-workbench-attempt-guard':guard,
    '@/lib/generated-image-client-delivery':client,'@/lib/cover-composition':{coverCompositionValidationError:()=>'',coverCompositionMatches:()=>true},
    '@/lib/image-resolution-pricing':{},'@/lib/cover-durable-attempt':{projectCoverCompositionPlan:value=>value}});
  const state=fixture(),storage=new Map(),browserStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
  cover.saveCoverEphemeralReceipt(browserStorage,'synthetic-owner',{id:'cover-task',ratio:'3:4',title:'Synthetic',subtitle:'',prompt:'Draw metadata: field',
    source:'生成',createdAt:'2026-10-12T00:00:00Z',taskNo:1,status:'done',url:'blob:must-not-persist',
    imageDeliveryReceipt:{recordId:state.recordId,deliveryMode:'inline_ephemeral',generationCompleted:true,cashCharged:0.01,
      billingReferenceId:'image:synthetic_cover',mediaAvailable:false,canRecover:false,retention:'current_page_only',width:192,height:256}});
  const entries=[...storage.entries()],persisted=JSON.parse(entries[0][1]);
  assert.equal(entries[0][0],'cover-generation:v1:synthetic-owner');assert.equal(persisted.history.length,0);assert.equal(persisted.receipts.length,1);
  const pageFor=value=>({evaluate:async()=>[[entries[0][0],JSON.stringify(value)]]});
  const receipt=await storageReceipt(pageFor(persisted),state);
  assert.equal(receipt.receipt.cashCharged,0.01);assert.equal(receipt.billing.chargedAmount,0.01);assertMetadata(persisted);
  const restored=cover.readCoverGenerationState(browserStorage,'synthetic-owner').history[0];
  assert.equal(restored.status,'done');assert.equal(restored.url,undefined);assert.equal(restored.billing.chargedAmount,0.01);
  const reject=async mutate=>{const value=JSON.parse(JSON.stringify(persisted));mutate(value);await assert.rejects(storageReceipt(pageFor(value),state));};
  await reject(value=>{value.history=value.receipts;delete value.receipts;});
  await reject(value=>{value.receipts=[];});
  await reject(value=>{value.receipts[0].imageDeliveryReceipt.recordId='f'.repeat(64);});
  await reject(value=>{value.receipts[0].imageDeliveryReceipt.cashCharged=0.02;});
  await reject(value=>{value.receipts[0].billing.chargedAmount=0.02;});
  await reject(value=>{value.receipts[0].url='blob:forbidden';});
  await reject(value=>{value.receipts[0].bytes=[1,2,3];});
  await reject(value=>{value.receipts[0].imageDeliveryReceipt.mediaAvailable=true;});
  return 17; // 9 producer/round-trip assertions and 8 actual consumer rejection fixtures.
}
async function selfTest() {
  const origin='http://127.0.0.1:5000',state=fixture(),report=counters();let checks=0;
  const invoke=async (url,method='GET',body,status=200)=>{
    let result; await routeCallback(origin,state,report)({request:()=>({url:()=>url.startsWith('http')?url:origin+url,method:()=>method,postDataJSON:()=>body}),
      fetch:async options=>{assert.deepEqual(options,{maxRedirects:0});if(status==='throw')throw Error('OFFLINE_READ_FAILED');return {ok:()=>status>=200&&status<300,status:()=>status,json:async()=>({models:[{id:'pm_real_fixture',displayName:'Fixture',capabilities:{available:true,priceReady:true}}]})};},
      fulfill:async value=>{result={kind:'fulfilled',...value};},abort:async()=>{result={kind:'blocked'};},continue:async()=>{throw Error('FORBIDDEN_CONTINUE');}});return result;
  };
  for(const url of [...approvedApiGets,'/cover','/_next/static/test.js']) {
    assert.equal((await invoke(url)).kind,'fulfilled');checks++;
    for(const status of [301,302,307,308,403,500]) {assert.equal((await invoke(url,'GET',undefined,status)).kind,'blocked');checks++;}
    assert.equal((await invoke(url,'GET',undefined,'throw')).status,500);checks++;
  }
  for(const [url,method] of [['https://example.invalid/a','GET'],['/api/unknown','GET'],['/api/image/generate','POST'],['/api/cover/history','DELETE']]) {assert.equal((await invoke(url,method)).kind,'blocked');checks++;}
  assert.equal((await invoke('/api/cover/attempt','POST',{action:'claim'})).status,500);checks++;
  state.armed=true;const body={action:'claim',clientIdempotencyKey:'fixture-key',clientTraceId:'fixture-trace',referenceCount:0,task:{ratio:'4:3',renderPlan:{}},payload:{modelId:'pm_real_fixture',historySurface:'cover-studio',referenceImageUrls:[]}};
  assert.equal((await invoke('/api/cover/attempt','POST',{...body,payload:{...body.payload,modelId:'unknown'}})).status,500);checks++;
  assert.equal((await invoke('/api/cover/attempt','POST',body)).status,200);checks++;
  assert.equal((await invoke('/api/cover/attempt?clientIdempotencyKey=other&clientTraceId=fixture-trace')).status,500);checks++;
  const dispatch={action:'dispatch',clientIdempotencyKey:'fixture-key',clientTraceId:'fixture-trace',payload:body.payload};
  assert.equal((await invoke('/api/cover/attempt','POST',{...dispatch,clientTraceId:'other'})).status,500);checks++;
  const completed=JSON.parse((await invoke('/api/cover/attempt','POST',dispatch)).body);assert.equal(completed.images.length,1);assert.equal(sha(state.png),completed.sha256);assert.equal((await sharp(state.png).metadata()).width,256);checks+=3;
  const receipt=JSON.parse((await invoke('/api/cover/attempt?clientIdempotencyKey=fixture-key&clientTraceId=fixture-trace')).body);assertMetadata(receipt);assert.deepEqual(receipt.images,[]);assert.equal(receipt.cashCharged,0.01);checks+=3;
  const discovery=JSON.parse((await invoke('/api/cover/attempt')).body);
  assert.deepEqual(discovery,{success:true,activeAttempt:null});checks++;
  for(const key of ['recordId','receipt','images','completed','cashCharged']) {assert.equal(Object.hasOwn(discovery,key),false);checks++;}
  assert.equal((await invoke('/api/cover/attempt','POST',dispatch)).status,500);checks++;assert.equal(report.generationCount,1);assert.equal(report.claimCount,1);checks+=2;
  assert.throws(()=>assertMetadata({url:'blob:test'}));assert.throws(()=>assertMetadata({base64:'test'}));checks+=2;
  const producerConsumerChecks=await producerConsumerSelfTest();checks+=producerConsumerChecks;
  console.log(JSON.stringify({passed:true,checks,producerConsumerChecks,scope:'Actual route callback plus real cover receipt producer -> same storage consumer; no browser/runtime/server accessed'}));
}
if(process.argv.includes('--self-test'))await selfTest();
