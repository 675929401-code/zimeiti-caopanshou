import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import sharp from "sharp";

// One explicitly selected case, submitted through the product's real controls.
// A consumed marker is permanent: a timeout is not permission to submit again.
const root = path.resolve(".codex-evidence/cover-rebuild-20261106-bc1a");
const origin = "http://127.0.0.1:5000";
const caseId = process.argv.find(value => value.startsWith("--case="))?.slice(7);
assert.match(caseId || "", /^[a-z0-9_-]{3,80}$/u);
const manifest = JSON.parse(await fs.readFile(path.join(root, "acceptance-cases.json"), "utf8"));
const scenario = manifest.cases.find(item => item.id === caseId);
assert.ok(scenario, "Case must be registered before browser submission");
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "null");
assert.ok(token && identity?.user?.id, "A normal authenticated local session is required");
const executePaid = process.argv.includes("--execute-paid");
assert.ok(!executePaid || process.env.COVER_ACCEPT_PAID === "1", "Explicit paid execution flag required");
const directory = path.join(root, "cases", caseId);
await fs.mkdir(directory, { recursive: true });
const marker = path.join(directory, "paid-submission-consumed.json");
const report = { caseId, startedAt: new Date().toISOString(), input: scenario, origin,
  authentication: "normal registered account session", mode: executePaid ? "real-browser-paid" : "free-preparation-only",
  status: "running", prepareReplies: [], attemptReplies: [], errors: [], downloads: [], historyReadback: null };
const save = () => fs.writeFile(path.join(directory, executePaid ? "report.json" : "preflight.json"), JSON.stringify(report, null, 2));
const clean = value => String(value).split(token).join("[redacted]").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted]").slice(0, 700);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const owned = value => ({ id: value.id, status: value.status, code: value.code, taskId: value.taskId,
  taskNo: value.taskNo, createdAt: value.createdAt,
  assetId: value.assetId, historyRecordId: value.historyRecordId, prepareOperationId: value.prepareOperationId,
  title: value.title, subtitle: value.subtitle, ratio: value.ratio, modelName: value.modelName,
  renderPlan: value.renderPlan, textVerification: value.textVerification,
  textRendering: value.textRendering, requestedText: value.requestedText,
  clientIdempotencyKey: value.clientIdempotencyKey, clientTraceId: value.clientTraceId,
  cloudStored: value.cloudStored, outputWidth: value.outputWidth ?? value.width, outputHeight: value.outputHeight ?? value.height });
