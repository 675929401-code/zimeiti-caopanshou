import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "playwright";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const baseOrigin = new URL(baseUrl).origin;
const evidenceDir = path.resolve(".codex-evidence", "manju-deep-e2e-20260823");
const reportPath = path.join(evidenceDir, "verify-manju-deep-e2e.json");

async function closeWithTimeout(closeable: { close(): Promise<void> }, label: string, timeoutMs = 3_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    closeable.close().catch((error: unknown) => {
      console.error(`[manju-deep-e2e] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[manju-deep-e2e] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

const DESKTOP_VIEWPORT = { width: 1440, height: 1000 } as const;
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const MANGA_AGENT_ID = "__manga_workbench__";
const EXISTING_CONVERSATION_ID = "e2e-existing-manga-conversation";
const TEXT_MODEL_ID = "e2e-fixture-text-model";
const SSE_FIXTURE_TEXT = "这是本地 SSE 验收回复，不调用任何外部模型。";
const CANVAS_STORAGE_KEYS = [
  "ai-creation-studio-free-canvas-sessions-v1",
  "ai-creation-studio-free-canvas-active-session-v1",
  "ai-creation-studio-free-canvas-layout-version",
] as const;
const SHOWCASE_HANDOFF_KEY = "official_inspiration_canvas_reference_v1";

const ERROR_BOUNDARY_PHRASES = [
  "Application error",
  "应用遇到了问题",
  "页面发生了意外错误",
  "This page could not be found",
] as const;

const MOBILE_ROUTES = [
  { path: "/youcai", name: "home" },
  { path: "/youcai/inspiration", name: "inspiration", scroller: "素材分类" },
  { path: "/youcai/tools/canvas", name: "canvas" },
  { path: "/youcai/tools/text/text-chat", name: "agent" },
  { path: "/youcai/assets", name: "assets", scroller: "素材语义分类" },
] as const;

interface InterceptedRequest {
  readonly method: string;
  readonly path: string;
  readonly resourceType: string;
}

interface LlmFixtureCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  readonly messageRoles: string[];
  readonly userTexts: string[];
}

interface SafetyEvidence {
  readonly interceptedWrites: InterceptedRequest[];
  readonly interceptedModelEndpoints: InterceptedRequest[];
  readonly forbiddenGenerationRequests: InterceptedRequest[];
  readonly forbiddenPaidRequests: InterceptedRequest[];
  readonly externalRequests: InterceptedRequest[];
  readonly llmFixtureCalls: LlmFixtureCall[];
  readonly pageErrors: Array<{ url: string; message: string }>;
}

interface ShowcaseEvidence {
  readonly href: string;
  readonly title: string;
  readonly detailNodes: number;
  readonly videoNodes: number;
  readonly detailEdges: number;
  readonly listNodes: number;
  readonly scrolled: boolean;
  readonly copiedPath: string;
  readonly freeCanvasNodes: number;
  readonly freeCanvasEdges: number;
}

interface MobileEvidence {
  readonly path: string;
  readonly horizontalOverflow: number;
  readonly categoryScroller?: {
    readonly ariaLabel: string;
    readonly overflowX: string;
    readonly clientWidth: number;
    readonly scrollWidth: number;
    readonly scrollLeft: number;
  };
}

interface DeepE2eReport {
  ok: boolean;
  readonly baseUrl: string;
  readonly generatedAt: string;
  readonly safeguards: {
    readonly noPaidOrGenerationCallsAllowed: true;
    readonly llmUsesLocalSseFixture: true;
    readonly externalResourcesAreNotAcceptanceDependencies: true;
  };
  mainSite: Record<string, unknown>;
  navigation: Record<string, unknown>;
  canvas: {
    banner: Record<string, unknown>;
    showcases: ShowcaseEvidence[];
  };
  agent: Record<string, unknown>;
  mobile: MobileEvidence[];
  assets: Record<string, unknown>;
  safety: SafetyEvidence;
  screenshots: string[];
  failure?: string;
}

interface ContextOptions {
  readonly authenticated?: boolean;
  readonly viewport?: { width: number; height: number };
  readonly blockExternal?: boolean;
}

const fakeUser = {
  id: "e2e-manga-user",
  email: "e2e-manga-user@example.invalid",
  displayName: "验收用户",
  name: "验收用户",
  role: "user",
  credits: 9999,
  memberStatus: "active",
  themePreference: "coze",
};

function requestPath(input: string): string {
  const url = new URL(input);
  return `${url.pathname}${url.search}`;
}

function requestRecord(route: Route): InterceptedRequest {
  const request = route.request();
  return {
    method: request.method(),
    path: requestPath(request.url()),
    resourceType: request.resourceType(),
  };
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function isModelEndpoint(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  const apiPath = pathname.slice("/api/".length);
  return /(?:^|[\/_-])models?(?:[\/_-]|$)/iu.test(apiPath)
    || /(?:^|[\/_-])(?:model-catalog|model-config|available-models)(?:[\/_-]|$)/iu.test(apiPath);
}

function isGenerationEndpoint(pathname: string): boolean {
  return /\/api\/[^?]*(?:generate|generation|render|comfy|seedance|image-gen|video-task|music-task|workflow-run)/iu.test(pathname);
}

function isPaidEndpoint(pathname: string): boolean {
  return /\/api\/[^?]*(?:charge|billing|payment|recharge|deduct|consume-credit|purchase)/iu.test(pathname);
}

function safeJsonBody(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractMessageEvidence(body: Record<string, unknown> | null): Pick<LlmFixtureCall, "messageRoles" | "userTexts"> {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const messageRoles: string[] = [];
  const userTexts: string[] = [];
  for (const candidate of messages) {
    if (!candidate || typeof candidate !== "object") continue;
    const message = candidate as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";
    messageRoles.push(role);
    if (role !== "user") continue;
    if (typeof message.content === "string") {
      userTexts.push(message.content);
      continue;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const record = part as Record<string, unknown>;
          return typeof record.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n");
      if (text) userTexts.push(text);
    }
  }
  return { messageRoles, userTexts };
}

function jsonFixture(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });
}

function existingConversationSummary() {
  return {
    id: EXISTING_CONVERSATION_ID,
    agent_id: MANGA_AGENT_ID,
    title: "既有验收会话",
    last_message: "既有助手回复",
    created_at: "2026-08-23T08:00:00.000Z",
    updated_at: "2026-08-23T08:01:00.000Z",
  };
}

function existingConversationMessages() {
  return [
    {
      id: "existing-user-message",
      role: "user",
      content: "既有用户消息",
      created_at: "2026-08-23T08:00:00.000Z",
    },
    {
      id: "existing-assistant-message",
      role: "assistant",
      content: "既有助手回复",
      agent_id: MANGA_AGENT_ID,
      agent_name: "漫剧创作 Agent",
      created_at: "2026-08-23T08:01:00.000Z",
    },
  ];
}

async function createSafeContext(browser: Browser, safety: SafetyEvidence, options: ContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport || DESKTOP_VIEWPORT,
    reducedMotion: "reduce",
  });

  if (options.authenticated) {
    await context.addInitScript(({ user }) => {
      try {
        const payload = btoa(JSON.stringify({ userId: user.id, exp: 4_102_444_800 }))
          .replace(/\+/gu, "-")
          .replace(/\//gu, "_")
          .replace(/=+$/gu, "");
        localStorage.setItem("auth_token", `e30.${payload}.e2e`);
        localStorage.setItem("auth_user", JSON.stringify(user));
      } catch {
        // Storage is not available on about:blank; it is available after navigation.
      }
    }, { user: fakeUser });
  }

  context.on("page", (page) => {
    page.on("pageerror", (error) => {
      safety.pageErrors.push({ url: page.url(), message: error.message });
    });
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method().toUpperCase();
    const record = requestRecord(route);

    if (url.origin !== baseOrigin) {
      safety.externalRequests.push(record);
      if (options.blockExternal !== false) {
        if (request.resourceType() === "image") {
          await route.fulfill({ status: 204, body: "" });
        } else if (["media", "font"].includes(request.resourceType())) {
          await route.abort("blockedbyclient");
        } else {
          await route.abort("blockedbyclient");
        }
        return;
      }
      await route.continue();
      return;
    }

    if (pathname === "/api/llm" && method === "POST") {
      const body = safeJsonBody(request.postData());
      const messageEvidence = extractMessageEvidence(body);
      safety.llmFixtureCalls.push({ method, path: requestPath(request.url()), body, ...messageEvidence });
      const latestUserText = messageEvidence.userTexts.at(-1) || "";
      const proposal = latestUserText.includes("雨夜宠物咖啡馆插画")
        ? { type: "generate_image", command: "/image-prompt", prompt: "生成一张雨夜宠物咖啡馆插画" }
        : latestUserText.includes("宠物城市夜景视频")
          ? { type: "generate_video", command: "/video-prompt", prompt: "生成一段 5 秒宠物城市夜景视频" }
          : latestUserText.includes("轻快治愈的宠物歌曲")
            ? { type: "generate_music", command: "/music-prompt", prompt: "创作一首轻快治愈的宠物歌曲" }
            : null;
      const machineEnvelope = proposal
        ? `\n<!-- manju_skill_output:v1\n${JSON.stringify({
          schema_version: "manju_skill_output.v1",
          artifact_type: "manju_skill_output",
          skill: {
            id: proposal.command.slice(1),
            command: proposal.command,
            version: "1.0.0",
            selection: "automatic",
            provenance: "internal_original",
          },
          status: "tool_proposed",
          result: { kind: "prompt_text", payload: proposal.prompt },
          tool_proposals: [{
            type: proposal.type,
            reason: "将已完成的提示词交给对应工作台，由用户确认模型和费用后提交。",
            input: { prompt: proposal.prompt },
            requires_authorization: true,
          }],
          quality: {
            passed: true,
            score: 100,
            hard_constraints_satisfied: ["只提出工具交接，不创建媒体任务，不扣费"],
            issues: [],
          },
        })}\n-->`
        : "";
      const chunks = proposal
        ? ["本地 fixture 已生成安全的工作台交接提案。", machineEnvelope]
        : ["这是本地 SSE 验收回复，", "不调用任何外部模型。"];
      const stream = chunks
        .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        .join("") + "data: [DONE]\n\n";
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
        body: stream,
      });
      return;
    }

    if (isModelEndpoint(pathname)) {
      safety.interceptedModelEndpoints.push(record);
      if (pathname === "/api/youcai/chat-models") {
        await jsonFixture(route, {
          models: [{
            id: TEXT_MODEL_ID,
            displayName: "E2E 文案模型",
            variantLabel: "本地 fixture",
          }],
          policy: {
            defaultModelId: TEXT_MODEL_ID,
            selection: "published-visible-text-compatible",
            fallback: "block-send-no-compatible-model",
            unavailableMessage: "本地验收模型目录",
          },
        });
      } else {
        await jsonFixture(route, { models: [], data: [], items: [] });
      }
      return;
    }

    if (method === "GET" && pathname === "/api/announcements") {
      await jsonFixture(route, { announcements: [] });
      return;
    }

    if (options.authenticated && method === "GET") {
      if (pathname === "/api/auth/me") {
        await jsonFixture(route, { user: fakeUser });
        return;
      }
      if (pathname === "/api/settings") {
        await jsonFixture(route, { settings: { theme: "coze" } });
        return;
      }
      if (pathname === "/api/settings/layout") {
        await jsonFixture(route, { layout: null });
        return;
      }
      if (pathname === "/api/bots") {
        await jsonFixture(route, { agents: [] });
        return;
      }
      if (pathname === "/api/credits") {
        await jsonFixture(route, { credits: 9999, cashBalance: 0 });
        return;
      }
      if (pathname === "/api/conversations/history") {
        if (url.searchParams.has("id")) {
          await jsonFixture(route, {
            conversation: {
              ...existingConversationSummary(),
              messages: existingConversationMessages(),
            },
            messages: existingConversationMessages(),
          });
        } else {
          await jsonFixture(route, { conversations: [existingConversationSummary()] });
        }
        return;
      }
    }

    if (isWriteMethod(method)) {
      safety.interceptedWrites.push(record);
      if (isGenerationEndpoint(pathname)) safety.forbiddenGenerationRequests.push(record);
      if (isPaidEndpoint(pathname)) safety.forbiddenPaidRequests.push(record);
      await jsonFixture(route, { success: true, fixture: true });
      return;
    }

    await route.continue();
  });

  return context;
}

async function gotoStable(page: Page, routePath: string): Promise<void> {
  const response = await page.goto(`${baseUrl}${routePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  assert(response, `导航 ${routePath} 没有返回响应`);
  assert(response.status() < 500, `${routePath} 返回 ${response.status()}`);
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
}

async function screenshot(page: Page, fileName: string, report: DeepE2eReport): Promise<void> {
  const destination = path.join(evidenceDir, fileName);
  await page.screenshot({ path: destination, fullPage: false, animations: "disabled" });
  report.screenshots.push(destination);
}

async function assertNoErrorBoundary(page: Page, routePath: string): Promise<void> {
  const bodyText = await page.locator("body").innerText();
  for (const phrase of ERROR_BOUNDARY_PHRASES) {
    assert(!bodyText.includes(phrase), `${routePath} 出现错误边界文案：${phrase}`);
  }
  assert(!/(^|\s)404(\s|$)/u.test(bodyText), `${routePath} 出现 404 文案`);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
    return Math.max(0, width - window.innerWidth);
  });
}

async function auditMainSite(browser: Browser, report: DeepE2eReport): Promise<void> {
  const safety = report.safety;
  const context = await createSafeContext(browser, safety, { blockExternal: true });
  await context.addInitScript(() => {
    try {
      sessionStorage.setItem("entered_app", "1");
    } catch {
      // Ignore unavailable storage before the origin is established.
    }
  });
  const page = await context.newPage();
  try {
    await gotoStable(page, "/");
    const cards = page.locator('[aria-label^="打开智能体："]');
    let cardsReady = false;
    for (let attempt = 0; attempt < 2 && !cardsReady; attempt += 1) {
      cardsReady = await page.waitForFunction(
        () => document.querySelectorAll('[aria-label^="打开智能体："]').length >= 70,
        undefined,
        { timeout: 30_000 },
      ).then(() => true).catch(() => false);
      if (!cardsReady) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
      }
    }
    assert(cardsReady, "主站智能体卡片连续两次均未加载完成");
    await cards.first().waitFor({ state: "visible" });
    const cardCount = await cards.count();
    assert.equal(cardCount, 70, `主站智能体卡片应为 70，实际 ${cardCount}`);

    const topNav = page.locator("button.nav-pill");
    await topNav.first().waitFor({ state: "visible" });
    const topNavLabels = (await topNav.allInnerTexts()).map((text) => text.trim()).filter(Boolean);
    assert.equal(topNavLabels.length, 10, `主站顶栏应为 10 项，实际 ${topNavLabels.length}`);
    const coverIndex = topNavLabels.indexOf("封面制作");
    const mangaIndex = topNavLabels.indexOf("漫剧工作台");
    assert(coverIndex >= 0, "主站顶栏缺少封面制作");
    assert.equal(mangaIndex, coverIndex + 1, "漫剧工作台必须紧跟封面制作");

    await topNav.filter({ hasText: /^漫剧工作台$/u }).click();
    await page.waitForURL((url) => url.pathname === "/youcai", { timeout: 15_000 });
    assert.equal(new URL(page.url()).pathname, "/youcai", "漫剧工作台没有进入 /youcai");
    await assertNoErrorBoundary(page, "/youcai");
    await screenshot(page, "01-main-to-manju.png", report);

    report.mainSite = {
      agentCardCount: cardCount,
      topNavCount: topNavLabels.length,
      topNavLabels,
      coverIndex,
      mangaIndex,
      mangaDestination: new URL(page.url()).pathname,
    };
  } finally {
    await closeWithTimeout(context, "main-site context.close");
  }
}

async function findAndMoveVerticalScroller(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => {
    const candidates = [document.scrollingElement, ...Array.from(document.querySelectorAll<HTMLElement>("main, section, div"))]
      .filter((element): element is HTMLElement => Boolean(element));
    for (const element of candidates) {
      const style = getComputedStyle(element);
      const allowsScroll = /(auto|scroll|overlay)/u.test(style.overflowY)
        || element === document.scrollingElement;
      if (!allowsScroll || element.scrollHeight <= element.clientHeight + 2) continue;
      const before = element.scrollTop;
      const previousScrollBehavior = element.style.scrollBehavior;
      element.style.scrollBehavior = "auto";
      element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight);
      const after = element.scrollTop;
      element.style.scrollBehavior = previousScrollBehavior;
      if (after > before) {
        return {
          tag: element.tagName,
          before,
          after,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        };
      }
    }
    return { tag: "", before: 0, after: 0, clientHeight: 0, scrollHeight: 0 };
  });
}

