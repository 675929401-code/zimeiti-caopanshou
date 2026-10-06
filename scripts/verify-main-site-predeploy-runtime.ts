import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page, type Request } from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { collectStaticSecondaryRoutes } from "./verify-local-navigation-experience.mjs";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const generatedAt = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", `main-site-predeploy-${generatedAt}`);

async function alignLocalPreviewRuntime(): Promise<void> {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) return;

  const runtimePath = process.env.LOCAL_PREVIEW_RUNTIME_FILE?.trim()
    || path.resolve("..", "..", "..", "运行数据", "自媒体操盘手", "local-data-20260902", "config", "runtime.json");
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as {
    localOnly?: boolean;
    supabaseUrl?: string;
    serviceRoleKey?: string;
    anonKey?: string;
    jwtSecret?: string;
  };
  assert.equal(runtime.localOnly, true, "LOCAL_PREVIEW_RUNTIME_NOT_ISOLATED");
  assert.equal(new URL(String(runtime.supabaseUrl || "")).origin, "http://127.0.0.1:54321", "LOCAL_PREVIEW_DATABASE_ORIGIN_MISMATCH");
  assert.ok(runtime.serviceRoleKey && runtime.anonKey && runtime.jwtSecret, "LOCAL_PREVIEW_RUNTIME_INCOMPLETE");
  process.env.COZE_SUPABASE_URL = String(runtime.supabaseUrl);
  process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = String(runtime.serviceRoleKey);
  process.env.COZE_SUPABASE_ANON_KEY = String(runtime.anonKey);
  process.env.JWT_SECRET = String(runtime.jwtSecret);
  process.env.LOCAL_ACCEPTANCE_PREVIEW = "true";
  process.env.SHARED_CONFIGURATION_ENABLED = "1";
  process.env.SHARED_CONFIGURATION_SUPABASE_URL = String(runtime.supabaseUrl);
  process.env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY = String(runtime.serviceRoleKey);
}

const desktopRoutes = [
  "/",
  "/tools",
  "/video",
  "/image-workbench",
  "/storyboard-workbench",
  "/cover",
  "/voice-studio/workspace",
  "/commerce",
  "/media-history",
  "/tools?tab=segment",
  "/tools?tab=extract",
  "/tools?tab=formatter",
  "/profile",
  "/recharge",
  "/admin",
  "/youcai",
  "/youcai/tools",
  "/youcai/assets",
  "/youcai/inspiration",
  "/youcai/skills",
  "/youcai/articles",
  "/youcai/youcai-tv",
  "/youcai/tools/canvas",
  "/youcai/tools/text/text-chat",
  "/youcai/tools/film-studio",
  "/youcai/tools/text",
  "/youcai/tools/image",
  "/youcai/tools/audio",
  "/youcai/tools/video",
] as const;

const knownSchemaBlockers = [
  "/api/youcai/skills",
  "/api/short-drama/",
] as const;

const explicitModelApiPaths = [
  "/api/youcai/chat-models",
  "/api/youcai/skills?limit=100",
  "/api/llm-models",
  "/api/video/models?surface=video-page",
  "/api/video/models?surface=storyboard-workbench",
  "/api/cover-models",
] as const;

function canvasAutosaveBody(request: Request): { canvasId: string; expectedRevision: number } | null {
  const url = new URL(request.url());
  if (url.origin !== new URL(baseUrl).origin || url.pathname !== "/api/canvas" || request.method() !== "POST") return null;
  try {
    const body = request.postDataJSON() as { action?: unknown; canvasId?: unknown; expectedRevision?: unknown };
    if (body.action !== "save" || typeof body.canvasId !== "string") return null;
    return {
      canvasId: body.canvasId,
      expectedRevision: Number.isFinite(Number(body.expectedRevision)) ? Number(body.expectedRevision) : 0,
    };
  } catch {
    return null;
  }
}

interface Session {
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

interface RouteResult {
  route: string;
  viewport: "desktop";
  passed: boolean;
  status: number | null;
  finalUrl: string;
  title: string;
  bodyLength: number;
  horizontalOverflow: number;
  failureText: string[];
  failure?: string;
}

interface ApiResult {
  path: string;
  status: number;
  count: number;
  passed: boolean;
  failure?: string;
}

async function createSession(): Promise<Session> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("users")
    .select("id, username, display_name, credits, cash_balance")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || "找不到可用于交付验收的管理员账号");
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
      role: "admin",
      displayName: user.displayName,
      sessionId: `predeploy-${randomUUID()}`,
    }),
  };
}

