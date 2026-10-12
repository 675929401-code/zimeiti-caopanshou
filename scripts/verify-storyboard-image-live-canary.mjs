#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { waitForImageDecoded, makeWorkbenchPaidPostHandler, safeHarnessErrorCode, readPaidDatabaseReadiness, parsePaidHarnessArgs, assertPaidActor, assertPaidQuote, projectImageDelivery, assertImageReceiptBinding, makePaidPostGuard, safeHarnessEvidence, capturePaidDownload, installPaidAuthCookie, writePaidTerminalReadback, runtimeIdentity, runPaidHarnessSelfTest, publicModelProjection, quotedModelPrice, assertPaidFinalPass } from "./verify-image-workbench-live-e2e.mjs";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
let token = "";

export function makeMediaPaidRouteBoundary(handler, report) {
  let resolveFailure;
  const failure = new Promise(resolve => { resolveFailure = resolve; });
  return { failure, handler:async route => {
    try {
      const request = route.request();
      if (request.method() === 'POST' && !report.request) {
        const body = request.postDataJSON();
        const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(value) ? value : null;
        report.request = {
          clientRequestId:safeId(body?.client_request_id || body?.clientIdempotencyKey),
          clientIdempotencyKey:safeId(body?.clientIdempotencyKey),
          clientTraceId:safeId(body?.clientTraceId || body?.client_trace_id),
          idempotencyKey:safeId(request.headers()['idempotency-key']),
        };
        report.forwarding = { stage:'captured-before-guard', state:'not-forwarded', providerDispatchCount:'unknown' };
      }
      await handler({
        request:() => route.request(),
        abort:(...args) => route.abort(...args),
        continue:async (...args) => {
          report.forwarding = { stage:'continue', state:'unknown', providerDispatchCount:'unknown' };
          await route.continue(...args);
          report.forwarding = { stage:'after-continue', state:'forwarded', providerDispatchCount:'unknown' };
        },
      });
    } catch {
      if (!report.routeFailure) {
        report.routeFailure = { errorCode:'MEDIA_ROUTE_HANDLER_FAILED', stage:report.forwarding?.stage || 'before-capture', forwardingState:report.forwarding?.state || 'unknown' };
        resolveFailure(report.routeFailure);
      }
    }
  } };
}

export function observeMediaPromise(promise) {
  promise.catch(() => undefined);
  return promise;
}

export async function awaitMediaGenerationResponse({page, click, failure, pathname, timeoutMs, capture, captureTimeoutMs}) {
  const response = observeMediaPromise(page.waitForResponse(candidate => candidate.request().method() === 'POST'
    && new URL(candidate.url()).pathname === pathname, { timeout:timeoutMs }));
  const stopped = observeMediaPromise(failure.then(() => { throw new Error('MEDIA_ROUTE_HANDLER_FAILED'); }));
  if (capture) observeMediaPromise(capture);
  let captureTimer;
  const captured = capture && captureTimeoutMs ? Promise.race([capture,new Promise((_,reject) => {
    captureTimer=setTimeout(()=>reject(new Error('VIDEO_UI_GENERATION_REQUEST_NOT_CAPTURED')),captureTimeoutMs);
  })]) : capture;
  const clicking = observeMediaPromise(Promise.resolve().then(click));
  const completed = observeMediaPromise(Promise.all([response, clicking, ...(captured ? [captured] : [])]));
  try {
    const [received, , request] = await Promise.race([completed, stopped]);
    return capture ? { response:received, capture:request } : received;
  } finally { clearTimeout(captureTimer); }
}

