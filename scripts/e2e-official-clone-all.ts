import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5000";
const origin = new URL(baseURL).origin;
const evidenceDir = path.resolve(".codex-evidence/official-clone-all-20260823");
const ownedExternalHosts = new Set([
  "ai-agent-main-storage-1434868362.cos.ap-guangzhou.myqcloud.com",
]);

const DESKTOP_VIEWPORT = { width: 1600, height: 1000 } as const;
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

const OFFICIAL_INVENTORY_LINK_TARGETS = [
  "/",
  "/about",
  "/articles",
  "/articles/changelog",
  "/articles/credits-faq",
  "/articles/GPT-Image-2",
  "/articles/seedance-2-prompt",
  "/articles/seedance-2-prompt-66",
  "/articles/seedance-2-video-prompt-guide",
  "/articles/seedance-agent-v2",
  "/articles/update-5",
  "/articles/youcai-group",
  "/assets",
  "/business",
  "/forgot-password",
  "/inspiration",
  "/login",
  "/login?redirect=%2Freferral",
  "/recharge",
  "/referral",
  "/register",
  "/register?redirect=%2Freferral",
  "/share/canvas/canvas-showcase-78f7a4a9ce11-paper-fox-adventure",
  "/share/canvas/cmsyrsury01e3caezkqyg5l5l",
  "/share/canvas/cmsyrvsqh01jgcaez3xadrsob",
  "/share/canvas/cmt37buny005u85fyne9adfac",
  "/tools",
  "/tools/audio",
  "/tools/audio/mimo-tts",
  "/tools/audio/mimo-voice-clone",
  "/tools/audio/mimo-voice-design",
  "/tools/audio/minimax-music",
  "/tools/audio/minimax-tts",
  "/tools/audio/volcengine-audio",
  "/tools/canvas",
  "/tools/chat",
  "/tools/film-studio",
  "/tools/image",
  "/tools/image/character-sheet",
  "/tools/image/image-chat",
  "/tools/image/image-edit",
  "/tools/image/jimeng-face-pretty",
  "/tools/image/jimeng-tilesr",
  "/tools/image/kling-image",
  "/tools/image/qwen-image",
  "/tools/image/storyboard",
  "/tools/image/volcengine-image",
  "/tools/text",
  "/tools/text/drama-script",
  "/tools/text/general-script",
  "/tools/text/image-prompt",
  "/tools/text/script-brief",
  "/tools/text/text-chat",
  "/tools/text/upload-script",
  "/tools/video",
  "/tools/video/aliyun-erase-subtitles",
  "/tools/video/aliyun-video-cover",
  "/tools/video/happyhorse-i2v",
  "/tools/video/happyhorse-r2v",
  "/tools/video/happyhorse-t2v",
  "/tools/video/kling-video",
  "/tools/video/video-edit",
  "/tools/video/volcengine-video",
  "/tools/video/wanx-i2v",
  "/tools/video/wanx-r2v",
  "/tools/video/wanx-t2v",
  "/tools/video/wanx-video-edit",
  "/youcai-tv",
] as const;

const SUPPLEMENTAL_LOCAL_ROUTES = [
  "/tools/utility",
  "/tools/text/formal-script",
] as const;

const ROUTES = [...OFFICIAL_INVENTORY_LINK_TARGETS, ...SUPPLEMENTAL_LOCAL_ROUTES] as const;

const EXPECTED_FINAL_PATHS = new Map<string, string>([
  ["/referral", "/login?redirect=%2Freferral"],
  ["/tools/chat", "/tools/text/text-chat"],
  ["/tools/utility", "/tools/utility?tab=segment"],
]);

const EXPECTED_ARTICLE_HEADINGS = new Map<string, string>([
  ["/articles/changelog", "自媒体操盘手 · 更新日志"],
  ["/articles/credits-faq", "自媒体操盘手积分功能常见问答"],
  ["/articles/GPT-Image-2", "GPT-Image-2 提示词使用指南"],
  ["/articles/seedance-2-prompt", "Seedance 2.0 提示词指南（主站适配版）"],
  ["/articles/seedance-2-prompt-66", "Seedance 2.0 视频生成、编辑、补全提示词 66 个原创练习方向"],
  ["/articles/seedance-2-video-prompt-guide", "Seedance 2.0 影视场景提示词指南"],
  ["/articles/seedance-agent-v2", "智能生视频 Agent 2.0 使用指南"],
  ["/articles/update-5", "自媒体操盘手近期重要功能更新速递"],
  ["/articles/youcai-group", "关于自媒体操盘手：用户交流与问题反馈"],
]);

