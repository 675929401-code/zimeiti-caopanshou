import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from "playwright";

import {
  GENERAL_SCRIPT_CONTRACT_VERSION,
  GENERAL_SCRIPT_PROFILE_VERSION,
  PET_SILENT_NARRATION_PROFILE_ID,
  parseGeneralScriptRequest,
  parseGeneralScriptResult,
  validateGeneralScriptResultForRequest,
  type GeneralScriptRequest,
} from "../src/lib/short-drama/general-script-contract";
import { createGeneralScriptFixture } from "../src/lib/short-drama/general-script-fixtures";

const baseUrl = (process.env.SHORT_DRAMA_E2E_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const projectRoot = process.cwd();
const evidenceDir = path.join(
  projectRoot,
  ".codex-evidence",
  "short-drama-alignment-20260823",
);
const reportPath = path.join(evidenceDir, "e2e-short-drama-alignment.json");

const fixtureInput = {
  title: "雨天里的小小守护者",
  narration:
    "下雨天，小狗发现院角的小刺猬被积水困住。它先试着用鼻尖推来木板，又叼来树叶铺成一条小路。没有谁开口说话，所有信息都由后期旁白说明；小狗通过耳朵、眼神、动作和道具变化完成表演。",
  animationStyle: "温暖电影感商业级 3D 宠物动画",
  videoSize: "16:9",
  requirements:
    "人物与宠物不张嘴、不做对白口型，不出现角色台词；全部使用后期旁白，以表情、动作、视线、走位、环境反馈和语义道具推进。",
} as const;

type RiskKind = "model" | "image" | "video" | "billing";

interface RiskCall {
  kind: RiskKind;
  method: string;
  url: string;
}

interface NetworkAudit {
  fixtureInterceptions: number;
  interceptedRequest: GeneralScriptRequest | null;
  riskCalls: RiskCall[];
  externalHttpRequests: Array<{ method: string; url: string; resourceType: string }>;
  allApiRequests: Array<{ method: string; path: string }>;
}

interface PageDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

function urlPath(requestUrl: string): string {
  try {
    return new URL(requestUrl).pathname;
  } catch {
    return requestUrl;
  }
}

function riskKindFor(request: Request): RiskKind | null {
  const pathname = urlPath(request.url());
  if (pathname === "/api/short-drama/script") return null;

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

function isExternalHttpRequest(requestUrl: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(requestUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  return target.origin !== base.origin;
}

function apiSuccess(request: GeneralScriptRequest): Record<string, unknown> {
  const result = validateGeneralScriptResultForRequest(
    request,
    parseGeneralScriptResult(createGeneralScriptFixture(request)),
  );
  return {
    ok: true,
    executionMode: "fixture",
    profile: {
      id: request.profile.id,
      version: GENERAL_SCRIPT_PROFILE_VERSION,
    },
    contractVersion: GENERAL_SCRIPT_CONTRACT_VERSION,
    result,
  };
}

async function installNetworkGuard(
  context: BrowserContext,
  audit: NetworkAudit,
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const pathname = urlPath(request.url());
    if (pathname.startsWith("/api/")) {
      audit.allApiRequests.push({ method: request.method(), path: pathname });
    }

    if (pathname === "/api/short-drama/script" && request.method() === "POST") {
      try {
        const parsed = parseGeneralScriptRequest(request.postDataJSON() as unknown);
        audit.fixtureInterceptions += 1;
        audit.interceptedRequest = parsed;
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify(apiSuccess(parsed)),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await route.fulfill({
          status: 400,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({
            ok: false,
            code: "E2E_FIXTURE_CONTRACT_FAILED",
            error: message,
          }),
        });
      }
      return;
    }

    const riskKind = riskKindFor(request);
    if (riskKind) {
      audit.riskCalls.push({ kind: riskKind, method: request.method(), url: request.url() });
      await route.abort("blockedbyclient");
      return;
    }

    if (isExternalHttpRequest(request.url())) {
      audit.externalHttpRequests.push({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
      });
    }
    await route.continue();
  });
}

function collectDiagnostics(page: Page): PageDiagnostics {
  const diagnostics: PageDiagnostics = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText === "net::ERR_BLOCKED_BY_CLIENT") return;
    try {
      const parsed = new URL(request.url());
      if (
        request.failure()?.errorText === "net::ERR_ABORTED"
        && parsed.origin === new URL(baseUrl).origin
        && parsed.searchParams.has("_rsc")
      ) return;
    } catch {
      // Keep malformed failed URLs in diagnostics.
    }
    diagnostics.failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText || "unknown"}`);
  });
  return diagnostics;
}

async function cleanLocalDrafts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    localStorage.removeItem("general_script_draft_v1");
    localStorage.removeItem("short_drama_general_script_handoff_v1");
    localStorage.removeItem("short_drama_storyboard_handoff_import_v1");
    sessionStorage.clear();
  });
}

async function requireResponse200(page: Page, routePath: string): Promise<void> {
  const response = await page.goto(`${baseUrl}${routePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.equal(response?.status(), 200, `${routePath} 应返回 200`);
}

