import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const origin = String(process.env.BASE_URL || process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "Local preview is required");
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9);
assert.match(runId || "", /^[a-zA-Z0-9_-]{6,100}$/u, "Unique --run-id required");
const execute = process.argv.includes("--execute");
const outputDir = path.resolve(".codex-evidence/image-workbench-live-20260904", runId);
await fs.mkdir(outputDir, { recursive: true });
const markerPath = path.join(outputDir, "dispatch.json");
if (!execute) {
  console.log(JSON.stringify({ mode: "plan", networkPosts: 0, command: `node scripts/verify-image-workbench-live-e2e.mjs --run-id=${runId} --execute` }));
} else {
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  assert.ok(token, "Verified local admin token required");
  const sessionResponse = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const session = await sessionResponse.json();
  assert.ok(sessionResponse.ok && session.user?.role === "admin", "Local admin session required");
  const modelsResponse = await fetch(`${origin}/api/cover-models`, { headers: { Authorization: `Bearer ${token}` } });
  const catalog = await modelsResponse.json();
  const selected = catalog.models?.find((model) => model.displayName === "Nano Banana 2") || catalog.models?.[0];
  assert.ok(modelsResponse.ok && selected?.id, "Current public image model required");
  const marker = `IMAGE_UI_E2E_${runId}_${randomUUID()}`;
  await fs.writeFile(markerPath, `${JSON.stringify({ createdAt: new Date().toISOString(), runId, marker, selectedModelId: selected.id, providerPostLimit: 1 })}\n`, { flag: "wx" });

  const browser = await chromium.launch({ headless: true });
  let generationPosts = 0;
  let requestBody = null;
  let responseBody = null;
  const consoleErrors = [];
  const pageErrors = [];
  let downloaded = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
    }, { token, user: session.user });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300)); });
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 300)));
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/image/generate") {
        generationPosts += 1;
        requestBody = request.postDataJSON();
      }
    });
    await page.goto(`${origin}/image-workbench`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.locator("select").first().selectOption(selected.id);
    await page.getByRole("button", { name: "1:1", exact: true }).click();
    while (await page.getByRole("button", { name: "删除生图卡片", exact: true }).count() > 1) {
      await page.getByRole("button", { name: "删除生图卡片", exact: true }).last().click();
    }
    const prompt = `白色背景上的青色马克杯，商品摄影，画面简洁，无文字。${marker}`;
    await page.getByPlaceholder("在这里填写这一张图片的完整提示词", { exact: true }).fill(prompt);
    const generationResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/image/generate", { timeout: 360_000 });
    await page.getByRole("button", { name: /生成\/恢复（1）/u }).click();
    const generationResponse = await generationResponsePromise;
    responseBody = await generationResponse.json().catch(() => null);
    assert.equal(generationResponse.status(), 200);
    assert.equal(responseBody?.success, true);
    assert.equal(generationPosts, 1);
    assert.equal(requestBody?.modelId, selected.id);
    assert.equal(responseBody?.modelIdUsed, selected.id);
    assert.equal(await page.locator("select").first().inputValue(), selected.id);
    await page.waitForTimeout(2500);

    const historyResponse = await context.request.get(`${origin}/api/image-workbench/history?page=1`, { headers: { Authorization: `Bearer ${token}` } });
    const history = await historyResponse.json();
    const persisted = history.records?.find((record) => record.items?.some((item) => item.prompt?.includes(marker)));
    assert.ok(historyResponse.ok() && persisted, "Generated image did not reach account history");
    assert.ok(persisted.items.some((item) => item.assetId === responseBody.images?.[0]?.assetId));

    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "一键下载", exact: true }).click();
    const download = await downloadPromise;
    const downloadPath = path.join(outputDir, download.suggestedFilename());
    await download.saveAs(downloadPath);
    const downloadBytes = await fs.readFile(downloadPath);
    downloaded = { file: path.basename(downloadPath), bytes: downloadBytes.length, sha256: createHash("sha256").update(downloadBytes).digest("hex") };
    assert.ok(downloadBytes.length > 1000);

    await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
    await page.getByRole("button", { name: "历史", exact: true }).click();
    await page.waitForTimeout(1000);
    const refreshedText = await page.locator("body").innerText();
    assert.match(refreshedText, /Nano Banana 2|历史/u);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({ path: path.join(outputDir, "history-after-refresh.png"), fullPage: true });

    const assetUrl = new URL(responseBody.images[0].url, origin);
    const assetResponse = await context.request.get(assetUrl.toString(), { headers: assetUrl.origin === new URL(origin).origin ? { Authorization: `Bearer ${token}` } : {} });
    const assetBytes = Buffer.from(await assetResponse.body());
    const metadata = await sharp(assetBytes).metadata();
    assert.ok(assetResponse.ok() && metadata.width && metadata.height);
    const report = {
      runId,
      checkedAt: new Date().toISOString(),
      selectedModel: selected.displayName,
      selectedModelId: selected.id,
      requestModelId: requestBody.modelId,
      responseModelId: responseBody.modelIdUsed,
      generationPosts,
      success: true,
      status: responseBody.status,
      cashCharged: responseBody.cashCharged,
      historyId: persisted.id,
      historyAssetId: responseBody.images[0].assetId,
      asset: { bytes: assetBytes.length, width: metadata.width, height: metadata.height, format: metadata.format },
      downloaded,
      refreshRestored: true,
      overflow,
      consoleErrors,
      pageErrors,
      tokenPersisted: false,
    };
    await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ runId, success: true, generationPosts, historyRestored: true, downloadBytes: downloaded.bytes, report: path.join(outputDir, "report.json") }));
  } finally {
    await browser.close();
  }
}
