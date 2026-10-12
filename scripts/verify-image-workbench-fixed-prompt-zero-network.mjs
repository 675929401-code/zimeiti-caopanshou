#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import sharp from "sharp";
import { chromium } from "playwright";
import {
  assertPaidActor, assertPaidQuote, quotedModelPrice, publicModelProjection, parseArgs,
  assertProviderImageEvidence, imageAspectSupport, assertFreshImageModel, assertDecodedImageAspect,
  makeWorkbenchPaidPostHandler, makeImagePaidRouteBoundary, awaitImageGenerationResponse, captureImageRequest,
  safeHarnessEvidence, safeHarnessErrorCode,
  modelSupportsRequestedImageParameters,
  selectPublicImageModel,
  waitForImageDecoded, readWorkbenchDeliveryReceipt,
} from "./verify-image-workbench-live-e2e.mjs";

async function runBrowserFixtures() {
  const browser=await chromium.launch({headless:true});
  let escapedRequests=0,mockedRequests=0,releaseImage,markImageRequested;
  const imageRequested=new Promise(resolve=>{markImageRequested=resolve;});
  const imageGate=new Promise(resolve=>{releaseImage=resolve;});
  const png=await sharp({create:{width:12,height:8,channels:4,background:'#00aaaa'}}).png().toBuffer();
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!=='https://fixture.test' || route.request().method()!=='GET'){
        escapedRequests++;return route.abort();
      }
      mockedRequests++;
      if(url.pathname==='/delayed.png'){
        markImageRequested();await imageGate;
        return route.fulfill({status:200,contentType:'image/png',body:png});
      }
      if(url.pathname==='/broken.png')return route.fulfill({status:200,contentType:'image/png',body:'invalid-image'});
      return route.fulfill({status:200,contentType:'text/html',body:'<img id="result" loading="lazy" decoding="async" style="width:120px;height:80px">'});
    });
    const page=await context.newPage();await page.goto('https://fixture.test/');
    const image=page.locator('#result');
    assert.equal(await image.isVisible(),true);
    assert.deepEqual(await image.evaluate(el=>[el.naturalWidth,el.naturalHeight]),[0,0]);
    let finished=false;
    const waiting=waitForImageDecoded(image,{timeout:5000}).then(value=>{finished=true;return value;});
    waiting.catch(()=>{});
    await image.evaluate(el=>{el.src='/delayed.png';});await imageRequested;
    assert.equal(finished,false,'VISIBLE_IMAGE_MUST_WAIT_FOR_BYTES');
    releaseImage();
    assert.deepEqual(await waiting,{complete:true,width:12,height:8});
    await page.reload();
    const invalid=waitForImageDecoded(image,{timeout:3000});invalid.catch(()=>{});
    await image.evaluate(el=>{el.src='/broken.png';});
    await assert.rejects(invalid,/HARNESS_IMAGE_(?:LOAD|DECODE)_FAILED/u);
    await page.reload();
    await assert.rejects(waitForImageDecoded(image,{timeout:250}),/HARNESS_IMAGE_DECODE_TIMEOUT/u);
    await page.reload();
    const detachedLocator={
      waitFor:options=>image.waitFor(options),
      scrollIntoViewIfNeeded:async options=>{await image.scrollIntoViewIfNeeded(options);await image.evaluate(el=>el.remove());},
      evaluate:(...args)=>image.evaluate(...args),
    };
    const detachStarted=Date.now();
    await assert.rejects(waitForImageDecoded(detachedLocator,{timeout:250}),/Timeout|HARNESS_IMAGE/u);
    assert.ok(Date.now()-detachStarted<2000,'DETACHED_LOCATOR_MUST_REJECT_WITHIN_BUDGET');
    const actor='fixture-owner',key='app_state_image_workbench_prompt_cards_v1:user:fixture-owner:receipts';
    const receipt={recordId:'a'.repeat(64),deliveryMode:'provider_url',cashCharged:.1,billingReferenceId:'image:fixture',generationCompleted:true,mediaAvailable:true,canRecover:true};
    const save=async(value,storage='sessionStorage')=>page.evaluate(({key,value,storage})=>{
      sessionStorage.clear();localStorage.clear();window[storage].setItem(key,JSON.stringify([{id:'fixture',receipt:value}]));
    },{key,value,storage});
    await save(receipt);
    await readWorkbenchDeliveryReceipt(page,receipt,actor);
    await page.reload();await readWorkbenchDeliveryReceipt(page,receipt,actor);
    await assert.rejects(readWorkbenchDeliveryReceipt(page,receipt,'wrong-owner'));
    await save(receipt,'localStorage');await assert.rejects(readWorkbenchDeliveryReceipt(page,receipt,actor));
    for(const change of [{recordId:'b'.repeat(64)},{deliveryMode:'inline_ephemeral'},{cashCharged:.2},{billingReferenceId:'wrong'},{generationCompleted:false},{media:'data:image/png;base64,fixture'}]){
      await save({...receipt,...change});await assert.rejects(readWorkbenchDeliveryReceipt(page,receipt,actor));
    }
    assert.equal(escapedRequests,0);
    console.log(JSON.stringify({passed:true,mode:'actual-chromium-image-decode-and-session-receipts',browserRuns:1,mockedRequests,externalNetworkRequests:0,databaseCalls:0,paidPosts:0,temporaryBrowserFilesystemState:true,visibleBeforeDecodedVerified:true,delayedDecodeVerified:true,errorAndTimeoutReject:true,detachedLocatorBounded:true,sessionOnlySameTabReloadVerified:true,localOnlyAndWrongOwnerRejected:true}));
  } finally {releaseImage?.();await browser.close();}
}