async function assertNoHorizontalOverflow(
  page: Page,
  label: string,
): Promise<{ viewportWidth: number; scrollWidth: number; overflowPixels: number }> {
  const dimensions = await page.evaluate(() => {
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
    dimensions.overflowPixels <= 1,
    `${label}: 页面横向溢出 ${dimensions.overflowPixels}px（scrollWidth=${dimensions.scrollWidth}, viewport=${dimensions.viewportWidth}）`,
  );
  return dimensions;
}

async function visibleLocator(
  page: Page,
  stableSelector: string,
  fallbackText: RegExp,
  timeout = 45_000,
) {
  const stable = page.locator(stableSelector).first();
  try {
    await stable.waitFor({ state: "visible", timeout: Math.min(timeout, 10_000) });
    return stable;
  } catch {
    const fallback = page.getByText(fallbackText).first();
    await fallback.waitFor({ state: "visible", timeout });
    return fallback;
  }
}

async function mainFlow(
  browser: Browser,
  audit: NetworkAudit,
): Promise<Record<string, unknown>> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  });
  await cleanLocalDrafts(context);
  await installNetworkGuard(context, audit);
  const page = await context.newPage();
  const diagnostics = collectDiagnostics(page);
  const heroMediaResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    if (/\/short-drama\/hero-pipeline-loop-v1\.(?:webm|mp4)$/i.test(new URL(response.url()).pathname)) {
      heroMediaResponses.push({ url: response.url(), status: response.status() });
    }
  });

  try {
    await requireResponse200(page, "/short-drama");
    await page.getByRole("heading", { level: 1, name: /从故事到成片/ }).waitFor({
      state: "visible",
      timeout: 30_000,
    });

    const heroVideo = page.locator('section[aria-labelledby="short-drama-title"] video').first();
    await heroVideo.waitFor({ state: "attached", timeout: 20_000 });
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>(
        'section[aria-labelledby="short-drama-title"] video',
      );
      return Boolean(
        video
          && video.currentSrc
          && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && Number.parseFloat(getComputedStyle(video).opacity || "0") > 0.5,
      );
    }, undefined, { timeout: 30_000 });
    const hero = await heroVideo.evaluate((video) => ({
      currentSrc: (video as HTMLVideoElement).currentSrc,
      readyState: (video as HTMLVideoElement).readyState,
      paused: (video as HTMLVideoElement).paused,
      autoplay: (video as HTMLVideoElement).autoplay,
      muted: (video as HTMLVideoElement).muted,
      loop: (video as HTMLVideoElement).loop,
      playsInline: (video as HTMLVideoElement).playsInline,
      poster: (video as HTMLVideoElement).poster,
      opacity: getComputedStyle(video).opacity,
    }));
    assert.equal(hero.autoplay, true, "主视觉视频必须启用 autoplay");
    assert.equal(hero.muted, true, "主视觉视频必须静音以允许自动播放");
    assert.equal(hero.loop, true, "主视觉视频必须循环");
    assert.equal(hero.playsInline, true, "主视觉视频必须移动端内联播放");
    assert.match(hero.currentSrc, /hero-pipeline-loop-v1\.(?:webm|mp4)$/i, "主视觉应加载原创循环视频");
    assert.ok(
      heroMediaResponses.some((item) => item.status === 200 || item.status === 206),
      "原创循环视频资源应返回 200，或以 Range 请求返回 206",
    );
    await page.screenshot({
      path: path.join(evidenceDir, "e2e-01-short-drama-hero.png"),
      fullPage: true,
      animations: "disabled",
    });

    const templateLink = page.getByRole("link", { name: /使用该模板/ });
    const templateHref = await templateLink.getAttribute("href");
    assert.equal(
      templateHref,
      "/tools/text/general-script?profile=pet-silent-narration",
      "宠物无对白模板必须传递正确 profile 参数",
    );
    await templateLink.click();
    await page.waitForURL(
      /\/tools\/text\/general-script\?profile=pet-silent-narration$/,
      { timeout: 30_000 },
    );

    await page.getByText("宠物无口型口播（单条）", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(/硬约束：人物与宠物不张嘴、不做对白口型/).waitFor({ state: "visible" });
    assert.equal(await page.locator("#general-script-genre").inputValue(), "宠物动画口播", "profile 应自动设置视频类型");
    await page.locator("#animation-style").fill(fixtureInput.animationStyle);
    await page.locator("#video-size").selectOption(fixtureInput.videoSize);
    assert.equal(
      await page.locator("#episodes-to-generate").inputValue(),
      "1",
      "宠物无口型单条 Profile 必须默认只生成 1 集",
    );
    assert.equal(
      await page.locator("#total-episodes").inputValue(),
      "1",
      "宠物无口型单条 Profile 必须默认总集数为 1",
    );
    await page.getByRole("button", { name: /下一步：输入内容/ }).click();

    await page.locator("#script-title").fill(fixtureInput.title);
    await page.locator("#script-brief").fill(fixtureInput.narration);
    await page.locator("#script-requirements").fill(fixtureInput.requirements);
    await page.screenshot({
      path: path.join(evidenceDir, "e2e-02-general-script-input.png"),
      fullPage: true,
      animations: "disabled",
    });

    await page.getByRole("button", { name: "生成完整项目" }).click();
    await page.getByText("离线验收数据", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(audit.fixtureInterceptions, 1, "脚本接口应且只应被 fixture 拦截一次");
    const request = audit.interceptedRequest;
    assert.ok(request, "应捕获合法的脚本合同请求");
    assert.equal(request.profile.id, PET_SILENT_NARRATION_PROFILE_ID, "请求必须使用宠物无对白 profile");
    assert.equal(request.content.brief, fixtureInput.narration, "请求必须包含口播文案变量");
    assert.equal(request.settings.animationStyle, fixtureInput.animationStyle, "请求必须包含动画风格变量");
    assert.equal(request.settings.videoSize, fixtureInput.videoSize, "请求必须包含视频尺寸变量");
    assert.match(
      `${request.content.brief}\n${request.content.requirements}`,
      /不张嘴|不做对白口型|无口型/u,
      "请求必须显式包含无口型约束",
    );
    assert.match(
      `${request.content.brief}\n${request.content.requirements}`,
      /后期旁白/u,
      "请求必须显式包含后期旁白约束",
    );

    await page.waitForFunction(() => {
      try {
        const raw = localStorage.getItem("general_script_draft_v1");
        const parsed = raw ? JSON.parse(raw) as { lastResult?: { schemaVersion?: string } } : null;
        return parsed?.lastResult?.schemaVersion === "general-script-result.v1";
      } catch {
        return false;
      }
    }, undefined, { timeout: 5_000 });
    const handoffPayload = await page.evaluate(() => {
      const raw = localStorage.getItem("general_script_draft_v1");
      return raw ? JSON.parse(raw) as Record<string, unknown> : null;
    });
    assert.ok(handoffPayload, "生成结果必须保存到本地草稿");
    const result = (handoffPayload as { lastResult?: Record<string, unknown> }).lastResult;
    assert.ok(result, "本地草稿必须保留完整结果");
    const resultCollections = result as {
      summary?: { protagonist?: string };
      episodes?: unknown[];
      characters?: unknown[];
      scenes?: unknown[];
      props?: unknown[];
    };
    assert.ok(resultCollections.summary?.protagonist, "结果必须包含 protagonist");
    assert.ok((resultCollections.episodes?.length || 0) >= 1, "结果必须包含 episodes");
    assert.ok((resultCollections.characters?.length || 0) >= 1, "结果必须包含 characters");
    assert.ok((resultCollections.scenes?.length || 0) >= 1, "结果必须包含 scenes");
    assert.ok((resultCollections.props?.length || 0) >= 1, "结果必须包含 props");
    await page.getByText(/主角：/).waitFor({ state: "visible" });
    await page.getByText(/第 1 集/).first().waitFor({ state: "visible" });
    await page.getByRole("heading", { name: /^角色 \d+$/ }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: /^场景 \d+$/ }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: /^道具 \d+$/ }).waitFor({ state: "visible" });
    await page.screenshot({
      path: path.join(evidenceDir, "e2e-03-general-script-result.png"),
      fullPage: true,
      animations: "disabled",
    });

    await page.getByRole("button", { name: /仅本地交接并进入/ }).click();
    await page.waitForURL(
      /\/storyboard-workbench\?entry=short-drama&handoff=general-script$/,
      { timeout: 30_000 },
    );
    const handoffUrl = page.url();
    const storedHandoff = await page.evaluate(() => {
      const raw = localStorage.getItem("short_drama_general_script_handoff_v1");
      return raw ? JSON.parse(raw) as Record<string, unknown> : null;
    });
    assert.ok(storedHandoff, "交接前必须保存通用短剧本地包");

    const preview = await visibleLocator(
      page,
      '[data-testid="general-script-handoff-preview"]',
      /剧本交接预览|短剧交接预览|检测到.*剧本|通用短剧.*交接/u,
    );
    const previewText = await preview.textContent();
    assert.match(previewText || "", /雨天里的小小守护者|小小守护者/u, "交接预览必须显示项目标题");
    await page.screenshot({
      path: path.join(evidenceDir, "e2e-04-storyboard-handoff-preview.png"),
      fullPage: true,
      animations: "disabled",
    });

    let confirm = page.locator('[data-testid="general-script-handoff-confirm"]').first();
    if (await confirm.count() === 0) {
      confirm = page.getByRole("button", { name: /确认.*导入|导入.*分镜|确认并导入/u }).first();
    }
    await confirm.waitFor({ state: "visible", timeout: 30_000 });
    await confirm.click();

    const importedCard = await visibleLocator(
      page,
      '[data-testid="general-script-imported-card"]',
      /生图提示词|生图 Prompt/u,
      30_000,
    );
    const cardText = await importedCard.textContent();
    const importedImagePrompt = await importedCard.getByRole("textbox", { name: /生图提示词/u }).inputValue();
    const importedVideoPrompt = await importedCard.getByRole("textbox", { name: /视频提示词/u }).inputValue();
    assert.match(cardText || "", /生图提示词|生图 Prompt/u, "导入卡片必须包含生图 Prompt");
    assert.match(cardText || "", /视频提示词|视频 Prompt/u, "导入卡片必须包含视频 Prompt");
    assert.ok(importedImagePrompt.trim().length > 0, "导入卡片的生图 Prompt 不得为空");
    assert.ok(importedVideoPrompt.trim().length > 0, "导入卡片的视频 Prompt 不得为空");
    assert.match(
      `${cardText || ""}\n${importedImagePrompt}\n${importedVideoPrompt}`,
      /不张嘴|无对白口型|不做对白口型|不得开口|嘴部自然闭合/u,
      "导入卡片必须保留无口型约束",
    );
    await page.screenshot({
      path: path.join(evidenceDir, "e2e-05-storyboard-imported-cards.png"),
      fullPage: true,
      animations: "disabled",
    });

    assert.deepEqual(audit.riskCalls, [], "验收过程中不得调用真实模型、生图、视频或计费接口");
    assert.deepEqual(audit.externalHttpRequests, [], "验收过程中不得请求外部供应商或外部 HTTP 资源");
    assert.deepEqual(diagnostics.pageErrors, [], `页面脚本错误：${diagnostics.pageErrors.join(" | ")}`);
    assert.deepEqual(diagnostics.consoleErrors, [], `控制台错误：${diagnostics.consoleErrors.join(" | ")}`);

    return {
      shortDramaRoute: 200,
      hero,
      heroMediaResponses,
      templateHref,
      profileAutoMatched: request.profile.id,
      fixtureExecutionMode: "fixture",
      requestVariables: {
        narration: request.content.brief,
        animationStyle: request.settings.animationStyle,
        videoSize: request.settings.videoSize,
        requirements: request.content.requirements,
      },
      resultCollections: {
        protagonist: resultCollections.summary?.protagonist,
        episodes: resultCollections.episodes?.length || 0,
        characters: resultCollections.characters?.length || 0,
        scenes: resultCollections.scenes?.length || 0,
        props: resultCollections.props?.length || 0,
      },
      handoffUrl,
      bridgePreview: true,
      bridgeConfirmed: true,
      importedCardChecks: {
        imagePrompt: importedImagePrompt,
        videoPrompt: importedVideoPrompt,
        silentMouthConstraint: /不张嘴|无对白口型|不做对白口型|不得开口|嘴部自然闭合/u.test(
          `${cardText || ""}\n${importedImagePrompt}\n${importedVideoPrompt}`,
        ),
      },
      diagnostics,
    };
  } catch (error) {
    await page.screenshot({
      path: path.join(evidenceDir, "e2e-failure-main-flow.png"),
      fullPage: true,
      animations: "disabled",
    }).catch(() => undefined);
    throw error;
  } finally {
    await context.close();
  }
}

