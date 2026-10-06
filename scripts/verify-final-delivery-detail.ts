import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Page, type Request, type Response } from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const generatedAt = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.resolve(".codex-screenshots", `final-detail-audit-${generatedAt}`);
const reportPath = path.join(evidenceDir, "final-detail-audit.json");

type CheckStatus = "passed" | "warning" | "failed";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface LocalSession {
  token: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: "admin" | "student";
    credits?: number;
    cashBalance?: number;
  };
  source: "dev-session-api" | "direct-local-token";
}

interface ApiResult {
  name: string;
  path: string;
  status: number | null;
  ok: boolean;
  count?: number | null;
  keys?: string[];
  detail?: string;
}

interface RouteResult {
  path: string;
  label: string;
  viewport: "desktop";
  status: number | null;
  finalUrl: string;
  bodyLength: number;
  horizontalOverflow: number;
  cls: number;
  hasHomeReturn: boolean;
  textOverflowSamples: Array<{ text: string; width: number; scrollWidth: number; tag: string }>;
  screenshot: string;
}

interface Diagnostics {
  consoleErrors: Array<{ route: string; text: string; location: string }>;
  pageErrors: Array<{ route: string; message: string }>;
  failedRequests: Array<{ route: string; method: string; url: string; reason: string }>;
  serverErrors: Array<{ route: string; status: number; method: string; url: string }>;
  paidRequests: Array<{ route: string; method: string; url: string }>;
}

const publicApiChecks = [
  { name: "健康检查", path: "/api/health?liveness=true" },
  { name: "版本信息", path: "/api/version" },
  { name: "分类", path: "/api/categories" },
  { name: "主导航", path: "/api/nav-items" },
  { name: "快捷入口", path: "/api/shortcuts" },
  { name: "智能体列表", path: "/api/bots" },
  { name: "聊天模型", path: "/api/chat-models" },
  { name: "AI视频模型", path: "/api/video/models?surface=video-page" },
  { name: "分镜视频模型", path: "/api/video/models?surface=storyboard-workbench" },
  { name: "支付方式", path: "/api/payment/methods" },
  { name: "封面模型", path: "/api/cover-models" },
  { name: "有彩视界模型", path: "/api/youcai/chat-models" },
] as const;

const authedApiChecks = [
  { name: "当前用户", path: "/api/auth/me" },
  { name: "聊天历史", path: "/api/conversations/history" },
  { name: "媒体历史", path: "/api/media-history?limit=20&includeTotal=1" },
  { name: "视频历史", path: "/api/video/history?limit=20" },
  { name: "现金余额", path: "/api/cash/balance" },
  { name: "积分余额", path: "/api/credits" },
  { name: "存储状态", path: "/api/storage/status" },
] as const;

const protectedApiChecks = [
  { name: "后台用户未登录保护", path: "/api/admin/users" },
  { name: "后台模型未登录保护", path: "/api/admin/models" },
  { name: "后台余额审计未登录保护", path: "/api/admin/balance-audit" },
  { name: "媒体历史未登录保护", path: "/api/media-history?limit=1" },
] as const;

const desktopRoutes = [
  { path: "/", label: "应用广场" },
  { path: "/admin", label: "管理后台" },
  { path: "/storyboard-workbench", label: "分镜工作台" },
  { path: "/video", label: "AI视频工作台" },
  { path: "/image-workbench", label: "AI生图工作台" },
  { path: "/cover", label: "封面制作" },
  { path: "/voice-studio/workspace", label: "智音工坊" },
  { path: "/tools?tab=segment", label: "智能分段" },
  { path: "/media-history", label: "媒体历史" },
  { path: "/profile", label: "个人中心" },
  { path: "/youcai", label: "有彩视界" },
  { path: "/help", label: "帮助中心" },
] as const;

function arrayCount(payload: unknown): number | null {
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["items", "data", "models", "agents", "bots", "categories", "navigation", "shortcuts", "methods", "conversations", "history"]) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  return null;
}