async function auditNavigation(browser: Browser, report: DeepE2eReport): Promise<void> {
  const safety = report.safety;
  const context = await createSafeContext(browser, safety, { blockExternal: true });
  const page = await context.newPage();
  try {
    const pageErrorStart = safety.pageErrors.length;
    await gotoStable(page, "/youcai");
    await assertNoErrorBoundary(page, "/youcai");
    assert.equal(
      safety.pageErrors.length,
      pageErrorStart,
      `漫剧首页出现 pageerror：${JSON.stringify(safety.pageErrors.slice(pageErrorStart))}`,
    );

    const retiredLinks = await page.locator('a[href*="/creative-horizon"], a[href$="/navigation"]').count();
    assert.equal(retiredLinks, 0, "漫剧导航仍显示已退役的视界杯或资源导航入口");

    const redirects: Array<{ path: string; status: number; finalPath: string }> = [];
    for (const path of ["/youcai/creative-horizon", "/youcai/navigation", "/creative-horizon", "/navigation"]) {
      const response = await page.goto(new URL(path, baseOrigin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const finalPath = new URL(page.url()).pathname;
      redirects.push({ path, status: response?.status() || 0, finalPath });
      assert.equal(finalPath, "/youcai", `已退役地址没有回到漫剧首页：${path} -> ${finalPath}`);
    }
    await gotoStable(page, "/youcai");
    await screenshot(page, "02-retired-navigation-removed.png", report);

    report.navigation = {
      retiredLabels: ["视界杯", "资源导航"],
      retiredLinksVisible: retiredLinks,
      redirects,
      pageErrors: safety.pageErrors.slice(pageErrorStart),
    };
  } finally {
    await closeWithTimeout(context, "navigation context.close");
  }
}

async function clearCanvasHandoff(page: Page): Promise<void> {
  await page.evaluate(({ localKeys, sessionKey }) => {
    for (const key of localKeys) localStorage.removeItem(key);
    sessionStorage.removeItem(sessionKey);
  }, { localKeys: [...CANVAS_STORAGE_KEYS], sessionKey: SHOWCASE_HANDOFF_KEY });
}

async function moveShowcaseViewport(page: Page, viewport: Locator): Promise<boolean> {
  const stage = viewport.locator('[data-canvas-transform="true"]');
  const before = await stage.getAttribute("style");
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole("button", { name: "放大", exact: true }).click();
  }
  const box = await viewport.boundingBox();
  assert(box, "案例画布缺少可交互区域");
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35, { steps: 4 });
  await page.mouse.up();
  const after = await stage.getAttribute("style");
  return Boolean(before && after && before !== after);
}

