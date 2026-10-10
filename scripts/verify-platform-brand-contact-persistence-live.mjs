#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import jsQR from "jsqr";
import pg from "pg";
import sharp from "sharp";
import { chromium } from "playwright";
import { decodeJwt } from "jose";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const nodeRequire = createRequire(import.meta.url);
const jsQrVersion = String(nodeRequire("jsqr/package.json").version);
const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
const requiredStorageProvider = String(process.env.LOCAL_BRAND_ACCEPTANCE_STORAGE_PROVIDER || "").trim();
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const configuredExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${crypto.randomBytes(4).toString("hex")}`;
const evidenceDir = path.resolve(".codex-evidence", "platform-brand-contact-persistence-live", runId);
const viewport = { width: 1440, height: 900 };
const userAgent = `codex-platform-brand-contact-live/${runId}`;
const suffix = crypto.randomBytes(6).toString("hex");
const phoneDigits = [...Buffer.from(suffix)].map((value) => String(value % 10)).join("").slice(0, 8);
const contact = {
  name: `本地联系验收-${suffix}`,
  wechat: `wx_live_${suffix}`,
  phone: `010-${phoneDigits.slice(0, 4)}-${phoneDigits.slice(4, 8)}`,
  email: `contact-${suffix}@example.test`,
};
const qrPayloads = {
  contact_wechat_qr_primary: `wechat:${contact.wechat}:primary`,
  contact_wechat_qr_secondary: `wechat:${contact.wechat}:secondary`,
};

const report = {
  schemaVersion: 2,
  acceptanceIds: ["CONTACT-01", "CONTACT-02"],
  passed: false,
  checkedAt: null,
  origin,
  viewport,
  runtime: null,
  localDatabase: null,
  storagePreflight: null,
  baseline: null,
  qrDecoding: {
    requiredDecoder: {
      name: "jsQR",
      version: jsQrVersion,
      runtime: "node",
      input: "sharp-raw-rgba",
      externalService: false,
    },
    optionalBrowserDecoder: {
      name: "BarcodeDetector",
      required: false,
      attempted: false,
      available: null,
    },
  },
  qrBeforeUpload: [],
  ui: {
    admin: null,
    refreshedDraft: null,
    publicHome: null,
    appSidebar: null,
  },
  authoritativeReadbacks: [],
  publicAssets: [],
  browser: {
    requests: [],
    responseFailures: [],
    expectedLocalStorageFailures: [],
    unexpectedResponseFailures: [],
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
    blockedExternalRequests: [],
    mutations: [],
    telemetryMutations: [],
    unexpectedMutations: [],
  },
  screenshots: [],
  cleanup: {
    attempted: false,
    rollbackApiApplied: false,
    baselinePublishedSemanticsRestored: false,
    baselineDraftSemanticsRestored: false,
    concurrentDriftDetected: false,
    concurrentDriftEvidence: null,
    stepUpRemoved: false,
    browserClosed: false,
  },
  retainedImmutableAcceptanceHistory: {
    retained: true,
    reason: "Published revisions and their assets are immutable acceptance history; this verifier never deletes them.",
    assetIds: [],
    acceptancePublishedRevisionId: null,
    rollbackRevisionId: null,
    restoredDraftRevisionId: null,
  },
  networkAudit: {
    scope: "Direct HTTP requests issued by this verifier and Playwright contexts only; server-internal downstream traffic is not intercepted.",
    nodeRequests: [],
    browserRequestCount: 0,
    browserExternalRequestCount: 0,
    serverSideProviderCalls: {
      observed: false,
      count: null,
      reason: "Server-internal downstream traffic is outside this verifier's interception boundary.",
    },
    paidProviderCalls: {
      observed: false,
      count: null,
      reason: "No server-side provider or billing transport interceptor is installed by this verifier.",
    },
    productionWrites: {
      observed: false,
      count: null,
      reason: "The verifier enforces a local runtime and database, but does not intercept every possible server-side production transport.",
    },
    externalStorageWrites: {
      observed: false,
      count: null,
      reason: "Local storage is required and its durable rows are checked, but server-side external storage transports are not intercepted.",
    },
  },
  failure: null,
};

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stateSignature(state) {
  return {
    generation: Number(state?.generation),
    draftRevisionId: state?.draft?.id || null,
    publishedRevisionId: state?.published?.id || null,
  };
}

function compactRevision(revision) {
  if (!revision) return null;
  return {
    id: revision.id,
    revisionVersion: revision.revisionVersion,
    snapshotSha256: revision.snapshotSha256,
    brand: canonicalize(revision.brand),
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

async function observedFetch(scope, url, init = {}) {
  const parsed = new URL(url);
  report.networkAudit.nodeRequests.push({
    scope,
    method: String(init.method || "GET").toUpperCase(),
    origin: parsed.origin,
    pathname: parsed.pathname,
  });
  return fetch(url, init);
}

async function api(pathname, stepUpToken = "", init = {}) {
  const response = await observedFetch("api", `${origin}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(stepUpToken ? { "x-admin-step-up": stepUpToken } : {}),
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  return { response, body: await readJson(response) };
}

