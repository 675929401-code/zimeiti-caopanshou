#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { chromium } from "playwright";
import { decodeJwt } from "jose";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const evidenceDir = path.resolve(".codex-evidence", "agent-image-upload-live");
const suffix = crypto.randomBytes(5).toString("hex");
const fixtureName = `图片资产验收-${suffix}`;
const userAgent = `codex-agent-image-live/${suffix}`;

const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  origin,
  fixtureName,
  agentId: null,
  uploadedKeys: [],
  uploadedAssetIds: [],
  assertions: {},
  browser: { pageErrors: [], consoleErrors: [], serverErrors: [], providerRequests: [], unexpectedWrites: [] },
  cleanup: { agentRemoved: false, assetRowsRemoved: false, stepUpRemoved: false },
  productionWrites: 0,
  paidCalls: 0,
};

function headers(stepUpToken, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    "x-admin-step-up": stepUpToken,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text.slice(0, 500) }; }
}

async function api(pathname, stepUpToken, init = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { ...headers(stepUpToken, Boolean(init.body && typeof init.body === "string")), ...(init.headers || {}) },
    signal: AbortSignal.timeout(40_000),
  });
  return { response, body: await readJson(response) };
}

async function uploadImage(stepUpToken, purpose, bytes, name, mimeType = "image/png") {
  const form = new FormData();
  form.set("purpose", purpose);
  form.set("file", new Blob([bytes], { type: mimeType }), name);
  const result = await api("/api/admin/agents/assets", stepUpToken, { method: "POST", body: form });
  assert.equal(result.response.status, 201, `AGENT_IMAGE_UPLOAD_FAILED:${purpose}:${result.response.status}:${result.body?.error || "unknown"}`);
  assert.ok(result.body?.asset?.key, `AGENT_IMAGE_KEY_MISSING:${purpose}`);
  assert.ok(result.body?.asset?.assetId, `AGENT_IMAGE_ASSET_ID_MISSING:${purpose}`);
  report.uploadedKeys.push(result.body.asset.key);
  report.uploadedAssetIds.push(result.body.asset.assetId);
  return result.body.asset;
}