const browser = await chromium.launch({ headless: true });
let pendingCapture = Promise.resolve();
let authenticatedContext;
try {
  if (executePaid) {
    try { await fs.access(marker); throw new Error("ALREADY_SUBMITTED_QUERY_ORIGINAL_ONLY"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  authenticatedContext = context;
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ token, user }) => {
    window.showSaveFilePicker = undefined;
    localStorage.setItem("auth_token", token); localStorage.setItem("auth_user", JSON.stringify(user)); sessionStorage.setItem("entered_app", "1");
  }, { token, user: identity.user });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(clean(error.message)));
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin !== origin || !["/api/cover/prepare", "/api/cover/attempt", "/api/cover/render"].includes(url.pathname)) return;
    pendingCapture = pendingCapture.then(async () => {
      const body = await response.json().catch(() => null);
      if (!body) return;
      if (url.pathname === "/api/cover/prepare") report.prepareReplies.push({ at: new Date().toISOString(), httpStatus: response.status(),
        operationId: body.operationId, status: body.status, code: body.code, error: body.error, quote: body.quote,
        analysis: body.analysis, analysisIssue: body.analysisIssue, layoutPlan: body.layoutPlan, renderPlan: body.renderPlan,
        generationIdentity: body.generationIdentity, generationPrompt: body.generationInput?.prompt,
        analysisPromptVersion: body.analysisPromptVersion, promptDependenciesFingerprint: body.promptDependenciesFingerprint,
        style: body.style, outputSpec: body.outputSpec, generationSpec: body.generationSpec,
        materials: body.materials, notices: body.notices, billing: body.billing });
      else if (url.pathname === "/api/cover/render") report.originalRenderReceipt = { httpStatus: response.status(), ...owned(body), renderedText: body.renderedText };
      else report.attemptReplies.push({ at: new Date().toISOString(), httpStatus: response.status(), code: body.code,
        completed: body.completed, state: typeof body.state === "string" ? body.state : undefined, error: body.error ? clean(body.error) : undefined,
        attempt: body.activeAttempt || body.terminalAttempt ? {
          state: (body.activeAttempt || body.terminalAttempt).state,
          clientIdempotencyKey: (body.activeAttempt || body.terminalAttempt).clientIdempotencyKey,
          clientTraceId: (body.activeAttempt || body.terminalAttempt).clientTraceId,
          task: owned((body.activeAttempt || body.terminalAttempt).task || {}) } : undefined,
        result: body.result ? owned(body.result) : undefined });
      await save();
    }).catch(error => report.errors.push(clean(error.message)));
  });
  await page.goto(origin + "/cover", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
  const modeLabels = { script: "动画风格", product: "商品封面", reference: "参考封面", background: "原图排版" };
  await page.getByRole("navigation", { name: "封面制作方式" }).getByRole("button", { name: modeLabels[scenario.mode], exact: true }).click();
  await page.locator("#cover-workbench-text").fill(scenario.text);
  if (scenario.assets?.length) {
    await page.locator('input[type="file"]').setInputFiles(scenario.assets.map(asset => path.resolve(asset.path)));
    await page.waitForFunction(() => !document.body.innerText.includes("正在上传…"), undefined, { timeout: 120_000 });
    await page.waitForTimeout(300);
  }
  if (scenario.mode === "script") await page.locator("#cover-workbench-style").selectOption(scenario.style);
  if (scenario.mode !== "background") {
    await page.locator("#cover-workbench-model").selectOption(scenario.modelId);
    await page.locator("#cover-workbench-resolution").selectOption(scenario.resolution);
  }
  await page.getByRole("button", { name: new RegExp(`^${scenario.ratio.replace(":", ":")}`) }).click();
  await page.screenshot({ path: path.join(directory, "01-input.png"), fullPage: false });
  const firstReply = page.waitForResponse(response => new URL(response.url()).pathname === "/api/cover/prepare" && response.request().method() === "POST");
  await page.getByRole("button", { name: "生成封面", exact: true }).click();
  const preparedResponse = await firstReply;
  const prepared = await preparedResponse.json();
  await pendingCapture;
  assert.equal(preparedResponse.status(), 200, prepared.code || "Preparation failed");
  assert.equal(prepared.status, "prepared", "Case requires a fresh, reviewable preparation");
  assert.equal(prepared.quote?.image?.ready, true);
  assert.equal(prepared.quote?.image?.unit, 'yuan', 'CURRENCY_UNIT');
  assert.ok(Number(prepared.quote?.image?.amount) <= scenario.maximumImageYuan, "Quoted image cost exceeds the registered case cap");
  if (scenario.mode !== "background") assert.equal(prepared.quote.image.modelId, scenario.modelId);
  report.operationId = prepared.operationId;
  report.quote = prepared.quote;
  await page.screenshot({ path: path.join(directory, "02-prepared-quote.png"), fullPage: false });
  if (!executePaid) { report.status = "free-preparation-passed"; await save(); }
  else {
    await fs.writeFile(marker, JSON.stringify({ caseId, operationId: prepared.operationId, consumedAt: new Date().toISOString(), quote: prepared.quote,
      authorization: "cover-workbench-v2 intent v6 and current user request; necessary paid acceptance after free checks", neverAutomaticResubmit: true }, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ event: "confirmed-once", caseId, operationId: prepared.operationId, imageYuan: prepared.quote.image.amount }));
    await page.getByRole("button", { name: "确认费用并制作", exact: true }).click();
    const deadline = Date.now() + 20 * 60_000;
    let complete = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2500);
      const download = page.getByRole("button", { name: "下载封面", exact: true });
      if (await download.isVisible().catch(() => false) && await download.isEnabled()) { complete = true; break; }
      const recovery = page.getByRole("button", { name: "查询原任务状态", exact: true });
      if (await recovery.isVisible().catch(() => false) && await recovery.isEnabled()) {
        // Never dispatch a second create: only the product's original-ID query.
        report.originalQueryCount = (report.originalQueryCount || 0) + 1;
        await recovery.click();
        if (report.originalQueryCount >= 5) break;
        await page.waitForTimeout(5000);
      }
      if (report.prepareReplies.some(reply => ["failed", "needs_input"].includes(reply.status))) break;
    }
    await pendingCapture;
    await page.screenshot({ path: path.join(directory, "03-result.png"), fullPage: false });
    if (!complete) {
      report.status = "not-delivered-query-original-only";
      report.visibleStatus = clean(await page.locator("main").innerText());
      await save(); throw new Error("DELIVERY_NOT_CONFIRMED_NO_RESUBMIT");
    }
    const downloadEvent = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "下载封面", exact: true }).click();
    const downloaded = await downloadEvent;
    const filename = path.join(directory, "cover.png");
    await downloaded.saveAs(filename);
    const bytes = await fs.readFile(filename); const metadata = await sharp(bytes).metadata();
    const expected = { "3:4": [1080, 1440], "16:9": [1920, 1080], "4:3": [1440, 1080], "9:16": [1080, 1920] }[scenario.ratio];
    assert.deepEqual([metadata.width, metadata.height], expected);
    report.downloads.push({ filename: "cover.png", bytes: bytes.length, sha256: hash(bytes), width: metadata.width, height: metadata.height });
    const historyResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/cover/history" && response.request().method() === "GET");
    await page.getByRole("button", { name: "历史作品", exact: true }).click();
    const history = await (await historyResponse).json();
    const delivery = scenario.mode === "background" ? report.originalRenderReceipt
      : report.attemptReplies.findLast(reply => reply.completed === true && reply.result?.assetId)?.result;
    assert.ok(delivery?.assetId && delivery.historyRecordId, "completed original attempt must identify saved assets");
    const exactRecord = history.records?.find(record => record.assetId === delivery.assetId && record.historyRecordId === delivery.historyRecordId);
    assert.ok(exactRecord?.assetId && exactRecord.historyRecordId, "history must contain this same delivered asset, not another recent output");
    const historyCard = page.locator(`[data-cover-asset-id="${exactRecord.assetId}"]`);
    await historyCard.waitFor({ timeout: 30_000 });
    report.historyReadback = { ...owned(exactRecord), assetId: await historyCard.getAttribute("data-cover-asset-id"), historyRecordId: await historyCard.getAttribute("data-cover-history-id"), label: await historyCard.innerText() };
    assert.ok(report.historyReadback.assetId && report.historyReadback.historyRecordId);
    await page.screenshot({ path: path.join(directory, "04-history.png"), fullPage: false });
    await historyCard.click();
    await page.getByRole("button", { name: "下载封面", exact: true }).waitFor();
    const historyDownloadEvent = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "下载封面", exact: true }).click();
    const historyDownload = await historyDownloadEvent;
    const historyFilename = path.join(directory, "history-cover.png");
    await historyDownload.saveAs(historyFilename);
    const historyBytes = await fs.readFile(historyFilename);
    assert.equal(hash(historyBytes), hash(bytes), "Reopened history must download the exact saved output");
    report.downloads.push({ filename: "history-cover.png", bytes: historyBytes.length, sha256: hash(historyBytes), matchesFirstDownload: true });
    report.status = "delivered-visual-review-required";
    report.visualAcceptance = "not-evaluated";
    await save();
    console.log(JSON.stringify({ event: "delivered", caseId, operationId: report.operationId, download: report.downloads[0], history: report.historyReadback }));
  }
} catch (error) {
  report.errors.push(clean(error.message));
  if (report.status === "running") report.status = "failed-or-unknown";
  await save(); console.error(JSON.stringify({ caseId, status: report.status, error: clean(error.message) })); process.exitCode = 1;
} finally {
  await pendingCapture;
  if (executePaid && report.operationId && authenticatedContext) {
    const getOriginal = async pathname => {
      const response = await authenticatedContext.request.get(origin + pathname, { headers: { Authorization: `Bearer ${token}` }, timeout: 30_000 });
      return { httpStatus: response.status(), body: await response.json() };
    };
    try {
      const original = await getOriginal(`/api/cover/prepare?operationId=${encodeURIComponent(report.operationId)}`);
      report.analysisSettlementReceipt = { httpStatus: original.httpStatus, operationId: original.body.operationId,
        status: original.body.status, billing: original.body.billing, analysisIssue: original.body.analysisIssue,
        quote: original.body.quote, verification: "exact preparation settlement response; ledger join recorded separately" };
      if (scenario.mode !== "background") {
        const keys = `clientIdempotencyKey=coverwb_${report.operationId}&clientTraceId=coverwb_${report.operationId}`;
        const originalImage = await getOriginal(`/api/image/status?${keys}`);
        const value = originalImage.body;
        report.imageSettlementReceipt = { httpStatus: originalImage.httpStatus, state: value.state, recordId: value.recordId,
          code: value.code, generationCompleted: value.generationCompleted, deliveryReady: value.deliveryReady,
          cashCharged: value.cashCharged, billingReferenceId: value.billingReferenceId, billingHeld: value.billingHeld,
          billingReleaseState: value.billingReleaseState, canResubmit: value.canResubmit,
          verification: "exact original image status; cashCharged can be a quoted-price projection and requires ledger join" };
      }
    } catch (error) { report.errors.push(`Original receipt readback: ${clean(error.message)}`); }
  }
  report.completedAt = new Date().toISOString(); await save(); await browser.close();
}
