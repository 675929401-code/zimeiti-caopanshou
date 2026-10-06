import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const evidenceDir = path.join(root, ".codex-evidence/inspiration-media-audit-20260823");
mkdirSync(evidenceDir, { recursive: true });

async function main() {
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });

try {
  const initialResponse = page.waitForResponse((response) => response.url().includes("/api/inspiration?") && response.ok(), { timeout: 30_000 });
  await page.goto("https://youcai.art/inspiration", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await initialResponse;
  await page.locator("div.group.relative").first().waitFor({ state: "visible", timeout: 30_000 });

  const categories = ["全部分类", "👤 角色", "🏞️ 场景", "💍 道具", "🎨 风格", "🎬 分镜", "🎞️ 成片", "🎵 音乐", "🎙️ 语音", "🎧 音频", "🔊 音效", "🖼️ 图片", "🎥 视频", "📁 其他"];
  const categoryVisibility = Object.fromEntries(await Promise.all(categories.map(async (label) => [
    label,
    await page.getByRole("button", { name: label, exact: true }).count(),
  ])));

  const audioResponse = page.waitForResponse((response) => response.url().includes("/api/inspiration?") && response.url().includes("type=audio") && response.ok());
  await page.getByRole("button", { name: "音频", exact: true }).first().click();
  await audioResponse;
  await page.locator("div.group.relative").first().waitFor({ state: "visible" });
  const audioCards = await page.locator("div.group.relative").count();
  await page.screenshot({ path: path.join(evidenceDir, "official-audio-filter-1440.png"), fullPage: true });
  await page.locator("div.group.relative").first().click();
  await page.locator("audio[controls]").waitFor({ state: "visible", timeout: 10_000 });
  const audioDetail = {
    player: await page.locator("audio[controls]").count(),
    promptPanel: await page.getByText("创作提示词", { exact: true }).count(),
    copyButton: await page.getByRole("button", { name: /复制/ }).count(),
  };
  await page.locator("div.fixed.inset-0").click({ position: { x: 2, y: 2 } });

  const videoResponse = page.waitForResponse((response) => response.url().includes("/api/inspiration?") && response.url().includes("type=video") && response.ok());
  await page.getByRole("button", { name: "视频", exact: true }).first().click();
  await videoResponse;
  await page.locator("div.group.relative").first().waitFor({ state: "visible" });
  const videoCards = await page.locator("div.group.relative").count();
  const videoPreviews = await page.locator("div.group.relative video").count();
  await page.screenshot({ path: path.join(evidenceDir, "official-video-filter-1440.png"), fullPage: true });
  await page.locator("div.group.relative").first().click();
  await page.locator("video[controls]").waitFor({ state: "visible", timeout: 10_000 });
  const videoDetail = {
    player: await page.locator("video[controls]").count(),
    promptPanel: await page.getByText("创作提示词", { exact: true }).count(),
  };

  console.log(JSON.stringify({
    ok: true,
    categoryVisibility,
    sortLatest: await page.getByRole("button", { name: /最新/ }).count(),
    sortPopular: await page.getByRole("button", { name: /最热/ }).count(),
    audioCards,
    audioDetail,
    videoCards,
    videoPreviews,
    videoDetail,
  }, null, 2));
} finally {
  await browser.close();
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
