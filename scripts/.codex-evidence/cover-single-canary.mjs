import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

// REVIEWABLE OPERATOR EXECUTOR. Merely importing this module does nothing.
// Do not execute until the user explicitly approves this single paid canary.
// No dotenv/runtime config/database access; the existing session wrapper supplies
// a verified token in process memory. Only the standard product gateways charge.
const ORIGIN = "http://127.0.0.1:5000";
const IMAGE_MODEL = "pm_PZ3hS353YQNbfRnz2_9Ro0aX";
const ANALYSIS_MODEL = "pm_ZV1b1wzgWPnoikNWnBtABufh";
const IMAGE_YUAN = 0.30;
const OUTPUT = { width: 1080, height: 1440 };
const BRIEF = "以前我总把任务拖到最后。后来我每天先做10分钟，不再等状态好了才开始。先行动，再调整，事情终于有了进展。";
const EVIDENCE_ROOT = ".codex-evidence/cover-db-20261106-e29b/paid";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined;
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,119}$/u.test(value) ? value : undefined;
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest("hex");
const ensure = (condition, code) => { if (!condition) throw new Error(code); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameMoney = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value - IMAGE_YUAN) < 1e-9;

export async function main(args = process.argv.slice(2)) {
  // These are execution guards, not an assertion that user approval exists.
  // The operator must obtain the user's approval before invoking this command.
  ensure(args.includes("--execute-one-paid-cover"), "EXPLICIT_PAID_EXECUTION_FLAG_REQUIRED");
  ensure(args.filter(arg => arg.startsWith("--confirm-image-yuan=")).length === 1
    && args.includes("--confirm-image-yuan=0.30"), "EXPLICIT_IMAGE_YUAN_030_CONFIRMATION_REQUIRED");
  const readArg = name => {
    const values = args.filter(arg => arg.startsWith(`--${name}=`));
    ensure(values.length === 1, "EXACT_EXPECTED_RUNTIME_ARGUMENTS_REQUIRED");
    return values[0].slice(name.length + 3);
  };
  const expectedSourceVersion = readArg("expected-source-version");
  const expectedBuildId = readArg("expected-build-id");
  ensure(/^R\d{6}-\d{8}-[a-f0-9]{8}$/u.test(expectedSourceVersion), "EXPECTED_SOURCE_VERSION_INVALID");
  ensure(/^[A-Za-z0-9_-]{8,100}$/u.test(expectedBuildId), "EXPECTED_BUILD_ID_INVALID");
  ensure(path.resolve(process.cwd()).replace(/\\/gu, "/").toLowerCase()
    === "f:/总项目文件/skill存储系统/01_网页开发项目/自媒体操盘手/当前版本", "CANONICAL_F_SOURCE_DIRECTORY_REQUIRED");
  ensure(String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/$/u, "") === ORIGIN, "CANONICAL_LOCAL_5000_REQUIRED");
  ensure(process.env.LOCAL_ACCEPTANCE_PREVIEW === "true", "LOCAL_ACCEPTANCE_SESSION_WRAPPER_REQUIRED");
  // Public, non-secret endpoint addresses only. This is wrapper authority; it
  // cannot independently attest the already-running server's database settings.
  ensure(new URL(process.env.COZE_SUPABASE_URL || "http://invalid").origin === "http://127.0.0.1:54321", "LOOPBACK_DATABASE_ADDRESS_REQUIRED");
  ensure(new URL(process.env.SHARED_CONFIGURATION_SUPABASE_URL || "http://invalid").origin === "http://127.0.0.1:54321", "LOOPBACK_CONFIGURATION_ADDRESS_REQUIRED");
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  ensure(typeof token === "string" && token.length > 10, "VERIFIED_SESSION_WRAPPER_REQUIRED");
  let identity;
  try { identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "null"); } catch { throw new Error("VERIFIED_IDENTITY_INVALID"); }
  ensure(identity?.user?.role === "admin" && UUID.test(identity.user.id || ""), "VERIFIED_ADMIN_REQUIRED");

  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const root = path.resolve(EVIDENCE_ROOT);
  const directory = path.join(root, runId);
  // Fixed approval-consumption marker, intentionally not per-run. Never remove
  // automatically: a failed/unknown paid run is not permission for a second one.
  const approvalMarker = path.join(root, "single-paid-approval-consumed-20261106.json");
  const reportPath = path.join(directory, "report.json");
  let stage = "runtime-preflight";
  let browser;
  let page;
  let fatalCode;
  const state = { operationId: undefined, clientRequestId: undefined, generationIdentity: undefined,
    prepared: undefined, plan: undefined, receipt: undefined, prepareCount: 0, analysisCount: 0,
    claimCount: 0, dispatchCount: 0, confirmationClicks: 0, downloadClicks: 0,
    confirmationArmed: false, analysisReturned: false, analysisReturnedAt: 0, dispatchReturned: false };
  const report = { schemaVersion: 1, scope: "one-real-paid-cover-only", runId, origin: ORIGIN,
    startedAt: new Date().toISOString(), expectedSourceVersion, expectedBuildId,
    actorFingerprint: hash(identity.user.id), imageModelId: IMAGE_MODEL, analysisModelId: ANALYSIS_MODEL,
    confirmedImageYuan: IMAGE_YUAN, analysisPricing: "standard gateway actual usage; no invented fixed quote or balance change",
    runtimeAuthority: "Operator must first verify CheckOnly runningLatest and the local server data authority; this executor additionally checks loopback wrapper addresses, public version metadata, local BUILD_ID and /api/version.",
    authorizationBoundary: "Explicit flags are mandatory. They do not replace the user's approval. No automatic retries/new keys; UNKNOWN allows original-key GET reconciliation only.",
    externalScope: ["server-side controlled text-model provider", "server-side controlled image-model provider", "server-side object storage upload/read and standard ledger/history writes"],
    authMeFixtureOnly: true, requests: [], blocked: [], cases: [], parentStates: [], screenshots: [], pageErrors: [],
    passed: false, outcome: "not_started", downloaded: false, balancesOrPricesModified: false };
  const auth = { Authorization: `Bearer ${token}` };
  const mark = (name, details = {}) => report.cases.push({ name, passed: true, ...details });
  const fail = code => { fatalCode ||= code; throw new Error(code); };
  const summary = (status, body) => ({ httpStatus: status,
    ...(safeCode(body?.code) ? { code: body.code } : {}),
    ...(safeCode(body?.error_code) ? { errorCode: body.error_code } : {}),
    ...(["prepared", "analyzing", "needs_input", "plan_ready", "unknown", "failed", "completed", "claimed", "dispatched", "delivery_pending", "cancelled", "rejected", "not_found"].includes(body?.status || body?.state) ? { state: body.status || body.state } : {}),
    ...(safeId(body?.recordId) ? { recordId: body.recordId } : {}),
    ...(safeId(body?.operationId) ? { operationId: body.operationId } : {}),
    ...(safeId(body?.billingReferenceId) ? { billingReferenceId: body.billingReferenceId } : {}) });
  function rememberParent(body) {
    ensure(body?.operationId === state.operationId, "PARENT_OPERATION_CHANGED");
    ensure(body.materials?.clientRequestId === state.clientRequestId && body.quote?.analysis?.modelId === ANALYSIS_MODEL
      && body.quote?.image?.modelId === IMAGE_MODEL && sameMoney(body.quote.image.amount), "ORIGINAL_PARENT_MODEL_KEY_OR_QUOTE_CHANGED");
    if (!report.parentStates.includes(body.status)) report.parentStates.push(body.status);
    if (body.generationIdentity) {
      const expectedKey = `coverwb_${state.operationId}`;
      ensure(body.generationIdentity.clientIdempotencyKey === expectedKey && body.generationIdentity.clientTraceId === expectedKey, "GENERATION_IDENTITY_NOT_BOUND_TO_PARENT");
      state.generationIdentity = body.generationIdentity;
      state.plan = body;
    }
    const billing = object(body.billing);
    report.analysisBilling = {
      ...(typeof billing.credits_charged === "number" && Number.isFinite(billing.credits_charged) ? { creditsCharged: billing.credits_charged } : {}),
      ...(safeId(billing.operation_id) ? { operationId: billing.operation_id } : {}),
      ...(safeId(billing.attempt_id) ? { attemptId: billing.attempt_id } : {}),
    };
  }
  function rememberReceipt(body) {
    const result = object(body?.result);
    if (body?.completed !== true || result.persisted !== true || result.cloudStored !== true) return;
    ensure(UUID.test(result.assetId || "") && safeId(result.historyRecordId) && UUID.test(body.backgroundAssetId || ""), "PERSISTED_RECEIPT_IDENTIFIERS_INVALID");
    ensure(result.width === OUTPUT.width && result.height === OUTPUT.height && result.planVersion === 2
      && result.outputSpec?.aspectRatio === "3:4", "PERSISTED_OUTPUT_SPEC_MISMATCH");
    ensure(result.renderedText?.title === state.plan?.renderPlan?.title, "PERSISTED_TITLE_MISMATCH");
    state.receipt = { assetId: result.assetId, historyRecordId: result.historyRecordId, backgroundAssetId: body.backgroundAssetId,
      persisted: true, cloudStored: true, width: result.width, height: result.height,
      title: result.renderedText.title, ...(safeId(body.operationId) ? { operationId: body.operationId } : {}) };
    report.receipt = { ...state.receipt }; delete report.receipt.title;
  }
  async function read(relativePath) {
    const url = new URL(relativePath, ORIGIN);
    ensure(url.origin === ORIGIN, "EXTERNAL_RUNNER_REQUEST_FORBIDDEN");
    const allowed = ["/api/version", "/api/cover-models", "/api/cover/history", "/api/cover/render"].includes(url.pathname)
      || url.pathname === "/api/cover/prepare" && url.searchParams.get("operationId") === state.operationId && Boolean(state.operationId)
      || ["/api/cover/attempt", "/api/image/status"].includes(url.pathname) && state.generationIdentity
        && url.searchParams.get("clientIdempotencyKey") === state.generationIdentity.clientIdempotencyKey
        && url.searchParams.get("clientTraceId") === state.generationIdentity.clientTraceId;
    ensure(allowed, "UNBOUND_RUNNER_READ_FORBIDDEN");
    const response = await fetch(url, { headers: auth, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(45_000) });
    const body = await response.json().catch(() => null);
    report.requests.push({ source: "runner", method: "GET", path: url.pathname, ...summary(response.status, body) });
    if (url.pathname === "/api/cover/prepare" && response.ok) rememberParent(body);
    if (url.pathname === "/api/cover/attempt" && response.ok) rememberReceipt(body);
    return { status: response.status, ok: response.ok, body };
  }
  async function verifyVersion() {
    const local = JSON.parse((await fs.readFile(path.resolve("public/version.json"), "utf8")).replace(/^\uFEFF/u, ""));
    const localBuild = (await fs.readFile(path.resolve(".next/BUILD_ID"), "utf8")).trim();
    ensure(local.sourceVersion === expectedSourceVersion && localBuild === expectedBuildId, "EXPECTED_LOCAL_SOURCE_OR_BUILD_CHANGED");
    const served = await read("/api/version");
    ensure(served.ok && served.body?.sourceVersion === expectedSourceVersion && served.body?.buildId === expectedBuildId, "SERVED_SOURCE_OR_BUILD_MISMATCH");
    report.runtime = { sourceVersion: served.body.sourceVersion, revision: served.body.revision, buildId: served.body.buildId };
  }
  async function shot(filename) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(directory, filename), fullPage: false }); report.screenshots.push(filename);
  }
  async function validateHistory() {
    const history = await read("/api/cover/history?page=1");
    ensure(history.ok && Array.isArray(history.body?.records), "REAL_HISTORY_READ_FAILED");
    const matches = history.body.records.filter(item => item.assetId === state.receipt?.assetId && item.historyRecordId === state.receipt?.historyRecordId);
    ensure(matches.length === 1, "MATCHING_SAVED_HISTORY_RECORD_REQUIRED");
    const saved = matches[0];
    ensure(saved.cloudStored === true && ["done", "display_pending"].includes(saved.status) && saved.backgroundAssetId === state.receipt.backgroundAssetId
      && saved.outputWidth === OUTPUT.width && saved.outputHeight === OUTPUT.height, "HISTORY_RECEIPT_MISMATCH");
    if (saved.prepareOperationId) ensure(saved.prepareOperationId === state.operationId, "HISTORY_PARENT_OPERATION_MISMATCH");
    report.history = { matched: true, assetId: saved.assetId, historyRecordId: saved.historyRecordId, cloudStored: true, displayStatus: saved.status,
      parentLink: saved.prepareOperationId ? "explicit_history_parent" : "original-bound-attempt-receipt-and-matching-asset-history-identifiers" };
    return { saved, records: history.body.records };
  }
  try {
    await fs.mkdir(directory, { recursive: true });
    try { await fs.access(approvalMarker); fail("PRIOR_SINGLE_PAID_APPROVAL_ALREADY_CONSUMED"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await verifyVersion();
    const catalog = await read("/api/cover-models?surface=cover-studio");
    const model = Array.isArray(catalog.body?.models) ? catalog.body.models.find(item => item.id === IMAGE_MODEL) : null;
    const cap = object(model?.capabilities);
    ensure(catalog.ok && model && cap.available === true && cap.generationReady === true && cap.protocolBindingReady === true && cap.priceReady === true, "FIXED_IMAGE_MODEL_NOT_READY");
    ensure(Array.isArray(cap.resolutionOptions) && cap.resolutionOptions.includes("2K"), "FIXED_MODEL_2K_UNAVAILABLE");
    const prices = Object.fromEntries((Array.isArray(cap.resolutionPrices) ? cap.resolutionPrices : []).map(entry => String(entry).split("=", 2)));
    const quoted = prices["2K"] !== undefined ? Number(prices["2K"]) : cap.defaultResolution === "2K" ? model.publicPrice : NaN;
    ensure(sameMoney(quoted), "FIXED_MODEL_IMAGE_QUOTE_NOT_030");
    const priorHistory = await read("/api/cover/history?page=1");
    ensure(priorHistory.ok && Array.isArray(priorHistory.body?.records), "HISTORY_PREFLIGHT_FAILED");
    ensure(!priorHistory.body.activeAttempt && (!Array.isArray(priorHistory.body.activeAttempts) || priorHistory.body.activeAttempts.length === 0), "EXISTING_ACTIVE_COVER_ATTEMPT_BLOCKS_CANARY");
    const ready = await read("/api/cover/render");
    ensure(ready.ok && ready.body?.ready === true, "RENDER_READINESS_FAILED");
    mark("local-version-fixed-model-price-history-and-render-preflight");

    stage = "real-ui-prepare";
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", acceptDownloads: true });
    await context.addCookies([{ name: "auth_token", value: token, url: ORIGIN, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken); localStorage.setItem("auth_user", JSON.stringify(user)); sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    await context.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method();
      const blocked = async code => {
        fatalCode ||= code; report.blocked.push({ code, method, path: url.origin === ORIGIN ? url.pathname : "external-resource" });
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ success: false, code }) });
      };
      if (url.origin !== ORIGIN) { report.blocked.push({ code: "BROWSER_EXTERNAL_ABORTED", method, path: "external-resource" }); return route.abort("blockedbyclient"); }
      if (url.pathname === "/api/auth/me" && method === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, user: identity.user }) });
      const relay = async action => {
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 360_000 });
          const body = await response.json().catch(() => null);
          report.requests.push({ source: "browser-real-relay", method, path: url.pathname, action, ...summary(response.status(), body) });
          if (["prepare", "analyze", "claim", "dispatch"].includes(action) || body?.completed === true) {
            console.log(JSON.stringify({ event: "single-cover-checkpoint", action, operationId: state.operationId || body?.operationId, ...summary(response.status(), body), completed: body?.completed === true }));
          }
          if (url.pathname === "/api/cover/prepare") {
            if (action === "prepare" && response.ok()) {
              ensure(UUID.test(body?.operationId || "") && body.status === "prepared", "REAL_PREPARED_PARENT_REQUIRED");
              state.operationId = body.operationId; state.prepared = body;
            }
            if (response.ok() && state.operationId) rememberParent(body);
            if (action === "analyze") { state.analysisReturned = true; state.analysisReturnedAt = Date.now(); }
          }
          if (url.pathname === "/api/cover/attempt") { rememberReceipt(body); if (action === "dispatch") state.dispatchReturned = true; }
          await route.fulfill({ response });
        } catch (error) {
          const responseCode = safeCode(error?.message) || "REAL_GATEWAY_RESPONSE_UNCONFIRMED";
          if (responseCode !== "REAL_GATEWAY_RESPONSE_UNCONFIRMED") fatalCode ||= responseCode;
          if (action === "analyze") { state.analysisReturned = true; state.analysisReturnedAt = Date.now(); }
          if (action === "dispatch") state.dispatchReturned = true;
          report.requests.push({ source: "browser-real-relay", method, path: url.pathname, action, code: responseCode });
          await route.abort("failed").catch(() => {});
        }
      };
      if (url.pathname === "/api/cover/prepare") {
        if (method === "GET") return state.operationId && url.searchParams.get("operationId") === state.operationId ? relay("get") : blocked("UNBOUND_PARENT_READ_BLOCKED");
        if (method !== "POST") return blocked("UNEXPECTED_PARENT_METHOD_BLOCKED");
        let body;
        try { body = req.postDataJSON(); } catch { return blocked("INVALID_PARENT_BODY_BLOCKED"); }
        if (body.action === "prepare") {
          const m = body.materials;
          if (state.prepareCount !== 0 || !m || m.text !== BRIEF || !UUID.test(m.clientRequestId || "")
            || m.modelId !== IMAGE_MODEL || m.styleKey !== "cartoon" || m.outputRatio !== "3:4" || m.resolution !== "2K"
            || !Array.isArray(m.assets) || m.assets.length !== 0 || m.manualTitle || body.consent) return blocked("SECOND_OR_MUTATED_PREPARE_BLOCKED");
          state.clientRequestId = m.clientRequestId; state.prepareCount += 1; return relay("prepare");
        }
        if (body.action === "analyze") {
          if (!state.confirmationArmed || state.analysisCount !== 0 || body.operationId !== state.operationId
            || body.consent?.analysis !== true || body.consent?.image !== true) return blocked("SECOND_OR_UNAUTHORIZED_ANALYSIS_BLOCKED");
          state.analysisCount += 1; return relay("analyze");
        }
        return blocked("NON_GET_PARENT_ACTION_BLOCKED");
      }
      if (url.pathname === "/api/cover/attempt") {
        const keys = state.generationIdentity;
        if (!keys) return blocked("GENERATION_BEFORE_BOUND_PLAN_BLOCKED");
        if (method === "GET") return url.searchParams.get("clientIdempotencyKey") === keys.clientIdempotencyKey
          && url.searchParams.get("clientTraceId") === keys.clientTraceId ? relay("get") : blocked("UNBOUND_ATTEMPT_READ_BLOCKED");
        let body;
        try { body = req.postDataJSON(); } catch { return blocked("INVALID_ATTEMPT_BODY_BLOCKED"); }
        if (method !== "POST" || body.clientIdempotencyKey !== keys.clientIdempotencyKey || body.clientTraceId !== keys.clientTraceId) return blocked("NEW_GENERATION_KEY_BLOCKED");
        if (body.action === "claim") {
          if (state.claimCount !== 0 || state.analysisCount !== 1 || body.task?.prepareOperationId !== state.operationId
            || body.task?.ratio !== "3:4" || body.task?.renderPlan?.outputSpec?.width !== OUTPUT.width
            || body.task?.renderPlan?.outputSpec?.height !== OUTPUT.height || hash(body.payload) !== hash(state.plan.generationInput)) return blocked("SECOND_OR_MUTATED_CLAIM_BLOCKED");
          state.claimCount += 1; return relay("claim");
        }
        if (body.action === "dispatch") {
          if (state.dispatchCount !== 0 || state.claimCount !== 1 || hash(body.payload) !== hash(state.plan.generationInput)) return blocked("SECOND_OR_MUTATED_DISPATCH_BLOCKED");
          state.dispatchCount += 1; return relay("dispatch");
        }
        return blocked("RETRY_ADOPT_CANCEL_OR_OTHER_ATTEMPT_WRITE_BLOCKED");
      }
      // Current UI reaches LLM/image providers inside the guarded parent/attempt
      // gateways. A direct browser call would bypass this single-operation proof.
      if (url.pathname === "/api/llm" || url.pathname === "/api/image/generate") return blocked("DIRECT_BROWSER_MODEL_CALL_BLOCKED");
      // Normal first-party audit events record browser request outcomes only;
      // this authenticated endpoint has no model or wallet dispatch capability.
      if (url.pathname === "/api/operation-events" && method === "POST") return relay("browser-operation-event");
      if (!["GET", "HEAD"].includes(method)) return blocked("UNRELATED_WRITE_BLOCKED");
      if (url.pathname === "/api/image/status" && (!state.generationIdentity
        || url.searchParams.get("clientIdempotencyKey") !== state.generationIdentity.clientIdempotencyKey
        || url.searchParams.get("clientTraceId") !== state.generationIdentity.clientTraceId)) return blocked("UNBOUND_IMAGE_STATUS_BLOCKED");
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(30_000);
    page.on("pageerror", () => report.pageErrors.push({ code: "BROWSER_RUNTIME_ERROR" }));
    await page.goto(`${ORIGIN}/cover`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
    ensure(new URL(page.url()).pathname === "/cover", "LOCAL_COVER_ROUTE_CHANGED");
    await page.waitForFunction(id => [...document.querySelectorAll("#cover-workbench-model option")].some(option => option.value === id), IMAGE_MODEL);
    await page.locator("#cover-workbench-model").selectOption(IMAGE_MODEL);
    await page.locator("#cover-workbench-style").selectOption("cartoon");
    await page.locator("#cover-workbench-resolution").selectOption("2K");
    await page.getByRole("button", { name: /^3:4\s/u }).click();
    await page.locator("#cover-workbench-text").fill(BRIEF);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "生成封面" && !button.disabled));
    await page.getByRole("button", { name: "生成封面", exact: true }).click();
    await page.getByRole("button", { name: "确认费用并制作", exact: true }).waitFor();
    ensure(!fatalCode && state.prepareCount === 1 && state.prepared?.status === "prepared", fatalCode || "ONE_REAL_PREPARE_REQUIRED");
    ensure(state.prepared.quote?.analysis?.modelId === ANALYSIS_MODEL, "ANALYSIS_MODEL_NOT_APPROVED_MODEL");
    ensure(state.prepared.quote.analysis.policy === "actual_usage" && state.prepared.quote.analysis.amount === null
      && !state.prepared.reuseAnalysisOperationId, "REAL_ANALYSIS_REQUIRED_NOT_CACHED_REUSE");
    ensure(state.prepared.quote?.image?.modelId === IMAGE_MODEL && sameMoney(state.prepared.quote.image.amount)
      && state.prepared.quote.image.unit === "yuan" && state.prepared.quote.image.resolution === "2K", "PREPARED_IMAGE_COST_OR_MODEL_CHANGED");
    ensure(state.prepared.materials?.text === BRIEF && state.prepared.materials.assets?.length === 0
      && state.prepared.materials.outputRatio === "3:4" && state.prepared.materials.styleKey === "cartoon", "PREPARED_MATERIALS_CHANGED");
    report.operationId = state.operationId; report.clientRequestId = state.clientRequestId;
    report.materialFingerprint = state.prepared.materialFingerprint;
    await shot("01-prepared-approved-models-and-cost.png");
    mark("real-UI-prepared-exact-parent-models-and-image-yuan-030");

    stage = "single-paid-confirmation";
    await verifyVersion();
    // Atomic and never automatically removed, including failures after this point.
    await fs.writeFile(approvalMarker, `${JSON.stringify({ runId, operationId: state.operationId, clientRequestId: state.clientRequestId,
      imageYuan: IMAGE_YUAN, imageModelId: IMAGE_MODEL, analysisModelId: ANALYSIS_MODEL,
      sourceVersion: expectedSourceVersion, buildId: expectedBuildId, consumedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
    report.approvalConsumed = true; state.confirmationArmed = true;
    state.confirmationClicks += 1;
    await page.getByRole("button", { name: "确认费用并制作", exact: true }).click();
    report.outcome = "submitted";

    stage = "wait-original-operation-only";
    const deadline = Date.now() + 14 * 60_000;
    let lastReadAt = 0;
    while (Date.now() < deadline && !state.receipt) {
      if (fatalCode) break;
      if (state.analysisReturned && Date.now() - lastReadAt > 10_000) {
        lastReadAt = Date.now();
        const parent = await read(`/api/cover/prepare?${new URLSearchParams({ operationId: state.operationId })}`);
        ensure(parent.ok, "ORIGINAL_PARENT_STATUS_UNAVAILABLE");
        if (["failed", "needs_input"].includes(parent.body.status)) fail(safeCode(parent.body.code) || "ANALYSIS_DID_NOT_FORM_READY_PLAN");
        // No UI recover click: that helper may adopt/dispatch. Only original-key
        // GET reconciliation is allowed once the original response is uncertain.
        if (state.dispatchReturned && state.generationIdentity) {
          const query = new URLSearchParams(state.generationIdentity);
          const recovered = await read(`/api/cover/attempt?${query}`);
          if (recovered.body?.terminalAttempt || ["failed", "cancelled", "rejected"].includes(recovered.body?.state)) fail(safeCode(recovered.body.code) || "ORIGINAL_IMAGE_ATTEMPT_TERMINAL_FAILURE");
          if (!state.receipt) await read(`/api/image/status?${query}`);
        }
        if (state.analysisReturned && Date.now() - state.analysisReturnedAt > 5000 && parent.body.status === "plan_ready" && state.claimCount === 0) {
          report.outcome = "analysis_recovered_no_image_resubmission";
          break;
        }
      }
      await pause(1000);
    }
    ensure(!fatalCode, fatalCode || "UNCONFIRMED_GATEWAY_RESPONSE");
    ensure(state.receipt, "ORIGINAL_OPERATION_STILL_UNKNOWN_OR_INCOMPLETE");
    ensure(state.confirmationClicks === 1 && state.analysisCount === 1 && state.claimCount === 1 && state.dispatchCount === 1, "ONE_ANALYSIS_AND_ONE_IMAGE_DISPATCH_REQUIRED");
    report.generationIdentity = state.generationIdentity;
    mark("one-paid-confirmation-one-analysis-one-claim-one-dispatch");

    stage = "real-history-and-download";
    const { saved, records } = await validateHistory();
    const download = page.getByRole("button", { name: "下载封面", exact: true });
    if (!await download.isVisible()) {
      ensure(records.filter(item => item.title === saved.title).length === 1, "RECOVERED_HISTORY_TITLE_AMBIGUOUS");
      await page.getByRole("button", { name: "历史作品", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "历史作品", exact: true });
      await dialog.getByRole("button").filter({ has: page.getByText(saved.title, { exact: true }) }).click();
    }
    await download.waitFor({ state: "visible" });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "下载封面" && !button.disabled));
    const downloadEvent = page.waitForEvent("download", { timeout: 60_000 });
    state.downloadClicks += 1; await download.click();
    const delivered = await downloadEvent;
    ensure(!await delivered.failure(), "REAL_BROWSER_DOWNLOAD_FAILED");
    ensure(/\.png$/iu.test(delivered.suggestedFilename()), "DOWNLOADED_FILE_NOT_PNG");
    const pngPath = path.join(directory, "downloaded-cover-1080x1440.png");
    await delivered.saveAs(pngPath);
    const bytes = await fs.readFile(pngPath);
    const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
    ensure(metadata.format === "png" && metadata.width === OUTPUT.width && metadata.height === OUTPUT.height, "DOWNLOADED_PNG_DIMENSIONS_INVALID");
    report.downloaded = true; report.download = { filename: path.basename(pngPath), bytes: bytes.length, sha256: hash(bytes),
      format: metadata.format, width: metadata.width, height: metadata.height };
    await shot("02-real-generated-and-saved-cover.png");
    await verifyVersion();
    await validateHistory();
    mark("real-cloud-history-readback-and-browser-PNG-download-1080x1440");
    ensure(report.pageErrors.length === 0, "BROWSER_RUNTIME_ERROR");
    report.outcome = "real_saved_history_and_download_verified"; report.passed = true;
  } catch (error) {
    report.failure = { stage, code: safeCode(error?.message) || safeCode(error?.code) || "SINGLE_CANARY_FAILED_OR_UNKNOWN" };
    if (report.outcome === "submitted" || state.analysisCount || state.dispatchCount) report.outcome = "failed_or_unknown_no_resubmission";
    else if (report.outcome === "not_started") report.outcome = "stopped_before_paid_confirmation";
    process.exitCode = 1;
    if (page && !page.isClosed()) await shot("failure-or-unknown.png").catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    report.operationId = state.operationId; report.clientRequestId = state.clientRequestId;
    report.generationIdentity = state.generationIdentity;
    report.counts = { prepareRequests: state.prepareCount, analysisRequests: state.analysisCount, claimRequests: state.claimCount,
      imageDispatchRequests: state.dispatchCount, feeConfirmationClicks: state.confirmationClicks, downloadClicks: state.downloadClicks };
    report.finishedAt = new Date().toISOString();
    // No raw prompts/model responses/URLs/storage keys/session/identity/tokens.
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    assert.ok(!serialized.includes(token), "TOKEN_MUST_NOT_BE_PERSISTED");
    assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(reportPath, serialized, { flag: "wx" });
    console.log(JSON.stringify({ passed: report.passed, outcome: report.outcome, operationId: report.operationId,
      generationIdentity: report.generationIdentity, failure: report.failure, counts: report.counts,
      downloaded: report.downloaded, report: reportPath, approvalMarker }));
  }
}
