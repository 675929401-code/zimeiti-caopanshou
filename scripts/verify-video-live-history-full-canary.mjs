#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const DEFAULT_ORIGIN = "http://127.0.0.1:5000";
const PROJECT_ROOT = process.cwd();
const CHEAPEST_MODEL_ID = "pm_Stp5Ka3hsbnsvqOaqdB0TUl3";
const DURATION_SECONDS = 1;
const RESOLUTION = "480p";
const PRICE_CEILING_YUAN = 0.04;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);
const POLL_INTERVAL_MS = 10_000;
const SAFE_RUNTIME_ID = /^[A-Za-z0-9._:-]{4,180}$/u;
const VIDEO_DATABASE_READINESS_CHECKER = "scripts/verify-video-request-snapshot-readiness-local.mjs";
const VIDEO_GENERATE_ROUTE = "src/app/api/video/generate/route.ts";
const LOCAL_DATABASE_TARGET = "127.0.0.1:54322/zimeiti_local";

function argument(args, name, fallback = "") {
  return args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function pathnameOnly(value) {
  try { return new URL(value).pathname; } catch { return "invalid-url"; }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function transactionId(row) {
  return String(row?.id || "");
}

function transactionReference(row) {
  return String(row?.referenceId || row?.reference_id || "");
}

function transactionAmount(row) {
  return Number(row?.amount || 0);
}

function normalizeStatus(value) {
  const status = String(value || "unknown").toLowerCase();
  if (status === "done" || status === "succeeded" || status === "success") return "completed";
  if (status === "processing" || status === "generating" || status === "pending") return status;
  return status;
}

function reconciliationGuide(runId, clientRequestId) {
  return {
    automaticRetryForbidden: true,
    command: `node scripts/with-local-customer-session.mjs scripts/verify-video-live-history-full-canary.mjs --reconcile --run-id=${runId}`,
    readOnlyLookup: `/api/video/request-status?clientRequestId=${encodeURIComponent(clientRequestId)}`,
    instruction: "先用原 client_request_id 查询原任务；未确认 found=false 前不得再次提交。即使确认可重试，也必须由操作者重新显式授权并沿用同一请求号。",
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { invalidJson: true, preview: text.slice(0, 300) };
  }
}

function createClient(origin, token) {
  async function requestJson(pathname, options = {}) {
    const response = await fetch(new URL(pathname, origin), {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
      cache: options.cache || "no-store",
      signal: options.signal || AbortSignal.timeout(120_000),
    });
    return { response, body: await readJsonResponse(response) };
  }

  async function requiredJson(pathname, options = {}) {
    const result = await requestJson(pathname, options);
    assert.ok(
      result.response.ok,
      `${result.body?.error_code || result.body?.code || "HTTP_ERROR"}:${result.body?.error || result.body?.message || result.response.status}`,
    );
    return result.body;
  }

  return { requestJson, requiredJson };
}

async function runtimeIdentity(client, expectedSourceVersion, expectedBuildId) {
  const runtimeVersion = await client.requiredJson("/api/version");
  const [diskVersionText, diskBuildId, receiptText] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "public", "version.json"), "utf8"),
    fs.readFile(path.join(PROJECT_ROOT, ".next", "BUILD_ID"), "utf8").then(value => value.trim()),
    fs.readFile(path.join(PROJECT_ROOT, ".next", "local-source-fingerprint.v1.json"), "utf8"),
  ]);
  const diskVersion = JSON.parse(diskVersionText);
  const receipt = JSON.parse(receiptText);
  const fingerprint = computeLocalBuildFingerprint(PROJECT_ROOT);
  const runningLatest = runtimeVersion?.sourceVersion === diskVersion?.sourceVersion
    && runtimeVersion?.buildId === diskBuildId
    && receipt?.buildId === diskBuildId
    && receipt?.fingerprint === fingerprint.fingerprint
    && receipt?.fileCount === fingerprint.fileCount;
  assert.equal(runningLatest, true, "RUNTIME_NOT_LATEST");
  assert.equal(runtimeVersion?.sourceVersion, expectedSourceVersion, "EXPECTED_SOURCE_VERSION_MISMATCH");
  assert.equal(runtimeVersion?.buildId, expectedBuildId, "EXPECTED_BUILD_ID_MISMATCH");
  return {
    sourceVersion: runtimeVersion.sourceVersion,
    buildId: runtimeVersion.buildId,
    diskSourceVersion: diskVersion.sourceVersion,
    diskBuildId,
    sourceFingerprint: fingerprint.fingerprint,
    sourceFingerprintCurrent: true,
    runningLatest,
  };
}

async function ordinaryStudentBillingPolicy() {
  const source = await fs.readFile(path.join(PROJECT_ROOT, VIDEO_GENERATE_ROUTE), "utf8");
  assert.match(source, /const billingExempt = false;/u, "VIDEO_BILLING_EXEMPTION_MUST_BE_DISABLED");
  return {
    route: VIDEO_GENERATE_ROUTE,
    role: "student",
    billingExempt: false,
    assertion: "current runningLatest source fixes video billing exemption to false",
  };
}

