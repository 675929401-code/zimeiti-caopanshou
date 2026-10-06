import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
  type Route,
} from "playwright";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const baseOrigin = new URL(baseUrl).origin;
const evidenceDir = path.resolve(".codex-evidence", "youcai-final-20260823");
const reportPath = path.join(evidenceDir, "verify-youcai-final.json");

const DESKTOP_VIEWPORT = { width: 1440, height: 1000 } as const;
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

const YOUCAI_NAVIGATION = [
  "个人资产",
  "Skill 专家",
  "创作中心",
  "创作 Agent",
  "影视工坊",
  "漫剧画布",
  "灵感广场",
  "漫剧TV",
  "帮助中心",
  "积分充值",
  "推荐计划",
] as const;

const BANNED_VISIBLE_PHRASES = [
  "自媒体操盘手",
  "真实链路",
  "不造假",
  "本地原创",
  "公开预览",
  "伪装",
  "虚假",
] as const;

const CORE_ROUTES = [
  { path: "/youcai", label: "漫剧工作台首页", screenshot: "02-youcai-home-desktop.png" },
  { path: "/youcai/assets", label: "个人资产", screenshot: "03-youcai-assets-desktop.png" },
  { path: "/youcai/tools", label: "创作中心", screenshot: "04-youcai-tools-desktop.png" },
  { path: "/youcai/tools/text/text-chat", label: "创作 Agent", screenshot: "05-youcai-agent-desktop.png" },
  { path: "/youcai/tools/film-studio", label: "影视工坊", screenshot: "06-youcai-film-studio-desktop.png" },
  { path: "/youcai/tools/canvas", label: "漫剧画布", screenshot: "07-youcai-canvas-desktop.png" },
  { path: "/youcai/inspiration", label: "灵感广场", screenshot: "08-youcai-inspiration-desktop.png" },
  { path: "/youcai/youcai-tv", label: "漫剧TV" },
  { path: "/youcai/articles", label: "帮助中心" },
  { path: "/youcai/recharge", label: "积分充值", screenshot: "10-youcai-recharge-desktop.png" },
  { path: "/youcai/referral", label: "推荐计划" },
  { path: "/youcai/tools/text/drama-script", label: "爽剧创作" },
  { path: "/youcai/tools/text/general-script", label: "通用短剧创作" },
  { path: "/youcai/tools/text/formal-script", label: "正剧入口" },
  { path: "/youcai/tools/text/upload-script", label: "上传剧本" },
  { path: "/youcai/tools/text/image-prompt", label: "图片提示词" },
  { path: "/youcai/tools/text", label: "文本工具目录" },
  { path: "/youcai/tools/image", label: "图片工具目录" },
  { path: "/youcai/tools/audio", label: "音频工具目录" },
  { path: "/youcai/tools/video", label: "视频工具目录", screenshot: "11-youcai-video-directory-desktop.png" },
] as const;

const MOBILE_ROUTES = [
  { path: "/youcai", testId: "official-home-page", screenshot: "12-youcai-home-mobile.png" },
  { path: "/youcai/tools/film-studio", testId: "film-studio-overview", screenshot: "13-youcai-film-studio-mobile.png" },
  { path: "/youcai/tools/text/text-chat", testId: "official-agent-page", screenshot: "14-youcai-agent-mobile.png" },
] as const;

interface ConsoleErrorEvidence {
  readonly route: string;
  readonly text: string;
  readonly locationUrl: string;
}

interface FailedRequestEvidence {
  readonly route: string;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly reason: string;
}

interface HttpErrorEvidence {
  readonly route: string;
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly allowed: boolean;
}

interface PageErrorEvidence {
  readonly route: string;
  readonly message: string;
}

interface BlockedWriteEvidence {
  readonly route: string;
  readonly method: string;
  readonly url: string;
}

interface ExternalRequestEvidence {
  readonly route: string;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
}

interface Diagnostics {
  consoleErrors: ConsoleErrorEvidence[];
  failedRequests: FailedRequestEvidence[];
  httpErrors: HttpErrorEvidence[];
  pageErrors: PageErrorEvidence[];
  blockedWrites: BlockedWriteEvidence[];
  externalRequests: ExternalRequestEvidence[];
}

