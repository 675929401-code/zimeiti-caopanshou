#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from 'node:url';
import { chromium } from "playwright";
import { makeWorkbenchPaidPostHandler, safeHarnessErrorCode, readPaidDatabaseReadiness, parsePaidHarnessArgs, assertPaidActor, publicVideoQuote, makePaidPostGuard, safeHarnessEvidence, runtimeIdentity, runPaidHarnessSelfTest, capturePaidDownload, installPaidAuthCookie, writePaidTerminalReadback, assertPaidFinalPass } from "./verify-image-workbench-live-e2e.mjs";
import { makeMediaPaidRouteBoundary, awaitMediaGenerationResponse, runMediaAsyncBoundarySelfTest } from './verify-storyboard-image-live-canary.mjs';

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
let token = "";
const DEFAULT_SOURCE_PROJECT_ID = "storyboard-run-mu98sb0e-1kav9y";
const DEFAULT_SOURCE_IMAGE_ASSET_ID = "6a733f04-08e1-4ea8-80f0-b171d52b94c7";
const DEFAULT_VIDEO_MODEL_ID = "pm_UDGvX0Ba6ijpTEZUitj0-C8l";

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
}

export function parseStoryboardVideoArgs(args) {
  const paid=parsePaidHarnessArgs(args,['run-id','model-id','source-project-id','source-card-id','source-image-record-id','source-image-asset-id','duration','resolution','completion-timeout-ms','execute','health-only','self-test']);
  assert.ok(!(paid.values['source-image-record-id'] && paid.values['source-image-asset-id']),'STORYBOARD_SOURCE_REFERENCE_CONFLICT');
  if(paid.values['source-image-record-id']) assert.match(paid.values['source-image-record-id'],/^[a-f0-9]{64}$/u,'STORYBOARD_SOURCE_RECORD_INVALID');
  const duration=Number(paid.values.duration || 4);
  assert.ok(Number.isInteger(duration) && duration>0 && duration<=60,'STORYBOARD_DURATION_INVALID');
  if(paid.flags.has('execute')) for(const key of ['source-project-id','source-card-id','model-id','duration','resolution']) assert.ok(paid.values[key],'STORYBOARD_EXACT_SOURCE_PARAMS_REQUIRED');
  return paid;
}

export function assertStoryboardSourceCard(card, recordId) {
  assert.ok(card,'EXACT_OWNED_SOURCE_CARD_REQUIRED');
  assert.equal(card.imageRef?.schema,'generated_image_ref.v1','SOURCE_REFERENCE_SCHEMA');
  assert.equal(card.imageRef?.recordId,recordId,'SOURCE_CARD_RECORD_MISMATCH');
  assert.equal(card.imageDeliveryMode,'provider_url','ASYNC_INLINE_INPUT_FORBIDDEN');
  assert.ok(card.imageClientRequestId && card.imageClientTraceId,'SOURCE_REQUEST_IDENTITY_REQUIRED');
  return card.imageRef;
}

export async function runStoryboardVideoSelfTest() {
  const result=await runPaidHarnessSelfTest(); let checks=result.checks;
  assert.equal(parseStoryboardVideoArgs([]).actorRole,'student'); checks++;
  for(const args of [['--source-image-record-id=bad'],['--source-image-record-id='+ 'a'.repeat(64),'--source-image-asset-id=asset'],['--duration=4.5'],['--source-card-id=a','--source-card-id=b']]) {assert.throws(()=>parseStoryboardVideoArgs(args));checks++;}
  const card={imageRef:{schema:'generated_image_ref.v1',recordId:'a'.repeat(64)},imageDeliveryMode:'provider_url',imageClientRequestId:'key',imageClientTraceId:'trace'};
  assert.deepEqual(assertStoryboardSourceCard(card,'a'.repeat(64)),card.imageRef);checks++;
  for(const change of [{imageDeliveryMode:'inline_ephemeral'},{imageRef:{...card.imageRef,recordId:'b'.repeat(64)}},{imageClientRequestId:null}]) {assert.throws(()=>assertStoryboardSourceCard({...card,...change},'a'.repeat(64)));checks++;}
  checks += (await runMediaAsyncBoundarySelfTest('/api/video/generate')).checks;
  console.log(JSON.stringify({kind:'storyboard-video-actual-contract-selftest',status:'PASS',checks,networkCalls:0,dbCalls:0,browserRuns:0,paidPosts:0}));
}

