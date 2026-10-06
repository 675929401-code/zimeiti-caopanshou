#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const parsedBaseUrl = new URL(baseUrl);
const customerToken = String(process.env.R267_CUSTOMER_TOKEN || "").trim();
const customer = JSON.parse(String(process.env.LOCAL_NAV_READONLY_CUSTOMER || "null"));
const evidenceDirectory = path.resolve(".codex-evidence/r272-digital-human-storyboard-platform");
const forbiddenCatalogKeys = new Set([
  "provider", "channel", "protocol", "endpoint", "apiKey", "api_key",
  "modelName", "model_name", "costPrice", "cost_price", "internalModelId",
]);

assert.ok(
  parsedBaseUrl.protocol === "http:"
    && ["127.0.0.1", "localhost"].includes(parsedBaseUrl.hostname)
    && parsedBaseUrl.pathname === "/",
  "R272_LOCAL_APP_ORIGIN_REQUIRED",
);
assert.ok(customerToken, "R272_CUSTOMER_AUTH_REQUIRED");
assert.equal(customer?.role, "student", "R272_ORDINARY_CUSTOMER_REQUIRED");

async function customerGet(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "GET",
    headers: { Authorization: `Bearer ${customerToken}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`R272_INVALID_JSON: ${pathname} returned ${response.status}`);
  }
  return { response, payload };
}

function modelMode(model) {
  return model?.capabilities?.requiresSourceVideo === true ? "video" : "photo";
}

function findForbiddenKeys(value, currentPath = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${currentPath}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${currentPath}.${key}`;
    if (forbiddenCatalogKeys.has(key)) found.push(nextPath);
    findForbiddenKeys(child, nextPath, found);
  }
  return found;
}

