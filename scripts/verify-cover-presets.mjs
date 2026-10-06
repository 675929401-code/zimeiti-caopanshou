import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const outputDir = path.resolve(".codex-evidence", "cover-presets");
const output = path.join(outputDir, "cover-presets-live.png");
const libraryOutput = path.join(outputDir, "cover-presets-library-live.png");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();

async function closeWithTimeout(closeable, label, timeoutMs = 3_000) {
  let timer;
  await Promise.race([
    closeable.close().catch((error) => {
      console.error(`[cover-presets] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.error(`[cover-presets] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
if (token) {
  await context.addInitScript((authToken) => localStorage.setItem("auth_token", authToken), token);
}
const page = await context.newPage();
const errors = [];
const paidRequests = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const pathname = new URL(request.url()).pathname;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && /\/(?:generate|image-generation|video-generation|llm|chat|cover\/attempt|cover\/render)(?:\/|$)/iu.test(pathname)) {
    paidRequests.push(pathname);
  }
});

try {
  const response = await page.goto(`${baseUrl}/cover?template-library-check=1`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "封面工作台应返回 200");
  await page.locator('.cover-rebuild-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole("button", { name: /^参考模板/u }).click();
  await page.locator('.cover-reference-dock').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('button', { name: '浏览模板库', exact: true }).click();
  const templateList = page.locator('.cover-template-library-grid');
  await templateList.waitFor({ state: "visible", timeout: 30_000 });
  const options = templateList.locator('.cover-template-library-option');
  const cards = await options.count();
  assert.ok(cards >= 2, `当前模板预设数量不足：${cards}`);
  const firstName = (await options.first().innerText()).trim();
  await page.waitForFunction(() => [...document.querySelectorAll('.cover-template-library-option > img')]
    .every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0));
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.cover-template-library-dialog');
    const entrance = dialog?.getAnimations()[0];
    return !entrance || entrance.playState === 'finished';
  });
  const imageStyles = await page.locator('.cover-template-library-option > img').evaluateAll((images) => images.map((image) => ({
    objectFit: getComputedStyle(image).objectFit,
    width: image.getBoundingClientRect().width,
    height: image.getBoundingClientRect().height,
  })));
  assert.ok(imageStyles.every((image) => image.objectFit === 'contain' && image.width > 0 && image.height > 0), '模板示例必须完整展示且不能裁切');
  const dialogBox = await page.locator('.cover-template-library-dialog').boundingBox();
  assert.ok(dialogBox && dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= 1601 && dialogBox.y + dialogBox.height <= 1001, '模板库必须完整位于桌面视口内');
  await page.screenshot({ path: libraryOutput, fullPage: false });
  await options.nth(1).click();
  const templatePreview = page.locator('.cover-template-preview-dialog');
  await templatePreview.waitFor({ state: 'visible' });
  await templatePreview.getByRole('button', { name: '使用此模板', exact: true }).click();
  await page.locator('.cover-template-library-dialog').waitFor({ state: 'hidden' });
  const selectedName = (await page.locator('.cover-reference-dock strong').first().textContent())?.trim() || '';
  assert.ok(selectedName && !firstName.startsWith(selectedName), '模板选择应更新当前参考摘要');
  const textField = page.getByRole("textbox", { name: "输入文案" });
  assert.equal(await textField.count(), 1, "封面文案输入框缺失");
  assert.equal(await page.getByRole('img', { name: /任务.+封面结果/u }).count(), 0, '模板验收不得伪造生成结果');
  await page.screenshot({ path: output, fullPage: false });
  assert.deepEqual(errors, [], "封面预设验收不应出现浏览器错误");
  assert.deepEqual(paidRequests, [], "封面预设零费用验收不得提交生成任务");
  console.log(JSON.stringify({ ok: true, cards, firstName, selectedName, paidRequests, errors, output, libraryOutput, imageStyles }, null, 2));
} finally {
  await closeWithTimeout(context, "context.close");
  await closeWithTimeout(browser, "browser.close");
}
process.exit(0);