async function auditCanvas(browser: Browser, report: DeepE2eReport): Promise<void> {
  const safety = report.safety;
  const context = await createSafeContext(browser, safety, { blockExternal: true });
  const page = await context.newPage();
  try {
    await gotoStable(page, "/youcai/tools/canvas");
    await page.locator('[data-testid="official-canvas-page"]').waitFor({ state: "visible", timeout: 20_000 });
    await assertNoErrorBoundary(page, "/youcai/tools/canvas");
    const bannerVideo = page.getByLabel("多模态节点工作流循环视频");
    await bannerVideo.waitFor({ state: "attached" });
    const bannerBeforePlay = await bannerVideo.evaluate((element) => {
      const video = element as HTMLVideoElement;
      return {
        autoplay: video.autoplay,
        muted: video.muted,
        loop: video.loop,
        playsInline: video.playsInline,
        preload: video.preload,
        poster: video.poster,
        sourceCount: video.querySelectorAll("source").length,
      };
    });
    assert.equal(bannerBeforePlay.autoplay, false, "画布横幅不应在用户操作前自动下载视频");
    assert.equal(bannerBeforePlay.preload, "none", "画布横幅播放前必须禁用视频预载");
    assert.equal(bannerBeforePlay.sourceCount, 0, "画布横幅播放前不得挂载 13 MB 视频源");
    assert.equal(new URL(bannerBeforePlay.poster).origin, baseOrigin, "画布视频 poster 不是本地源");

    await page.getByRole("button", { name: "播放画布创作演示" }).click();
    const activeBannerVideo = page.getByLabel("多模态节点工作流循环视频");
    await activeBannerVideo.locator("source").waitFor({ state: "attached" });
    const banner = await activeBannerVideo.evaluate((element) => {
      const video = element as HTMLVideoElement;
      return {
        autoplay: video.autoplay,
        muted: video.muted,
        loop: video.loop,
        playsInline: video.playsInline,
        poster: video.poster,
        sources: Array.from(video.querySelectorAll("source")).map((source) => ({
          src: source.src,
          type: source.type,
        })),
      };
    });
    assert.equal(banner.autoplay, true, "画布顶部视频缺少 autoplay");
    assert.equal(banner.muted, true, "画布顶部视频缺少 muted");
    assert.equal(banner.loop, true, "画布顶部视频缺少 loop");
    assert.equal(banner.playsInline, true, "画布顶部视频缺少 playsinline");
    assert.equal(new URL(banner.poster).origin, baseOrigin, "画布视频 poster 不是本地源");
    assert(banner.sources.length >= 1, "画布顶部视频至少应提供一个本地可播放源");
    for (const source of banner.sources) {
      assert.equal(new URL(source.src).origin, baseOrigin, `画布视频不是本地源：${source.src}`);
    }
    assert(
      banner.sources.some((source) => source.type.includes("mp4") || source.type.includes("webm")),
      "画布视频缺少浏览器可识别的 mp4/webm 源",
    );
    const localMediaStatuses: Array<{ path: string; status: number }> = [];
    for (const href of [banner.poster, ...banner.sources.map((source) => source.src)]) {
      const response = await context.request.get(href, { failOnStatusCode: false });
      localMediaStatuses.push({ path: requestPath(href), status: response.status() });
      assert(
        response.status() >= 200 && response.status() < 400,
        `画布本地视频素材不可访问：${requestPath(href)} (${response.status()})`,
      );
    }
    await page.getByRole("button", { name: "停止画布创作演示并释放视频流量" }).click();
    assert.equal(await page.getByLabel("多模态节点工作流循环视频").locator("source").count(), 0, "停止演示后应卸载视频源");

    const showcaseCards = page.locator('section[aria-labelledby="showcase-heading"] [data-showcase-id]');
    await showcaseCards.first().waitFor({ state: "visible" });
    assert.equal(await showcaseCards.count(), 4, "画布入口必须有 4 个独立案例");
    const showcaseHrefs = await showcaseCards.evaluateAll((cards) => cards.map((card) => {
      if (card instanceof HTMLAnchorElement) return card.href;
      return card.querySelector<HTMLAnchorElement>('a[href*="/share/canvas/"]')?.href || "";
    }));
    assert.equal(new Set(showcaseHrefs).size, 4, "4 个画布案例必须指向 4 个独立页面");
    for (const href of showcaseHrefs) {
      assert(href, "画布案例缺少链接");
      const url = new URL(href);
      assert.equal(url.origin, baseOrigin, `画布案例不是站内链接：${href}`);
      assert(url.pathname.startsWith("/youcai/share/canvas/"), `画布案例没有分支前缀：${href}`);
      assert(!/^\/youcai\/youcai(?:\/|$)/u.test(url.pathname), `画布案例出现双前缀：${href}`);
    }
    await screenshot(page, "03-canvas-home.png", report);
    report.canvas.banner = { beforePlay: bannerBeforePlay, afterPlay: banner, localMediaStatuses };

    for (let index = 0; index < showcaseHrefs.length; index += 1) {
      const href = showcaseHrefs[index];
      await clearCanvasHandoff(page);
      await gotoStable(page, requestPath(href));
      await assertNoErrorBoundary(page, new URL(href).pathname);
      const nodes = page.locator("[data-node-id]");
      await nodes.first().waitFor({ state: "visible", timeout: 20_000 });
      const detailNodes = await nodes.count();
      const videoNodes = await page.locator('[data-node-id][data-kind="video"]').count();
      assert(detailNodes > 0, `案例 ${href} 没有工作流节点`);

      const canvasViewport = page.locator('section[aria-label="只读工作流画布"]');
      await canvasViewport.waitFor({ state: "visible" });
      const detailEdges = await canvasViewport.locator('svg path[marker-end]').count();
      assert(detailEdges > 0, `案例 ${href} 没有连线`);

      assert.equal(await canvasViewport.getAttribute("data-canvas-viewport"), "transform", `案例 ${href} 未启用变换式画布`);
      const scrolled = await moveShowcaseViewport(page, canvasViewport);
      assert(scrolled, `案例 ${href} 放大后仍不能平移画布`);
      await canvasViewport.getByRole("button", { name: "适配视图", exact: true }).click();

      await page.getByRole("button", { name: "列表视图", exact: true }).click();
      const listView = page.locator('section[aria-label="只读工作流列表"]');
      await listView.waitFor({ state: "visible" });
      const listNodes = await listView.locator("[data-node-id]").count();
      assert.equal(listNodes, detailNodes, `案例 ${href} 列表节点数与画布不一致`);
      await page.getByRole("button", { name: "画布视图", exact: true }).click();
      await page.locator('section[aria-label="只读工作流画布"]').waitFor({ state: "visible" });

      const title = (await page.locator("h1").first().innerText()).trim();
      await screenshot(page, `04-showcase-${index + 1}.png`, report);
      await page.getByRole("button", { name: /复制并继续创作/u }).click();
      await page.waitForURL(
        (url) => url.pathname === "/youcai/free-canvas" && url.searchParams.get("showcase") === new URL(href).pathname.split("/").at(-1),
        { timeout: 20_000, waitUntil: "domcontentloaded" },
      );
      const flowCount = page.locator(".flow-count");
      await flowCount.waitFor({ state: "visible", timeout: 30_000 });
      const flowText = await flowCount.innerText();
      const flowDeclared = flowText.match(/(\d+)\s*节点\s*·\s*(\d+)\s*连线/u);
      assert(flowDeclared, `案例 ${href} 复制后缺少 free-canvas 节点/连线计数`);
      const freeCanvasNodes = await page.locator(".react-flow__node").count();
      const freeCanvasEdges = await page.locator(".react-flow__edge").count();
      assert.equal(Number(flowDeclared[1]), detailNodes, `案例 ${href} 复制后节点计数丢失`);
      assert.equal(Number(flowDeclared[2]), detailEdges, `案例 ${href} 复制后连线计数丢失`);
      assert.equal(freeCanvasNodes, detailNodes, `案例 ${href} free-canvas 节点 DOM 不完整`);
      assert.equal(freeCanvasEdges, detailEdges, `案例 ${href} free-canvas 连线 DOM 不完整`);
      await page.locator(".react-flow__controls").waitFor({ state: "visible" });
      await screenshot(page, `05-free-canvas-${index + 1}.png`, report);

      report.canvas.showcases.push({
        href,
        title,
        detailNodes,
        videoNodes,
        detailEdges,
        listNodes,
        scrolled,
        copiedPath: requestPath(page.url()),
        freeCanvasNodes,
        freeCanvasEdges,
      });
    }

    assert.equal(safety.forbiddenGenerationRequests.length, 0, "画布验收触发了生成接口");
    assert.equal(safety.forbiddenPaidRequests.length, 0, "画布验收触发了付费接口");
  } finally {
    await closeWithTimeout(context, "canvas context.close");
  }
}