if(process.argv.includes('--browser-fixtures')){
  await runBrowserFixtures();process.exit(0);
}

const root = process.cwd();
const verifierPath = path.join(root, "scripts", "verify-image-workbench-live-e2e.mjs");
const source = fs.readFileSync(verifierPath, "utf8");

function runPlan(args) {
  const result = spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const smokeRunId = `image_smoke_plan_${process.pid}_${Date.now()}`;
const smokeEvidence = path.join(root, ".codex-evidence", "image-workbench-live-ui-only", smokeRunId);
assert.equal(fs.existsSync(smokeEvidence), false);
const smoke = runPlan([`--run-id=${smokeRunId}`]);
assert.equal(smoke.mode, "plan");
assert.equal(smoke.acceptanceProfile, "smoke");
assert.equal(smoke.networkCalls, 0);
assert.equal(smoke.databaseCalls, 0);
assert.equal(smoke.filesystemWrites, 0);
assert.equal(smoke.generationPosts, 0);
assert.equal(smoke.providerCalls, 0);
assert.equal(smoke.paidCalls, 0);
assert.equal(smoke.automaticRetries, 0);
assert.equal(smoke.requestedInputs.prompt, undefined);
assert.ok(smoke.requestedInputs.promptCharacters > 0);
assert.equal(smoke.requestedInputs.imageCount, 1);
assert.equal(smoke.modelSelection, "existing smoke selection behavior");
assert.equal(smoke.executeWillFailClosedBeforeBrowserClick, "unless externally pinned current application DB readiness succeeds");
assert.doesNotMatch(smoke.executeCommand, /--prompt=|--resolution=|--aspect-ratio=|--image-count=/u);
assert.equal(fs.existsSync(smokeEvidence), false, "SMOKE_PLAN_MUST_NOT_WRITE_EVIDENCE");

const exactPrompt = "同一位穿黄色雨衣的短发女孩站在雨夜公交站左侧，右手举透明雨伞，左手把红色纸飞机递给一只坐着的柯基；中景平视，蓝紫霓虹倒影，画面内不要文字、水印、额外人物或额外犬只。";
const fixedRunId = `image_fixed_plan_${process.pid}_${Date.now()}`;
const fixedEvidence = path.join(root, ".codex-evidence", "image-workbench-live-ui-only", fixedRunId);
assert.equal(fs.existsSync(fixedEvidence), false);
const fixed = runPlan([
  `--run-id=${fixedRunId}`,
  `--prompt=${exactPrompt}`,
  "--resolution=1K",
  "--aspect-ratio=16:9",
  "--image-count=1",
]);
assert.equal(fixed.mode, "plan");
assert.equal(fixed.acceptanceProfile, "fixed-prompt-adherence");
assert.deepEqual(fixed.requestedInputs, {
  promptCharacters: exactPrompt.length,
  promptSha256: fixed.requestedInputs.promptSha256,
  resolution: "1K",
  aspectRatio: "16:9",
  imageCount: 1,
});
assert.match(fixed.requestedInputs.promptSha256, /^[a-f0-9]{64}$/u);
assert.equal(fixed.networkCalls, 0);
assert.equal(fixed.databaseCalls, 0);
assert.equal(fixed.filesystemWrites, 0);
assert.equal(fixed.generationPosts, 0);
assert.equal(fixed.providerCalls, 0);
assert.equal(fixed.paidCalls, 0);
assert.equal(fixed.providerEvidence.ready, undefined);
assert.equal(fixed.providerEvidence.enforced, true);
assert.equal(fixed.providerEvidence.readbackStage, "after generation, from owner-scoped status GET");
assert.equal(fixed.executeWillFailClosedBeforeBrowserClick, "unless externally pinned current application DB readiness succeeds");
assert.ok(!JSON.stringify(fixed).includes(exactPrompt), "PLAN_MUST_NOT_ECHO_PRIVATE_PROMPT");
for (const expected of ["--resolution=1K", "--aspect-ratio=16:9", "--image-count=1"]) {
  assert.ok(fixed.executeCommand.includes(expected), `FIXED_EXECUTE_COMMAND_MISSING:${expected}`);
}
assert.equal(fs.existsSync(fixedEvidence), false, "FIXED_PLAN_MUST_NOT_WRITE_EVIDENCE");

const availableButWrong = {
  id: "pm_wrong",
  displayName: "Wrong Shape",
  available: true,
  priceReady: true,
  publicPrice: 0.2,
  resolutionPrices: { "1K": 0.2 },
  resolutionOptions: ["1K"],
  aspectRatios: ["1:1"],
};
const unavailableMatch = {
  id: "pm_unavailable",
  displayName: "Unavailable Match",
  available: false,
  priceReady: true,
  publicPrice: 0.1,
  resolutionPrices: { "1K": 0.1 },
  resolutionOptions: ["1K"],
  aspectRatios: ["16:9"],
};
const exactMatch = {
  id: "pm_exact",
  displayName: "Exact Match",
  available: true,
  priceReady: true,
  publicPrice: 0.3,
  resolutionPrices: { "1K": 0.3 },
  resolutionOptions: ["1K", "2K"],
  aspectRatios: ["16:9", "1:1"],
};
const fixedOptions = {
  acceptanceProfile: "fixed-prompt-adherence",
  resolution: "1K",
  aspectRatio: "16:9",
  modelId: "",
  modelName: "Nano Banana 2",
  modelNameExplicit: false,
};
assert.equal(modelSupportsRequestedImageParameters(availableButWrong, "1K", "16:9"), false);
assert.equal(modelSupportsRequestedImageParameters(unavailableMatch, "1K", "16:9"), false);
assert.equal(modelSupportsRequestedImageParameters(exactMatch, "1K", "16:9"), true);
assert.equal(
  selectPublicImageModel([availableButWrong, unavailableMatch, exactMatch], fixedOptions)?.id,
  exactMatch.id,
  "FIXED_PROFILE_MUST_DYNANICALLY_SKIP_INCOMPATIBLE_OR_UNAVAILABLE_MODELS",
);
assert.equal(selectPublicImageModel([availableButWrong], fixedOptions), null);
assert.equal(selectPublicImageModel([exactMatch], { ...fixedOptions, modelId: "pm_missing" }), null);

const smokeNamed = { ...availableButWrong, id: "pm_smoke", displayName: "Nano Banana 2" };
assert.equal(selectPublicImageModel([exactMatch, smokeNamed], {
  acceptanceProfile: "smoke",
  modelId: "",
  modelName: "Nano Banana 2",
})?.id, smokeNamed.id, "DEFAULT_SMOKE_MODEL_SELECTION_REGRESSED");

assert.match(source, /generationPostLimit:\s*1/u);
assert.match(source, /automaticRetries:\s*0/u);

const hash = value => createHash('sha256').update(value).digest('hex');
const smokeOptions = {acceptanceProfile:'smoke',aspectRatio:''};
const rawModel = {id:'pm_fixture',displayName:'Nano Banana 2',publicPrice:0.3,capabilities:{
  available:true,priceReady:true,resolutionOptions:['1K'],defaultResolution:'1K',resolutionPrices:{'1K':0.3},
}};
const unspecified = publicModelProjection(rawModel);
assert.deepEqual(imageAspectSupport(unspecified,smokeOptions,'1:1'), {aspectBasis:'ui-default-with-catalog-unspecified',advertisedAspectSupport:'unknown'});
assert.deepEqual(assertFreshImageModel(unspecified,structuredClone(unspecified),smokeOptions,'1K','1:1',0.3), imageAspectSupport(unspecified,smokeOptions,'1:1'));
assert.equal(selectPublicImageModel([unspecified],{...fixedOptions,aspectRatio:'1:1'}),null);
assert.throws(() => imageAspectSupport(unspecified,fixedOptions,'1:1'));
for (const patch of [
  {id:'pm_other'},{available:false},{priceReady:false},{publicPrice:0.4},
  {resolutionOptions:['2K']},{defaultResolution:'2K'},{resolutionPrices:{'1K':0.4}},
  {aspectRatios:['1:1']},
]) assert.throws(() => assertFreshImageModel(unspecified,{...unspecified,...patch},smokeOptions,'1K','1:1',0.3));
assert.throws(() => assertFreshImageModel(exactMatch,{...exactMatch,aspectRatios:['1:1']},fixedOptions,'1K','16:9',0.3));
for (const [width,height] of [[23,23],[23,17]]) {
  const bytes = await sharp({create:{width,height,channels:3,background:'#179eaa'}}).png().toBuffer();
  const decoded = await sharp(bytes).metadata();
  if (width === height) assert.equal(assertDecodedImageAspect(decoded,'1:1').width,23);
  else assert.throws(() => assertDecodedImageAspect(decoded,'1:1'),/HARNESS_DOWNLOADED_IMAGE_NOT_SQUARE/u);
}

// Execute the real fixed preflight and catch/finally with only external I/O replaced in RAM.
const runSource = source.slice(source.indexOf('async function runExecute(options)'),source.indexOf('\nexport async function main('));
assert.ok(runSource.startsWith('async function runExecute(options)'));
async function executeRamFixture({accountBoundary=false, freshFailure=false, continueFailure=false, missingAspect=false} = {}) {
  const userId='11111111-1111-4111-8111-111111111111';
  const options={...fixedOptions,origin:'http://127.0.0.1:5000',runId:'ram_fixed_fixture',prompt:exactPrompt,imageCount:1,
    paid:{actorRole:'student',userId,maxCharge:0.3,remainingBudget:1}};
  const events=[], writes=new Map();
  let catalogReads=0, continues=0, aborts=0, registered, rejectResponse, rejectClick, request, pagePrompt='';
  const catalogModel=structuredClone(rawModel);
  if (!missingAspect) catalogModel.capabilities.aspectRatios=['16:9'];
  const page=new EventEmitter();
  const locator={waitFor:async()=>{},isVisible:async()=>false,isEnabled:async()=>true,count:async()=>1,
    click:async()=>{},selectOption:async()=>{},inputValue:async()=>catalogModel.id};
  page.locator=()=>locator;
  page.getByLabel=name=>typeof name === 'string' ? {...locator,fill:async value=>{pagePrompt=value;},inputValue:async()=>pagePrompt} : locator;
  const route=()=>({request:()=>request,abort:async()=>{aborts++;},continue:async()=>{continues++;if(continueFailure)throw Error('UNTRUSTED_FORWARD_FAILURE');}});
  page.getByRole=(_role,{name})=>String(name).includes('生成图片') ? {...locator,click:()=>{
    const body={modelId:catalogModel.id,resolution:'1K',aspectRatio:'16:9',historySurface:'image-workbench',prompt:pagePrompt,
      clientTraceId:'original_trace_fixture',clientIdempotencyKey:'original_key_fixture'};
    request={method:()=> 'POST',url:()=>options.origin+'/api/image/generate',postData:()=>JSON.stringify(body),postDataJSON:()=>body};
    page.emit('request',request);
    queueMicrotask(()=>{ registered(route()); }); // Event dispatch deliberately ignores the handler promise.
    return new Promise((_resolve,reject)=>{rejectClick=reject;});
  }} : locator;
  page.goto=async()=>({ok:()=>true});page.screenshot=async()=>{};
  page.waitForResponse=()=>new Promise((_resolve,reject)=>{rejectResponse=reject;});
  const context={addInitScript:async()=>{},addCookies:async()=>{},route:async(_pattern,handler)=>{registered=handler;},newPage:async()=>page,
    close:async()=>{
      if(request) await registered(route()); // A second attempt stays blocked after asynchronous failure.
      rejectClick?.(Error('CLOSED_CLICK'));rejectResponse?.(Error('CLOSED_RESPONSE'));
      events.push('context-closed');
    }};
  const sandbox={assert,path,randomUUID,sha256:hash,pathnameOnly:value=>new URL(value).pathname,parseJson:(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}},
    process:{env:{R267_CUSTOMER_TOKEN:'RAM_ONLY_FIXTURE',LOCAL_NAV_READONLY_CUSTOMER:JSON.stringify({id:userId,role:'student'})}},
    fs:{access:async()=>{throw Error('ABSENT');},mkdir:async()=>{},writeFile:async(file,text)=>{writes.set(path.basename(file),JSON.parse(text));}},
    runtimeIdentity:async()=>{events.push('runtime');return {runningLatest:true,sourceVersion:'RFIXTURE',buildId:'fixture-build'};},
    readPaidDatabaseReadiness:async()=>{events.push('A173-readiness');return {ready:true};},
    getJson:async(_origin,pathname)=>{
      if(pathname==='/api/auth/me')return {user:{id:userId,role:'student'}};
      assert.equal(pathname,'/api/cover-models?surface=image-workbench','UNEXPECTED_HTTP_BOUNDARY');
      catalogReads++;
      const model=structuredClone(catalogModel);
      if(freshFailure && catalogReads>1)model.capabilities.available=false;
      return {models:[model]};
    },
    readAccountEvidence:async()=>{events.push('account');if(accountBoundary)throw Error('ACCOUNT_BOUNDARY');return {cash:10};},
    chromium:{launch:async()=>{events.push('browser');return {newContext:async()=>context,close:async()=>{events.push('browser-closed');}};}},
    assertPaidActor,assertPaidQuote,quotedModelPrice,publicModelProjection,selectPublicImageModel,modelSupportsRequestedImageParameters,
    imageAspectSupport,assertFreshImageModel,makeWorkbenchPaidPostHandler,makeImagePaidRouteBoundary,awaitImageGenerationResponse,captureImageRequest,
    safeHarnessEvidence,safeHarnessErrorCode,redactText:()=> '[REDACTED]',
  };
  const execute=runInNewContext(runSource+'\nrunExecute;',sandbox);
  let failure;
  try { await execute(options); } catch(error) { failure=error; }
  await new Promise(resolve=>setImmediate(resolve)); // Late losing click/response rejections must already be handled.
  assert.ok(failure,'FIXTURE_MUST_STOP');
  return {failure,events,report:writes.get('report.json'),continues,aborts};
}
const fixedPreflight=await executeRamFixture({accountBoundary:true});
assert.deepEqual(fixedPreflight.events,['runtime','A173-readiness','account']);
assert.equal(fixedPreflight.failure.message,'ACCOUNT_BOUNDARY');
assert.equal(fixedPreflight.report.databaseReadiness.ready,true);
assert.equal(fixedPreflight.report.providerEvidence.ready,undefined,'DB_READINESS_IS_NOT_PROVIDER_COMPLETION');
const missingFixed=await executeRamFixture({missingAspect:true});
assert.ok(!missingFixed.events.includes('account') && !missingFixed.events.includes('browser'));
for (const options of [{freshFailure:true},{continueFailure:true}]) {
  const stopped=await executeRamFixture(options);
  assert.equal(stopped.failure.message,'IMAGE_ROUTE_HANDLER_FAILED');
  assert.equal(stopped.report.status,'failed-stopped-no-retry');
  assert.equal(stopped.report.cleanup.contextClosed,true);
  assert.equal(stopped.report.cleanup.browserClosed,true);
  assert.equal(stopped.report.request.clientTraceId,'original_trace_fixture');
  assert.equal(stopped.report.request.clientIdempotencyKey,'original_key_fixture');
  assert.equal(stopped.report.request.promptSha256,hash(exactPrompt));
  assert.equal(stopped.report.diagnostics.generationPostAttempts,2);
  assert.equal(stopped.report.diagnostics.duplicateGenerationPostsBlocked,1);
  assert.equal(stopped.report.diagnostics.generationPostsContinued,0);
  assert.equal(stopped.report.forwarding.providerDispatchCount,'unknown');
  assert.equal(stopped.report.forwarding.state,options.freshFailure?'not-forwarded':'unknown');
  assert.equal(stopped.report.routeFailure.stage,options.freshFailure?'before-guarded':'continue');
  assert.equal(stopped.continues,options.freshFailure?0:1);
  assert.ok(stopped.aborts>=2);
  assert.ok(!JSON.stringify(stopped.report).includes(exactPrompt));
}

