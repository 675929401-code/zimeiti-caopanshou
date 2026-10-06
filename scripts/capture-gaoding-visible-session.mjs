import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const outputDir = path.resolve("research-output/gaoding-interactive");
const target = process.env.GAODING_URL || "https://www.gaoding.com/contents?q=%E5%B0%81%E9%9D%A2&from=input&search_scope=gaoding";
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  executablePath: process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: "zh-CN" });
const page = await context.newPage();

try {
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90000 });
  console.log("请在临时稿定窗口中完成正常验证。窗口关闭后不会保留登录状态。");
  const deadline = Date.now() + 15 * 60 * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      text: document.body?.innerText?.slice(0, 1000) || "",
      linksWithImages: document.querySelectorAll("a[href] img").length,
    })).catch(() => ({ text: "", linksWithImages: 0 }));
    if (!/405|异常访问|访问被阻止/.test(state.text) && state.linksWithImages >= 12) {
      ready = true;
      break;
    }
    await page.waitForTimeout(1500);
  }
  if (!ready) throw new Error("等待正常模板页面超时，未采集任何模板数据");

  let previousHeight = 0;
  let stableRounds = 0;
  for (let round = 0; round < 50 && stableRounds < 6; round += 1) {
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    await page.waitForTimeout(900);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    stableRounds = height === previousHeight ? stableRounds + 1 : 0;
    previousHeight = height;
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));

  const result = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const allowed = (value) => {
      try {
        const url = new URL(value, location.href);
        return url.protocol === "https:" && (url.hostname.endsWith("gaoding.com") || url.hostname.endsWith("dancf.com"));
      } catch { return false; }
    };
    const cards = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor, index) => {
        const image = anchor.querySelector("img");
        if (!image || !allowed(anchor.href)) return null;
        const imageUrl = image.currentSrc || image.src;
        if (!allowed(imageUrl)) return null;
        const attributes = {};
        for (const element of [anchor, image]) {
          for (const attribute of element.attributes) {
            if (/^(data-|width$|height$|title$|aria-label$)/i.test(attribute.name)) {
              attributes[`${element.tagName.toLowerCase()}.${attribute.name}`] = attribute.value;
            }
          }
        }
        return {
          index,
          href: anchor.href,
          visibleText: clean(anchor.innerText || anchor.textContent).slice(0, 300),
          alt: clean(image.alt),
          imageUrl,
          thumbnailNaturalWidth: image.naturalWidth,
          thumbnailNaturalHeight: image.naturalHeight,
          renderedWidth: Math.round(anchor.getBoundingClientRect().width),
          renderedHeight: Math.round(anchor.getBoundingClientRect().height),
          attributes,
        };
      })
      .filter(Boolean)
      .filter((card, index, all) => all.findIndex((item) => item.href === card.href && item.imageUrl === card.imageUrl) === index);
    const visibleSizeLabels = Array.from(document.querySelectorAll("body *"))
      .filter((element) => element.children.length === 0 && /\b\d{2,5}\s*[×xX*]\s*\d{2,5}\b/.test(element.textContent || ""))
      .map((element) => ({ text: clean(element.textContent), nearestLink: element.closest("a[href]")?.href || "" }))
      .slice(0, 2000);
    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      page: { url: location.href, title: document.title },
      safety: { visibleDomOnly: true, cookiesRead: false, storageRead: false, requestsReplayed: false, sessionPersisted: false },
      cardCount: cards.length,
      cards,
      visibleSizeLabels,
    };
  });

  const output = path.join(outputDir, `visible-templates-${Date.now()}.json`);
  await writeFile(output, JSON.stringify(result, null, 2), "utf8");
  await page.screenshot({ path: path.join(outputDir, "captured-page.png"), fullPage: true });
  console.log(JSON.stringify({ ok: true, cards: result.cardCount, sizeLabels: result.visibleSizeLabels.length, output }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
