#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";
import sharp from "sharp";

const projectRoot = process.cwd();
const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.equal(origin, "http://127.0.0.1:5000", "Paid cover acceptance is restricted to the canonical local preview");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.ok(token, "A verified local administrator session is required");

const executePaid = process.argv.includes("--execute-paid-cover-b3");
const resumeLatestClaimed = process.argv.includes("--resume-latest-claimed");
const resumeRun = process.argv.includes("--resume-run");
const runArgument = process.argv.find((value) => value.startsWith("--run-id="));
const runId = runArgument?.slice("--run-id=".length)
  || `cover-paid-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
assert.match(runId, /^[a-zA-Z0-9_-]{6,100}$/u, "Invalid run id");

const maximumSpendYuan = 2;
const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "The acceptance runtime must be local-only");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "The acceptance database must be local");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "Unexpected local database port");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "Unexpected local database name");

const evidenceRoot = path.resolve(".codex-evidence/cover-paid-b3-20260928");
const outputDir = path.join(evidenceRoot, runId);
const reportPath = path.join(outputDir, "report.json");
const networkPath = path.join(outputDir, "network.jsonl");
await fs.mkdir(outputDir, { recursive: true });

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const money = (value) => Math.round(Number(value) * 100) / 100;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const safeKey = (value) => {
  const text = String(value || "");
  return text.length > 22 ? `${text.slice(0, 14)}…${text.slice(-6)}` : text;
};

const scenarios = [
  {
    key: "01-text-cartoon-gpt25-3x4",
    source: "文案直出",
    sourceKind: "text",
    style: "卡通风格",
    modelLabel: "GPT Image 2.5",
    modelId: "pm_PZ3hS353YQNbfRnz2_9Ro0aX",
    ratio: "3:4",
    expectedReferences: 0,
  },
  {
    key: "02-text-funny-seedream-9x16",
    source: "文案直出",
    sourceKind: "text",
    style: "卡通搞怪",
    modelLabel: "豆包 5.0",
    modelId: "pm_7y8qxRpEQYgNuYBVvqL4MJgs",
    ratio: "9:16",
    expectedReferences: 0,
  },
  {
    key: "03-template-cartoon-banana-4x3",
    source: "参考模板",
    sourceKind: "template",
    style: "卡通风格",
    modelLabel: "Banana",
    modelId: "pm_sHaGkgaNoH1ZgQzpHW2dEUyF",
    ratio: "4:3",
    expectedReferences: 1,
  },
  {
    key: "04-upload-first-result-funny-banana-16x9",
    source: "上传参考图",
    sourceKind: "upload",
    style: "卡通搞怪",
    modelLabel: "Banana",
    modelId: "pm_sHaGkgaNoH1ZgQzpHW2dEUyF",
    ratio: "16:9",
    expectedReferences: 1,
  },
];

const expectedDimensions = {
  "16:9": [2048, 1152],
  "9:16": [1152, 2048],
  "4:3": [2048, 1536],
  "3:4": [1536, 2048],
};

const petBrief = [
  "你以为狗狗每天趴在门口，是因为无聊吗？其实它在等一个对它来说最重要的人回家。",
  "研究发现，小狗会记住主人的脚步声、电梯声和开门的节奏。",
  "它不懂你为什么离开，却会把每一次等待都当成承诺。",
  "你推门的一刻，它摇尾巴冲过来，不只是开心，而是在告诉你：我一直相信你会回来。",
].join("");

const db = new pg.Client(runtime.ownerConnection);
await db.connect();

async function query(text, parameters = []) {
  return (await db.query(text, parameters)).rows;
}

async function getBalance(userId) {
  const rows = await query("select cash_balance from public.users where id=$1", [userId]);
  assert.equal(rows.length, 1, "Acceptance user disappeared");
  return money(rows[0].cash_balance);
}

async function getActiveAttempts(userId) {
  return query(`select id::text,state,client_idempotency_key,created_at
    from public.cover_generation_attempts
    where user_id::text=$1 and state in ('claimed','dispatched','generated','rendering')
    order by created_at`, [userId]);
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = 30_000, ...fetchOptions } = options;
  const response = await fetch(url, {
    ...fetchOptions,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

const identity = await fetchJson(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
});
assert.ok(identity.response.ok && identity.body?.user?.id, "The current local browser identity is unavailable");
const actor = identity.body.user;
assert.equal(actor.role, "admin", "The paid canary must use the currently authorized administrator account");
const actorFingerprint = sha256(String(actor.id)).slice(0, 12);

const localBuildId = (await fs.readFile(path.join(projectRoot, ".next", "BUILD_ID"), "utf8")).trim();
const version = await fetchJson(`${origin}/api/version`);
assert.equal(version.response.status, 200, "The local version endpoint is unavailable");
assert.equal(version.body?.buildId, localBuildId, "The served runtime is not the current local build");

const catalog = await fetchJson(`${origin}/api/cover-models?surface=cover-studio`, {
  headers: { Authorization: `Bearer ${token}` },
});
assert.ok(catalog.response.ok && Array.isArray(catalog.body?.models), "The cover model catalog is unavailable");
const historyPreflight = await fetchJson(`${origin}/api/cover/history?page=1`, {
  headers: { Authorization: `Bearer ${token}` },
});
assert.ok(historyPreflight.response.ok && Array.isArray(historyPreflight.body?.records), "Cover history reconciliation is unavailable");
const catalogById = new Map(catalog.body.models.map((model) => [model.id, model]));
for (const scenario of scenarios) {
  const model = catalogById.get(scenario.modelId);
  assert.ok(model, `${scenario.modelLabel} is missing from the cover catalog`);
  assert.equal(model.capabilities?.available, true, `${scenario.modelLabel} is not available`);
  assert.equal(model.capabilities?.priceReady, true, `${scenario.modelLabel} price is not ready`);
  assert.ok(Number.isFinite(Number(model.publicPrice)) && Number(model.publicPrice) > 0, `${scenario.modelLabel} has no paid price`);
  if (scenario.expectedReferences) {
    assert.equal(model.capabilities?.supportsReferenceInput, true, `${scenario.modelLabel} cannot accept the required reference`);
  }
  scenario.price = money(model.publicPrice);
  scenario.resolution = String(model.capabilities?.defaultResolution || "");
}
const plannedSpendYuan = money(scenarios.reduce((sum, scenario) => sum + scenario.price, 0));
assert.ok(plannedSpendYuan <= maximumSpendYuan, `Planned spend ¥${plannedSpendYuan} exceeds the ¥${maximumSpendYuan} cap`);

const currentStartingBalance = await getBalance(actor.id);
assert.ok(currentStartingBalance >= maximumSpendYuan, "The current account does not have enough cash for the capped canary");
let priorReport = null;
if (resumeRun) {
  assert.equal(executePaid, true, "A resumed run must use the paid execution gate");
  priorReport = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(priorReport?.schema, "cover_paid_b3_e2e.v1", "The prior report schema is not resumable");
  assert.equal(priorReport?.runId, runId, "The prior report belongs to another run");
  assert.equal(priorReport?.actorFingerprint, actorFingerprint, "The prior report belongs to another account");
  assert.equal(priorReport?.buildId, localBuildId, "The prior report belongs to another build");
}
const initialBalance = money(priorReport?.initialBalance ?? currentStartingBalance);
const activeBefore = await getActiveAttempts(actor.id);
if (resumeLatestClaimed) {
  assert.equal(activeBefore.length, 1, "Exactly one active cover attempt is required for guarded recovery");
  assert.equal(activeBefore[0].state, "claimed", "Only a pre-dispatch claimed attempt can be recovered this way");
  const claimedRows = await query(`select user_id::text,client_idempotency_key,client_trace_id,state,generation_input,
      requires_reference_reupload,created_at
    from public.cover_generation_attempts where id::text=$1 and user_id::text=$2`, [activeBefore[0].id, actor.id]);
  assert.equal(claimedRows.length, 1, "The claimed cover attempt disappeared");
  const claimed = claimedRows[0];
  assert.equal(claimed.requires_reference_reupload, false, "Reference-bearing attempts require a browser re-upload");
  assert.ok(Date.now() - Date.parse(claimed.created_at) < 10 * 60 * 1000, "The claimed attempt is too old to dispatch safely");
  const priorImageRows = await query(`select record_id,state from public.image_generation_requests
    where user_id=$1 and client_idempotency_key=$2 and client_trace_id=$3`, [actor.id, claimed.client_idempotency_key, claimed.client_trace_id]);
  assert.deepEqual(priorImageRows, [], "The claimed attempt already has an image request");
  const beforeResumeBalance = await getBalance(actor.id);
  const recovered = await fetchJson(`${origin}/api/cover/attempt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "dispatch",
      clientIdempotencyKey: claimed.client_idempotency_key,
      clientTraceId: claimed.client_trace_id,
      payload: { ...claimed.generation_input, referenceImageUrls: [] },
    }),
    timeoutMs: 360_000,
  });
  const afterResumeBalance = await getBalance(actor.id);
  const safeResult = {
    mode: "guarded-same-key-recovery",
    runId,
    requestKey: safeKey(claimed.client_idempotency_key),
    httpStatus: recovered.response.status,
    success: recovered.body?.success === true,
    completed: recovered.body?.completed === true,
    code: recovered.body?.code || null,
    error: recovered.body?.error || null,
    message: recovered.body?.message || null,
    backgroundAssetId: recovered.body?.backgroundAssetId || null,
    resultAssetId: recovered.body?.result?.assetId || null,
    historyRecordId: recovered.body?.result?.historyRecordId || null,
    persisted: recovered.body?.result?.persisted === true,
    cloudStored: recovered.body?.result?.cloudStored === true,
    balanceBefore: beforeResumeBalance,
    balanceAfter: afterResumeBalance,
    balanceDelta: money(beforeResumeBalance - afterResumeBalance),
  };
  await fs.writeFile(path.join(outputDir, "guarded-recovery.json"), `${JSON.stringify(safeResult, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(safeResult, null, 2));
  await db.end();
  process.exit(recovered.response.ok && recovered.body?.completed === true ? 0 : 1);
}
assert.deepEqual(activeBefore, [], "Resolve existing active cover attempts before paid testing");

const report = priorReport || {
  schema: "cover_paid_b3_e2e.v1",
  runId,
  mode: executePaid ? "paid-execution" : "preflight-only",
  startedAt: new Date().toISOString(),
  localOnly: true,
  origin,
  buildId: localBuildId,
  actorFingerprint,
  maximumSpendYuan,
  plannedSpendYuan,
  initialBalance,
  scenarios: scenarios.map((scenario) => ({
    key: scenario.key,
    source: scenario.source,
    style: scenario.style,
    modelLabel: scenario.modelLabel,
    modelId: scenario.modelId,
    ratio: scenario.ratio,
    resolution: scenario.resolution,
    quotedPriceYuan: scenario.price,
    expectedReferences: scenario.expectedReferences,
    state: "planned",
  })),
  paidDispatches: 0,
  completed: 0,
  failed: 0,
};
if (priorReport) {
  report.mode = "paid-execution-resume";
  report.resumedAt = new Date().toISOString();
  delete report.finishedAt;
  delete report.stoppedAt;
  delete report.stopReason;
  delete report.ok;
  for (const scenario of scenarios) {
    const saved = report.scenarios.find((item) => item.key === scenario.key);
    assert.ok(saved, `The prior report is missing ${scenario.key}`);
    assert.equal(saved.modelId, scenario.modelId, `${scenario.key} model changed between runs`);
    assert.equal(saved.ratio, scenario.ratio, `${scenario.key} ratio changed between runs`);
    assert.equal(money(saved.quotedPriceYuan), scenario.price, `${scenario.key} price changed between runs`);
  }
}

async function saveReport() {
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function journal(event) {
  await fs.appendFile(networkPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

await saveReport();
if (!executePaid) {
  console.log(JSON.stringify({
    ok: true,
    mode: report.mode,
    runId,
    buildId: localBuildId,
    actorFingerprint,
    initialBalance,
    plannedSpendYuan,
    maximumSpendYuan,
    scenarios: report.scenarios,
    paidCalls: 0,
    report: reportPath,
  }, null, 2));
  await db.end();
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL: origin,
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  serviceWorkers: "block",
  colorScheme: "light",
});
await context.addInitScript(({ authToken, user }) => {
  localStorage.setItem("auth_token", authToken);
  localStorage.setItem("auth_user", JSON.stringify(user));
  localStorage.setItem("user_theme_preference", "light");
}, { authToken: token, user: actor });

const page = await context.newPage();
let currentScenario = null;
const dispatches = new Map();
const pageErrors = [];

page.on("pageerror", (error) => {
  pageErrors.push({ name: error.name, message: error.message.slice(0, 500) });
});
page.on("requestfailed", (request) => {
  const target = new URL(request.url());
  if (target.origin === origin) {
    void journal({ type: "request-failed", path: target.pathname, method: request.method(), error: request.failure()?.errorText || "" });
  }
});

await context.route("**/api/cover/attempt**", async (route) => {
  const request = route.request();
  if (request.method() !== "POST") return route.continue();
  let body;
  try {
    body = request.postDataJSON();
  } catch {
    await journal({ type: "blocked-non-json-cover-attempt" });
    return route.abort();
  }
  const scenario = currentScenario;
  if (!scenario || !["claim", "dispatch"].includes(body?.action)) return route.continue();
  const key = String(body.clientIdempotencyKey || "");
  const trace = String(body.clientTraceId || "");
  assert.match(key, /^cover_[a-f0-9-]{36}$/u, "Unexpected cover request key");
  assert.equal(trace, key, "Cover trace and idempotency keys diverged");

  if (body.action === "claim") {
    assert.equal(Number(body.referenceCount || 0), scenario.expectedReferences, "Claim reference count is incorrect");
    await journal({
      type: "claim",
      scenario: scenario.key,
      key: safeKey(key),
      referenceCount: Number(body.referenceCount || 0),
      taskId: String(body.task?.id || ""),
      titleHash: sha256(String(body.task?.title || "")),
    });
    return route.continue();
  }

  if (dispatches.has(scenario.key)) {
    await journal({ type: "blocked-duplicate-dispatch", scenario: scenario.key, key: safeKey(key) });
    return route.abort();
  }
  const payload = body.payload || {};
  const references = Array.isArray(payload.referenceImageUrls) ? payload.referenceImageUrls : [];
  assert.equal(payload.modelId, scenario.modelId, "The submitted model does not match the visible selection");
  assert.equal(payload.aspectRatio, scenario.ratio, "The submitted ratio does not match the visible selection");
  assert.equal(payload.resolution, scenario.resolution, "The submitted resolution does not match the catalog default");
  assert.equal(references.length, scenario.expectedReferences, "The submitted reference count is incorrect");
  assert.match(String(payload.style || ""), new RegExp(scenario.style, "u"), "The submitted style is incorrect");
  assert.match(String(payload.style || ""), new RegExp(scenario.source, "u"), "The submitted source is incorrect");
  const dispatch = {
    scenario: scenario.key,
    key,
    trace,
    modelId: payload.modelId,
    ratio: payload.aspectRatio,
    resolution: payload.resolution,
    style: payload.style,
    promptLength: String(payload.prompt || "").length,
    promptHash: sha256(String(payload.prompt || "")),
    referenceCount: references.length,
    referenceProof: references.map((reference) => ({ bytes: String(reference).length, sha256: sha256(String(reference)) })),
    dispatchedAt: new Date().toISOString(),
  };
  dispatches.set(scenario.key, dispatch);
  Object.assign(report.scenarios.find((item) => item.key === scenario.key), {
    state: "dispatched",
    stableRequestKey: safeKey(key),
    dispatch: { ...dispatch, key: safeKey(key), trace: safeKey(trace) },
  });
  report.paidDispatches = report.scenarios.filter((item) => item.dispatch).length;
  await journal({ type: "dispatch", ...dispatch, key: safeKey(key), trace: safeKey(trace) });
  await saveReport();
  return route.continue();
});

async function waitForCoverTerminal(scenario, timeoutMs = 420_000) {
  const status = page.locator(".cover-result-toolbar-title > span");
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let uncertaintyJournaled = false;
  while (Date.now() < deadline) {
    lastStatus = String(await status.textContent().catch(() => "")).trim();
    if (lastStatus === "已完成") return lastStatus;
    if (lastStatus === "结果待确认" && !uncertaintyJournaled) {
      uncertaintyJournaled = true;
      await journal({ type: "transient-result-uncertain", scenario: scenario.key });
    }
    if (["生成失败", "已终止"].includes(lastStatus)) {
      const message = String(await page.locator(".cover-main-state").textContent().catch(() => "")).trim();
      throw new Error(`${scenario.key} ended as ${lastStatus}: ${message.slice(0, 500)}`);
    }
    await sleep(2_000);
  }
  throw new Error(`${scenario.key} did not reach a terminal UI state within ${timeoutMs}ms; last status: ${lastStatus}`);
}

async function auditDatabase(scenario, dispatch, downloaded) {
  const coverRows = await query(`select id::text,state,client_idempotency_key,client_trace_id,task,generation_input,
      requires_reference_reupload,background_asset_id::text,result_asset_id::text,history_record_id,error_code,
      created_at,dispatched_at,completed_at,cancelled_at
    from public.cover_generation_attempts
    where user_id::text=$1 and client_idempotency_key=$2 and client_trace_id=$3`, [actor.id, dispatch.key, dispatch.trace]);
  assert.equal(coverRows.length, 1, "Expected exactly one durable cover attempt");
  const cover = coverRows[0];
  assert.equal(cover.state, "completed", "The durable cover attempt is not completed");
  assert.ok(cover.background_asset_id && cover.result_asset_id && cover.history_record_id, "The durable cover attempt has no delivered assets");
  assert.equal(cover.requires_reference_reupload, scenario.expectedReferences > 0, "Reference persistence flag is incorrect");
  assert.equal(cover.generation_input?.modelId, scenario.modelId, "Durable model snapshot mismatch");
  assert.equal(cover.generation_input?.aspectRatio, scenario.ratio, "Durable ratio snapshot mismatch");
  assert.equal(cover.generation_input?.referenceImageUrls?.length || 0, 0, "Reference bytes leaked into the durable snapshot");

  const imageRows = await query(`select record_id,state,delivery_state,delivery_asset_id,request_snapshot,response,created_at,updated_at
    from public.image_generation_requests
    where user_id=$1 and client_idempotency_key=$2 and client_trace_id=$3`, [actor.id, dispatch.key, dispatch.trace]);
  assert.equal(imageRows.length, 1, "Expected exactly one upstream image request");
  const image = imageRows[0];
  assert.equal(image.state, "completed", "The image request is not completed");
  assert.equal(image.delivery_state, "delivered", "The image request is not delivered");
  assert.equal(image.delivery_asset_id, cover.background_asset_id, "The delivered background asset is not linked to the cover attempt");
  assert.equal(image.request_snapshot?.publicModelId, scenario.modelId, "The billed public model does not match the UI selection");
  assert.equal(image.request_snapshot?.aspectRatio, scenario.ratio, "The billed aspect ratio does not match the UI selection");
  assert.equal(Number(image.request_snapshot?.referenceAssetRefs?.length || 0), scenario.expectedReferences, "The billed reference count is incorrect");
  assert.equal(money(image.request_snapshot?.quotedPriceYuan), scenario.price, "The billed quote does not match the catalog price");

  const backgroundRows = await query(`select id::text,file_name,file_size,content_type,storage_provider,meta
    from public.user_files where id::text=$1 and user_id::text=$2`, [cover.background_asset_id, actor.id]);
  assert.equal(backgroundRows.length, 1, "The generated background asset is missing");
  const background = backgroundRows[0];
  const billingReferenceId = String(background.meta?.billingReferenceId || "");
  assert.match(billingReferenceId, /^image:h3_[a-f0-9]{48}$/u, "The background asset has no stable billing reference");

  const resultRows = await query(`select id::text,file_name,file_size,content_type,storage_provider,meta
    from public.user_files where id::text=$1 and user_id::text=$2`, [cover.result_asset_id, actor.id]);
  assert.equal(resultRows.length, 1, "The composed cover asset is missing");
  const historyRows = await query(`select asset_id::text,background_asset_id::text,history_record_id,plan,
      output_width,output_height,source_width,source_height,task_no,created_at
    from public.cover_generation_history where user_id::text=$1 and asset_id::text=$2`, [actor.id, cover.result_asset_id]);
  assert.equal(historyRows.length, 1, "The cover history row is missing");
  const history = historyRows[0];
  assert.equal(history.background_asset_id, cover.background_asset_id, "Cover history points to the wrong background");
  assert.equal(history.history_record_id, cover.history_record_id, "Cover history id mismatch");
  assert.equal(history.plan?.aspectRatio, scenario.ratio, "Cover history ratio mismatch");
  assert.equal(history.output_width, downloaded.width, "Downloaded width does not match the persisted cover");
  assert.equal(history.output_height, downloaded.height, "Downloaded height does not match the persisted cover");

  const walletRows = await query(`select id::text,wallet,operation_kind,idempotency_key,amount,delta,status,balance_before,balance_after
    from public.wallet_operations where user_id=$1 and idempotency_key=$2`, [actor.id, billingReferenceId]);
  assert.equal(walletRows.length, 1, "Expected exactly one wallet charge");
  const wallet = walletRows[0];
  assert.equal(wallet.wallet, "cash", "Cover generation used the wrong wallet");
  assert.equal(wallet.operation_kind, "cash_charge", "Cover generation has no cash charge");
  assert.equal(wallet.status, "completed", "Cover wallet charge is not completed");
  assert.equal(money(wallet.amount), scenario.price, "Wallet charge does not match the quote");
  assert.equal(money(wallet.delta), -scenario.price, "Wallet delta does not match the quote");
  assert.equal(money(Number(wallet.balance_before) - Number(wallet.balance_after)), scenario.price, "Wallet before/after balances do not reconcile");

  const ledgerRows = await query(`select id::text,operation_id::text,wallet,operation_kind,idempotency_key,delta,balance_before,balance_after
    from public.wallet_ledger_entries where user_id=$1 and idempotency_key=$2`, [actor.id, billingReferenceId]);
  assert.equal(ledgerRows.length, 1, "Expected exactly one wallet ledger entry");
  assert.equal(ledgerRows[0].operation_id, wallet.id, "Wallet ledger is not linked to the charge");
  assert.equal(money(ledgerRows[0].delta), -scenario.price, "Wallet ledger delta is incorrect");

  const cashRows = await query(`select id::text,amount,balance_after,type,reference_id
    from public.cash_transactions where user_id::text=$1 and reference_id=$2`, [actor.id, billingReferenceId]);
  assert.equal(cashRows.length, 1, "Expected exactly one cash transaction");
  assert.equal(cashRows[0].type, "consume", "The cash transaction is not a consumption record");
  assert.equal(money(cashRows[0].amount), scenario.price, "Cash transaction amount is incorrect");

  const revenueRows = await query(`select model_id,task_id,cost_price,selling_price,profit,is_admin,billing_exempt,
      record_type,cash_charged,created_at from public.revenue_records
    where user_id::text=$1 and task_id=$2 and record_type='image'`, [actor.id, billingReferenceId]);
  assert.equal(revenueRows.length, 1, "Expected exactly one image revenue record");
  const revenue = revenueRows[0];
  assert.equal(money(revenue.selling_price), scenario.price, "Revenue selling price is incorrect");
  assert.equal(money(revenue.cash_charged), scenario.price, "Revenue cash charge is incorrect");
  assert.equal(revenue.billing_exempt, false, "The paid canary was incorrectly marked billing-exempt");
  assert.equal(money(Number(revenue.selling_price) - Number(revenue.cost_price)), money(revenue.profit), "Revenue profit does not reconcile");
  assert.equal(money(background.meta?.quotedPriceYuan), scenario.price, "Asset billing metadata quote is incorrect");
  assert.equal(money(background.meta?.actualCostPriceYuan), money(revenue.cost_price), "Asset cost and revenue cost differ");

  return {
    coverAttempt: {
      state: cover.state,
      attemptId: cover.id,
      backgroundAssetId: cover.background_asset_id,
      resultAssetId: cover.result_asset_id,
      historyRecordId: cover.history_record_id,
      dispatchedAt: cover.dispatched_at,
      completedAt: cover.completed_at,
    },
    imageRequest: {
      recordId: image.record_id,
      state: image.state,
      deliveryState: image.delivery_state,
      selectedInternalModelId: image.response?.selectedModelId || "",
      actualCostPriceYuan: money(image.response?.selectedCostPrice),
      referenceAssetRefs: image.request_snapshot?.referenceAssetRefs || [],
    },
    billing: {
      referenceId: billingReferenceId,
      walletOperationId: wallet.id,
      chargedYuan: money(wallet.amount),
      balanceBefore: money(wallet.balance_before),
      balanceAfter: money(wallet.balance_after),
      ledgerEntryId: ledgerRows[0].id,
      cashTransactionId: cashRows[0].id,
      costYuan: money(revenue.cost_price),
      sellingYuan: money(revenue.selling_price),
      profitYuan: money(revenue.profit),
      billingExempt: revenue.billing_exempt,
    },
    history: {
      taskNo: history.task_no,
      outputWidth: history.output_width,
      outputHeight: history.output_height,
      sourceWidth: history.source_width,
      sourceHeight: history.source_height,
    },
    assets: {
      backgroundBytes: Number(background.file_size),
      resultBytes: Number(resultRows[0].file_size),
      storageProvider: resultRows[0].storage_provider,
    },
  };
}

async function chooseDifferentTemplate() {
  await page.getByRole("button", { name: "浏览模板库", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择模板版式", exact: true });
  await dialog.waitFor({ state: "visible", timeout: 15_000 });
  const options = dialog.getByRole("option");
  const count = await options.count();
  assert.ok(count >= 2, "Template library did not expose multiple templates");
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (await option.getAttribute("aria-selected") !== "true") {
      const label = String(await option.textContent()).replace(/\s+/gu, " ").trim();
      await option.click();
      return label;
    }
  }
  throw new Error("No alternative template was selectable");
}

async function validateCompletedResult(scenario, dispatch, reportScenario, { recoverFromHistory = false } = {}) {
  if (recoverFromHistory) {
    await page.goto(`${origin}/cover`, { waitUntil: "load", timeout: 60_000 });
    await page.getByRole("button", { name: new RegExp(scenario.modelLabel, "u") }).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: /^历史记录/u }).click();
    const recoveryHistory = page.getByRole("dialog", { name: "封面历史记录", exact: true });
    await recoveryHistory.waitFor({ state: "visible", timeout: 15_000 });
    const completedTask = recoveryHistory.locator(".cover-task-day-group button").filter({ hasText: "完成" }).first();
    await completedTask.waitFor({ state: "visible", timeout: 30_000 });
    await completedTask.click();
    await recoveryHistory.getByRole("button", { name: "关闭历史记录", exact: true }).click();
    await journal({ type: "resumed-completed-result", scenario: scenario.key, key: safeKey(dispatch.key) });
  }

  const resultImage = page.locator(".cover-result-image-button img");
  await resultImage.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => {
    const image = document.querySelector(".cover-result-image-button img");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }, null, { timeout: 60_000 });
  const browserImage = await resultImage.evaluate((image) => ({
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    alt: image.alt,
  }));

  await page.getByRole("button", { name: "放大查看封面", exact: true }).click();
  const previewDialog = page.getByRole("dialog", { name: "封面大图预览", exact: true });
  await previewDialog.waitFor({ state: "visible", timeout: 15_000 });
  await previewDialog.locator("img").waitFor({ state: "visible", timeout: 15_000 });
  const previewImage = await previewDialog.locator("img").evaluate((image) => ({
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  }));
  assert.ok(previewImage.naturalWidth > 0 && previewImage.naturalHeight > 0, "Large preview did not decode");
  await previewDialog.getByRole("button", { name: "关闭封面大图预览", exact: true }).click();

  await page.getByRole("button", { name: /^历史记录/u }).click();
  const historyDialog = page.getByRole("dialog", { name: "封面历史记录", exact: true });
  await historyDialog.waitFor({ state: "visible", timeout: 15_000 });
  const activeHistory = historyDialog.locator(".cover-task-day-group button.is-active");
  await activeHistory.waitFor({ state: "visible", timeout: 15_000 });
  const activeHistoryText = String(await activeHistory.textContent()).replace(/\s+/gu, " ").trim();
  assert.match(activeHistoryText, /完成/u, "The current result is not completed in account history");
  const historyItemCount = await historyDialog.locator(".cover-task-day-group button").count();
  await historyDialog.getByRole("button", { name: "关闭历史记录", exact: true }).click();

  const downloadEvent = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "下载", exact: true }).click();
  const download = await downloadEvent;
  const temporaryDownload = path.join(outputDir, `${scenario.key}-download.bin`);
  await download.saveAs(temporaryDownload);
  const bytes = await fs.readFile(temporaryDownload);
  assert.ok(bytes.length > 1_000 && bytes.length <= 25 * 1024 * 1024, "Downloaded cover size is invalid");
  const metadata = await sharp(bytes).metadata();
  assert.ok(metadata.width && metadata.height && metadata.format, "Downloaded cover cannot be decoded");
  const [expectedWidth, expectedHeight] = expectedDimensions[scenario.ratio];
  const [ratioWidth, ratioHeight] = scenario.ratio.split(":").map(Number);
  const expectedRatio = ratioWidth / ratioHeight;
  const actualRatio = metadata.width / metadata.height;
  assert.ok(Math.abs(actualRatio - expectedRatio) / expectedRatio <= 0.025, "Downloaded cover ratio is incorrect");
  assert.ok(
    metadata.width >= expectedWidth * 0.8 && metadata.height >= expectedHeight * 0.8,
    "Downloaded cover is below the 2K delivery floor",
  );
  const extension = metadata.format === "jpeg" ? "jpg" : metadata.format;
  const finalDownload = path.join(outputDir, `${scenario.key}-cover.${extension}`);
  await fs.rm(finalDownload, { force: true });
  await fs.rename(temporaryDownload, finalDownload);

  const database = await auditDatabase(scenario, dispatch, {
    width: metadata.width,
    height: metadata.height,
  });
  await page.screenshot({ path: path.join(outputDir, `${scenario.key}-completed.png`), fullPage: true });

  Object.assign(reportScenario, {
    state: "completed",
    completedAt: new Date().toISOString(),
    recoveredFromPriorDispatch: recoverFromHistory,
    browser: {
      viewport: { width: 1440, height: 900 },
      noHorizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      resultImage: browserImage,
      previewImage,
      historyItemCount,
      activeHistoryText,
    },
    download: {
      file: path.relative(evidenceRoot, finalDownload).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: sha256(bytes),
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    },
    database,
  });
  delete reportScenario.error;
  report.completed = report.scenarios.filter((item) => item.state === "completed").length;
  report.failed = report.scenarios.filter((item) => item.state === "failed").length;
  await saveReport();
  console.log(JSON.stringify({
    event: recoverFromHistory ? "scenario-recovered" : "scenario-complete",
    key: scenario.key,
    chargedYuan: database.billing.chargedYuan,
    costYuan: database.billing.costYuan,
    asset: database.coverAttempt.resultAssetId,
    download: finalDownload,
  }));
  return finalDownload;
}

async function runScenario(scenario, uploadPath) {
  const reportScenario = report.scenarios.find((item) => item.key === scenario.key);
  reportScenario.state = "preparing";
  reportScenario.startedAt = new Date().toISOString();
  await saveReport();
  console.log(JSON.stringify({ event: "scenario-start", key: scenario.key, price: scenario.price }));

  await page.goto(`${origin}/cover`, { waitUntil: "load", timeout: 60_000 });
  await page.getByRole("button", { name: new RegExp(scenario.modelLabel, "u") }).first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth, null, { timeout: 15_000 });

  const modelButton = page.getByRole("button", { name: new RegExp(scenario.modelLabel, "u") }).first();
  assert.equal(await modelButton.isDisabled(), false, `${scenario.modelLabel} is disabled in the browser`);
  await modelButton.click();
  await page.getByRole("button", { name: new RegExp(`^${scenario.style}`, "u") }).click();
  await page.getByRole("button", { name: new RegExp(`^${scenario.source}`, "u") }).click();
  await page.locator(".cover-ratio-picker button").filter({ hasText: scenario.ratio }).click();

  let selectedTemplate = "";
  if (scenario.sourceKind === "template") selectedTemplate = await chooseDifferentTemplate();
  if (scenario.sourceKind === "upload") {
    assert.ok(uploadPath, "The first generated cover is required for the recursive reference test");
    const uploadMetadata = await sharp(uploadPath).metadata();
    const originalBytes = await fs.readFile(uploadPath);
    const uploadStat = await fs.stat(uploadPath);
    assert.ok(uploadMetadata.width && uploadMetadata.height, "The first cover cannot be decoded for upload");
    let referenceUploadPath = uploadPath;
    if (uploadStat.size > 5 * 1024 * 1024) {
      referenceUploadPath = path.join(outputDir, `${scenario.key}-reference-from-first-cover.jpg`);
      await sharp(originalBytes)
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
        .toFile(referenceUploadPath);
    }
    const referenceBytes = await fs.readFile(referenceUploadPath);
    assert.ok(referenceBytes.length <= 5 * 1024 * 1024, "The prepared first-cover reference exceeds the 5MB upload contract");
    reportScenario.referencePreparation = {
      sourceFile: path.relative(evidenceRoot, uploadPath).replaceAll("\\", "/"),
      sourceBytes: originalBytes.length,
      sourceSha256: sha256(originalBytes),
      uploadFile: path.relative(evidenceRoot, referenceUploadPath).replaceAll("\\", "/"),
      uploadBytes: referenceBytes.length,
      uploadSha256: sha256(referenceBytes),
      transcodedToJpeg: referenceUploadPath !== uploadPath,
      preservedWidth: uploadMetadata.width,
      preservedHeight: uploadMetadata.height,
    };
    await page.locator('input[type="file"][accept*="image/png"]').setInputFiles(referenceUploadPath);
    await page.getByAltText("已上传参考图预览").waitFor({ state: "visible", timeout: 15_000 });
  }

  await page.getByLabel("输入文案", { exact: true }).fill(petBrief);
  await page.getByRole("button", { name: "拆解文案", exact: true }).click();
  const resultEditor = page.getByLabel("拆解结果", { exact: true });
  await page.waitForFunction(() => {
    const editor = document.querySelector('textarea[aria-label="拆解结果"]');
    return editor instanceof HTMLTextAreaElement && editor.value.trim().length >= 4;
  }, null, { timeout: 10_000 });
  const title = String(await resultEditor.inputValue()).trim();
  const titleLines = title.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  assert.ok(titleLines.length >= 1 && titleLines.length <= 3, "Cover copy must contain one to three lines");
  assert.ok(title.replace(/\s+/gu, "").length >= 6, "Cover copy is too short to carry the emotional hook");

  const auxiliaryToggle = page.getByRole("button", { name: /辅助短句（可选）/u });
  await auxiliaryToggle.click();
  const subtitle = String(await page.locator(".cover-optional-copy-editor input").inputValue()).trim();
  const advancedToggle = page.getByRole("button", { name: "画面描述（高级）", exact: true });
  await advancedToggle.click();
  const prompt = String(await page.getByLabel("拆解后的画面描述", { exact: true }).inputValue()).trim();
  assert.ok(prompt.length >= 120, "The generated visual description is too short");
  assert.match(prompt, /标题|文案/u, "The visual description does not preserve cover-copy semantics");
  if (scenario.sourceKind === "template") assert.match(prompt, /参考模板/u, "The template source is missing from the analysis prompt");
  if (scenario.sourceKind === "upload") assert.match(prompt, /用户上传图/u, "The uploaded reference is missing from the analysis prompt");
  if (scenario.sourceKind === "text") assert.doesNotMatch(prompt, /等待用户上传参考图/u, "Text-only mode retained an upload dependency");

  const generate = page.getByRole("button", { name: "生成封面", exact: true });
  assert.equal(await generate.isDisabled(), false, "Generate remained disabled after analysis");
  const costLine = String(await page.locator(".cover-cost-line").textContent()).replace(/\s+/gu, " ").trim();
  assert.match(costLine, new RegExp(`¥${scenario.price.toFixed(2).replace(".", "\\.")}`, "u"), "The visible quote is incorrect");
  reportScenario.analysis = {
    title,
    titleLines,
    subtitle,
    promptLength: prompt.length,
    promptHash: sha256(prompt),
    selectedTemplate,
    visibleCostLine: costLine,
  };
  await page.screenshot({ path: path.join(outputDir, `${scenario.key}-before-submit.png`), fullPage: true });

  currentScenario = scenario;
  await generate.click();
  await waitForCoverTerminal(scenario);
  currentScenario = null;
  const dispatch = dispatches.get(scenario.key);
  assert.ok(dispatch, "No paid dispatch was observed for the completed scenario");
  return validateCompletedResult(scenario, dispatch, reportScenario);
}

async function resolvePriorDispatch(scenario, reportScenario) {
  const storedKey = String(reportScenario.dispatch?.key || reportScenario.stableRequestKey || "");
  const match = storedKey.match(/^(cover_[a-f0-9]+)…([a-f0-9]{6})$/u);
  assert.ok(match, `${scenario.key} has no safe durable request key`);
  const rows = await query(`select client_idempotency_key,client_trace_id,state,generation_input,created_at
    from public.cover_generation_attempts
    where user_id::text=$1 and client_idempotency_key like $2 and right(client_idempotency_key,6)=$3
    order by created_at desc`, [actor.id, `${match[1]}%`, match[2]]);
  assert.equal(rows.length, 1, `${scenario.key} safe request key is not unique`);
  const attempt = rows[0];
  assert.equal(attempt.state, "completed", `${scenario.key} prior dispatch is ${attempt.state}`);
  assert.equal(attempt.generation_input?.modelId, scenario.modelId, `${scenario.key} prior model mismatch`);
  assert.equal(attempt.generation_input?.aspectRatio, scenario.ratio, `${scenario.key} prior ratio mismatch`);
  return {
    ...reportScenario.dispatch,
    scenario: scenario.key,
    key: attempt.client_idempotency_key,
    trace: attempt.client_trace_id,
  };
}

let firstDownload = "";
try {
  for (const scenario of scenarios) {
    const reportScenario = report.scenarios.find((item) => item.key === scenario.key);
    let downloaded = "";
    if (resumeRun && reportScenario.state === "completed" && reportScenario.download?.file) {
      downloaded = path.resolve(evidenceRoot, reportScenario.download.file);
      const metadata = await sharp(downloaded).metadata();
      assert.ok(metadata.width && metadata.height, `${scenario.key} saved download is unreadable`);
      console.log(JSON.stringify({ event: "scenario-already-complete", key: scenario.key, download: downloaded }));
    } else if (resumeRun && reportScenario.dispatch) {
      const priorDispatch = await resolvePriorDispatch(scenario, reportScenario);
      report.paidDispatches = report.scenarios.filter((item) => item.dispatch).length;
      downloaded = await validateCompletedResult(scenario, priorDispatch, reportScenario, { recoverFromHistory: true });
    } else {
      downloaded = await runScenario(scenario, scenario.sourceKind === "upload" ? firstDownload : "");
    }
    if (!firstDownload) firstDownload = downloaded;
    const currentBalance = await getBalance(actor.id);
    const observedSpend = money(initialBalance - currentBalance);
    assert.ok(observedSpend <= maximumSpendYuan, `Observed spend ¥${observedSpend} exceeded the ¥${maximumSpendYuan} cap`);
    report.currentBalance = currentBalance;
    report.observedSpendYuan = observedSpend;
    await saveReport();
  }

  const finalBalance = await getBalance(actor.id);
  const observedSpendYuan = money(initialBalance - finalBalance);
  const auditedChargeYuan = money(report.scenarios.reduce((sum, scenario) => sum + Number(scenario.database?.billing?.chargedYuan || 0), 0));
  const auditedCostYuan = money(report.scenarios.reduce((sum, scenario) => sum + Number(scenario.database?.billing?.costYuan || 0), 0));
  assert.equal(observedSpendYuan, plannedSpendYuan, "The account balance delta does not equal the four quoted prices");
  assert.equal(auditedChargeYuan, plannedSpendYuan, "The audited wallet charges do not equal the plan");
  assert.equal(report.paidDispatches, scenarios.length, "The number of paid dispatches is incorrect");
  assert.deepEqual(await getActiveAttempts(actor.id), [], "Completed paid testing left an active cover attempt");
  assert.deepEqual(pageErrors, [], "Browser page errors occurred during paid acceptance");

  report.finishedAt = new Date().toISOString();
  report.finalBalance = finalBalance;
  report.observedSpendYuan = observedSpendYuan;
  report.auditedChargeYuan = auditedChargeYuan;
  report.auditedCostYuan = auditedCostYuan;
  report.failed = 0;
  report.ok = true;
  report.pageErrors = pageErrors;
  await saveReport();
  console.log(JSON.stringify({
    ok: true,
    runId,
    scenarios: scenarios.length,
    completed: report.completed,
    paidDispatches: report.paidDispatches,
    chargedYuan: auditedChargeYuan,
    providerCostYuan: auditedCostYuan,
    balanceBefore: initialBalance,
    balanceAfter: finalBalance,
    report: reportPath,
  }, null, 2));
} catch (error) {
  currentScenario = null;
  const message = error instanceof Error ? error.message : String(error);
  const pending = report.scenarios.find((item) => !["completed", "failed"].includes(item.state));
  if (pending) {
    pending.state = "failed";
    pending.error = message;
  }
  report.failed = report.scenarios.filter((item) => item.state === "failed").length;
  report.ok = false;
  report.stoppedAt = new Date().toISOString();
  report.stopReason = message;
  report.currentBalance = await getBalance(actor.id).catch(() => null);
  report.observedSpendYuan = report.currentBalance == null ? null : money(initialBalance - report.currentBalance);
  report.pageErrors = pageErrors;
  await page.screenshot({ path: path.join(outputDir, "failure.png"), fullPage: true }).catch(() => undefined);
  await saveReport();
  console.error(JSON.stringify({ ok: false, runId, message, paidDispatches: report.paidDispatches, report: reportPath }));
  process.exitCode = 1;
} finally {
  await browser.close();
  await db.end();
}
