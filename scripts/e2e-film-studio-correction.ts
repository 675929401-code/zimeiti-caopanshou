import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Route,
} from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.FILM_STUDIO_E2E_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const evidenceDir = path.join(
  process.cwd(),
  ".codex-evidence",
  "film-studio-correction-20260823",
);
const reportPath = path.join(evidenceDir, "e2e-film-studio-correction.json");

const OFFICIAL_COPY = {
  title: /从故事到成片.*每一步都能回改/,
  subtitle: "影视工坊负责组织剧本、角色、场景、道具、分镜和视频入口；实际生成继续复用主站现有工作台与服务端能力。",
  steps: ["剧本", "角色", "场景", "道具", "分镜", "视频"],
  entries: {
    drama: {
      title: "爽剧",
      description: "从冲突、反转和情绪回报出发，先完成可编辑剧本，再进入分镜工作台。",
      path: "/storyboard-workbench",
      mode: "爽剧",
      testId: "",
    },
    general: {
      title: "短剧",
      description: "适合口播、知识、萌宠和品牌故事，将文案拆成画面与视频提示结构。",
      path: "/storyboard-workbench",
      mode: "通用短剧",
      testId: "",
    },
    long: {
      title: "正剧",
      description: "独立正剧生成与项目保存后端尚未完成验收，当前暂不可用。",
      testId: "",
    },
    upload: {
      title: "上传剧本",
      description: "进入分镜工作台整理已有剧本；文件解析能力以工作台当前支持范围为准。",
      path: "/storyboard-workbench",
      mode: "upload",
      testId: "",
    },
  },
} as const;

type RiskKind = "model" | "image" | "video" | "billing";

interface RiskCall {
  kind: RiskKind;
  method: string;
  url: string;
}

interface NetworkAudit {
  projectFixtureInterceptions: number;
  riskCalls: RiskCall[];
  externalHttpRequests: Array<{ method: string; url: string; resourceType: string }>;
  apiRequests: Array<{ method: string; path: string }>;
}

interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: Array<{ status: number; url: string; resourceType: string }>;
}

interface OverflowEvidence {
  viewportWidth: number;
  scrollWidth: number;
  overflowPixels: number;
}

interface EntryEvidence {
  title: string;
  tagName: string;
  disabled: boolean;
  href: string | null;
}

interface LocalSession {
  token: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: "admin";
    credits: number;
    cashBalance: number;
  };
}

async function createLocalSession(): Promise<LocalSession> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("users")
    .select("id, username, display_name, credits, cash_balance")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || "找不到可用于影视工坊验收的管理员账号");
  const user = {
    id: String(data.id),
    username: String(data.username),
    displayName: String(data.display_name || "本地验收"),
    role: "admin" as const,
    credits: Number(data.credits || 0),
    cashBalance: Number(data.cash_balance || 0),
  };
  return {
    user,
    token: await createToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
      sessionId: `film-studio-e2e-${randomUUID()}`,
    }),
  };
}

function pathOf(input: string): string {
  try {
    return new URL(input).pathname;
  } catch {
    return input;
  }
}

function isExternalHttp(input: string): boolean {
  try {
    const target = new URL(input);
    const base = new URL(baseUrl);
    return ["http:", "https:"].includes(target.protocol) && target.origin !== base.origin;
  } catch {
    return false;
  }
}

function riskKindFor(request: Request): RiskKind | null {
  const pathname = pathOf(request.url());

  const checks: Array<[RiskKind, RegExp[]]> = [
    [
      "model",
      [
        /^\/api\/llm(?:\/|$)/i,
        /^\/api\/(?:chat|agent\/run|agents\/execute|skills\/execute)(?:\/|$)/i,
        /^\/api\/models?\/(?:invoke|run|generate|execute)(?:\/|$)/i,
      ],
    ],
    [
      "image",
      [
        /^\/api\/(?:image-generation|generate-image)(?:\/|$)/i,
        /^\/api\/images?\/(?:generate|submit|tasks?|jobs?|status|result)(?:\/|$)/i,
        /^\/api\/canvas\/(?:generate|execute|run)(?:\/|$)/i,
      ],
    ],
    [
      "video",
      [
        /^\/api\/(?:video-generation|generate-video)(?:\/|$)/i,
        /^\/api\/videos?\/(?:generate|submit|tasks?|jobs?|status|result)(?:\/|$)/i,
        /^\/api\/canvas\/(?:generate-video|video)(?:\/|$)/i,
      ],
    ],
    [
      "billing",
      [
        /^\/api\/(?:billing|payment|payments|checkout|orders)(?:\/|$)/i,
        /^\/api\/credits\/(?:charge|deduct|consume|settle)(?:\/|$)/i,
      ],
    ],
  ];

  for (const [kind, patterns] of checks) {
    if (patterns.some((pattern) => pattern.test(pathname))) return kind;
  }
  return null;
}