async function waitForCompleteAssistant(page: Page, expectedMinimum: number): Promise<void> {
  await page.waitForFunction((minimum) => {
    const complete = Array.from(document.querySelectorAll('[data-role="assistant"]'))
      .filter((element) => element.getAttribute("data-message-status") === "complete")
      .filter((element) => (element.textContent || "").includes("本地 SSE 验收回复"));
    return complete.length >= Number(minimum);
  }, expectedMinimum, { timeout: 20_000 });
}

async function assertMessageLabels(page: Page): Promise<Record<string, number>> {
  const actualUserRows = page.locator('[data-testid="official-agent-real-chat"] article[data-role="user"]');
  const assistantRows = page.locator('[data-testid="official-agent-real-chat"] article[data-role="assistant"]');
  assert(await actualUserRows.count() > 0, "Agent 对话缺少用户消息");
  assert(await assistantRows.count() > 0, "Agent 对话缺少 assistant 消息");
  for (let index = 0; index < await actualUserRows.count(); index += 1) {
    const lines = (await actualUserRows.nth(index).innerText()).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    assert.equal(lines.filter((line) => line === "你").length, 0, "用户消息出现重复“你”标签");
    assert.equal(lines.filter((line) => line === "我").length, 1, "用户消息“我”标签缺失或重复");
  }
  for (let index = 0; index < await assistantRows.count(); index += 1) {
    const lines = (await assistantRows.nth(index).innerText()).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    assert.equal(lines.filter((line) => line === "你" || line === "我").length, 0, "assistant 消息出现多余“你/我”标签");
  }
  return { userRows: await actualUserRows.count(), assistantRows: await assistantRows.count() };
}