function publicVideoModelId(internalId) {
  const secret = String(process.env.JWT_SECRET || "").trim();
  assert.ok(secret.length >= 16, "JWT_SECRET environment variable is required");
  const digest = createHmac("sha256", secret).update(`video:${internalId}`).digest("base64url").slice(0, 24);
  return `pm_${digest}`;
}

async function waitForActiveModel(button, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await button.getAttribute("class"))?.includes("is-active")) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, body?.error || `${new URL(url).pathname} returned ${response.status}`);
  return body;
}

async function billingSnapshot(userId) {
  const [balance, transactions, credits] = await Promise.all([
    jsonRequest(`${origin}/api/cash/balance`),
    jsonRequest(`${origin}/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50`),
    jsonRequest(`${origin}/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`),
  ]);
  const cashRows = (transactions?.data?.transactions || []).filter((row) => row?.category === "cash");
  return {
    balance: Number(balance.balance), credits:Number(credits.credits), reservedCredits:Number(credits.reservedCredits),
    cashRows,
    cashIds: new Set(cashRows.map((row) => String(row.id))),
  };
}

export async function main(args=process.argv.slice(2)) {
  const paid=parseStoryboardVideoArgs(args);
  if(paid.flags.has('self-test')) return runStoryboardVideoSelfTest();
  assert.ok(!(paid.values['source-image-record-id'] && paid.values['source-image-asset-id']),'STORYBOARD_SOURCE_REFERENCE_CONFLICT');
  const runId = paid.values["run-id"];
  const selectedVideoModelId = paid.values["model-id"] || DEFAULT_VIDEO_MODEL_ID;
  const sourceProjectId = paid.values["source-project-id"] || DEFAULT_SOURCE_PROJECT_ID;
  const sourceImageRecordId=paid.values["source-image-record-id"] || "";
  const sourceImageAssetId = sourceImageRecordId ? "" : paid.values["source-image-asset-id"] || DEFAULT_SOURCE_IMAGE_ASSET_ID;
  const requestedDuration = Number(paid.values["duration"] || "4");
  const requestedResolution = paid.values["resolution"] || "720p";
  const completionTimeoutMs = Number(paid.values["completion-timeout-ms"] || "900000");
  const execute = paid.flags.has("execute");
  const healthOnly = paid.flags.has("health-only");
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.match(runId, /^[A-Za-z0-9_-]{8,100}$/u, "UNIQUE_RUN_ID_REQUIRED");
  assert.match(selectedVideoModelId, /^pm_[A-Za-z0-9_-]+$/u, "PUBLIC_VIDEO_MODEL_ID_REQUIRED");
  assert.ok(Number.isInteger(requestedDuration) && requestedDuration >= 1 && requestedDuration <= 60, "VIDEO_DURATION_INVALID");
  assert.match(requestedResolution, /^(?:480p|720p|768p|1080p|2K|4K|lite)$/u, "VIDEO_RESOLUTION_INVALID");
  assert.ok(Number.isFinite(completionTimeoutMs) && completionTimeoutMs >= 60_000 && completionTimeoutMs <= 1_800_000, "COMPLETION_TIMEOUT_INVALID");
  if(execute || healthOnly) {
    token=String((paid.actorRole==='admin'?process.env.LOCAL_NAV_ADMIN_TOKEN:process.env.R267_CUSTOMER_TOKEN)||'').trim();
    assert.ok(token,'CONTROLLED_EXISTING_SESSION_REQUIRED');
  }

  if (healthOnly) {
    const [publicCatalog, adminCatalog, channelHealth] = await Promise.all([
      jsonRequest(`${origin}/api/video/models?surface=storyboard-workbench`),
      paid.actorRole==="admin" ? jsonRequest(`${origin}/api/admin/video-models`) : Promise.resolve({models:[]}),
      paid.actorRole==="admin" ? jsonRequest(`${origin}/api/video/channel-health`) : Promise.resolve({channels:[]}),
    ]);
    const internalByPublicId = new Map((adminCatalog.models || []).map((model) => [publicVideoModelId(String(model.id)), model]));
    const healthByInternalId = new Map((channelHealth.channels || []).map((channel) => [String(channel.channelId), channel]));
    const candidates = (publicCatalog.models || []).filter((model) => model?.capabilities?.supportsImageInput === true).map((model) => {
      const internal = internalByPublicId.get(String(model.id));
      const health = internal ? healthByInternalId.get(String(internal.id)) : null;
      return {
        publicId: model.id,
        name: model.displayName,
        publicPrice: model.publicPrice,
        billingUnit: model.capabilities?.billingUnit,
        durations: model.capabilities?.nativeDurations || [],
        resolutions: model.capabilities?.resolutionOptions || [],
        credentialConfigured: internal?.api_key_configured === true,
        circuitState: health?.circuitState || "unverified",
        productionBlocked: health?.productionBlocked === true,
        consecutiveFailures: Number(health?.consecutiveFailures || 0),
        lastSuccessAt: health?.lastSuccessAt || null,
        lastFailAt: health?.lastFailAt || null,
        lastErrorCode: health?.lastErrorCode || "NONE",
      };
    }).sort((left, right) => Number(left.productionBlocked) - Number(right.productionBlocked)
      || Number(right.circuitState === "healthy") - Number(left.circuitState === "healthy")
      || String(right.lastSuccessAt || "").localeCompare(String(left.lastSuccessAt || "")));
    console.log(JSON.stringify({ mode: "health-only", providerPosts: 0, counterScope:"browser-generation-POST",providerDispatchCount:"unknown", browserDirectWrites:0,serverSideEffectsNotAudited:true, candidates }, null, 2));
    return;
  }

  const outputDir = path.resolve(".codex-evidence/storyboard-video-platform-fix-20260920", runId);
  if (!execute) {
    console.log(JSON.stringify({ mode: "plan", providerPostLimit: 1, counterScope:"browser-generation-POST",providerDispatchCount:"unknown", imageGenerationPosts: 0, outputDir }));
    return;
  }

  await fs.mkdir(outputDir,{recursive:true});
  const identity = await jsonRequest(`${origin}/api/auth/me`);
  const actor=assertPaidActor(identity,paid);
  const pins={origin,expectedSourceVersion:paid.values["expected-source-version"],expectedBuildId:paid.values["expected-build-id"]};
  const runtimeBefore=await runtimeIdentity(pins);
  const databaseReadiness=await readPaidDatabaseReadiness(paid,runtimeBefore);
  const [catalog, adminCatalog, channelHealth] = await Promise.all([
    jsonRequest(`${origin}/api/video/models?surface=storyboard-workbench`),
    paid.actorRole==="admin" ? jsonRequest(`${origin}/api/admin/video-models`) : Promise.resolve({models:[]}),
    paid.actorRole==="admin" ? jsonRequest(`${origin}/api/video/channel-health`) : Promise.resolve({channels:[]}),
  ]);
  const selectedModel = catalog.models?.find((model) => model.id === selectedVideoModelId);
  assert.ok(selectedModel?.capabilities?.available, "KNOWN_GOOD_STORYBOARD_VIDEO_MODEL_UNAVAILABLE");
  assert.equal(selectedModel.capabilities.supportsImageInput, true, "VIDEO_MODEL_IMAGE_INPUT_REQUIRED");
  assert.ok(selectedModel.capabilities.nativeDurations?.includes(requestedDuration), `VIDEO_MODEL_DURATION_REQUIRED:${requestedDuration}`);
  assert.ok(selectedModel.capabilities.resolutionOptions?.includes(requestedResolution), `VIDEO_MODEL_RESOLUTION_REQUIRED:${requestedResolution}`);
  if(paid.actorRole==="admin") {
  const selectedInternalModel = (adminCatalog.models || []).find((model) => publicVideoModelId(String(model.id)) === selectedVideoModelId);
  assert.ok(selectedInternalModel, "STORYBOARD_VIDEO_INTERNAL_MODEL_MAPPING_MISSING");
  assert.equal(selectedInternalModel.api_key_configured, true, "STORYBOARD_VIDEO_CREDENTIAL_NOT_CONFIGURED");
  const selectedHealth = (channelHealth.channels || []).find((channel) => channel.channelId === selectedInternalModel.id);
  assert.notEqual(selectedHealth?.productionBlocked, true,
    `STORYBOARD_VIDEO_CHANNEL_BLOCKED:${selectedHealth?.circuitState || "unknown"}:${selectedHealth?.lastErrorCode || "NONE"}`);

  }

  const lockedQuote=publicVideoQuote(selectedModel,requestedDuration,requestedResolution,paid);
  const billingBefore = await billingSnapshot(identity.user.id);
  assert.ok(Number.isFinite(billingBefore.balance), "BILLING_BALANCE_BEFORE_INVALID");

  const source = await jsonRequest(`${origin}/api/storyboard/projects?id=${encodeURIComponent(sourceProjectId)}`);
  const sourceCard=source.project?.document?.cards?.find(card=>card.id===paid.values['source-card-id']);
  assert.ok(sourceCard,'EXACT_OWNED_SOURCE_CARD_REQUIRED');
  let ownedImage;
  if(sourceImageRecordId) {
    assert.match(sourceImageRecordId,/^[a-f0-9]{64}$/u,'GENERATED_IMAGE_RECORD_INVALID');
    assertStoryboardSourceCard(sourceCard,sourceImageRecordId);
    const status=await jsonRequest(`${origin}/api/image/status?${new URLSearchParams({clientIdempotencyKey:sourceCard.imageClientRequestId,clientTraceId:sourceCard.imageClientTraceId})}`);
    assert.equal(status.recordId,sourceImageRecordId,'SOURCE_OWNER_STATUS_RECORD_MISMATCH');
    assert.equal(status.deliveryMode,'provider_url','SOURCE_MODE_MISMATCH');
    assert.equal(status.generationCompleted,true,'SOURCE_NOT_COMPLETED');
    assert.equal(status.mediaAvailable,true,'SOURCE_MEDIA_UNAVAILABLE');
    const read=await fetch(`${origin}/api/media-history/content?recordId=${sourceImageRecordId}`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
    assert.ok(read.ok && /^image\//u.test(read.headers.get('content-type')||''),'SOURCE_OWNED_MEDIA_UNAVAILABLE');
    await read.body?.cancel();
    ownedImage={ref:sourceCard.imageRef,url:`/api/media-history/content?recordId=${sourceImageRecordId}`};
  } else {
    assert.equal(sourceCard.imageAssetId,sourceImageAssetId,'SOURCE_CARD_ASSET_MISMATCH');
    ownedImage=await jsonRequest(`${origin}/api/storyboard/image?assetId=${encodeURIComponent(sourceImageAssetId)}`);
    assert.equal(ownedImage.assetId,sourceImageAssetId,'STORYBOARD_IMAGE_OWNERSHIP_MISMATCH');
    assert.ok(ownedImage.url && ownedImage.storageKey,'STORYBOARD_IMAGE_NOT_RESTORABLE');
  }

  const now = Date.now();
  const projectId = `sbw-video-${runId}`;
  const projectTitle = `分镜视频验收 ${runId}`;
  const marker = `SBW_VIDEO_FIX_${runId}_${randomUUID()}`;
  const document = structuredClone(source.project.document);
  document.id = projectId;
  document.title = projectTitle;
  document.createdAt = now;
  document.updatedAt = now;
  document.lastSubmittedAt = now;
  document.ratio = "16:9";
  document.videoModelId = selectedVideoModelId;
  document.videoResolution = requestedResolution;
  document.videoDuration = requestedDuration;
  document.cards = [structuredClone(sourceCard)];
  Object.assign(document.cards[0], {
    id: `sbw-video-card-${runId}`,
    order: 1,
    imageStatus: "done",
    imageUrl: ownedImage.url,
    imageRef: ownedImage.ref, imageRecordId:sourceImageRecordId || undefined, imageDeliveryMode:sourceImageRecordId ? "provider_url" : undefined,
    imageAssetId: ownedImage.assetId,
    imageStorageKey: ownedImage.storageKey,
    imageValidatedAt: now,
    imageError: undefined,
    videoPrompt: `金毛幼犬在明亮客厅木地板上轻快跳跃，镜头平稳缓慢前推，暖色自然光，保持角色和环境一致，无文字无水印。验收标记 ${marker} 仅用于任务核对，不得出现在画面。`,
    videoStatus: "idle",
    videoUrl: undefined,
    videoError: undefined,
    videoTaskId: undefined,
    videoTaskModelId: undefined,
    videoContentUrl: undefined,
    videoClientRequestId: undefined,
    videoClientRequestFingerprint: undefined,
    videoRetryable: undefined,
    videoBillingState: undefined,
    videoPriceCharged: undefined,
  });
  const saved = await jsonRequest(`${origin}/api/storyboard/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document, expectedRevision: 0 }),
  });
  assert.equal(saved.project?.id, projectId, "STORYBOARD_CANARY_PROJECT_SAVE_FAILED");

  const dispatchPath = path.join(outputDir, "dispatch.json");
  await fs.writeFile(dispatchPath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    runId,
    marker,
    projectId,
    sourceImageAssetId,
    selectedModelId: selectedVideoModelId,
    selectedModel: selectedModel.displayName,
    duration: requestedDuration,
    resolution: requestedResolution,
    balanceBefore: billingBefore.balance,
    providerPostLimit: 1, counterScope:"browser-generation-POST",providerDispatchCount:"unknown",
  }, null, 2)}\n`, { flag: "wx" });

  const browser = await chromium.launch({ headless: true });
  let generationPosts = 0;
  let imageGenerationPosts = 0;
  let requestBody = null;
  let responseBody = null;
  const routeEvidence = {};
  const admission={generationPostAttempts:0,generationPostsContinued:0,duplicateGenerationPostsBlocked:0};
  const consoleErrors = [];
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    await installPaidAuthCookie(context, origin, token);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    let clickArmed=false;
    const guardExpected={surface:'storyboard-workbench',batch_topic:'storyboard-workbench',model_id:selectedVideoModelId,duration:requestedDuration,resolution_tier:requestedResolution,
      prompt:document.cards[0].videoPrompt.trim(),
      ...(sourceImageRecordId ? {image_ref:ownedImage.ref} : {image_storage_key:ownedImage.storageKey})};
    const installed=makeWorkbenchPaidPostHandler({diagnostics:admission,isArmed:()=>clickArmed,expected:guardExpected,
      checkFresh:async route=>{
        const body=route.request().postDataJSON();
        if(sourceImageRecordId) assert.equal(Object.prototype.hasOwnProperty.call(body,'image_url'),false,'RAW_AND_TYPED_IMAGE_CONFLICT');
        else {
          const actual=new URL(body.image_url,origin),expected=new URL(ownedImage.url,origin);
          assert.equal(actual.origin+actual.pathname,expected.origin+expected.pathname,'OWNED_SOURCE_IMAGE_IDENTITY_DRIFT');
        }
        const fresh=await jsonRequest(`${origin}/api/video/models?surface=storyboard-workbench`);
        const current=fresh.models?.find(item=>item.id===selectedVideoModelId);
        assert.equal(publicVideoQuote(current,requestedDuration,requestedResolution,paid),lockedQuote,'STORYBOARD_VIDEO_PRICE_DRIFT');
      }});
    const routeBoundary=makeMediaPaidRouteBoundary(installed,routeEvidence);
    await context.route('**/api/video/generate',routeBoundary.handler);
    await context.route('**/api/image/generate',route=>route.abort('blockedbyclient'));
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 400)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 400));
    });
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST" && pathname === "/api/video/generate") {
        generationPosts += 1;
        requestBody = request.postDataJSON();
      }
      if (request.method() === "POST" && pathname === "/api/image/generate") imageGenerationPosts += 1;
    });

    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
    const project = page.locator(`[data-storyboard-project-id="${projectId}"]`);
    await project.waitFor({ state: "visible", timeout: 45_000 });
    await project.getByRole("button", { name: "打开任务", exact: true }).click();

    let card = page.locator("article.sbw-shot-card").first();
    const image = card.getByRole("img", { name: "任务1故事板" });
    await image.waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector("article.sbw-shot-card img[alt='任务1故事板']");
      return element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0;
    }, undefined, { timeout: 45_000 });
    const selectedButton = page.locator(`.sbw-video-model-list button[data-model-id="${selectedVideoModelId}"]`).first();
    await selectedButton.waitFor({ state: "visible", timeout: 45_000 });
    assert.equal(await waitForActiveModel(selectedButton), true, "VIDEO_MODEL_SELECTION_NOT_RESTORED");

    const generate = card.getByRole("button", { name: "生成视频", exact: true });
    await generate.waitFor({ state: "visible", timeout: 30_000 });
    let generateEnabled = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      generateEnabled = await generate.isEnabled();
      if (generateEnabled) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!generateEnabled) {
      const imageDimensions = await image.evaluate((element) => ({
        width: element.naturalWidth,
        height: element.naturalHeight,
        complete: element.complete,
      }));
      const disabledReason = await generate.getAttribute("title");
      const cardState = await card.getAttribute("data-card-state");
      throw new Error(`STORYBOARD_VIDEO_BUTTON_DISABLED:${disabledReason || "NO_TITLE"}:${cardState || "NO_STATE"}:${imageDimensions.width}x${imageDimensions.height}`);
    }
    clickArmed=true;
    const generationResponse = await awaitMediaGenerationResponse({page,click:()=>generate.click(),failure:routeBoundary.failure,pathname:'/api/video/generate',timeoutMs:120_000});
    responseBody = await generationResponse.json().catch(() => null);
    assert.ok(generationResponse.status() < 500, responseBody?.error || responseBody?.message || "STORYBOARD_VIDEO_SUBMISSION_FAILED");
    assert.equal(generationPosts, 1, "STORYBOARD_VIDEO_POST_COUNT_INVALID");
    assert.equal(imageGenerationPosts, 0, "UNEXPECTED_IMAGE_GENERATION_POST");
    assert.equal(requestBody?.surface, "storyboard-workbench");
    assert.equal(requestBody?.batch_topic, "storyboard-workbench");
    assert.equal(requestBody?.model_id, selectedVideoModelId);
    assert.equal(requestBody?.duration, requestedDuration);
    assert.equal(requestBody?.resolution_tier, requestedResolution);
    if(sourceImageRecordId) assert.deepEqual(requestBody.image_ref,ownedImage.ref,"STORYBOARD_TYPED_SOURCE_DRIFT");
    else assert.ok(requestBody?.image_url,"STORYBOARD_VIDEO_IMAGE_NOT_BOUND");
    const taskId = responseBody?.business_task_id || responseBody?.task_id;
    assert.ok(taskId, "STORYBOARD_VIDEO_TASK_ID_MISSING");
    const submittedAt = Date.now();

    let submittedProject = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      submittedProject = await jsonRequest(`${origin}/api/storyboard/projects?id=${encodeURIComponent(projectId)}`);
      if (submittedProject?.project?.document?.cards?.[0]?.videoTaskId === taskId) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(submittedProject?.project?.document?.cards?.[0]?.videoTaskId, taskId, "STORYBOARD_VIDEO_SUBMISSION_NOT_PERSISTED");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: "最近任务", exact: true }).first().click();
    const projectAfterReload = page.locator(`[data-storyboard-project-id="${projectId}"]`);
    await projectAfterReload.waitFor({ state: "visible", timeout: 45_000 });
    await projectAfterReload.getByRole("button", { name: "打开任务", exact: true }).click();
    card = page.locator("article.sbw-shot-card").first();
    await card.waitFor({ state: "visible", timeout: 45_000 });
    const selectedAfterReload = page.locator(`.sbw-video-model-list button[data-model-id="${selectedVideoModelId}"]`).first();
    await selectedAfterReload.waitFor({ state: "visible", timeout: 45_000 });
    assert.equal(await waitForActiveModel(selectedAfterReload), true, "VIDEO_MODEL_SELECTION_LOST_AFTER_RELOAD");
    assert.equal(generationPosts, 1, "PAGE_RELOAD_REPOSTED_VIDEO_TASK");

    await card.locator('[data-status="done"]').filter({ hasText: "视频完成" }).waitFor({ state: "visible", timeout: completionTimeoutMs });
    const completedAt = Date.now();
    const video = card.locator("video").first();
    await video.waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector("article.sbw-shot-card video");
      return element instanceof HTMLVideoElement && element.readyState >= 1 && element.videoWidth > 0 && element.videoHeight > 0;
    }, undefined, { timeout: 120_000 });
    const rendered = await video.evaluate((element) => ({
      width: element.videoWidth,
      height: element.videoHeight,
      duration: element.duration,
      readyState: element.readyState,
    }));

    let restoredProject = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      restoredProject = await jsonRequest(`${origin}/api/storyboard/projects?id=${encodeURIComponent(projectId)}`);
      if (restoredProject?.project?.document?.cards?.[0]?.videoStatus === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const persistedCard = restoredProject?.project?.document?.cards?.[0];
    assert.equal(persistedCard?.videoStatus, "done", "STORYBOARD_VIDEO_COMPLETION_NOT_PERSISTED");
    assert.equal(persistedCard?.videoTaskId, taskId, "STORYBOARD_VIDEO_TASK_NOT_PERSISTED");

    const history = await jsonRequest(`${origin}/api/video/history?surface=storyboard-workbench&limit=200`);
    const historyTask = history.tasks?.find((task) => task.id === taskId);
    assert.ok(historyTask, "STORYBOARD_VIDEO_HISTORY_MISSING");
    assert.equal(historyTask.status, "completed", "STORYBOARD_VIDEO_HISTORY_NOT_COMPLETED");
    assert.equal(historyTask.modelId, selectedVideoModelId, "STORYBOARD_VIDEO_HISTORY_MODEL_MISMATCH");

    const expectedCharge = Number(historyTask.priceCharged || 0);
    assert.ok(Number.isFinite(expectedCharge) && expectedCharge > 0, "ADMIN_VIDEO_MUST_USE_NORMAL_BILLING");
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
    assert.ok(balanceDelta<=paid.maxCharge,"STORYBOARD_VIDEO_CHARGE_EXCEEDS_CAP");
    assert.equal(balanceDelta,lockedQuote,"STORYBOARD_VIDEO_LOCKED_QUOTE_DRIFT");
    assert.ok(Math.abs(balanceDelta - expectedCharge) <= 0.000001,
      `VIDEO_BILLING_BALANCE_DELTA_MISMATCH:${balanceDelta}:${expectedCharge}`);
    const newCashRows = billingAfter.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
    assert.equal(newCashRows.length, 1, `VIDEO_BILLING_TRANSACTION_COUNT_MISMATCH:${newCashRows.length}`);
    assert.equal(String(newCashRows[0].referenceId || ""),`video-terminal:${taskId}`,"VIDEO_ORIGINAL_CASH_REFERENCE_MISMATCH");
    assertPaidFinalPass({actor:identity.user,expectedRole:paid.actorRole,completed:true,cashDelta:balanceDelta,quote:lockedQuote,newCashRows:newCashRows.length,generationPosts});
    assert.ok(Math.abs(Math.abs(Number(newCashRows[0].amount)) - expectedCharge) <= 0.000001,
      "VIDEO_BILLING_TRANSACTION_AMOUNT_MISMATCH");

    await writePaidTerminalReadback(outputDir, {runId,terminalStatus:historyTask.status,actor,generationPosts,admission,
      imageGenerationPosts,modelId:selectedVideoModelId,taskId,billingState:historyTask.billingState,runtimeBefore,
      persisted:{projectId,cardId:persistedCard.id,videoStatus:persistedCard.videoStatus,videoTaskId:persistedCard.videoTaskId},
      reusableSource:{projectId:sourceProjectId,cardId:sourceCard.id,recordId:sourceImageRecordId || null,
        deliveryMode:sourceImageRecordId ? 'provider_url' : 'legacy_owned',imageRef:sourceImageRecordId ? ownedImage.ref : null},
      billing:{balanceBefore:billingBefore.balance,balanceAfter:billingAfter.balance,balanceDelta,
        newTransactionCount:newCashRows.length,referenceId:newCashRows[0].referenceId,amount:Number(newCashRows[0].amount)}});

    const ticket = await jsonRequest(`${origin}/api/video/access-ticket?${new URLSearchParams({ taskId, scope: "download", name: `${runId}.mp4` })}`);
    assert.ok(ticket.url, "STORYBOARD_VIDEO_DOWNLOAD_TICKET_MISSING");
    const mediaResponse = await context.request.get(new URL(ticket.url, origin).toString(), {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120_000,
    });
    const mediaBytes = Buffer.from(await mediaResponse.body());
    assert.ok(mediaResponse.ok() && mediaBytes.length > 1_024, "STORYBOARD_VIDEO_MEDIA_INVALID");
    assert.equal(mediaBytes.subarray(4, 8).toString("ascii"), "ftyp", "STORYBOARD_VIDEO_MP4_HEADER_INVALID");
    const explicitDownload=await capturePaidDownload(page,card.getByTitle('下载视频',{exact:true}),outputDir,'video');
    await page.screenshot({ path: path.join(outputDir, "storyboard-video-success.png"), fullPage: true });

    const version = await (await context.request.get(`${origin}/api/version`)).json();
    const report = {
      runId,
      checkedAt: new Date().toISOString(),
      sourceVersion: version.sourceVersion,
      projectId,
      selectedModel: selectedModel.displayName,
      selectedModelId: selectedVideoModelId,
      generationPosts, admission,
      imageGenerationPosts,
      counterScope:'browser-generation-POST',providerDispatchCount:'unknown',...routeEvidence,
      request: {
        surface: requestBody.surface,
        batchTopic: requestBody.batch_topic,
        duration: requestBody.duration,
        resolution: requestBody.resolution_tier,
        hasImageUrl: Boolean(requestBody.image_url), imageRef:requestBody.image_ref || null,
        clientRequestId: requestBody.client_request_id,
      },
      response: {
        http: generationResponse.status(),
        taskId,
        status: responseBody?.status,
        taskSubmitted: responseBody?.task_submitted,
        billingState: responseBody?.billing_state,
        price: responseBody?.price,
      },
      history: {
        status: historyTask.status,
        billingState: historyTask.billingState,
        priceCharged: expectedCharge,
      },
      refreshRecovery: {
        taskPersistedBeforeReload: true,
        modelSelectionRestored: true,
        generationPostsAfterReload: generationPosts,
      },
      timing: {
        submittedAt: new Date(submittedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        elapsedSeconds: Number(((completedAt - submittedAt) / 1_000).toFixed(3)),
      },
      billing: {
        balanceBefore: billingBefore.balance,
        balanceAfter: billingAfter.balance,
        balanceDelta,
        newTransactionCount: newCashRows.length,
        referenceId: newCashRows[0].referenceId,
        amount: Number(newCashRows[0].amount),
      },
      persisted: { videoStatus: persistedCard.videoStatus, videoTaskId: persistedCard.videoTaskId },
      rendered,
      media: {
        explicitDownload, bytes: mediaBytes.length,
        contentType: mediaResponse.headers()["content-type"] || "",
        sha256: createHash("sha256").update(mediaBytes).digest("hex"),
        temporaryFileDeleted:true,
      },
      consoleErrors,
      pageErrors,
      tokenPersisted: false,
    };
    assert.deepEqual(await runtimeIdentity(pins),runtimeBefore,"RUNTIME_CHANGED_DURING_CANARY");
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(safeHarnessEvidence(report), null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ success: true, runId, generationPosts, imageGenerationPosts, taskId, status: historyTask.status,
      priceCharged: Number(historyTask.priceCharged || 0), report: path.join(outputDir, "report.json") }));
  } catch (error) {
    const failure = {
      errorCode:safeHarnessErrorCode(error), budgetDisposition:"full allocation occupied until original terminal readback",
      runId,
      failedAt: new Date().toISOString(),
      generationPosts,
      imageGenerationPosts,
      counterScope:'browser-generation-POST',providerDispatchCount:'unknown',admission,...routeEvidence,
      automaticRetries:0,allocatedBudget:paid.maxCharge,lockedQuote,
      taskId: responseBody?.business_task_id || responseBody?.task_id || null,
      responseStatus: responseBody?.status || null,
      message: error instanceof Error ? error.message.slice(0, 1_200) : String(error).slice(0, 1_200),
    };
    await fs.writeFile(path.join(outputDir, "failure.json"), `${JSON.stringify(safeHarnessEvidence(failure), null, 2)}\n`, { flag: "wx" }).catch(() => {});
    throw error;
  } finally {
    await browser.close().catch(()=>undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error=>{console.error(JSON.stringify({success:false,errorCode:safeHarnessErrorCode(error),automaticRetries:0}));process.exitCode=1;});