const providerReport=()=>({generation:{providerProtocol:'fixture-protocol'},providerEvidence:{enforced:true},databaseReadiness:{ready:true}});
assert.throws(()=>assertProviderImageEvidence({state:'completed'},providerReport(),exactPrompt,'16:9','1K',1),/IMAGE_PROVIDER_EVIDENCE_READBACK_REQUIRED/u);
const provider={ready:true,actualPayloadSha256:'a'.repeat(64),dispatchReceiptId:'dispatch_fixture',submissionReceiptId:'submission_fixture',
  dispatchReceiptSha256:'b'.repeat(64),submissionReceiptSha256:'c'.repeat(64),transportState:'response_received',providerProtocol:'fixture-protocol',
  actualPayloadBytes:1200,responseStatus:200,responseBodySha256:'d'.repeat(64),requestProjection:{userPromptSha256:hash(exactPrompt),aspectRatio:'16:9',resolution:'1K',imageCount:1}};
const matched=providerReport();
assertProviderImageEvidence({providerEvidence:provider},matched,exactPrompt,'16:9','1K',1);
assert.equal(matched.providerEvidence.readback.actualPayloadSha256,provider.actualPayloadSha256);
for(const patch of [{userPromptSha256:'e'.repeat(64)},{aspectRatio:'1:1'},{resolution:'2K'},{imageCount:2}]) {
  assert.throws(()=>assertProviderImageEvidence({providerEvidence:{...provider,requestProjection:{...provider.requestProjection,...patch}}},providerReport(),exactPrompt,'16:9','1K',1));
}