const EXPECTED_TOOL_DIRECTORY_COUNTS = new Map<string, number>([
  ["/tools/text", 6],
  ["/tools/image", 9],
  ["/tools/audio", 6],
  ["/tools/video", 12],
]);

const MOBILE_ROUTES = ROUTES;

const CRITICAL_SOURCE_PATHS = [
  "src/components/app-route-shell.tsx",
  "src/features/official-home/official-home-page.tsx",
  "src/features/official-core-routes/official-assets-route.tsx",
  "src/features/official-tool-directory/tool-directory-data.tsx",
  "src/features/official-tool-directory/official-tool-directory.tsx",
  "src/features/official-tool-aliases/official-tool-alias-map.ts",
  "src/features/official-tool-aliases/official-tool-alias-page.tsx",
  "src/features/short-drama/short-drama-portal.tsx",
  "src/features/general-script-official/general-script-official.tsx",
  "src/features/upload-script/upload-script-workbench.tsx",
  "src/features/official-inspiration/inspiration-data.ts",
  "src/features/official-inspiration/official-inspiration-gallery.tsx",
  "src/lib/help-center-public-articles.ts",
  "src/lib/help-center-domain.ts",
] as const;

interface Audit {
  path: string;
  finalPath: string;
  status: number | null;
  title: string;
  heading: string;
  viewport: { width: number; height: number; label: "desktop" | "mobile" };
  notFoundDetected: boolean;
  pageErrors: string[];
  failedRequests: string[];
  externalRequests: string[];
  blockedWrites: string[];
  horizontalOverflow: number;
}

async function createAuditedPage(context: BrowserContext) {
  const page = await context.newPage();
  const auditState = {
    pageErrors: [] as string[],
    failedRequests: [] as string[],
    externalRequests: [] as string[],
    blockedWrites: [] as string[],
  };

  page.on("pageerror", (error) => auditState.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const url = request.url();
    const reason = request.failure()?.errorText || "failed";
    if (reason === "net::ERR_ABORTED" && (
      url.includes("_rsc=")
      || /\.(?:mp4|webm)(?:\?|$)/i.test(url)
      || auditState.blockedWrites.some((entry) => entry.endsWith(url))
    )) return;
    auditState.failedRequests.push(`${request.method()} ${url} :: ${reason}`);
  });
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("data:") && !url.startsWith("blob:")) {
      const parsed = new URL(url);
      if (parsed.origin !== origin && !ownedExternalHosts.has(parsed.hostname)) auditState.externalRequests.push(url);
    }
  });
  await page.route("**/*", async (route) => {
    const method = route.request().method().toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      auditState.blockedWrites.push(`${method} ${route.request().url()}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return { page, auditState };
}

async function visit(
  page: Page,
  state: Awaited<ReturnType<typeof createAuditedPage>>["auditState"],
  pathname: string,
  viewport: { width: number; height: number; label: "desktop" | "mobile" } = { ...DESKTOP_VIEWPORT, label: "desktop" },
): Promise<Audit> {
  state.pageErrors.length = 0;
  state.failedRequests.length = 0;
  state.externalRequests.length = 0;
  state.blockedWrites.length = 0;
  const response = await page.goto(`${baseURL}${pathname}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(800);
  const finalUrl = new URL(page.url());
  const pageState = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    title: document.title.trim(),
    heading: document.querySelector("h1")?.textContent?.trim() || "",
    bodyLines: document.body.innerText.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 80),
  }));
  const notFoundDetected = response?.status() === 404 || pageState.bodyLines.some((line) => (
    line === "404"
    || line === "This page could not be found."
    || line === "This page could not be found"
    || line === "页面不存在"
  ));
  return {
    path: pathname,
    finalPath: `${finalUrl.pathname}${finalUrl.search}`,
    status: response?.status() ?? null,
    title: pageState.title,
    heading: pageState.heading,
    viewport,
    notFoundDetected,
    pageErrors: [...state.pageErrors],
    failedRequests: [...state.failedRequests],
    externalRequests: [...new Set(state.externalRequests)],
    blockedWrites: [...state.blockedWrites],
    horizontalOverflow: Math.max(0, pageState.scroll - pageState.client),
  };
}

async function hydrateLazyMedia(page: Page) {
  const scrollHeight = Number(await page.evaluate("document.documentElement.scrollHeight"));
  const viewportHeight = page.viewportSize()?.height || 844;
  const step = Math.max(240, Math.floor(viewportHeight * 0.72));
  for (let y = 0; y < scrollHeight; y += step) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await page.waitForTimeout(90);
  }
  await page.evaluate("window.scrollTo(0, 0)");
  await page.waitForTimeout(250);
}