async function installNetworkGuard(
  context: BrowserContext,
  audit: NetworkAudit,
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const pathname = pathOf(request.url());
    const method = request.method();

    if (pathname.startsWith("/api/")) {
      audit.apiRequests.push({ method, path: pathname });
    }

    if (method === "GET" && pathname === "/api/short-drama/projects") {
      audit.projectFixtureInterceptions += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ projects: [] }),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/drama/projects") {
      audit.projectFixtureInterceptions += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ success: true, data: [] }),
      });
      return;
    }

    const riskKind = riskKindFor(request);
    if (riskKind) {
      audit.riskCalls.push({ kind: riskKind, method, url: request.url() });
      await route.abort("blockedbyclient");
      return;
    }

    if (isExternalHttp(request.url())) {
      audit.externalHttpRequests.push({
        method,
        url: request.url(),
        resourceType: request.resourceType(),
      });
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
  });
}

function collectDiagnostics(page: Page): Diagnostics {
  const diagnostics: Diagnostics = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    httpErrors: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.httpErrors.push({
        status: response.status(),
        url: response.url(),
        resourceType: response.request().resourceType(),
      });
    }
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "unknown";
    if (failure === "net::ERR_BLOCKED_BY_CLIENT") return;
    try {
      const parsed = new URL(request.url());
      if (
        failure === "net::ERR_ABORTED"
        && parsed.origin === new URL(baseUrl).origin
        && (
          parsed.searchParams.has("_rsc")
          || (
            request.method() === "GET"
            && ["/api/auth/me", "/api/settings", "/api/settings/layout"].includes(parsed.pathname)
          )
        )
      ) {
        return;
      }
    } catch {
      // Malformed failed URLs remain diagnostic evidence.
    }
    diagnostics.failedRequests.push(`${request.method()} ${request.url()} :: ${failure}`);
  });
  return diagnostics;
}

async function prepareContext(context: BrowserContext, session: LocalSession): Promise<void> {
  await context.addInitScript(({ token, user }) => {
    localStorage.removeItem("general_script_draft_v1");
    localStorage.removeItem("short_drama_general_script_handoff_v1");
    localStorage.removeItem("short_drama_storyboard_handoff_import_v1");
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
    sessionStorage.clear();
    sessionStorage.setItem("entered_app", "1");
  }, session);
}

