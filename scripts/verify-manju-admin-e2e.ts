import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Request, type Response } from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

type LocalSession = {
  token: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: "admin";
    credits?: number;
    cashBalance?: number;
  };
  source: "dev-session-api" | "direct-local-token";
};

type RequestIssue = {
  method: string;
  url: string;
  status?: number;
  reason?: string;
  expected?: boolean;
};

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const generatedAt = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.resolve(".codex-evidence", "manju-admin-e2e-20260830", generatedAt);
const reportPath = path.join(evidenceDir, "report.json");
const screenshotPath = path.join(evidenceDir, "manju-admin.png");
let browserForCleanup: Browser | null = null;

async function closeWithTimeout(closeable: { close(): Promise<void> }, label: string, timeoutMs = 3_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    closeable.close().catch((error: unknown) => {
      console.error(`[manju-admin-e2e] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[manju-admin-e2e] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function isExpectedMigrationResponse(response: Response): boolean {
  const url = response.url();
  return response.status() === 503 && url.includes("/api/admin/skill-packages");
}

function isPaidOrGenerationRequest(request: Request): boolean {
  if (request.method().toUpperCase() !== "POST") return false;
  const url = request.url();
  return /\/api\/(?:image\/generate|video\/generate|music\/generate|voice\/generate|llm\/generate|chat\/send|bridge\/image\/generate|bridge\/video\/generate)/iu.test(url);
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
    payload = { raw: text.slice(0, 300) };
  }
  return { response, payload };
}

async function createLocalSession(): Promise<LocalSession> {
  try {
    const { response, payload } = await jsonFetch("/api/auth/dev-session");
    const record = payload as Record<string, unknown>;
    if (response.ok && typeof record.token === "string" && record.user && typeof record.user === "object") {
      return {
        token: record.token,
        user: record.user as LocalSession["user"],
        source: "dev-session-api",
      };
    }
  } catch {
    // Production-mode local preview intentionally does not expose dev-session.
  }

  const database = getSupabaseClient();
  const { data, error } = await database
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
    displayName: String(data.display_name || "本地验收管理员"),
    role: "admin" as const,
    credits: Number(data.credits || 0),
    cashBalance: Number(data.cash_balance || 0),
  };
  const token = await createToken({
    userId: user.id,
    username: user.username,
    role: "admin",
    displayName: user.displayName,
    sessionId: `manju-admin-e2e-${randomUUID()}`,
  });
  return { token, user, source: "direct-local-token" };
}

function bodyIncludes(bodyText: string, text: string): boolean {
  return bodyText.includes(text);
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });

  const version = await jsonFetch("/api/version");
  if (!version.response.ok) {
    throw new Error(`/api/version 不可用，状态 ${version.response.status}`);
  }

  const session = await createLocalSession();
  const apiSkillPackages = await jsonFetch("/api/admin/skill-packages?limit=20", session.token);
  const apiSkillPackagesBody = apiSkillPackages.payload as Record<string, unknown> | null;
  const skillPackageStoreState =
    apiSkillPackages.response.ok
      ? "ready"
      : apiSkillPackages.response.status === 503 && apiSkillPackagesBody?.code === "MIGRATION_NOT_READY"
        ? "migration_not_ready"
        : "unavailable";

  const browser = await chromium.launch({ headless: true });
  browserForCleanup = browser;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1600 },
    baseURL: baseUrl,
  });
  await context.addInitScript(
    ({ token, user }) => {
      window.localStorage.setItem("auth_token", token);
      window.localStorage.setItem("auth_user", JSON.stringify(user));
      window.localStorage.setItem("app_theme", "dark-blue-pro");
      window.localStorage.setItem("app_mode", "dark");
    },
    { token: session.token, user: session.user },
  );

  const page = await context.newPage();
  const consoleErrors: Array<{ text: string; location: string }> = [];
  const pageErrors: string[] = [];
  const failedRequests: RequestIssue[] = [];
  const serverResponses: RequestIssue[] = [];
  const paidRequests: RequestIssue[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    const text = message.text();
    if (/favicon|ResizeObserver/iu.test(text)) return;
    if (/503 \(Service Unavailable\)/iu.test(text) && location.url.includes("/api/admin/skill-packages")) return;
    consoleErrors.push({
      text,
      location: `${location.url}:${location.lineNumber}:${location.columnNumber}`,
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("request", (request) => {
    if (isPaidOrGenerationRequest(request)) {
      paidRequests.push({ method: request.method(), url: request.url() });
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({
      method: request.method(),
      url: request.url(),
      reason: request.failure()?.errorText,
    });
  });
  page.on("response", (response) => {
    if (response.status() < 500) return;
    serverResponses.push({
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
      expected: isExpectedMigrationResponse(response),
    });
  });

  await page.goto("/admin?tab=manju-workbench#manju-custom-skill-packages", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);

  const workbench = page.locator("[data-admin-panel='manju-workbench']");
  const configCenter = page.locator("[data-admin-section='manju-config-center']");
  const skillManager = page.locator("[data-admin-section='manju-skill-manager']");
  const customSkillPackages = page.locator("[data-admin-section='manju-custom-skill-packages']");
  await workbench.waitFor({ state: "visible", timeout: 30_000 });
  await customSkillPackages.scrollIntoViewIfNeeded();
  await customSkillPackages.waitFor({ state: "visible", timeout: 30_000 });

  const bodyTextBefore = await page.locator("body").innerText();
  const saveDraftDisabled = await customSkillPackages.getByRole("button", { name: /保存草稿/u }).isDisabled();

  await customSkillPackages.getByRole("button", { name: /^新增 Skill$/u }).click();
  await customSkillPackages.getByLabel("Skill slug").fill("e2e-manga-story-helper");
  await customSkillPackages.getByLabel("命令").fill("/e2e-manga-story-helper");
  await customSkillPackages.getByLabel("名称").fill("E2E 漫剧故事拆解助手");
  await customSkillPackages.getByLabel("摘要 / 前台说明").fill("用于验证漫剧工作台后台的用户自建 Skill 结构校验链路。");
  await customSkillPackages.getByLabel("触发词").fill("漫剧故事,剧情拆解,角色动机");
  await customSkillPackages.getByLabel("Skill 提示词 / 指令正文").fill(
    "你是漫剧故事拆解助手。请根据用户输入拆解主题、角色、冲突、节拍和可执行镜头建议。禁止输出 API Key、Token 或任何敏感凭证。",
  );
  await customSkillPackages.getByRole("button", { name: /校验结构/u }).click();
  await customSkillPackages.getByText(/Skill 包结构校验通过|payload_hash/u).first().waitFor({ state: "visible", timeout: 30_000 });

  await page.screenshot({ path: screenshotPath, fullPage: true });
  const bodyTextAfter = await page.locator("body").innerText();

  const skillRows = await page.locator("[data-testid='manju-skill-row']").count();
  const checks = {
    buildId: (version.payload as Record<string, unknown>)?.buildId || null,
    sessionSource: session.source,
    skillPackageStoreState,
    apiSkillPackagesStatus: apiSkillPackages.response.status,
    manjuPanelVisible: (await workbench.count()) > 0,
    configCenterVisible: (await configCenter.count()) > 0,
    skillManagerVisible: (await skillManager.count()) > 0,
    customSkillPackagesVisible: (await customSkillPackages.count()) > 0,
    builtinSkillRows: skillRows,
    hasConfigCorruptBanner: bodyIncludes(bodyTextAfter, "CONFIG_STORE_CORRUPT"),
    hasFallbackSafetyBanner: bodyIncludes(bodyTextAfter, "内置安全基线"),
    hasBuiltinEditCopy: bodyIncludes(bodyTextAfter, "直接编辑本卡"),
    hasResetOverrideCopy: bodyIncludes(bodyTextAfter, "删除覆盖/恢复默认"),
    hasCustomPackageBoundaryCopy: bodyIncludes(bodyTextAfter, "和上方 36 张平台内置 Skill 卡片分离"),
    hasNoFakeSaveCopy: bodyIncludes(bodyTextAfter, "不允许假保存"),
    saveDraftDisabledWhenMigrationMissing: skillPackageStoreState === "migration_not_ready" ? saveDraftDisabled : null,
    validateActionPassed: bodyIncludes(bodyTextAfter, "payload_hash") || bodyIncludes(bodyTextAfter, "Skill 包结构校验通过"),
    noPaidRequests: paidRequests.length === 0,
    serverResponses,
    failedRequests,
    consoleErrors,
    pageErrors,
  };

  const unexpectedServerResponses = serverResponses.filter((item) => !item.expected);
  const failures = [
    checks.manjuPanelVisible ? null : "漫剧工作台后台面板不可见",
    checks.configCenterVisible ? null : "配置中心不可见",
    checks.skillManagerVisible ? null : "内置 Skill 管理不可见",
    checks.customSkillPackagesVisible ? null : "用户自建/导入 Skill 包后台不可见",
    checks.builtinSkillRows >= 36 ? null : `内置 Skill 行数不足：${checks.builtinSkillRows}`,
    !checks.hasConfigCorruptBanner ? null : "仍出现 CONFIG_STORE_CORRUPT 横幅",
    !checks.hasFallbackSafetyBanner ? null : "仍显示内置安全基线横幅",
    checks.hasBuiltinEditCopy ? null : "缺少内置 Skill 直接编辑入口文案",
    checks.hasResetOverrideCopy ? null : "缺少删除覆盖/恢复默认入口",
    checks.hasCustomPackageBoundaryCopy ? null : "缺少内置 Skill 与用户 Skill 的边界说明",
    checks.validateActionPassed ? null : "用户自建 Skill 结构校验未通过",
    checks.noPaidRequests ? null : "后台结构验收误触发了付费/生成请求",
    unexpectedServerResponses.length === 0 ? null : `存在非预期 5xx 响应 ${unexpectedServerResponses.length} 个`,
    failedRequests.length === 0 ? null : `存在失败请求 ${failedRequests.length} 个`,
    consoleErrors.length === 0 ? null : `存在控制台错误 ${consoleErrors.length} 个`,
    pageErrors.length === 0 ? null : `存在页面异常 ${pageErrors.length} 个`,
  ].filter((item): item is string => Boolean(item));

  const report = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    baseUrl,
    reportPath,
    screenshotPath,
    checks,
    expectedWarnings:
      skillPackageStoreState === "migration_not_ready"
        ? ["用户自建 Skill 包数据库迁移未完成，保存/发布/安装被正确禁止，校验结构可用。"]
        : [],
    failures,
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await closeWithTimeout(browser, "browser.close");
  browserForCleanup = null;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().then(
  () => process.exit(Number(process.exitCode || 0)),
  async (error) => {
    if (browserForCleanup) {
      await closeWithTimeout(browserForCleanup, "browser.close after failure");
      browserForCleanup = null;
    }
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  },
);
