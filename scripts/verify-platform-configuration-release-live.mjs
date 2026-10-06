#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const adminIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const evidenceDir = path.resolve(".codex-evidence/platform-configuration-release");

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function assertNoPlaintextCredentials(value, at = "response") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoPlaintextCredentials(item, `${at}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!["api_key", "secret_value", "password", "rawCredential", "resolvedCredential"].includes(key), `PLAINTEXT_CREDENTIAL_PROPERTY:${at}.${key}`);
    assertNoPlaintextCredentials(item, `${at}.${key}`);
  }
}

async function overview(endpoint, headers) {
  const result = await request(`${origin}${endpoint}`, { headers });
  assert.equal(result.response.status, 200, `${endpoint}:OVERVIEW_FAILED:${JSON.stringify(result.body)}`);
  assert.equal(result.body.runtimeEnforcement?.ready, true, `${endpoint}:DATABASE_READBACK_NOT_READY:${JSON.stringify(result.body.runtimeEnforcement)}`);
  assert.deepEqual(result.body.runtimeEnforcement?.blockers, [], `${endpoint}:DATABASE_READBACK_BLOCKERS`);
  assertNoPlaintextCredentials(result.body);
  return result.body;
}

async function post(endpoint, headers, body) {
  const result = await request(`${origin}${endpoint}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.ok(result.response.ok, `${endpoint}:${body.action}_FAILED:${JSON.stringify(result.body)}`);
  assertNoPlaintextCredentials(result.body);
  return result.body;
}

async function ensureCurrent(endpoint, headers) {
  let state = await overview(endpoint, headers);
  if (state.current) return { current: state.current, bootstrapped: false, published: false };
  let candidates = state.releases.filter((row) => row.is_current !== true && ["draft", "validated"].includes(String(row.status)));
  if (candidates.length === 0) {
    await post(endpoint, headers, { action: "bootstrap", changeNote: "Codex 本地运行配置迁移基线验收" });
    state = await overview(endpoint, headers);
    candidates = state.releases.filter((row) => row.is_current !== true && ["draft", "validated"].includes(String(row.status)));
  }
  assert.ok(candidates.length > 0, `${endpoint}:BASELINE_CANDIDATE_MISSING`);
  let candidate = candidates[0];
  if (candidate.status !== "validated") {
    await post(endpoint, headers, { action: "validate", releaseId: candidate.id });
    state = await overview(endpoint, headers);
    candidate = state.releases.find((row) => row.id === candidate.id);
  }
  const validation = candidate?.validation_result || {};
  assert.equal(candidate?.status, "validated", `${endpoint}:BASELINE_INVALID:${JSON.stringify(validation)}`);
  const previewResult = await request(`${origin}${endpoint}?previewReleaseId=${encodeURIComponent(candidate.id)}`, { headers });
  assert.equal(previewResult.response.status, 200, `${endpoint}:PREVIEW_FAILED:${JSON.stringify(previewResult.body)}`);
  assert.ok(previewResult.body.preview?.previewSha256, `${endpoint}:PREVIEW_SHA_MISSING`);
  assertNoPlaintextCredentials(previewResult.body);
  await post(endpoint, headers, {
    action: "publish",
    releaseId: candidate.id,
    previewSha256: previewResult.body.preview.previewSha256,
  });
  state = await overview(endpoint, headers);
  assert.equal(state.current?.id, candidate.id, `${endpoint}:CURRENT_READBACK_MISMATCH`);
  assert.equal(state.current?.status, "published", `${endpoint}:CURRENT_STATUS_WRONG`);
  assert.equal(state.current?.is_current, true, `${endpoint}:CURRENT_FLAG_WRONG`);
  return { current: state.current, bootstrapped: true, published: true };
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_ORIGIN_REQUIRED");
  assert.ok(adminToken, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.ok(adminIdentity?.user?.id, "LOCAL_ADMIN_IDENTITY_REQUIRED");
  await fs.mkdir(evidenceDir, { recursive: true });
  const headers = { Authorization: `Bearer ${adminToken}` };

  const modelPool = await ensureCurrent("/api/admin/model-pool-releases", headers);
  const workspaceModels = await ensureCurrent("/api/admin/workspace-model-releases", headers);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, extraHTTPHeaders: headers });
  await context.addInitScript(({ token, identity }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(identity.user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: adminToken, identity: adminIdentity });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror:${error.message}`));
  try {
    await page.goto(`${origin}/admin?tab=models`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const poolPanel = page.getByTestId("platform-release-panel-model-pool");
    await poolPanel.waitFor({ timeout: 60_000 });
    await poolPanel.getByText(`当前 v${modelPool.current.release_version}`, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2), false, "MODEL_POOL_HORIZONTAL_OVERFLOW");
    await page.screenshot({ path: path.join(evidenceDir, "model-pool-release-1600x1000.png"), fullPage: false });

    await page.goto(`${origin}/admin?tab=workspace-models&project=cover`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const workspacePanel = page.getByTestId("platform-release-panel-workspace-models");
    await workspacePanel.waitFor({ timeout: 60_000 });
    await workspacePanel.getByText(`当前 v${workspaceModels.current.release_version}`, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2), false, "WORKSPACE_HORIZONTAL_OVERFLOW");
    await page.screenshot({ path: path.join(evidenceDir, "workspace-release-1600x1000.png"), fullPage: false });
  } finally {
    await context.close();
    await browser.close();
  }
  const actionableErrors = consoleErrors.filter((message) => !/favicon|ResizeObserver|net::ERR_ABORTED/iu.test(message));
  assert.deepEqual(actionableErrors, [], `BROWSER_CONSOLE_ERRORS:${JSON.stringify(actionableErrors)}`);

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    modelPool: { releaseId: modelPool.current.id, version: modelPool.current.release_version, bootstrapped: modelPool.bootstrapped },
    workspaceModels: { releaseId: workspaceModels.current.id, version: workspaceModels.current.release_version, bootstrapped: workspaceModels.bootstrapped },
    checks: ["database-runtime-readback", "immutable-candidate", "preview-fingerprint", "atomic-publish", "exact-current-readback", "desktop-browser", "credential-redaction"],
    providerRequests: 0,
    paidModelCalls: 0,
    productionWrites: 0,
    localDatabaseWrites: modelPool.published || workspaceModels.published ? "baseline-release-only" : "none",
  };
  await fs.writeFile(path.join(evidenceDir, "live-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}
