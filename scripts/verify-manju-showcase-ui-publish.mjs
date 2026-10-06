import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { chromium } from "playwright";
import { manjuConfigSemanticHash } from "./lib/manju-config-semantic-hash.mjs";

dotenv.config({ path: ".env.local", quiet: true });
const origin = "http://127.0.0.1:5000";
const output = process.argv[2] || ".codex-evidence/manju-current/showcase-ui-publish.json";
const marker = `e2e-manju-showcase-ui-${Date.now()}-${randomUUID().slice(0, 8)}`;
for (const name of ["JWT_SECRET", "COZE_SUPABASE_URL", "COZE_SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) throw new Error(`MISSING_${name}`);
}
const db = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const report = {
  observedAt: new Date().toISOString(), origin, marker,
  mode: "authorized-local-admin-ui-save-publish-and-reviewed-rollback",
  providerCalls: 0, paidGenerationRequests: 0, databaseMutations: 0,
  steps: [], pageErrors: [], httpErrors: [], blocked: [],
};
let adminToken = "";
let ordinaryToken = "";
let baseline;
let ownRevisionId = "";
let adminBrowser;

const revision = (record) => record?.revision || record || {};
const revisionId = (record) => record?.revision_id || record?.pointer?.revision_id || record?.release?.revision_id || revision(record).revision_id || revision(record).id || "";
const releaseId = (record) => record?.release_id || record?.active_release_id || record?.pointer?.active_release_id || record?.release?.id || record?.id || "";

async function tokenFor(user) {
  return new SignJWT({ userId: user.id, username: user.username || user.email || "local-acceptance", role: user.role,
    displayName: user.display_name || "本地验收" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30m")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function api(route, { method = "GET", body, token = adminToken } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${method} ${route}: HTTP ${response.status} ${data.code || ""}`);
  assert.notEqual(data.ok, false, data.code || data.error || "API_FAILED");
  if (method !== "GET") report.databaseMutations += 1;
  return data;
}

async function publicRuntime() {
  return api(`/api/youcai/runtime-config?environment=production&t=${Date.now()}`, { token: "" });
}

async function normalFrontReadback(canvasId) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
  await context.addInitScript(({ tokenValue, expectedOrigin }) => {
    if (location.origin === expectedOrigin) localStorage.setItem("auth_token", tokenValue);
  }, { tokenValue: ordinaryToken, expectedOrigin: origin });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
      report.blocked.push({ stage: "ordinary-front", method: request.method(), path: url.origin === origin ? url.pathname : "external" });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push({ stage: "ordinary-front", name: error.name, message: error.message.slice(0, 160) }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) report.httpErrors.push({ stage: "ordinary-front", path: url.pathname, status: response.status() });
  });
  try {
    const response = await page.goto(`${origin}/youcai/tools/canvas`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200);
    const card = page.locator(`[data-showcase-id="${canvasId}"]`);
    await card.getByText(marker, { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    const state = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      fatalText: /Application error|Unhandled Runtime Error|This page could not be found/iu.test(document.body.innerText),
      sidebarCount: document.querySelectorAll('[data-testid="film-studio-sidebar"]').length,
      mainCount: document.querySelectorAll('[data-testid="manju-content"]').length,
    }));
    assert.equal(state.horizontalOverflow, false);
    assert.equal(state.fatalText, false);
    assert.equal(state.sidebarCount, 1);
    assert.equal(state.mainCount, 1);
    report.steps.push({ stage: "ordinary-front-readback", canvasId, publishedTitleVisible: true, ...state });
  } finally {
    await browser.close();
  }
}