async function auditRoute(page: Page, route: string, viewport: "desktop"): Promise<RouteResult> {
  let response: Awaited<ReturnType<Page["goto"]>> = null;
  let navigationFailure = "";
  try {
    response = await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => {
      const text = document.body?.innerText?.trim() || "";
      return text.length > 40
        || /Application error|Unhandled Runtime Error|This page could not be found|页面不存在|加载异常/u.test(text);
    }, null, { timeout: 30_000 });
  } catch (error) {
    navigationFailure = error instanceof Error ? error.message : String(error);
  }
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(350);
  const state = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const failurePatterns = [
      "This page could not be found",
      "页面不存在",
      "应用遇到了问题",
      "项目加载失败",
      "发生意外错误",
      "Failed to fetch",
    ];
    return {
      title: document.title.trim(),
      bodyLength: body.trim().length,
      overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      failureText: failurePatterns.filter((entry) => body.includes(entry)),
    };
  });
  const result: RouteResult = {
    route,
    viewport,
    passed: false,
    status: response?.status() ?? null,
    finalUrl: page.url(),
    title: state.title,
    bodyLength: state.bodyLength,
    horizontalOverflow: state.overflow,
    failureText: state.failureText,
  };
  const failures = [
    navigationFailure,
    result.status !== 200 ? `${viewport}:${route} HTTP ${result.status}` : "",
    result.bodyLength <= 40 ? `${viewport}:${route} 页面内容为空或首屏未完成` : "",
    result.horizontalOverflow > 1 ? `${viewport}:${route} 横向溢出 ${result.horizontalOverflow}px` : "",
    result.failureText.length > 0 ? `${viewport}:${route} 出现错误态：${result.failureText.join("、")}` : "",
  ].filter(Boolean);
  result.passed = failures.length === 0;
  if (failures.length > 0) result.failure = failures.join(" | ");
  return result;
}

async function auditModelApi(pathname: string): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 CodexPredeployVerifier" },
  });
  const payload = await response.json().catch(() => null) as {
    models?: unknown[];
    data?: unknown[];
    skills?: unknown[];
    count?: number;
    catalog_count?: number;
    error?: string;
  } | null;
  const count = Array.isArray(payload?.models)
    ? payload.models.length
    : Array.isArray(payload?.data)
      ? payload.data.length
      : Array.isArray(payload?.skills) && payload.skills.length > 0
        ? payload.skills.length
        : Number(payload?.count || payload?.catalog_count || 0);
  const failures = [
    response.status !== 200 ? `${pathname} HTTP ${response.status}: ${payload?.error || "模型接口不可用"}` : "",
    count <= 0 ? `${pathname} 模型为空` : "",
  ].filter(Boolean);
  return {
    path: pathname,
    status: response.status,
    count,
    passed: failures.length === 0,
    ...(failures.length > 0 ? { failure: failures.join(" | ") } : {}),
  };
}

function isExplicitlyAuditedAbort(requestUrl: string): boolean {
  const url = new URL(requestUrl);
  if (url.origin !== new URL(baseUrl).origin) return false;
  const pathWithSearch = `${url.pathname}${url.search}`;
  return explicitModelApiPaths.includes(pathWithSearch as (typeof explicitModelApiPaths)[number])
    || explicitModelApiPaths.includes(url.pathname as (typeof explicitModelApiPaths)[number]);
}

function isBenignNavigationAbort(request: Request): boolean {
  const requestUrl = request.url();
  const url = new URL(requestUrl);
  if (url.origin !== new URL(baseUrl).origin) return false;
  if (request.method() === "POST" && ["/api/announcements/events", "/api/diagnostic-logs"].includes(url.pathname)) return true;
  if (request.method() !== "GET") return false;
  if (url.searchParams.has("_rsc")) return true;
  if (isExplicitlyAuditedAbort(requestUrl)) return true;
  if (/\.(?:mp4|webm)(?:\?|$)/u.test(requestUrl)) return true;
  return ["document", "script", "stylesheet", "font", "image", "media", "fetch", "xhr"].includes(request.resourceType());
}

async function closeAnnouncement(page: Page) {
  const closeButton = page.getByRole("button", { name: "关闭", exact: true });
  if (!(await closeButton.count())) return;
  const eventResponse = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST"
      && new URL(response.url()).pathname === "/api/announcements/events";
  }, { timeout: 5_000 }).catch(() => null);
  await closeButton.first().click();
  const response = await eventResponse;
  if (response) assert.ok(response.status() < 500, `公告事件接口 HTTP ${response.status()}`);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(200);
}