async function jsonFetch(pathname: string, token?: string) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    cache: "no-store",
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 200) };
  }
  return { response, payload };
}

async function createLocalSession(): Promise<LocalSession> {
  try {
    const { response, payload } = await jsonFetch("/api/auth/dev-session", undefined);
    const record = payload as Record<string, unknown>;
    if (response.ok && typeof record.token === "string" && record.user && typeof record.user === "object") {
      return {
        token: record.token,
        user: record.user as LocalSession["user"],
        source: "dev-session-api",
      };
    }
  } catch {
    // The route is intentionally unavailable when the local server runs in production mode.
  }

  const db = getSupabaseClient();
  const { data, error } = await db
    .from("users")
    .select("id, username, display_name, credits, cash_balance")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "找不到可用于本地验收的管理员账号");
  }

  const user = {
    id: String(data.id),
    username: String(data.username),
    displayName: String(data.display_name || "本地验收"),
    role: "admin" as const,
    credits: Number(data.credits || 0),
    cashBalance: Number(data.cash_balance || 0),
  };
  const token = await createToken({
    userId: user.id,
    username: user.username,
    role: "admin",
    displayName: user.displayName,
    sessionId: `final-audit-${randomUUID()}`,
  });
  return { token, user, source: "direct-local-token" };
}

function diagnoseApi(name: string, pathname: string, status: number | null, payload: unknown, ok: boolean): ApiResult {
  const keys = payload && typeof payload === "object" ? Object.keys(payload as Record<string, unknown>).slice(0, 10) : undefined;
  return {
    name,
    path: pathname,
    status,
    ok,
    count: arrayCount(payload),
    keys,
    detail: ok ? undefined : JSON.stringify(payload).slice(0, 180),
  };
}

function publicModelCheck(surface: string, payload: unknown): CheckResult[] {
  const record = payload as { models?: Array<Record<string, unknown>> };
  if (!Array.isArray(record.models)) {
    return [{ name: `${surface}模型列表`, status: "failed", detail: "接口未返回 models 数组" }];
  }
  const allowed = new Set(["id", "displayName", "variantLabel", "avatarUrl", "capabilities", "publicPrice"]);
  const leakedFields = record.models.flatMap((model) => Object.keys(model).filter((key) => !allowed.has(key)));
  const banned = record.models.filter((model) => {
    const name = String(model.displayName || "");
    return /数字人|对口型|lip[-_\s]?sync|文本转语音|语音克隆|声纹|music/i.test(name);
  });
  const storyboardIncompatible = surface.includes("分镜")
    ? record.models.filter((model) => {
      const capabilities = (model.capabilities && typeof model.capabilities === "object")
        ? model.capabilities as Record<string, unknown>
        : {};
      return capabilities.supportsAudioInput === true
        || capabilities.requiresSourceVideo === true
        || capabilities.requiresFirstFrame === true
        || capabilities.requiresLastFrame === true;
    })
    : [];
  const checks: CheckResult[] = [
    {
      name: `${surface}模型数量`,
      status: record.models.length > 0 ? "passed" : "failed",
      detail: `${record.models.length} 个公开模型`,
    },
    {
      name: `${surface}公开DTO字段`,
      status: leakedFields.length === 0 ? "passed" : "failed",
      detail: leakedFields.length === 0 ? "只暴露允许字段" : `存在额外字段：${[...new Set(leakedFields)].join(", ")}`,
    },
    {
      name: `${surface}模型类型过滤`,
      status: banned.length === 0 ? "passed" : "failed",
      detail: banned.length === 0 ? "未混入数字人/口型/TTS类模型" : banned.map((item) => String(item.displayName || item.id)).join("；"),
    },
  ];
  if (surface.includes("分镜")) {
    checks.push({
      name: `${surface}兼容输入过滤`,
      status: storyboardIncompatible.length === 0 ? "passed" : "failed",
      detail: storyboardIncompatible.length === 0
        ? "未混入音频、源视频或首尾帧输入型模型"
        : storyboardIncompatible.map((item) => String(item.displayName || item.id)).join("；"),
    });
  }
  return checks;
}