const partial = spawnSync(process.execPath, [verifierPath, "--run-id=partial_fixed", `--prompt=${exactPrompt}`], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});
assert.notEqual(partial.status, 0, "PARTIAL_FIXED_INPUTS_MUST_FAIL_CLOSED");
assert.equal(JSON.parse(partial.stderr).errorCode, "HARNESS_FAILURE_STOPPED");
assert.throws(() => parseArgs(["--run-id=partial_fixed", `--prompt=${exactPrompt}`]), /FIXED_PROMPT_REQUIRES_PROMPT_RESOLUTION_ASPECT_RATIO_AND_IMAGE_COUNT/u);

console.log(JSON.stringify({
  passed: true,
  mode: "zero-network-fixed-image-prompt-contract",
  networkCalls: 0,
  databaseCalls: 0,
  filesystemWrites: 0,
  assertions: {
    defaultSmokeBehaviorPreserved: true,
    fixedInputsExplicitAndExact: true,
    dynamicCapabilitySelection: true,
    actualFixedPreflightReachesAccountAfterA173Readiness: true,
    databaseReadinessDoesNotGrantProviderCompletion: true,
    actualProviderEvidenceRequiresMatchingReadback: true,
    asynchronousRouteFailureWritesReportWithoutUnhandledRejection: true,
    uncertainForwardingIsNotProviderZero: true,
    unspecifiedCatalogSmokeDefaultDoesNotGrantFixedSupport: true,
    catalogProjectionAndPriceRemainLocked: true,
    decodedSquareBytesRequired: true,
    browserGenerationPostLimit: 1,
    automaticRetries: 0,
  },
}, null, 2));
