import assert from "node:assert/strict";
import { chromium } from "playwright";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import COS from "cos-nodejs-sdk-v5";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

config({ path: ".env.local", quiet: true });
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const publicModelId = "pm_takE97o_QD3mnl65r8uLsnza";
const generationResultPath = path.resolve(".tmp-e2e/gpt-image2-high-live-result-20260815.json");
const resultPath = path.resolve(".tmp-e2e/gpt-image2-high-recovery-result-20260815.json");
const originalResult = JSON.parse(await readFile(generationResultPath, "utf8"));
assert.equal(originalResult.upstream_generation_submissions, 1);
assert.equal(originalResult.public_api_response?.success, true);

const dbUrl = process.env.COZE_SUPABASE_URL;
const dbKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
if (!dbUrl || !dbKey) throw new Error("Missing database configuration");
const db = createClient(dbUrl, dbKey, { auth: { persistSession: false, autoRefreshToken: false } });
const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "Local acceptance session unavailable");

const filesResponse = await fetch(`${baseUrl}/api/storage/files?category=image&limit=20`, {
  headers: { Authorization: `Bearer ${session.token}` },
});
const filesPayload = await filesResponse.json();
assert.ok(filesResponse.ok, filesPayload.error || "Stored image metadata unavailable");
const file = filesPayload.files?.find((item) => item.source === "image-workbench" && item.storage_provider === "tencent_cos");
assert.ok(file?.storage_key, "Persisted image object from the successful run was not found");

const bucket = process.env.COS_BUCKET;
const region = process.env.COS_REGION;
const secretId = process.env.COS_SECRET_ID;
const secretKey = process.env.COS_SECRET_KEY;
if (!bucket || !region || !secretId || !secretKey) throw new Error("COS runtime configuration unavailable");
const cos = new COS({ SecretId: secretId, SecretKey: secretKey });
const persistentUrl = await new Promise((resolve, reject) => {
  cos.getObjectUrl({ Bucket: bucket, Region: region, Key: file.storage_key, Sign: true, Expires: 30 * 24 * 60 * 60 }, (error, data) => {
    if (error) reject(error);
    else resolve(data.Url);
  });
});
const imageResponse = await fetch(persistentUrl);
assert.ok(imageResponse.ok, `Persisted COS image is unavailable: HTTP ${imageResponse.status}`);
assert.match(String(imageResponse.headers.get("content-type") || ""), /^image\//u);
const imageBytes = (await imageResponse.arrayBuffer()).byteLength;
assert.ok(imageBytes > 10_000);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const browserErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
await page.addInitScript(({ token, modelId, imageUrl }) => {
  localStorage.setItem("auth_token", token);
  if (sessionStorage.getItem("gpt_image2_high_recovery_seeded") === "1") return;
  const now = Date.now();
  const run = {
    id: `gpt-image2-high-recovery-${now}`,
    createdAt: now,
    updatedAt: now,
    ratio: "16:9",
    imageResolution: "1K",
    videoResolution: "1080p",
    videoDuration: 10,
    imageModelId: modelId,
    videoModelId: "",
    title: "GPT Image A · E密钥高质量组 · 1K真实验收",
    cards: [{
      id: `gpt-image2-high-card-${now}`,
      order: 1,
      imagePrompt: "一只白色陶瓷杯放在浅灰摄影台上，柔和自然光，干净商业摄影，画面中不出现文字",
      videoPrompt: "",
      referenceImageUrls: [],
      imageStatus: "done",
      imageUrl,
      imageValidatedAt: now,
      imageModelIdUsed: modelId,
      imageModelNameUsed: "GPT Image A",
      videoStatus: "idle",
    }],
  };
  localStorage.setItem("storyboard_prompt_workbench_current_v2", JSON.stringify(run));
  localStorage.setItem("storyboard_prompt_workbench_history_v2", JSON.stringify([run]));
  sessionStorage.setItem("gpt_image2_high_recovery_seeded", "1");
}, { token: session.token, modelId: publicModelId, imageUrl: persistentUrl });

try {
  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "networkidle" });
  await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
  await page.reload({ waitUntil: "networkidle" });
  const restoredImage = page.locator(".sbw-shot-card").first().locator(".sbw-image-frame img");
  await restoredImage.waitFor({ timeout: 30_000 });
  assert.equal(await restoredImage.getAttribute("src"), persistentUrl);
  const runAfterRefresh = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_current_v2") || "null"));
  assert.equal(runAfterRefresh.imageModelId, publicModelId);
  assert.equal(runAfterRefresh.imageResolution, "1K");
  assert.equal(runAfterRefresh.cards?.[0]?.imageModelIdUsed, publicModelId);
  assert.equal(runAfterRefresh.cards?.[0]?.imageModelNameUsed, "GPT Image A");
  assert.equal(runAfterRefresh.cards?.[0]?.imageStatus, "done");

  await page.getByRole("button", { name: "历史", exact: true }).click();
  const historyDrawer = page.getByRole("complementary", { name: "分镜工作台历史" });
  await historyDrawer.waitFor({ timeout: 10_000 });
  const historyText = await historyDrawer.innerText();
  assert.match(historyText, /GPT Image A · E密钥高质量组 · 1K真实验收/u);
  assert.match(historyText, /图片1/u);
  await historyDrawer.getByRole("button", { name: "恢复", exact: true }).first().click();
  await page.locator(".sbw-shot-card").first().locator(".sbw-image-frame img").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: path.resolve(".codex-screenshots/gpt-image2-high-1k-history-restored-20260815.png"), fullPage: true });

  const result = {
    result: "PASS",
    additional_upstream_generation_submissions: 0,
    public_model_id: publicModelId,
    storage_key: file.storage_key,
    storage_provider: file.storage_provider,
    upstream_success_url: originalResult.public_api_response?.images?.[0]?.url || null,
    persistent_workbench_host: new URL(persistentUrl).host,
    persistent_url_http_status: imageResponse.status,
    persistent_url_content_type: imageResponse.headers.get("content-type"),
    persistent_url_bytes: imageBytes,
    refresh_restored: true,
    history_restored: true,
    browser_errors: browserErrors,
    console_errors: consoleErrors,
    screenshot: ".codex-screenshots/gpt-image2-high-1k-history-restored-20260815.png",
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close();
  await browser.close();
}