function localVideoDatabaseReadiness() {
  const childEnvironment = { ...process.env };
  for (const key of [
    "R267_CUSTOMER_TOKEN",
    "LOCAL_NAV_READONLY_CUSTOMER",
    "AUTH_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) delete childEnvironment[key];
  const startedAtMs = Date.now();
  const result = spawnSync(process.execPath, [path.resolve(PROJECT_ROOT, VIDEO_DATABASE_READINESS_CHECKER)], {
    cwd: PROJECT_ROOT,
    env: childEnvironment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const completedAtMs = Date.now();
  const body = parseJson(result.stdout, null);
  const checkedAtMs = Date.parse(String(body?.checkedAt || ""));
  const fresh = Number.isFinite(checkedAtMs)
    && checkedAtMs >= startedAtMs - 1_000
    && checkedAtMs <= completedAtMs + 1_000;
  const summary = {
    checker: VIDEO_DATABASE_READINESS_CHECKER,
    exitCode: result.status,
    signal: result.signal || null,
    processError: result.error ? String(result.error.code || result.error.name || "checker-error") : null,
    checkedAt: body?.checkedAt || null,
    fresh,
    target: body?.target || null,
    migration: {
      file: body?.migration || null,
      sha256: body?.migrationHash || null,
      ledgerPresent: body?.ledgerPresent === true,
      ledgerHashMatches: body?.ledgerHashMatches === true,
    },
    live: body?.live ? {
      tableOwner: body.live.tableOwner,
      columnsReady: body.live.columnsReady === true,
      constraint: body.live.constraint,
      snapshotCounts: body.live.snapshotCounts,
      functions: Array.isArray(body.live.functions) ? body.live.functions.map(item => ({
        signature: item.signature,
        present: item.present === true,
        semanticsReady: item.semanticsReady === true,
        owner: item.owner,
        ownerMatchesTable: item.ownerMatchesTable === true,
        securityDefiner: item.securityDefiner === true,
        searchPath: item.searchPath,
        executeGrantees: item.executeGrantees,
        privileges: item.privileges,
        securityReady: item.securityReady === true,
        ready: item.ready === true,
      })) : [],
    } : null,
    writes: body?.writes ?? null,
    providerCalls: body?.providerCalls ?? null,
    credentialsPrinted: body?.credentialsPrinted ?? null,
  };
  summary.ready = result.status === 0
    && fresh
    && body?.target === LOCAL_DATABASE_TARGET
    && body?.ready === true
    && body?.ledgerHashMatches === true
    && body?.live?.columnsReady === true
    && body?.live?.constraint?.semanticsReady === true
    && Number(body?.live?.snapshotCounts?.invalid) === 0
    && Array.isArray(body?.live?.functions)
    && body.live.functions.length === 3
    && body.live.functions.every(item => item.ready === true)
    && body?.writes === 0
    && body?.providerCalls === 0
    && body?.billingOperations === 0
    && body?.credentialsPrinted === false;
  return summary;
}

async function billingSnapshot(client, userId) {
  assert.match(String(userId || ""), /^[0-9a-f-]{36}$/iu, "BILLING_USER_ID_REQUIRED");
  const [balance, credits, transactions] = await Promise.all([
    client.requiredJson("/api/cash/balance"),
    client.requiredJson(`/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`),
    client.requiredJson("/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=200"),
  ]);
  const rows = (transactions?.data?.transactions || []).filter((row) => row?.category === "cash");
  const cashBalance = Number(balance?.balance);
  const creditsCashBalance = Number(credits?.cashBalance);
  assert.ok(Number.isFinite(cashBalance), "CASH_BALANCE_UNREADABLE");
  assert.ok(Number.isFinite(creditsCashBalance), "CREDITS_CASH_BALANCE_UNREADABLE");
  assert.ok(Number.isFinite(Number(credits?.credits)), "CREDITS_BALANCE_UNREADABLE");
  assert.ok(Number.isFinite(Number(credits?.reservedCredits)), "RESERVED_CREDITS_UNREADABLE");
  assert.ok(Math.abs(cashBalance - creditsCashBalance) <= 0.000001, "WALLET_CASH_ENDPOINT_MISMATCH");
  return {
    userId,
    balance: cashBalance,
    credits: Number(credits?.credits),
    reservedCredits: Number(credits?.reservedCredits),
    memberStatus: String(credits?.memberStatus || ""),
    rows,
    ids: rows.map(transactionId).filter(Boolean),
  };
}

function assertModelGate(model) {
  const capabilities = model?.capabilities || {};
  const publicPrice = Number(model?.publicPrice);
  assert.ok(model, "CHEAPEST_MODEL_MISSING");
  assert.equal(capabilities.available ?? model.available, true, "CHEAPEST_MODEL_UNAVAILABLE");
  assert.equal(capabilities.generationReady ?? model.generationReady, true, `CHEAPEST_MODEL_NOT_READY:${capabilities.readinessMessage || model.availabilityMessage || ""}`);
  assert.equal(capabilities.requiresImage, false, "CHEAPEST_MODEL_MUST_BE_TEXT_TO_VIDEO");
  assert.notEqual(capabilities.supportsTextInput, false, "CHEAPEST_MODEL_TEXT_INPUT_DISABLED");
  assert.ok((capabilities.nativeDurations || []).includes(DURATION_SECONDS), "ONE_SECOND_DURATION_NOT_SUPPORTED");
  assert.ok((capabilities.resolutionOptions || []).includes(RESOLUTION), "LOWEST_RESOLUTION_NOT_SUPPORTED");
  assert.ok(Number.isFinite(publicPrice) && publicPrice > 0, `PUBLIC_PRICE_MUST_BE_POSITIVE:${model?.publicPrice}`);
  assert.ok(publicPrice <= PRICE_CEILING_YUAN, `PRICE_CEILING_EXCEEDED:${publicPrice}`);
  return {
    id: String(model.id),
    displayName: String(model.displayName || model.name || model.id),
    publicPrice,
    billingUnit: String(capabilities.billingUnit || ""),
    pricingMode: String(capabilities.pricingMode || ""),
  };
}

async function requireOrdinaryStudentIdentity(client, wrapperCustomer) {
  const identity = await client.requiredJson("/api/auth/me");
  assert.equal(wrapperCustomer?.role, "student", "CUSTOMER_WRAPPER_STUDENT_REQUIRED");
  assert.equal(identity?.user?.role, "student", "ORDINARY_STUDENT_IDENTITY_REQUIRED");
  assert.equal(identity?.user?.id, wrapperCustomer?.id, "CUSTOMER_WRAPPER_IDENTITY_MISMATCH");
  return identity;
}

async function preflight(client, report, wrapperCustomer) {
  const identity = await requireOrdinaryStudentIdentity(client, wrapperCustomer);
  const [version, catalog, billing] = await Promise.all([
    client.requiredJson("/api/version"),
    client.requiredJson("/api/video/models?surface=video-page"),
    billingSnapshot(client, identity.user.id),
  ]);
  assert.ok(Number.isFinite(billing.credits), "CREDITS_BALANCE_UNREADABLE");
  assert.ok(Number.isFinite(billing.reservedCredits), "RESERVED_CREDITS_UNREADABLE");
  assert.equal(billing.memberStatus, "active", "ACTIVE_STUDENT_MEMBER_REQUIRED");
  const model = assertModelGate((catalog?.models || []).find((item) => item.id === CHEAPEST_MODEL_ID));
  assert.ok(billing.balance + 1e-9 >= model.publicPrice, `BALANCE_INSUFFICIENT:${billing.balance}:${model.publicPrice}`);
  Object.assign(report, {
    actor: { id: identity.user.id, role: identity.user.role },
    role: identity.user.role,
    billingExempt: false,
    quotedPriceYuan: model.publicPrice,
    sourceVersion: version?.sourceVersion || "",
    buildId: version?.buildId || "",
    model,
    balanceReadable: true,
    balanceSufficient: true,
  });
  return { identity, model, billing };
}

async function saveReport(outputDir, report, name = "report.json") {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, name), `${JSON.stringify(report, null, 2)}\n`);
}

async function waitForTaskTerminal(client, taskId, modelId, timeoutMs, report) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const status = await client.requestJson(`/api/video/status?${new URLSearchParams({ taskId, modelId })}`, {
      signal: AbortSignal.timeout(90_000),
    });
    const state = normalizeStatus(status.body?.status || `http-${status.response.status}`);
    const observation = {
      at: new Date().toISOString(),
      attempt,
      http: status.response.status,
      status: state,
      stage: status.body?.processingStage || null,
      progress: status.body?.progress ?? null,
      billingState: status.body?.billingState || null,
      priceCharged: Number(status.body?.priceCharged || 0),
      errorCode: status.body?.errorCode || status.body?.error_code || null,
      message: String(status.body?.errorMessage || status.body?.message || "").slice(0, 400),
      videoUrlPresent: Boolean(status.body?.videoUrl || status.body?.storageUrl),
    };
    const previous = report.polling.at(-1);
    if (!previous || previous.status !== observation.status || previous.progress !== observation.progress || attempt % 6 === 0) {
      report.polling.push(observation);
      console.log(JSON.stringify(observation));
      await saveReport(report.outputDir, report, "progress.json");
    }
    if (TERMINAL_STATES.has(state)) {
      return {
        ...observation,
        taskId,
        videoUrl: String(status.body?.videoUrl || status.body?.storageUrl || ""),
      };
    }
    await delay(POLL_INTERVAL_MS);
  }
  return null;
}

async function waitForVideoHistory(client, identifiers, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await client.requiredJson("/api/video/history?surface=video-page&limit=200&offset=0");
    const task = (history?.tasks || []).find((item) => (
      identifiers.has(String(item.id || ""))
      || identifiers.has(String(item.taskIdExternal || ""))
      || identifiers.has(String(item.clientRequestId || ""))
    ));
    if (task && normalizeStatus(task.status) === "completed" && task.videoUrl) return task;
    await delay(2_000);
  }
  throw new Error("VIDEO_PAGE_HISTORY_REALTIME_TIMEOUT");
}