function requireOk(result, label, expectedStatus = 200) {
  assert.equal(
    result.response.status,
    expectedStatus,
    `${label}:HTTP_${result.response.status}:${result.body?.code || "UNKNOWN"}:${result.body?.error || "unknown"}`,
  );
  return result.body;
}

async function readAdminBranding() {
  const result = await api("/api/admin/branding");
  const body = requireOk(result, "ADMIN_BRANDING_READ");
  assert.equal(body?.ok, true, "ADMIN_BRANDING_OK_REQUIRED");
  assert.equal(body?.state?.migrationRequired, false, "BRAND_MIGRATION_REQUIRED");
  return body.state;
}

async function assertNoConcurrentDrift(expected, stage) {
  const current = await readAdminBranding();
  const actual = stateSignature(current);
  if (!sameValue(actual, expected)) {
    report.cleanup.concurrentDriftDetected = true;
    report.cleanup.concurrentDriftEvidence = { stage, expected, actual };
    throw new Error(`CONCURRENT_PLATFORM_BRAND_DRIFT:${stage}`);
  }
  return current;
}

async function createStepUp(db, actorId) {
  const self = await api("/api/admin/access-control/self");
  const body = requireOk(self, "ADMIN_ACCESS_SELF");
  assert.equal(body?.access?.integrityValid, true, "ADMIN_ACCESS_INTEGRITY_REQUIRED");
  assert.ok(body.access.permissionKeys.includes("brand.settings.manage"), "BRAND_SETTINGS_PERMISSION_REQUIRED");
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);
  await db.query("BEGIN");
  try {
    await db.query("SELECT set_config('app.admin_governance_write','on',true)");
    await db.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1',$5,now()+interval '15 minutes')`,
      [actorId, tokenHash, JSON.stringify(body.access.permissionKeys), body.access.revision, userAgent],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  return { rawToken, tokenHash };
}

async function removeStepUp(db, tokenHash) {
  await db.query("BEGIN");
  try {
    await db.query("SELECT set_config('app.admin_governance_write','on',true)");
    await db.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [tokenHash]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  const remaining = await db.query(
    "SELECT count(*)::integer AS count FROM public.admin_step_up_sessions WHERE token_hash=$1",
    [tokenHash],
  );
  return Number(remaining.rows[0]?.count || 0) === 0;
}

async function createQrPng(payload) {
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, {
    value: payload,
    size: 512,
    level: "H",
    marginSize: 4,
    bgColor: "#FFFFFF",
    fgColor: "#101820",
    title: payload,
  }));
  return sharp(Buffer.from(svg, "utf8"), { density: 192 })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