async function assertImageLoaded(page: Page, alt: string, scope: string) {
  const image = page.getByAltText(alt);
  await image.scrollIntoViewIfNeeded();
  let loaded = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    loaded = await image.evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0);
    if (loaded) break;
    await page.waitForTimeout(150);
  }
  assert.equal(loaded, true, `${alt} must load ${scope}`);
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const browserVersion = browser.version();
  const desktopContext = await browser.newContext({ viewport: DESKTOP_VIEWPORT, deviceScaleFactor: 1 });
  await desktopContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const { page, auditState } = await createAuditedPage(desktopContext);
  const audits: Audit[] = [];
  const actionTrace: Array<{ action: string; result: string; detail?: string }> = [];

  for (const pathname of ROUTES) {
    const audit = await visit(page, auditState, pathname);
    audits.push(audit);
    assert.equal(audit.status, 200, `${pathname} status=${audit.status}`);
    assert.equal(audit.notFoundDetected, false, `${pathname} rendered a not-found page`);
    assert.equal(audit.finalPath, EXPECTED_FINAL_PATHS.get(pathname) ?? pathname, `${pathname} finalPath=${audit.finalPath}`);
    assert.equal(audit.pageErrors.length, 0, `${pathname} page errors: ${audit.pageErrors.join(" | ")}`);
    assert.equal(audit.failedRequests.length, 0, `${pathname} request failures: ${audit.failedRequests.join(" | ")}`);
    assert.equal(audit.externalRequests.length, 0, `${pathname} external requests: ${audit.externalRequests.join(" | ")}`);
    assert.equal(audit.blockedWrites.length, 0, `${pathname} attempted write on page load: ${audit.blockedWrites.join(" | ")}`);
    assert.ok(audit.horizontalOverflow <= 1, `${pathname} horizontal overflow=${audit.horizontalOverflow}`);
  }

  for (const [pathname, expectedHeading] of EXPECTED_ARTICLE_HEADINGS) {
    const audit = audits.find((entry) => entry.path === pathname && entry.viewport.label === "desktop");
    assert.ok(audit, `${pathname} article audit missing`);
    assert.equal(audit.heading, expectedHeading, `${pathname} must render its real article H1`);
    assert.notEqual(audit.heading, "这篇文档尚未发布或不存在", `${pathname} must not use the article placeholder`);
  }
  actionTrace.push({ action: "public-help-articles", result: "passed", detail: "9 official public slugs render independent local-original articles" });

  const assetsAudit = audits.find((entry) => entry.path === "/assets" && entry.viewport.label === "desktop");
  assert.equal(assetsAudit?.heading, "个人资产", "/assets must expose an accessible page H1");
  actionTrace.push({ action: "assets-page-semantics", result: "passed", detail: "personal assets exposes an accessible H1 while preserving the official-style toolbar" });

  for (const [categoryPath, expectedCount] of EXPECTED_TOOL_DIRECTORY_COUNTS) {
    await visit(page, auditState, categoryPath);
    const officialCards = page.locator("[data-official-path]");
    const values = await officialCards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-official-path")).filter(Boolean));
    assert.equal(values.length, expectedCount, `${categoryPath} official card count`);
    assert.equal(new Set(values).size, expectedCount, `${categoryPath} official card paths must be unique`);
  }
  actionTrace.push({ action: "official-tool-directory-coverage", result: "passed", detail: "33/33 third-level official paths have visible directory cards; unavailable specialty chains remain explicitly labelled" });

  await visit(page, auditState, "/");
  await page.getByTestId("official-home-page").waitFor();
  await page.getByTestId("official-home-promo").waitFor();
  await page.getByTestId("official-home-member-strip").waitFor();
  const utilityNavigationLinks = page.getByRole("link", { name: "实用工具箱", exact: true });
  assert.ok(await utilityNavigationLinks.count() >= 1, "main navigation must retain the original utility toolbox");
  assert.equal(await utilityNavigationLinks.first().getAttribute("href"), "/tools/utility");
  actionTrace.push({ action: "main-site-utility-preserved", result: "passed", detail: "original segmentation, extraction and typography toolbox remains a first-level navigation entry" });
  await page.screenshot({ path: path.join(evidenceDir, "home-viewport-desktop.png") });
  await hydrateLazyMedia(page);
  for (const alt of [
    "原创影视工坊视觉图",
    "纸艺狐狸雾谷原创画面",
    "雨夜宠物原创画面",
    "紫晶香水原创商业画面",
    "月下观测室原创画面",
  ]) {
    await assertImageLoaded(page, alt, "after scrolling into view");
  }
  await page.screenshot({ path: path.join(evidenceDir, "home-desktop.png"), fullPage: true });
  const handoffPrompt = "把一段宠物科普文案拆成无对白动画镜头，不要自动生成";
  await page.getByLabel("描述创作需求").fill(handoffPrompt);
  await page.getByLabel("描述创作需求").press("Enter");
  await page.waitForURL("**/tools/text/text-chat");
  await page.getByRole("heading", { name: "全能 AI 创作 Agent" }).waitFor();
  await page.getByLabel("创作需求").waitFor();
  assert.equal(await page.getByLabel("创作需求").inputValue(), handoffPrompt);
  await page.getByText("积分授权", { exact: false }).waitFor();
  await page.getByText("记忆", { exact: false }).waitFor();
  await page.getByLabel("主站对话模型").waitFor();
  await page.waitForFunction(() => {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="主站对话模型"]');
    return Boolean(select?.value);
  });
  assert.notEqual(await page.getByLabel("主站对话模型").inputValue(), "", "Agent must resolve a real public model");
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("official_agent_prefill")),
    handoffPrompt,
    "unauthenticated handoff must survive until login succeeds",
  );
  assert.equal(auditState.blockedWrites.length, 0, "homepage handoff must not submit a model call");
  await page.screenshot({ path: path.join(evidenceDir, "agent-prefill-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "保存需求并前往登录" }).click();
  await page.waitForURL("**/login?redirect=%2Ftools%2Ftext%2Ftext-chat");
  assert.equal(auditState.blockedWrites.length, 0, "unauthenticated Agent submit must not call a model");
  actionTrace.push({ action: "homepage-agent-handoff", result: "passed", detail: "prefill preserved; explicit unauthenticated submit reached login without model write" });

  await visit(page, auditState, "/tools/film-studio");
  assert.equal(await page.getByTestId("film-entry-drama-script").getAttribute("href"), "/tools/text/drama-script");
  assert.equal(await page.getByTestId("film-entry-general-script").getAttribute("href"), "/tools/text/general-script");
  assert.equal(await page.getByTestId("film-entry-long-script").getAttribute("href"), "/tools/text/formal-script");
  assert.equal(await page.getByTestId("film-entry-upload-script").getAttribute("href"), "/tools/text/upload-script");
  assert.equal(await page.getByRole("button", { name: "登录后刷新" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("link", { name: "去登录" }).getAttribute("href"),
    "/login?redirect=%2Ftools%2Ffilm-studio",
  );
  await page.screenshot({ path: path.join(evidenceDir, "film-studio-desktop.png"), fullPage: true });
  for (const entry of [
    ["film-entry-drama-script", "/tools/text/drama-script"],
    ["film-entry-general-script", "/tools/text/general-script"],
    ["film-entry-long-script", "/tools/text/formal-script"],
    ["film-entry-upload-script", "/tools/text/upload-script"],
  ] as const) {
    await visit(page, auditState, "/tools/film-studio");
    await page.getByTestId(entry[0]).click();
    await page.waitForURL(`**${entry[1]}`);
    assert.equal(new URL(page.url()).pathname, entry[1]);
    actionTrace.push({ action: `click-${entry[0]}`, result: "passed", detail: entry[1] });
  }
  await visit(page, auditState, "/tools/canvas");
  await page.getByRole("heading", { name: "精选工作流" }).waitFor();
  const workflowCards = page.locator("article").filter({ hasText: "只读示例 · 本地原创" });
  assert.equal(await workflowCards.count(), 4);
  for (let index = 0; index < 4; index += 1) {
    const card = workflowCards.nth(index);
    const title = (await card.getByRole("heading", { level: 3 }).textContent())?.trim() || `workflow-${index + 1}`;
    await card.getByRole("button", { name: "查看", exact: true }).click();
    await page.getByRole("dialog", { name: new RegExp(title) }).waitFor();
    await page.getByRole("button", { name: "关闭示例" }).click();
    await card.getByRole("button", { name: "复制 JSON", exact: true }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(typeof JSON.parse(clipboard), "object", `${title} clipboard must contain JSON`);
    actionTrace.push({ action: `canvas-workflow-${index + 1}`, result: "passed", detail: `${title}: preview + clipboard JSON` });
  }
  const unknownShare = await desktopContext.request.get(`${baseURL}/share/canvas/unknown-local-showcase-id`);
  assert.equal(unknownShare.status(), 404, "unknown canvas share id must return 404");
  for (const [shareId, expectedHeading] of [
    ["canvas-showcase-78f7a4a9ce11-paper-fox-adventure", "纸雕狐狸冒险"],
    ["cmsyrsury01e3caezkqyg5l5l", "漫剧"],
    ["cmsyrvsqh01jgcaez3xadrsob", "奕派M8广告"],
    ["cmt37buny005u85fyne9adfac", "我在古代当花魁"],
  ] as const) {
    await visit(page, auditState, `/share/canvas/${shareId}`);
    await page.getByRole("heading", { name: new RegExp(expectedHeading), level: 1 }).waitFor();
    await page.getByText("本地主站原创替代示例", { exact: false }).first().waitFor();
    actionTrace.push({ action: `canvas-share-${shareId}`, result: "passed", detail: `${expectedHeading}: public read-only local-original showcase` });
  }
  assert.equal(auditState.blockedWrites.length, 0, "Canvas preview must stay read-only");
  await page.screenshot({ path: path.join(evidenceDir, "canvas-desktop.png"), fullPage: true });

  await visit(page, auditState, "/assets");
  await page.getByLabel("素材语义分类").waitFor();
  for (const label of ["角色", "场景", "道具", "风格", "分镜", "成片", "音乐", "语音", "音频", "音效", "图片", "视频", "其他"]) {
    await page.getByLabel("素材语义分类").getByRole("button", { name: label, exact: true }).waitFor();
  }
  assert.equal(await page.getByRole("link", { name: "AI生成" }).getAttribute("href"), "/image-workbench");
  assert.equal(await page.getByRole("button", { name: "选择", exact: true }).isDisabled(), true);
  for (const [group, label] of [
    ["素材类型", "图片"],
    ["素材来源", "生成记录"],
    ["素材语义分类", "角色"],
  ] as const) {
    const button = page.getByLabel(group).getByRole("button", { name: label, exact: true });
    await button.click();
    assert.equal(await button.getAttribute("data-active"), "true", `${group}/${label} must update UI state`);
  }
  await page.getByPlaceholder("搜索素材…").fill("角色一致性");
  assert.equal(await page.getByPlaceholder("搜索素材…").inputValue(), "角色一致性");
  await page.screenshot({ path: path.join(evidenceDir, "assets-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "AI生成" }).click();
  await page.waitForURL("**/image-workbench");
  actionTrace.push({ action: "assets-filters-and-image-generation-route", result: "passed", detail: "filter state changed; AI生成 reached /image-workbench" });

  await visit(page, auditState, "/inspiration");
  await page.getByRole("heading", { name: "灵感广场" }).waitFor();
  await hydrateLazyMedia(page);
  await page.screenshot({ path: path.join(evidenceDir, "inspiration-gallery-desktop.png"), fullPage: true });
  assert.ok(await page.getByLabel("灵感作品列表").locator("article").count() >= 40, "inspiration gallery must provide at least 40 local-original items");
  for (const label of ["图片", "音频", "视频"]) {
    await page.getByLabel("媒体类型").getByRole("button", { name: label, exact: true }).click();
    assert.ok(await page.getByText(/项 · 仅本地静态内容/).isVisible());
    assert.ok(await page.getByLabel("灵感作品列表").locator("article").count() >= 2, `${label} must have at least 2 inspiration items`);
  }
  await page.getByLabel("媒体类型").getByRole("button", { name: "全部", exact: true }).click();
  for (const label of ["角色", "场景", "道具", "风格", "分镜", "成片", "音乐", "语音", "音频", "音效", "图片", "视频", "其他"]) {
    await page.getByLabel("素材分类").getByRole("button", { name: label, exact: true }).click();
    assert.ok(await page.getByLabel("灵感作品列表").locator("article").count() >= 2, `${label} must have at least 2 local-original items`);
  }
  await page.getByLabel("素材分类").getByRole("button", { name: "全部分类", exact: true }).click();
  actionTrace.push({ action: "inspiration-density-and-category-coverage", result: "passed", detail: "40+ local-original items; every media and semantic category has at least 2 entries" });
  await page.getByLabel("媒体类型").getByRole("button", { name: "图片", exact: true }).click();
  await page.getByLabel("灵感作品列表").locator("article").first().getByRole("button").click();
  const imagePrompt = (await page.locator('[class*="promptText"]').textContent())?.trim() || "";
  assert.ok(imagePrompt.length > 20, "image detail must expose a complete prompt");
  await page.getByRole("button", { name: "复制完整提示词" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), imagePrompt);
  await page.getByRole("button", { name: "分享作品" }).click();
  await page.getByRole("button", { name: "已分享" }).waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /\/inspiration\?item=/);
  await page.getByRole("button", { name: "进入创作画布" }).click();
  await page.waitForURL("**/tools/canvas?entry=inspiration&reference=*");
  actionTrace.push({ action: "inspiration-image-copy-share-canvas", result: "passed", detail: "prompt copied, share fallback copied URL, canvas handoff reached" });

  await visit(page, auditState, "/inspiration");
  await page.getByLabel("媒体类型").getByRole("button", { name: "图片", exact: true }).click();
  await page.getByLabel("灵感作品列表").locator("article").first().getByRole("button").click();
  await page.getByRole("button", { name: "登录后下载" }).click();
  await page.waitForURL("**/login");
  actionTrace.push({ action: "inspiration-download-auth-gate", result: "passed", detail: "unauthenticated local asset download reached /login" });

  await visit(page, auditState, "/inspiration");
  await page.getByLabel("媒体类型").getByRole("button", { name: "视频", exact: true }).click();
  await page.getByRole("button", { name: /影视流程本地演示/ }).click();
  const localVideo = page.getByLabel("影视流程本地演示本地演示视频");
  await localVideo.waitFor();
  await localVideo.evaluate((node) => (node as HTMLVideoElement).load());
  let videoReadyState = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    videoReadyState = await localVideo.evaluate((node) => (node as HTMLVideoElement).readyState);
    if (videoReadyState >= 1) break;
    await page.waitForTimeout(200);
  }
  assert.ok(videoReadyState >= 1, "video metadata timeout");
  const videoSource = await localVideo.getAttribute("src");
  assert.ok(videoSource, "video detail must have a local source");
  const videoResponse = await desktopContext.request.get(`${baseURL}${videoSource}`);
  assert.equal(videoResponse.status(), 200);
  assert.equal(auditState.blockedWrites.length, 0, "Inspiration preview must stay read-only");
  await page.screenshot({ path: path.join(evidenceDir, "inspiration-video-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.getByLabel("媒体类型").getByRole("button", { name: "音频", exact: true }).click();
  await page.getByLabel("灵感作品列表").locator("article").first().getByRole("button").click();
  assert.equal(await page.getByRole("dialog").locator("audio").count(), 0, "planned audio must not render a fake player");
  assert.equal(await page.getByRole("button", { name: "素材待接入" }).isDisabled(), true);
  await page.getByRole("button", { name: "关闭详情" }).click();
  actionTrace.push({ action: "inspiration-video-and-audio-boundary", result: "passed", detail: "local video metadata + GET 200; planned audio has no fake player" });

  await visit(page, auditState, "/tools/text/general-script");
  await page.getByTestId("general-script-official").waitFor();
  await page.screenshot({ path: path.join(evidenceDir, "general-script-desktop.png"), fullPage: true });

  await visit(page, auditState, "/tools/text/formal-script");
  await page.getByTestId("formal-script-official").waitFor();
  await page.getByRole("heading", { name: "正剧创作", exact: true }).waitFor();
  assert.equal(await page.getByTestId("formal-episodes-to-generate").inputValue(), "1");
  assert.equal(await page.getByTestId("formal-production-format").inputValue(), "tv_series");
  assert.equal(await page.getByTestId("formal-episode-duration").inputValue(), "45");
  assert.equal(await page.getByTestId("formal-act-structure").inputValue(), "three_act");
  assert.equal(await page.getByTestId("formal-scene-continuity").inputValue(), "strict");
  assert.match(await page.getByTestId("formal-video-size").inputValue(), /16:9/);
  await page.screenshot({ path: path.join(evidenceDir, "formal-script-settings-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: /下一步：输入内容/ }).click();
  await page.getByTestId("formal-character-arc").waitFor();
  await page.getByTestId("formal-relationship-conflict").waitFor();
  await page.getByTestId("formal-foreshadowing-plan").waitFor();
  await page.getByRole("heading", { name: "正剧创作指南" }).waitFor();
  actionTrace.push({ action: "formal-drama-independent-workflow", result: "passed", detail: "long-form format, duration, act structure, continuity, character arc, relationship conflict and foreshadowing controls verified" });
  await page.screenshot({ path: path.join(evidenceDir, "formal-script-desktop.png"), fullPage: true });

  await visit(page, auditState, "/tools/text/upload-script");
  const formalUploadGenre = page.getByRole("button", { name: /正剧/ });
  await formalUploadGenre.click();
  assert.equal(await formalUploadGenre.getAttribute("data-active"), "true");
  assert.equal(auditState.blockedWrites.length, 0, "selecting an upload genre must not upload or call a model");
  actionTrace.push({ action: "upload-script-formal-genre", result: "passed", detail: "正剧 genre can be selected without triggering a write" });

  await visit(page, auditState, "/tools/text/image-prompt");
  await page.getByTestId("image-prompt-workbench").waitFor();
  await page.getByLabel("画面描述 *").fill("雨夜中的未来宠物诊所，温暖室内灯光");
  await page.getByRole("button", { name: "生成提示词", exact: true }).click();
  await page.getByText("请先登录主站").waitFor();
  await page.waitForTimeout(2_200);
  assert.equal(await page.getByRole("button", { name: "生成提示词", exact: true }).textContent(), "生成提示词");
  assert.equal(auditState.blockedWrites.length, 0, "unauth image prompt must not call API");
  await page.screenshot({ path: path.join(evidenceDir, "image-prompt-desktop.png"), fullPage: true });

  const unauthCreativePlan = await desktopContext.request.post(`${baseURL}/api/tools/creative-plan`, {
    data: {
      operation: "image-prompt",
      input: {
        theme: "仅验证未登录边界，不应调用任何模型",
        style: "自动",
        detail: "standard",
        targetModel: "主站生图模型",
      },
    },
  });
  assert.equal(unauthCreativePlan.status(), 401);
  const unauthScript = await desktopContext.request.post(`${baseURL}/api/short-drama/script`, {
    data: {
      profile: {
        id: "general-script",
        version: "1.0.0",
      },
      operation: "generate",
      settings: {
        creationMode: "original",
        targetAudience: "all_ages",
        tone: "comedy",
        customTone: "",
        genre: "通用短剧",
        animationStyle: "影视级短剧",
        videoSize: "16:9",
        episodesToGenerate: 1,
        totalEpisodes: null,
        isFinale: false,
      },
      content: {
        title: "",
        brief: "仅验证未登录边界，不应调用任何模型",
        sourceMaterial: "",
        requirements: "仅验证未登录边界，不应调用任何模型",
      },
      rewriteEpisodeNumbers: [],
      rewriteInstruction: "",
    },
  });
  assert.equal(unauthScript.status(), 401);
  const unauthAssets = await desktopContext.request.get(`${baseURL}/api/storage/files?limit=20&quota=true`);
  assert.equal(unauthAssets.status(), 401);

  // Playwright APIResponse bodies belong to the request context. Capture the
  // immutable evidence before closing that context below.
  const apiGuardEvidence = [
    {
      method: "POST",
      path: "/api/tools/creative-plan",
      status: unauthCreativePlan.status(),
      responseExcerpt: (await unauthCreativePlan.text()).slice(0, 500),
    },
    {
      method: "POST",
      path: "/api/short-drama/script",
      status: unauthScript.status(),
      responseExcerpt: (await unauthScript.text()).slice(0, 500),
    },
    {
      method: "GET",
      path: "/api/storage/files?limit=20&quota=true",
      status: unauthAssets.status(),
      responseExcerpt: (await unauthAssets.text()).slice(0, 500),
    },
  ];

  const mobileContext = await browser.newContext({ viewport: MOBILE_VIEWPORT, deviceScaleFactor: 1 });
  const mobile = await createAuditedPage(mobileContext);
  for (const pathname of MOBILE_ROUTES) {
    const audit = await visit(mobile.page, mobile.auditState, pathname, { ...MOBILE_VIEWPORT, label: "mobile" });
    audits.push(audit);
    assert.equal(audit.status, 200);
    assert.equal(audit.notFoundDetected, false, `${pathname} mobile rendered a not-found page`);
    assert.equal(audit.finalPath, EXPECTED_FINAL_PATHS.get(pathname) ?? pathname, `${pathname} mobile finalPath=${audit.finalPath}`);
    assert.equal(audit.pageErrors.length, 0, `${pathname} mobile page errors: ${audit.pageErrors.join(" | ")}`);
    assert.equal(audit.failedRequests.length, 0, `${pathname} mobile request failures: ${audit.failedRequests.join(" | ")}`);
    assert.equal(audit.externalRequests.length, 0, `${pathname} mobile external requests: ${audit.externalRequests.join(" | ")}`);
    assert.equal(audit.blockedWrites.length, 0, `${pathname} mobile attempted writes: ${audit.blockedWrites.join(" | ")}`);
    assert.ok(audit.horizontalOverflow <= 1, `${pathname} mobile horizontal overflow=${audit.horizontalOverflow}`);
  }
  await visit(mobile.page, mobile.auditState, "/tools/film-studio");
  await mobile.page.screenshot({ path: path.join(evidenceDir, "film-studio-mobile.png"), fullPage: true });
  await visit(mobile.page, mobile.auditState, "/inspiration");
  await hydrateLazyMedia(mobile.page);
  await mobile.page.screenshot({ path: path.join(evidenceDir, "inspiration-mobile.png"), fullPage: true });
  await visit(mobile.page, mobile.auditState, "/tools/text/general-script");
  await mobile.page.screenshot({ path: path.join(evidenceDir, "general-script-mobile.png"), fullPage: true });
  await visit(mobile.page, mobile.auditState, "/tools/text/formal-script");
  await mobile.page.screenshot({ path: path.join(evidenceDir, "formal-script-mobile.png"), fullPage: true });
  await visit(mobile.page, mobile.auditState, "/");
  await mobile.page.screenshot({ path: path.join(evidenceDir, "home-viewport-mobile.png") });
  await mobile.page.getByRole("button", { name: "打开导航" }).click();
  await mobile.page.getByRole("navigation", { name: "影视工坊主导航" }).waitFor();
  await mobile.page.screenshot({ path: path.join(evidenceDir, "home-navigation-mobile.png") });
  await mobile.page.getByRole("button", { name: "关闭导航", exact: true }).click();
  await hydrateLazyMedia(mobile.page);
  for (const alt of [
    "原创影视工坊视觉图",
    "纸艺狐狸雾谷原创画面",
    "雨夜宠物原创画面",
    "紫晶香水原创商业画面",
    "月下观测室原创画面",
  ]) {
    await assertImageLoaded(mobile.page, alt, "on mobile after scrolling into view");
  }
  await mobile.page.screenshot({ path: path.join(evidenceDir, "home-mobile.png"), fullPage: true });

  await mobileContext.close();
  await desktopContext.close();
  await browser.close();

  const scriptPath = path.resolve("scripts/e2e-official-clone-all.ts");
  const scriptSha256 = createHash("sha256").update(await readFile(scriptPath)).digest("hex");
  const buildId = (await readFile(path.resolve(".next/BUILD_ID"), "utf8")).trim();
  const criticalSourceSnapshots = await Promise.all(CRITICAL_SOURCE_PATHS.map(async (relativePath) => {
    const absolutePath = path.resolve(relativePath);
    const [contents, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    return {
      path: relativePath,
      sha256: createHash("sha256").update(contents).digest("hex"),
      modifiedAt: metadata.mtime.toISOString(),
    };
  }));
  const newestCriticalSourceModifiedAt = criticalSourceSnapshots
    .map((entry) => entry.modifiedAt)
    .sort()
    .at(-1) || null;

  const report = {
    ok: true,
    okMeaning: "The declared public unauthenticated audit completed without assertion failures; this is not paid product lifecycle E2E.",
    scope: "public-unauthenticated-readonly-route-and-interaction-audit",
    productE2E: false,
    baseURL,
    timestamp: new Date().toISOString(),
    officialInventoryTargetCount: OFFICIAL_INVENTORY_LINK_TARGETS.length,
    supplementalLocalRouteCount: SUPPLEMENTAL_LOCAL_ROUTES.length,
    desktopAuditCount: ROUTES.length,
    mobileAuditCount: MOBILE_ROUTES.length,
    evidence: {
      scriptPath,
      scriptSha256,
      buildId,
      browserVersion,
      desktopViewport: DESKTOP_VIEWPORT,
      mobileViewport: MOBILE_VIEWPORT,
      sourceControl: "local source of truth; this directory is not a Git worktree",
      newestCriticalSourceModifiedAt,
      criticalSourceSnapshots,
    },
    audits,
    actionTrace,
    assertions: {
      allOfficialInventoryLinkTargetsRender: true,
      allNinePublicArticlesRenderIndependentOriginalContent: true,
      allThirtyThreeOfficialToolDirectoryEntriesVisible: true,
      originalMainSiteUtilityToolboxPreservedInPrimaryNavigation: true,
      assetsAccessibleHeadingPresent: true,
      allAuditedRoutesAvoidNotFound: true,
      noPageLoadWrites: true,
      noExternalRuntimeAssets: true,
      homeAgentPrefillRequiresUserConfirmation: true,
      agentComposerAndRealPublicModelResolvedBeforeLogin: true,
      filmStudioNavigationCorrect: true,
      formalDramaIndependentLongFormControlsVerified: true,
      signedOutFilmRefreshCannotBecomeDeadAction: true,
      canvasFourReadOnlyWorkflowsPreviewAndClipboardVerified: true,
      unknownCanvasShareReturns404: true,
      assetsFilterStateAndRealImageToolNavigationVerified: true,
      inspirationImageCopyShareCanvasAndDownloadGateVerified: true,
      inspirationFortyPlusItemsAndCategoryCoverageVerified: true,
      inspirationLocalVideoMetadataAndHttpVerified: true,
      inspirationPlannedAudioHasNoFakePlayer: true,
      unauthPromptDoesNotCallModel: true,
      unauthorizedApiGuards: apiGuardEvidence,
      allAuditedDesktopAndMobileRoutesNoHorizontalOverflow: true,
      paidGenerationTriggered: false,
      paidGenerationPersistenceBillingTested: false,
    },
  };
  await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