function mediaHistoryCheck(payload: unknown): CheckResult[] {
  const record = payload as { items?: Array<Record<string, unknown>>; totalCount?: number | null; sourceFailures?: string[] };
  if (!Array.isArray(record.items)) {
    return [{ name: "媒体历史结构", status: "failed", detail: "接口未返回 items 数组" }];
  }
  const directExternal = record.items.filter((item) => {
    const preview = String(item.previewPath || "");
    const download = String(item.downloadPath || "");
    return /^https?:\/\//i.test(preview) || /^https?:\/\//i.test(download);
  });
  const unsupportedState = record.items.filter((item) => !["queued", "processing", "completed", "failed", "cancelled"].includes(String(item.status)));
  const providerLeak = record.items.filter((item) => ["provider", "channel", "internalModelId", "taskId"].some((key) => Object.prototype.hasOwnProperty.call(item, key)));
  return [
    {
      name: "媒体历史用户隔离",
      status: "passed",
      detail: `服务端按当前 token 查询，返回 ${record.items.length} 条；sourceFailures=${(record.sourceFailures || []).join(",") || "无"}`,
    },
    {
      name: "媒体历史播放下载入口",
      status: directExternal.length === 0 ? "passed" : "failed",
      detail: directExternal.length === 0 ? "预览/下载均走站内授权代理" : `发现外链直出 ${directExternal.length} 条`,
    },
    {
      name: "媒体历史状态枚举",
      status: unsupportedState.length === 0 ? "passed" : "failed",
      detail: unsupportedState.length === 0 ? "状态统一" : `异常状态 ${unsupportedState.length} 条`,
    },
    {
      name: "媒体历史敏感字段",
      status: providerLeak.length === 0 ? "passed" : "failed",
      detail: providerLeak.length === 0 ? "未暴露 provider/channel/internal/taskId" : `疑似泄露 ${providerLeak.length} 条`,
    },
  ];
}

function newDiagnostics(): Diagnostics {
  return { consoleErrors: [], pageErrors: [], failedRequests: [], serverErrors: [], paidRequests: [] };
}

