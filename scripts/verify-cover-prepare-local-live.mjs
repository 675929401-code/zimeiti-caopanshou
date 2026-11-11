import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Run only through with-local-admin-session.mjs. This verifier never loads
// runtime files, dotenv, database clients, provider clients, or credentials.
const ORIGIN = "http://127.0.0.1:5000";
const MODEL_PATH = "/api/cover-models?surface=cover-studio"; // Actual workbench hook.
const ROOT = ".codex-evidence/cover-db-20261106-e29b/live";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const PAID_OR_MUTATING_PATH = /\/(?:llm|image|images|attempt|poll|status|recover|generate|render|preview|materials|upload)(?:\/|$)/u;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const ensure = (condition, code) => { if (!condition) throw new Error(code); };
const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
function priceFor2K(model) {
  const cap = record(model.capabilities);
  for (const entry of Array.isArray(cap.resolutionPrices) ? cap.resolutionPrices : []) {
    const [resolution, amount] = String(entry).split("=", 2);
    if (resolution?.trim().toUpperCase() === "2K" && amount?.trim()
      && Number.isFinite(Number(amount)) && Number(amount) >= 0) return Number(amount);
  }
  if (cap.defaultResolution === "2K" && typeof model.publicPrice === "number"
    && Number.isFinite(model.publicPrice) && model.publicPrice >= 0) return model.publicPrice;
  return null;
}
function selectModel(payload) {
  ensure(Array.isArray(payload.models), "MODEL_CATALOG_SHAPE_INVALID");
  const selected = payload.models.find(model => {
    const cap = record(model?.capabilities);
    return /^pm_[A-Za-z0-9_-]+$/u.test(model?.id || "") && typeof model.displayName === "string"
      && cap.available === true && cap.generationReady === true
      && cap.protocolBindingReady === true && cap.priceReady === true
      && Array.isArray(cap.resolutionOptions) && cap.resolutionOptions.includes("2K")
      && priceFor2K(model) !== null;
  });
  ensure(selected, "NO_AVAILABLE_PRICED_2K_COVER_MODEL");
  const ratios = record(selected.capabilities).aspectRatios;
  const ratio = ["3:4", "16:9", "9:16", "4:3"].find(value => !Array.isArray(ratios) || !ratios.length || ratios.includes(value));
  ensure(ratio, "NO_SUPPORTED_FIXED_COVER_RATIO");
  return { modelId: selected.id, ratio, resolution: "2K" };
}