async function decodeQrPng(bytes, page = null) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4, "NODE_QR_DECODER_RGBA_REQUIRED");
  assert.ok(info.width > 0 && info.height > 0, "NODE_QR_DECODER_DIMENSIONS_REQUIRED");
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const detected = jsQR(pixels, info.width, info.height, { inversionAttempts: "attemptBoth" });
  assert.ok(detected, "NODE_JSQR_DECODE_FAILED");
  const node = {
    decoder: `jsQR@${jsQrVersion}`,
    runtime: "node",
    payload: String(detected.data || ""),
    width: info.width,
    height: info.height,
  };

  let browser = { attempted: false, available: null, payloads: [], error: null };
  if (page) {
    browser = await page.evaluate(async ({ base64 }) => {
      if (!("BarcodeDetector" in globalThis)) {
        return { attempted: true, available: false, payloads: [], error: "BROWSER_QR_DECODER_UNAVAILABLE" };
      }
      try {
        const supported = await globalThis.BarcodeDetector.getSupportedFormats();
        if (!supported.includes("qr_code")) {
          return { attempted: true, available: false, payloads: [], error: "BROWSER_QR_CODE_FORMAT_UNAVAILABLE" };
        }
        const response = await fetch(`data:image/png;base64,${base64}`);
        const bitmap = await createImageBitmap(await response.blob());
        try {
          const entries = await new globalThis.BarcodeDetector({ formats: ["qr_code"] }).detect(bitmap);
          return {
            attempted: true,
            available: true,
            payloads: entries.map((entry) => String(entry.rawValue || "")),
            error: null,
          };
        } finally {
          bitmap.close();
        }
      } catch (error) {
        return {
          attempted: true,
          available: true,
          payloads: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }, { base64: bytes.toString("base64") });
    report.qrDecoding.optionalBrowserDecoder.attempted ||= browser.attempted;
    if (browser.available !== null) report.qrDecoding.optionalBrowserDecoder.available = browser.available;
  }
  return { node, browser };
}

async function launchBrowser() {
  const executableAvailable = await fs.access(configuredExecutable).then(() => true).catch(() => false);
  return chromium.launch({
    headless: true,
    ...(executableAvailable ? { executablePath: configuredExecutable } : {}),
  });
}

async function installSession(context, stepUpToken, entered = true) {
  await context.addCookies([
    { name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    { name: "zimeiti_admin_step_up", value: stepUpToken, url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  await context.addInitScript(({ sessionToken, user, shouldEnter }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    if (shouldEnter) sessionStorage.setItem("entered_app", "1");
    else sessionStorage.removeItem("entered_app");
  }, { sessionToken: token, user: identity.user, shouldEnter: entered });
}

function observeContext(context, scope) {
  context.on("request", (request) => {
    const url = new URL(request.url());
    report.browser.requests.push({
      scope,
      method: request.method(),
      origin: url.origin,
      pathname: url.pathname,
    });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      const entry = { scope, method: request.method(), pathname: url.pathname };
      report.browser.mutations.push(entry);
      const isBrandingMutation = [
        "/api/admin/branding",
        "/api/admin/branding/assets",
      ].includes(url.pathname);
      const isExpectedTelemetryMutation = [
        "/api/operation-events",
        "/api/product-usage/events",
      ].includes(url.pathname);
      if (isExpectedTelemetryMutation) report.browser.telemetryMutations.push({ ...entry, serverReached: true });
      else if (!isBrandingMutation) report.browser.unexpectedMutations.push(entry);
    }
  });
  context.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) {
      report.browser.responseFailures.push({
        scope,
        method: response.request().method(),
        status: response.status(),
        pathname: url.pathname,
      });
    }
    if (url.origin === origin && response.status() >= 500) {
      report.browser.serverErrors.push({
        scope,
        method: response.request().method(),
        status: response.status(),
        pathname: url.pathname,
      });
    }
  });
}

async function blockExternalRequests(context, scope) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      await route.continue();
      return;
    }
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      report.browser.blockedExternalRequests.push({ scope, method: request.method(), origin: url.origin, pathname: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

function observePage(page, scope) {
  page.on("pageerror", (error) => report.browser.pageErrors.push({ scope, message: String(error?.message || error).slice(0, 700) }));
  page.on("console", (message) => {
    if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT|favicon|React DevTools/iu.test(message.text())) {
      report.browser.consoleErrors.push({ scope, message: message.text().slice(0, 700) });
    }
  });
}

async function waitForBrandNotice(page, pattern) {
  await page.getByRole("status").filter({ hasText: pattern }).waitFor({ state: "visible", timeout: 30_000 });
}

async function uploadQrThroughUi(page, purpose, bytes) {
  const label = purpose === "contact_wechat_qr_primary" ? "微信二维码 1" : "微信二维码 2";
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/admin/branding/assets"
  ), { timeout: 30_000 });
  await page.getByLabel(`上传${label}`, { exact: true }).setInputFiles({
    name: `${purpose}-${suffix}.png`,
    mimeType: "image/png",
    buffer: bytes,
  });
  const response = await responsePromise;
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status(), 201, `${purpose}:UI_UPLOAD_HTTP_${response.status()}:${body?.error || "unknown"}`);
  assert.equal(body?.asset?.purpose, purpose, `${purpose}:UI_UPLOAD_PURPOSE`);
  assert.ok(body?.asset?.id, `${purpose}:UI_UPLOAD_ASSET_ID`);
  await waitForBrandNotice(page, `${label}已上传到平台存储`);
  return body.asset;
}

async function fillContactFields(page) {
  await page.getByLabel("联系人或客服名称", { exact: true }).fill(contact.name);
  await page.getByLabel("微信号", { exact: true }).fill(contact.wechat);
  await page.getByLabel("联系电话", { exact: true }).fill(contact.phone);
  await page.getByLabel("联系邮箱", { exact: true }).fill(contact.email);
}

async function readContactFields(page) {
  return {
    name: await page.getByLabel("联系人或客服名称", { exact: true }).inputValue(),
    wechat: await page.getByLabel("微信号", { exact: true }).inputValue(),
    phone: await page.getByLabel("联系电话", { exact: true }).inputValue(),
    email: await page.getByLabel("联系邮箱", { exact: true }).inputValue(),
    primaryAssetId: await page.getByLabel("选择微信二维码 1", { exact: true }).inputValue(),
    secondaryAssetId: await page.getByLabel("选择微信二维码 2", { exact: true }).inputValue(),
  };
}

async function postBrandAction(stepUpToken, action, expectedGeneration, revisionId, brand) {
  const result = await api("/api/admin/branding", stepUpToken, {
    method: "POST",
    headers: { "Idempotency-Key": `contact-live-${action}-${runId}-${crypto.randomUUID()}` },
    body: JSON.stringify({
      action,
      expectedGeneration,
      ...(action === "save-draft" ? { brand } : { revisionId }),
    }),
  });
  return requireOk(result, `BRAND_${action.toUpperCase()}`);
}