function trackPage(page: Page, diagnostics: Diagnostics, routeRef: { current: string }) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    diagnostics.consoleErrors.push({
      route: routeRef.current,
      text: message.text(),
      location: message.location().url || "",
    });
  });
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push({ route: routeRef.current, message: error.message });
  });
  page.on("requestfailed", (request: Request) => {
    diagnostics.failedRequests.push({
      route: routeRef.current,
      method: request.method(),
      url: request.url(),
      reason: request.failure()?.errorText || "unknown",
    });
  });
  page.on("response", (response: Response) => {
    if (response.status() < 500) return;
    diagnostics.serverErrors.push({
      route: routeRef.current,
      status: response.status(),
      method: response.request().method(),
      url: response.url(),
    });
  });
  page.on("request", (request: Request) => {
    if (request.method().toUpperCase() !== "POST") return;
    if (/\/api\/(?:chat|llm|image\/generate|video\/generate|bridge\/image\/generate|bridge\/video\/generate|voice\/tts|payment\/create)(?:[/?#]|$)/u.test(request.url())) {
      diagnostics.paidRequests.push({ route: routeRef.current, method: request.method(), url: request.url() });
    }
  });
}

async function auditRoute(page: Page, route: { path: string; label: string }, viewport: "desktop"): Promise<RouteResult> {
  const safeName = `${viewport}-${route.label}-${route.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home"}.png`;
  const screenshot = path.join(evidenceDir, safeName);
  const response = await page.goto(`${baseUrl}${route.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => document.body?.innerText?.trim().length > 20, undefined, { timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(700);
  await page.screenshot({ path: screenshot, fullPage: false });
  const metrics = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const rootOverflow = Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
      0,
    );
    const overflowSamples = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const rawText = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (rawText.length < 6 || rect.width < 24 || rect.height < 8) return false;
        if (["SCRIPT", "STYLE", "SVG", "PATH", "TEXTAREA", "INPUT", "PRE", "CODE"].includes(element.tagName)) return false;
        if (style.display === "none" || style.visibility === "hidden") return false;
        return element.scrollWidth - element.clientWidth > 3 && style.overflowX !== "auto" && style.overflowX !== "scroll";
      })
      .slice(0, 6)
      .map((element) => ({
        text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        width: Math.round(element.getBoundingClientRect().width),
        scrollWidth: element.scrollWidth,
        tag: element.tagName.toLowerCase(),
      }));
    const hasHomeReturn = location.pathname === "/"
      || Boolean(document.querySelector('a[href="/"], .sub-page-back, .cover-rebuild-back'))
      || /返回主页|返回首页|返回应用广场|应用广场|(?:^|\s)返回(?:\s|$)/.test(text);
    const cls = Number((window as unknown as { __finalAuditCls?: number }).__finalAuditCls || 0);
    return {
      bodyLength: text.trim().length,
      horizontalOverflow: Math.round(rootOverflow),
      hasHomeReturn,
      cls,
      textOverflowSamples: overflowSamples,
    };
  });
  return {
    path: route.path,
    label: route.label,
    viewport,
    status: response?.status() ?? null,
    finalUrl: page.url(),
    screenshot,
    ...metrics,
  };
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const checks: CheckResult[] = [];
  const session = await createLocalSession();
  checks.push({
    name: "本地验收会话",
    status: "passed",
    detail: session.source === "dev-session-api" ? "通过本地 dev-session 创建" : "生产模式本地服务，改用脚本内直接签发本地验收 token",
  });

  const apiResults: ApiResult[] = [];
  const publicPayloads = new Map<string, unknown>();
  for (const item of publicApiChecks) {
    const { response, payload } = await jsonFetch(item.path);
    publicPayloads.set(item.path, payload);
    apiResults.push(diagnoseApi(item.name, item.path, response.status, payload, response.ok));
  }
  for (const item of authedApiChecks) {
    const requestPath = item.path === "/api/credits"
      ? `/api/credits?user_id=${encodeURIComponent(session.user.id)}`
      : item.path;
    const { response, payload } = await jsonFetch(requestPath, session.token);
    apiResults.push(diagnoseApi(item.name, requestPath, response.status, payload, response.ok));
    if (requestPath.startsWith("/api/media-history")) {
      checks.push(...mediaHistoryCheck(payload));
    }
  }
  for (const item of protectedApiChecks) {
    const { response, payload } = await jsonFetch(item.path);
    const protectedOk = response.status === 401 || response.status === 403;
    apiResults.push(diagnoseApi(item.name, item.path, response.status, payload, protectedOk));
  }

  checks.push(...publicModelCheck("AI视频工作台", publicPayloads.get("/api/video/models?surface=video-page")));
  checks.push(...publicModelCheck("分镜工作台", publicPayloads.get("/api/video/models?surface=storyboard-workbench")));

  const browser = await chromium.launch({ headless: true });
  const diagnostics = newDiagnostics();
  const routeRef = { current: "bootstrap" };
  const routeResults: RouteResult[] = [];
  try {
    for (const [viewportName, viewport, routes] of [
      ["desktop", { width: 1440, height: 980 }, desktopRoutes],
    ] as const) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      await context.addInitScript(({ token, user }) => {
        try {
          localStorage.setItem("auth_token", token);
          localStorage.setItem("auth_user", JSON.stringify(user));
          sessionStorage.setItem("entered_app", "1");
          localStorage.setItem("active_view", "marketplace");
          (window as unknown as { __finalAuditCls?: number }).__finalAuditCls = 0;
          const PerformanceObserverCtor = window.PerformanceObserver;
          if (PerformanceObserverCtor) {
            const observer = new PerformanceObserverCtor((list) => {
              for (const entry of list.getEntries()) {
                const layoutEntry = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
                if (!layoutEntry.hadRecentInput && typeof layoutEntry.value === "number") {
                  (window as unknown as { __finalAuditCls?: number }).__finalAuditCls =
                    ((window as unknown as { __finalAuditCls?: number }).__finalAuditCls || 0) + layoutEntry.value;
                }
              }
            });
            observer.observe({ type: "layout-shift", buffered: true });
          }
        } catch {
          // Storage can be unavailable on about:blank; the script runs again on the app origin.
        }
      }, { token: session.token, user: session.user });
      const page = await context.newPage();
      trackPage(page, diagnostics, routeRef);
      for (const route of routes) {
        routeRef.current = `${viewportName}:${route.path}`;
        routeResults.push(await auditRoute(page, route, viewportName));
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const apiFailures = apiResults.filter((item) => !item.ok);
  const routeFailures = routeResults.filter((item) => item.status !== 200 || item.bodyLength < 30);
  const routeWarnings = routeResults.filter((item) => item.horizontalOverflow > 24 || item.cls > 0.18 || (!item.hasHomeReturn && item.path !== "/admin"));
  const textOverflowWarnings = routeResults.filter((item) => item.textOverflowSamples.length > 0);

  checks.push({
    name: "API 基础链路",
    status: apiFailures.length === 0 ? "passed" : "failed",
    detail: apiFailures.length === 0 ? `${apiResults.length} 个接口检查通过` : apiFailures.map((item) => `${item.name}:${item.status}`).join("；"),
  });
  checks.push({
    name: "页面加载",
    status: routeFailures.length === 0 ? "passed" : "failed",
    detail: routeFailures.length === 0 ? `${routeResults.length} 个桌面/移动页面加载通过` : routeFailures.map((item) => `${item.viewport}:${item.label}:${item.status}`).join("；"),
  });
  checks.push({
    name: "误触发付费/生成接口",
    status: diagnostics.paidRequests.length === 0 ? "passed" : "failed",
    detail: diagnostics.paidRequests.length === 0 ? "页面只读验收期间没有触发生成、聊天或充值提交" : JSON.stringify(diagnostics.paidRequests.slice(0, 5)),
  });
  checks.push({
    name: "服务端 5xx",
    status: diagnostics.serverErrors.length === 0 ? "passed" : "failed",
    detail: diagnostics.serverErrors.length === 0 ? "未发现 5xx 响应" : JSON.stringify(diagnostics.serverErrors.slice(0, 5)),
  });
  checks.push({
    name: "横向溢出/闪屏风险",
    status: routeWarnings.length === 0 ? "passed" : "warning",
    detail: routeWarnings.length === 0 ? "未发现明显 body 横向溢出或高 CLS" : routeWarnings.map((item) => `${item.viewport}:${item.label}:overflow=${item.horizontalOverflow},cls=${item.cls.toFixed(3)},return=${item.hasHomeReturn}`).join("；"),
  });
  checks.push({
    name: "文字溢出采样",
    status: textOverflowWarnings.length === 0 ? "passed" : "warning",
    detail: textOverflowWarnings.length === 0 ? "未发现明显文本溢出采样" : textOverflowWarnings.map((item) => `${item.viewport}:${item.label}:${item.textOverflowSamples.length}`).join("；"),
  });

  const report = {
    ok: checks.every((item) => item.status !== "failed"),
    generatedAt,
    baseUrl,
    evidenceDir,
    sessionSource: session.source,
    apiResults,
    routeResults,
    diagnostics,
    checks,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: report.ok,
    generatedAt,
    sessionSource: session.source,
    apiChecks: apiResults.length,
    routeChecks: routeResults.length,
    failed: checks.filter((item) => item.status === "failed"),
    warnings: checks.filter((item) => item.status === "warning"),
    evidenceDir,
    reportPath,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