interface RouteResult {
  readonly path: string;
  readonly label: string;
  readonly viewport: "desktop" | "mobile";
  readonly status: number | null;
  readonly finalPath: string;
  readonly title: string;
  readonly heading: string;
  readonly bodyLength: number;
  readonly horizontalOverflow: number;
  readonly bannedPhrases: string[];
}

interface ContextAudit {
  readonly context: BrowserContext;
  readonly diagnostics: Diagnostics;
  setActiveRoute(route: string): void;
}

interface FinalReport {
  ok: boolean;
  baseUrl: string;
  generatedAt: string;
  mainSite: Record<string, unknown>;
  sidebarLabels: string[];
  routeResults: RouteResult[];
  filmStudioDestinations: Record<string, string>;
  mobileResults: RouteResult[];
  diagnostics: {
    desktop: Diagnostics | null;
    mobile: Diagnostics | null;
    unexpectedConsoleErrors: ConsoleErrorEvidence[];
    unexpectedFailedRequests: FailedRequestEvidence[];
    unexpectedHttpErrors: HttpErrorEvidence[];
  };
  screenshots: string[];
  failure?: string;
}

function pathnameOf(input: string): string {
  try {
    return new URL(input).pathname;
  } catch {
    return input;
  }
}

function isAllowedSignedOutResponse(status: number, input: string): boolean {
  return status === 401 && pathnameOf(input).startsWith("/api/");
}

function isExpectedAbortedRequest(item: FailedRequestEvidence): boolean {
  if (!/ERR_ABORTED|NS_BINDING_ABORTED/u.test(item.reason)) return false;
  try {
    const parsed = new URL(item.url);
    return parsed.origin === baseOrigin && (
      parsed.searchParams.has("_rsc")
      || item.resourceType === "media"
      || item.resourceType === "image"
      || item.resourceType === "fetch"
    );
  } catch {
    return false;
  }
}

function isAllowedSignedOutConsoleError(item: ConsoleErrorEvidence): boolean {
  if (/\b401\b|unauthori[sz]ed|not authenticated|未登录|请先登录/u.test(item.text)) return true;
  if (!item.locationUrl) return false;
  return pathnameOf(item.locationUrl).startsWith("/api/") && /401|auth/u.test(item.text);
}

function newDiagnostics(): Diagnostics {
  return {
    consoleErrors: [],
    failedRequests: [],
    httpErrors: [],
    pageErrors: [],
    blockedWrites: [],
    externalRequests: [],
  };
}

async function createAuditedContext(
  browser: Browser,
  viewport: { readonly width: number; readonly height: number },
): Promise<ContextAudit> {
  const context = await browser.newContext({ viewport });
  const diagnostics = newDiagnostics();
  let activeRoute = "bootstrap";
  let settingsSnapshot: {
    status: number;
    headers: Record<string, string>;
    body: string;
  } | null = null;

  await context.addInitScript(() => {
    // Directly open the existing application marketplace instead of the optional marketing splash.
    try {
      sessionStorage.setItem("entered_app", "1");
    } catch {
      // about:blank can have an opaque origin; the script runs again for the application origin.
    }
  });

  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const requestUrl = new URL(request.url());
    if (
      method === "GET"
      && requestUrl.origin === baseOrigin
      && requestUrl.pathname === "/api/announcements"
    ) {
      // The main-site announcement popup is unrelated to this branch audit and can
      // cover the navigation under test. Keep the run read-only and deterministic.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ announcements: [] }),
      });
      return;
    }
    if (
      method === "GET"
      && requestUrl.origin === baseOrigin
      && requestUrl.pathname === "/api/settings"
    ) {
      // Every route mounts the shared account shell. Read the real public settings
      // once per browser context, then reuse that exact response during this rapid
      // multi-page audit so the test itself does not trip the endpoint rate limit.
      if (!settingsSnapshot) {
        const response = await route.fetch();
        settingsSnapshot = {
          status: response.status(),
          headers: response.headers(),
          body: await response.text(),
        };
      }
      await route.fulfill(settingsSnapshot);
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      diagnostics.blockedWrites.push({ route: activeRoute, method, url: request.url() });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  context.on("page", (page) => {
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() !== "error") return;
      diagnostics.consoleErrors.push({
        route: activeRoute,
        text: message.text(),
        locationUrl: message.location().url || "",
      });
    });
    page.on("pageerror", (error) => {
      diagnostics.pageErrors.push({ route: activeRoute, message: error.message });
    });
    page.on("requestfailed", (request: Request) => {
      diagnostics.failedRequests.push({
        route: activeRoute,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        reason: request.failure()?.errorText || "unknown",
      });
    });
    page.on("response", (response: Response) => {
      if (response.status() < 400) return;
      diagnostics.httpErrors.push({
        route: activeRoute,
        status: response.status(),
        method: response.request().method(),
        url: response.url(),
        resourceType: response.request().resourceType(),
        allowed: isAllowedSignedOutResponse(response.status(), response.url()),
      });
    });
    page.on("request", (request: Request) => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      try {
        const parsed = new URL(url);
        if (parsed.origin !== baseOrigin) {
          diagnostics.externalRequests.push({
            route: activeRoute,
            method: request.method(),
            url,
            resourceType: request.resourceType(),
          });
        }
      } catch {
        // Malformed URLs are already visible in the failed-request diagnostics when they fail.
      }
    });
  });

  return {
    context,
    diagnostics,
    setActiveRoute(route: string) {
      activeRoute = route;
    },
  };
}