async function inspectHandoff(page: Page, skill: "image" | "video" | "music", prompt: string): Promise<Record<string, unknown>> {
  const expected: Record<"image" | "video" | "music", { path: string; key: string; storage: "local" | "session" }> = {
    image: { path: "/youcai/tools/image/image-chat", key: "agent_hub_image_workbench_transfer_session_v1", storage: "session" },
    video: { path: "/youcai/video", key: "agent_hub_video_task_transfer_v1", storage: "session" },
    music: { path: "/youcai/tools/audio/minimax-music", key: "youcai_music_brief_prefill_v1", storage: "session" },
  };
  const target = expected[skill];
  await page.waitForFunction(
    (expectedPath) => window.location.pathname === expectedPath,
    target.path,
    { timeout: 20_000 },
  );
  const state = await page.evaluate(({ key, storage, expectedPrompt }) => {
    const value = storage === "local" ? localStorage.getItem(key) : sessionStorage.getItem(key);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
    const prefilled = inputs.some((input) => input.value.includes(expectedPrompt));
    return { value, prefilled };
  }, { key: target.key, storage: target.storage, expectedPrompt: prompt });
  assert(
    (typeof state.value === "string" && state.value.includes(prompt)) || state.prefilled,
    `${skill} 路由成功但预填内容没有保留`,
  );
  return { skill, prompt, destination: target.path, storageKey: target.key, storageValue: state.value, prefilled: state.prefilled };
}