export async function main() {
  const [versionRead, catalogRead] = await Promise.all([
    customerGet("/api/version"),
    customerGet("/api/video/models?surface=digital-human"),
  ]);
  assert.equal(versionRead.response.status, 200, "R272_VERSION_GET_FAILED");
  assert.equal(catalogRead.response.status, 200, "R272_DIGITAL_HUMAN_CATALOG_GET_FAILED");
  assert.ok(Array.isArray(catalogRead.payload?.models), "R272_DIGITAL_HUMAN_CATALOG_INVALID");
  assert.deepEqual(findForbiddenKeys(catalogRead.payload), [], "R272_DIGITAL_HUMAN_CATALOG_LEAKS_INTERNAL_FIELDS");

  const models = catalogRead.payload.models;
  assert.equal(new Set(models.map((model) => model?.id)).size, models.length, "R272_DIGITAL_HUMAN_PUBLIC_IDS_NOT_UNIQUE");
  const expectedOfficialModels = [
    { displayName: "即梦 OmniHuman1.5 · 照片说话", mode: "photo" },
    { displayName: "火山视觉 · 视频改口型 Lite", mode: "video" },
    { displayName: "阿里声动人像 · 视频改口型", mode: "video" },
    { displayName: "阿里万相 · 照片说话", mode: "photo" },
    { displayName: "Seedance 2.0 Fast · 照片说话", mode: "photo" },
  ];
  const officialCatalog = expectedOfficialModels.map((expected) => {
    const model = models.find((item) => item?.displayName === expected.displayName);
    assert.ok(model, `R272_OFFICIAL_MODEL_NOT_PUBLIC: ${expected.displayName}`);
    assert.equal(modelMode(model), expected.mode, `R272_OFFICIAL_MODEL_MODE_MISMATCH: ${expected.displayName}`);
    assert.ok(Number(model.publicPrice) > 0, `R272_OFFICIAL_MODEL_PRICE_MISSING: ${expected.displayName}`);
    const available = model.capabilities?.available === true;
    if (!available) {
      assert.ok(
        String(model.capabilities?.availabilityMessage || "").length > 0,
        `R272_OFFICIAL_MODEL_CUSTOMER_MESSAGE_MISSING: ${expected.displayName}`,
      );
    }
    return {
      id: model.id,
      displayName: model.displayName,
      mode: expected.mode,
      available,
      publicPrice: Number(model.publicPrice),
      availabilityMessage: String(model.capabilities?.availabilityMessage || ""),
    };
  });

  const browserUser = {
    id: String(customer.id),
    username: String(customer.username || customer.email || "r272-customer"),
    displayName: String(customer.displayName || customer.display_name || customer.username || "普通用户"),
    role: "student",
  };
  const audit = {
    blockedNonGet: [],
    blockedExternal: [],
    blockedCommerce: [],
    pageErrors: [],
    consoleErrors: [],
    httpFailures: [],
    executedNonGet: 0,
    providerCalls: 0,
    paidCalls: 0,
    productDatabaseWrites: 0,
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.addInitScript(({ token, user }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: customerToken, user: browserUser });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      audit.blockedExternal.push({ method, url: request.url(), reason: "invalid-url" });
      await route.abort("blockedbyclient");
      return;
    }
    if (["data:", "blob:"].includes(url.protocol)) {
      await route.continue();
      return;
    }
    if (url.origin !== parsedBaseUrl.origin) {
      audit.blockedExternal.push({ method, url: url.href, reason: "external-origin" });
      await route.abort("blockedbyclient");
      return;
    }
    if (/^\/(?:api\/)?commerce(?:\/|$)/iu.test(url.pathname)) {
      audit.blockedCommerce.push({ method, path: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (method !== "GET") {
      audit.blockedNonGet.push({ method, path: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: browserUser }) });
      return;
    }
    // Do not let an existing in-flight account task make this read-only page
    // probe advance or poll a provider. The public model catalog remains real.
    if (url.pathname === "/api/video/history") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [], nextOffset: null }) });
      return;
    }
    if (url.pathname === "/api/digital-human/long-history") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [], nextOffset: null }) });
      return;
    }
    if (url.pathname === "/api/cash/balance") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 0 }) });
      return;
    }
    if (url.pathname === "/api/voice/favorites") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ voices: [], favorites: [] }) });
      return;
    }
    if (url.pathname === "/api/conversations/history") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [], data: [] }) });
      return;
    }
    if (url.pathname === "/api/digital-human/voices") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ voices: [] }) });
      return;
    }
    if (url.pathname === "/api/announcements/inbox") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ announcements: [], unreadCount: 0 }) });
      return;
    }
    if (url.pathname === "/api/credits") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ credits: 0, balance: 0 }) });
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => audit.pageErrors.push({ name: error.name, message: error.message }));
  page.on("console", (entry) => {
    if (entry.type() === "error") audit.consoleErrors.push(entry.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      audit.httpFailures.push({ method: response.request().method(), status: response.status(), url: response.url() });
    }
  });

  const results = {};
  try {
    const digitalResponse = await page.goto(`${baseUrl}/digital-human`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assert.equal(digitalResponse?.status(), 200, "R272_DIGITAL_HUMAN_PAGE_FAILED");
    const modelSelect = page.getByRole("combobox", { name: "数字人模型", exact: true });
    await modelSelect.waitFor({ state: "visible", timeout: 20_000 });

    const renderedByMode = {};
    for (const mode of ["photo", "video"]) {
      const label = mode === "photo" ? "照片说话" : "视频改口型";
      await page.getByRole("tab", { name: new RegExp(`^${label}`) }).click();
      await page.waitForTimeout(100);
      renderedByMode[mode] = await modelSelect.locator("option").allTextContents();
      for (const expected of officialCatalog.filter((model) => model.mode === mode)) {
        assert.ok(
          renderedByMode[mode].some((text) => text.includes(expected.displayName)),
          `R272_MODEL_MISSING_FROM_CUSTOMER_SELECT: ${expected.displayName}`,
        );
        const option = modelSelect.locator("option").filter({ hasText: expected.displayName });
        assert.equal(await option.count(), 1, `R272_MODEL_OPTION_NOT_UNIQUE: ${expected.displayName}`);
        assert.equal(
          await option.evaluate((element) => element.disabled === true),
          !expected.available,
          `R272_MODEL_OPTION_AVAILABILITY_MISMATCH: ${expected.displayName}`,
        );
        if (!expected.available) {
          assert.ok(
            (await option.textContent())?.includes(expected.availabilityMessage),
            `R272_MODEL_OPTION_CUSTOMER_MESSAGE_MISSING: ${expected.displayName}`,
          );
        }
      }
    }

    const digitalText = await page.locator("body").innerText();
    for (const forbidden of ["管理员免费", "管理员免", "供应商", "上游余额", "API Key", "数据库迁移"]) {
      assert.equal(digitalText.includes(forbidden), false, `R272_DIGITAL_HUMAN_INTERNAL_COPY_EXPOSED: ${forbidden}`);
    }
    results.digitalHuman = {
      catalogCount: models.length,
      officialCatalog,
      renderedByMode,
      customerInternalCopyHidden: true,
    };

  } finally {
    await context.close();
    await browser.close();
  }

  assert.deepEqual(audit.pageErrors, [], "R272_PAGE_ERRORS_PRESENT");
  const unexpectedHttpFailures = audit.httpFailures.filter((failure) => {
    const url = new URL(failure.url);
    return !(failure.method === "GET"
      && failure.status === 503
      && url.pathname === "/api/image-workbench/failure-history");
  });
  assert.deepEqual(unexpectedHttpFailures, [], "R272_UNEXPECTED_HTTP_FAILURES_PRESENT");
  const unexpectedConsoleErrors = audit.consoleErrors.filter((message) => !message.startsWith("Failed to load resource:"));
  assert.deepEqual(unexpectedConsoleErrors, [], "R272_UNEXPECTED_CONSOLE_ERRORS_PRESENT");
  assert.deepEqual(audit.blockedCommerce, [], "R272_COMMERCE_REQUEST_ATTEMPTED");
  assert.equal(audit.executedNonGet, 0);
  assert.equal(audit.providerCalls, 0);
  assert.equal(audit.paidCalls, 0);
  assert.equal(audit.productDatabaseWrites, 0);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceVersion: versionRead.payload?.sourceVersion || versionRead.payload?.version || null,
    buildId: versionRead.payload?.buildId || null,
    customerRole: customer.role,
    results,
    audit,
    acceptanceBoundary: {
      customerIdentityMode: "browser-readonly-fixture",
      digitalHumanPlatformConfigurationPassed: true,
      storyboardExcludedFromThisProbe: true,
      upstreamBalanceQuotaOrAuthExcludedByUser: true,
      realGenerationExecuted: false,
      deploymentExecuted: false,
      migrationsExecuted: false,
      dataReconciliationExecuted: false,
    },
  };
  await fs.mkdir(evidenceDirectory, { recursive: true });
  await fs.writeFile(path.join(evidenceDirectory, "ui-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  await main();
}
