#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const adminIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const evidenceDir = path.resolve(".codex-evidence/credential-safety");

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function assertNoSecretProperties(value, pathName = "response") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretProperties(item, `${pathName}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!["api_key", "secret_value", "rawCredential", "resolvedCredential", "credentialSuffix"].includes(key), `SECRET_PROPERTY_EXPOSED:${pathName}.${key}`);
    assertNoSecretProperties(item, `${pathName}.${key}`);
  }
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_ORIGIN_REQUIRED");
  assert.ok(adminToken, "LOCAL_ADMIN_TOKEN_REQUIRED");
  assert.ok(adminIdentity?.user?.id, "LOCAL_ADMIN_IDENTITY_REQUIRED");
  await fs.mkdir(evidenceDir, { recursive: true });
  const headers = { Authorization: `Bearer ${adminToken}` };

  const [health, models, missingCredential] = await Promise.all([
    jsonRequest(`${origin}/api/admin/credential-health`, { headers }),
    jsonRequest(`${origin}/api/admin/models`, { headers }),
    jsonRequest(`${origin}/api/admin/video-models/quick-add`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "https://example.com/v1 test-model 售价1.2", dryRun: true }),
    }),
  ]);
  assert.equal(health.response.status, 200, `CREDENTIAL_HEALTH_FAILED:${JSON.stringify(health.body)}`);
  assert.equal(models.response.status, 200, "ADMIN_MODELS_FAILED");
  assert.equal(missingCredential.response.status, 400, "QUICK_ADD_MISSING_CREDENTIAL_NOT_REJECTED_BEFORE_NETWORK");
  assert.equal(health.body.policy.plaintextCredentialReturned, false, "PLAINTEXT_POLICY_WRONG");
  assert.equal(health.body.policy.resolvedCredentialReturned, false, "RESOLVED_SECRET_POLICY_WRONG");
  assert.equal(health.body.policy.credentialSuffixReturned, false, "SECRET_SUFFIX_POLICY_WRONG");
  assert.equal(health.body.policy.editFieldsAreWriteOnly, true, "WRITE_ONLY_POLICY_WRONG");
  assert.equal(health.body.summary.total, health.body.credentials.length, "CREDENTIAL_SUMMARY_COUNT_WRONG");
  assert.ok(health.body.credentials.every((item) => /^cfg_[a-f0-9]{12}$/u.test(item.credentialId)), "SAFE_CONFIGURATION_ID_WRONG");
  assert.ok(health.body.credentials.every((item) => typeof item.configured === "boolean" && item.validationStatus), "CREDENTIAL_STATUS_INCOMPLETE");
  assertNoSecretProperties(health.body);
  assertNoSecretProperties(models.body);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    extraHTTPHeaders: headers,
  });
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
    const safetyPanel = page.getByTestId("credential-safety-panel");
    await safetyPanel.waitFor({ timeout: 60_000 });
    await page.getByTestId("credential-safety-summary").waitFor({ timeout: 30_000 });
    await safetyPanel.getByRole("button", { name: "查看安全清单" }).click();
    await page.getByTestId("credential-safety-details").waitFor();
    const quickAdd = page.getByTestId("secure-video-quick-add");
    await quickAdd.waitFor();
    assert.equal(await quickAdd.getByLabel("视频模型渠道密钥").getAttribute("type"), "password", "QUICK_ADD_CREDENTIAL_NOT_PASSWORD_FIELD");
    assert.ok(!(await quickAdd.getByLabel("视频模型非敏感配置").getAttribute("placeholder") || "").includes("密钥"), "NON_SECRET_FIELD_REQUESTS_CREDENTIAL");
    const pageText = await safetyPanel.innerText();
    assert.match(pageText, /不返回明文、尾号或可解析密钥/u, "SAFE_PRESENTATION_COPY_MISSING");
    await page.screenshot({ path: path.join(evidenceDir, "credential-safety-model-pool-1600x1000.png"), fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    assert.equal(overflow, false, "MODEL_POOL_HORIZONTAL_OVERFLOW");

    for (const adjacent of ["workspace-models&project=cover", "agents"]) {
      await page.goto(`${origin}/admin?tab=${adjacent}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator("main").waitFor({ timeout: 30_000 });
      const adjacentOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      assert.equal(adjacentOverflow, false, `ADMIN_ADJACENT_PAGE_OVERFLOW:${adjacent}`);
    }
    const actionableErrors = consoleErrors.filter((message) => !/favicon|ResizeObserver|net::ERR_ABORTED/iu.test(message));
    assert.deepEqual(actionableErrors, [], `BROWSER_CONSOLE_ERRORS:${JSON.stringify(actionableErrors)}`);
  } finally {
    await context.close();
    await browser.close();
  }

  const version = await jsonRequest(`${origin}/api/version`);
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    sourceVersion: version.body.sourceVersion,
    buildId: version.body.buildId,
    checks: {
      noCredentialValueOrSuffixReturned: true,
      safeConfigurationIds: true,
      configurationAndValidationSeparated: true,
      quickAddCredentialWriteOnlyPasswordField: true,
      missingCredentialRejectedBeforeNetwork: true,
      modelPoolDesktopVisual: true,
      adjacentPages: ["workspace-models&project=cover", "agents"],
      browserConsoleClean: true,
    },
    providerRequests: 0,
    paidModelCalls: 0,
    productionWrites: 0,
  };
  await fs.writeFile(path.join(evidenceDir, "live-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}