async function auditAgent(browser: Browser, report: DeepE2eReport): Promise<void> {
  const safety = report.safety;
  const context = await createSafeContext(browser, safety, { authenticated: true, blockExternal: true });
  const page = await context.newPage();
  try {
    await gotoStable(page, "/youcai/tools/text/text-chat");
    await page.locator('[data-testid="official-agent-page"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.getByLabel("选择创作模型").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="选择创作模型"]');
      return Boolean(select && !select.disabled && select.value);
    }, undefined, { timeout: 15_000 });

    await page.getByRole("button", { name: "新对话", exact: true }).click();
    await page.locator('[data-testid="official-agent-real-chat"]').waitFor({ state: "visible" });
    const firstPrompt = "请写一段宠物漫剧的开场文案，只进行文本对话验收";
    await page.getByRole("textbox", { name: "创作需求", exact: true }).fill(firstPrompt);
    await page.getByRole("button", { name: "发送创作需求", exact: true }).click();
    await waitForCompleteAssistant(page, 1);
    const firstLabels = await assertMessageLabels(page);
    assert.equal(safety.llmFixtureCalls.length, 1, "首次文本发送没有且仅有一次 /api/llm fixture 调用");
    const firstCall = safety.llmFixtureCalls[0];
    assert.equal(firstCall.body?.modelId, TEXT_MODEL_ID, "Agent 没有使用 fixture 文案模型");
    assert.deepEqual(firstCall.messageRoles, ["user"], "客户端只能提交用户消息，系统 Prompt 必须由服务端按 Agent/Skill 治理配置注入");
    assert(firstCall.userTexts.some((text) => text.includes(firstPrompt)), "Agent 请求体缺少首次用户文案");
    assert(firstCall.userTexts.some((text) => text.includes('authority="client_hint_only"')), "Agent 请求体缺少不可信客户端提示边界");
    assert.equal(firstCall.body?.agentId, MANGA_AGENT_ID, "Agent 请求没有携带服务端 Prompt 治理所需的漫剧 Agent 标识");
    assert((await page.locator('[data-role="assistant"]').last().innerText()).includes(SSE_FIXTURE_TEXT), "Agent 没有展示完整 SSE fixture 回复");
    await screenshot(page, "06-agent-first-turn.png", report);

    const existingConversation = page.getByRole("button", { name: /既有验收会话/u });
    await existingConversation.waitFor({ state: "visible" });
    await existingConversation.click();
    await page.locator('[data-role="assistant"]').getByText("既有助手回复", { exact: true }).waitFor({ state: "visible" });
    const existingPrompt = "继续既有会话，只做文本链路验收";
    await page.getByRole("textbox", { name: "创作需求", exact: true }).fill(existingPrompt);
    await page.getByRole("button", { name: "发送创作需求", exact: true }).click();
    await page.waitForFunction((prompt) => {
      const userRows = Array.from(document.querySelectorAll('[data-role="user"]'));
      const assistantRows = Array.from(document.querySelectorAll('[data-role="assistant"]'));
      return userRows.some((row) => (row.textContent || "").includes(String(prompt)))
        && assistantRows.some((row) => (row.textContent || "").includes("本地 SSE 验收回复"));
    }, existingPrompt, { timeout: 20_000 });
    assert.equal(safety.llmFixtureCalls.length, 2, "既有会话文本发送没有命中第二次 /api/llm fixture");
    const existingCall = safety.llmFixtureCalls[1];
    assert(existingCall.userTexts.some((text) => text.includes("既有用户消息")), "既有会话请求体没有带入历史用户消息");
    assert(existingCall.userTexts.some((text) => text.includes(existingPrompt)), "既有会话请求体没有当前用户消息");
    const existingLabels = await assertMessageLabels(page);
    await screenshot(page, "07-agent-existing-conversation.png", report);

    const handoffs: Record<string, unknown>[] = [];
    const handoffTests = [
      { skill: "image" as const, prompt: "生成一张雨夜宠物咖啡馆插画", button: "带入图片工作台" },
      { skill: "video" as const, prompt: "生成一段 5 秒宠物城市夜景视频", button: "带入视频工作台" },
      { skill: "music" as const, prompt: "创作一首轻快治愈的宠物歌曲", button: "带入音乐工作台" },
    ];
    for (const test of handoffTests) {
      await gotoStable(page, "/youcai/tools/text/text-chat");
      const conversation = page.getByRole("button", { name: /既有验收会话/u });
      await conversation.waitFor({ state: "visible" });
      await conversation.click();
      await page.locator('[data-role="assistant"]').getByText("既有助手回复", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("textbox", { name: "创作需求", exact: true }).fill(test.prompt);
      const llmBefore: number = safety.llmFixtureCalls.length;
      await page.getByRole("button", { name: "发送创作需求", exact: true }).click();
      await page.getByRole("button", { name: test.button, exact: true }).waitFor({ state: "visible", timeout: 20_000 });
      await page.getByRole("button", { name: test.button, exact: true }).click();
      handoffs.push(await inspectHandoff(page, test.skill, test.prompt));
      assert.equal(safety.llmFixtureCalls.length, llmBefore + 1, `${test.skill} 提示词与工具提案必须且只能命中一次本地 /api/llm fixture`);
    }

    assert.equal(safety.forbiddenGenerationRequests.length, 0, "Agent 路由验收意外触发生成接口");
    assert.equal(safety.forbiddenPaidRequests.length, 0, "Agent 路由验收意外触发付费接口");
    report.agent = {
      modelId: TEXT_MODEL_ID,
      fixtureText: SSE_FIXTURE_TEXT,
      firstTurn: { prompt: firstPrompt, labels: firstLabels },
      existingConversation: { id: EXISTING_CONVERSATION_ID, prompt: existingPrompt, labels: existingLabels },
      llmFixtureCallCount: safety.llmFixtureCalls.length,
      handoffs,
    };
  } finally {
    await closeWithTimeout(context, "agent context.close");
  }
}

