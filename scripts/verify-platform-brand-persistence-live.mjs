#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const actor = identity.user || {};
const databaseUrl = String(process.env.DATABASE_URL || "");
const userAgent = "Codex-Platform-Brand-Acceptance/1.0";
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", `platform-brand-persistence-${runId}`);
const sourceLogo = path.resolve("src/app/icon.png");

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_5000_ORIGIN_REQUIRED");
assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
assert.ok(actor.id, "LOCAL_ADMIN_IDENTITY_REQUIRED");
assert.ok(databaseUrl, "LOCAL_DATABASE_URL_REQUIRED");

const report = {
  passed: false,
  checkedAt: "",
  origin,
  viewport: { width: 1440, height: 900 },
  saveDraftWithoutStepUp: null,
  publishWithoutStepUp: null,
  uploadedAsset: null,
  refreshedDraft: null,
  published: null,
  publicReadback: null,
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  serverErrors: [],
  cleanup: {},
  productionWrites: 0,
  paidCalls: 0,
};

function completeBrand(value = {}) {
  return {
    schema: "platform-brand/v1",
    name: String(value.name || "自媒体操盘手"),
    shortName: String(value.shortName || "操盘手"),
    slogan: String(value.slogan || "AI 内容经营系统"),
    welcomeMessage: String(value.welcomeMessage || "欢迎回到自媒体操盘手"),
    description: String(value.description || "把洞察、创作、生产和经营数据沉淀为可持续复用的内容资产。"),
    seo: {
      title: String(value.seo?.title || value.name || "自媒体操盘手"),
      description: String(value.seo?.description || "面向创作者与内容团队的 AI 内容经营系统。"),
    },
    colors: {
      primary: String(value.colors?.primary || "#168D7A").toUpperCase(),
      accent: String(value.colors?.accent || "#2F80FF").toUpperCase(),
    },
    assetIds: { ...(value.assetIds || {}) },
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function api(pathname, options = {}) {
  return fetch(`${origin}${pathname}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    ...options,
    headers: {
      "User-Agent": userAgent,
      ...(options.headers || {}),
    },
  });
}

async function readAdminState() {
  const response = await api("/api/admin/branding", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const body = await readJson(response);
  assert.equal(response.status, 200, `BRAND_ADMIN_READ_${response.status}:${JSON.stringify(body)}`);
  assert.equal(body.ok, true, "BRAND_ADMIN_READ_OK");
  return body.state;
}

await fs.mkdir(evidenceDir, { recursive: true });
const db = new pg.Client({ connectionString: databaseUrl, application_name: "codex-platform-brand-acceptance" });
let stepUpToken = "";
let stepUpHash = "";
let browser;

try {
  const initial = await readAdminState();
  assert.equal(initial.migrationRequired, false, "BRAND_MIGRATION_REQUIRED");
  const initialBrand = completeBrand(initial.draft?.brand || initial.published?.brand || initial.publicBranding?.brand);

  const saveResponse = await api("/api/admin/branding", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `brand-persistence-save-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ action: "save-draft", expectedGeneration: initial.generation, brand: initialBrand }),
  });
  const saved = await readJson(saveResponse);
  assert.equal(saveResponse.status, 200, `BRAND_SAVE_WITHOUT_STEP_UP_${saveResponse.status}:${JSON.stringify(saved)}`);
  assert.equal(saved.ok, true, "BRAND_SAVE_WITHOUT_STEP_UP_OK");
  const afterSave = await readAdminState();
  assert.ok(afterSave.draft?.id, "BRAND_DRAFT_REQUIRED_AFTER_SAVE");
  report.saveDraftWithoutStepUp = { status: saveResponse.status, generation: afterSave.generation, revisionId: afterSave.draft.id };

  const deniedPublishResponse = await api("/api/admin/branding", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `brand-persistence-denied-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ action: "publish", expectedGeneration: afterSave.generation, revisionId: afterSave.draft.id }),
  });
  const deniedPublish = await readJson(deniedPublishResponse);
  assert.equal(deniedPublishResponse.status, 428, `BRAND_PUBLISH_STEP_UP_REQUIRED_${deniedPublishResponse.status}`);
  assert.equal(deniedPublish.code, "ADMIN_STEP_UP_REQUIRED", "BRAND_PUBLISH_STEP_UP_CODE");
  report.publishWithoutStepUp = { status: deniedPublishResponse.status, code: deniedPublish.code };

  const selfResponse = await api("/api/admin/access-control/self", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const self = await readJson(selfResponse);
  assert.equal(selfResponse.status, 200, `ADMIN_SELF_${selfResponse.status}`);
  assert.ok(self.access?.permissionKeys?.includes("brand.settings.manage"), "BRAND_PERMISSION_REQUIRED");

  await db.connect();
  stepUpToken = crypto.randomBytes(32).toString("base64url");
  stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.admin_governance_write','on',true)");
  await db.query(
    `INSERT INTO public.admin_step_up_sessions
      (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
     VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1',$5,now() + interval '8 minutes')`,
    [actor.id, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision, userAgent],
  );
  await db.query("COMMIT");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: report.viewport, serviceWorkers: "block", colorScheme: "light" });
  await context.addCookies([
    { name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    { name: "zimeiti_admin_step_up", value: stepUpToken, url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: actor });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" && !/ResizeObserver|ERR_ABORTED/iu.test(message.text())) report.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 500)));
  page.on("response", (response) => {
    if (response.status() >= 500) report.serverErrors.push({ status: response.status(), pathname: new URL(response.url()).pathname });
  });

  const adminResponse = await page.goto(`${origin}/admin?tab=general`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(adminResponse?.status(), 200, "ADMIN_GENERAL_HTTP");
  const panel = page.getByTestId("platform-brand-settings");
  await panel.waitFor({ state: "visible", timeout: 45_000 });
  const upload = panel.locator('input[aria-label="上传主 Logo"]');
  await upload.setInputFiles(sourceLogo);
  await page.getByRole("status").filter({ hasText: "主 Logo已上传到平台存储" }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("brand-save-draft").click();
  await page.getByRole("status").filter({ hasText: "品牌草稿已保存" }).waitFor({ state: "visible", timeout: 60_000 });

  const afterUploadSave = await readAdminState();
  const assetId = afterUploadSave.draft?.brand?.assetIds?.logo_square;
  assert.ok(assetId, "PERSISTED_DRAFT_LOGO_ASSET_REQUIRED");
  const uploadedAsset = afterUploadSave.assets.find((asset) => asset.id === assetId);
  assert.ok(uploadedAsset && uploadedAsset.purpose === "logo_square", "DRAFT_LOGO_ASSET_RECORD_REQUIRED");
  report.uploadedAsset = {
    id: assetId,
    purpose: uploadedAsset.purpose,
    width: uploadedAsset.width,
    height: uploadedAsset.height,
    bytes: uploadedAsset.bytes,
    published: uploadedAsset.published,
  };

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await panel.waitFor({ state: "visible", timeout: 45_000 });
  const persistedSelect = panel.locator('select[aria-label="选择主 Logo"]');
  await persistedSelect.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await persistedSelect.inputValue(), assetId, "DRAFT_LOGO_SELECTION_NOT_RESTORED");
  const preview = panel.locator('img[alt="主 Logo预览"]');
  await preview.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const image = document.querySelector('img[alt="主 Logo预览"]');
    return image instanceof HTMLImageElement
      && image.complete
      && image.naturalWidth > 0
      && (/^blob:/u.test(image.currentSrc || image.src)
        || /\/api\/admin\/branding\/assets\//u.test(image.currentSrc || image.src));
  }, { timeout: 30_000 });
  const previewMetrics = await preview.evaluate((image) => ({
    src: image.currentSrc || image.src,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  }));
  assert.equal(previewMetrics.naturalWidth, 1254, "DRAFT_PREVIEW_WIDTH");
  assert.equal(previewMetrics.naturalHeight, 1254, "DRAFT_PREVIEW_HEIGHT");
  assert.match(previewMetrics.src, /^(blob:|http:\/\/127\.0\.0\.1:5000\/api\/admin\/branding\/assets\/)/u, "DRAFT_PREVIEW_PROTECTED_SOURCE");
  report.refreshedDraft = { assetId, naturalWidth: previewMetrics.naturalWidth, naturalHeight: previewMetrics.naturalHeight, protectedPreview: true };
  const draftScreenshot = path.join(evidenceDir, "brand-draft-after-refresh-1440x900.png");
  await page.screenshot({ path: draftScreenshot, fullPage: false });
  report.screenshots.push(path.relative(process.cwd(), draftScreenshot).replaceAll("\\", "/"));

  await page.getByTestId("brand-publish-draft").click();
  await page.getByRole("status").filter({ hasText: "品牌版本已发布" }).waitFor({ state: "visible", timeout: 60_000 });
  const afterPublish = await readAdminState();
  assert.equal(afterPublish.published?.brand?.assetIds?.logo_square, assetId, "PUBLISHED_LOGO_ASSET_REQUIRED");
  assert.equal(afterPublish.draft, null, "DRAFT_MUST_CLEAR_AFTER_PUBLISH");
  report.published = { generation: afterPublish.generation, revisionId: afterPublish.published.id, assetId };

  const publicResponse = await api("/api/branding", { headers: { Accept: "application/json" } });
  const publicBody = await readJson(publicResponse);
  assert.equal(publicResponse.status, 200, `PUBLIC_BRANDING_${publicResponse.status}`);
  assert.equal(publicBody.branding?.source, "published", "PUBLIC_BRANDING_SOURCE");
  assert.equal(publicBody.branding?.assets?.logo_square?.id, assetId, "PUBLIC_LOGO_ASSET_ID");
  const publicAssetResponse = await api(publicBody.branding.assets.logo_square.url);
  const publicAssetBytes = Buffer.from(await publicAssetResponse.arrayBuffer());
  assert.equal(publicAssetResponse.status, 200, `PUBLIC_BRAND_ASSET_${publicAssetResponse.status}`);
  assert.equal(crypto.createHash("sha256").update(publicAssetBytes).digest("hex"), publicBody.branding.assets.logo_square.sha256, "PUBLIC_ASSET_HASH");
  report.publicReadback = {
    source: publicBody.branding.source,
    revisionId: publicBody.branding.revisionId,
    assetId,
    pathname: new URL(publicBody.branding.assets.logo_square.url, origin).pathname,
    sha256: publicBody.branding.assets.logo_square.sha256,
  };

  const publishedScreenshot = path.join(evidenceDir, "brand-published-1440x900.png");
  await page.screenshot({ path: publishedScreenshot, fullPage: false });
  report.screenshots.push(path.relative(process.cwd(), publishedScreenshot).replaceAll("\\", "/"));
  await context.close();

  assert.deepEqual(report.consoleErrors, [], "BROWSER_CONSOLE_ERRORS");
  assert.deepEqual(report.pageErrors, [], "BROWSER_PAGE_ERRORS");
  assert.deepEqual(report.serverErrors, [], "BROWSER_SERVER_ERRORS");
  report.passed = true;
} finally {
  await browser?.close().catch(() => undefined);
  if (stepUpHash) {
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('app.admin_governance_write','on',true)");
      await db.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
      await db.query("COMMIT");
      report.cleanup.stepUpSessionRemoved = true;
    } catch {
      await db.query("ROLLBACK").catch(() => undefined);
      report.cleanup.stepUpSessionRemoved = false;
    }
  }
  await db.end().catch(() => undefined);
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

assert.equal(report.passed, true, "PLATFORM_BRAND_PERSISTENCE_ACCEPTANCE_FAILED");
process.stdout.write(`${JSON.stringify({ passed: report.passed, evidenceDir, saveDraftWithoutStepUp: report.saveDraftWithoutStepUp, publishWithoutStepUp: report.publishWithoutStepUp, uploadedAsset: report.uploadedAsset, publicReadback: report.publicReadback, cleanup: report.cleanup }, null, 2)}\n`);
