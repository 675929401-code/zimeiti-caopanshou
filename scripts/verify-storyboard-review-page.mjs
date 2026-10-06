import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const targetUrl = `${baseUrl}/storyboard-workbench?review=benchmark-v41`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  const responses = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("storyboard-reviews") || response.status() >= 400) {
      responses.push({ url: response.url(), status: response.status() });
    }
  });

  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 90_000 });
  try {
    await page.waitForFunction(() => document.body.innerText.includes("异食行为警报"), null, { timeout: 30_000 });
  } catch (error) {
    const diagnostic = {
      targetUrl,
      pageUrl: page.url(),
      bodyText: (await page.locator("body").innerText()).slice(0, 5000),
      errors,
      responses,
      html: (await page.content()).slice(0, 5000),
      error: error instanceof Error ? error.message : String(error),
    };
    await page.screenshot({ path: ".tmp-e2e/storyboard-benchmark-v41-review-page-failed.png", fullPage: true });
    await writeFile(".tmp-e2e/storyboard-benchmark-v41-review-page-failed.json", JSON.stringify(diagnostic, null, 2), "utf8");
    console.log(JSON.stringify(diagnostic, null, 2));
    throw error;
  }
  const bodyText = await page.locator("body").innerText();
  assert.match(bodyText, /异食行为警报/);
  assert.match(bodyText, /1张5格故事板/);
  assert.match(bodyText, /图 已完成/);
  assert.match(bodyText, /已载入测试存档/);
  const image = page.locator('img[alt="片段1故事板"]');
  await image.waitFor({ state: "visible", timeout: 30_000 });
  const naturalSize = await image.evaluate((element) => ({ width: element.naturalWidth, height: element.naturalHeight }));
  assert.ok(naturalSize.width > 0 && naturalSize.height > 0, "历史存档成图没有加载");
  await page.screenshot({ path: ".tmp-e2e/storyboard-benchmark-v41-review-page.png", fullPage: true });

  const report = {
    passed: true,
    targetUrl,
    title: await page.title(),
    naturalSize,
    consoleErrors: errors,
    responses,
    screenshot: ".tmp-e2e/storyboard-benchmark-v41-review-page.png",
  };
  await writeFile(".tmp-e2e/storyboard-benchmark-v41-review-page.json", JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