async function fetchMediaEvidence(origin, client, taskId, runId) {
  const ticket = await client.requiredJson(`/api/video/access-ticket?${new URLSearchParams({ taskId, scope: "playback", name: `${runId}.mp4` })}`);
  assert.ok(ticket?.url, "VIDEO_PLAYBACK_TICKET_MISSING");
  const response = await fetch(new URL(ticket.url, origin), {
    headers: { Range: "bytes=0-65535" },
    signal: AbortSignal.timeout(120_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(response.ok || response.status === 206, `VIDEO_MEDIA_HTTP_${response.status}`);
  assert.ok(bytes.length > 8, "VIDEO_MEDIA_EMPTY");
  assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp", "VIDEO_MEDIA_NOT_MP4");
  return {
    http: response.status,
    bytes: bytes.length,
    contentType: response.headers.get("content-type") || "",
    mp4Header: "ftyp",
  };
}

async function waitForSuccessfulBilling(client, before, taskId, expectedCharge, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const baselineIds = new Set(before.ids);
  const referenceId = `video-terminal:${taskId}`;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await billingSnapshot(client, before.userId);
    const matching = latest.rows.filter((row) => transactionReference(row) === referenceId);
    const newRows = latest.rows.filter((row) => !baselineIds.has(transactionId(row)));
    const delta = Number((before.balance - latest.balance).toFixed(6));
    const creditsDelta = Number((before.credits - latest.credits).toFixed(6));
    const reservedCreditsDelta = Number((before.reservedCredits - latest.reservedCredits).toFixed(6));
    if (matching.length === 1 && newRows.length === 1 && Math.abs(delta - expectedCharge) <= 0.000001
      && creditsDelta === 0 && reservedCreditsDelta === 0) {
      assert.ok(Math.abs(Math.abs(transactionAmount(matching[0])) - expectedCharge) <= 0.000001, "VIDEO_LEDGER_AMOUNT_MISMATCH");
      return {
        taskId,
        billingExempt: false,
        quotedPriceYuan: expectedCharge,
        balanceAfter: latest.balance,
        balanceDelta: delta,
        creditsAfter: latest.credits,
        creditsDelta,
        reservedCreditsAfter: latest.reservedCredits,
        reservedCreditsDelta,
        newTransactionIds: newRows.map(transactionId),
        referenceId,
        amount: transactionAmount(matching[0]),
        transactionCount: matching.length,
        allTransactionIds: latest.ids,
      };
    }
    await delay(2_000);
  }
  const delta = latest ? Number((before.balance - latest.balance).toFixed(6)) : null;
  const creditsDelta = latest ? Number((before.credits - latest.credits).toFixed(6)) : null;
  const reservedCreditsDelta = latest ? Number((before.reservedCredits - latest.reservedCredits).toFixed(6)) : null;
  throw new Error(`VIDEO_BILLING_NOT_UNIQUE:${referenceId}:${delta}:${creditsDelta}:${reservedCreditsDelta}`);
}

async function assertFailedTaskNotCharged(client, before, taskId) {
  const after = await billingSnapshot(client, before.userId);
  const baselineIds = new Set(before.ids);
  const newRows = after.rows.filter((row) => !baselineIds.has(transactionId(row)));
  const references = new Set([`video-terminal:${taskId}`, `video:${taskId}`]);
  const matching = after.rows.filter((row) => references.has(transactionReference(row)));
  const delta = Number((before.balance - after.balance).toFixed(6));
  const creditsDelta = Number((before.credits - after.credits).toFixed(6));
  const reservedCreditsDelta = Number((before.reservedCredits - after.reservedCredits).toFixed(6));
  assert.equal(delta, 0, `FAILED_VIDEO_CHARGED_BALANCE:${delta}`);
  assert.equal(creditsDelta, 0, `FAILED_VIDEO_CHARGED_CREDITS:${creditsDelta}`);
  assert.equal(reservedCreditsDelta, 0, `FAILED_VIDEO_RESERVED_CREDITS_CHANGED:${reservedCreditsDelta}`);
  assert.equal(newRows.length, 0, `FAILED_VIDEO_ADDED_LEDGER_ROWS:${newRows.map(transactionId).join(",")}`);
  assert.equal(matching.length, 0, "FAILED_VIDEO_HAS_BILLING_REFERENCE");
  return {
    balanceAfter: after.balance,
    balanceDelta: delta,
    creditsAfter: after.credits,
    creditsDelta,
    reservedCreditsAfter: after.reservedCredits,
    reservedCreditsDelta,
    newTransactions: 0,
  };
}

function minimalStoryboardDocument({ runId, projectId, cardId, taskId, modelId, clientRequestId, prompt, priceCharged, billingState }) {
  const now = Date.now();
  return {
    id: projectId,
    title: `同任务视频历史验收 ${runId}`,
    createdAt: now,
    updatedAt: now,
    lastSubmittedAt: now,
    ratio: "16:9",
    imageResolution: "",
    videoResolution: RESOLUTION,
    videoDuration: DURATION_SECONDS,
    imageModelId: "",
    videoModelId: modelId,
    cards: [{
      id: cardId,
      order: 1,
      imagePrompt: "",
      videoPrompt: prompt,
      referenceImageUrls: [],
      imageStatus: "idle",
      videoStatus: "done",
      videoStartedAt: now,
      videoTaskId: taskId,
      videoTaskModelId: modelId,
      videoClientRequestId: clientRequestId,
      videoRetryable: false,
      videoBillingState: billingState || "settled",
      videoPriceCharged: priceCharged,
    }],
  };
}

async function bindOwnedTaskToCanaryProject(client, fixture) {
  const existing = await client.requestJson(`/api/storyboard/projects?id=${encodeURIComponent(fixture.projectId)}`);
  if (existing.response.ok) {
    const project = existing.body?.project;
    const card = project?.document?.cards?.find((item) => item.id === fixture.cardId);
    assert.equal(project?.document?.title, fixture.document.title, "EXISTING_CANARY_PROJECT_TITLE_MISMATCH");
    assert.equal(card?.videoTaskId, fixture.taskId, "EXISTING_CANARY_PROJECT_TASK_MISMATCH");
    assert.ok(card?.videoUrl, "EXISTING_CANARY_PROJECT_TASK_NOT_PLAYABLE");
    return { project, reused: true };
  }
  assert.equal(existing.response.status, 404, `CANARY_PROJECT_PREFLIGHT_HTTP_${existing.response.status}`);
  const saved = await client.requiredJson("/api/storyboard/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document: fixture.document, expectedRevision: 0 }),
  });
  assert.equal(saved?.project?.id, fixture.projectId, "CANARY_PROJECT_SAVE_FAILED");
  const hydrated = await client.requiredJson(`/api/storyboard/projects?id=${encodeURIComponent(fixture.projectId)}`);
  const card = hydrated?.project?.document?.cards?.find((item) => item.id === fixture.cardId);
  assert.equal(card?.videoTaskId, fixture.taskId, "OWNED_TASK_BINDING_NOT_NORMALIZED");
  assert.equal(card?.videoStatus, "done", "OWNED_TASK_BINDING_NOT_COMPLETED");
  assert.ok(card?.videoUrl, "OWNED_TASK_BINDING_PLAYBACK_TICKET_MISSING");
  return { project: hydrated.project, reused: false };
}

async function cleanupCanaryProject(client, fixture, report) {
  const current = await client.requestJson(`/api/storyboard/projects?id=${encodeURIComponent(fixture.projectId)}`);
  if (current.response.status === 404) {
    report.cleanup = {
      projectId: fixture.projectId,
      projectDeleted: true,
      alreadyAbsent: true,
      taskDeleted: false,
      historyDeleted: false,
      billingDeleted: false,
    };
    return;
  }
  assert.ok(current.response.ok, `CANARY_PROJECT_CLEANUP_READ_HTTP_${current.response.status}`);
  const project = current.body?.project;
  const card = project?.document?.cards?.find((item) => item.id === fixture.cardId);
  assert.equal(project?.document?.title, fixture.document.title, "CLEANUP_REFUSED_NON_CANARY_PROJECT");
  assert.equal(card?.videoTaskId, fixture.taskId, "CLEANUP_REFUSED_TASK_MISMATCH");
  await client.requiredJson("/api/storyboard/projects", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: fixture.projectId, expectedRevision: Number(project.revision) }),
  });
  const confirmation = await client.requestJson(`/api/storyboard/projects?id=${encodeURIComponent(fixture.projectId)}`);
  assert.equal(confirmation.response.status, 404, "CANARY_PROJECT_CLEANUP_NOT_CONFIRMED");
  report.cleanup = {
    projectId: fixture.projectId,
    projectDeleted: true,
    taskDeleted: false,
    historyDeleted: false,
    billingDeleted: false,
    preservedTaskId: fixture.taskId,
    note: "仅删除本次临时分镜项目；真实计费任务、视频历史和账务审计保留。",
  };
}

