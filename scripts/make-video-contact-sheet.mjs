import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const inputDir = path.resolve(process.env.FRAME_DIR || "");
const outputPath = path.resolve(process.env.OUTPUT_PATH || path.join(inputDir, "contact-sheet.png"));
assert.ok(process.env.FRAME_DIR, "FRAME_DIR is required");
const files = (await readdir(inputDir)).filter((name) => name.endsWith(".png")).sort().slice(0, 16);
assert.equal(files.length, 16, `expected 16 frames, got ${files.length}`);
const cells = files.map((name) => `<figure><img src="${pathToFileURL(path.join(inputDir, name)).href}"><figcaption>${name.replace(/^\d+-/, "")}</figcaption></figure>`).join("");
const htmlPath = path.join(inputDir, "contact-sheet.html");
await writeFile(htmlPath, `<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#111;color:#fff;font:18px Arial}.grid{display:grid;grid-template-columns:repeat(4,480px);gap:6px;padding:6px}figure{margin:0;background:#222}img{display:block;width:480px;height:270px;object-fit:cover}figcaption{height:30px;padding:4px 8px}</style><div class="grid">${cells}</div>`, "utf8");
const browser = await chromium.launch({ headless: true, args: ["--allow-file-access-from-files"] });
try {
  const page = await browser.newPage({ viewport: { width: 1944, height: 1230 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(JSON.stringify({ inputDir, outputPath, frames: files }, null, 2));
} finally {
  await browser.close();
}
