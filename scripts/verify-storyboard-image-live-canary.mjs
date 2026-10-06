#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();

async function authenticatedJson(pathname, timeoutMs = 30_000) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, body?.error || `${pathname} failed with ${response.status}`);
  return body;
}

async function billingSnapshot() {
  const [balance, transactions] = await Promise.all([
    authenticatedJson("/api/cash/balance"),
    authenticatedJson("/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50"),
  ]);
  const cashRows = (transactions?.data?.transactions || []).filter((row) => row?.category === "cash");
  return {
    balance: Number(balance.balance),
    cashRows,
    cashIds: new Set(cashRows.map((row) => String(row.id))),
  };
}

export async function main() {
  const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9) || "";
  const modelContains = process.argv.find((value) => value.startsWith("--model-contains="))
    ?.slice("--model-contains=".length).trim() || "Nano Banana Pro";
  const requestedResolution = process.argv.find((value) => value.startsWith("--resolution="))
    ?.slice("--resolution=".length).trim().toUpperCase() || "1K";
  const expectedFailureCode = process.argv.find((value) => value.startsWith("--expect-failure-code="))
    ?.slice("--expect-failure-code=".length).trim() || "";
  const execute = process.argv.includes("--execute");
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.match(runId, /^[a-zA-Z0-9_-]{8,100}$/u, "UNIQUE_RUN_ID_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

  const outputDir = path.resolve(".codex-evidence/storyboard-image-platform-fix-20260920", runId);
  await fs.mkdir(outputDir, { recursive: true });
  if (!execute) {
    console.log(JSON.stringify({ mode: "plan", providerPostLimit: 1, outputDir }));
    return;
  }

  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const identity = await identityResponse.json();
  assert.equal(identityResponse.status, 200, identity?.error || "ADMIN_IDENTITY_FAILED");
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");

  const catalogResponse = await fetch(`${origin}/api/cover-models?surface=storyboard-workbench`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200, catalog?.error || "STORYBOARD_IMAGE_CATALOG_FAILED");
  const selected = catalog.models?.find((model) => String(model.displayName || model.name || "").includes(modelContains)
    && model.capabilities?.available !== false
    && model.capabilities?.priceReady !== false);
  assert.ok(selected?.id, `REQUESTED_IMAGE_MODEL_NOT_AVAILABLE:${modelContains}`);
  assert.ok(
    (selected.capabilities?.resolutionOptions || []).map((value) => String(value).toUpperCase()).includes(requestedResolution),
    `REQUESTED_IMAGE_RESOLUTION_NOT_AVAILABLE:${requestedResolution}`,
  );

  const billingBefore = await billingSnapshot();
  assert.ok(Number.isFinite(billingBefore.balance), "BILLING_BALANCE_BEFORE_INVALID");

  const marker = `SBW_IMAGE_FIX_${runId}_${randomUUID()}`;
  const markerPath = path.join(outputDir, "dispatch.json");
  await fs.writeFile(markerPath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    runId,
    marker,
    selectedModelId: selected.id,
    selectedModel: selected.displayName,
    requestedResolution,
    expectedFailureCode: expectedFailureCode || null,
    balanceBefore: billingBefore.balance,
    providerPostLimit: 1,
  }, null, 2)}\n`, { flag: "wx" });

  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  const pageErrors = [];
  let generationPosts = 0;
  let requestBody = null;
  let responseBody = null;
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      serviceWorkers: "block",
    });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });

    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 400)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 400));
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/image/generate") {
        generationPosts += 1;
        requestBody = request.postDataJSON();
      }
    });

    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The visible/accessible label may include a channel variant. Bind the
    // canary to the stable public model ID used by the request contract.
    const modelButton = page.locator(`.sbw-image-model-list button[data-model-id="${selected.id}"]`).first();
    await modelButton.waitFor({ state: "visible", timeout: 45_000 });
    await modelButton.click();

    const removeButtons = page.getByTitle("删除镜头", { exact: true });
    while (await removeButtons.count() > 1) await removeButtons.last().click();

    const imageControls = page.locator(".sbw-control-group.is-image");
    await imageControls.getByRole("button", { name: "16:9", exact: true }).click();
    const resolutionSelect = imageControls.getByRole("combobox", { name: "图片分辨率" });
    if (await resolutionSelect.count()) {
      const options = await resolutionSelect.locator("option").allTextContents();
      assert.ok(options.some((value) => value.trim().toUpperCase() === requestedResolution),
        `IMAGE_RESOLUTION_OPTION_MISSING:${requestedResolution}`);
      await resolutionSelect.selectOption({ label: requestedResolution });
    }

    const card = page.locator("article.sbw-shot-card").first();
    const prompt = `一只可爱的金毛幼犬在明亮整洁的木地板客厅里轻轻跳舞，商业级3D动画质感，完整身体，暖色自然光，16:9横构图，无文字，无水印。内部验收标记 ${marker}，标记仅用于请求核对，不得出现在画面中。`;
    await card.getByRole("textbox", { name: "镜头1生图提示词" }).fill(prompt);
    const generateButton = card.getByRole("button", { name: "生成图片", exact: true });
    await generateButton.waitFor({ state: "visible" });
    assert.equal(await generateButton.isEnabled(), true, "STORYBOARD_IMAGE_BUTTON_DISABLED");

    const generationResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/image/generate", { timeout: 360_000 });
    await generateButton.click();
    const generationResponse = await generationResponsePromise;
    responseBody = await generationResponse.json().catch(() => null);
    if (expectedFailureCode) {
      assert.ok(generationResponse.status() >= 400, "EXPECTED_IMAGE_FAILURE_DID_NOT_OCCUR");
      assert.equal(responseBody?.code, expectedFailureCode, responseBody?.error || "IMAGE_FAILURE_CODE_MISMATCH");
      assert.equal(generationPosts, 1, "STORYBOARD_IMAGE_POST_COUNT_INVALID");
      const billingAfterFailure = await billingSnapshot();
      const failureBalanceDelta = Number((billingBefore.balance - billingAfterFailure.balance).toFixed(6));
      const failureCashRows = billingAfterFailure.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
      assert.equal(failureBalanceDelta, 0, "FAILED_IMAGE_REQUEST_CHANGED_BALANCE");
      assert.equal(failureCashRows.length, 0, "FAILED_IMAGE_REQUEST_CREATED_CASH_TRANSACTION");
      await page.screenshot({ path: path.join(outputDir, "storyboard-image-expected-failure.png"), fullPage: true });
      const failureReport = {
        runId,
        checkedAt: new Date().toISOString(),
        sourceVersion: await page.evaluate(async () => (await fetch("/api/version")).json()).then((value) => value.sourceVersion),
        selectedModel: selected.displayName,
        selectedModelId: selected.id,
        requestedResolution,
        generationPosts,
        expectedFailure: {
          httpStatus: generationResponse.status(),
          code: responseBody.code,
          error: responseBody.error,
          balanceDelta: failureBalanceDelta,
          newTransactionCount: failureCashRows.length,
        },
        consoleErrors,
        pageErrors,
        tokenPersisted: false,
      };
      await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(failureReport, null, 2)}\n`);
      console.log(JSON.stringify({
        success: true,
        expectedFailure: true,
        runId,
        code: responseBody.code,
        generationPosts,
        cashCharged: 0,
        report: path.join(outputDir, "report.json"),
      }));
      return;
    }
    assert.equal(generationResponse.status(), 200, responseBody?.error || "STORYBOARD_IMAGE_GENERATION_FAILED");
    assert.equal(responseBody?.success, true, "STORYBOARD_IMAGE_RESPONSE_NOT_SUCCESS");
    assert.equal(generationPosts, 1, "STORYBOARD_IMAGE_POST_COUNT_INVALID");
    assert.equal(requestBody?.historySurface, "storyboard-workbench");
    assert.equal(requestBody?.modelId, selected.id);
    assert.ok(responseBody?.images?.[0]?.assetId, "STORYBOARD_IMAGE_ASSET_ID_MISSING");

    const generatedImage = card.getByRole("img", { name: "任务1故事板" });
    await generatedImage.waitFor({ state: "visible", timeout: 60_000 });
    const rendered = await generatedImage.evaluate((image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
      complete: image.complete,
      src: image.currentSrc || image.src,
    }));
    assert.ok(rendered.complete && rendered.width > 0 && rendered.height > 0, "STORYBOARD_IMAGE_NOT_RENDERED");
    await card.getByText("图片完成", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });

    const statusQuery = new URLSearchParams({
      clientIdempotencyKey: requestBody.clientIdempotencyKey,
      clientTraceId: requestBody.clientTraceId,
    });
    const statusResponse = await context.request.get(`${origin}/api/image/status?${statusQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const status = await statusResponse.json();
    assert.equal(statusResponse.status(), 200, status?.error || "STORYBOARD_IMAGE_STATUS_FAILED");
    assert.equal(status?.state, "completed", "STORYBOARD_IMAGE_NOT_TERMINAL");
    assert.equal(status?.assetId, responseBody.images[0].assetId, "STORYBOARD_IMAGE_STATUS_ASSET_MISMATCH");

    const expectedCharge = Number(responseBody.cashCharged);
    assert.ok(Number.isFinite(expectedCharge) && expectedCharge > 0, "ADMIN_GENERATION_MUST_USE_NORMAL_BILLING");
    let billingAfter = await billingSnapshot();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const newCashRows = billingAfter.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
      if (newCashRows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      billingAfter = await billingSnapshot();
    }
    const balanceDelta = Number((billingBefore.balance - billingAfter.balance).toFixed(6));
    assert.ok(Math.abs(balanceDelta - expectedCharge) <= 0.000001,
      `BILLING_BALANCE_DELTA_MISMATCH:${balanceDelta}:${expectedCharge}`);
    const newCashRows = billingAfter.cashRows.filter((row) => !billingBefore.cashIds.has(String(row.id)));
    assert.equal(newCashRows.length, 1, `BILLING_TRANSACTION_COUNT_MISMATCH:${newCashRows.length}`);
    assert.match(String(newCashRows[0].referenceId || ""), /^image:/u, "IMAGE_BILLING_REFERENCE_MISSING");
    assert.ok(Math.abs(Math.abs(Number(newCashRows[0].amount)) - expectedCharge) <= 0.000001,
      "IMAGE_BILLING_TRANSACTION_AMOUNT_MISMATCH");

    const assetResponse = await context.request.get(rendered.src, {
      headers: rendered.src.startsWith(origin) ? { Authorization: `Bearer ${token}` } : {},
    });
    const assetBytes = Buffer.from(await assetResponse.body());
    const metadata = await sharp(assetBytes).metadata();
    assert.ok(assetResponse.ok() && assetBytes.length > 1_000 && metadata.width && metadata.height, "STORYBOARD_IMAGE_ASSET_INVALID");
    const assetExtension = metadata.format === "jpeg" ? "jpg" : (metadata.format || "bin");
    const assetFile = `generated-image.${assetExtension}`;
    await fs.writeFile(path.join(outputDir, assetFile), assetBytes, { flag: "wx" });

    await page.screenshot({ path: path.join(outputDir, "storyboard-image-success.png"), fullPage: true });
    const report = {
      runId,
      checkedAt: new Date().toISOString(),
      sourceVersion: await page.evaluate(async () => (await fetch("/api/version")).json()).then((value) => value.sourceVersion),
      selectedModel: selected.displayName,
      selectedModelId: selected.id,
      requestedResolution,
      generationPosts,
      request: {
        historySurface: requestBody.historySurface,
        aspectRatio: requestBody.aspectRatio,
        resolution: requestBody.resolution,
        traceId: requestBody.clientTraceId,
      },
      response: {
        success: responseBody.success,
        status: responseBody.status,
        modelIdUsed: responseBody.modelIdUsed,
        assetId: responseBody.images[0].assetId,
        cashCharged: responseBody.cashCharged,
        idempotencyReplayed: responseBody.idempotencyReplayed,
      },
      terminalStatus: status.state,
      billing: {
        balanceBefore: billingBefore.balance,
        balanceAfter: billingAfter.balance,
        balanceDelta,
        newTransactionCount: newCashRows.length,
        referenceId: newCashRows[0].referenceId,
        amount: Number(newCashRows[0].amount),
      },
      rendered,
      asset: {
        bytes: assetBytes.length,
        sha256: createHash("sha256").update(assetBytes).digest("hex"),
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        file: assetFile,
      },
      consoleErrors,
      pageErrors,
      tokenPersisted: false,
    };
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      success: true,
      runId,
      generationPosts,
      terminalStatus: status.state,
      assetId: responseBody.images[0].assetId,
      cashCharged: responseBody.cashCharged,
      report: path.join(outputDir, "report.json"),
    }));
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
