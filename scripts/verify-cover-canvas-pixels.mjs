import assert from "node:assert/strict";
import { chromium } from "playwright";

async function closeWithTimeout(closeable, label, timeoutMs = 3_000) {
  let timer;
  await Promise.race([
    closeable.close().catch((error) => {
      console.error(`[cover-canvas-pixels] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.error(`[cover-canvas-pixels] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const failures = [];
page.on("response", (response) => {
  if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
});
const response = await page.goto("http://127.0.0.1:5000/cover?canvas-pixel-check=1", { waitUntil: "networkidle" });
assert.equal(response?.status(), 200, "封面工作台应返回 200");
await page.getByRole("button", { name: /载入真实样张/u }).click();
const resultImage = page.getByRole("img", { name: /任务.+封面结果/u });
await resultImage.waitFor({ state: "visible" });
await page.waitForFunction(() => {
  const image = document.querySelector('img[alt*="封面结果"]');
  return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
});
const rendered = await resultImage.evaluate((element) => {
  const image = element;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context?.drawImage(image, 0, 0);
  const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
  let colored = 0;
  let visible = 0;
  if (pixels) {
    for (let index = 0; index < pixels.length; index += 160) {
      if (pixels[index + 3] > 0) visible += 1;
      if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) colored += 1;
    }
  }
  return {
    src: image.currentSrc || image.src,
    width: image.naturalWidth,
    height: image.naturalHeight,
    visible,
    colored,
    dataUrlLength: canvas.toDataURL("image/png").length,
  };
});
assert.ok(rendered.width > 0 && rendered.height > 0, "封面真实样张没有可解码尺寸");
assert.ok(rendered.visible > 0 && rendered.colored > 0 && rendered.dataUrlLength > 1_000, "封面真实样张没有渲染出可交付像素");
assert.deepEqual(failures, [], `封面页面存在失败请求：${failures.join(" | ")}`);
console.log(JSON.stringify({ ok: true, rendered, failures }));
await closeWithTimeout(browser, "browser.close");
process.exit(0);
