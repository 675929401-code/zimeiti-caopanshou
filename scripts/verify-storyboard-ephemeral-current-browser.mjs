#!/usr/bin/env node
// Run through with-local-customer-session.mjs after the coordinator's current build.
// Browser writes are intercepted in RAM. This is a synthetic UI check, not paid E2E.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const approvedApiGets = new Set(["/api/version", "/api/auth/me", "/api/member-permissions", "/api/cover-models", "/api/video/models"]);
function isStaticEntry(url) {
  if (url.pathname === "/storyboard-workbench" || url.pathname.startsWith("/_next/static/")) return true;
  // Only actual public files qualify; API/dynamic/media proxy endpoints cannot match.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return false;
  try {
    const publicRoot = path.resolve("public");
    const target = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
    return target.startsWith(`${publicRoot}${path.sep}`) && statSync(target).isFile();
  } catch { return false; }
}
function loadContract(file, dependencies) {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, require: (name) => {
    assert.ok(name in dependencies, "UNEXPECTED_CONTRACT_IMPORT");
    return dependencies[name];
  } });
  return module.exports;
}
function assertMetadata(value) {
  if (typeof value === "string") assert.equal(/^(?:blob:|data:[^,]+;base64,)/iu.test(value), false, "PERSISTED_MEDIA_URL");
  else if (Array.isArray(value)) {
    assert.equal(value.length > 0 && value.every((item) => typeof item === "number"), false, "PERSISTED_BYTE_ARRAY");
    value.forEach(assertMetadata);
  } else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    assert.equal(/^(?:base64|bytes|buffer|dataUrl|transientDelivery)$/iu.test(key), false, "PERSISTED_BINARY_FIELD");
    assertMetadata(item);
  }
}
export async function fulfillApprovedStoryboardRead(route, report) {
  const response = await route.fetch({ maxRedirects: 0 });
  if (!response.ok() || response.status() >= 300 && response.status() < 400) {
    report.approvedReadRejectedCount++;
    return route.abort("blockedbyclient");
  }
  return route.fulfill({ response });
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
  const runtime = await response.json();
  const disk = JSON.parse(versionText.replace(/^\uFEFF/u, ""));
  const receipt = JSON.parse(receiptText.replace(/^\uFEFF/u, ""));
  const current = computeLocalBuildFingerprint(process.cwd());
  assert.equal(receipt.schemaVersion, 1, "FINGERPRINT_RECEIPT_SCHEMA_MISMATCH");
  assert.equal(receipt.kind, "local-production-preview-source-fingerprint", "FINGERPRINT_RECEIPT_KIND_MISMATCH");
  assert.ok(runtime.sourceVersion && runtime.buildId, "PRODUCTION_BUILD_ID_REQUIRED");
  assert.equal(runtime.sourceVersion, disk.sourceVersion, "SOURCE_VERSION_MISMATCH");
  assert.equal(runtime.buildId, buildText.trim(), "RUNTIME_BUILD_MISMATCH");
  assert.equal(receipt.buildId, runtime.buildId, "RECEIPT_BUILD_MISMATCH");
  assert.equal(receipt.fingerprint, current.fingerprint, "CURRENT_SOURCE_FINGERPRINT_MISMATCH");
  assert.equal(receipt.fileCount, current.fileCount, "CURRENT_SOURCE_COUNT_MISMATCH");
  return { sourceVersion: runtime.sourceVersion, buildId: runtime.buildId, fingerprint: current.fingerprint, runningLatest: true };
}