export async function main() {
  const started = new Date();
  const runId = `${started.toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const prefix = `cover_live_${started.getTime()}_${randomUUID().slice(0, 8)}`;
  const directory = path.resolve(ROOT, runId);
  const reportPath = path.join(directory, "report.json");
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  let identity;
  let browser;
  let stage = "initialization";
  const operationIds = new Set();
  const report = {
    scope: "local-real-parent-table-and-prepared-refresh-only",
    startedAt: started.toISOString(), origin: ORIGIN, runId, testPrefix: prefix,
    modelCatalogPath: MODEL_PATH, cases: [], requests: [], screenshots: [],
    blocked: { external: [], paidOrMutating: [], otherWrites: [], invalidPrepare: [] },
    authMeReadFixture: true, pageErrors: [], operations: [], recordsDeleted: 0,
    providerCalls: 0, llmCalls: 0, imageGenerationCalls: 0,
    callCountEvidence: "Counts cover requests forwarded by this verifier and browser. Backend provider traffic is not independently instrumented; the real operation must remain prepared without analysis/generation results, and the prepare/get implementation does not dispatch providers.",
    costBoundary: "Only real prepare/get requests are forwarded; analyze/LLM/image/attempt/render/upload and all other writes are blocked before dispatch. No real analysis or image generation is accepted by this run.",
    rlsAndCas: "Not executed here; separate owner transaction acceptance.",
    uiKeyPolicy: "API cases use test-prefix client keys. The UI retains its real crypto.randomUUID key and uses the test-prefix text; subsequent lookups are limited to its exact returned operation ID.",
    passed: false,
  };
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const mark = (name, details = {}) => report.cases.push({ name, passed: true, ...details });
  const codeOnly = error => /^[A-Z][A-Z0-9_]{2,120}$/u.test(String(error?.message || "")) ? error.message : "VERIFICATION_FAILED";
  const brief = (status, body) => ({ httpStatus: status,
    ...(typeof body?.code === "string" && /^[A-Z0-9_]{1,100}$/u.test(body.code) ? { code: body.code } : {}),
    ...(typeof body?.status === "string" && /^[a-z_]{1,40}$/u.test(body.status) ? { status: body.status } : {}) });
  async function request(relativePath, body) {
    const url = new URL(relativePath, ORIGIN);
    ensure(url.origin === ORIGIN, "EXTERNAL_HTTP_FORBIDDEN");
    const method = body ? "POST" : "GET";
    if (body) {
      ensure(url.pathname === "/api/cover/prepare" && ["prepare", "get"].includes(body.action), "UNSAFE_HTTP_WRITE_FORBIDDEN");
      if (body.action === "prepare") {
        ensure(body.materials?.clientRequestId?.startsWith(prefix) && body.materials.text.startsWith(prefix)
          && Array.isArray(body.materials.assets) && body.materials.assets.length === 0 && !body.consent, "NON_TEST_MATERIAL_FORBIDDEN");
      } else ensure(operationIds.has(body.operationId), "NON_TEST_OPERATION_FORBIDDEN");
    } else if (url.pathname === "/api/cover/prepare") {
      const id = url.searchParams.get("operationId");
      const key = url.searchParams.get("clientRequestId");
      ensure((id && operationIds.has(id)) || (key && key.startsWith(prefix)), "NON_TEST_OPERATION_FORBIDDEN");
    } else ensure(relativePath === MODEL_PATH, "UNSAFE_HTTP_READ_FORBIDDEN");
    const response = await fetch(url, { method, headers: { ...auth(), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(45_000) });
    const payload = await response.json().catch(() => null);
    report.requests.push({ source: "runner", path: url.pathname, method, ...(body ? { action: body.action } : {}), ...brief(response.status, payload) });
    return { response, payload };
  }
  function checkPrepared(payload, materials, expectedId) {
    ensure(payload?.success === true && payload.status === "prepared", "REAL_PREPARED_RESULT_REQUIRED");
    ensure(UUID.test(payload.operationId || ""), "OPERATION_ID_INVALID");
    if (expectedId) ensure(payload.operationId === expectedId, "OPERATION_ID_CHANGED");
    ensure(digest(payload.materials) === digest(materials), "PREPARED_MATERIALS_CHANGED");
    ensure(payload.analysis === undefined && payload.renderPlan === undefined && payload.generationInput === undefined,
      "UNEXPECTED_ANALYSIS_OR_GENERATION_RESULT");
    ensure(payload.quote?.analysis?.unit === "credits" && payload.quote?.image?.ready === true, "PREPARED_QUOTE_MISSING");
    ensure(typeof payload.quote.image.amount === "number" && payload.quote.image.amount >= 0, "PREPARED_IMAGE_PRICE_INVALID");
    ensure(/^pm_/u.test(payload.quote.analysis.modelId || ""), "PREPARED_ANALYSIS_MODEL_MISSING");
    ensure(payload.quote.image.modelId === materials.modelId, "PREPARED_MODEL_CHANGED");
    ensure(payload.generationSpec?.resolution === "2K", "PREPARED_RESOLUTION_CHANGED");
    ensure(!Object.values(record(payload.billing)).some(value => typeof value === "number" && value > 0), "PREPARE_BILLING_NOT_EMPTY");
  }
  try {
    await fs.mkdir(directory, { recursive: true });
    ensure(String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/$/u, "") === ORIGIN, "LOCAL_5000_ORIGIN_REQUIRED");
    ensure(typeof token === "string" && token.length > 10, "SESSION_WRAPPER_REQUIRED");
    try { identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "null"); } catch { throw new Error("SESSION_IDENTITY_INVALID"); }
    ensure(identity?.user?.role === "admin" && UUID.test(identity.user.id || ""), "VERIFIED_ADMIN_IDENTITY_REQUIRED");
    report.actorFingerprint = digest(identity.user.id);

    stage = "model-catalog";
    const catalog = await request(MODEL_PATH);
    ensure(catalog.response.ok, "MODEL_CATALOG_HTTP_FAILED");
    const selection = selectModel(catalog.payload);
    report.selection = selection;
    mark("real-hook-catalog-selects-ready-priced-2K-model");
    const materials = { schemaVersion: "cover-prepare/1", clientRequestId: `${prefix}_api`, materialRevision: 1,
      text: `${prefix} 本地无付费验收：整理书桌的三个步骤。`, assets: [], styleKey: "cartoon",
      outputRatio: selection.ratio, modelId: selection.modelId, resolution: "2K" };

    stage = "http-first-prepare";
    const first = await request("/api/cover/prepare", { action: "prepare", materials });
    ensure(first.response.status === 200, "FIRST_PREPARE_HTTP_FAILED");
    checkPrepared(first.payload, materials);
    operationIds.add(first.payload.operationId);
    report.operations.push({ source: "http", operationId: first.payload.operationId, clientRequestId: materials.clientRequestId });
    const snapshotHash = digest(first.payload);
    mark("real-http-first-prepare", { ...brief(first.response.status, first.payload), operationId: first.payload.operationId, snapshotHash });

    stage = "http-sequential-idempotency";
    const second = await request("/api/cover/prepare", { action: "prepare", materials });
    ensure(second.response.status === 200, "REPLAY_HTTP_FAILED");
    checkPrepared(second.payload, materials, first.payload.operationId);
    ensure(digest(second.payload) === snapshotHash, "SEQUENTIAL_REPLAY_CHANGED_SNAPSHOT");
    mark("sequential-same-key-same-materials-same-operation-and-snapshot");

    stage = "http-concurrent-idempotency";
    const concurrent = await Promise.all([request("/api/cover/prepare", { action: "prepare", materials }),
      request("/api/cover/prepare", { action: "prepare", materials })]);
    for (const result of concurrent) {
      ensure(result.response.status === 200, "CONCURRENT_REPLAY_HTTP_FAILED");
      checkPrepared(result.payload, materials, first.payload.operationId);
      ensure(digest(result.payload) === snapshotHash, "CONCURRENT_REPLAY_CHANGED_SNAPSHOT");
    }
    mark("two-concurrent-same-key-replays-preserve-operation-and-snapshot", { replayCount: concurrent.length });

    stage = "http-material-conflict";
    const conflict = await request("/api/cover/prepare", { action: "prepare", materials: { ...materials, text: `${materials.text} 已修改材料。` } });
    ensure(conflict.response.status === 409 && conflict.payload?.code === "COVER_MATERIAL_CONFLICT", "EXPECTED_MATERIAL_CONFLICT_MISSING");
    const afterConflict = await request("/api/cover/prepare", { action: "get", operationId: first.payload.operationId });
    ensure(afterConflict.response.status === 200, "POST_GET_HTTP_FAILED");
    checkPrepared(afterConflict.payload, materials, first.payload.operationId);
    ensure(digest(afterConflict.payload) === snapshotHash, "MATERIAL_CONFLICT_MUTATED_ORIGINAL_SNAPSHOT");
    mark("different-materials-409-and-original-snapshot-unchanged", brief(conflict.response.status, conflict.payload));

    stage = "http-get-recovery";
    for (const query of [{ operationId: first.payload.operationId }, { clientRequestId: materials.clientRequestId }]) {
      const recovered = await request(`/api/cover/prepare?${new URLSearchParams(query)}`);
      ensure(recovered.response.status === 200, "GET_RECOVERY_HTTP_FAILED");
      checkPrepared(recovered.payload, materials, first.payload.operationId);
      ensure(digest(recovered.payload) === snapshotHash, "GET_RECOVERY_CHANGED_SNAPSHOT");
    }
    mark("real-POST-get-and-GET-by-id-or-key-recover-original-prepared");

    stage = "browser-setup";
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await context.addCookies([{ name: "auth_token", value: token, url: ORIGIN, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(({ token: currentToken, user }) => {
      localStorage.setItem("auth_token", currentToken); localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { token, user: identity.user });
    let uiPrepareCount = 0;
    // Installed request guards observe this binding before the first response.
    // eslint-disable-next-line prefer-const
    let uiOperationId;
    let uiMaterials;
    const uiText = `${prefix} 页面无付费验收：整理书桌的三个步骤。`;
    const uiPrepareBodies = [];
    const block = (list, method, pathname) => { list.push({ method, path: pathname }); };
    await context.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url()), method = req.method();
      const deny = async (list, code) => {
        block(list, method, url.origin === ORIGIN ? url.pathname : "external-resource");
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ success: false, code }) });
      };
      if (url.origin !== ORIGIN) { block(report.blocked.external, method, "external-resource"); return route.abort("blockedbyclient"); }
      if (url.pathname === "/api/auth/me") {
        if (method !== "GET") return deny(report.blocked.otherWrites, "ACCEPTANCE_WRITE_BLOCKED");
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, user: identity.user }) });
      }
      if (url.pathname === "/api/cover/prepare") {
        if (method === "POST") {
          let body;
          try { body = req.postDataJSON(); } catch { return deny(report.blocked.invalidPrepare, "ACCEPTANCE_INVALID_BODY"); }
          if (body?.action === "analyze") return deny(report.blocked.paidOrMutating, "ACCEPTANCE_ANALYSIS_BLOCKED");
          if (body?.action === "prepare") {
            const m = body.materials;
            if (uiPrepareCount !== 0 || !m || m.text !== uiText || !UUID.test(m.clientRequestId || "")
              || m.modelId !== selection.modelId || m.resolution !== "2K" || m.outputRatio !== selection.ratio
              || !Array.isArray(m.assets) || m.assets.length || body.consent) {
              return deny(report.blocked.invalidPrepare, "ACCEPTANCE_NON_TEST_PREPARE_BLOCKED");
            }
            uiPrepareCount += 1; uiPrepareBodies.push(body); uiMaterials = m;
            return route.continue();
          }
          if (body?.action === "get" && operationIds.has(body.operationId)) return route.continue();
          return deny(report.blocked.invalidPrepare, "ACCEPTANCE_NON_TEST_OPERATION_BLOCKED");
        }
        if (method === "GET" && uiOperationId && url.searchParams.get("operationId") === uiOperationId) return route.continue();
        return deny(report.blocked.invalidPrepare, "ACCEPTANCE_NON_TEST_OPERATION_BLOCKED");
      }
      if (url.pathname.startsWith("/api/") && PAID_OR_MUTATING_PATH.test(url.pathname)) {
        return deny(report.blocked.paidOrMutating, "ACCEPTANCE_PAID_OR_MUTATING_ROUTE_BLOCKED");
      }
      if (!["GET", "HEAD"].includes(method)) return deny(report.blocked.otherWrites, "ACCEPTANCE_WRITE_BLOCKED");
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", () => report.pageErrors.push({ code: "BROWSER_PAGE_ERROR" }));
    page.on("response", response => {
      const req = response.request(), url = new URL(response.url());
      if (url.origin === ORIGIN && url.pathname === "/api/cover/prepare") {
        let action;
        try { action = req.method() === "POST" ? req.postDataJSON()?.action : "get"; } catch { action = "invalid"; }
        report.requests.push({ source: "browser", path: url.pathname, method: req.method(), action, httpStatus: response.status() });
      }
    });
    const screenshot = async name => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(directory, name), fullPage: false });
      report.screenshots.push(name);
    };
    stage = "browser-first-prepare";
    await page.goto(`${ORIGIN}/cover`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
    ensure(new URL(page.url()).pathname === "/cover", "BROWSER_COVER_REDIRECTED");
    await page.waitForFunction(modelId => [...document.querySelectorAll("#cover-workbench-model option")].some(option => option.value === modelId), selection.modelId);
    await page.locator("#cover-workbench-model").selectOption(selection.modelId);
    await page.locator("#cover-workbench-resolution").selectOption("2K");
    await page.getByRole("button", { name: new RegExp(`^${selection.ratio}\\s`) }).click();
    await page.locator("#cover-workbench-text").fill(uiText);
    const primary = page.getByRole("button", { name: "生成封面", exact: true });
    await primary.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "生成封面" && !button.disabled));
    ensure(await primary.isEnabled(), "BROWSER_FIRST_PREPARE_DISABLED");
    const preparedResponsePromise = page.waitForResponse(response => {
      if (new URL(response.url()).pathname !== "/api/cover/prepare" || response.request().method() !== "POST") return false;
      try { return response.request().postDataJSON()?.action === "prepare"; } catch { return false; }
    });
    await primary.click();
    const preparedResponse = await preparedResponsePromise;
    const prepared = await preparedResponse.json().catch(() => null);
    ensure(preparedResponse.status() === 200, "BROWSER_REAL_PREPARE_HTTP_FAILED");
    checkPrepared(prepared, uiMaterials);
    uiOperationId = prepared.operationId; operationIds.add(uiOperationId);
    report.operations.push({ source: "ui", operationId: uiOperationId, clientRequestId: uiMaterials.clientRequestId, testTextFingerprint: digest(uiText) });
    await page.getByRole("button", { name: "确认费用并制作", exact: true }).waitFor();
    ensure(uiPrepareCount === 1, "BROWSER_UNEXPECTED_PREPARE_COUNT");
    const sessionKey = `cover-workbench-operation-v2:${identity.user.id}`;
    const draftKey = `cover-workbench-draft-v2:${identity.user.id}`;
    await page.waitForFunction(({ draftKey: key, expectedText, modelId }) => {
      try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value?.text === expectedText && value.modelId === modelId && value.assets?.length === 0; } catch { return false; }
    }, { draftKey, expectedText: uiText, modelId: selection.modelId });
    const persisted = await page.evaluate(key => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } }, sessionKey);
    ensure(persisted?.operationId === uiOperationId && persisted.clientRequestId === uiMaterials.clientRequestId && persisted.phase === "prepare", "BROWSER_PENDING_REFERENCE_NOT_PERSISTED");
    await screenshot("01-real-prepared.png");
    mark("real-UI-first-primary-creates-prepared-with-fees-and-pending-reference", { operationId: uiOperationId, prepareRequests: uiPrepareCount });

    stage = "browser-refresh-recovery";
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
    await page.waitForFunction(expected => document.querySelector("#cover-workbench-text")?.value === expected, uiText);
    ensure(await page.locator("#cover-workbench-model").inputValue() === selection.modelId, "REFRESH_MODEL_NOT_RESTORED");
    ensure(await page.locator("#cover-workbench-resolution").inputValue() === "2K", "REFRESH_RESOLUTION_NOT_RESTORED");
    ensure(await page.getByRole("button", { name: new RegExp(`^${selection.ratio}\\s`) }).getAttribute("aria-pressed") === "true", "REFRESH_RATIO_NOT_RESTORED");
    const recoveryResponsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === "/api/cover/prepare" && url.searchParams.get("operationId") === uiOperationId;
    });
    await page.getByRole("button", { name: "查询原任务状态", exact: true }).click();
    const recoveryResponse = await recoveryResponsePromise;
    const recovered = await recoveryResponse.json().catch(() => null);
    ensure(recoveryResponse.status() === 200, "BROWSER_RECOVERY_GET_HTTP_FAILED");
    checkPrepared(recovered, uiMaterials, uiOperationId);
    await page.getByRole("button", { name: "恢复原任务材料", exact: true }).click();
    await page.getByRole("button", { name: "确认费用并制作", exact: true }).waitFor();
    ensure(await page.locator("#cover-workbench-text").inputValue() === uiText, "RECOVERY_MATERIAL_TEXT_CHANGED");
    ensure(uiPrepareCount === 1 && uiPrepareBodies.length === 1, "REFRESH_RESUBMITTED_PREPARE");
    const finalReference = await page.evaluate(key => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } }, sessionKey);
    ensure(finalReference?.operationId === uiOperationId, "RECOVERY_OPERATION_ID_CHANGED");
    await screenshot("02-refreshed-original-prepared-recovered.png");
    mark("real-page-refresh-restores-draft-and-GET-recovers-same-prepared-without-resubmission", { operationId: uiOperationId });

    stage = "final-boundary-checks";
    ensure(report.blocked.paidOrMutating.length === 0, "UI_ATTEMPTED_PAID_OR_MUTATING_ROUTE");
    ensure(report.blocked.invalidPrepare.length === 0, "UI_ATTEMPTED_INVALID_PREPARE_ROUTE");
    ensure(report.pageErrors.length === 0, "BROWSER_RUNTIME_ERROR");
    const final = await request(`/api/cover/prepare?${new URLSearchParams({ operationId: uiOperationId })}`);
    ensure(final.response.status === 200, "FINAL_PREPARED_GET_HTTP_FAILED");
    checkPrepared(final.payload, uiMaterials, uiOperationId);
    mark("final-real-parent-remains-prepared-and-no-analysis-or-generation-was-forwarded");
    report.forwardedPrepareRequests = report.requests.filter(item => item.source === "runner" && item.method === "POST" && item.action === "prepare").length + uiPrepareCount;
    report.retainedTestOperations = operationIds.size;
    report.passed = true;
  } catch (error) {
    report.failure = { stage, code: codeOnly(error) };
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    report.caseCount = report.cases.length;
    // Write no request/response bodies, authorization headers, cookies, tokens,
    // identity, session IDs, model bindings, provider URLs, or account data.
    await fs.mkdir(directory, { recursive: true });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    assert.ok(!token || !serialized.includes(token), "SESSION_TOKEN_MUST_NOT_BE_PERSISTED");
    assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u);
    await fs.writeFile(reportPath, serialized, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ passed: report.passed, caseCount: report.caseCount, failure: report.failure,
      providerCalls: report.providerCalls, llmCalls: report.llmCalls, imageGenerationCalls: report.imageGenerationCalls,
      retainedTestOperations: operationIds.size, recordsDeleted: 0, report: reportPath,
      screenshots: report.screenshots.map(file => path.join(directory, file)) }));
  }
}