async function auditHorizontalScroller(page: Page, ariaLabel: string): Promise<NonNullable<MobileEvidence["categoryScroller"]>> {
  const locator = page.getByLabel(ariaLabel, { exact: true });
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  const result = await locator.evaluate((element) => {
    const target = element as HTMLElement;
    const style = getComputedStyle(target);
    target.scrollLeft = Math.min(80, Math.max(0, target.scrollWidth - target.clientWidth));
    return {
      overflowX: style.overflowX,
      clientWidth: target.clientWidth,
      scrollWidth: target.scrollWidth,
      scrollLeft: target.scrollLeft,
    };
  });
  assert(/auto|scroll|overlay/u.test(result.overflowX), `${ariaLabel} 没有横向滚动样式`);
  assert(result.scrollWidth > result.clientWidth + 1, `${ariaLabel} 在 390px 下没有形成可滚动内容`);
  assert(result.scrollLeft > 0, `${ariaLabel} 在 390px 下不能横向滚动`);
  return { ariaLabel, ...result };
}

async function auditMobile(browser: Browser, report: DeepE2eReport): Promise<void> {
  const context = await createSafeContext(browser, report.safety, {
    viewport: MOBILE_VIEWPORT,
    blockExternal: true,
  });
  const page = await context.newPage();
  try {
    for (const route of MOBILE_ROUTES) {
      await gotoStable(page, route.path);
      await assertNoErrorBoundary(page, route.path);
      const overflow = await horizontalOverflow(page);
      assert(overflow <= 2, `${route.path} 在 390x844 下横向页面溢出 ${overflow}px`);
      const categoryScroller = "scroller" in route && route.scroller
        ? await auditHorizontalScroller(page, route.scroller)
        : undefined;
      const entry: MobileEvidence = {
        path: route.path,
        horizontalOverflow: overflow,
        ...(categoryScroller ? { categoryScroller } : {}),
      };
      report.mobile.push(entry);
      await screenshot(page, `08-mobile-${route.name}.png`, report);
    }
  } finally {
    await closeWithTimeout(context, "mobile context.close");
  }
}