export async function main() {
  assert.equal(process.version, "v24.19.0", "PINNED_NODE_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/$/u, "");
  assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_ORIGIN_REQUIRED");
  const token = process.env.R267_CUSTOMER_TOKEN;
  const user = JSON.parse(process.env.LOCAL_NAV_READONLY_CUSTOMER || "null");
  assert.ok(token && user?.id && user.role === "student", "VERIFIED_CUSTOMER_WRAPPER_REQUIRED");
  assert.ok(process.env.STORYBOARD_EPHEMERAL_ACCEPTANCE_OUTPUT, "OUTPUT_DIRECTORY_REQUIRED");
  const output = path.resolve(process.env.STORYBOARD_EPHEMERAL_ACCEPTANCE_OUTPUT);
  await mkdir(output, { recursive: true });
  const report = {
    schema: "storyboard-ephemeral-current-browser.v1", checkedAt: new Date().toISOString(),
    scope: "Current Edge desktop UI with synthetic inline PNG and RAM-only project API; not paid E2E",
    passed: false, viewport: { width: 1440, height: 900 }, runtimeBefore: null, runtimeAfter: null,
    imagePostCount: 0, imageStatusGetCount: 0, upstreamRequests: 0, mediaTaskRequestsForwarded: 0, cosUploadRequestsForwarded: 0,
    counterScope: "Browser generation/media/task/COS requests are mocked or blocked. Server-internal effects of approved auth/permission/catalog GETs and the session wrapper are not audited; no blanket database-write claim.",
    downloadScope: "Explicit synthetic download may use a browser temporary file; its stream is hashed and the download deleted. No bytes are saved to evidence.",
    approvedApiGetPaths: [...approvedApiGets].sort(), approvedApiGetCounts: {},
    blockedNonGetCount: 0, blockedExternalCount: 0, blockedOtherGetCount: 0, forwardedNonGetCount: 0,
    projectPostCount: 0, projectDetailGetCount: 0, approvedReadRejectedCount: 0, stages: [],
  };
  let browser;
  let page;
  const cspEvents = [];
  let stage = "runtime gate";
  try {
    report.runtimeBefore = await runtimeIdentity(origin);
    const refs = loadContract("src/lib/generated-image-reference.ts", { zod: { z } });
    const contracts = loadContract("src/lib/storyboard-project-contract.ts", {
      zod: { z }, "@/lib/generated-image-reference": refs,
    });
    const saveSchema = z.object({ document: contracts.StoryboardProjectDocument, expectedRevision: z.number().int().nonnegative() }).strict();
    const recordId = sha("storyboard-inline-synthetic-current-browser-v1");
    const cashCharged = 0.01; // Synthetic receipt value, never debited.
    const projects = new Map();
    const writes = [];
    let armed = false;
    let synthetic;
    let syntheticRequest;
    const routeErrors = [];
    const summary = (record) => ({ id: record.document.id, title: record.document.title, revision: record.revision,
      createdAt: new Date(record.document.createdAt).toISOString(), updatedAt: new Date(record.document.updatedAt).toISOString(),
      submittedAt: new Date(record.document.lastSubmittedAt || record.document.updatedAt).toISOString(), cardCount: record.document.cards.length });
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: report.viewport, acceptDownloads: true, serviceWorkers: "block" });
    await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(({ sessionToken, identity }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(identity));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, identity: user });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.origin !== origin) { report.blockedExternalCount++; return route.abort("blockedbyclient"); }
      try {
        if (url.pathname === "/api/storyboard/projects" && method === "POST") {
          const payload = request.postDataJSON();
          assertMetadata(payload);
          const parsed = saveSchema.parse(payload);
          const previous = projects.get(parsed.document.id);
          assert.equal(parsed.expectedRevision, previous?.revision || 0, "PROJECT_REVISION_MISMATCH");
          const record = { document: structuredClone(parsed.document), revision: (previous?.revision || 0) + 1 };
          projects.set(parsed.document.id, record);
          writes.push(structuredClone(payload));
          report.lastSavedCardMetadata = parsed.document.cards.map(card => ({
            state: card.imageStatus, mode: card.imageDeliveryMode, recordIdPresent: Boolean(card.imageRecordId),
            billingState: card.imageBillingState, ...(typeof card.imagePriceCharged === "number" && Number.isFinite(card.imagePriceCharged) ? { fee: card.imagePriceCharged } : {}),
          }));
          report.projectPostCount++;
          return json(route, { project: summary(record) });
        }
        if (url.pathname === "/api/storyboard/projects" && method === "GET") {
          const id = url.searchParams.get("id");
          if (!id) return json(route, { projects: [...projects.values()].map(summary), nextOffset: null });
          report.projectDetailGetCount++;
          const record = projects.get(id);
          return record ? json(route, { project: { ...summary(record), document: record.document } }) : json(route, { error: "RAM project missing" }, 404);
        }
        if (url.pathname === "/api/image/generate" && method === "POST") {
          report.imagePostCount++;
          assert.ok(armed && report.imagePostCount === 1, "UNEXPECTED_OR_AUTOMATIC_IMAGE_POST");
          armed = false;
          const body = request.postDataJSON();
          syntheticRequest = { clientIdempotencyKey: body.clientIdempotencyKey, clientTraceId: body.clientTraceId };
          const sizes = { "16:9": [320, 180], "9:16": [180, 320], "1:1": [256, 256] };
          assert.ok(sizes[body.aspectRatio], "UNSUPPORTED_UI_RATIO");
          const [width, height] = sizes[body.aspectRatio];
          const buffer = await sharp({ create: { width, height, channels: 3, background: "#7b55d8" } }).png().toBuffer();
          synthetic = { width, height, sha256: sha(buffer), byteLength: buffer.length };
          report.selectedModelId = body.modelId;
          report.ratio = body.aspectRatio;
          return json(route, { recordId, deliveryMode: "inline_ephemeral", mediaAvailable: true, canRecover: false, canResubmit: false,
            cashCharged, billed: true, state: "completed", images: [{ url: `data:image/png;base64,${buffer.toString("base64")}`,
              recordId, deliveryMode: "inline_ephemeral", ephemeral: true, mediaAvailable: true, canRecover: false,
              width, height, dimensionsVerified: true }] });
        }
        if (url.pathname === "/api/image/status" && method === "GET") {
          report.imageStatusGetCount++;
          const bound = syntheticRequest && url.searchParams.get("clientIdempotencyKey") === syntheticRequest.clientIdempotencyKey
            && url.searchParams.get("clientTraceId") === syntheticRequest.clientTraceId;
          return bound ? json(route, {
            state: "completed", recordId, deliveryMode: "inline_ephemeral", mediaAvailable: false,
            canRecover: false, canResubmit: false, images: [], cashCharged, billed: true,
          }) : json(route, { state: "unknown", canRecover: false, canResubmit: false, images: [] }, 404);
        }
        if (method === "GET" && url.pathname === "/api/video/history") return json(route, { tasks: [] });
        if (method === "GET" && url.pathname === "/api/image-workbench/failure-history") return json(route, { records: [], nextPage: null });
        if (method !== "GET") { report.blockedNonGetCount++; return route.abort("blockedbyclient"); }
        if (approvedApiGets.has(url.pathname)) {
          report.approvedApiGetCounts[url.pathname] = (report.approvedApiGetCounts[url.pathname] || 0) + 1;
          return await fulfillApprovedStoryboardRead(route, report); // Actual read, no redirect hop.
        }
        if (isStaticEntry(url)) return await fulfillApprovedStoryboardRead(route, report);
        report.blockedOtherGetCount++;
        return route.abort("blockedbyclient"); // Includes every other task/history/status/lifecycle/media endpoint.
      } catch {
        routeErrors.push("FIXTURE_ROUTE_CONTRACT_FAILED");
        return json(route, { error: "Synthetic fixture contract failed" }, 500);
      }
    });
    page = await context.newPage();
    await page.exposeFunction("recordStoryboardCsp", (event) => {
      if (cspEvents.length < 100 && ["connect-src", "img-src"].includes(event?.directive) && ["data", "blob", "other"].includes(event?.scheme)) cspEvents.push({ directive: event.directive, scheme: event.scheme });
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", event => {
        const directive = event.effectiveDirective;
        const scheme = event.blockedURI.startsWith("data:") ? "data" : event.blockedURI.startsWith("blob:") ? "blob" : "other";
        if (directive === "connect-src" || directive === "img-src") void window.recordStoryboardCsp({ directive, scheme });
      });
    });
    page.setDefaultTimeout(30_000);
    page.on("dialog", (dialog) => void dialog.accept());
    stage = "real permission and catalog entry";
    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
    const models = page.locator('.sbw-image-model-list button[data-model-selectable="true"]');
    await models.first().waitFor({ state: "visible" });
    await models.first().click();
    const ratios = page.locator(".sbw-ratio-control button:not([disabled])");
    assert.ok(await ratios.count(), "NO_ACTUAL_MODEL_SUPPORTED_RATIO");
    await ratios.first().click();
    await page.getByRole("textbox", { name: "镜头1生图提示词", exact: true }).fill("Synthetic browser fixture: a purple rectangle. No real model call.");
    const generate = page.locator('button[title="生成故事板图片"]').first();
    assert.ok(await generate.isEnabled(), "ACTUAL_ENTRY_NOT_GENERATABLE");
    stage = "one manual UI generation";
    armed = true;
    await generate.click();
    const image = page.locator(".sbw-image-frame.has-result img").first();
    await image.waitFor({ state: "visible" });
    const decoded = await image.evaluate(async (element) => {
      await element.decode();
      return { blob: element.src.startsWith("blob:"), width: element.naturalWidth, height: element.naturalHeight };
    });
    assert.equal(decoded.blob, true, "INLINE_PREVIEW_NOT_BLOB");
    assert.equal(decoded.width, synthetic.width);
    assert.equal(decoded.height, synthetic.height);
    report.syntheticImage = synthetic;
    report.stages.push({ name: stage, passed: true, decoded });
    stage = "preview and explicit synthetic download";
    await page.locator('button[title="查看原图"]').first().click();
    const preview = page.getByRole("dialog").locator("img");
    await preview.waitFor({ state: "visible" });
    assert.ok(await preview.evaluate(async (element) => { await element.decode(); return element.naturalWidth > 0; }));
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    const downloadEvent = page.waitForEvent("download");
    await page.locator('button[title="下载故事板"]').first().click();
    const download = await downloadEvent;
    const stream = await download.createReadStream();
    assert.ok(stream, "DOWNLOAD_STREAM_MISSING");
    const chunks = []; let downloadedBytes = 0;
    for await (const chunk of stream) { downloadedBytes += chunk.length; assert.ok(downloadedBytes <= 2 * 1024 * 1024, "DOWNLOAD_TOO_LARGE"); chunks.push(chunk); }
    assert.equal(sha(Buffer.concat(chunks)), synthetic.sha256, "DOWNLOAD_BYTES_MISMATCH");
    await download.delete();
    report.stages.push({ name: stage, passed: true, downloadedBytes, sha256: synthetic.sha256 });
    await page.screenshot({ path: path.join(output, "inline-current-page.png"), fullPage: false });
    stage = "actual cloud POST projection and browser metadata";
    await assertEventually(() => writes.some((write) => write.document.cards.some((card) => card.imageRecordId === recordId && card.imageStatus === "done")), "COMPLETED_PROJECT_NOT_SAVED");
    const completed = [...writes].reverse().find((write) => write.document.cards.some((card) => card.imageRecordId === recordId));
    assertMetadata(completed);
    const savedCard = completed.document.cards.find((card) => card.imageRecordId === recordId);
    assert.equal(savedCard.imageDeliveryMode, "inline_ephemeral");
    assert.equal(savedCard.imagePriceCharged, cashCharged);
    assert.equal(savedCard.imageUrl, undefined);
    assert.equal(savedCard.imageRetryBlocked, true);
    assert.match(savedCard.imageError, /无法恢复/u);
    assert.match(await page.locator(".sbw-image-flow").first().innerText(), /实际扣费 ¥0\.01/u, "SYNTHETIC_FEE_NOT_VISIBLE");
    async function browserMetadata() {
      const entries = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => /storyboard/iu.test(key)));
      for (const [, raw] of entries) { try { assertMetadata(JSON.parse(raw)); } catch (error) { if (error instanceof SyntaxError) assertMetadata(raw); else throw error; } }
      return { keys: entries.map(([key]) => key), count: entries.length, sha256: sha(JSON.stringify(entries)) };
    }
    report.browserStorageBefore = await browserMetadata();
    report.projectProjection = { topKeys: Object.keys(completed.document).sort(), cardKeys: Object.keys(savedCard).sort(), sha256: sha(JSON.stringify(completed)), recordId, syntheticFee: cashCharged };
    report.stages.push({ name: stage, passed: true });
    stage = "reload receipt through RAM project GET";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "最近任务", exact: true }).click();
    const open = page.getByRole("button", { name: "打开任务", exact: true }).first();
    await open.waitFor({ state: "visible" });
    await open.click();
    await page.getByRole("textbox", { name: "镜头1生图提示词", exact: true }).waitFor();
    await page.locator(".sbw-error-line").filter({ hasText: /无法恢复/u }).first().waitFor({ state: "visible" });
    assert.equal(await page.locator(".sbw-image-frame.has-result img").count(), 0, "EPHEMERAL_IMAGE_RESTORED");
    assert.equal(await page.locator('button[title="下载故事板"]').count(), 0, "EPHEMERAL_DOWNLOAD_RESTORED");
    assert.ok(await page.locator(".is-image-command").first().isDisabled(), "RECEIPT_AUTOMATIC_RETRY_ALLOWED");
    assert.match(await page.locator(".sbw-image-flow").first().innerText(), /实际扣费 ¥0\.01/u, "RELOADED_FEE_NOT_VISIBLE");
    assert.equal(await page.locator(".sbw-shot-card").first().getAttribute("data-card-state"), "done", "COMPLETED_RECEIPT_BADGE_STATE");
    assert.equal(await page.locator(".is-image-command").first().innerText(), "图片不可恢复");
    assert.doesNotMatch(await page.locator(".sbw-image-flow").first().innerText(), /结果待确认|尚未生成/u);
    assert.ok(await page.getByRole("textbox", { name: "镜头1生图提示词", exact: true }).isEnabled(), "COMPLETED_RECEIPT_PROMPT_LOCKED");
    assert.equal(report.imageStatusGetCount, 0, "COMPLETED_RECEIPT_STATUS_POLLED");
    await page.waitForTimeout(9000); // Cross the component's 8-second status interval.
    assert.equal(report.imageStatusGetCount, 0, "COMPLETED_RECEIPT_STATUS_POLL_CONTINUED");
    assert.equal(report.imagePostCount, 1, "AUTOMATIC_IMAGE_REPLAY");
    assert.ok(report.projectDetailGetCount > 0, "PROJECT_RELOAD_NOT_EXERCISED");
    assert.equal(routeErrors.length, 0, "FIXTURE_CONTRACT_ERRORS");
    report.browserStorageAfter = await browserMetadata();
    assert.ok([...projects.values()].some((record) => record.document.cards.some((card) => card.imageRecordId === recordId && card.imagePriceCharged === cashCharged)), "RECEIPT_ID_OR_FEE_LOST");
    report.stages.push({ name: stage, passed: true, recordId, syntheticFee: cashCharged, mediaAvailable: false, canRecover: false });
    await page.screenshot({ path: path.join(output, "inline-reloaded-receipt.png"), fullPage: false });
    stage = "unchanged current build";
    report.runtimeAfter = await runtimeIdentity(origin);
    assert.deepEqual(report.runtimeAfter, report.runtimeBefore, "RUNTIME_CHANGED_DURING_CHECK");
    report.passed = true;
  } catch (error) {
    // Never persist Playwright call logs, URLs, DOM dumps, auth or response payloads.
    report.failure = { stage, name: error?.name === "AssertionError" ? "AssertionError" : "ExecutionError" };
    report.failureIndicators = { csp: cspEvents };
    if (page && !page.isClosed()) {
      try {
        report.failureIndicators.dom = await page.evaluate(() => ({
          cards: [...document.querySelectorAll(".sbw-shot-card")].map(card => ({ state: card.getAttribute("data-card-state"), hasError: Boolean(card.querySelector(".sbw-error-line")), feeVisible: /实际扣费/u.test(card.querySelector(".sbw-billing-line")?.textContent || "") })),
          images: [...document.querySelectorAll(".sbw-image-frame img")].map(image => ({ scheme: image.src.startsWith("blob:") ? "blob" : image.src.startsWith("data:") ? "data" : "other", width: image.naturalWidth, height: image.naturalHeight })),
          receiptHint: /费用收据/u.test(document.querySelector(".sbw-notice")?.textContent || ""),
        }));
        const card = page.locator(".sbw-shot-card").first();
        if (await card.count()) await card.screenshot({ path: path.join(output, "failure-synthetic-card.png"), timeout: 5000 });
      } catch { report.failureIndicators.captureFailed = true; }
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ passed: report.passed, stage: report.failure?.stage || "complete", imagePostCount: report.imagePostCount, upstreamRequests: 0 }));
  }
}

async function assertEventually(predicate, message) {
  const deadline = Date.now() + 20_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(predicate(), message);
}