export async function runMediaAsyncBoundarySelfTest(pathname) {
  let checks = 0;
  const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
  const nextEvent = () => new Promise(resolve => setImmediate(resolve));
  const fixture = (checkFresh, continuation = async () => undefined) => {
    const diagnostics = {generationPostAttempts:0,generationPostsContinued:0,duplicateGenerationPostsBlocked:0};
    const report = {};
    let forwards = 0, aborts = 0;
    const request = {method:()=>'POST',postDataJSON:()=>({modelId:'pm_fixture',client_request_id:'original-key',clientIdempotencyKey:'original-key',clientTraceId:'original-trace',prompt:'PRIVATE_FIXTURE',image_url:'https://private.invalid/secret'}),headers:()=>({'idempotency-key':'original-key'})};
    const route = {request:()=>request,continue:async()=>{forwards++;await continuation();},abort:async()=>{aborts++;}};
    const boundary = makeMediaPaidRouteBoundary(makeWorkbenchPaidPostHandler({diagnostics,isArmed:()=>true,expected:{modelId:'pm_fixture'},checkFresh}),report);
    const events = new EventEmitter(), tasks = [];
    events.on('submit', () => tasks.push(boundary.handler(route)));
    return {diagnostics,report,boundary,events,tasks,get forwards(){return forwards;},get aborts(){return aborts;}};
  };
  const fresh = deferred(), response = deferred(), click = deferred();
  const failed = fixture(async()=>{await fresh.promise;throw new Error('PRIVATE_FRESH_FAILURE');});
  let listening = false;
  const waiting = awaitMediaGenerationResponse({page:{waitForResponse:()=>{listening=true;return response.promise;}},
    click:()=>{assert.equal(listening,true);failed.events.emit('submit');return click.promise;},failure:failed.boundary.failure,pathname,timeoutMs:100});
  const rejected = assert.rejects(waiting,/MEDIA_ROUTE_HANDLER_FAILED/u);
  await nextEvent();
  assert.equal(failed.report.request.clientRequestId,'original-key');checks++;
  assert.equal(failed.report.request.clientTraceId,'original-trace');checks++;
  assert.equal(JSON.stringify(failed.report).includes('PRIVATE_FIXTURE'),false);checks++;
  assert.equal(JSON.stringify(failed.report).includes('private.invalid'),false);checks++;
  failed.events.emit('submit');
  fresh.resolve();
  await rejected;
  click.reject(new Error('DELAYED_CLICK_REJECTION'));
  response.reject(new Error('LOSING_RESPONSE_REJECTION'));
  await Promise.all(failed.tasks);
  await nextEvent();
  assert.equal(failed.forwards,0);checks++;
  assert.equal(failed.diagnostics.duplicateGenerationPostsBlocked,1);checks++;
  assert.equal(failed.report.routeFailure.forwardingState,'not-forwarded');checks++;
  const originalFailure = failed.report.routeFailure;
  failed.events.emit('submit');await Promise.all(failed.tasks);
  assert.equal(failed.report.routeFailure,originalFailure);checks++;

  const unknown = fixture(async()=>undefined,async()=>{throw new Error('CONTINUE_RESULT_UNKNOWN');});
  unknown.events.emit('submit');await Promise.all(unknown.tasks);
  assert.equal((await unknown.boundary.failure).forwardingState,'unknown');checks++;
  assert.equal(unknown.diagnostics.generationPostsContinued,0);checks++;
  assert.equal(unknown.report.forwarding.providerDispatchCount,'unknown');checks++;
  unknown.events.emit('submit');await Promise.all(unknown.tasks);
  assert.equal(unknown.forwards,1);checks++;
  assert.equal(unknown.diagnostics.duplicateGenerationPostsBlocked,1);checks++;

  const delayedResponse = deferred();
  const clickFailure = awaitMediaGenerationResponse({page:{waitForResponse:()=>delayedResponse.promise},click:async()=>{await nextEvent();throw new Error('CLICK_FAILED');},failure:new Promise(()=>{}),pathname,timeoutMs:100});
  await assert.rejects(clickFailure,/CLICK_FAILED/u);checks++;
  delayedResponse.reject(new Error('AFTER_CLICK_RESPONSE_REJECTION'));await nextEvent();

  const captured = deferred(), capturedResponse = deferred(), capturedClick = deferred();
  observeMediaPromise(captured.promise);
  const captureFailure = awaitMediaGenerationResponse({page:{waitForResponse:()=>capturedResponse.promise},click:()=>capturedClick.promise,failure:new Promise(()=>{}),pathname,timeoutMs:100,capture:captured.promise});
  const captureRejected = assert.rejects(captureFailure,/CAPTURE_FAILED/u);
  captured.reject(new Error('CAPTURE_FAILED'));await captureRejected;checks++;
  capturedResponse.reject(new Error('LOSING_CAPTURE_RESPONSE'));capturedClick.reject(new Error('LOSING_CAPTURE_CLICK'));await nextEvent();
  const earlyCapture = observeMediaPromise(Promise.reject(new Error('EARLY_CAPTURE_FAILURE')));
  await nextEvent();
  await assert.rejects(awaitMediaGenerationResponse({page:{waitForResponse:async()=>({status:200})},click:async()=>undefined,
    failure:new Promise(()=>{}),pathname,timeoutMs:100,capture:earlyCapture}),/EARLY_CAPTURE_FAILURE/u);checks++;
  const success = await awaitMediaGenerationResponse({page:{waitForResponse:async()=>({status:200})},click:async()=>undefined,
    failure:new Promise(()=>{}),pathname,timeoutMs:100,capture:Promise.resolve({clientRequestId:'original-key'}),captureTimeoutMs:100});
  assert.equal(success.response.status,200);checks++;
  assert.equal(success.capture.clientRequestId,'original-key');checks++;
  return {checks,networkCalls:0};
}

