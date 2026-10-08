#!/usr/bin/env node

/**
 * Desktop, read-only proof that the tracked platform logo is the exact image
 * rendered by public, authenticated and administration shells.
 *
 * Run after a current build:
 *   node scripts/with-local-admin-session.mjs scripts/verify-platform-logo-live.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium } from "playwright";

const EXPECTED_SHA256 = "6a7d15ff1071742a6f3703ad85f100a68adf01ab550f3f52c7b8fb483fd917d7";
const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", `platform-logo-live-${runId}`);
const allowedTelemetryPaths = new Set([
  "/api/announcements/events",
  "/api/client-error-report",
  "/api/diagnostic-logs",
  "/api/operation-events",
  "/api/product-usage/events",
]);

assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
assert.ok(identity?.user?.id, "LOCAL_NAV_READONLY_IDENTITY_REQUIRED");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function pixelSha256(bytes, normalizeWidth = null) {
  const pipeline = sharp(bytes).rotate();
  if (normalizeWidth) pipeline.resize({ width: normalizeWidth, height: normalizeWidth, fit: "fill" });
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    sha256: sha256(data),
  };
}

async function readResponseBytes(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, `LOGO_ASSET_HTTP_${response.status}:${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function inspectLogo(page, id, imageLocator, containerLocator, expectedPixels, expectedPathname = "") {
  await imageLocator.waitFor({ state: "visible", timeout: 45_000 });
  if (expectedPathname) {
    await imageLocator.evaluate((image, expectedPath) => new Promise((resolve, reject) => {
      const matches = () => {
        try {
          return new URL(image.currentSrc || image.src, window.location.origin).pathname === expectedPath;
        } catch {
          return false;
        }
      };
      if (matches()) {
        resolve(undefined);
        return;
      }
      const observer = new MutationObserver(() => {
        if (!matches()) return;
        observer.disconnect();
        window.clearTimeout(timeout);
        window.clearInterval(poll);
        resolve(undefined);
      });
      const poll = window.setInterval(() => {
        if (!matches()) return;
        observer.disconnect();
        window.clearTimeout(timeout);
        window.clearInterval(poll);
        resolve(undefined);
      }, 50);
      const timeout = window.setTimeout(() => {
        observer.disconnect();
        window.clearInterval(poll);
        if (matches()) resolve(undefined);
        else reject(new Error(`PUBLISHED_LOGO_NOT_APPLIED:${expectedPath}:${image.currentSrc || image.src}`));
      }, 20_000);
      observer.observe(image, { attributes: true, attributeFilter: ["src", "srcset"] });
    }), expectedPathname);
  }
  await imageLocator.evaluate((image) => image.complete
    ? undefined
    : new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", reject, { once: true });
      }));
  const container = containerLocator || imageLocator.locator("..");
  const metrics = await imageLocator.evaluate((image, parentSelector) => {
    const parent = parentSelector ? document.querySelector(parentSelector) : image.parentElement;
    if (!(parent instanceof HTMLElement)) throw new Error("LOGO_CONTAINER_MISSING");
    const imageStyle = getComputedStyle(image);
    const parentStyle = getComputedStyle(parent);
    const imageRect = image.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    return {
      currentSrc: image.currentSrc || image.src,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      objectFit: imageStyle.objectFit,
      transform: imageStyle.transform,
      imagePadding: [imageStyle.paddingTop, imageStyle.paddingRight, imageStyle.paddingBottom, imageStyle.paddingLeft],
      parentPadding: [parentStyle.paddingTop, parentStyle.paddingRight, parentStyle.paddingBottom, parentStyle.paddingLeft],
      parentOverflow: parentStyle.overflow,
      imageWidth: imageRect.width,
      imageHeight: imageRect.height,
      parentWidth: parentRect.width,
      parentHeight: parentRect.height,
      coverageX: parentRect.width > 0 ? imageRect.width / parentRect.width : 0,
      coverageY: parentRect.height > 0 ? imageRect.height / parentRect.height : 0,
    };
  }, null);
  assert.ok(metrics.naturalWidth >= 192 && metrics.naturalWidth <= 1254, `${id}:NATURAL_WIDTH`);
  assert.equal(metrics.naturalHeight, metrics.naturalWidth, `${id}:NATURAL_ASPECT`);
  assert.equal(metrics.objectFit, "cover", `${id}:OBJECT_FIT`);
  assert.deepEqual(metrics.imagePadding, ["0px", "0px", "0px", "0px"], `${id}:IMAGE_PADDING`);
  assert.ok(metrics.coverageX >= 0.94, `${id}:HORIZONTAL_WHITESPACE:${metrics.coverageX}`);
  assert.ok(metrics.coverageY >= 0.94, `${id}:VERTICAL_WHITESPACE:${metrics.coverageY}`);
  assert.ok(["hidden", "clip"].includes(metrics.parentOverflow), `${id}:CONTAINER_NOT_CLIPPED:${metrics.parentOverflow}`);
  const assetUrl = new URL(metrics.currentSrc, origin);
  const bytes = await readResponseBytes(assetUrl.href, { Authorization: `Bearer ${token}` });
  const assetSha256 = sha256(bytes);
  const pixels = await pixelSha256(bytes, 256);
  assert.deepEqual(pixels, expectedPixels, `${id}:RENDERED_ASSET_PIXELS`);
  const screenshotPath = path.join(evidenceDir, `${id}.png`);
  await container.screenshot({ path: screenshotPath });
  return { id, ...metrics, pathname: assetUrl.pathname, sha256: assetSha256, pixelSha256: pixels.sha256, screenshotPath };
}

async function configureReadOnlyRouting(context, report) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      report.externalRequests.push({ method: request.method(), url: request.url() });
      return route.abort();
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      if (allowedTelemetryPaths.has(url.pathname)) return route.fulfill({ status: 204, body: "" });
      report.blockedWrites.push({ method: request.method(), pathname: url.pathname });
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "READ_ONLY_LOGO_ACCEPTANCE" }) });
    }
    return route.continue();
  });
}

export async function main() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    origin,
    viewport: { width: 1440, height: 900 },
    expectedSha256: EXPECTED_SHA256,
    sourceAssets: [],
    publicBranding: null,
    surfaces: [],
    externalRequests: [],
    blockedWrites: [],
    failedResponses: [],
    consoleErrors: [],
    pageErrors: [],
  };

  for (const assetPath of ["src/app/icon.png", "src/app/apple-icon.png"]) {
    const bytes = await fs.readFile(path.resolve(assetPath));
    const digest = sha256(bytes);
    assert.equal(digest, EXPECTED_SHA256, `SOURCE_ASSET_HASH:${assetPath}`);
    report.sourceAssets.push({ path: assetPath, bytes: bytes.length, sha256: digest });
  }
  const expectedPixels = await pixelSha256(await fs.readFile(path.resolve("src/app/icon.png")), 256);
  const displayFallback = await fs.readFile(path.resolve("public/brand/platform-logo-display-256.webp"));
  assert.ok(displayFallback.byteLength < 100_000, "DISPLAY_FALLBACK_TOO_LARGE");
  assert.deepEqual(await pixelSha256(displayFallback, 256), expectedPixels, "DISPLAY_FALLBACK_PIXELS");
  const servedIcon = await readResponseBytes(`${origin}/icon.png`);
  assert.equal(sha256(servedIcon), EXPECTED_SHA256, "SERVED_ICON_HASH");

  const brandingResponse = await fetch(`${origin}/api/branding`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(brandingResponse.status, 200, "PUBLIC_BRANDING_HTTP");
  const brandingBody = await brandingResponse.json();
  report.publicBranding = {
    source: brandingBody.branding?.source,
    generation: brandingBody.branding?.generation,
    revisionId: brandingBody.branding?.revisionId,
    legacyLogoUrl: brandingBody.branding?.legacyLogoUrl || null,
    logoSquareUrl: brandingBody.branding?.assets?.logo_square?.url || null,
    faviconUrl: brandingBody.branding?.assets?.favicon?.url || null,
  };
  const expectedPublishedLogoPath = report.publicBranding.logoSquareUrl
    ? new URL(report.publicBranding.logoSquareUrl, origin).pathname
    : "";

  const browser = await chromium.launch({ headless: true });
  try {
    const publicContext = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block" });
    await configureReadOnlyRouting(publicContext, report);
    const publicPage = await publicContext.newPage();
    publicPage.on("response", (response) => {
      if (response.status() >= 400 && ![409].includes(response.status())) report.failedResponses.push({ status: response.status(), url: response.url() });
    });
    publicPage.on("console", (message) => {
      if (message.type() === "error" && !/ERR_FAILED|ResizeObserver/iu.test(message.text())) report.consoleErrors.push(message.text());
    });
    publicPage.on("pageerror", (error) => report.pageErrors.push(error.message));

    const landingResponse = await publicPage.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(landingResponse?.status(), 200, "LANDING_HTTP");
    report.surfaces.push(await inspectLogo(
      publicPage,
      "landing-header-logo",
      publicPage.locator(".swh-brand-mark img"),
      publicPage.locator(".swh-brand-mark"),
      expectedPixels,
      expectedPublishedLogoPath,
    ));

    const loginResponse = await publicPage.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(loginResponse?.status(), 200, "LOGIN_HTTP");
    const loginImage = publicPage.locator('img[src*="/platform-logo-display-256.webp"], img[src*="/icon.png"], img[src*="/api/branding/assets/"]').first();
    report.surfaces.push(await inspectLogo(publicPage, "login-logo", loginImage, loginImage.locator(".."), expectedPixels, expectedPublishedLogoPath));
    await publicContext.close();

    const adminContext = await browser.newContext({
      viewport: report.viewport,
      serviceWorkers: "block",
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    await adminContext.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    await adminContext.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    await configureReadOnlyRouting(adminContext, report);
    const page = await adminContext.newPage();
    page.on("response", (response) => {
      if (response.status() >= 400 && ![409].includes(response.status())) report.failedResponses.push({ status: response.status(), url: response.url() });
    });
    page.on("console", (message) => {
      if (message.type() === "error" && !/ERR_FAILED|ResizeObserver|ERR_ABORTED/iu.test(message.text())) report.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => report.pageErrors.push(error.message));

    const routeResponse = await page.goto(`${origin}/recharge`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(routeResponse?.status(), 200, "APP_ROUTE_HTTP");
    const shellContainer = page.locator('[data-platform-logo="true"]').first();
    report.surfaces.push(await inspectLogo(page, "app-route-shell-logo", shellContainer.locator("img"), shellContainer, expectedPixels, expectedPublishedLogoPath));

    const adminResponse = await page.goto(`${origin}/admin?tab=general`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(adminResponse?.status(), 200, "ADMIN_GENERAL_HTTP");
    const adminLogo = page.locator('.admin-light-shell > header img[src*="/platform-logo-display-256.webp"], .admin-light-shell > header img[src*="/icon.png"], .admin-light-shell > header img[src*="/api/branding/assets/"]').first();
    report.surfaces.push(await inspectLogo(page, "admin-header-logo", adminLogo, adminLogo.locator(".."), expectedPixels, expectedPublishedLogoPath));
    const brandPanel = page.getByTestId("platform-brand-settings");
    await brandPanel.waitFor({ state: "visible", timeout: 45_000 });
    const brandImage = brandPanel.locator('img[alt="当前平台 Logo"]');
    report.surfaces.push(await inspectLogo(page, "admin-brand-preview-logo", brandImage, brandImage.locator(".."), expectedPixels, expectedPublishedLogoPath));
    await adminContext.close();
  } finally {
    await browser.close();
  }

  const actionableFailures = report.failedResponses.filter((entry) => !/favicon|__nextjs_original-stack-frame/iu.test(entry.url));
  const actionableConsole = report.consoleErrors.filter((message) => !/favicon|ResizeObserver|ERR_ABORTED/iu.test(message));
  assert.deepEqual(report.blockedWrites, [], "UNEXPECTED_BUSINESS_WRITE");
  assert.deepEqual(report.externalRequests, [], "UNEXPECTED_EXTERNAL_REQUEST");
  assert.deepEqual(actionableFailures, [], "HTTP_FAILURES");
  assert.deepEqual(actionableConsole, [], "CONSOLE_ERRORS");
  assert.deepEqual(report.pageErrors, [], "PAGE_ERRORS");
  assert.equal(report.surfaces.length, 5, "LOGO_SURFACE_COUNT");
  report.ok = true;
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, evidenceDir, surfaces: report.surfaces.map((surface) => ({ id: surface.id, pathname: surface.pathname, sha256: surface.sha256 })) }, null, 2));
}