async function runInteractionChecks(page: Page) {
  const checks: Array<{ name: string; status: "passed" | "failed"; detail: string }> = [];
  const run = async (name: string, action: () => Promise<string>) => {
    try {
      checks.push({ name, status: "passed", detail: await action() });
    } catch (error) {
      checks.push({ name, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await run("应用广场八个核心入口", async () => {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await closeAnnouncement(page);
    const labels = ["应用广场", "工具箱", "视频制作", "分镜工作台", "AI生图工作台", "智音工坊", "封面制作", "漫剧工作台", "带货 Agent"];
    const missing: string[] = [];
    for (const label of labels) {
      if (!(await page.getByText(label, { exact: true }).count())) missing.push(label);
    }
    assert.deepEqual(missing, []);
    await page.screenshot({ path: path.join(evidenceDir, "home-after-announcement-close.png"), fullPage: false });
    return `${labels.length}/9 入口可见，公告可关闭`;
  });

  await run("AI视频任务编辑", async () => {
    await page.goto(`${baseUrl}/video`, { waitUntil: "domcontentloaded" });
    const add = page.getByRole("button", { name: /添加任务/u }).first();
    await add.waitFor({ state: "visible" });
    await add.click();
    const prompts = page.locator("textarea");
    assert.ok(await prompts.count() >= 1);
    await prompts.first().fill("交付前只读交互检查，不提交生成");
    await prompts.first().fill("");
    return "添加任务、编辑提示词正常；未提交生成";
  });

  await run("AI生图提示词编辑", async () => {
    await page.goto(`${baseUrl}/image-workbench`, { waitUntil: "domcontentloaded" });
    const input = page.locator("textarea").first();
    await input.waitFor({ state: "visible" });
    await input.fill("交付前只读生图检查，不提交生成");
    await input.fill("");
    return "提示词输入与清空正常；未提交生成";
  });

  await run("封面比例切换", async () => {
    await page.goto(`${baseUrl}/cover`, { waitUntil: "domcontentloaded" });
    const ratio = page.getByText(/9:16/u).first();
    await ratio.waitFor({ state: "visible" });
    await ratio.click();
    return "9:16 比例可交互；未提交生成";
  });

  await run("智音文案编辑", async () => {
    await page.goto(`${baseUrl}/voice-studio/workspace`, { waitUntil: "domcontentloaded" });
    const input = page.locator("textarea").first();
    await input.waitFor({ state: "visible" });
    await input.fill("交付前只读语音检查，不提交合成");
    await input.fill("");
    return "语音文案输入与清空正常；未提交合成";
  });

  await run("媒体历史筛选", async () => {
    await page.goto(`${baseUrl}/media-history`, { waitUntil: "domcontentloaded" });
    const videoOption = page.locator('select option[value="video"]').first();
    if (await videoOption.count()) await videoOption.locator("..").selectOption("video");
    return "历史页加载并可切换视频筛选";
  });

  await run("后台系统健康入口", async () => {
    await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
    const tab = page.getByText("系统健康", { exact: true }).first();
    await tab.waitFor({ state: "visible" });
    await tab.click();
    await page.waitForTimeout(400);
    return "管理后台系统健康页签可点击";
  });

  return checks;
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  await alignLocalPreviewRuntime();
  const session = await createSession();
  const secondaryRoutes = await collectStaticSecondaryRoutes();
  const desktopAuditRoutes = [...new Set<string>([...desktopRoutes, ...secondaryRoutes])];
  const browser = await chromium.launch({ headless: true });
  const diagnostics = {
    pageErrors: [] as string[],
    consoleErrors: [] as string[],
    requestFailures: [] as string[],
    serverErrors: [] as string[],
    rateLimits: [] as string[],
    schemaBlockers: [] as string[],
    mutations: [] as string[],
    benignMutations: [] as string[],
  };
  const routeResults: RouteResult[] = [];
  const apiResults: ApiResult[] = [];

  try {
    for (const [viewport, routes, size] of [
      ["desktop", desktopAuditRoutes, { width: 1440, height: 900 }],
    ] as const) {
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
      await context.addCookies([{
        name: "auth_token",
        value: session.token,
        url: baseUrl,
        httpOnly: true,
        sameSite: "Lax",
      }]);
      await context.addInitScript(({ token, user }) => {
        localStorage.setItem("auth_token", token);
        localStorage.setItem("auth_user", JSON.stringify(user));
      }, session);
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (["GET", "HEAD", "OPTIONS"].includes(request.method())) {
          await route.continue();
          return;
        }
        const url = new URL(request.url());
        let commerceBridge = false;
        if (url.origin === new URL(baseUrl).origin && url.pathname === "/api/commerce/session" && request.method() === "POST") {
          try { commerceBridge = request.postDataJSON()?.action === "main-bind"; } catch { commerceBridge = false; }
        }
        if (commerceBridge) {
          await route.continue();
          return;
        }
        const canvasAutosave = canvasAutosaveBody(request);
        if (canvasAutosave) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              canvas: {
                id: canvasAutosave.canvasId,
                revision: canvasAutosave.expectedRevision + 1,
                updatedAt: new Date().toISOString(),
              },
            }),
          });
          return;
        }
        await route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      let activeRoute = "";
      page.on("pageerror", (error) => diagnostics.pageErrors.push(`${activeRoute} :: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (/status of 503 \(Service Unavailable\)/u.test(text) && activeRoute.startsWith("/youcai/skills")) return;
        diagnostics.consoleErrors.push(`${activeRoute} :: ${text}`);
      });
      page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText || "failed";
        if (reason === "net::ERR_ABORTED" && isBenignNavigationAbort(request)) return;
        diagnostics.requestFailures.push(`${activeRoute} :: ${request.method()} ${request.url()} :: ${reason}`);
      });
      page.on("request", (request) => {
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
          const item = `${activeRoute} :: ${request.method()} ${request.url()}`;
          const pathname = new URL(request.url()).pathname;
          let commerceBridge = false;
          if (pathname === "/api/commerce/session") {
            try { commerceBridge = request.postDataJSON()?.action === "main-bind"; } catch { commerceBridge = false; }
          }
          if (["/api/announcements/events", "/api/diagnostic-logs"].includes(pathname) || commerceBridge || canvasAutosaveBody(request)) diagnostics.benignMutations.push(item);
          else diagnostics.mutations.push(item);
        }
      });
      page.on("response", (response) => {
        if (response.status() === 429) {
          diagnostics.rateLimits.push(`${activeRoute} :: 429 ${response.url()}`);
          return;
        }
        if (response.status() < 400) return;
        const pathname = new URL(response.url()).pathname;
        const item = `${activeRoute} :: ${response.status()} ${response.url()}`;
        if (knownSchemaBlockers.some((prefix) => pathname.startsWith(prefix))) diagnostics.schemaBlockers.push(item);
        else diagnostics.serverErrors.push(item);
      });

      for (const route of routes) {
        activeRoute = route;
        const routeResult = await auditRoute(page, route, viewport);
        routeResults.push(routeResult);
        if (!routeResult.passed) {
          const safeRoute = route.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "home";
          await page.screenshot({
            path: path.join(evidenceDir, `${viewport}-${safeRoute}-failure.png`),
            fullPage: true,
          }).catch(() => undefined);
        }
      }
      if (viewport === "desktop") {
        activeRoute = "model-api";
        for (const pathname of explicitModelApiPaths) {
          apiResults.push(await auditModelApi(pathname));
        }
        activeRoute = "interactions";
        const interactionChecks = await runInteractionChecks(page);
        await writeFile(path.join(evidenceDir, "interaction-checks.json"), JSON.stringify(interactionChecks, null, 2), "utf8");
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const interactionChecks = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(path.join(evidenceDir, "interaction-checks.json"), "utf8"))) as Array<{ status: string }>;
  const failures = [
    ...routeResults.filter((entry) => !entry.passed).map((entry) => entry.failure || `${entry.viewport}:${entry.route} 页面验收失败`),
    ...apiResults.filter((entry) => !entry.passed).map((entry) => entry.failure || `${entry.path} 模型接口验收失败`),
    ...diagnostics.pageErrors,
    ...diagnostics.consoleErrors,
    ...diagnostics.requestFailures,
    ...diagnostics.serverErrors,
    ...diagnostics.rateLimits,
    ...diagnostics.mutations,
    ...interactionChecks.filter((entry) => entry.status !== "passed").map((entry) => JSON.stringify(entry)),
  ];
  const report = {
    runtimeOk: failures.length === 0,
    productionReady: failures.length === 0 && diagnostics.schemaBlockers.length === 0,
    generatedAt,
    build: await fetch(`${baseUrl}/api/version`).then((response) => response.json()),
    session: { userId: session.user.id, credits: session.user.credits, cashBalance: session.user.cashBalance },
    routeResults,
    apiResults,
    interactionChecks,
    diagnostics,
    failures,
    paidGenerationTriggered: diagnostics.mutations.some((entry) => /\/api\/(?:chat|llm|image|video|voice|payment)/u.test(entry)),
  };
  await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    runtimeOk: report.runtimeOk,
    productionReady: report.productionReady,
    evidenceDir,
    routes: routeResults.length,
    modelApis: apiResults,
    interactions: interactionChecks,
    diagnostics,
    paidGenerationTriggered: report.paidGenerationTriggered,
  }, null, 2));
  if (!report.productionReady) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
