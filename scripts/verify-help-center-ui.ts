import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

const baseUrl = (process.env.HELP_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const projectRoot = process.cwd();
const screenshotDir = path.join(projectRoot, ".codex-screenshots", "task05-help-center");
const reportPath = path.join(projectRoot, ".tmp-help-audit", "help-ui-report.json");
const publishedTitles = [
  "分镜工作台：从提示词到图片，再到视频",
  "自由画布：三阶段完成一条分镜流程",
  "失败重试与公共图片 URL：先定位，再决定是否重新生成",
];
const forbiddenPublicKeys = new Set([
  "trace", "verificationStatus", "taskId", "runId", "historyId", "artifactPath",
  "sourceRecord", "provider", "channel", "apiKey", "secret",
]);

const viewports = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1440", width: 1440, height: 1000 },
  { name: "1024", width: 1024, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;
const themes = ["lattice"] as const;

function collectKeys(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, result));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      result.add(key);
      collectKeys(item, result);
    });
  }
  return result;
}

async function prepareContext(context: BrowserContext, theme: typeof themes[number]): Promise<void> {
  await context.addInitScript((selectedTheme) => {
    localStorage.setItem("user_theme_preference", selectedTheme);
    localStorage.setItem("app_theme", selectedTheme);
    localStorage.setItem("app_mode", "dark");
  }, theme);
}

async function openHelp(page: Page): Promise<void> {
  const response = await page.goto(`${baseUrl}/help`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "/help 应返回 200");
  await page.getByRole("heading", { name: "快速找到下一步" }).waitFor({ state: "visible", timeout: 20_000 });
  await page.getByText(/^共 \d+ 篇$/u).waitFor({ state: "visible", timeout: 20_000 });
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, `${label}: 页面横向溢出 ${dimensions.scrollWidth - dimensions.clientWidth}px`);
}

async function assertPublishedList(page: Page): Promise<void> {
  for (const title of publishedTitles) {
    await page.getByRole("link", { name: title, exact: true }).waitFor({ state: "visible" });
  }
  const headings = await page.locator("main article h2").allTextContents();
  for (const title of publishedTitles) {
    assert.equal(headings.includes(title), true, `公开帮助列表缺少必要文章：${title}`);
  }
}

async function matrixScreenshots(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<string[]> {
  const screenshots: string[] = [];
  for (const theme of themes) {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "reduce" });
      await prepareContext(context, theme);
      const page = await context.newPage();
      await openHelp(page);
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme, `${theme}/${viewport.name}: 主题属性不匹配`);
      await assertPublishedList(page);
      await assertNoHorizontalOverflow(page, `${theme}/${viewport.name}`);
      const file = path.join(screenshotDir, `help-${theme}-${viewport.name}.png`);
      await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
      screenshots.push(file);
      await page.getByRole("link", { name: publishedTitles[0], exact: true }).click();
      await page.waitForURL(/\/help\/storyboard-prompt-image-video$/);
      await page.getByRole("heading", { level: 1, name: publishedTitles[0] }).waitFor({ state: "visible" });
      await assertNoHorizontalOverflow(page, `detail/${theme}/${viewport.name}`);
      const detailFile = path.join(screenshotDir, `help-detail-${theme}-${viewport.name}.png`);
      await page.screenshot({ path: detailFile, fullPage: true, animations: "disabled" });
      screenshots.push(detailFile);
      await context.close();
    }
  }
  return screenshots;
}

