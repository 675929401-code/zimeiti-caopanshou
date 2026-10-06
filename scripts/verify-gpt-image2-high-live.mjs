import assert from "node:assert/strict";
import { chromium } from "playwright";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

config({ path: ".env.local", quiet: true });
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const publicModelId = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
const expectedBusinessPrice = 0.2;
const screenshotDir = path.resolve(".codex-screenshots");
const resultPath = path.resolve(".tmp-e2e/gpt-image2-pro-2k-live-result-20260815.json");
const preflightPath = path.resolve(".tmp-e2e/gpt-image2-pro-2k-cost-preflight-20260815.json");
await mkdir(screenshotDir, { recursive: true });

const dbUrl = process.env.COZE_SUPABASE_URL;
const dbKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
if (!dbUrl || !dbKey) throw new Error("Missing database configuration");
const db = createClient(dbUrl, dbKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: proRow, error: proError } = await db.from("cover_models")
  .select("id, name, model_name, api_key, selling_price, supports_image_input")
  .eq("id", "gpt-image-2-chA-1")
  .single();
if (proError || !proRow) throw proError || new Error("Pro model row unavailable");
const rawProKey = String(proRow.api_key || "");
const proKeyFingerprint = `sha256:${createHash("sha256").update(rawProKey).digest("hex").slice(0, 12)}…${rawProKey.slice(-4)}`;
assert.equal(proRow.name, "GPT-Image-2 · 渠道A pro");
assert.equal(proRow.model_name, "gpt-image-2");
assert.equal(proKeyFingerprint, "sha256:0b49a8c5f27a…yaoE");
assert.equal(proRow.supports_image_input, true);
assert.equal(Number(proRow.selling_price), expectedBusinessPrice);
await writeFile(preflightPath, `${JSON.stringify({
  recorded_at: new Date().toISOString(),
  db_model_id: proRow.id,
  public_model_id: publicModelId,
  public_display_name: proRow.name,
  payload_model: proRow.model_name,
  key_fingerprint: proKeyFingerprint,
  key_group_route: "adobe-image2-high",
  resolution: "2K",
  expected_business_price_cny: expectedBusinessPrice,
  expected_local_admin_charge_cny: 0,
  maximum_upstream_generation_submissions: 1,
  submitted: false,
}, null, 2)}\n`, "utf8");

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "Local acceptance session unavailable");
const jwt = decodeJwt(session.token);
const userId = String(jwt.userId || "");
assert.ok(userId, "Acceptance user id unavailable");
const readBilling = async () => {
  const [{ data: user, error: userError }, { count, error: countError }] = await Promise.all([
    db.from("users").select("cash_balance").eq("id", userId).single(),
    db.from("cash_transactions").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);
  if (userError) throw userError;
  if (countError) throw countError;
  return { cashBalance: Number(user.cash_balance), cashTransactions: count || 0 };
};
const billingBefore = await readBilling();

const modelsResponse = await fetch(`${baseUrl}/api/cover-models`, { headers: { Authorization: `Bearer ${session.token}` } });
const modelsPayload = await modelsResponse.json();
assert.ok(modelsResponse.ok, modelsPayload.error || "Public image models unavailable");
const target = modelsPayload.models?.find((model) => model.id === publicModelId);
assert.ok(target, "Target public model unavailable");
assert.equal(target.displayName, "GPT-Image-2 · 渠道A pro");
assert.equal(target.publicPrice, expectedBusinessPrice);
assert.deepEqual(target.capabilities?.resolutionOptions, ["1K", "2K", "4K"]);
assert.equal(target.capabilities?.supportsImageInput, true);
assert.ok(!/api_key|api_endpoint|model_name|provider|密钥|secure-skill/i.test(JSON.stringify(target)), "Public model DTO leaked internal routing details");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const browserErrors = [];
const consoleErrors = [];
let upstreamGenerationSubmissions = 0;
let publicApiRequest = null;
let publicApiResponse = null;
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
await page.route("**/api/image/generate", async (route) => {
  upstreamGenerationSubmissions += 1;
  publicApiRequest = route.request().postDataJSON();
  if (upstreamGenerationSubmissions > 1) {
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "验收门禁阻止重复上游提交" }) });
    return;
  }
  await route.continue();
});
page.on("response", async (response) => {
  if (response.url().includes("/api/image/generate") && response.request().method() === "POST") {
    publicApiResponse = await response.json().catch(() => null);
  }
});
await page.addInitScript((token) => {
  localStorage.setItem("auth_token", token);
  if (sessionStorage.getItem("gpt_image2_pro_2k_seeded") === "1") return;
  localStorage.removeItem("storyboard_prompt_workbench_current_v2");
  localStorage.removeItem("storyboard_prompt_workbench_history_v2");
  sessionStorage.setItem("gpt_image2_pro_2k_seeded", "1");
}, session.token);