async function requireResponse200(page: Page, pathname: string): Promise<void> {
  const response = await page.goto(`${baseUrl}${pathname}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.equal(response?.status(), 200, `${pathname} 应返回 200`);
  await page.waitForTimeout(1_200);
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<OverflowEvidence> {
  const evidence = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const scrollWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0,
    );
    return {
      viewportWidth,
      scrollWidth,
      overflowPixels: Math.max(0, scrollWidth - viewportWidth),
    };
  });
  assert.ok(
    evidence.overflowPixels <= 1,
    `${label} 横向溢出 ${evidence.overflowPixels}px（${evidence.scrollWidth}/${evidence.viewportWidth}）`,
  );
  return evidence;
}

async function entryInteractive(
  page: Page,
  testId: string,
  title: string,
): Promise<Locator> {
  if (testId) {
    const stable = page.locator(`[data-testid="${testId}"]`).first();
    if (await stable.count()) return stable;
  }

  const titleNode = page.getByRole("heading", { name: title, exact: true, level: 3 }).first();
  await titleNode.waitFor({ state: "visible", timeout: 30_000 });
  const interactive = titleNode.locator(
    "xpath=ancestor-or-self::*[self::a or self::button][1]",
  ).first();
  if (await interactive.count()) return interactive;
  return titleNode.locator("xpath=ancestor::*[self::article or self::div][1]").first();
}

async function entryEvidence(locator: Locator, title: string): Promise<EntryEvidence> {
  return locator.evaluate((element, entryTitle) => {
    const button = element instanceof HTMLButtonElement ? element : null;
    const anchor = element instanceof HTMLAnchorElement ? element : element.querySelector("a");
    const disabled = Boolean(
      button?.disabled
      || element.getAttribute("aria-disabled") === "true"
      || element.getAttribute("data-disabled") === "true"
      || (!anchor && !(element instanceof HTMLButtonElement)),
    );
    return {
      title: entryTitle,
      tagName: element.tagName,
      disabled,
      href: anchor?.getAttribute("href") || null,
    };
  }, title);
}

async function assertPortalStructure(page: Page): Promise<Record<string, unknown>> {
  const viewport = page.viewportSize();
  assert.deepEqual(viewport, { width: 1920, height: 1080 }, "桌面视觉基线必须使用 1920×1080");
  const brand = page.locator("main").getByRole("link", { name: "返回自媒体操盘手主站", exact: true }).first();
  await brand.waitFor({ state: "visible" });
  const topbar = brand.locator("xpath=ancestor::header[1]");
  const topbarBox = await topbar.boundingBox();
  assert.ok(topbarBox, "桌面端影视工坊顶栏必须可见");
  assert.ok(topbarBox.width >= 1200, `桌面端顶栏宽度不足：${topbarBox.width}px`);
  await topbar.getByText("影视工坊", { exact: true }).waitFor({ state: "visible" });
  await topbar.getByRole("link", { name: "进入工作台", exact: true }).waitFor({ state: "visible" });

  const heroHeading = page.getByRole("heading", { name: OFFICIAL_COPY.title, level: 1 });
  await heroHeading.waitFor({ state: "visible" });
  const hero = heroHeading.locator("xpath=ancestor::section[1]");
  const heroBox = await hero.boundingBox();
  assert.ok(heroBox, "影视工坊视频主视觉必须可见");
  assert.ok(heroBox.width >= 1200, `视频主视觉宽度不足：${heroBox.width}px`);
  assert.ok(heroBox.height >= 520, `视频主视觉高度不足：${heroBox.height}px`);
  assert.ok(Math.abs(heroBox.x - topbarBox.x) <= 2, "顶栏与视频主视觉必须左侧对齐");
  assert.ok(Math.abs(heroBox.width - topbarBox.width) <= 2, "顶栏与视频主视觉必须等宽");
  await hero.getByText(OFFICIAL_COPY.subtitle, { exact: true }).waitFor({ state: "visible" });
  await hero.getByRole("link", { name: "开始创作", exact: true }).waitFor({ state: "visible" });
  await hero.getByRole("link", { name: "浏览原创灵感", exact: true }).waitFor({ state: "visible" });
  await hero.getByText("6制作阶段", { exact: true }).waitFor({ state: "visible" });
  await hero.getByText("5主站工作台", { exact: true }).waitFor({ state: "visible" });
  await hero.getByText("0本页自动扣费", { exact: true }).waitFor({ state: "visible" });
  const poster = hero.locator('img[alt="影视创作工坊全流程横幅"]');
  await poster.waitFor({ state: "visible" });
  const posterReady = await poster.evaluate((element) => {
    const image = element as HTMLImageElement;
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  });
  assert.equal(posterReady, true, "影视工坊视频主视觉封面必须真实解码");

  const workflow = page.getByRole("heading", { name: "六步制作链路", exact: true }).locator("xpath=ancestor::section[1]");
  await workflow.waitFor({ state: "visible" });
  const workflowText = (await workflow.innerText()).replace(/\s+/g, " ");
  let previousIndex = -1;
  for (const step of OFFICIAL_COPY.steps) {
    const stepIndex = workflowText.indexOf(step, previousIndex + 1);
    assert.ok(stepIndex > previousIndex, `六步制作链路缺少或打乱：${step}`);
    previousIndex = stepIndex;
  }

  await page.getByText(OFFICIAL_COPY.entries.drama.description, { exact: true }).waitFor({ state: "visible" });
  await page.getByText(OFFICIAL_COPY.entries.general.description, { exact: true }).waitFor({ state: "visible" });
  await page.getByText(OFFICIAL_COPY.entries.long.description, { exact: true }).waitFor({ state: "visible" });
  await page.getByText(OFFICIAL_COPY.entries.upload.description, { exact: true }).waitFor({ state: "visible" });

  const desktopEntryBoxes = [];
  for (const entry of Object.values(OFFICIAL_COPY.entries)) {
    const card = await entryInteractive(page, entry.testId, entry.title);
    const box = await card.boundingBox();
    assert.ok(box, `${entry.title} 卡片必须可见`);
    desktopEntryBoxes.push({ title: entry.title, ...box });
  }
  const firstEntryTop = desktopEntryBoxes[0].y;
  for (const entryBox of desktopEntryBoxes) {
    assert.ok(Math.abs(entryBox.y - firstEntryTop) <= 2, "1920 桌面端四入口必须保持同一行");
    assert.ok(entryBox.width >= 285 && entryBox.width <= 325, `${entryBox.title} 卡片宽度异常：${entryBox.width}px`);
    assert.ok(entryBox.height >= 300, `${entryBox.title} 卡片高度不足：${entryBox.height}px`);
  }
  for (let index = 1; index < desktopEntryBoxes.length; index += 1) {
    const previous = desktopEntryBoxes[index - 1];
    const current = desktopEntryBoxes[index];
    const gap = current.x - (previous.x + previous.width);
    assert.ok(gap >= 10 && gap <= 20, `桌面入口列间距异常：${gap}px`);
  }

  const projectSection = page.getByRole("heading", { name: "我的项目", exact: true }).locator("xpath=ancestor::section[1]");
  await projectSection.waitFor({ state: "visible" });
  const projectStateVisible = await projectSection.getByText(/登录后查看项目库|还没有短剧项目|项目库服务尚未启用|项目库加载失败/).count();
  assert.ok(projectStateVisible > 0, "我的项目必须呈现明确的登录、空态、未启用或错误状态");

  for (const utility of ["自由画布", "配音工作台", "媒体历史", "灵感广场"]) {
    await page.getByRole("heading", { name: utility, exact: true, level: 3 }).waitFor({ state: "visible" });
  }

  return {
    topbar: topbarBox,
    hero: heroBox,
    entryBoxes: desktopEntryBoxes,
    posterReady,
    projectStateVisible,
  };
}

async function assertEntryRoutes(page: Page): Promise<Record<string, EntryEvidence>> {
  const evidence: Record<string, EntryEvidence> = {};

  await requireResponse200(page, "/tools/film-studio");
  const drama = await entryInteractive(
    page,
    OFFICIAL_COPY.entries.drama.testId,
    OFFICIAL_COPY.entries.drama.title,
  );
  evidence.drama = await entryEvidence(drama, OFFICIAL_COPY.entries.drama.title);
  assert.equal(evidence.drama.disabled, false, "爽剧必须可用");
  await drama.click();
  await page.waitForURL((url) => url.pathname === OFFICIAL_COPY.entries.drama.path, { timeout: 30_000 });
  await page.waitForTimeout(1_200);
  assert.equal(pathOf(page.url()), OFFICIAL_COPY.entries.drama.path, "爽剧必须进入分镜工作台");
  assert.equal(new URL(page.url()).searchParams.get("mode"), OFFICIAL_COPY.entries.drama.mode, "爽剧模式参数必须保留");

  await requireResponse200(page, "/tools/film-studio");
  const general = await entryInteractive(
    page,
    OFFICIAL_COPY.entries.general.testId,
    OFFICIAL_COPY.entries.general.title,
  );
  evidence.general = await entryEvidence(general, OFFICIAL_COPY.entries.general.title);
  assert.equal(evidence.general.disabled, false, "短剧必须可用");
  await general.click();
  await page.waitForURL((url) => url.pathname === OFFICIAL_COPY.entries.general.path, { timeout: 30_000 });
  await page.waitForTimeout(1_200);
  assert.equal(pathOf(page.url()), OFFICIAL_COPY.entries.general.path, "短剧必须进入分镜工作台");
  assert.equal(new URL(page.url()).searchParams.get("mode"), OFFICIAL_COPY.entries.general.mode, "通用短剧模式参数必须保留");

  await requireResponse200(page, "/tools/film-studio");
  const long = await entryInteractive(
    page,
    OFFICIAL_COPY.entries.long.testId,
    OFFICIAL_COPY.entries.long.title,
  );
  evidence.long = await entryEvidence(long, OFFICIAL_COPY.entries.long.title);
  assert.equal(evidence.long.disabled, true, "正剧必须保持 disabled，不能伪装已上线");
  assert.equal(evidence.long.href, null, "正剧禁用状态不得携带可导航 href");

  const upload = await entryInteractive(
    page,
    OFFICIAL_COPY.entries.upload.testId,
    OFFICIAL_COPY.entries.upload.title,
  );
  evidence.upload = await entryEvidence(upload, OFFICIAL_COPY.entries.upload.title);
  assert.equal(evidence.upload.disabled, false, "上传剧本入口必须可用");
  await upload.click();
  await page.waitForURL((url) => url.pathname === OFFICIAL_COPY.entries.upload.path, { timeout: 30_000 });
  await page.waitForTimeout(1_200);
  assert.equal(new URL(page.url()).searchParams.get("mode"), OFFICIAL_COPY.entries.upload.mode, "上传模式参数必须保留");

  return evidence;
}

function assertDiagnosticsClean(diagnostics: Diagnostics[], label: string): void {
  const combined = diagnostics.reduce<Diagnostics>((result, current) => ({
    consoleErrors: [...result.consoleErrors, ...current.consoleErrors],
    pageErrors: [...result.pageErrors, ...current.pageErrors],
    failedRequests: [...result.failedRequests, ...current.failedRequests],
    httpErrors: [...result.httpErrors, ...current.httpErrors],
  }), { consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [] });
  assert.deepEqual(combined.consoleErrors, [], `${label} console error：${combined.consoleErrors.join(" | ")}`);
  assert.deepEqual(combined.pageErrors, [], `${label} page error：${combined.pageErrors.join(" | ")}`);
  assert.deepEqual(combined.failedRequests, [], `${label} request failure：${combined.failedRequests.join(" | ")}`);
  assert.deepEqual(
    combined.httpErrors,
    [],
    `${label} HTTP error：${combined.httpErrors.map((item) => `${item.status} ${item.url}`).join(" | ")}`,
  );
}

async function desktopFlow(
  browser: Browser,
  audit: NetworkAudit,
  session: LocalSession,
): Promise<Record<string, unknown>> {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await prepareContext(context, session);
  await installNetworkGuard(context, audit);
  const page = await context.newPage();
  const diagnostics = collectDiagnostics(page);

  try {
    const legacyResponse = await page.goto(`${baseUrl}/short-drama`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    assert.ok(legacyResponse, "影视工坊旧入口必须返回响应");
    assert.ok(legacyResponse.status() < 400, `影视工坊旧入口 HTTP ${legacyResponse.status()}`);
    await page.waitForURL((url) => url.pathname === "/tools/film-studio", { timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(350);
    const legacyAlias = {
      status: legacyResponse.status(),
      finalPath: pathOf(page.url()),
    };

    const structure = await assertPortalStructure(page);
    const overflow = await assertNoHorizontalOverflow(page, "1920 桌面端");
    await page.screenshot({
      path: path.join(evidenceDir, "e2e-film-studio-desktop-1920.png"),
      fullPage: true,
      animations: "disabled",
    });

    const entries = await assertEntryRoutes(page);

    assert.deepEqual(audit.riskCalls, [], "不得调用真实模型、生图、视频或计费接口");
    assert.deepEqual(audit.externalHttpRequests, [], "不得请求外部供应商或外部 HTTP 素材");
    return { legacyAlias, structure, overflow, entries, diagnostics };
  } finally {
    await context.close();
  }
}

async function mobileFlow(
  browser: Browser,
  audit: NetworkAudit,
  session: LocalSession,
): Promise<Record<string, unknown>> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    isMobile: true,
    hasTouch: true,
  });
  await prepareContext(context, session);
  await installNetworkGuard(context, audit);
  const page = await context.newPage();
  const diagnostics = collectDiagnostics(page);

  try {
    await requireResponse200(page, "/tools/film-studio");
    await page.getByText(OFFICIAL_COPY.entries.drama.description, { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "我的项目", exact: true }).waitFor({ state: "visible" });
    const brand = page.locator("main").getByRole("link", { name: "返回自媒体操盘手主站", exact: true }).first();
    await brand.waitFor({ state: "visible" });
    const topbarBox = await brand.locator("xpath=ancestor::header[1]").boundingBox();
    assert.ok(topbarBox, "390 移动端影视工坊顶栏必须可见");
    assert.ok(topbarBox.x >= 8 && topbarBox.x <= 12, `移动端顶栏左距异常：${topbarBox.x}px`);
    assert.ok(topbarBox.width >= 368 && topbarBox.width <= 372, `移动端顶栏宽度异常：${topbarBox.width}px`);

    const heroHeading = page.getByRole("heading", { name: OFFICIAL_COPY.title, level: 1 });
    await heroHeading.waitFor({ state: "visible" });
    const heroBox = await heroHeading.locator("xpath=ancestor::section[1]").boundingBox();
    assert.ok(heroBox, "390 移动端视频主视觉必须可见");
    assert.ok(heroBox.x >= 8 && heroBox.x <= 12, `移动端视频主视觉左距异常：${heroBox.x}px`);
    assert.ok(heroBox.width >= 368 && heroBox.width <= 372, `移动端视频主视觉宽度异常：${heroBox.width}px`);
    assert.ok(heroBox.height >= 580, `移动端视频主视觉高度不足：${heroBox.height}px`);

    const mobileEntryBoxes = [];
    for (const entry of Object.values(OFFICIAL_COPY.entries)) {
      const card = await entryInteractive(page, entry.testId, entry.title);
      const box = await card.boundingBox();
      assert.ok(box, `移动端 ${entry.title} 卡片必须可见`);
      mobileEntryBoxes.push({ title: entry.title, ...box });
    }
    for (let index = 1; index < mobileEntryBoxes.length; index += 1) {
      assert.ok(mobileEntryBoxes[index].y > mobileEntryBoxes[index - 1].y, "移动端入口卡必须按单列顺序排列");
    }
    for (const entryBox of mobileEntryBoxes) {
      assert.ok(entryBox.width >= 365 && entryBox.width <= 372, `${entryBox.title} 移动端宽度异常：${entryBox.width}px`);
      assert.ok(entryBox.height >= 280, `${entryBox.title} 移动端高度不足：${entryBox.height}px`);
    }
    const workflowCards = page
      .getByRole("heading", { name: "六步制作链路", exact: true })
      .locator("xpath=ancestor::section[1]")
      .locator("a");
    assert.equal(await workflowCards.count(), 6, "移动端必须保留六步制作链路");
    const overflow = await assertNoHorizontalOverflow(page, "390 移动端");
    await page.screenshot({
      path: path.join(evidenceDir, "e2e-film-studio-mobile-390.png"),
      fullPage: true,
      animations: "disabled",
    });
    return { topbar: topbarBox, hero: heroBox, entryBoxes: mobileEntryBoxes, overflow, diagnostics };
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  const audit: NetworkAudit = {
    projectFixtureInterceptions: 0,
    riskCalls: [],
    externalHttpRequests: [],
    apiRequests: [],
  };
  const report: Record<string, unknown> = {
    schemaVersion: "film-studio-correction-e2e.v1",
    startedAt: new Date().toISOString(),
    baseUrl,
    ok: false,
  };
  const session = await createLocalSession();
  const browser = await chromium.launch({ headless: true });

  try {
    const desktop = await desktopFlow(browser, audit, session);
    const mobile = await mobileFlow(browser, audit, session);
    report.desktop = desktop;
    report.mobile = mobile;
    assert.deepEqual(audit.riskCalls, [], "全程真实模型/生图/视频/计费调用必须为 0");
    assert.deepEqual(audit.externalHttpRequests, [], "全程外部 HTTP 请求必须为 0");
    assertDiagnosticsClean(
      [
        (desktop as { diagnostics: Diagnostics }).diagnostics,
        (mobile as { diagnostics: Diagnostics }).diagnostics,
      ],
      "完整影视工坊验收",
    );
    report.ok = true;
  } catch (error: unknown) {
    report.error = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.networkAudit = audit;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
