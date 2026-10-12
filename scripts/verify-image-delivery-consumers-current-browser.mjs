#!/usr/bin/env node
// Import main through with-local-customer-session.mjs after the coordinator builds.
// --self-test exercises the same route callback offline; it never launches a browser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const approvedApiGets = new Set(["/api/version", "/api/auth/me", "/api/member-permissions", "/api/cover-models", "/api/video/models"]);
const uiPaths = new Set(["/image-workbench", "/cover", "/storyboard-workbench"]);
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
function staticEntry(url) {
  if (uiPaths.has(url.pathname) || url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/")) return false;
  try {
    const root = path.resolve("public"), target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    return target.startsWith(`${root}${path.sep}`) && statSync(target).isFile();
  } catch { return false; }
}
function assertMetadata(value) {
  if (typeof value === "string") assert.equal(/^(?:blob:|data:[^,]+;base64,)/iu.test(value), false, "PERSISTED_MEDIA_URL");
  else if (Array.isArray(value)) {
    assert.equal(value.length > 0 && value.every(item => typeof item === "number"), false, "PERSISTED_BYTE_ARRAY");
    value.forEach(assertMetadata);
  } else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    assert.equal(/^(?:base64|bytes|buffer|dataUrl|transientDelivery)$/iu.test(key), false, "PERSISTED_BINARY_FIELD");
    assertMetadata(item);
  }
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
  const runtime = await response.json(), disk = JSON.parse(versionText.replace(/^\uFEFF/u, ""));
  const receipt = JSON.parse(receiptText.replace(/^\uFEFF/u, "")), current = computeLocalBuildFingerprint(process.cwd());
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, "local-production-preview-source-fingerprint");
  assert.ok(runtime.sourceVersion && runtime.buildId, "PRODUCTION_BUILD_REQUIRED");
  assert.equal(runtime.sourceVersion, disk.sourceVersion, "SOURCE_VERSION_MISMATCH");
  assert.equal(runtime.buildId, buildText.trim(), "RUNTIME_BUILD_MISMATCH");
  assert.equal(receipt.buildId, runtime.buildId, "RECEIPT_BUILD_MISMATCH");
  assert.equal(receipt.fingerprint, current.fingerprint, "CURRENT_SOURCE_FINGERPRINT_MISMATCH");
  assert.equal(receipt.fileCount, current.fileCount, "CURRENT_SOURCE_COUNT_MISMATCH");
  return { sourceVersion: runtime.sourceVersion, buildId: runtime.buildId, fingerprint: current.fingerprint, runningLatest: true };
}
function counters() {
  return { imagePostCount: 0, blockedNonGetCount: 0, blockedExternalCount: 0, blockedOtherGetCount: 0,
    forwardedNonGetCount: 0, approvedApiGetCounts: {}, fixtureErrors: 0, ownerContentGetCount: 0 };
}
function fixture(mode) {
  assert.ok(["provider_url", "inline_ephemeral"].includes(mode));
  return { mode, recordId: sha(`image-delivery-browser-synthetic-v1:${mode}`), armed: false, generated: false, modelId: "", png: null, receipt: null };
}
async function fulfillApprovedRead(route, report) {
  // Playwright routing may not intercept every redirect hop: never follow one here.
  const response = await route.fetch({ maxRedirects: 0 });
  if (!response.ok() || (response.status() >= 300 && response.status() < 400)) {
    report.fixtureErrors++;
    return route.abort("blockedbyclient");
  }
  return route.fulfill({ response });
}
// This exact callback is exercised by --self-test and installed in both browser contexts.
function routeCallback(origin, state, report) {
  return async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) { report.blockedExternalCount++; return route.abort("blockedbyclient"); }
    try {
      if (url.pathname === "/api/image/generate" && method === "POST") {
        report.imagePostCount++;
        assert.ok(state.armed && !state.generated && report.imagePostCount <= 2, "UNEXPECTED_OR_AUTOMATIC_IMAGE_POST");
        state.armed = false; state.generated = true;
        const body = request.postDataJSON();
        assert.equal(body.modelId, state.modelId, "REAL_MODEL_SELECTION_CHANGED");
        assert.ok(body.clientIdempotencyKey && body.clientTraceId, "REQUEST_IDENTITY_MISSING");
        state.requestIdentity = { key: body.clientIdempotencyKey, trace: body.clientTraceId };
        assert.equal(body.historySurface, "image-workbench");
        assert.equal(body.resumeDeliveryOnly, undefined, "UNEXPECTED_DELIVERY_REPLAY");
        assert.equal(body.referenceImageUrls, undefined, "UNEXPECTED_REFERENCE_UPLOAD");
        const dimensions = { "4:3": [256, 192], "3:4": [192, 256], "16:9": [320, 180], "9:16": [180, 320], "1:1": [256, 256], "3:2": [300, 200], "2:3": [200, 300], "21:9": [336, 144] }[body.aspectRatio];
        assert.ok(dimensions, "UNSUPPORTED_SYNTHETIC_RATIO");
        const [width, height] = dimensions;
        state.png = await sharp({ create: { width, height, channels: 4, background: "#8057c8" } }).png().toBuffer();
        state.receipt = { recordId: state.recordId, deliveryMode: state.mode, state: "completed", success: true,
          generationCompleted: true, mediaAvailable: false, canRecover: false, canResubmit: false,
          cashCharged: 0.01, billingReferenceId: `image:synthetic_${state.mode}`, billed: true,
          width, height, sha256: sha(state.png), byteLength: state.png.length, contentType: "image/png",
          ...(state.mode === "inline_ephemeral" ? { retention: "current_page_only" } : {}) };
        const imageUrl = state.mode === "inline_ephemeral" ? `data:image/png;base64,${state.png.toString("base64")}` : `/api/media-history/content?recordId=${state.recordId}`;
        return json(route, { ...state.receipt, mediaAvailable: true, taskId: body.clientTraceId, traceId: body.clientTraceId,
          modelIdUsed: body.modelId, resolution: body.resolution,
          images: [{ url: imageUrl, recordId: state.recordId, deliveryMode: state.mode, width, height }] });
      }
      if (method === "GET" && url.pathname === "/api/media-history/content") {
        assert.ok(state.generated && state.mode === "provider_url" && state.png, "UNOWNED_CONTENT_REQUEST");
        assert.equal(url.searchParams.get("recordId"), state.recordId, "CONTENT_OWNER_RECORD_MISMATCH");
        assert.deepEqual([...url.searchParams.keys()], ["recordId"], "UNEXPECTED_CONTENT_QUERY");
        report.ownerContentGetCount++;
        return route.fulfill({ status: 200, contentType: "image/png", headers: { "Cache-Control": "private, no-store" }, body: state.png });
      }
      if (method === "GET" && url.pathname === "/api/image/status") {
        assert.ok(state.receipt, "STATUS_BEFORE_COMPLETION");
        assert.equal(url.searchParams.get("clientIdempotencyKey"), state.requestIdentity.key, "STATUS_KEY_MISMATCH");
        assert.equal(url.searchParams.get("clientTraceId"), state.requestIdentity.trace, "STATUS_TRACE_MISMATCH");
        return json(route, { ...state.receipt, images: [] });
      }
      const empty = {
        "/api/cash/balance": { balance: 1000 },
        "/api/image-workbench/history": { records: [], nextPage: null },
        "/api/image-workbench/unresolved": { records: [], truncated: false },
        "/api/image-workbench/failure-history": { records: [], nextPage: null },
        "/api/video/history": { tasks: [] },
        "/api/storyboard/projects": { projects: [], nextOffset: null },
      };
      if (method === "GET" && Object.hasOwn(empty, url.pathname)) return json(route, empty[url.pathname]);
      if (method !== "GET") { report.blockedNonGetCount++; return route.abort("blockedbyclient"); }
      if (approvedApiGets.has(url.pathname)) {
        report.approvedApiGetCounts[url.pathname] = (report.approvedApiGetCounts[url.pathname] || 0) + 1;
        return await fulfillApprovedRead(route, report); // Actual ordinary authority; no redirect following.
      }
      if (staticEntry(url)) return await fulfillApprovedRead(route, report);
      report.blockedOtherGetCount++;
      return route.abort("blockedbyclient");
    } catch {
      report.fixtureErrors++;
      return json(route, { error: "Synthetic fixture contract failed" }, 500);
    }
  };
}
async function storageReceipt(page, state) {
  const entries = await page.evaluate(() => [localStorage, sessionStorage].flatMap((store, index) =>
    Object.entries(store).filter(([key]) => /image_workbench/iu.test(key)).map(([key, value]) => ({ store: index, key, value }))));
  let receipt;
  for (const entry of entries) {
    const parsed = JSON.parse(entry.value); assertMetadata(parsed);
    if (entry.key.endsWith(":receipts") && Array.isArray(parsed)) receipt ||= parsed.find(item => item.receipt?.recordId === state.recordId)?.receipt;
  }
  assert.ok(receipt, "COMPLETED_RECEIPT_NOT_PERSISTED");
  assert.equal(receipt.deliveryMode, state.mode); assert.equal(receipt.cashCharged, 0.01);
  assert.equal(receipt.generationCompleted, true); assert.equal(receipt.mediaAvailable, false);
  if (state.mode === "inline_ephemeral") { assert.equal(receipt.canRecover, false); assert.equal(receipt.retention, "current_page_only"); }
  // Only allowlisted receipt metadata goes into evidence, never raw browser storage/prompt/auth.
  return { receipt, storageKeys: entries.map(entry => entry.key), storageSha256: sha(JSON.stringify(entries)) };
}
function inspectSingleImageZip(bytes, expected) {
  assert.ok(bytes.length >= 30 && bytes.readUInt32LE(0) === 0x04034b50, "ZIP_LOCAL_HEADER_MISSING");
  assert.equal(bytes.readUInt16LE(8), 0, "ZIP_FIXTURE_MUST_BE_STORED");
  const length=bytes.readUInt32LE(18),nameLength=bytes.readUInt16LE(26),extraLength=bytes.readUInt16LE(28),offset=30+nameLength+extraLength;
  assert.equal(bytes.subarray(30,30+nameLength).toString("utf8"),"1.png");
  assert.equal(length,expected.byteLength);assert.equal(sha(bytes.subarray(offset,offset+length)),expected.sha256);
  assert.equal(bytes.readUInt32LE(offset+length),0x02014b50,"ZIP_UNEXPECTED_EXTRA_IMAGE");
}
async function downloadHash(page, button, expected, zip=false, onStage=()=>{}) {
  onStage("click"); const event = page.waitForEvent("download"); await button.click(); onStage("event"); const download = await event;
  try {
    onStage("stream");
    const stream = await download.createReadStream(); assert.ok(stream, "DOWNLOAD_STREAM_MISSING");
    const chunks=[];let byteLength = 0;
    for await (const chunk of stream) { byteLength += chunk.length; assert.ok(byteLength <= 2 * 1024 * 1024); chunks.push(chunk); }
    const bytes=Buffer.concat(chunks);onStage("verify");
    if(zip)inspectSingleImageZip(bytes,expected);
    else {assert.equal(sha(bytes), expected.sha256, "DOWNLOAD_BYTES_MISMATCH"); assert.equal(byteLength, expected.byteLength);}
  } finally { await download.delete(); }
}
export async function main() {
  assert.equal(process.version, "v24.19.0", "PINNED_NODE_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/$/u, "");
  assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_ORIGIN_REQUIRED");
  const token = process.env.R267_CUSTOMER_TOKEN, user = JSON.parse(process.env.LOCAL_NAV_READONLY_CUSTOMER || "null");
  assert.ok(token && user?.id && user.role === "student", "VERIFIED_ORDINARY_WRAPPER_REQUIRED");
  assert.ok(process.env.IMAGE_DELIVERY_CONSUMERS_ACCEPTANCE_OUTPUT, "OUTPUT_DIRECTORY_REQUIRED");
  const output = path.resolve(process.env.IMAGE_DELIVERY_CONSUMERS_ACCEPTANCE_OUTPUT); await mkdir(output, { recursive: true });
  const report = { schema: "image-delivery-consumers-current-browser.v1", checkedAt: new Date().toISOString(), passed: false,
    scope: "Real ordinary desktop UI with two synthetic image responses; not paid or storage E2E", viewport: { width: 1440, height: 900 },
    counterScope: "All browser non-target POST and external traffic blocked. Approved auth/permission/catalog GET server internals and controlled session-wrapper effects are not audited.",
    downloadScope: "Synthetic explicit downloads use browser temporary files, hashed then deleted; no image bytes in JSON evidence.",
    ...counters(), approvedApiGetPaths: [...approvedApiGets].sort(), scenarios: [], adjacentPages: [], runtimeBefore: null, runtimeAfter: null };
  let browser, stage = "current build gate";
  try {
    report.runtimeBefore = await runtimeIdentity(origin);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    for (const mode of ["provider_url", "inline_ephemeral"]) {
      const state = fixture(mode), scenario = { mode, recordId: state.recordId };
      const context = await browser.newContext({ viewport: report.viewport, acceptDownloads: true, serviceWorkers: "block" });
      let page;
      try {
        await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
        await context.addInitScript(({ sessionToken, identity }) => {
          localStorage.setItem("auth_token", sessionToken); localStorage.setItem("auth_user", JSON.stringify(identity)); sessionStorage.setItem("entered_app", "1");
          window.__imageDownloadDiagnostics={blobFetches:0,violations:[]};
          const originalFetch=window.fetch;
          window.fetch=function(input,options){if(typeof input==="string" && input.startsWith("blob:"))window.__imageDownloadDiagnostics.blobFetches++;return originalFetch.call(this,input,options);};
          document.addEventListener("securitypolicyviolation",event=>window.__imageDownloadDiagnostics.violations.push({directive:event.effectiveDirective,scheme:String(event.blockedURI||"").split(":")[0]}));
        }, { sessionToken: token, identity: user });
        await context.route("**/*", routeCallback(origin, state, report));
        page = await context.newPage(); page.setDefaultTimeout(30_000);
        stage = `${mode}: actual ordinary permission and model entry`;
        await page.goto(`${origin}/image-workbench`, { waitUntil: "domcontentloaded" });
        scenario.authority = await page.evaluate(async ({ expectedUserId }) => {
          const headers = { Authorization: `Bearer ${localStorage.getItem("auth_token") || ""}` };
          const [auth, permissions] = await Promise.all([fetch("/api/auth/me", { headers, cache: "no-store" }), fetch("/api/member-permissions", { headers, cache: "no-store" })]);
          const identity = await auth.json(), permissionBody = await permissions.json(), permission = permissionBody.permission;
          return { authStatus: auth.status, permissionStatus: permissions.status, ordinary: identity.user?.role === "student",
            ownerMatches: identity.user?.id === expectedUserId && permission?.userId === expectedUserId,
            authorityReady: permission?.authorityStatus === "ready" && permission?.integrityValid === true,
            allowedEntries: ["image_workbench", "cover", "storyboard_workbench"].filter(key => permission?.featureNavigationKeys?.includes(key)),
            legacySchemaFallback: permission?.checksum === "legacy-schema-absent" };
        }, { expectedUserId: user.id });
        assert.equal(scenario.authority.authStatus, 200, "ORDINARY_AUTH_FAILED");
        assert.equal(scenario.authority.permissionStatus, 200, "ORDINARY_PERMISSION_UNAVAILABLE");
        assert.ok(scenario.authority.ordinary && scenario.authority.ownerMatches && scenario.authority.authorityReady, "ORDINARY_AUTHORITY_INVALID");
        assert.equal(scenario.authority.allowedEntries.length, 3, "ORDINARY_ENTRY_PERMISSION_INSUFFICIENT");
        report.scenarios.push(scenario); // Keep the safe authority result even if entry later fails.
        const model = page.locator("#image-workbench-model"); await model.waitFor({ state: "visible" });
        await page.waitForFunction(() => [...document.querySelectorAll("#image-workbench-model option")].some(option => !option.disabled && option.value));
        state.modelId = await model.locator("option:not([disabled])").evaluateAll(options => options.find(option => option.value)?.value || "");
        assert.ok(state.modelId, "ORDINARY_REAL_MODEL_NOT_AVAILABLE"); await model.selectOption(state.modelId);
        await page.getByRole("textbox", { name: "第 1 张图片提示词", exact: true }).fill("Synthetic offline acceptance rectangle. No real generation.");
        const generate = page.getByRole("button", { name: /^生成图片（1）$/u });
        await generate.waitFor({ state: "visible" }); assert.ok(await generate.isEnabled(), "ORDINARY_ENTRY_NOT_GENERATABLE");
        stage = `${mode}: one explicit generation, preview and download`;
        const beforePosts = report.imagePostCount; state.armed = true; await generate.click();
        let card = page.locator("article").filter({ has: page.getByRole("textbox", { name: "第 1 张图片提示词", exact: true }) });
        const image = card.locator("img"); await image.waitFor({ state: "visible" });
        scenario.decoded = await image.evaluate(async element => { await element.decode(); return { blob: element.src.startsWith("blob:"), localOwned: new URL(element.src).pathname === "/api/media-history/content", width: element.naturalWidth, height: element.naturalHeight }; });
        assert.equal(scenario.decoded.blob, mode === "inline_ephemeral");
        if (mode === "provider_url") assert.equal(scenario.decoded.localOwned, true);
        assert.equal(scenario.decoded.width, state.receipt.width); assert.equal(scenario.decoded.height, state.receipt.height);
        stage = `${mode}: preview open`;
        await card.getByRole("button", { name: "放大预览 1.png", exact: true }).click();
        const preview = page.getByRole("dialog", { name: "图片放大预览", exact: true }).locator("img");
        await preview.waitFor({ state: "visible" }); assert.ok(await preview.evaluate(async element => { await element.decode(); return element.naturalWidth > 0; }));
        stage = `${mode}: preview close`;await page.getByRole("button", { name: "关闭预览", exact: true }).click();
        await downloadHash(page, card.getByRole("button", { name: "下载图片", exact: true }), state.receipt,false,part=>{stage=`${mode}: explicit single download ${part}`;});
        await downloadHash(page,page.getByRole("button",{name:"一键下载",exact:true}),state.receipt,true,part=>{stage=`${mode}: explicit ZIP download ${part}`;});
        scenario.singleDownloadVerified=true;scenario.zipDownloadVerified=true;
        scenario.downloadDiagnostics=await page.evaluate(()=>window.__imageDownloadDiagnostics);
        assert.equal(scenario.downloadDiagnostics.blobFetches,0,"INLINE_DOWNLOAD_MUST_NOT_FETCH_BLOB_URL");
        assert.equal(scenario.downloadDiagnostics.violations.filter(item=>item.scheme==="blob").length,0,"BLOB_DOWNLOAD_CSP_VIOLATION");
        stage = `${mode}: fee and storage receipt before reload`;
        assert.match(await card.innerText(), /实扣 ¥0\.01/u, "FIRST_FEE_NOT_VISIBLE");
        scenario.beforeReload = await storageReceipt(page, state);
        await page.screenshot({ path: path.join(output, `${mode}-current.png`), fullPage: false });
        stage = `${mode}: receipt reload without generation POST`;
        await page.reload({ waitUntil: "domcontentloaded" });
        card = page.locator("article").filter({ hasText: state.recordId }); await card.waitFor({ state: "visible" });
        assert.match(await card.innerText(), /实扣 ¥0\.01/u, "RELOADED_FEE_NOT_VISIBLE");
        if (mode === "inline_ephemeral") {
          assert.equal(await card.locator("img").count(), 0, "INLINE_MEDIA_RESTORED");
          assert.equal(await card.getByRole("button", { name: "下载图片", exact: true }).count(), 0);
          assert.match(await card.innerText(), /无法恢复/u);
        } else {
          await card.locator("img").waitFor({ state: "visible" });
          assert.ok(await card.locator("img").evaluate(async element => { await element.decode(); return new URL(element.src).pathname === "/api/media-history/content" && element.naturalWidth > 0; }));
        }
        await page.waitForTimeout(3500);
        assert.equal(report.imagePostCount, beforePosts + 1, "AUTOMATIC_OR_SECOND_GENERATION");
        scenario.afterReload = await storageReceipt(page, state); scenario.postCount = 1; scenario.passed = true;
        await page.screenshot({ path: path.join(output, `${mode}-reloaded.png`), fullPage: false });
        if (mode === "inline_ephemeral") for (const route of ["/cover", "/storyboard-workbench"]) {
          stage = `adjacent readonly layout ${route}`;
          await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
          await page.locator(route === "/cover" ? '.cover-rebuild-workspace [aria-label="封面生成参数"]' : '.sbw-root .sbw-shell').waitFor({ state: "visible" });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "DESKTOP_HORIZONTAL_OVERFLOW");
          await page.screenshot({ path: path.join(output, `adjacent-${route.slice(1)}.png`), fullPage: false });
          report.adjacentPages.push({ route, passed: true, scope: "Read-only desktop entry/layout; no generation" });
        }
      } catch(error) {
        if(page && !page.isClosed()) {
          scenario.failureMetrics=await page.evaluate(()=>({dialogs:document.querySelectorAll('[role="dialog"]').length,downloadButtons:document.querySelectorAll('button[aria-label="下载图片"]').length,
            images:[...document.querySelectorAll('article img')].map(image=>({scheme:image.src.split(":")[0],width:image.naturalWidth,height:image.naturalHeight})),downloadDiagnostics:window.__imageDownloadDiagnostics})).catch(()=>({unavailable:true}));
          await page.screenshot({path:path.join(output,`${mode}-failed.png`),fullPage:false}).catch(()=>{});
        }
        throw error;
      } finally { await context.close(); }
    }
    assert.equal(report.imagePostCount, 2); assert.equal(report.fixtureErrors, 0, "FIXTURE_CONTRACT_ERRORS");
    assert.ok(report.approvedApiGetCounts["/api/auth/me"] && report.approvedApiGetCounts["/api/member-permissions"] && report.approvedApiGetCounts["/api/cover-models"], "ACTUAL_IDENTITY_PERMISSION_CATALOG_NOT_READ");
    stage = "unchanged current build gate";
    report.runtimeAfter = await runtimeIdentity(origin); assert.deepEqual(report.runtimeAfter, report.runtimeBefore);
    report.passed = true;
  } catch (error) {
    report.failure = { stage, name: error?.name === "AssertionError" ? "AssertionError" : "ExecutionError" };
    process.exitCode = 1; // Never persist Playwright logs, raw response, DOM dumps, URL parameters or auth.
  } finally {
    if (browser) await browser.close();
    await writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ passed: report.passed, stage: report.failure?.stage || "complete", imagePostCount: report.imagePostCount }));
  }
}
async function selfTest() {
  const origin = "http://127.0.0.1:5000", report = counters(); let checks = 0;
  const invoke = async (state, pathname, method = "GET", body, readStatus = 200) => {
    let result;
    await routeCallback(origin, state, report)({ request: () => ({ url: () => pathname.startsWith("http") ? pathname : origin + pathname, method: () => method, postDataJSON: () => body }),
      fetch: async options => { assert.deepEqual(options, { maxRedirects: 0 }); return { ok: () => readStatus >= 200 && readStatus < 300, status: () => readStatus }; },
      fulfill: async value => { result = { kind: "fulfilled", ...value }; }, abort: async () => { result = { kind: "blocked" }; }, continue: async () => { throw new Error("UNCONTROLLED_FORWARD_FORBIDDEN"); } });
    return result;
  };
  const state = fixture("provider_url"); state.modelId = "actual-model-fixture";
  for (const [url, method] of [["https://example.invalid/image", "GET"], ["/api/media/persist", "POST"], ["/api/unknown", "GET"], ["/api/auth/me", "POST"]]) { assert.equal((await invoke(state, url, method)).kind, "blocked"); checks++; }
  for (const url of [...approvedApiGets, "/image-workbench", "/_next/static/fixture.js"]) { assert.equal((await invoke(state, url)).kind, "fulfilled"); checks++; }
  for (const url of ["/api/auth/me", "/image-workbench", "/_next/static/fixture.js"]) {
    for (const status of [301, 302, 307, 308, 403, 500]) {
      const denied = await invoke(state, url, "GET", undefined, status);
      assert.equal(denied.kind, "blocked", "REDIRECT_OR_FAILED_APPROVED_READ_NOT_BLOCKED"); checks++;
    }
  }
  assert.equal((await invoke(state, "/api/image/generate", "POST", {})).status, 500); checks++;
  // Start a clean aggregate: denied attempts above are negative fixtures, never real POSTs.
  Object.assign(report, counters());
  for (const mode of ["provider_url", "inline_ephemeral"]) {
    const current = fixture(mode); current.modelId = "actual-model-fixture"; current.armed = true;
    const result = await invoke(current, "/api/image/generate", "POST", { modelId: current.modelId, clientIdempotencyKey: "fixture_key", clientTraceId: "fixture_trace", historySurface: "image-workbench", aspectRatio: "4:3" });
    assert.equal(result.status, 200); const payload = JSON.parse(result.body); assert.equal(payload.images[0].deliveryMode, mode); checks++;
    assert.equal((await sharp(current.png).metadata()).width, 256); assert.equal(sha(current.png), payload.sha256); checks++;
    const status = await invoke(current, "/api/image/status?clientIdempotencyKey=fixture_key&clientTraceId=fixture_trace"); const receipt = JSON.parse(status.body); assertMetadata(receipt); assert.deepEqual(receipt.images, []); assert.equal(receipt.cashCharged, 0.01); checks++;
    const content = await invoke(current, `/api/media-history/content?recordId=${current.recordId}`);
    assert.equal(content.status, mode === "provider_url" ? 200 : 500); checks++;
    if (mode === "provider_url") { assert.equal(sha(content.body), payload.sha256); assert.equal((await invoke(current, `/api/media-history/content?recordId=${"f".repeat(64)}`)).status, 500); checks++; }
  }
  const last = fixture("inline_ephemeral"); last.generated = true;
  assert.equal((await invoke(last, "/api/image/generate", "POST", {})).status, 500); checks++;
  assert.equal(report.forwardedNonGetCount, 0); checks++;
  assert.throws(() => assertMetadata({ url: "blob:fixture" })); assert.throws(() => assertMetadata({ bytes: [1, 2] })); checks += 2;
  assert.throws(()=>inspectSingleImageZip(Buffer.from("not-a-zip"),{byteLength:1,sha256:"f".repeat(64)}));checks++;
  console.log(JSON.stringify({ passed: true, scope: "Offline actual route callbacks only; browser not run", checks }));
}
if (process.argv.includes("--self-test")) await selfTest();