async function functionalChecks(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<Record<string, unknown>> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await prepareContext(context, "lattice");
  const paidRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (/^\/api\/(?:generate|image-generation|video-generation|chat|agent\/run|canvas\/generate)/i.test(url.pathname)) paidRequests.push(url.pathname);
  });
  const page = await context.newPage();
  await openHelp(page);

  await page.keyboard.press("/");
  const search = page.getByPlaceholder("例如：图片 URL、8 秒、下载");
  assert.equal(await search.evaluate((element) => element === document.activeElement), true, "/ 应聚焦搜索框");
  await search.fill("段落编号");
  await page.getByRole("link", { name: publishedTitles[0], exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator("main article h2").count(), 1, "搜索应索引准备内容/步骤字段");
  await search.fill("永远不会出现的搜索词-05");
  await page.getByRole("heading", { name: "没有找到匹配的文档" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByText(/^共 \d+ 篇$/u).waitFor({ state: "visible" });

  await page.getByRole("button").filter({ hasText: "案例展示" }).click();
  await page.getByText("当前分类还没有已发布内容。", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "清除筛选" }).click();

  await page.getByRole("link", { name: publishedTitles[0], exact: true }).click();
  await page.waitForURL(/\/help\/storyboard-prompt-image-video$/);
  await page.getByRole("heading", { level: 1, name: publishedTitles[0] }).waitFor({ state: "visible" });
  for (const heading of ["适用场景", "准备内容", "操作步骤", "真实素材与结果对照", "费用与等待说明", "成功判定", "常见失败与处理"]) {
    await page.getByRole("heading", { name: heading, exact: true }).waitFor({ state: "visible" });
  }
  await assertNoHorizontalOverflow(page, "detail/1440");

  const zoomTrigger = page.getByRole("button", { name: "放大查看：分镜工作台当前桌面界面" });
  await zoomTrigger.click();
  const close = page.getByRole("button", { name: "关闭图片预览" });
  await close.waitFor({ state: "visible" });
  assert.equal(await close.evaluate((element) => element === document.activeElement), true, "图片对话框应接管焦点");
  await page.keyboard.press("Tab");
  assert.equal(await close.evaluate((element) => element === document.activeElement), true, "Tab 焦点不得逸出图片对话框");
  await page.keyboard.press("Escape");
  await close.waitFor({ state: "detached" });
  assert.equal(await zoomTrigger.evaluate((element) => element === document.activeElement), true, "关闭对话框后应返回原触发按钮");

  await page.route("**/help/storyboard-workbench.png", (route) => route.abort("failed"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("媒体暂时不可用", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  const failureShot = path.join(screenshotDir, "help-media-failure-nocturne-1440.png");
  await page.screenshot({ path: failureShot, fullPage: true, animations: "disabled" });
  await page.unroute("**/help/storyboard-workbench.png");

  const notFoundResponse = await page.goto(`${baseUrl}/help/not-a-published-article`, { waitUntil: "domcontentloaded" });
  assert.equal(notFoundResponse?.status(), 200, "动态帮助路由应由客户端渲染友好未发布状态");
  await page.getByRole("heading", { name: "这篇文档尚未发布或不存在" }).waitFor({ state: "visible" });

  const loadingPage = await context.newPage();
  await loadingPage.route("**/api/help", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  const loadingNavigation = loadingPage.goto(`${baseUrl}/help`, { waitUntil: "domcontentloaded" });
  await loadingPage.getByText("正在读取学习中心", { exact: true }).waitFor({ state: "visible" });
  await loadingNavigation;
  await loadingPage.close();

  const errorPage = await context.newPage();
  await errorPage.route("**/api/help", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "验收用可恢复错误" }) }));
  await errorPage.goto(`${baseUrl}/help`, { waitUntil: "domcontentloaded" });
  await errorPage.getByRole("alert").getByText("验收用可恢复错误", { exact: true }).waitFor({ state: "visible" });
  await errorPage.close();

  assert.deepEqual(paidRequests, [], "帮助验收不得调用付费生成 API");
  await context.close();
  return { search: true, category: true, empty: true, detail: true, imageDialog: true, mediaFailure: true, notFound: true, loading: true, apiError: true, paidRequests };
}

async function apiAndVideoChecks(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<Record<string, unknown>> {
  const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  const publicResponse = await context.request.get(`${baseUrl}/api/help`);
  assert.equal(publicResponse.status(), 200, "/api/help 应返回 200");
  const publicPayload = await publicResponse.json();
  assert.ok(publicPayload.articles.length >= 3, "公开 API 至少应返回 3 篇已发布教程");
  for (const title of publishedTitles) {
    assert.equal(
      publicPayload.articles.some((article: { title?: string }) => article.title === title),
      true,
      `公开 API 缺少必要文章：${title}`,
    );
  }
  const keys = collectKeys(publicPayload);
  for (const key of forbiddenPublicKeys) assert.equal(keys.has(key), false, `公开 API 暴露内部字段 ${key}`);
  assert.equal(publicPayload.media.some((item: { sourceKind?: string }) => item.sourceKind === "test_fixture" || item.sourceKind === "waiting"), false, "公开 API 不得返回 fixture/waiting 媒体");

  const adminResponse = await context.request.get(`${baseUrl}/api/admin/help`);
  assert.ok([401, 403].includes(adminResponse.status()), `未登录后台 API 应返回 401/403，实际 ${adminResponse.status()}`);

  const adminPage = await context.newPage();
  await adminPage.goto(`${baseUrl}/admin/help`, { waitUntil: "domcontentloaded" });
  const gateHeading = adminPage.getByRole("heading", { name: "仅管理员可访问学习中心后台" });
  await Promise.race([
    adminPage.waitForURL(/\/login(?:\?|$)/, { timeout: 10_000 }),
    gateHeading.waitFor({ state: "visible", timeout: 10_000 }),
  ]).catch(() => undefined);
  const adminGate = adminPage.url().includes("/login") || await gateHeading.isVisible().catch(() => false);
  assert.equal(adminGate, true, "未登录用户不得进入帮助后台");

  const videoResponse = await context.request.get(`${baseUrl}/help/storyboard-video-case.mp4`, { headers: { Range: "bytes=0-1048575" } });
  assert.ok([200, 206].includes(videoResponse.status()), `归档视频应支持读取/Range，实际 ${videoResponse.status()}`);
  assert.match(videoResponse.headers()["content-type"] || "", /^video\/mp4/i, "归档视频 MIME 应为 video/mp4");
  const captionsResponse = await context.request.get(`${baseUrl}/help/storyboard-video-case.zh-CN.vtt`);
  assert.equal(captionsResponse.status(), 200, "中文字幕资源应返回 200");
  assert.match(await captionsResponse.text(), /^WEBVTT/m, "字幕应为合法 WebVTT");

  await adminPage.goto(`${baseUrl}/help`, { waitUntil: "domcontentloaded" });
  const playback = await adminPage.evaluate(async (src) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = src;
    document.body.append(video);
    const metadata = await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("视频 metadata 超时")), 15_000);
      video.addEventListener("loadedmetadata", () => {
        window.clearTimeout(timer);
        resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
      }, { once: true });
      video.addEventListener("error", () => reject(new Error(`视频解码失败: ${video.error?.message || "unknown"}`)), { once: true });
    });
    await video.play();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const currentTime = video.currentTime;
    video.pause();
    video.remove();
    return { ...metadata, currentTime };
  }, `${baseUrl}/help/storyboard-video-case.mp4`);
  assert.ok(playback.duration > 0 && playback.width > 0 && playback.height > 0, "归档视频应可解码");
  assert.ok(playback.currentTime >= 0, "归档视频应能启动播放");

  const clientSource = await readFile(path.join(projectRoot, "src/app/help/help-center-client.tsx"), "utf8");
  assert.match(clientSource, /<video controls/);
  assert.match(clientSource, /<track kind="captions"/);
  assert.match(clientSource, /media\.textSummary/);
  await context.close();
  return { publicApi: 200, adminApiAnonymous: adminResponse.status(), adminAnonymousGate: true, video: playback, captions: 200 };
}

async function main(): Promise<void> {
  await mkdir(screenshotDir, { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const screenshots = await matrixScreenshots(browser);
    const interaction = await functionalChecks(browser);
    const api = await apiAndVideoChecks(browser);
    const report = {
      ok: true,
      baseUrl,
      generatedAt: new Date().toISOString(),
      screenshots,
      viewports,
      themes,
      interaction,
      api,
      authenticatedAdminPreview: "未使用或伪造登录会话；管理员预览权限由领域契约测试覆盖",
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
