import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const evidenceDir = path.resolve(process.env.C210_THEME_EVIDENCE_DIR || ".codex-evidence/c210-theme-browser");
await mkdir(evidenceDir, { recursive: true });

const fakeAgents = Array.from({ length: 8 }, (_, index) => ({
  id: `c210-theme-agent-${index + 1}`,
  bot_id: `c210-theme-agent-${index + 1}`,
  bot_name: ["商业IP定位", "账号主页包装", "短视频文案成稿", "咨询回复与跟进", "运营数据复盘", "3D故事导演", "文案质量专家", "故事脚本架构"][index],
  name: `C210 验收智能体 ${index + 1}`,
  description: "用于主题层次与卡片布局的隔离浏览器样本，不触发智能体调用。",
  category: index < 4 ? "商业定位IP" : "文案创作",
  icon_url: "",
  is_active: true,
  user_access: "available",
  sort_order: index,
}));

const browser = await chromium.launch({ headless: true });
const errors = [];
const providerCalls = [];

async function openFixturePage(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "GET" && /\/api\/(image|video|llm|cover\/render|cover\/attempt|payment)/u.test(pathname)) providerCalls.push(`${request.method()} ${pathname}`);
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) return route.abort("blockedbyclient");
    if (url.pathname.startsWith("/api/")) {
      if (request.method() !== "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, records: [] }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [], projects: [], models: [], assets: [], tasks: [], agents: [], categories: [] }) });
    }
    if (request.method() !== "GET") return route.abort("blockedbyclient");
    return route.continue();
  });
  await installStoryboardBrowserFixture(page, { origin: baseUrl, resetStorage: true });
  await page.route("**/api/bots*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agents: fakeAgents, navigationKeys: ["bip:loop", "task:影像编导", "task:文案创作", "task:获客转化", "自用"] }) }));
  await page.route("**/api/member-permissions**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ permission: { userId: "storyboard-browser-fixture-user", role: "admin", featureNavigationKeys: ["marketplace", "toolbox", "storyboard_workbench", "image_workbench", "create", "voice", "cover", "youcai", "commerce_agent"], agentNavigationKeys: fakeAgents.map((agent) => agent.bot_id), revision: 1, checksum: "c210-theme-fixture", integrityValid: true, authorityStatus: "admin" } }) }));
  await page.route("**/api/categories", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [] }) }));
  await page.addInitScript(() => {
    const applyTheme = () => {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute("data-theme-selection", "crystal-aurora");
      root.setAttribute("data-theme", "crystal-aurora");
      root.setAttribute("data-mode", "dark");
    };
    if (document.documentElement) applyTheme();
    else document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
  });
  return { context, page };
}

async function forceCrystal(page) {
  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme-selection", "crystal-aurora");
    root.setAttribute("data-theme", "crystal-aurora");
    root.setAttribute("data-mode", "dark");
  });
  await page.waitForTimeout(80);
}

const root = await openFixturePage({ width: 1880, height: 1000 });
await root.page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
await forceCrystal(root.page);
await root.page.locator(".marketplace-shell").waitFor({ timeout: 30_000 });
await root.page.locator(".agent-card-hover").first().waitFor({ timeout: 30_000 });
await forceCrystal(root.page);
assert.equal(await root.page.locator(".agent-card-hover").count(), 8, "应用广场隔离样本应渲染八张智能体卡片");
const cardStyle = await root.page.locator(".agent-card-hover").first().evaluate((node) => {
  const style = getComputedStyle(node);
  const avatar = node.querySelector(".marketplace-agent-avatar");
  const avatarStyle = avatar ? getComputedStyle(avatar) : null;
  return { background: style.backgroundImage, borderColor: style.borderColor, height: style.height, avatarBorder: avatarStyle?.borderColor || "" };
});
assert.ok(cardStyle.height !== "0px", "应用广场卡片没有有效高度");
const shortcutGeometry = await root.page.evaluate(() => [...document.querySelectorAll(".sidebar-shortcut-grid > :is(.sidebar-tool-card, .toolbox-trigger-sidebar)")].map((element) => {
  const rect = element.getBoundingClientRect();
  return { height: rect.height, top: rect.top, bottom: rect.bottom };
}));
assert.ok(shortcutGeometry.length >= 3, "快捷导航没有渲染足够的入口");
assert.ok(new Set(shortcutGeometry.map((item) => Math.round(item.height))).size === 1, "快捷工具按钮高度没有对齐");
await root.page.screenshot({ path: path.join(evidenceDir, "marketplace-crystal-1880.png"), fullPage: true });

const storyboard = await openFixturePage({ width: 1440, height: 1000 });
await storyboard.page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
await forceCrystal(storyboard.page);
await storyboard.page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
await forceCrystal(storyboard.page);
assert.equal(await storyboard.page.locator(".sbw-shot-card").count(), 3, "分镜工作台默认卡片数发生变化");
const storyboardStyle = await storyboard.page.locator(".sbw-shot-card").first().evaluate((node) => {
  const style = getComputedStyle(node);
  const media = node.querySelector(".sbw-image-frame");
  const mediaStyle = media ? getComputedStyle(media) : null;
  return { background: style.backgroundImage, borderColor: style.borderColor, mediaRadius: mediaStyle?.borderRadius || "" };
});
assert.equal(await storyboard.page.locator(".sbw-shot-grid").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length), 3);
await storyboard.page.screenshot({ path: path.join(evidenceDir, "storyboard-crystal-1440.png"), fullPage: true });

const image = await openFixturePage({ width: 1440, height: 1000 });
await image.page.goto(`${baseUrl}/image-workbench`, { waitUntil: "domcontentloaded" });
await forceCrystal(image.page);
await image.page.locator(".voice-studio-root.vs-workbench").first().waitFor({ timeout: 30_000 });
await forceCrystal(image.page);
assert.equal(await image.page.locator(".voice-studio-root.vs-workbench").count(), 1, "AI生图工作台没有使用统一生成页桥接类");
await image.page.screenshot({ path: path.join(evidenceDir, "image-workbench-crystal-1440.png"), fullPage: true });

const tools = await openFixturePage({ width: 1440, height: 1000 });
await tools.page.goto(`${baseUrl}/tools`, { waitUntil: "domcontentloaded" });
await forceCrystal(tools.page);
await tools.page.locator('[data-page="tools"]').waitFor({ timeout: 30_000 });
await forceCrystal(tools.page);
await tools.page.screenshot({ path: path.join(evidenceDir, "tools-crystal-1440.png"), fullPage: true });

for (const fixture of [root, storyboard, image, tools]) await fixture.context.close();
await browser.close();
assert.deepEqual(errors, [], `页面错误：${errors.join(" | ")}`);
assert.deepEqual(providerCalls, [], `出现了不允许的 provider 请求：${providerCalls.join(" | ")}`);
console.log(JSON.stringify({ passed: true, routes: ["/", "/storyboard-workbench", "/image-workbench", "/tools"], cardCount: 8, storyboardCards: 3, shortcutHeights: [...new Set(shortcutGeometry.map((item) => Math.round(item.height)))], cardStyle, storyboardStyle, pageErrors: 0, providerCalls: 0, screenshots: ["marketplace-crystal-1880.png", "storyboard-crystal-1440.png", "image-workbench-crystal-1440.png", "tools-crystal-1440.png"] }, null, 2));