async function verifyRunningLatest() {
  const [receipt, diskBuildId, currentFingerprint, versionResponse] = await Promise.all([
    fs.readFile(path.resolve(".next/local-source-fingerprint.v1.json"), "utf8").then(JSON.parse),
    fs.readFile(path.resolve(".next/BUILD_ID"), "utf8").then((value) => value.trim()),
    Promise.resolve(computeLocalBuildFingerprint(process.cwd())),
    fetch(`${origin}/api/version`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const servedVersion = await versionResponse.json();
  const servedBuildId = String(servedVersion.buildId || servedVersion.version || "");
  const runningLatest = receipt.fingerprint === currentFingerprint.fingerprint
    && receipt.fileCount === currentFingerprint.fileCount
    && receipt.buildId === diskBuildId
    && servedBuildId === diskBuildId;
  assert.equal(runningLatest, true, "RUNNING_LATEST_REQUIRED");
  return {
    sourceVersion: servedVersion.sourceVersion,
    diskBuildId,
    servedBuildId,
    sourceFingerprint: currentFingerprint.fingerprint,
    sourceFingerprintCurrent: true,
    runningLatest,
  };
}

async function verifyStoragePreflight() {
  assert.equal(requiredStorageProvider, "local", "SET_LOCAL_BRAND_ACCEPTANCE_STORAGE_PROVIDER_TO_LOCAL");
  const health = await api("/api/health");
  const body = requireOk(health, "HEALTH_READ");
  const storage = body?.checks?.find((entry) => entry?.name === "对象存储");
  assert.ok(storage, "OBJECT_STORAGE_HEALTH_REQUIRED");
  const details = storage.details || {};
  assert.equal(details.defaultProvider, "local", `EXTERNAL_STORAGE_WRITE_REFUSED:${details.defaultProvider || "unknown"}`);
  assert.ok(details.initializedProviders?.includes("local"), "LOCAL_STORAGE_PROVIDER_NOT_INITIALIZED");
  return {
    explicitRequiredProvider: requiredStorageProvider,
    actualDefaultProvider: details.defaultProvider,
    fallbackProvider: details.fallbackProvider,
    initializedProviders: details.initializedProviders,
    runtimeMode: details.runtimeMode,
    configurationState: details.configurationState,
    externalProbeExecuted: details.externalProbeExecuted,
    safeForThisLocalAcceptance: true,
  };
}

async function verifyPublicAssets(publicBranding, expectedAssets, decoderPage) {
  const results = [];
  for (const [purpose, expectedPayload] of Object.entries(qrPayloads)) {
    const asset = publicBranding.assets?.[purpose];
    assert.ok(asset?.id, `${purpose}:PUBLIC_ASSET_REQUIRED`);
    assert.equal(asset.id, expectedAssets[purpose].id, `${purpose}:PUBLIC_ASSET_ID`);
    assert.match(asset.url, /^\/api\/branding\/assets\/[0-9a-f-]+\?revision=/u, `${purpose}:PUBLIC_ASSET_URL`);
    const response = await observedFetch("public-asset", `${origin}${asset.url}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) {
      const responseBody = await readJson(response);
      const currentResult = await api("/api/branding");
      const diagnostic = {
        purpose,
        assetId: asset.id,
        url: asset.url,
        requestedRevision: new URL(asset.url, origin).searchParams.get("revision"),
        expectedPublishedRevision: publicBranding.revisionId || null,
        httpStatus: response.status,
        responseBody,
        currentRevisionHttpStatus: currentResult.response.status,
        currentRevision: currentResult.body?.branding?.revisionId || null,
      };
      results.push(diagnostic);
      report.publicAssets = results;
      assert.equal(
        response.status,
        200,
        `${purpose}:PUBLIC_ASSET_HTTP_${response.status}:${JSON.stringify(diagnostic)}`,
      );
    }
    assert.equal(response.status, 200, `${purpose}:PUBLIC_ASSET_HTTP_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256(bytes);
    assert.equal(bytes.byteLength, Number(asset.bytes), `${purpose}:PUBLIC_ASSET_BYTES`);
    assert.equal(digest, asset.sha256, `${purpose}:PUBLIC_ASSET_SHA`);
    const decoded = await decodeQrPng(bytes, decoderPage);
    assert.equal(decoded.node.payload, expectedPayload, `${purpose}:PUBLIC_QR_DECODE_MISMATCH`);
    results.push({
      purpose,
      assetId: asset.id,
      url: asset.url,
      bytes: bytes.byteLength,
      sha256: digest,
      width: decoded.node.width,
      height: decoded.node.height,
      expectedPayload,
      decodedPayload: decoded.node.payload,
      decoder: decoded.node.decoder,
      optionalBrowserDecoder: decoded.browser,
      httpStatus: response.status,
      cacheControl: response.headers.get("cache-control"),
      immutable: /immutable/iu.test(response.headers.get("cache-control") || ""),
    });
  }
  return results;
}

async function verifyPublicHome(browser, expectedAssets) {
  const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
  observeContext(context, "public-home");
  await blockExternalRequests(context, "public-home");
  const page = await context.newPage();
  observePage(page, "public-home");
  try {
    const response = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200, "PUBLIC_HOME_HTTP_200");
    const section = page.locator("#swh-contact");
    await section.waitFor({ state: "visible", timeout: 30_000 });
    await section.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll("#swh-contact img")]
      .every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0), null, { timeout: 20_000 });
    const metrics = await section.evaluate((node, expected) => {
      const text = String(node.textContent || "");
      const images = [...node.querySelectorAll("img")].map((image) => ({
        src: image.getAttribute("src") || "",
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      }));
      return {
        contactVisible: Object.values(expected.contact).every((value) => text.includes(value)),
        primaryAssetVisible: images.some((image) => image.src.includes(expected.primaryAssetId)),
        secondaryAssetVisible: images.some((image) => image.src.includes(expected.secondaryAssetId)),
        qrImages: images,
        overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      };
    }, {
      contact,
      primaryAssetId: expectedAssets.contact_wechat_qr_primary.id,
      secondaryAssetId: expectedAssets.contact_wechat_qr_secondary.id,
    });
    assert.equal(metrics.contactVisible, true, "PUBLIC_CONTACT_FIELDS_VISIBLE");
    assert.equal(metrics.primaryAssetVisible, true, "PUBLIC_PRIMARY_QR_VISIBLE");
    assert.equal(metrics.secondaryAssetVisible, true, "PUBLIC_SECONDARY_QR_VISIBLE");
    assert.equal(metrics.overflowX, 0, "PUBLIC_HOME_HORIZONTAL_OVERFLOW");
    const screenshot = path.join(evidenceDir, "contact-public-home-1440x900.png");
    await page.screenshot({ path: screenshot, fullPage: false });
    report.screenshots.push(path.relative(process.cwd(), screenshot));
    return metrics;
  } finally {
    await context.close();
  }
}