async function authenticatedJson(pathname, timeoutMs = 30_000) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, body?.error || `${pathname} failed with ${response.status}`);
  return body;
}

async function billingSnapshot(userId) {
  const [balance, transactions, credits] = await Promise.all([
    authenticatedJson("/api/cash/balance"),
    authenticatedJson("/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50"),
    authenticatedJson(`/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`),
  ]);
  const cashRows = (transactions?.data?.transactions || []).filter((row) => row?.category === "cash");
  return {
    balance: Number(balance.balance), credits:Number(credits.credits), reservedCredits:Number(credits.reservedCredits),
    cashRows,
    cashIds: new Set(cashRows.map((row) => String(row.id))),
  };
}

export function parseStoryboardImageArgs(args) {
  const paid=parsePaidHarnessArgs(args,['run-id','model-id','model-contains','resolution','expect-failure-code','execute','self-test']);
  assert.ok(['1K','2K','4K'].includes((paid.values.resolution || '1K').toUpperCase()),'STORYBOARD_IMAGE_RESOLUTION_INVALID');
  if(paid.values['model-id']) assert.match(paid.values['model-id'],/^pm_[A-Za-z0-9_-]+$/u,'PUBLIC_IMAGE_MODEL_REQUIRED');
  if(paid.flags.has('execute')) assert.ok(paid.values['model-id'],'EXACT_PUBLIC_IMAGE_MODEL_REQUIRED');
  return paid;
}

export async function runStoryboardImageSelfTest() {
  const result=await runPaidHarnessSelfTest();let checks=result.checks;
  assert.equal(parseStoryboardImageArgs([]).actorRole,'student');checks++;
  for(const args of [['--resolution=8K'],['--model-id=internal'],['--resolution=1K','--resolution=2K']]) {assert.throws(()=>parseStoryboardImageArgs(args));checks++;}
  const projected=publicModelProjection({id:'pm_fixture',publicPrice:.1,capabilities:{resolutionPrices:{'1K':.1,'2K':.2}}});
  assert.equal(quotedModelPrice(projected,'2K'),.2);checks++;
  checks += (await runMediaAsyncBoundarySelfTest('/api/image/generate')).checks;
  console.log(JSON.stringify({kind:'storyboard-image-actual-parser-selftest',status:'PASS',checks,networkCalls:0,dbCalls:0,browserRuns:0,paidPosts:0}));
}