async function mobileSmoke(
  browser: Browser,
  audit: NetworkAudit,
): Promise<Record<string, unknown>> {
  const routes = [
    {
      name: "short-drama",
      path: "/short-drama",
      ready: /从故事到成片/u,
      ctaRole: "link" as const,
      ctaName: /开始创作/u,
    },
    {
      name: "general-script",
      path: "/tools/text/general-script?profile=pet-silent-narration",
      ready: /三步完成可进入影视工坊的剧本项目/u,
      ctaRole: "button" as const,
      ctaName: /下一步：输入内容/u,
    },
    {
      name: "inspiration",
      path: "/inspiration",
      ready: /先看创作结构/u,
      ctaRole: "link" as const,
      ctaName: /带入分镜/u,
    },
  ];
  const results: Record<string, unknown> = {};

  for (const route of routes) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    await cleanLocalDrafts(context);
    await installNetworkGuard(context, audit);
    const page = await context.newPage();
    const diagnostics = collectDiagnostics(page);
    try {
      await requireResponse200(page, route.path);
      await page.getByText(route.ready).first().waitFor({ state: "visible", timeout: 30_000 });
      if (route.name === "general-script") {
        await page.getByText(/硬约束：人物与宠物不张嘴、不做对白口型/).waitFor({ state: "visible" });
      }
      const dimensions = await assertNoHorizontalOverflow(page, `mobile/${route.name}`);
      const cta = route.ctaRole === "link"
        ? page.getByRole("link", { name: route.ctaName }).first()
        : page.getByRole("button", { name: route.ctaName }).first();
      await cta.waitFor({ state: "visible", timeout: 20_000 });
      await cta.scrollIntoViewIfNeeded();
      const ctaBox = await cta.boundingBox();
      assert.ok(ctaBox, `mobile/${route.name}: 主按钮必须具有可见布局框`);
      assert.ok(
        ctaBox.x >= -1 && ctaBox.x + ctaBox.width <= 391,
        `mobile/${route.name}: 主按钮超出横向视口`,
      );
      const screenshot = path.join(evidenceDir, `mobile-${route.name}-390x844.png`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      assert.deepEqual(diagnostics.pageErrors, [], `mobile/${route.name} 页面脚本错误`);
      assert.deepEqual(diagnostics.consoleErrors, [], `mobile/${route.name} 控制台错误`);
      results[route.name] = {
        status: 200,
        dimensions,
        ctaVisible: true,
        screenshot: path.relative(projectRoot, screenshot),
        diagnostics,
      };
    } catch (error) {
      await page.screenshot({
        path: path.join(evidenceDir, `mobile-${route.name}-failure.png`),
        fullPage: true,
        animations: "disabled",
      }).catch(() => undefined);
      throw error;
    } finally {
      await context.close();
    }
  }

  assert.deepEqual(audit.riskCalls, [], "移动端冒烟不得调用真实模型、生图、视频或计费接口");
  return results;
}