async function settlePage(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.innerText.trim().length > 20, undefined, { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

async function visiblePageState(page: Page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText.replace(/\u00a0/g, " ").trim();
    return {
      title: document.title.trim(),
      heading: document.querySelector("h1")?.textContent?.trim() || "",
      bodyText,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

async function visitYoucaiRoute(
  audit: ContextAudit,
  page: Page,
  target: { readonly path: string; readonly label: string; readonly screenshot?: string },
  viewport: "desktop" | "mobile",
  screenshots: string[],
): Promise<RouteResult> {
  audit.setActiveRoute(target.path);
  const response = await page.goto(`${baseUrl}${target.path}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await settlePage(page);

  const finalUrl = new URL(page.url());
  const state = await visiblePageState(page);
  const bannedPhrases = BANNED_VISIBLE_PHRASES.filter((phrase) => state.bodyText.includes(phrase));
  const result: RouteResult = {
    path: target.path,
    label: target.label,
    viewport,
    status: response?.status() ?? null,
    finalPath: finalUrl.pathname,
    title: state.title,
    heading: state.heading,
    bodyLength: state.bodyText.length,
    horizontalOverflow: Math.max(0, state.scrollWidth - state.clientWidth),
    bannedPhrases: [...bannedPhrases],
  };

  assert.equal(result.status, 200, `${target.label} ${target.path} 应返回 HTTP 200，实际 ${String(result.status)}`);
  assert.equal(result.finalPath, target.path, `${target.path} 不应跳到 ${result.finalPath}`);
  assert.equal(result.bodyLength > 20, true, `${target.path} 页面内容为空`);
  assert.equal(
    /Application error|This page could not be found|页面不存在|ChunkLoadError/u.test(state.bodyText),
    false,
    `${target.path} 出现页面崩溃或 404 文案`,
  );
  assert.deepEqual(result.bannedPhrases, [], `${target.path} 出现内部词：${result.bannedPhrases.join("、")}`);

  if (target.screenshot) {
    const screenshotPath = path.join(evidenceDir, target.screenshot);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    screenshots.push(screenshotPath);
  }

  return result;
}

async function verifyMainSite(
  audit: ContextAudit,
  page: Page,
  screenshots: string[],
): Promise<Record<string, unknown>> {
  audit.setActiveRoute("/");
  const response = await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("button.nav-pill").first().waitFor({ state: "visible", timeout: 45_000 });
  await page.locator('[aria-label^="打开智能体："]').first().waitFor({ state: "visible", timeout: 45_000 });
  await settlePage(page);

  assert.equal(response?.status(), 200, "主站 / 应返回 HTTP 200");
  assert.equal(new URL(page.url()).pathname, "/", "主站 / 不应发生跳转");

  const navLabels = (await page.locator("button.nav-pill").allInnerTexts()).map((label) => label.trim());
  const coverIndex = navLabels.indexOf("封面制作");
    const youcaiIndex = navLabels.indexOf("漫剧工作台");
  const cardCount = await page.locator('[aria-label^="打开智能体："]').count();
  const shortcutLabels = (await page.locator("button.sidebar-tool-card").allInnerTexts()).map((label) => label.trim());

  assert.equal(cardCount, 70, `主站应用广场应保留 70 张智能体卡片，实际 ${cardCount}`);
  assert.equal(await page.getByText("暂无智能体", { exact: true }).count(), 0, "主站错误显示暂无智能体");
  assert.equal(navLabels.includes("应用广场"), true, "主站顶部导航缺少应用广场");
  assert.equal(navLabels.includes("影视工坊"), false, "主站顶部导航仍有旧影视工坊");
  assert.equal(shortcutLabels.includes("影视工坊"), false, "主站左侧快捷导航仍有旧影视工坊");
  assert.equal(coverIndex >= 0, true, "主站顶部导航缺少封面制作");
    assert.equal(youcaiIndex, coverIndex + 1, "漫剧工作台必须紧跟封面制作");

  const screenshotPath = path.join(evidenceDir, "01-main-site-marketplace-desktop.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  screenshots.push(screenshotPath);

    const youcaiButton = page.locator("button.nav-pill").filter({ hasText: /^\s*漫剧工作台\s*$/u });
    assert.equal(await youcaiButton.count(), 1, "主站顶部漫剧工作台入口数量应为 1");
  await youcaiButton.click();
  await page.waitForURL((url) => url.pathname === "/youcai", { timeout: 30_000 });
  await page.locator('[data-testid="official-home-page"]').waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(new URL(page.url()).pathname, "/youcai", "点击漫剧工作台后必须进入 /youcai");

  return {
    status: response?.status() ?? null,
    marketplaceCardCount: cardCount,
    navLabels,
    shortcutLabels,
    coverIndex,
    youcaiIndex,
    clickedDestination: new URL(page.url()).pathname,
  };
}

async function verifyYoucaiSidebar(page: Page): Promise<string[]> {
  const sidebar = page.locator('[data-testid="film-studio-sidebar"]');
  await sidebar.waitFor({ state: "visible", timeout: 30_000 });
    const labels = (await sidebar.locator('nav[aria-label="漫剧工作台主导航"] a').allInnerTexts())
    .map((label) => label.trim());
  assert.deepEqual(labels, [...YOUCAI_NAVIGATION], "漫剧工作台侧栏必须按约定顺序显示 13 个项目");
  return labels;
}

async function clickFilmEntry(
  audit: ContextAudit,
  page: Page,
  testId: string,
  expectedPath: string,
): Promise<string> {
  audit.setActiveRoute(`/youcai/tools/film-studio#${testId}`);
  const entry = page.locator(`[data-testid="${testId}"]`);
  await entry.waitFor({ state: "visible", timeout: 30_000 });
  await entry.click();
  await page.waitForURL((url) => url.pathname === expectedPath, { timeout: 30_000 });
  await settlePage(page);
  const actualPath = new URL(page.url()).pathname;
  assert.equal(actualPath, expectedPath, `${testId} 入口错误跳转到 ${actualPath}`);
  assert.equal(actualPath.includes("storyboard"), false, `${testId} 不得跳到分镜工作台`);
  return actualPath;
}

async function openFilmStudio(audit: ContextAudit, page: Page): Promise<void> {
  audit.setActiveRoute("/youcai/tools/film-studio");
  const response = await page.goto(`${baseUrl}/youcai/tools/film-studio`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.equal(response?.status(), 200, "影视工坊应返回 HTTP 200");
  await page.locator('[data-testid="film-studio-overview"]').waitFor({ state: "visible", timeout: 30_000 });
  await settlePage(page);
}

async function verifyFilmStudioDestinations(
  audit: ContextAudit,
  page: Page,
): Promise<Record<string, string>> {
  await openFilmStudio(audit, page);
  const drama = await clickFilmEntry(
    audit,
    page,
    "film-entry-drama-script",
    "/youcai/tools/film-studio/create/drama-script",
  );

  await openFilmStudio(audit, page);
  const general = await clickFilmEntry(
    audit,
    page,
    "film-entry-general-script",
    "/youcai/tools/film-studio/create/general-script",
  );

  await openFilmStudio(audit, page);
  const upload = await clickFilmEntry(
    audit,
    page,
    "film-entry-upload-script",
    "/youcai/tools/film-studio/create/upload-script",
  );

  await openFilmStudio(audit, page);
  const formalEntry = page.locator('[data-testid="film-entry-long-script"]');
  await formalEntry.waitFor({ state: "visible", timeout: 30_000 });
  const formalState = await formalEntry.evaluate((element) => ({
    tagName: element.tagName,
    disabled: element instanceof HTMLButtonElement && element.disabled,
    href: element instanceof HTMLAnchorElement ? element.getAttribute("href") : null,
    text: element.textContent?.replace(/\s+/g, " ").trim() || "",
  }));
  assert.equal(formalState.tagName, "BUTTON", "正剧应使用不可跳转按钮");
  assert.equal(formalState.disabled, true, "正剧应为禁用状态");
  assert.equal(formalState.href, null, "正剧不应包含跳转链接");
  assert.match(formalState.text, /即将上线/u, "正剧应明确显示即将上线");
  const beforeDisabledClick = new URL(page.url()).pathname;
  await formalEntry.evaluate((element) => (element as HTMLElement).click());
  await page.waitForTimeout(300);
  const afterDisabledClick = new URL(page.url()).pathname;
  assert.equal(afterDisabledClick, beforeDisabledClick, "点击禁用正剧入口不得发生跳转");
  assert.equal(afterDisabledClick.includes("storyboard"), false, "正剧入口不得跳到分镜工作台");

  return { drama, general, upload, formal: afterDisabledClick };
}

async function verifyMobile(
  browser: Browser,
  screenshots: string[],
): Promise<{ audit: ContextAudit; results: RouteResult[] }> {
  const audit = await createAuditedContext(browser, MOBILE_VIEWPORT);
  const page = await audit.context.newPage();
  const results: RouteResult[] = [];

  for (const target of MOBILE_ROUTES) {
    const result = await visitYoucaiRoute(
      audit,
      page,
      { path: target.path, label: `${target.path} 手机端`, screenshot: target.screenshot },
      "mobile",
      screenshots,
    );
    await page.locator(`[data-testid="${target.testId}"]`).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(result.horizontalOverflow <= 2, true, `${target.path} 手机端横向溢出 ${result.horizontalOverflow}px`);
    results.push(result);
  }

  audit.setActiveRoute("/youcai/tools/film-studio#mobile-navigation");
  await page.goto(`${baseUrl}/youcai/tools/film-studio`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByRole("button", { name: "打开导航" }).click();
  const mobileDrawer = page.locator('[data-testid="film-studio-mobile-drawer"]');
  await mobileDrawer.waitFor({ state: "visible", timeout: 30_000 });
    const mobileLabels = (await mobileDrawer.locator('nav[aria-label="漫剧工作台主导航"] a').allInnerTexts())
    .map((label) => label.trim());
  assert.deepEqual(mobileLabels, [...YOUCAI_NAVIGATION], "手机端侧栏也必须完整显示 13 个官网项目");

  return { audit, results };
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  let browser: Browser | null = null;
  let desktopAudit: ContextAudit | null = null;
  let mobileAudit: ContextAudit | null = null;

  const report: FinalReport = {
    ok: false,
    baseUrl,
    generatedAt: new Date().toISOString(),
    mainSite: {},
    sidebarLabels: [],
    routeResults: [],
    filmStudioDestinations: {},
    mobileResults: [],
    diagnostics: {
      desktop: null,
      mobile: null,
      unexpectedConsoleErrors: [],
      unexpectedFailedRequests: [],
      unexpectedHttpErrors: [],
    },
    screenshots: [],
  };

  try {
    browser = await chromium.launch({ headless: true });
    desktopAudit = await createAuditedContext(browser, DESKTOP_VIEWPORT);
    report.diagnostics.desktop = desktopAudit.diagnostics;
    const page = await desktopAudit.context.newPage();

    report.mainSite = await verifyMainSite(desktopAudit, page, report.screenshots);
    report.sidebarLabels = await verifyYoucaiSidebar(page);

    for (const target of CORE_ROUTES) {
      report.routeResults.push(await visitYoucaiRoute(
        desktopAudit,
        page,
        target,
        "desktop",
        report.screenshots,
      ));
      if (target.path === "/youcai") report.sidebarLabels = await verifyYoucaiSidebar(page);
    }

    report.filmStudioDestinations = await verifyFilmStudioDestinations(desktopAudit, page);

    const mobile = await verifyMobile(browser, report.screenshots);
    mobileAudit = mobile.audit;
    report.diagnostics.mobile = mobileAudit.diagnostics;
    report.mobileResults = mobile.results;

    const combinedDiagnostics = [desktopAudit.diagnostics, mobileAudit.diagnostics];
    const allConsoleErrors = combinedDiagnostics.flatMap((item) => item.consoleErrors);
    const allFailedRequests = combinedDiagnostics.flatMap((item) => item.failedRequests);
    const allHttpErrors = combinedDiagnostics.flatMap((item) => item.httpErrors);
    const allPageErrors = combinedDiagnostics.flatMap((item) => item.pageErrors);
    const allBlockedWrites = combinedDiagnostics.flatMap((item) => item.blockedWrites);

    report.diagnostics.unexpectedConsoleErrors = uniqueBy(
      allConsoleErrors.filter((item) => !isAllowedSignedOutConsoleError(item)),
      (item) => `${item.route}|${item.text}|${item.locationUrl}`,
    );
    report.diagnostics.unexpectedFailedRequests = uniqueBy(
      allFailedRequests.filter((item) => (
        !isExpectedAbortedRequest(item)
        && !allBlockedWrites.some((write) => write.method === item.method && write.url === item.url)
      )),
      (item) => `${item.route}|${item.method}|${item.url}|${item.reason}`,
    );
    report.diagnostics.unexpectedHttpErrors = uniqueBy(
      allHttpErrors.filter((item) => !item.allowed),
      (item) => `${item.route}|${item.status}|${item.method}|${item.url}`,
    );

    assert.deepEqual(allPageErrors, [], `检测到页面脚本异常：${JSON.stringify(allPageErrors)}`);
    assert.deepEqual(allBlockedWrites, [], `只读验收期间页面尝试了写请求：${JSON.stringify(allBlockedWrites)}`);
    assert.deepEqual(
      report.diagnostics.unexpectedConsoleErrors,
      [],
      `检测到非未登录 401 导致的 console error：${JSON.stringify(report.diagnostics.unexpectedConsoleErrors)}`,
    );
    assert.deepEqual(
      report.diagnostics.unexpectedFailedRequests,
      [],
      `检测到非导航中止的 failed request：${JSON.stringify(report.diagnostics.unexpectedFailedRequests)}`,
    );
    assert.deepEqual(
      report.diagnostics.unexpectedHttpErrors,
      [],
      `检测到非未登录 API 401 的 HTTP 错误：${JSON.stringify(report.diagnostics.unexpectedHttpErrors)}`,
    );

    report.ok = true;
  } catch (error) {
    report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    report.generatedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await mobileAudit?.context.close().catch(() => undefined);
    await desktopAudit?.context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  console.log(JSON.stringify({
    ok: report.ok,
    baseUrl,
    checkedDesktopRoutes: report.routeResults.length,
    checkedMobileRoutes: report.mobileResults.length,
    marketplaceCardCount: report.mainSite.marketplaceCardCount,
    sidebarLabels: report.sidebarLabels,
    filmStudioDestinations: report.filmStudioDestinations,
    allowedSignedOut401Count: [desktopAudit, mobileAudit]
      .filter((item): item is ContextAudit => Boolean(item))
      .flatMap((item) => item.diagnostics.httpErrors)
      .filter((item) => item.allowed).length,
    reportPath,
    screenshots: report.screenshots,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