export async function main(args = process.argv.slice(2)) {
  const paid=parseStoryboardImageArgs(args);
  if (paid.flags.has("self-test")) return runStoryboardImageSelfTest();
  const runId = args.find((value) => value.startsWith("--run-id="))?.slice(9) || "";
  const modelContains = args.find((value) => value.startsWith("--model-contains="))
    ?.slice("--model-contains=".length).trim() || "Nano Banana Pro";
  const requestedResolution = args.find((value) => value.startsWith("--resolution="))
    ?.slice("--resolution=".length).trim().toUpperCase() || "1K";
  const expectedFailureCode = args.find((value) => value.startsWith("--expect-failure-code="))
    ?.slice("--expect-failure-code=".length).trim() || "";
  const execute = args.includes("--execute");
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.match(runId, /^[a-zA-Z0-9_-]{8,100}$/u, "UNIQUE_RUN_ID_REQUIRED");


  const outputDir = path.resolve(".codex-evidence/storyboard-image-platform-fix-20260920", runId);
  if (!execute) {
    console.log(JSON.stringify({ mode: "plan", providerPostLimit: 1, counterScope:"browser-generation-POST",providerDispatchCount:"unknown", outputDir }));
    return;
  }

  token=String((paid.actorRole==='admin'?process.env.LOCAL_NAV_ADMIN_TOKEN:process.env.R267_CUSTOMER_TOKEN)||'').trim();
  assert.ok(token,'CONTROLLED_EXISTING_SESSION_REQUIRED');
  await fs.mkdir(outputDir,{recursive:true});
  const pins={origin,expectedSourceVersion:paid.values['expected-source-version'],expectedBuildId:paid.values['expected-build-id']};
  const runtimeBefore=await runtimeIdentity(pins);
  const databaseReadiness=await readPaidDatabaseReadiness(paid,runtimeBefore);
  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const identity = await identityResponse.json();
  assert.equal(identityResponse.status, 200, identity?.error || "ADMIN_IDENTITY_FAILED");
  const actor=assertPaidActor(identity,paid);

  const catalogResponse = await fetch(`${origin}/api/cover-models?surface=storyboard-workbench`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200, catalog?.error || "STORYBOARD_IMAGE_CATALOG_FAILED");
  const selected = catalog.models?.find((model) => (paid.values["model-id"] ? model.id===paid.values["model-id"] : String(model.displayName || model.name || "").includes(modelContains))
    && model.capabilities?.available !== false
    && model.capabilities?.priceReady !== false);
  assert.ok(selected?.id, `REQUESTED_IMAGE_MODEL_NOT_AVAILABLE:${modelContains}`);
  assert.ok(
    (selected.capabilities?.resolutionOptions || []).map((value) => String(value).toUpperCase()).includes(requestedResolution),
    `REQUESTED_IMAGE_RESOLUTION_NOT_AVAILABLE:${requestedResolution}`,
  );

  const lockedQuote=assertPaidQuote(quotedModelPrice(publicModelProjection(selected),requestedResolution),paid);
  const billingBefore = await billingSnapshot(identity.user.id);
  assert.ok(Number.isFinite(billingBefore.balance), "BILLING_BALANCE_BEFORE_INVALID");

  const marker = `SBW_IMAGE_FIX_${runId}_${randomUUID()}`;
  const markerPath = path.join(outputDir, "dispatch.json");
  await fs.writeFile(markerPath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    runId,
    marker,
    selectedModelId: selected.id,
    selectedModel: selected.displayName,
    requestedResolution,
    expectedFailureCode: expectedFailureCode || null,
    balanceBefore: billingBefore.balance,
    providerPostLimit: 1, counterScope:"browser-generation-POST",providerDispatchCount:"unknown",
  }, null, 2)}\n`, { flag: "wx" });

  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  const pageErrors = [];
  let generationPosts = 0;
  let requestBody = null;
  let responseBody = null;
  let deliveryReceipt = null;
  const routeEvidence = {};
  const admission={generationPostAttempts:0,generationPostsContinued:0,duplicateGenerationPostsBlocked:0};
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      serviceWorkers: "block",
    });
    await installPaidAuthCookie(context, origin, token);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });

    const prompt = `一只可爱的金毛幼犬在明亮整洁的木地板客厅里轻轻跳舞，商业级3D动画质感，完整身体，暖色自然光，16:9横构图，无文字，无水印。内部验收标记 ${marker}，标记仅用于请求核对，不得出现在画面中。`;
    let clickArmed=false;
    const installed=makeWorkbenchPaidPostHandler({diagnostics:admission,isArmed:()=>clickArmed,
      expected:{modelId:selected.id,resolution:requestedResolution,aspectRatio:'16:9',historySurface:'storyboard-workbench',prompt},
      checkFresh:async()=>{
        const current=await authenticatedJson('/api/cover-models?surface=storyboard-workbench');
        const model=current.models?.find(item=>item.id===selected.id);
        const projected=publicModelProjection(model);
        assert.ok(projected.available && projected.priceReady && projected.resolutionOptions.includes(requestedResolution) && projected.aspectRatios.includes('16:9'),'STORYBOARD_IMAGE_CATALOG_DRIFT');
        assert.equal(quotedModelPrice(projected,requestedResolution),lockedQuote,'STORYBOARD_IMAGE_PRICE_DRIFT');
      }});
    const routeBoundary=makeMediaPaidRouteBoundary(installed,routeEvidence);
    await context.route('**/api/image/generate',routeBoundary.handler);
    let savedProjectId;
    const page = await context.newPage();
    page.on('response',async response=>{
      if(response.request().method()==='POST' && new URL(response.url()).pathname==='/api/storyboard/projects' && response.ok()) {
        const result=await response.json().catch(()=>null); if(result?.project?.id) savedProjectId=result.project.id;
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 400)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 400));
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/image/generate") {
        generationPosts += 1;
        requestBody = request.postDataJSON();
      }
    });

    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The visible/accessible label may include a channel variant. Bind the
    // canary to the stable public model ID used by the request contract.
    const modelButton = page.locator(`.sbw-image-model-list button[data-model-id="${selected.id}"]`).first();
    await modelButton.waitFor({ state: "visible", timeout: 45_000 });
    await modelButton.click();

    const removeButtons = page.getByTitle("删除镜头", { exact: true });
    while (await removeButtons.count() > 1) await removeButtons.last().click();

    const imageControls = page.locator(".sbw-control-group.is-image");
    await imageControls.getByRole("button", { name: "16:9", exact: true }).click();
    const resolutionSelect = imageControls.getByRole("combobox", { name: "图片分辨率" });
    if (await resolutionSelect.count()) {
      const options = await resolutionSelect.locator("option").allTextContents();
      assert.ok(options.some((value) => value.trim().toUpperCase() === requestedResolution),
        `IMAGE_RESOLUTION_OPTION_MISSING:${requestedResolution}`);
      await resolutionSelect.selectOption({ label: requestedResolution });
    }

    const card = page.locator("article.sbw-shot-card").first();
    await card.getByRole("textbox", { name: "镜头1生图提示词" }).fill(prompt);
    const generateButton = card.getByRole("button", { name: "生成图片", exact: true });
    await generateButton.waitFor({ state: "visible" });
    assert.equal(await generateButton.isEnabled(), true, "STORYBOARD_IMAGE_BUTTON_DISABLED");

    clickArmed=true;
    const generationResponse = await awaitMediaGenerationResponse({page,click:()=>generateButton.click(),failure:routeBoundary.failure,pathname:'/api/image/generate',timeoutMs:360_000});
    responseBody = await generationResponse.json().catch(() => null);
    if (expectedFailureCode) {
      assert.ok(generationResponse.status() >= 400, "EXPECTED_IMAGE_FAILURE_DID_NOT_OCCUR");
      assert.equal(responseBody?.code, expectedFailureCode, responseBody?.error || "IMAGE_FAILURE_CODE_MISMATCH");
      assert.equal(generationPosts, 1, "STORYBOARD_IMAGE_POST_COUNT_INVALID");
      const billingAfterFailure = await billingSnapshot(identity.user.id);
      const failureBalanceDelta = Number((billingBefore.balance - billingAfterFailure.balance).toFixed(6));
      const failureCashRows = billingAfterFailure.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
      assert.equal(failureBalanceDelta, 0, "FAILED_IMAGE_REQUEST_CHANGED_BALANCE");
      assert.equal(failureCashRows.length, 0, "FAILED_IMAGE_REQUEST_CREATED_CASH_TRANSACTION");
      await page.screenshot({ path: path.join(outputDir, "storyboard-image-expected-failure.png"), fullPage: true });
      const failureReport = {
        runId,
        checkedAt: new Date().toISOString(),
        sourceVersion: await page.evaluate(async () => (await fetch("/api/version")).json()).then((value) => value.sourceVersion),
        selectedModel: selected.displayName,
        selectedModelId: selected.id,
        requestedResolution,
        generationPosts,
        expectedFailure: {
          httpStatus: generationResponse.status(),
          code: responseBody.code,
          error: responseBody.error,
          balanceDelta: failureBalanceDelta,
          newTransactionCount: failureCashRows.length,
        },
        consoleErrors,
        pageErrors,
        tokenPersisted: false,
      };
      await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(safeHarnessEvidence(failureReport), null, 2)}\n`);
      console.log(JSON.stringify({
        success: true,
        expectedFailure: true,
        runId,
        code: responseBody.code,
        generationPosts,
        cashCharged: 0,
        report: path.join(outputDir, "report.json"),
      }));
      return;
    }
    assert.equal(generationResponse.status(), 200, responseBody?.error || "STORYBOARD_IMAGE_GENERATION_FAILED");
    assert.equal(responseBody?.success, true, "STORYBOARD_IMAGE_RESPONSE_NOT_SUCCESS");
    assert.equal(generationPosts, 1, "STORYBOARD_IMAGE_POST_COUNT_INVALID");
    assert.equal(requestBody?.historySurface, "storyboard-workbench");
    assert.equal(requestBody?.modelId, selected.id);
    const receipt=projectImageDelivery(responseBody);
    deliveryReceipt=receipt;
    assert.equal(receipt.cashCharged,lockedQuote,"STORYBOARD_IMAGE_QUOTE_DRIFT");

    const generatedImage = card.getByRole("img", { name: "任务1故事板" });
    const rendered = await waitForImageDecoded(generatedImage,{timeout:60_000});
    assert.ok(rendered.complete && rendered.width > 0 && rendered.height > 0, "STORYBOARD_IMAGE_NOT_RENDERED");
    await card.getByText("图片完成", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });

    const statusQuery = new URLSearchParams({
      clientIdempotencyKey: requestBody.clientIdempotencyKey,
      clientTraceId: requestBody.clientTraceId,
    });
    const statusResponse = await context.request.get(`${origin}/api/image/status?${statusQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status = await statusResponse.json();
    assert.equal(statusResponse.status(), 200, status?.error || "STORYBOARD_IMAGE_STATUS_FAILED");
    assert.equal(status?.state, "completed", "STORYBOARD_IMAGE_NOT_TERMINAL");
    if(receipt.deliveryMode==="legacy_owned") assert.equal(status?.assetId,receipt.assetId,"STORYBOARD_IMAGE_STATUS_ASSET_MISMATCH");
    else assertImageReceiptBinding(receipt,status);

    const expectedCharge = Number(responseBody.cashCharged);
    assert.ok(Number.isFinite(expectedCharge) && expectedCharge > 0, "ADMIN_GENERATION_MUST_USE_NORMAL_BILLING");
    let billingAfter = await billingSnapshot(identity.user.id);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const newCashRows = billingAfter.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
      if (newCashRows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      billingAfter = await billingSnapshot(identity.user.id);
    }
    const balanceDelta = Number((billingBefore.balance - billingAfter.balance).toFixed(6));
    assert.equal(billingAfter.credits,billingBefore.credits,"UNEXPECTED_CREDIT_CHARGE");
    assert.equal(billingAfter.reservedCredits,billingBefore.reservedCredits,"UNRELEASED_CREDIT_RESERVATION");
    assert.ok(Math.abs(balanceDelta - expectedCharge) <= 0.000001,
      `BILLING_BALANCE_DELTA_MISMATCH:${balanceDelta}:${expectedCharge}`);
    const newCashRows = billingAfter.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
    assert.equal(newCashRows.length, 1, `BILLING_TRANSACTION_COUNT_MISMATCH:${newCashRows.length}`);
    assert.match(String(newCashRows[0].referenceId || ""), /^image:/u, "IMAGE_BILLING_REFERENCE_MISSING");
    if(receipt.deliveryMode!=="legacy_owned") assert.equal(newCashRows[0].referenceId,receipt.billingReferenceId,"IMAGE_ORIGINAL_CASH_REFERENCE_MISMATCH");
    assert.ok(Math.abs(Math.abs(Number(newCashRows[0].amount)) - expectedCharge) <= 0.000001,
      "IMAGE_BILLING_TRANSACTION_AMOUNT_MISMATCH");

    assertPaidFinalPass({actor:identity.user,expectedRole:paid.actorRole,completed:true,cashDelta:balanceDelta,quote:lockedQuote,newCashRows:newCashRows.length,generationPosts});
    let savedProject, savedCard;
    for(let i=0;i<30;i++) {
      if(savedProjectId) {savedProject=await authenticatedJson(`/api/storyboard/projects?id=${encodeURIComponent(savedProjectId)}`);savedCard=savedProject.project?.document?.cards?.find(item=>receipt.recordId ? item.imageRecordId===receipt.recordId : item.imageAssetId===receipt.assetId);}
      if(savedCard?.imageStatus==='done') break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.ok(savedCard?.imageStatus==='done','STORYBOARD_COMPLETED_PROJECT_RECEIPT_MISSING');
    const reusableSource={projectId:savedProjectId,cardId:savedCard.id,recordId:receipt.recordId,deliveryMode:receipt.deliveryMode,imageRef:savedCard.imageRef || null};
    await writePaidTerminalReadback(outputDir, {runId,terminalStatus:status.state,actor,generationPosts,admission,
      modelId:selected.id,deliveryReceipt:receipt,reusableSource,runtimeBefore,
      billing:{balanceBefore:billingBefore.balance,balanceAfter:billingAfter.balance,balanceDelta,
        newTransactionCount:newCashRows.length,referenceId:newCashRows[0].referenceId,amount:Number(newCashRows[0].amount)}});
    const download=await capturePaidDownload(page,card.getByTitle('下载故事板',{exact:true}),outputDir);
    const metadata={width:rendered.width,height:rendered.height};
    let runtimeAfter;
    if(receipt.deliveryMode==='inline_ephemeral') {
      await page.reload({waitUntil:'domcontentloaded'});
      assert.equal(generationPosts,1,'INLINE_RELOAD_REPOST');
      const afterReload=await authenticatedJson(`/api/image/status?${statusQuery}`);
      assertImageReceiptBinding(receipt,afterReload);
      const reloadedProject=await authenticatedJson(`/api/storyboard/projects?id=${encodeURIComponent(savedProjectId)}`);
      const reloadedCard=reloadedProject.project?.document?.cards?.find(item=>item.id===savedCard.id);
      assert.equal(reloadedCard?.imageStatus,'done','INLINE_REFRESH_NOT_COMPLETED');
      assert.equal(reloadedCard?.imagePriceCharged,receipt.cashCharged,'INLINE_REFRESH_LOST_FEE');
      assert.ok(!reloadedCard?.imageUrl && !reloadedCard?.imageRef,'INLINE_REFRESH_PERSISTED_MEDIA');
    }
    await page.screenshot({ path: path.join(outputDir, "storyboard-image-success.png"), fullPage: true });
    runtimeAfter=await runtimeIdentity(pins);
    assert.deepEqual(runtimeAfter,runtimeBefore,"RUNTIME_CHANGED_DURING_CANARY");
    const report = {
      runId,
      checkedAt: new Date().toISOString(),
      sourceVersion: await page.evaluate(async () => (await fetch("/api/version")).json()).then((value) => value.sourceVersion),
      selectedModel: selected.displayName,
      selectedModelId: selected.id,
      requestedResolution,
      generationPosts,
      request: {
        ...routeEvidence.request,
        historySurface: requestBody.historySurface,
        aspectRatio: requestBody.aspectRatio,
        resolution: requestBody.resolution,
        traceId: requestBody.clientTraceId,
      },
      response: {
        success: responseBody.success,
        status: responseBody.status,
        modelIdUsed: responseBody.modelIdUsed,
        assetId: receipt.assetId,
        cashCharged: responseBody.cashCharged,
        idempotencyReplayed: responseBody.idempotencyReplayed,
      },
      terminalStatus: status.state,
      billing: {
        balanceBefore: billingBefore.balance,
        balanceAfter: billingAfter.balance,
        balanceDelta,
        newTransactionCount: newCashRows.length,
        referenceId: newCashRows[0].referenceId,
        amount: Number(newCashRows[0].amount),
      },
      actor, admission, forwarding:routeEvidence.forwarding, databaseReadiness, runtimeBefore, runtimeAfter, deliveryReceipt:receipt, reusableSource, rendered, download,
      asset: { width:metadata.width,height:metadata.height },
      consoleErrors,
      pageErrors,
      tokenPersisted: false,
    };
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(safeHarnessEvidence(report), null, 2)}\n`);
    console.log(JSON.stringify({
      success: true,
      runId,
      generationPosts,
      terminalStatus: status.state,
      assetId: receipt.assetId,
      cashCharged: responseBody.cashCharged,
      report: path.join(outputDir, "report.json"),
    }));
  } catch (error) {
    const failure={success:false,errorCode:safeHarnessErrorCode(error),runId,failedAt:new Date().toISOString(),
      automaticRetries:0,budgetDisposition:'full allocation occupied until original terminal readback',
      allocatedBudget:paid.maxCharge,lockedQuote,generationPosts,counterScope:'browser-generation-POST',providerDispatchCount:'unknown',
      actor,admission,...routeEvidence,deliveryReceipt,databaseReadiness,runtimeBefore};
    await fs.writeFile(path.join(outputDir,'failure.json'),`${JSON.stringify(safeHarnessEvidence(failure),null,2)}\n`,{flag:'wx'}).catch(()=>undefined);
    throw error;
  } finally {
    await browser.close().catch(()=>undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error=>{console.error(JSON.stringify({success:false,errorCode:safeHarnessErrorCode(error),automaticRetries:0}));process.exitCode=1;});
}