async function verifyAppSidebar(browser, stepUpToken) {
  const context = await browser.newContext({
    viewport,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block",
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUpToken },
  });
  await installSession(context, stepUpToken, true);
  observeContext(context, "app-sidebar");
  await blockExternalRequests(context, "app-sidebar");
  const page = await context.newPage();
  observePage(page, "app-sidebar");
  try {
    const response = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200, "APP_HOME_HTTP_200");
    const brand = page.getByTestId("sidebar-platform-brand");
    await brand.waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("platform-branding:refresh")));
    await page.waitForFunction((expected) => document.querySelector('[data-testid="sidebar-platform-brand"]')?.textContent?.includes(`微信：${expected}`), contact.wechat, { timeout: 20_000 });
    const metrics = await brand.evaluate((node, expected) => ({
      visible: Boolean(node.getClientRects().length),
      wechatVisible: String(node.textContent || "").includes(`微信：${expected}`),
      overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }), contact.wechat);
    assert.equal(metrics.visible, true, "APP_SIDEBAR_BRAND_VISIBLE");
    assert.equal(metrics.wechatVisible, true, "APP_SIDEBAR_WECHAT_VISIBLE");
    assert.equal(metrics.overflowX, 0, "APP_SIDEBAR_HORIZONTAL_OVERFLOW");
    const screenshot = path.join(evidenceDir, "contact-app-sidebar-1440x900.png");
    await page.screenshot({ path: screenshot, fullPage: false });
    report.screenshots.push(path.relative(process.cwd(), screenshot));
    return metrics;
  } finally {
    await context.close();
  }
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_ORIGIN_REQUIRED");
  assert.ok(token.length > 32, "WITH_LOCAL_ADMIN_SESSION_TOKEN_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");

  const actorId = String(decodeJwt(token).userId || "");
  assert.match(actorId, /^[0-9a-f-]{36}$/iu, "LOCAL_ADMIN_ACTOR_REQUIRED");
  const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  report.runtime = await verifyRunningLatest();
  report.localDatabase = { host: "127.0.0.1", port: 54322, database: "zimeiti_local", localOnly: true };
  await fs.mkdir(evidenceDir, { recursive: true });

  const db = new pg.Client({
    ...runtime.ownerConnection,
    application_name: `codex-platform-brand-contact-live-${suffix}`,
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
  });
  let browser;
  let stepUp = null;
  let baselineState = null;
  let ownedSignature = null;
  let semanticMutationStarted = false;
  let thrown = null;

  try {
    await db.connect();
    const databaseIdentity = (await db.query(
      "SELECT current_database() AS db, host(inet_server_addr()) AS host, inet_server_port() AS port",
    )).rows[0];
    assert.deepEqual(databaseIdentity, { db: "zimeiti_local", host: "127.0.0.1", port: 54322 });

    report.storagePreflight = await verifyStoragePreflight();
    baselineState = await readAdminBranding();
    assert.ok(baselineState.published?.id, "PUBLISHED_PLATFORM_BRAND_BASELINE_REQUIRED");
    assert.equal(
      baselineState.publicBranding?.revisionId,
      baselineState.published.id,
      "PUBLISHED_BASELINE_PUBLIC_REVISION_MISMATCH",
    );
    const baselineCounts = (await db.query(`
      SELECT
        (SELECT count(*)::integer FROM public.platform_brand_revisions) AS revisions,
        (SELECT count(*)::integer FROM public.platform_brand_assets WHERE deleted_at IS NULL) AS assets,
        (SELECT count(*)::integer FROM public.platform_brand_revision_assets) AS mappings,
        (SELECT count(*)::integer FROM public.platform_brand_events) AS events
    `)).rows[0];
    report.baseline = {
      signature: stateSignature(baselineState),
      published: compactRevision(baselineState.published),
      draft: compactRevision(baselineState.draft),
      counts: baselineCounts,
    };
    ownedSignature = report.baseline.signature;

    const qrBuffers = {};
    for (const [purpose, payload] of Object.entries(qrPayloads)) qrBuffers[purpose] = await createQrPng(payload);

    browser = await launchBrowser();
    const decoderContext = await browser.newContext({ viewport, serviceWorkers: "block" });
    observeContext(decoderContext, "qr-decoder");
    const decoderPage = await decoderContext.newPage();
    await decoderPage.goto(`${origin}/api/version`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    for (const [purpose, bytes] of Object.entries(qrBuffers)) {
      const decoded = await decodeQrPng(bytes, decoderPage);
      assert.equal(decoded.node.payload, qrPayloads[purpose], `${purpose}:GENERATED_QR_MUST_DECODE_BEFORE_UPLOAD`);
      report.qrBeforeUpload.push({
        purpose,
        expectedPayload: qrPayloads[purpose],
        decodedPayload: decoded.node.payload,
        decoder: decoded.node.decoder,
        optionalBrowserDecoder: decoded.browser,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        width: decoded.node.width,
        height: decoded.node.height,
      });
    }

    stepUp = await createStepUp(db, actorId);
    const adminContext = await browser.newContext({
      viewport,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      serviceWorkers: "block",
      extraHTTPHeaders: { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp.rawToken },
    });
    await installSession(adminContext, stepUp.rawToken, true);
    observeContext(adminContext, "admin-branding");
    await blockExternalRequests(adminContext, "admin-branding");
    const adminPage = await adminContext.newPage();
    observePage(adminPage, "admin-branding");
    const adminResponse = await adminPage.goto(`${origin}/admin?tab=general`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(adminResponse?.status(), 200, "ADMIN_GENERAL_HTTP_200");
    await adminPage.getByTestId("platform-brand-settings").waitFor({ state: "visible", timeout: 45_000 });
    report.ui.admin = {
      url: adminPage.url(),
      panelVisible: true,
      viewport: await adminPage.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    };

    await assertNoConcurrentDrift(ownedSignature, "before-upload");
    await fillContactFields(adminPage);
    const uploadedAssets = {};
    for (const purpose of Object.keys(qrPayloads)) {
      await assertNoConcurrentDrift(ownedSignature, `before-upload-${purpose}`);
      uploadedAssets[purpose] = await uploadQrThroughUi(adminPage, purpose, qrBuffers[purpose]);
      report.retainedImmutableAcceptanceHistory.assetIds.push(uploadedAssets[purpose].id);
    }
    const uploadedRows = await db.query(
      `SELECT id::text,purpose,storage_provider,storage_key,sha256,mime_type,bytes,width,height
         FROM public.platform_brand_assets
        WHERE id=ANY($1::uuid[])
        ORDER BY purpose`,
      [Object.values(uploadedAssets).map((asset) => asset.id)],
    );
    assert.equal(uploadedRows.rowCount, 2, "TWO_DURABLE_QR_ASSETS_REQUIRED");
    for (const row of uploadedRows.rows) {
      assert.equal(row.storage_provider, "local", `${row.purpose}:LOCAL_STORAGE_PROVIDER_REQUIRED`);
      assert.equal(row.mime_type, "image/png", `${row.purpose}:PNG_REQUIRED`);
      assert.ok(Number(row.bytes) > 0, `${row.purpose}:BYTES_REQUIRED`);
    }

    await assertNoConcurrentDrift(ownedSignature, "before-save-draft");
    const saveResponsePromise = adminPage.waitForResponse((response) => (
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin/branding"
    ), { timeout: 30_000 });
    await adminPage.getByTestId("brand-save-draft").click();
    const saveResponse = await saveResponsePromise;
    assert.equal(saveResponse.status(), 200, `UI_SAVE_DRAFT_HTTP_${saveResponse.status()}`);
    await waitForBrandNotice(adminPage, "品牌草稿已保存并完成服务器读回");
    semanticMutationStarted = true;
    const savedState = await readAdminBranding();
    ownedSignature = stateSignature(savedState);
    assert.equal(savedState.published.id, baselineState.published.id, "SAVE_MUST_NOT_CHANGE_PUBLISHED_REVISION");
    assert.deepEqual(savedState.draft.brand.contact, contact, "SAVED_CONTACT_READBACK");
    for (const [purpose, asset] of Object.entries(uploadedAssets)) {
      assert.equal(savedState.draft.brand.assetIds[purpose], asset.id, `${purpose}:SAVED_ASSET_ID`);
    }
    report.authoritativeReadbacks.push({ stage: "saved-draft", signature: ownedSignature, draft: compactRevision(savedState.draft) });

    await adminPage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await adminPage.getByTestId("platform-brand-settings").waitFor({ state: "visible", timeout: 45_000 });
    const refreshedDraft = await readContactFields(adminPage);
    assert.deepEqual(refreshedDraft, {
      ...contact,
      primaryAssetId: uploadedAssets.contact_wechat_qr_primary.id,
      secondaryAssetId: uploadedAssets.contact_wechat_qr_secondary.id,
    }, "DRAFT_REFRESH_PERSISTENCE");
    report.ui.refreshedDraft = refreshedDraft;
    const draftScreenshot = path.join(evidenceDir, "contact-draft-after-refresh-1440x900.png");
    await adminPage.screenshot({ path: draftScreenshot, fullPage: true });
    report.screenshots.push(path.relative(process.cwd(), draftScreenshot));

    await assertNoConcurrentDrift(ownedSignature, "before-publish");
    const publishResponsePromise = adminPage.waitForResponse((response) => (
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin/branding"
    ), { timeout: 30_000 });
    await adminPage.getByTestId("brand-publish-draft").click();
    const publishResponse = await publishResponsePromise;
    assert.equal(publishResponse.status(), 200, `UI_PUBLISH_HTTP_${publishResponse.status()}`);
    await waitForBrandNotice(adminPage, "品牌版本已发布并完成服务器读回");
    const publishedState = await readAdminBranding();
    ownedSignature = stateSignature(publishedState);
    assert.equal(publishedState.draft, null, "PUBLISH_MUST_CLEAR_DRAFT");
    assert.deepEqual(publishedState.published.brand.contact, contact, "PUBLISHED_CONTACT_READBACK");
    report.retainedImmutableAcceptanceHistory.acceptancePublishedRevisionId = publishedState.published.id;
    report.authoritativeReadbacks.push({ stage: "published", signature: ownedSignature, published: compactRevision(publishedState.published) });

    const publicResult = await api("/api/branding");
    const publicBody = requireOk(publicResult, "PUBLIC_BRANDING_READ");
    assert.equal(publicBody?.branding?.revisionId, publishedState.published.id, "PUBLIC_REVISION_READBACK");
    assert.deepEqual(publicBody.branding.brand.contact, contact, "PUBLIC_CONTACT_READBACK");
    report.publicAssets = await verifyPublicAssets(publicBody.branding, uploadedAssets, decoderPage);
    assert.equal(report.publicAssets.every((asset) => asset.immutable), true, "PUBLISHED_ASSET_URLS_MUST_BE_IMMUTABLE");
    report.ui.publicHome = await verifyPublicHome(browser, uploadedAssets);
    report.ui.appSidebar = await verifyAppSidebar(browser, stepUp.rawToken);
    await assertNoConcurrentDrift(ownedSignature, "after-public-ui-verification");
    await adminContext.close();
    await decoderContext.close();

    const allowedBrowserWrites = report.browser.mutations.filter((entry) => (
      entry.scope === "admin-branding"
      && entry.method === "POST"
      && ["/api/admin/branding", "/api/admin/branding/assets"].includes(entry.pathname)
    ));
    assert.equal(allowedBrowserWrites.length, 4, `EXPECTED_FOUR_ADMIN_UI_WRITES:${JSON.stringify(report.browser.mutations)}`);
    assert.deepEqual(report.browser.unexpectedMutations, [], "UNEXPECTED_BROWSER_MUTATION");
    const baselineAssetIds = new Set(Object.values(baselineState.published?.brand?.assetIds || {}).filter(Boolean));
    report.browser.expectedLocalStorageFailures = report.browser.responseFailures.filter((entry) => (
      (entry.scope === "admin-branding"
        && entry.method === "GET"
        && entry.status === 404
        && entry.pathname.startsWith("/api/branding/assets/")
        && baselineAssetIds.has(entry.pathname.split("/").at(-1)))
      || (entry.scope === "app-sidebar"
        && entry.method === "GET"
        && entry.status === 500
        && entry.pathname === "/api/avatars")
      || (entry.scope === "app-sidebar"
        && entry.method === "POST"
        && entry.status === 503
        && entry.pathname === "/api/product-usage/events")
    ));
    const expectedFailureKeys = new Set(report.browser.expectedLocalStorageFailures.map((entry) => JSON.stringify(entry)));
    report.browser.unexpectedResponseFailures = report.browser.responseFailures.filter((entry) => !expectedFailureKeys.has(JSON.stringify(entry)));
    assert.deepEqual(report.browser.unexpectedResponseFailures, [], "UNEXPECTED_BROWSER_RESPONSE_FAILURE");
    assert.deepEqual(report.browser.pageErrors, [], "BROWSER_PAGE_ERRORS");
    const nonResourceConsoleErrors = report.browser.consoleErrors.filter((entry) => (
      !/^Failed to load resource: the server responded with a status of \d+ \(.+\)$/u.test(entry.message)
    ));
    assert.deepEqual(nonResourceConsoleErrors, [], "BROWSER_NON_RESOURCE_CONSOLE_ERRORS");
    const unexpectedServerErrors = report.browser.serverErrors.filter((entry) => ![
      "GET:500:/api/avatars",
      "POST:503:/api/product-usage/events",
    ].includes(`${entry.method}:${entry.status}:${entry.pathname}`));
    assert.deepEqual(unexpectedServerErrors, [], "BROWSER_UNEXPECTED_SERVER_ERRORS");
    report.passed = true;
  } catch (error) {
    thrown = error;
    report.failure = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 6000) : null,
    };
  } finally {
    report.cleanup.attempted = true;
    if (semanticMutationStarted && baselineState && stepUp && ownedSignature) {
      try {
        const current = await readAdminBranding();
        const actual = stateSignature(current);
        if (!sameValue(actual, ownedSignature)) {
          report.cleanup.concurrentDriftDetected = true;
          report.cleanup.concurrentDriftEvidence ||= { stage: "before-cleanup", expected: ownedSignature, actual };
        } else {
          await postBrandAction(stepUp.rawToken, "rollback", current.generation, baselineState.published.id);
          let restored = await readAdminBranding();
          report.cleanup.rollbackApiApplied = true;
          report.retainedImmutableAcceptanceHistory.rollbackRevisionId = restored.published?.id || null;
          ownedSignature = stateSignature(restored);
          assert.equal(sameValue(restored.published?.brand, baselineState.published.brand), true, "ROLLBACK_PUBLISHED_SEMANTICS");
          report.cleanup.baselinePublishedSemanticsRestored = true;

          if (baselineState.draft) {
            await assertNoConcurrentDrift(ownedSignature, "before-baseline-draft-restore");
            await postBrandAction(stepUp.rawToken, "save-draft", restored.generation, null, baselineState.draft.brand);
            restored = await readAdminBranding();
            ownedSignature = stateSignature(restored);
            report.retainedImmutableAcceptanceHistory.restoredDraftRevisionId = restored.draft?.id || null;
            assert.equal(sameValue(restored.draft?.brand, baselineState.draft.brand), true, "BASELINE_DRAFT_SEMANTICS");
          } else {
            assert.equal(restored.draft, null, "BASELINE_DRAFT_ABSENCE");
          }
          report.cleanup.baselineDraftSemanticsRestored = true;
          const finalPublic = requireOk(await api("/api/branding"), "FINAL_PUBLIC_BRANDING_READ");
          assert.equal(sameValue(finalPublic.branding?.brand, baselineState.published.brand), true, "FINAL_PUBLIC_BASELINE_SEMANTICS");
        }
      } catch (cleanupError) {
        report.failure ||= {
          name: cleanupError instanceof Error ? cleanupError.name : "Error",
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          stack: cleanupError instanceof Error ? cleanupError.stack?.slice(0, 6000) : null,
        };
        thrown ||= cleanupError;
      }
    } else if (baselineState) {
      try {
        const current = await readAdminBranding();
        const unchanged = sameValue(stateSignature(current), stateSignature(baselineState));
        report.cleanup.baselinePublishedSemanticsRestored = unchanged;
        report.cleanup.baselineDraftSemanticsRestored = unchanged;
      } catch { /* The original failure remains authoritative. */ }
    }

    if (stepUp?.tokenHash) {
      try {
        report.cleanup.stepUpRemoved = await removeStepUp(db, stepUp.tokenHash);
      } catch (cleanupError) {
        thrown ||= cleanupError;
        report.failure ||= { name: "StepUpCleanupError", message: String(cleanupError), stack: null };
      }
    } else {
      report.cleanup.stepUpRemoved = true;
    }
    if (browser) {
      await browser.close().catch(() => undefined);
      report.cleanup.browserClosed = true;
    } else {
      report.cleanup.browserClosed = true;
    }
    await db.end().catch(() => undefined);
    report.networkAudit.browserRequestCount = report.browser.requests.length;
    report.networkAudit.browserExternalRequestCount = report.browser.requests
      .filter((entry) => entry.origin !== origin && entry.origin !== "null").length;
    report.checkedAt = new Date().toISOString();
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (thrown) {
    if (!report.cleanup.stepUpRemoved || !report.cleanup.browserClosed) {
      throw new AggregateError(
        [thrown, new Error("LIVE_ACCEPTANCE_RESOURCE_CLEANUP_INCOMPLETE")],
        "Live acceptance failed and resource cleanup was incomplete",
      );
    }
    throw thrown;
  }
  assert.equal(report.cleanup.concurrentDriftDetected, false, "CONCURRENT_DRIFT_FORBIDS_AUTOMATIC_OVERWRITE");
  assert.equal(report.cleanup.rollbackApiApplied, true, "NORMAL_ROLLBACK_API_REQUIRED");
  assert.equal(report.cleanup.baselinePublishedSemanticsRestored, true, "BASELINE_PUBLISHED_RESTORE_REQUIRED");
  assert.equal(report.cleanup.baselineDraftSemanticsRestored, true, "BASELINE_DRAFT_RESTORE_REQUIRED");
  assert.equal(report.cleanup.stepUpRemoved, true, "TEMPORARY_STEP_UP_REMOVAL_REQUIRED");
  assert.equal(report.cleanup.browserClosed, true, "BROWSER_CLOSE_REQUIRED");
  assert.equal(report.passed, true, "CONTACT_LIVE_ACCEPTANCE_NOT_PASSED");
  console.log(JSON.stringify({
    passed: true,
    acceptanceIds: report.acceptanceIds,
    origin,
    sourceVersion: report.runtime.sourceVersion,
    storageProvider: report.storagePreflight.actualDefaultProvider,
    publicAssetCount: report.publicAssets.length,
    rollbackApiApplied: report.cleanup.rollbackApiApplied,
    retainedImmutableAcceptanceHistory: report.retainedImmutableAcceptanceHistory,
    reportPath: path.relative(process.cwd(), path.join(evidenceDir, "report.json")),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
