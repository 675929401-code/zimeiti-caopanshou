import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const targetUrl = process.env.GAODING_URL
  || "https://www.gaoding.com/contents?q=%E5%B0%81%E9%9D%A2&from=input&search_scope=gaoding";
const outputDir = path.resolve(process.env.GAODING_OUTPUT || "research-output/gaoding-public");
const scrollRounds = Number(process.env.GAODING_SCROLL_ROUNDS || 10);
const edgePath = process.env.BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

await mkdir(path.join(outputDir, "responses"), { recursive: true });

function safeName(url) {
  const parsed = new URL(url);
  const stem = `${parsed.hostname}${parsed.pathname}`.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 90);
  return `${stem}-${createHash("sha1").update(url).digest("hex").slice(0, 12)}.json`;
}

function findTemplateCandidates(value, sourceUrl, output, seen, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) findTemplateCandidates(item, sourceUrl, output, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const entries = Object.entries(value);
  const keys = new Set(entries.map(([key]) => key.toLowerCase()));
  const hasIdentity = ["id", "templateid", "template_id", "designid", "design_id", "workid"].some((key) => keys.has(key));
  const hasVisual = entries.some(([key, item]) => /cover|thumb|preview|image|url/i.test(key) && typeof item === "string" && /^https?:\/\//.test(item));
  const hasDimensions = ["width", "height", "w", "h"].some((key) => keys.has(key));
  const hasLayerHint = entries.some(([key]) => /layer|element|canvas|design|editor|material/i.test(key));

  if ((hasIdentity && hasVisual) || (hasVisual && hasDimensions) || (hasIdentity && hasLayerHint)) {
    const compact = Object.fromEntries(entries.filter(([key, item]) => {
      if (/id|title|name|width|height|size|ratio|cover|thumb|preview|image|url|type|scene|category|layer|element|canvas|design|editor|material/i.test(key)) return true;
      return typeof item === "string" && item.length < 180;
    }));
    const signature = createHash("sha1").update(JSON.stringify(compact)).digest("hex");
    if (!seen.has(signature)) {
      seen.add(signature);
      output.push({ sourceUrl, data: compact });
    }
  }

  for (const [, item] of entries) findTemplateCandidates(item, sourceUrl, output, seen, depth + 1);
}

const browser = await chromium.launch({ headless: true, executablePath: edgePath });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  locale: "zh-CN",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36",
});
const page = await context.newPage();
const responseIndex = [];
const jsonPayloads = [];

page.on("response", async (response) => {
  const url = response.url();
  if (!url.includes("gaoding.com")) return;
  const headers = response.headers();
  const contentType = headers["content-type"] || "";
  const item = { url, status: response.status(), method: response.request().method(), contentType };
  responseIndex.push(item);
  if (!/json|javascript/.test(contentType) || response.status() >= 400) return;
  try {
    const body = await response.body();
    if (!body.length || body.length > 12 * 1024 * 1024) return;
    const text = body.toString("utf8");
    if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return;
    const parsed = JSON.parse(text);
    const filename = safeName(url);
    await writeFile(path.join(outputDir, "responses", filename), JSON.stringify(parsed, null, 2), "utf8");
    jsonPayloads.push({ url, filename, parsed });
  } catch {
    // Some responses are compressed streams or JSONP and are intentionally skipped.
  }
});

try {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(5000);
  for (let index = 0; index < scrollRounds; index += 1) {
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(900);
  }

  const dom = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const images = Array.from(document.images).map((image) => ({
      src: image.currentSrc || image.src,
      alt: clean(image.alt),
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      renderedWidth: Math.round(image.getBoundingClientRect().width),
      renderedHeight: Math.round(image.getBoundingClientRect().height),
    })).filter((item) => item.src);
    const links = Array.from(document.querySelectorAll("a[href]")).map((anchor) => {
      const image = anchor.querySelector("img");
      return {
        href: anchor.href,
        text: clean(anchor.textContent).slice(0, 180),
        image: image ? image.currentSrc || image.src : "",
      };
    }).filter((item) => item.href.includes("gaoding.com") && (item.image || item.text));
    const performanceUrls = performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => url.includes("gaoding.com"));
    return {
      title: document.title,
      url: location.href,
      bodyText: clean(document.body.innerText).slice(0, 12000),
      images,
      links,
      performanceUrls,
      nextData: document.querySelector("#__NEXT_DATA__")?.textContent || "",
    };
  });

  const candidates = [];
  const seen = new Set();
  for (const payload of jsonPayloads) findTemplateCandidates(payload.parsed, payload.url, candidates, seen);
  if (dom.nextData) {
    try { findTemplateCandidates(JSON.parse(dom.nextData), "#__NEXT_DATA__", candidates, seen); } catch { /* no-op */ }
  }

  const summary = {
    capturedAt: new Date().toISOString(),
    targetUrl,
    finalUrl: dom.url,
    title: dom.title,
    responseCount: responseIndex.length,
    jsonResponseCount: jsonPayloads.length,
    imageCount: dom.images.length,
    linkCount: dom.links.length,
    candidateCount: candidates.length,
  };
  await Promise.all([
    writeFile(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8"),
    writeFile(path.join(outputDir, "responses.json"), JSON.stringify(responseIndex, null, 2), "utf8"),
    writeFile(path.join(outputDir, "dom.json"), JSON.stringify(dom, null, 2), "utf8"),
    writeFile(path.join(outputDir, "template-candidates.json"), JSON.stringify(candidates, null, 2), "utf8"),
    page.screenshot({ path: path.join(outputDir, "page.png"), fullPage: true }),
  ]);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