async function writeReport(payload: Record<string, unknown>): Promise<void> {
  await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function run(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  const audit: NetworkAudit = {
    fixtureInterceptions: 0,
    interceptedRequest: null,
    riskCalls: [],
    externalHttpRequests: [],
    allApiRequests: [],
  };
  const browser = await chromium.launch({ headless: true });
  const startedAt = new Date().toISOString();
  try {
    const flow = await mainFlow(browser, audit);
    const mobile = await mobileSmoke(browser, audit);
    const counters = {
      model: audit.riskCalls.filter((item) => item.kind === "model").length,
      image: audit.riskCalls.filter((item) => item.kind === "image").length,
      video: audit.riskCalls.filter((item) => item.kind === "video").length,
      billing: audit.riskCalls.filter((item) => item.kind === "billing").length,
      externalHttp: audit.externalHttpRequests.length,
      fixtureInterceptions: audit.fixtureInterceptions,
    };
    assert.deepEqual(
      { model: counters.model, image: counters.image, video: counters.video, billing: counters.billing },
      { model: 0, image: 0, video: 0, billing: 0 },
      "真实模型、生图、视频和计费接口调用数必须全部为 0",
    );
    const report = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl,
      flow,
      mobile,
      network: {
        counters,
        countersScope: "只统计模型执行、图片生成、视频生成/任务状态和计费写入；本地主站只读模型目录 GET 单独列出，不属于付费执行。",
        readOnlyCatalogRequests: audit.allApiRequests.filter((item) =>
          item.method === "GET" && ["/api/cover-models", "/api/video/models"].includes(item.path)
        ),
        allApiRequests: audit.allApiRequests,
        externalHttpRequests: audit.externalHttpRequests,
        riskCalls: audit.riskCalls,
      },
      paidOrProviderCallsExecuted: false,
      note: "脚本生成接口由项目内合同 fixture 在浏览器路由层响应；未调用真实 LLM、生图、视频或计费供应商。",
    };
    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const failedReport = {
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl,
      error: message,
      network: audit,
      paidOrProviderCallsExecuted: false,
    };
    await writeReport(failedReport);
    console.error(message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

void run();