async function createStepUp(db, actorId) {
  const self = await api("/api/admin/access-control/self", "", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(self.response.status, 200, `ADMIN_ACCESS_SELF_FAILED:${self.response.status}`);
  assert.equal(self.body?.access?.integrityValid, true, "ADMIN_ACCESS_INTEGRITY_REQUIRED");
  assert.ok(self.body.access.permissionKeys.includes("agents.manage"), "AGENTS_MANAGE_PERMISSION_REQUIRED");
  assert.ok(self.body.access.permissionKeys.includes("prompts.edit"), "PROMPTS_EDIT_PERMISSION_REQUIRED");
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
  await db.query("BEGIN");
  try {
    await db.query("SELECT set_config('app.admin_governance_write','on',true)");
    await db.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1',$5,now()+interval '12 minutes')`,
      [actorId, hash, JSON.stringify(self.body.access.permissionKeys), self.body.access.revision, userAgent],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  return { rawToken, hash };
}

async function deleteAsset(stepUpToken, key, assetId = "") {
  const result = await api("/api/admin/agents/assets", stepUpToken, {
    method: "DELETE",
    body: JSON.stringify({ key, ...(assetId ? { assetId } : {}) }),
  }).catch(() => null);
  return result || { response: { status: 0 }, body: null };
}

async function waitForAssetRowCount(db, key, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.query("SELECT count(*)::int AS count FROM public.user_files WHERE storage_key=$1", [key]);
    if (Number(result.rows[0]?.count || 0) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`ASSET_ROW_COUNT_TIMEOUT:${key}:${expected}`);
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "FIXED_LOCAL_PREVIEW_REQUIRED");
  assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.equal(identity?.user?.role, "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");
  const actorId = String(decodeJwt(token).userId || "");
  assert.ok(actorId, "LOCAL_ADMIN_ACTOR_REQUIRED");
  const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_DATABASE_REQUIRED");
  await fs.mkdir(evidenceDir, { recursive: true });

  const db = new pg.Client({
    ...runtime.ownerConnection,
    application_name: `codex-agent-image-live-${suffix}`,
    connectionTimeoutMillis: 10_000,
    query_timeout: 40_000,
  });
  await db.connect();
  let stepUp = null;
  let agentId = "";
  let browser;
  try {
    stepUp = await createStepUp(db, actorId);

    const avatarBytes = await sharp({
      create: { width: 256, height: 256, channels: 4, background: { r: 30, g: 145, b: 125, alpha: 1 } },
    }).png().toBuffer();
    const coverBytes = await sharp({
      create: { width: 1200, height: 630, channels: 4, background: { r: 244, g: 236, b: 216, alpha: 1 } },
    }).png().toBuffer();
    const replacementCoverBytes = await sharp({
      create: { width: 1200, height: 630, channels: 4, background: { r: 47, g: 128, b: 237, alpha: 1 } },
    }).png().toBuffer();

    const forged = new FormData();
    forged.set("purpose", "avatar");
    forged.set("file", new Blob([Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")], { type: "image/png" }), "forged.png");
    const forgedResult = await api("/api/admin/agents/assets", stepUp.rawToken, { method: "POST", body: forged });
    assert.equal(forgedResult.response.status, 415, `FORGED_MIME_MUST_BE_REJECTED:${forgedResult.response.status}`);
    report.assertions.forgedMimeRejected = true;

    const avatar = await uploadImage(stepUp.rawToken, "avatar", avatarBytes, "avatar.png");
    const cover = await uploadImage(stepUp.rawToken, "cover", coverBytes, "cover.png");
    assert.deepEqual([avatar.width, avatar.height], [256, 256]);
    assert.deepEqual([cover.width, cover.height], [1200, 630]);
    const durableReceipts = await db.query(
      "SELECT id,storage_key,file_size,content_type,meta FROM public.user_files WHERE id=ANY($1::uuid[]) ORDER BY storage_key",
      [[avatar.assetId, cover.assetId]],
    );
    assert.equal(durableReceipts.rowCount, 2, "DURABLE_ASSET_RECEIPTS_REQUIRED");
    for (const row of durableReceipts.rows) {
      assert.ok(row.storage_key === avatar.key || row.storage_key === cover.key);
      assert.ok(Number(row.file_size) > 0);
      assert.equal(row.content_type, "image/png");
      assert.ok(row.meta?.sha256);
      assert.ok(row.meta?.width);
      assert.ok(row.meta?.height);
    }
    report.assertions.uploadedAndNormalized = true;
    report.assertions.durableAssetReceipts = true;

    const disposable = await uploadImage(stepUp.rawToken, "avatar", avatarBytes, "discard-me.png");
    const mismatchedDelete = await deleteAsset(stepUp.rawToken, disposable.key, avatar.assetId);
    assert.equal(mismatchedDelete.response.status, 409, "ASSET_ID_MISMATCH_MUST_FAIL");
    const disposableDelete = await deleteAsset(stepUp.rawToken, disposable.key, disposable.assetId);
    assert.equal(disposableDelete.response.status, 200, "UNREFERENCED_ASSET_DELETE_FAILED");
    assert.equal(disposableDelete.body?.deletedAssetId, disposable.assetId);
    await waitForAssetRowCount(db, disposable.key, 0);
    report.assertions.stableAssetIdentityAndDiscard = true;

    const orphan = await uploadImage(stepUp.rawToken, "cover", coverBytes, "orphan-cover.png");
    await db.query("UPDATE public.user_files SET created_at=now()-interval '48 hours' WHERE id=$1", [orphan.assetId]);
    const sweep = await api("/api/admin/agents/assets", stepUp.rawToken, {
      method: "PUT",
      body: JSON.stringify({ maxAgeHours: 24 }),
    });
    assert.equal(sweep.response.status, 200, `ORPHAN_SWEEP_FAILED:${sweep.response.status}`);
    assert.ok(Number(sweep.body?.deleted || 0) >= 1, "ORPHAN_SWEEP_DID_NOT_DELETE_FIXTURE");
    await waitForAssetRowCount(db, orphan.key, 0);
    report.assertions.orphanSweepVerified = true;

    const model = await db.query(
      `SELECT id,model_name FROM public.llm_models
        WHERE coalesce(is_active,true) IS TRUE
        ORDER BY updated_at DESC NULLS LAST,created_at DESC NULLS LAST
        LIMIT 1`,
    );
    assert.equal(model.rowCount, 1, "ACTIVE_LLM_MODEL_REQUIRED");
    const category = await db.query(
      `SELECT name AS category
         FROM public.categories
        WHERE is_active IS TRUE
          AND coalesce(visibility,'public') <> 'private'
          AND name <> '自用'
        ORDER BY sort_order NULLS LAST,name
        LIMIT 1`,
    );
    assert.equal(category.rowCount, 1, "PUBLIC_AGENT_CATEGORY_REQUIRED");
    const created = await api("/api/admin/agents", stepUp.rawToken, {
      method: "POST",
      body: JSON.stringify({
        name: fixtureName,
        description: "本地图片资产链验收夹具",
        category: String(category.rows[0]?.category || "通用"),
        source: "llm",
        model_id: String(model.rows[0].id),
        model: String(model.rows[0].model_name || ""),
        system_prompt: "本地验收夹具，不调用模型。",
        avatar: avatar.key,
        cover_url: cover.key,
        is_active: true,
        user_access: "available",
        cost_per_message: 0,
      }),
    });
    assert.equal(created.response.status, 200, `AGENT_CREATE_FAILED:${created.response.status}:${created.body?.error || "unknown"}`);
    agentId = String(created.body?.agent?.id || "");
    assert.ok(agentId, "AGENT_CREATE_ID_MISSING");
    report.agentId = agentId;

    const stored = await db.query("SELECT avatar,cover_url,is_active,user_access FROM public.agents WHERE id=$1", [agentId]);
    assert.equal(stored.rowCount, 1, "AGENT_NOT_PERSISTED");
    assert.equal(stored.rows[0].avatar, avatar.key);
    assert.equal(stored.rows[0].cover_url, cover.key);
    assert.equal(stored.rows[0].is_active, true);
    report.assertions.stableKeysPersisted = true;

    const inUseDelete = await deleteAsset(stepUp.rawToken, avatar.key, avatar.assetId);
    assert.equal(inUseDelete.response.status, 409, "IN_USE_ASSET_DELETE_MUST_FAIL");
    assert.equal(inUseDelete.body?.code, "AGENT_IMAGE_IN_USE");
    report.assertions.inUseAssetProtected = true;

    const automaticAttempt = await api("/api/admin/agents/batch-avatar", stepUp.rawToken, {
      method: "POST",
      body: JSON.stringify({
        agentId,
        singleAgent: { name: fixtureName, description: "不得覆盖人工头像" },
        idempotencyKey: `manual-avatar-preserve-${suffix}`,
        confirmPaidGeneration: true,
        confirmedAgentCount: 1,
      }),
    });
    assert.equal(automaticAttempt.response.status, 409, "AUTOMATIC_TASK_MUST_SKIP_MANUAL_AVATAR");
    assert.equal(automaticAttempt.body?.code, "MANUAL_AVATAR_PRESERVED");
    report.assertions.manualAvatarPreservedBeforeProviderCall = true;

    for (const asset of [avatar, cover]) {
      const response = await fetch(`${origin}/api/avatars?key=${encodeURIComponent(asset.key)}`, { signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200, `AGENT_IMAGE_READ_FAILED:${asset.key}:${response.status}`);
      const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      assert.equal(metadata.width, asset.width);
      assert.equal(metadata.height, asset.height);
    }
    report.assertions.imagesReadableAfterDatabaseWrite = true;

    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await context.addCookies([
      {
        name: "auth_token",
        value: token,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "zimeiti_admin_step_up",
        value: stepUp.rawToken,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const telemetry = new Set([
        "/api/announcements/events",
        "/api/operation-events",
        "/api/product-usage/events",
      ]);
      if (/^\/api\/(?:llm|chat|image\/generate|video\/generate|voice\/(?:tts|nest)|digital-human\/generate)(?:\/|$)/u.test(url.pathname)) {
        report.browser.providerRequests.push(`${request.method()} ${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (request.method() !== "GET") {
        if (telemetry.has(url.pathname)) {
          await route.fulfill({ status: 204, body: "" });
          return;
        }
        const allowed = request.method() === "POST" && url.pathname === "/api/admin/agents/assets"
          || request.method() === "DELETE" && url.pathname === "/api/admin/agents/assets"
          || request.method() === "PUT" && url.pathname === "/api/admin/agents"
          || request.method() === "POST" && url.pathname === "/api/admin/prompt-versions"
          || request.method() === "POST" && url.pathname === "/__nextjs_original-stack-frames";
        if (!allowed) {
          report.browser.unexpectedWrites.push(`${request.method()} ${url.pathname}`);
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.browser.pageErrors.push(String(error?.message || error)));
    page.on("console", (message) => {
      if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/u.test(message.text())) report.browser.consoleErrors.push(message.text().slice(0, 800));
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 500) report.browser.serverErrors.push(`${response.status()} ${url.pathname}`);
    });
    await page.goto(`${origin}/admin?tab=agents`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const row = page.locator("tbody tr").filter({ hasText: fixtureName });
    await row.waitFor({ state: "visible", timeout: 45_000 });
    const firstPromptLoad = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/admin/prompt-versions", { timeout: 20_000 }).catch(() => null);
    await row.getByRole("button", { name: "编辑", exact: true }).click();
    const heading = page.getByRole("heading", { name: "编辑智能体", exact: true });
    await heading.waitFor({ state: "visible", timeout: 20_000 });
    const modal = heading.locator("xpath=ancestor::div[contains(@class,'fixed')][1]");
    const avatarPreview = modal.getByAltText("头像预览");
    const coverPreview = modal.getByAltText("App背景图预览");
    await avatarPreview.waitFor({ state: "visible", timeout: 20_000 });
    await coverPreview.waitFor({ state: "visible", timeout: 20_000 });
    await firstPromptLoad;
    assert.match(await avatarPreview.getAttribute("src") || "", new RegExp(encodeURIComponent(avatar.key).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(await coverPreview.getAttribute("src") || "", new RegExp(encodeURIComponent(cover.key).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    report.assertions.editDialogRestoresBothImages = true;

    const fileInputs = modal.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]');
    assert.ok(await fileInputs.count() >= 2, "EDIT_IMAGE_INPUTS_MISSING");
    const uploadResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin/agents/assets");
    await fileInputs.nth(1).setInputFiles({ name: "replacement-cover.png", mimeType: "image/png", buffer: replacementCoverBytes });
    const uploadResponse = await uploadResponsePromise;
    const replacementPayload = await uploadResponse.json();
    assert.equal(uploadResponse.status(), 201, `EDIT_COVER_UPLOAD_FAILED:${uploadResponse.status()}`);
    const replacementKey = String(replacementPayload?.asset?.key || "");
    assert.ok(replacementKey, "REPLACEMENT_COVER_KEY_MISSING");
    report.uploadedKeys.push(replacementKey);
    await modal.getByAltText("App背景图预览").waitFor({ state: "visible", timeout: 20_000 });
    const saveResponsePromise = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/admin/agents");
    const promptSavePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/admin/prompt-versions", { timeout: 20_000 }).catch(() => null);
    await modal.getByRole("button", { name: "保存修改", exact: true }).click();
    const saveResponse = await saveResponsePromise;
    assert.equal(saveResponse.status(), 200, `EDIT_AGENT_SAVE_FAILED:${saveResponse.status()}:${await saveResponse.text()}`);
    await promptSavePromise;
    await heading.waitFor({ state: "hidden", timeout: 30_000 });
    const updated = await db.query("SELECT avatar,cover_url FROM public.agents WHERE id=$1", [agentId]);
    assert.equal(updated.rows[0].avatar, avatar.key);
    assert.equal(updated.rows[0].cover_url, replacementKey);
    await waitForAssetRowCount(db, cover.key, 0);
    report.assertions.browserReplacementPersisted = true;
    report.assertions.replacedAssetReclaimed = true;

    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    const reloadedRow = page.locator("tbody tr").filter({ hasText: fixtureName });
    await reloadedRow.waitFor({ state: "visible", timeout: 45_000 });
    const reloadedPromptLoad = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/admin/prompt-versions", { timeout: 20_000 }).catch(() => null);
    await reloadedRow.getByRole("button", { name: "编辑", exact: true }).click();
    const reloadedCover = page.getByRole("heading", { name: "编辑智能体", exact: true })
      .locator("xpath=ancestor::div[contains(@class,'fixed')][1]")
      .getByAltText("App背景图预览");
    await reloadedCover.waitFor({ state: "visible", timeout: 20_000 });
    await reloadedPromptLoad;
    assert.match(await reloadedCover.getAttribute("src") || "", new RegExp(encodeURIComponent(replacementKey).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    report.assertions.browserReloadRestoresReplacement = true;
    await page.screenshot({ path: path.join(evidenceDir, "agent-edit-images-1440x900.png"), fullPage: false });

    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const marketplaceCard = page.getByRole("button", { name: `打开智能体：${fixtureName}`, exact: true });
    await marketplaceCard.waitFor({ state: "visible", timeout: 45_000 });
    const marketplaceCover = await marketplaceCard.getAttribute("data-agent-cover-url");
    assert.match(marketplaceCover || "", new RegExp(encodeURIComponent(replacementKey).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    const marketplaceCoverImage = marketplaceCard.locator('img[aria-hidden="true"]');
    await marketplaceCoverImage.waitFor({ state: "visible", timeout: 20_000 });
    assert.match(await marketplaceCoverImage.getAttribute("src") || "", new RegExp(encodeURIComponent(replacementKey).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    report.assertions.marketplaceCoverReadback = true;
    await page.screenshot({ path: path.join(evidenceDir, "agent-marketplace-cover-1440x900.png"), fullPage: false });
    await context.close();

    assert.deepEqual(report.browser.providerRequests, [], "PROVIDER_REQUEST_DETECTED");
    assert.deepEqual(report.browser.pageErrors, [], "BROWSER_PAGE_ERRORS");
    assert.deepEqual(report.browser.consoleErrors, [], "BROWSER_CONSOLE_ERRORS");
    assert.deepEqual(report.browser.serverErrors, [], "BROWSER_SERVER_ERRORS");
    assert.deepEqual(report.browser.unexpectedWrites, [], "UNEXPECTED_BROWSER_WRITES");
  } finally {
    await browser?.close().catch(() => undefined);
    if (agentId && stepUp?.rawToken) {
      await api(`/api/admin/agents?id=${encodeURIComponent(agentId)}`, stepUp.rawToken, { method: "DELETE", body: JSON.stringify({ agentId }) }).catch(() => null);
      await api(`/api/admin/agents?id=${encodeURIComponent(agentId)}&permanent=1`, stepUp.rawToken, { method: "DELETE", body: JSON.stringify({ agentId, permanent: true }) }).catch(() => null);
    }
    if (stepUp?.rawToken) {
      for (const key of [...new Set(report.uploadedKeys)]) await deleteAsset(stepUp.rawToken, key);
    }
    if (stepUp?.hash) {
      try {
        await db.query("BEGIN");
        await db.query("SELECT set_config('app.admin_governance_write','on',true)");
        await db.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUp.hash]);
        await db.query("COMMIT");
      } catch {
        await db.query("ROLLBACK").catch(() => undefined);
      }
    }
    const agentCount = agentId ? await db.query("SELECT count(*)::int AS count FROM public.agents WHERE id=$1", [agentId]) : { rows: [{ count: 0 }] };
    const assetCount = report.uploadedKeys.length
      ? await db.query("SELECT count(*)::int AS count FROM public.user_files WHERE storage_key=ANY($1::text[])", [[...new Set(report.uploadedKeys)]])
      : { rows: [{ count: 0 }] };
    const stepCount = stepUp?.hash
      ? await db.query("SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUp.hash])
      : { rows: [{ count: 0 }] };
    report.cleanup.agentRemoved = Number(agentCount.rows[0]?.count || 0) === 0;
    report.cleanup.assetRowsRemoved = Number(assetCount.rows[0]?.count || 0) === 0;
    report.cleanup.stepUpRemoved = Number(stepCount.rows[0]?.count || 0) === 0;
    report.checkedAt = new Date().toISOString();
    await db.end().catch(() => undefined);
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  assert.deepEqual(report.cleanup, { agentRemoved: true, assetRowsRemoved: true, stepUpRemoved: true }, "LOCAL_FIXTURE_CLEANUP_FAILED");
  report.passed = true;
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) {
  await main();
}