async function launchBrowser() {
  const bundled = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
  try {
    await fs.access(bundled);
    return await chromium.launch({ headless: true, executablePath: bundled });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function attachAuthenticatedPage(browser, identity, token, origin, evidence) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.origin === origin && url.pathname === "/api/video/generate") {
      evidence.generationPosts += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message.slice(0, 500)));
  page.on("console", (message) => {
    if (message.type() === "error") evidence.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (url.origin === origin) evidence.responseFailures.push({
      status: response.status(),
      method: response.request().method(),
      path: url.pathname,
    });
  });
  return { context, page };
}

async function submitVideoThroughUi({ origin, token, identity, report, model, billingBefore, prompt }) {
  await fs.mkdir(report.outputDir, { recursive: true });
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  let clickArmed = false;
  let requestAttempts = 0;
  let continuedPosts = 0;
  let duplicatePostsBlocked = 0;
  let resolveCapture;
  let rejectCapture;
  const capturePromise = new Promise((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  try {
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    await context.route("**/api/video/generate", async (route) => {
      requestAttempts += 1;
      if (!clickArmed || continuedPosts >= 1) {
        duplicatePostsBlocked += 1;
        Object.assign(report.uiSubmission, { requestAttempts, continuedPosts, duplicatePostsBlocked });
        await route.abort("blockedbyclient");
        return;
      }
      try {
        const request = route.request();
        const rawBody = request.postData() || "";
        const body = parseJson(rawBody, null);
        assert.equal(request.method(), "POST", "VIDEO_UI_GENERATION_METHOD_INVALID");
        assert.equal(pathnameOnly(request.url()), "/api/video/generate", "VIDEO_UI_GENERATION_PATH_INVALID");
        assert.equal(body?.model_id, CHEAPEST_MODEL_ID, "VIDEO_UI_MODEL_MISMATCH");
        assert.equal(body?.prompt, prompt, "VIDEO_UI_PROMPT_MISMATCH");
        assert.equal(Number(body?.duration), DURATION_SECONDS, "VIDEO_UI_DURATION_MISMATCH");
        assert.equal(body?.resolution, RESOLUTION, "VIDEO_UI_RESOLUTION_MISMATCH");
        assert.equal(body?.resolution_tier, RESOLUTION, "VIDEO_UI_RESOLUTION_TIER_MISMATCH");
        assert.equal(body?.aspect_ratio, "16:9", "VIDEO_UI_ASPECT_RATIO_MISMATCH");
        assert.equal(body?.surface, "video-page", "VIDEO_UI_SURFACE_MISMATCH");
        const clientRequestId = String(body?.client_request_id || "");
        assert.match(clientRequestId, /^[A-Za-z0-9._:-]{8,200}$/u, "VIDEO_UI_CLIENT_REQUEST_ID_REQUIRED");
        assert.equal(request.headers()["idempotency-key"], clientRequestId, "VIDEO_UI_IDEMPOTENCY_KEY_MISMATCH");
        const dispatch = {
          schemaVersion: 2,
          runId: report.runId,
          createdAt: new Date().toISOString(),
          submissionAuthority: "browser-page-click-only",
          actorId: identity.user.id,
          actorRole: identity.user.role,
          billingExempt: false,
          quotedPriceYuan: model.publicPrice,
          clientRequestId,
          modelId: CHEAPEST_MODEL_ID,
          modelName: model.displayName,
          duration: DURATION_SECONDS,
          resolution: RESOLUTION,
          aspectRatio: "16:9",
          publicPrice: model.publicPrice,
          priceCeilingYuan: PRICE_CEILING_YUAN,
          providerPostLimit: 1,
          providerPosts: 1,
          automaticRetries: 0,
          prompt,
          request: {
            method: request.method(),
            path: pathnameOnly(request.url()),
            modelId: body.model_id,
            duration: Number(body.duration),
            resolution: body.resolution,
            aspectRatio: body.aspect_ratio,
            surface: body.surface,
            clientRequestId,
          },
          billingBefore: {
            userId: billingBefore.userId,
            balance: billingBefore.balance,
            credits: billingBefore.credits,
            reservedCredits: billingBefore.reservedCredits,
            ids: billingBefore.ids,
          },
        };
        await fs.writeFile(
          path.join(report.outputDir, "dispatch.json"),
          `${JSON.stringify(dispatch, null, 2)}\n`,
          { flag: "wx" },
        );
        await route.continue();
        continuedPosts += 1;
        report.providerPosts = continuedPosts;
        Object.assign(report.uiSubmission, {
          requestAttempts,
          continuedPosts,
          duplicatePostsBlocked,
          clientRequestId,
        });
        resolveCapture(dispatch);
      } catch (error) {
        rejectCapture(error);
        await route.abort("blockedbyclient").catch(() => undefined);
      }
    });
    const page = await context.newPage();
    page.on("pageerror", error => report.uiSubmission.pageErrors.push(errorMessage(error).slice(0, 500)));
    page.on("console", message => {
      if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) {
        report.uiSubmission.consoleErrors.push(message.text().slice(0, 500));
      }
    });
    const navigation = await page.goto(`${origin}/video`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(navigation?.status(), 200, "VIDEO_UI_PAGE_LOAD_FAILED");
    await page.locator("[data-video-model-list]").waitFor({ state: "visible", timeout: 30_000 });
    const modelButton = page.locator(`[data-video-model-list] button[data-video-model-id="${CHEAPEST_MODEL_ID}"]`);
    await modelButton.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await modelButton.isEnabled(), true, "VIDEO_UI_MODEL_BUTTON_DISABLED");
    await modelButton.click();
    await page.waitForFunction(modelId => (
      document.querySelector(`[data-video-model-list] button[data-video-model-id="${CSS.escape(modelId)}"]`)
        ?.className.includes("shadow-[inset_3px_0_var(--primary)]")
    ), CHEAPEST_MODEL_ID, { timeout: 30_000 });

    const aspectTrigger = page.getByRole("combobox", { name: "视频比例", exact: true });
    await aspectTrigger.click();
    await page.getByRole("option", { name: "横屏 16:9", exact: true }).click();
    const resolutionTrigger = page.getByRole("combobox", { name: "视频分辨率", exact: true });
    if (await resolutionTrigger.count()) {
      await resolutionTrigger.click();
      await page.getByRole("option").filter({ hasText: /^480p\b/u }).click();
    } else {
      await page.getByText(/^480p\b/u).first().waitFor({ state: "visible", timeout: 10_000 });
    }
    const durationTrigger = page.getByRole("combobox", { name: "默认视频时长", exact: true });
    if (await durationTrigger.count()) {
      await durationTrigger.click();
      await page.getByRole("option").filter({ hasText: /^1秒/u }).click();
    } else {
      await page.getByText(/固定\s*1\s*秒/u).first().waitFor({ state: "visible", timeout: 10_000 });
    }
    const taskCard = page.locator("[data-video-task-card]").first();
    await taskCard.waitFor({ state: "visible", timeout: 30_000 });
    const promptInput = taskCard.getByRole("textbox", { name: "任务1提示词", exact: true });
    await promptInput.fill(prompt);
    assert.equal(await promptInput.inputValue(), prompt, "VIDEO_UI_PROMPT_INPUT_MISMATCH");
    assert.match(await page.locator("body").innerText(), new RegExp(`单条预计：\\s*¥${model.publicPrice.toFixed(2).replace(".", "\\.")}`, "u"), "VIDEO_UI_PRICE_MISMATCH");
    await page.screenshot({ path: path.join(report.outputDir, "video-page-before-submit.png"), fullPage: true });

    const generateButton = taskCard.getByRole("button", { name: "生成视频", exact: true });
    await generateButton.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await generateButton.isEnabled(), true, "VIDEO_UI_GENERATE_BUTTON_DISABLED");
    const responsePromise = page.waitForResponse(response => response.request().method() === "POST"
      && pathnameOnly(response.url()) === "/api/video/generate", { timeout: 240_000 });
    clickArmed = true;
    report.uiSubmission.clickedAt = new Date().toISOString();
    await generateButton.click();
    const [dispatch, response] = await Promise.all([
      withTimeout(capturePromise, 30_000, "VIDEO_UI_GENERATION_REQUEST_NOT_CAPTURED"),
      responsePromise,
    ]);
    const body = await response.json().catch(() => null);
    await page.waitForTimeout(500);
    report.providerPosts = continuedPosts;
    report.uiSubmission = {
      ...report.uiSubmission,
      requestAttempts,
      continuedPosts,
      duplicatePostsBlocked,
      clientRequestId: dispatch.clientRequestId,
      responseHttp: response.status(),
    };
    assert.equal(requestAttempts, 1, "VIDEO_UI_GENERATION_POST_ATTEMPTS_MUST_EQUAL_ONE");
    assert.equal(continuedPosts, 1, "VIDEO_UI_GENERATION_POST_CONTINUATIONS_MUST_EQUAL_ONE");
    assert.equal(duplicatePostsBlocked, 0, "VIDEO_UI_DUPLICATE_GENERATION_POST_DETECTED");
    await page.screenshot({ path: path.join(report.outputDir, "video-page-after-submit.png"), fullPage: true });
    return {
      dispatch,
      submitted: {
        response: { status: response.status(), ok: response.ok() },
        body,
      },
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function playableVideoEvidence(video) {
  await video.waitFor({ state: "visible", timeout: 60_000 });
  const deadline = Date.now() + 120_000;
  let metadata = null;
  while (Date.now() < deadline) {
    metadata = await video.evaluate((element) => ({
      readyState: element.readyState,
      videoWidth: element.videoWidth,
      videoHeight: element.videoHeight,
      duration: element.duration,
      currentTime: element.currentTime,
    }));
    if (metadata.readyState >= 1 && metadata.videoWidth > 0 && metadata.videoHeight > 0 && Number.isFinite(metadata.duration) && metadata.duration > 0) break;
    await delay(500);
  }
  assert.ok(metadata?.readyState >= 1, "BROWSER_VIDEO_METADATA_NOT_READY");
  assert.ok(metadata.videoWidth > 0 && metadata.videoHeight > 0, "BROWSER_VIDEO_DIMENSIONS_INVALID");
  assert.ok(Number.isFinite(metadata.duration) && metadata.duration > 0, "BROWSER_VIDEO_DURATION_INVALID");
  await video.evaluate((element) => element.play().catch(() => undefined));
  await delay(500);
  const played = await video.evaluate((element) => ({ currentTime: element.currentTime, ended: element.ended, paused: element.paused }));
  assert.ok(played.currentTime > 0 || played.ended || !played.paused, "BROWSER_VIDEO_DID_NOT_PLAY");
  return { ...metadata, ...played };
}

async function enterAndExitFullscreen(page, dialog, enterButtonName) {
  const enter = dialog.getByRole("button", { name: enterButtonName, exact: true });
  await enter.click();
  await page.waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 10_000 });
  const entered = await page.evaluate(() => document.fullscreenElement !== null);
  assert.equal(entered, true, "FULLSCREEN_DID_NOT_ENTER");
  const exit = dialog.getByRole("button", { name: "退出全屏", exact: true });
  await exit.click();
  await page.waitForFunction(() => document.fullscreenElement === null, undefined, { timeout: 10_000 });
  return { entered: true, exited: true };
}

async function verifyVideoPageBrowser(page, origin, taskId, outputDir) {
  const openHistory = async () => {
    const historyButton = page.getByRole("button", { name: "历史", exact: true }).first();
    await historyButton.waitFor({ state: "visible", timeout: 60_000 });
    await historyButton.click();
    const card = page.locator(`[data-video-history-task="${taskId}"]`);
    await card.waitFor({ state: "visible", timeout: 60_000 });
    return card;
  };

  await page.goto(`${origin}/video`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const firstCard = await openHistory();
  const trigger = firstCard.getByRole("button", { name: /^放大播放 /u });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  const playback = await playableVideoEvidence(dialog.locator("video"));
  await dialog.getByRole("button", { name: "放大视频", exact: true }).click();
  await dialog.getByText("放大预览 · 当前 110%", { exact: true }).waitFor({ state: "visible" });
  const fullscreen = await enterAndExitFullscreen(page, dialog, "进入全屏");
  await dialog.getByRole("button", { name: "关闭视频预览", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(outputDir, "video-page-history.png"), fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  const restoredCard = await openHistory();
  await restoredCard.getByRole("button", { name: /^放大播放 /u }).click();
  const restoredDialog = page.getByRole("dialog");
  const restoredPlayback = await playableVideoEvidence(restoredDialog.locator("video"));
  await restoredDialog.getByRole("button", { name: "关闭视频预览", exact: true }).click();
  return {
    appearedWithoutRefreshButton: true,
    manualRefreshClicks: 0,
    playback,
    zoomPercent: 110,
    fullscreen,
    reloadRestored: true,
    restoredPlayback,
  };
}

async function verifyStoryboardBrowser(page, origin, fixture, outputDir) {
  const openProjectHistory = async () => {
    const recent = page.getByRole("button", { name: "最近任务", exact: true }).first();
    await recent.waitFor({ state: "visible", timeout: 60_000 });
    await recent.click();
    const project = page.locator(`[data-storyboard-project-id="${fixture.projectId}"]`);
    await project.waitFor({ state: "visible", timeout: 60_000 });
    const video = project.locator(`[data-storyboard-project-video="${fixture.projectId}:${fixture.cardId}"]`);
    await video.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await video.getAttribute("data-video-task-id"), fixture.taskId, "STORYBOARD_BROWSER_TASK_BINDING_MISMATCH");
    return { project, video };
  };

  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const first = await openProjectHistory();
  await first.video.click();
  const dialog = page.getByRole("dialog", { name: "视频放大预览", exact: true });
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  const playback = await playableVideoEvidence(dialog.locator("video"));
  await dialog.getByRole("button", { name: "放大预览", exact: true }).click();
  await dialog.locator('output[aria-label="当前缩放比例"]').filter({ hasText: "110%" }).waitFor({ state: "visible" });
  const fullscreen = await enterAndExitFullscreen(page, dialog, "进入全屏");
  await dialog.getByRole("button", { name: "关闭预览", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(outputDir, "storyboard-bound-project-history.png"), fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  const restored = await openProjectHistory();
  await restored.video.click();
  const restoredDialog = page.getByRole("dialog", { name: "视频放大预览", exact: true });
  const restoredPlayback = await playableVideoEvidence(restoredDialog.locator("video"));
  await restoredDialog.getByRole("button", { name: "关闭预览", exact: true }).click();
  return {
    appearedInProjectHistoryWithoutRefreshButton: true,
    manualRefreshClicks: 0,
    boundTaskId: fixture.taskId,
    playback,
    zoomPercent: 110,
    fullscreen,
    reloadRestored: true,
    restoredPlayback,
  };
}

async function verifyIndependentBrowsers({ origin, token, identity, taskId, fixture, outputDir }) {
  const evidence = {
    independentBrowserProcesses: 2,
    generationPosts: 0,
    pageErrors: [],
    consoleErrors: [],
    responseFailures: [],
  };
  const [videoBrowser, storyboardBrowser] = await Promise.all([launchBrowser(), launchBrowser()]);
  try {
    const [{ context: videoContext, page: videoPage }, { context: storyboardContext, page: storyboardPage }] = await Promise.all([
      attachAuthenticatedPage(videoBrowser, identity, token, origin, evidence),
      attachAuthenticatedPage(storyboardBrowser, identity, token, origin, evidence),
    ]);
    try {
      const [videoPageResult, storyboardResult] = await Promise.all([
        verifyVideoPageBrowser(videoPage, origin, taskId, outputDir),
        verifyStoryboardBrowser(storyboardPage, origin, fixture, outputDir),
      ]);
      evidence.videoPage = videoPageResult;
      evidence.storyboard = storyboardResult;
    } finally {
      await Promise.allSettled([videoContext.close(), storyboardContext.close()]);
    }
  } finally {
    await Promise.allSettled([videoBrowser.close(), storyboardBrowser.close()]);
  }
  assert.equal(evidence.generationPosts, 0, "BROWSER_ATTEMPTED_ADDITIONAL_VIDEO_GENERATION");
  assert.deepEqual(evidence.pageErrors, [], `BROWSER_PAGE_ERRORS:${evidence.pageErrors.join("|")}`);
  const critical = evidence.responseFailures.filter((failure) => [
    "/api/video/history",
    "/api/video/access-ticket",
    "/api/video/proxy",
    "/api/storyboard/projects",
  ].includes(failure.path));
  assert.deepEqual(critical, [], `BROWSER_CRITICAL_HTTP_FAILURES:${JSON.stringify(critical)}`);
  return evidence;
}

async function resolveReconciliationTask(client, clientRequestId) {
  const result = await client.requestJson(`/api/video/request-status?clientRequestId=${encodeURIComponent(clientRequestId)}`);
  assert.ok(result.response.ok, `VIDEO_REQUEST_RECONCILIATION_HTTP_${result.response.status}`);
  return result.body;
}

async function continueAcceptedTask({ client, origin, token, identity, report, dispatch, taskId, externalTaskId, timeoutMs }) {
  const identifiers = new Set([taskId, externalTaskId, dispatch.clientRequestId].filter(Boolean));
  const terminal = await waitForTaskTerminal(client, taskId, dispatch.modelId, timeoutMs, report);
  if (!terminal) {
    report.reconcile = reconciliationGuide(report.runId, dispatch.clientRequestId);
    await saveReport(report.outputDir, report, "progress.json");
    throw new Error("VIDEO_TASK_TERMINAL_TIMEOUT_FAIL_CLOSED");
  }
  report.terminal = terminal;
  if (terminal.status !== "completed") {
    report.failedTaskBilling = await assertFailedTaskNotCharged(client, dispatch.billingBefore, taskId);
    await saveReport(report.outputDir, report, "progress.json");
    throw new Error(`VIDEO_TASK_${terminal.status.toUpperCase()}:${terminal.errorCode || terminal.message || ""}`);
  }
  assert.ok(terminal.videoUrl, "COMPLETED_VIDEO_URL_MISSING");
  const historyTask = await waitForVideoHistory(client, identifiers);
  assert.equal(historyTask.modelId, dispatch.modelId, "VIDEO_HISTORY_MODEL_MISMATCH");
  assert.equal(historyTask.clientRequestId, dispatch.clientRequestId, "VIDEO_HISTORY_REQUEST_ID_MISMATCH");
  const expectedCharge = Number(historyTask.priceCharged || terminal.priceCharged || 0);
  assert.ok(expectedCharge > 0 && expectedCharge <= PRICE_CEILING_YUAN + 1e-9, `VIDEO_CHARGE_OUT_OF_RANGE:${expectedCharge}`);
  assert.ok(Math.abs(expectedCharge - report.quotedPriceYuan) <= 0.000001, `VIDEO_CHARGE_QUOTE_MISMATCH:${expectedCharge}:${report.quotedPriceYuan}`);
  report.history = {
    surface: "video-page",
    id: historyTask.id,
    status: historyTask.status,
    clientRequestId: historyTask.clientRequestId,
    taskIdExternal: historyTask.taskIdExternal || "",
    videoUrlPresent: Boolean(historyTask.videoUrl),
    priceCharged: expectedCharge,
  };
  report.media = await fetchMediaEvidence(origin, client, historyTask.id, report.runId);
  report.billing = await waitForSuccessfulBilling(client, dispatch.billingBefore, historyTask.id, expectedCharge);
  assert.equal(report.actor?.role, "student", "FINAL_STUDENT_ROLE_REQUIRED");
  assert.equal(report.billingExempt, false, "FINAL_NON_EXEMPT_BILLING_REQUIRED");
  assert.ok(report.quotedPriceYuan > 0, "FINAL_POSITIVE_QUOTED_PRICE_REQUIRED");
  assert.equal(report.billing.taskId, historyTask.id, "FINAL_BILLING_TASK_MISMATCH");
  assert.equal(report.billing.creditsDelta, 0, "FINAL_VIDEO_MUST_NOT_CHARGE_CREDITS");
  assert.equal(report.billing.reservedCreditsDelta, 0, "FINAL_VIDEO_MUST_NOT_CHANGE_RESERVED_CREDITS");

  const storyboardSurface = await client.requiredJson("/api/video/history?surface=storyboard-workbench&limit=200&offset=0");
  const leakedAcrossSurface = (storyboardSurface?.tasks || []).some((item) => identifiers.has(String(item.id || "")) || identifiers.has(String(item.taskIdExternal || "")));
  assert.equal(leakedAcrossSurface, false, "VIDEO_PAGE_TASK_LEAKED_INTO_STORYBOARD_GENERATION_HISTORY");
  report.surfaceIsolation = {
    videoPageHistoryContainsTask: true,
    storyboardGenerationHistoryContainsTask: false,
    reason: "生成记录按入口隔离；同一任务通过账号校验后的分镜项目历史绑定复用，不改写 task_label。",
  };

  const fixture = {
    projectId: `sbw-live-${report.runId}`,
    cardId: `sbw-live-card-${report.runId}`,
    taskId: String(historyTask.id),
  };
  fixture.document = minimalStoryboardDocument({
    runId: report.runId,
    projectId: fixture.projectId,
    cardId: fixture.cardId,
    taskId: fixture.taskId,
    modelId: dispatch.modelId,
    clientRequestId: dispatch.clientRequestId,
    prompt: dispatch.prompt,
    priceCharged: expectedCharge,
    billingState: historyTask.billingState || terminal.billingState,
  });
  report.fixture = { projectId: fixture.projectId, cardId: fixture.cardId, taskId: fixture.taskId };
  let primaryError = null;
  try {
    const binding = await bindOwnedTaskToCanaryProject(client, fixture);
    report.storyboardBinding = {
      safeOwnedTaskHydration: true,
      reusedExistingCanaryProject: binding.reused,
      revision: binding.project.revision,
      providerPosts: 0,
    };
    report.browser = await verifyIndependentBrowsers({
      origin,
      token,
      identity,
      taskId: historyTask.id,
      fixture,
      outputDir: report.outputDir,
    });
    const billingFinal = await billingSnapshot(client, dispatch.billingBefore.userId);
    assert.equal(billingFinal.balance, report.billing.balanceAfter, "EXTRA_CHARGE_AFTER_HISTORY_OR_BROWSER_VERIFICATION");
    assert.equal(billingFinal.credits, report.billing.creditsAfter, "EXTRA_CREDIT_CHANGE_AFTER_HISTORY_OR_BROWSER_VERIFICATION");
    assert.equal(billingFinal.reservedCredits, report.billing.reservedCreditsAfter, "EXTRA_RESERVED_CREDIT_CHANGE_AFTER_HISTORY_OR_BROWSER_VERIFICATION");
    assert.deepEqual(new Set(billingFinal.ids), new Set(report.billing.allTransactionIds), "EXTRA_LEDGER_ROW_AFTER_HISTORY_OR_BROWSER_VERIFICATION");
    report.noAdditionalCharge = true;
    report.totalVideoGenerationPosts = Number(dispatch.providerPosts || 1) + report.browser.generationPosts;
    assert.equal(report.totalVideoGenerationPosts, 1, "MORE_THAN_ONE_VIDEO_GENERATION_POST");
  } catch (error) {
    primaryError = error;
  }
  try {
    await cleanupCanaryProject(client, fixture, report);
  } catch (cleanupError) {
    report.cleanup = {
      projectId: fixture.projectId,
      projectDeleted: false,
      taskDeleted: false,
      historyDeleted: false,
      billingDeleted: false,
      error: errorMessage(cleanupError),
      manualAction: "仅核对并删除该 canary projectId；不得删除视频任务、历史或账务记录。",
    };
    if (!primaryError) primaryError = cleanupError;
  }
  await saveReport(report.outputDir, report, "progress.json");
  if (primaryError) throw primaryError;
}

async function main(args = process.argv.slice(2)) {
  const runId = argument(args, "run-id");
  const origin = String(argument(args, "origin", process.env.LOCAL_NAV_ORIGIN || DEFAULT_ORIGIN)).replace(/\/+$/u, "");
  const expectedSourceVersion = argument(args, "expected-source-version");
  const expectedBuildId = argument(args, "expected-build-id");
  const token = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
  const wrapperCustomer = parseJson(process.env.LOCAL_NAV_READONLY_CUSTOMER, null);
  const execute = args.includes("--execute");
  const healthOnly = args.includes("--health-only");
  const reconcile = args.includes("--reconcile");
  const timeoutMs = Number(argument(args, "completion-timeout-ms", "1200000"));
  assert.equal(origin, DEFAULT_ORIGIN, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.match(runId, /^[A-Za-z0-9_-]{8,80}$/u, "UNIQUE_RUN_ID_REQUIRED");
  if (expectedSourceVersion) assert.match(expectedSourceVersion, SAFE_RUNTIME_ID, "EXPECTED_SOURCE_VERSION_INVALID");
  if (expectedBuildId) assert.match(expectedBuildId, SAFE_RUNTIME_ID, "EXPECTED_BUILD_ID_INVALID");
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 1_800_000, "COMPLETION_TIMEOUT_INVALID");
  assert.ok(Number(execute) + Number(healthOnly) + Number(reconcile) <= 1, "MODE_FLAGS_ARE_MUTUALLY_EXCLUSIVE");

  let clientRequestId = "";
  const outputDir = path.resolve(".codex-evidence/video-live-history-full-canary", runId);
  const report = {
    schemaVersion: 1,
    runId,
    clientRequestId,
    origin,
    modelId: CHEAPEST_MODEL_ID,
    duration: DURATION_SECONDS,
    resolution: RESOLUTION,
    priceCeilingYuan: PRICE_CEILING_YUAN,
    startedAt: new Date().toISOString(),
    mode: execute ? "execute" : healthOnly ? "health-only" : reconcile ? "reconcile" : "plan",
    outputDir,
    providerPosts: 0,
    automaticRetries: 0,
    polling: [],
    runtime: null,
    databaseReadiness: {
      ready: false,
      checker: VIDEO_DATABASE_READINESS_CHECKER,
      status: "not-run-in-plan-mode",
    },
    uiSubmission: {
      authority: "browser-page-click-only",
      requestAttempts: 0,
      continuedPosts: 0,
      duplicatePostsBlocked: 0,
      pageErrors: [],
      consoleErrors: [],
    },
  };

  if (!execute && !healthOnly && !reconcile) {
    Object.assign(report, {
      success: true,
      planOnly: true,
      databaseWrites: 0,
      filesystemWrites: 0,
      networkCalls: 0,
      providerPosts: 0,
      automaticRetries: 0,
      requiredExecuteGate: `fresh ${VIDEO_DATABASE_READINESS_CHECKER} local ledger/hash/live semantics/owner/ACL ready result`,
      requiredActor: { role: "student", billingExempt: false },
      executeCommand: `node scripts/with-local-customer-session.mjs scripts/verify-video-live-history-full-canary.mjs --execute --run-id=${runId} --expected-source-version=<sourceVersion> --expected-build-id=<buildId>`,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  assert.ok(token, "R267_CUSTOMER_TOKEN_REQUIRED");
  assert.ok(wrapperCustomer?.id, "LOCAL_CUSTOMER_WRAPPER_IDENTITY_REQUIRED");
  assert.equal(wrapperCustomer?.role, "student", "LOCAL_CUSTOMER_WRAPPER_STUDENT_REQUIRED");
  const client = createClient(origin, token);
  if (execute) {
    assert.match(expectedSourceVersion, SAFE_RUNTIME_ID, "EXPECTED_SOURCE_VERSION_REQUIRED");
    assert.match(expectedBuildId, SAFE_RUNTIME_ID, "EXPECTED_BUILD_ID_REQUIRED");
    report.databaseReadiness = localVideoDatabaseReadiness();
    await saveReport(outputDir, report, "progress.json");
    assert.equal(
      report.databaseReadiness.ready,
      true,
      "VIDEO_DATABASE_SNAPSHOT_READINESS_REQUIRED",
    );
    report.runtime = await runtimeIdentity(client, expectedSourceVersion, expectedBuildId);
    report.billingPolicy = await ordinaryStudentBillingPolicy();
    await saveReport(outputDir, report, "progress.json");
  }
  const preflightResult = reconcile
    ? { identity: await requireOrdinaryStudentIdentity(client, wrapperCustomer), model: null, billing: null }
    : await preflight(client, report, wrapperCustomer);
  if (reconcile) {
    Object.assign(report, {
      actor: { id: preflightResult.identity.user.id, role: preflightResult.identity.user.role },
      role: preflightResult.identity.user.role,
    });
  }
  if (healthOnly) {
    Object.assign(report, {
      success: true,
      completedAt: new Date().toISOString(),
      providerPosts: 0,
      databaseWrites: 0,
      balance: preflightResult.billing.balance,
    });
    await saveReport(outputDir, report, "health.json");
    console.log(JSON.stringify({ success: true, mode: "health-only", model: report.model, balance: report.balance, providerPosts: 0, databaseWrites: 0, report: path.join(outputDir, "health.json") }));
    return;
  }

  let dispatch;
  let taskId = "";
  let externalTaskId = "";
  if (reconcile) {
    dispatch = JSON.parse(await fs.readFile(path.join(outputDir, "dispatch.json"), "utf8"));
    assert.equal(dispatch.runId, runId, "DISPATCH_RUN_ID_MISMATCH");
    assert.equal(dispatch.modelId, CHEAPEST_MODEL_ID, "DISPATCH_MODEL_ID_MISMATCH");
    assert.equal(dispatch.actorId, preflightResult.identity.user.id, "RECONCILE_ACTOR_MISMATCH");
    assert.equal(dispatch.actorRole, "student", "RECONCILE_STUDENT_ACTOR_REQUIRED");
    assert.equal(dispatch.billingExempt, false, "RECONCILE_NON_EXEMPT_TASK_REQUIRED");
    assert.ok(Number(dispatch.quotedPriceYuan) > 0, "RECONCILE_POSITIVE_QUOTE_REQUIRED");
    clientRequestId = String(dispatch.clientRequestId || "");
    assert.match(clientRequestId, /^[A-Za-z0-9._:-]{8,200}$/u, "DISPATCH_CLIENT_REQUEST_ID_MISSING");
    report.clientRequestId = clientRequestId;
    report.dispatchAttemptAlreadyRecorded = true;
    const recovered = await resolveReconciliationTask(client, clientRequestId);
    report.requestReconciliation = recovered;
    if (recovered?.found !== true) {
      report.reconcile = reconciliationGuide(runId, clientRequestId);
      await saveReport(outputDir, report, "progress.json");
      throw new Error(`ORIGINAL_VIDEO_REQUEST_NOT_FOUND:${recovered?.canResubmit === true ? "EXPLICIT_OPERATOR_DECISION_REQUIRED" : "UNKNOWN"}`);
    }
    taskId = String(recovered.businessTaskId || recovered.taskId || "");
    externalTaskId = String(recovered.taskId || "");
    assert.ok(taskId, "RECONCILED_TASK_ID_MISSING");
    Object.assign(report, {
      success: true,
      completedAt: new Date().toISOString(),
      readOnlyReconciliation: true,
      originalRequestFound: true,
      recoveredTaskId: taskId,
      recoveredExternalTaskId: externalTaskId,
      providerPosts: 0,
      databaseWrites: 0,
      automaticRetries: 0,
      nextStep: "Continue observing the original task only; never rerun --execute for this run-id.",
    });
    await saveReport(outputDir, report, "reconcile.json");
    console.log(JSON.stringify({
      success: true,
      mode: "reconcile",
      readOnly: true,
      originalRequestFound: true,
      taskId,
      providerPosts: 0,
      databaseWrites: 0,
      automaticRetries: 0,
      report: path.join(outputDir, "reconcile.json"),
    }));
    return;
  } else {
    const prompt = "清晨的湖面上，一艘白色纸船缓慢向前漂动，固定镜头，柔和自然光，画面稳定，无文字，无水印。";
    let submitted;
    try {
      const uiResult = await submitVideoThroughUi({
        origin,
        token,
        identity: preflightResult.identity,
        report,
        model: preflightResult.model,
        billingBefore: preflightResult.billing,
        prompt,
      });
      dispatch = uiResult.dispatch;
      submitted = uiResult.submitted;
      clientRequestId = dispatch.clientRequestId;
      report.clientRequestId = clientRequestId;
    } catch (error) {
      try {
        dispatch = JSON.parse(await fs.readFile(path.join(outputDir, "dispatch.json"), "utf8"));
        clientRequestId = String(dispatch.clientRequestId || "");
        report.clientRequestId = clientRequestId || null;
      } catch {
        dispatch = null;
      }
      report.submission = { outcome: "unknown", error: errorMessage(error) };
      report.reconcile = clientRequestId
        ? reconciliationGuide(runId, clientRequestId)
        : { automaticRetryForbidden: true, instruction: "页面未捕获可核验的 client_request_id；禁止再次提交，需先人工检查浏览器与服务器请求日志。" };
      await saveReport(outputDir, report, "progress.json");
      throw new Error("VIDEO_SUBMISSION_RESULT_UNKNOWN_FAIL_CLOSED");
    }
    report.submission = {
      http: submitted.response.status,
      taskId: submitted.body?.task_id || null,
      businessTaskId: submitted.body?.business_task_id || null,
      status: submitted.body?.status || null,
      taskSubmitted: submitted.body?.task_submitted ?? null,
      retryable: submitted.body?.retryable ?? null,
      role: preflightResult.identity.user.role,
      billingExempt: false,
      quotedPriceYuan: preflightResult.model.publicPrice,
      errorCode: submitted.body?.error_code || null,
      message: submitted.body?.error || submitted.body?.message || null,
    };
    taskId = String(submitted.body?.business_task_id || submitted.body?.task_id || "");
    externalTaskId = String(submitted.body?.task_id || "");
    if (!taskId) {
      const definitelyRejected = submitted.body?.task_submitted === false && submitted.response.status >= 400;
      if (definitelyRejected) {
        report.rejectedBilling = await assertFailedTaskNotCharged(client, dispatch.billingBefore, clientRequestId);
        await saveReport(outputDir, report, "progress.json");
        throw new Error(`VIDEO_SUBMISSION_REJECTED:${report.submission.errorCode || submitted.response.status}`);
      }
      report.reconcile = reconciliationGuide(runId, clientRequestId);
      await saveReport(outputDir, report, "progress.json");
      throw new Error("VIDEO_SUBMISSION_NO_TASK_RECEIPT_FAIL_CLOSED");
    }
  }

  await continueAcceptedTask({
    client,
    origin,
    token,
    identity: preflightResult.identity,
    report,
    dispatch,
    taskId,
    externalTaskId,
    timeoutMs,
  });
  Object.assign(report, {
    success: true,
    completedAt: new Date().toISOString(),
    automaticRetries: 0,
  });
  await saveReport(outputDir, report);
  console.log(JSON.stringify({
    success: true,
    mode: report.mode,
    taskId: report.history.id,
    providerPosts: report.totalVideoGenerationPosts,
    automaticRetries: 0,
    balanceDelta: report.billing.balanceDelta,
    cleanup: report.cleanup,
    report: path.join(outputDir, "report.json"),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(async (error) => {
    const args = process.argv.slice(2);
    const runId = argument(args, "run-id", "invalid-run-id");
    const outputDir = path.resolve(".codex-evidence/video-live-history-full-canary", runId);
    const progressPath = path.join(outputDir, "progress.json");
    let progress = {};
    try {
      progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
    } catch {
      progress = {};
    }
    let dispatch = {};
    try {
      dispatch = JSON.parse(await fs.readFile(path.join(outputDir, "dispatch.json"), "utf8"));
    } catch {
      dispatch = {};
    }
    const knownClientRequestId = String(progress.clientRequestId || dispatch.clientRequestId || "");
    const failure = {
      ...progress,
      success: false,
      failedAt: new Date().toISOString(),
      runnerError: errorMessage(error).slice(0, 1_600),
      automaticRetries: 0,
      reconcile: progress.reconcile || (knownClientRequestId
        ? reconciliationGuide(runId, knownClientRequestId)
        : {
            automaticRetryForbidden: true,
            submissionAttempted: false,
            instruction: "没有捕获到 client_request_id；不得运行 --reconcile 或重新提交，先解决执行前门禁。",
          }),
    };
    await saveReport(outputDir, failure, "failure.json").catch(() => undefined);
    console.error(JSON.stringify({ success: false, runnerError: failure.runnerError, reconcile: failure.reconcile, report: path.join(outputDir, "failure.json") }));
    process.exitCode = 1;
  });
}

export { main };