let finalResult;
try {
  await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "networkidle" });
  const firstCard = page.locator(".sbw-shot-card").first();
  await firstCard.waitFor({ timeout: 30_000 });
  const modelButton = page.getByRole("button", { name: "选择生图模型：GPT-Image-2 · 渠道A pro", exact: true });
  await modelButton.click();
  const resolution = page.getByRole("combobox", { name: "图片分辨率", exact: true });
  assert.deepEqual(await resolution.locator("option").allTextContents(), ["1K", "2K", "4K"]);
  assert.equal(await resolution.inputValue(), "2K", "Pro model default resolution must be 2K");
  await resolution.selectOption("2K");
  await firstCard.getByRole("textbox", { name: "镜头1生图提示词" }).fill("一只白色陶瓷杯放在浅灰摄影台上，柔和自然光，干净商业摄影，画面中不出现文字");
  const modelText = await modelButton.innerText();
  assert.match(modelText, /GPT-Image-2 · 渠道A pro/u);
  assert.match(modelText, /¥0\.20\/张/u);
  assert.ok(!/密钥|secure-skill|adobe-image2-high/u.test(modelText), "UI leaked internal key-group routing details");
  await page.screenshot({ path: path.join(screenshotDir, "gpt-image2-pro-2k-before-20260815.png"), fullPage: true });

  await writeFile(preflightPath, `${JSON.stringify({
    recorded_at: new Date().toISOString(),
    public_model_id: publicModelId,
    public_display_name: proRow.name,
    payload_model: "gpt-image-2",
    key_fingerprint: proKeyFingerprint,
    key_group_route: "adobe-image2-high",
    resolution: "2K",
    expected_business_price_cny: expectedBusinessPrice,
    expected_local_admin_charge_cny: 0,
    maximum_upstream_generation_submissions: 1,
    submitted: true,
  }, null, 2)}\n`, "utf8");
  await firstCard.getByRole("button", { name: "生成图片" }).click();
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("storyboard_prompt_workbench_current_v2");
    if (!raw) return false;
    const card = JSON.parse(raw).cards?.[0];
    return card?.imageStatus === "done" || card?.imageStatus === "failed";
  }, null, { timeout: 420_000 });
  const run = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_current_v2") || "null"));
  const card = run?.cards?.[0];
  assert.equal(card?.imageStatus, "done", card?.imageError || "Real 2K image generation failed");
  assert.equal(run.imageModelId, publicModelId);
  assert.equal(run.imageResolution, "2K");
  assert.equal(card.imageModelIdUsed, publicModelId);
  assert.equal(card.imageModelNameUsed, "GPT-Image-2 · 渠道A pro");
  assert.ok(/^https?:\/\//u.test(card.imageUrl || ""), "Persistent image URL missing");
  assert.equal(upstreamGenerationSubmissions, 1, "Expected exactly one upstream generation submission");
  assert.equal(publicApiRequest?.modelId, publicModelId);
  assert.equal(publicApiRequest?.resolution, "2K");
  assert.equal(publicApiResponse?.modelIdUsed, publicModelId);
  assert.equal(publicApiResponse?.modelUsed, "GPT-Image-2 · 渠道A pro");
  assert.equal(publicApiResponse?.resolution, "2K");
  assert.equal(publicApiResponse?.cashCharged, 0);

  const imageResponse = await context.request.get(card.imageUrl);
  assert.ok(imageResponse.ok(), `Persistent image URL is not readable: HTTP ${imageResponse.status()}`);
  assert.match(String(imageResponse.headers()["content-type"] || ""), /^image\//u);
  const imageBytes = (await imageResponse.body()).byteLength;
  assert.ok(imageBytes > 10_000, "Returned image payload is unexpectedly small");
  await page.screenshot({ path: path.join(screenshotDir, "gpt-image2-pro-2k-success-20260815.png"), fullPage: true });

  await page.reload({ waitUntil: "networkidle" });
  const restoredImage = page.locator(".sbw-shot-card").first().locator(".sbw-image-frame img");
  await restoredImage.waitFor({ timeout: 30_000 });
  assert.equal(await restoredImage.getAttribute("src"), card.imageUrl);
  await page.getByRole("button", { name: "历史", exact: true }).click();
  const historyDrawer = page.getByRole("complementary", { name: "分镜工作台历史" });
  await historyDrawer.waitFor({ timeout: 10_000 });
  assert.match(await historyDrawer.innerText(), /图片1/u);
  await page.screenshot({ path: path.join(screenshotDir, "gpt-image2-pro-2k-history-restored-20260815.png"), fullPage: true });

  const billingAfter = await readBilling();
  assert.deepEqual(billingAfter, billingBefore, "Admin acceptance request unexpectedly changed local billing");
  finalResult = {
    result: "PASS",
    public_model_id: publicModelId,
    db_model_id: "gpt-image-2-chA-1",
    public_display_name: proRow.name,
    payload_model: "gpt-image-2",
    key_fingerprint: proKeyFingerprint,
    key_group_route: "adobe-image2-high",
    resolution: "2K",
    expected_business_price_cny: expectedBusinessPrice,
    local_admin_charge_cny: 0,
    upstream_generation_submissions: upstreamGenerationSubmissions,
    upstream_returned_url: publicApiResponse?.images?.[0]?.url || null,
    persistent_workbench_host: new URL(card.imageUrl).host,
    persistent_url_http_status: imageResponse.status(),
    persistent_url_content_type: imageResponse.headers()["content-type"] || null,
    persistent_url_bytes: imageBytes,
    response_metadata: {
      modelIdUsed: publicApiResponse?.modelIdUsed,
      modelUsed: publicApiResponse?.modelUsed,
      resolution: publicApiResponse?.resolution,
      cashCharged: publicApiResponse?.cashCharged,
    },
    history_restored_after_refresh: true,
    billing_before: billingBefore,
    billing_after: billingAfter,
    browser_errors: browserErrors,
    console_errors: consoleErrors,
    screenshots: [
      ".codex-screenshots/gpt-image2-pro-2k-before-20260815.png",
      ".codex-screenshots/gpt-image2-pro-2k-success-20260815.png",
      ".codex-screenshots/gpt-image2-pro-2k-history-restored-20260815.png",
    ],
  };
  await writeFile(resultPath, `${JSON.stringify(finalResult, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(finalResult, null, 2));
} catch (error) {
  const billingAfter = await readBilling().catch(() => null);
  finalResult = {
    result: "FAIL",
    error: error instanceof Error ? error.message : String(error),
    upstream_generation_submissions: upstreamGenerationSubmissions,
    billing_before: billingBefore,
    billing_after: billingAfter,
    public_api_response: publicApiResponse,
    browser_errors: browserErrors,
    console_errors: consoleErrors,
  };
  await page.screenshot({ path: path.join(screenshotDir, "gpt-image2-pro-2k-failed-20260815.png"), fullPage: true }).catch(() => {});
  await writeFile(resultPath, `${JSON.stringify(finalResult, null, 2)}\n`, "utf8");
  console.error(JSON.stringify(finalResult, null, 2));
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