try {
  const users = await db.from("users")
    .select("id,username,email,display_name,role,status,is_active")
    .in("role", ["admin", "student"]).eq("is_active", true).limit(100);
  if (users.error) throw users.error;
  const admin = users.data.find((item) => item.role === "admin" && (item.status === "active" || item.status === null));
  const ordinary = users.data.find((item) => item.role === "student" && (item.status === "active" || item.status === null));
  assert.ok(admin, "ACTIVE_ADMIN_REQUIRED");
  assert.ok(ordinary, "ACTIVE_ORDINARY_USER_REQUIRED");
  adminToken = await tokenFor(admin);
  ordinaryToken = await tokenFor(ordinary);
  baseline = await api("/api/admin/manju-config?environment=production&domain=media");
  assert.ok(baseline.active && Number.isInteger(baseline.storage_generation));
  const baselinePayload = revision(baseline.active).payload;
  const baselineHash = manjuConfigSemanticHash(baselinePayload);
  const baselineReleaseId = releaseId(baseline.active);
  const baselineRevisionId = revisionId(baseline.active);
  assert.ok(baselineReleaseId && baselineRevisionId);

  adminBrowser = await chromium.launch({ headless: true });
  const context = await adminBrowser.newContext({ viewport: { width: 1480, height: 1100 }, serviceWorkers: "block" });
  await context.addInitScript(({ tokenValue, userValue, expectedOrigin }) => {
    if (location.origin !== expectedOrigin) return;
    localStorage.setItem("auth_token", tokenValue);
    localStorage.setItem("auth_user", JSON.stringify(userValue));
  }, { tokenValue: adminToken, userValue: admin, expectedOrigin: origin });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let allowed = url.origin === origin && ["GET", "HEAD"].includes(request.method());
    if (url.origin === origin && request.method() === "POST" && url.pathname === "/api/admin/manju-config") {
      try {
        const body = JSON.parse(request.postData() || "{}");
        allowed = body.environment === "production" && body.domain === "media" && ["save-draft", "publish"].includes(body.action);
      } catch {
        allowed = false;
      }
    }
    if (allowed) return route.continue();
    report.blocked.push({ stage: "admin-ui", method: request.method(), path: url.origin === origin ? url.pathname : "external" });
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push({ stage: "admin-ui", name: error.name, message: error.message.slice(0, 160) }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) report.httpErrors.push({ stage: "admin-ui", path: url.pathname, status: response.status() });
  });
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "confirm" && /确认发布 production\/media/u.test(dialog.message())) await dialog.accept();
    else await dialog.dismiss();
  });
  const navigation = await page.goto(`${origin}/admin?tab=manju-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(navigation?.status(), 200);
  const manager = page.locator('[data-admin-section="manju-showcase-catalog"]');
  await manager.getByRole("button", { name: "画布示例", exact: true }).waitFor({ state: "visible", timeout: 45_000 });
  await manager.getByRole("button", { name: "草稿、发布与回滚", exact: true }).click();
  await manager.getByRole("button", { name: "作为新草稿起点", exact: true }).click();
  await manager.getByRole("button", { name: "画布示例", exact: true }).click();
  const siteConfig = await api("/api/site-config", { token: "" });
  const firstExample = siteConfig.data?.canvasExamples?.[0];
  assert.ok(firstExample?.canvasId);
  const editor = manager.locator("article").filter({ has: page.getByText(firstExample.canvasId, { exact: true }) });
  await editor.getByLabel("标题", { exact: true }).fill(marker);
  const saveResponsePromise = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/admin/manju-config" || response.request().method() !== "POST") return false;
    try { return JSON.parse(response.request().postData() || "{}").action === "save-draft"; } catch { return false; }
  }, { timeout: 45_000 });
  await manager.getByRole("button", { name: "保存草稿", exact: true }).click();
  const saveResponse = await saveResponsePromise;
  const saveBody = await saveResponse.json();
  assert.equal(saveResponse.status(), 200);
  assert.notEqual(saveBody.ok, false);
  ownRevisionId = revisionId(saveBody.revision) || saveBody.revision?.id || "";
  assert.ok(ownRevisionId);
  report.databaseMutations += 1;
  await manager.getByText(/展示配置草稿已保存/u).waitFor({ state: "visible", timeout: 30_000 });
  report.steps.push({ stage: "admin-ui-save", canvasId: firstExample.canvasId, ownRevisionIdPresent: true, noticeVisible: true });

  const draftOnly = await publicRuntime();
  assert.equal(manjuConfigSemanticHash(draftOnly.domains.media), baselineHash, "draft leaked to public runtime");
  const publishResponsePromise = page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== "/api/admin/manju-config" || response.request().method() !== "POST") return false;
    try { return JSON.parse(response.request().postData() || "{}").action === "publish"; } catch { return false; }
  }, { timeout: 45_000 });
  await manager.getByRole("button", { name: "发布所选草稿", exact: true }).click();
  const publishResponse = await publishResponsePromise;
  const publishBody = await publishResponse.json();
  assert.equal(publishResponse.status(), 200);
  assert.notEqual(publishBody.ok, false);
  report.databaseMutations += 1;
  await manager.getByText(/展示配置发布成功/u).waitFor({ state: "visible", timeout: 30_000 });
  report.steps.push({ stage: "admin-ui-publish", noticeVisible: true, releaseReceiptPresent: Boolean(releaseId(publishBody.release) || publishBody.release?.id) });
  await adminBrowser.close();
  adminBrowser = undefined;

  const published = await publicRuntime();
  assert.equal(published.domains.media.showcase_catalog?.v1?.canvas_examples?.overrides?.[firstExample.canvasId]?.title, marker);
  report.steps.push({ stage: "public-api-readback", publishedMarkerMatched: true, draftStayedPrivate: true });
  await normalFrontReadback(firstExample.canvasId);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error?.name || "Error", message: error?.message || "UNKNOWN" };
  process.exitCode = 1;
} finally {
  await adminBrowser?.close().catch(() => {});
  try {
    if (baseline?.active && ownRevisionId) {
      const current = await api("/api/admin/manju-config?environment=production&domain=media");
      if (revisionId(current.active) === ownRevisionId) {
        await api("/api/admin/manju-config", {
          method: "POST",
          body: {
            action: "rollback", environment: "production", domain: "media",
            expected_storage_generation: current.storage_generation,
            target_release_id: releaseId(baseline.active),
            expected_active_release_id: releaseId(current.active),
          },
        });
        const restored = await publicRuntime();
        assert.equal(manjuConfigSemanticHash(restored.domains.media), manjuConfigSemanticHash(revision(baseline.active).payload));
        report.steps.push({ stage: "reviewed-rollback", baselinePayloadRestored: true });
      } else if (revisionId(current.active) !== revisionId(baseline.active)) {
        report.rollbackFailure = "CONCURRENT_MEDIA_CHANGE_NO_AUTOMATIC_ROLLBACK";
        report.passed = false;
        process.exitCode = 1;
      }
    }
  } catch (error) {
    report.rollbackFailure = error?.message || "ROLLBACK_FAILED";
    report.passed = false;
    process.exitCode = 1;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}