async function auditSignedOutAssets(browser: Browser, report: DeepE2eReport): Promise<void> {
  const context = await createSafeContext(browser, report.safety, { blockExternal: true });
  const page = await context.newPage();
  try {
    await gotoStable(page, "/youcai/assets");
    await assertNoErrorBoundary(page, "/youcai/assets");
    const signedOutState = page.getByText("登录后查看你的资产", { exact: true });
    await signedOutState.waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("link", { name: "去登录", exact: true }).waitFor({ state: "visible" });
    const assetCards = page.locator('section[aria-live="polite"] article');
    assert.equal(await assetCards.count(), 0, "未登录资产页不应渲染空白占位卡");
    const blankArticles = await page.locator("article").evaluateAll((articles) => articles.filter((article) => {
      const box = article.getBoundingClientRect();
      return box.width > 1 && box.height > 1 && !(article.textContent || "").trim();
    }).length);
    assert.equal(blankArticles, 0, "未登录资产页存在可见空白 article");
    await screenshot(page, "09-assets-signed-out.png", report);
    report.assets = {
      signedOutMessage: await signedOutState.innerText(),
      assetCardCount: await assetCards.count(),
      visibleBlankArticleCount: blankArticles,
    };
  } finally {
    await closeWithTimeout(context, "assets context.close");
  }
}

async function main(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  const safety: SafetyEvidence = {
    interceptedWrites: [],
    interceptedModelEndpoints: [],
    forbiddenGenerationRequests: [],
    forbiddenPaidRequests: [],
    externalRequests: [],
    llmFixtureCalls: [],
    pageErrors: [],
  };
  const report: DeepE2eReport = {
    ok: false,
    baseUrl,
    generatedAt: new Date().toISOString(),
    safeguards: {
      noPaidOrGenerationCallsAllowed: true,
      llmUsesLocalSseFixture: true,
      externalResourcesAreNotAcceptanceDependencies: true,
    },
    mainSite: {},
    navigation: {},
    canvas: { banner: {}, showcases: [] },
    agent: {},
    mobile: [],
    assets: {},
    safety,
    screenshots: [],
  };

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    await auditMainSite(browser, report);
    await auditNavigation(browser, report);
    await auditCanvas(browser, report);
    await auditAgent(browser, report);
    await auditMobile(browser, report);
    await auditSignedOutAssets(browser, report);

    assert.equal(safety.forbiddenGenerationRequests.length, 0, "验收过程中触发了禁止的生成写接口");
    assert.equal(safety.forbiddenPaidRequests.length, 0, "验收过程中触发了禁止的付费写接口");
    report.ok = true;
  } catch (error) {
    report.failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ""}` : String(error);
    process.exitCode = 1;
  } finally {
    if (browser) await closeWithTimeout(browser, "browser.close");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    reportPath,
    screenshots: report.screenshots.length,
    mainCards: report.mainSite.agentCardCount,
    mainNav: report.mainSite.topNavCount,
    showcases: report.canvas.showcases.length,
    llmFixtureCalls: safety.llmFixtureCalls.length,
    forbiddenGenerationRequests: safety.forbiddenGenerationRequests.length,
    forbiddenPaidRequests: safety.forbiddenPaidRequests.length,
    failure: report.failure,
  }, null, 2)}\n`);
}

void main().then(
  () => process.exit(Number(process.exitCode || 0)),
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  },
);
