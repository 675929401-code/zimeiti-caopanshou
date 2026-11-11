import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

// Real account, real UI, separate analysis and image consent. No request
// interception can provide a generated result or impersonate a server reply.
const origin = "http://127.0.0.1:5000";
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "null");
const manifest = JSON.parse(await fs.readFile(process.env.COVER_CASE_MANIFEST, "utf8"));
const scenario = manifest.cases.find(item => item.id === process.env.COVER_CASE_ID);
assert.ok(token && identity?.user?.id && scenario);
const executePaid = process.argv.includes("--execute-paid");
const directory = path.resolve(process.env.COVER_REAL_EVIDENCE_ROOT, "cases", scenario.id);
await fs.mkdir(directory, { recursive: true });
const report = { schemaVersion: "cover-review-real-browser/1", id: scenario.id, startedAt: new Date().toISOString(),
  scope: executePaid ? "real-page-confirmed-provider-acceptance" : "real-page-free-preparation", status: "running", scenario,
  replies: [], errors: [], downloads: [], historyReadback: null };
// Serialize a detached copy only. The browser, downloads and in-memory receipt
// must retain their original signed URLs while disk evidence omits authority.
function reportForDisk(value) {
  const authKey = key => /^(?:qsign.*|qak|qkeytime|qheaderlist|qurlparamlist|signature|sig|sign|token|accesstoken|authtoken|authkey|authorization|apikey|awsaccesskeyid|ossaccesskeyid|googleaccessid|securitytoken|credential|keypairid|policy)$/u.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ""))
    || /^(?:xamz|xgoog|xoss)/u.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ""));
  const stripAuthority = (text, relative = false) => {
    try {
      const parsed = new URL(text, relative ? "https://report.invalid" : undefined);
      if (![...parsed.searchParams.keys()].some(authKey)) return text;
      return relative ? text.startsWith("//") ? `//${parsed.host}${parsed.pathname}` : parsed.pathname : parsed.origin + parsed.pathname;
    } catch { return text; }
  };
  if (typeof value === "string") {
    if (/^\/[^\s]*$/u.test(value)) return stripAuthority(value, true);
    return value.replace(/https?:\/\/[^\s<>"'`]+/giu, match => {
      const ending = match.match(/[)\]}>）】》」』，。；！？、]+$/u)?.[0] || "";
      return stripAuthority(ending ? match.slice(0, -ending.length) : match) + ending;
    });
  }
  if (Array.isArray(value)) return value.map(reportForDisk);
  if (value && typeof value === "object") {
    if (typeof value.toJSON === "function") return reportForDisk(value.toJSON());
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, reportForDisk(entry)]));
  }
  return value;
}
const save = () => fs.writeFile(path.join(directory, executePaid ? "report.json" : "preflight.json"), JSON.stringify(reportForDisk(report), null, 2));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const clean = value => String(value).split(token).join("[redacted]").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted]").slice(0, 500);
const consentMarker = async phase => fs.writeFile(path.join(directory, `${phase}-submit-consumed.json`), JSON.stringify({ caseId: scenario.id, phase, at: new Date().toISOString(), instruction: "Never resubmit; query the original operation only." }), { flag: "wx" });
let captures = Promise.resolve();
const browser = await chromium.launch({ headless: true });
try {
  for (const phase of ["analysis", "confirmation", "image"]) {
    try { await fs.access(path.join(directory, `${phase}-submit-consumed.json`)); throw new Error("ALREADY_SUBMITTED_QUERY_ORIGINAL_ONLY"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, serviceWorkers: "block" });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ token, user, scenario }) => {
    // This driver validates the browser-managed download and history file bytes.
    window.showSaveFilePicker = undefined;
    localStorage.setItem("auth_token", token); localStorage.setItem("auth_user", JSON.stringify(user)); sessionStorage.setItem("entered_app", "1");
    if (scenario.reuseAnalysisOperationId) localStorage.setItem(`cover-workbench-operation-v2:${user.id}`, JSON.stringify({ workflowVersion: 3,
      operationId: scenario.reuseAnalysisOperationId, clientRequestId: scenario.reuseAnalysisClientRequestId || "recover_existing_analysis", phase: "review" }));
  }, { token, user: identity.user, scenario });
  let analysisRequests = 0, confirmationRequests = 0, executionRequests = 0;
  await context.route("**/api/cover-workbench/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "POST" && !url.pathname.endsWith("/prepare")) {
      if (!executePaid) return route.abort("blockedbyclient");
      if (url.pathname.endsWith("/analyze")) { assert.ok(!scenario.reuseAnalysisOperationId); assert.equal(++analysisRequests, 1); }
      else if (url.pathname.endsWith("/confirm")) assert.equal(++confirmationRequests, 1);
      else if (url.pathname.endsWith("/execute")) assert.equal(++executionRequests, 1);
      else throw Error("Unexpected paid workflow mutation");
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(clean(error.message)));
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin !== origin || !url.pathname.startsWith("/api/cover-workbench/")) return;
    captures = captures.then(async () => { const body = await response.json().catch(() => null);
      if (body) { report.replies.push({ at: new Date().toISOString(), path: url.pathname, method: response.request().method(), httpStatus: response.status(), body }); await save(); }
    }).catch(error => report.errors.push(clean(error.message)));
  });
  await page.goto(origin + "/cover", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
  if (scenario.reuseAnalysisOperationId) {
    await page.getByLabel("方案封面标题", { exact: true }).waitFor({ timeout: 120_000 });
  } else {
    const modes = { script: "动画封面", product: "商品封面", reference: "参考封面", background: "原图排版" };
    await page.getByRole("navigation", { name: "封面制作方式" }).getByRole("button", { name: modes[scenario.mode], exact: true }).click();
    await page.locator("#cover-workbench-text").fill(scenario.text);
    if (scenario.assets?.length) { await page.locator('input[type="file"]').setInputFiles(scenario.assets.map(item => path.resolve(item.path)));
      await page.waitForFunction(() => !document.body.innerText.includes("正在上传…"), undefined, { timeout: 120_000 }); }
    if (scenario.mode === "script") {
      await page.locator("#cover-workbench-style").click();
      await page.getByRole("dialog", { name: "选择画面风格" }).getByRole("button", { name: new RegExp(scenario.style === "funny-cartoon" ? "趣味反差" : "暖光叙事") }).click();
    }
    if (scenario.mode !== "background") { await page.locator("#cover-workbench-model").selectOption(scenario.modelId); await page.locator("#cover-workbench-resolution").selectOption(scenario.resolution); }
    await page.getByRole("button", { name: new RegExp(`^${scenario.ratio}`) }).click();
    await page.getByRole("button", { name: "下一步：拆解内容", exact: true }).click();
    await page.getByRole("button", { name: /确认费用并拆解|拆解已完成/u }).waitFor(); await captures;
  }
  const prepared = [...report.replies].reverse().find(item => item.body.kind === "analysis")?.body;
  assert.ok(prepared?.operationId, "A durable analysis operation must exist before consent");
  if (scenario.mode !== "background") assert.ok(prepared.quote?.image?.ready && prepared.quote.image.amount <= scenario.maximumImageYuan, "Live quote must match the case ceiling");
  await page.screenshot({ path: path.join(directory, "prepared.png") });
  if (!executePaid) { report.status = "prepared_without_paid_calls"; }
  else {
    if (prepared.status !== "review_ready") {
      await consentMarker("analysis"); await page.getByRole("button", { name: "确认费用并拆解", exact: true }).click();
      await page.getByLabel("方案封面标题", { exact: true }).waitFor({ timeout: 240_000 });
    }
    await captures;
    if (scenario.edits?.primaryTitle) await page.getByLabel("方案封面标题", { exact: true }).fill(scenario.edits.primaryTitle);
    if (scenario.edits?.visualBrief?.action) await page.getByLabel("方案动作与画面关系", { exact: true }).fill(scenario.edits.visualBrief.action);
    await page.screenshot({ path: path.join(directory, "review-before-confirmation.png") });
    // The UI's single confirmation click performs the private compile and then
    // submits exactly one image; reserve both markers before that click.
    await consentMarker("confirmation"); await consentMarker("image");
    await page.getByRole("button", { name: "确认方案并生成封面", exact: true }).click();
    const end = Date.now() + 12 * 60_000;
    while (Date.now() < end) {
      await captures;
      const last = [...report.replies].reverse().find(item => item.path.endsWith("/execute"));
      const rejected = [...report.replies].reverse().find(item => item.httpStatus >= 400);
      if (rejected) { report.status = "rejected_query_original_only"; break; }
      if (last?.body.status === "completed" || last?.body.status === "failed") break;
      if (last?.body.status === "unknown") { report.status = "unknown_query_original_only"; break; }
      if (last && last.httpStatus >= 400) { report.status = "rejected_query_original_only"; break; }
      await page.waitForTimeout(2000);
    }
    await captures;
    const delivered = [...report.replies].reverse().find(item => item.path.endsWith("/execute") && item.body.status === "completed")?.body;
    if (!delivered?.task?.assetId || delivered.task.cloudStored !== true || !delivered.task.historyRecordId) {
      report.status = report.status === "running" ? "not_completed_query_original_only" : report.status;
      await page.screenshot({ path: path.join(directory, "incomplete.png") });
    } else {
      report.confirmationId = delivered.confirmationId; report.delivered = delivered.task;
      const visible = page.getByRole("img", { name: `封面：${delivered.task.title}`, exact: true }); await visible.waitFor();
      await visible.evaluate(img => img.complete && img.naturalWidth > 0 ? Promise.resolve() : new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; }));
      await page.screenshot({ path: path.join(directory, "completed.png") });
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "下载封面", exact: true }).click()]);
      const outputFile = path.join(directory, "download.png"); await download.saveAs(outputFile);
      const bytes = await fs.readFile(outputFile), metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, delivered.task.outputWidth); assert.equal(metadata.height, delivered.task.outputHeight);
      report.downloads.push({ file: outputFile, sha256: digest(bytes), width: metadata.width, height: metadata.height, filename: download.suggestedFilename() });
      await page.getByRole("button", { name: "历史作品", exact: true }).click();
      const card = page.locator(`[data-cover-asset-id="${delivered.task.assetId}"][data-cover-history-id="${delivered.task.historyRecordId}"]`);
      await card.waitFor(); await card.click();
      const [second] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "下载封面", exact: true }).click()]);
      const secondFile = path.join(directory, "history-download.png"); await second.saveAs(secondFile);
      assert.equal(digest(await fs.readFile(secondFile)), digest(bytes));
      report.historyReadback = { assetId: delivered.task.assetId, historyRecordId: delivered.task.historyRecordId, downloadSha256: digest(bytes), exactMatch: true };
      report.status = "completed_pending_visual_and_ledger_review";
    }
  }
  report.requestCounts = { analysis: analysisRequests, confirmation: confirmationRequests, execution: executionRequests };
} catch (error) { report.status = report.status === "running" ? "failed_query_original_only" : report.status; report.errors.push(clean(error.stack || error.message)); process.exitCode = 1; }
finally { await captures; report.finishedAt = new Date().toISOString(); await save(); await browser.close(); console.log(JSON.stringify({ id: scenario.id, status: report.status, directory, errors: report.errors })); }
