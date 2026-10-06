import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const generatedAt = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", `youcai-nav-performance-${generatedAt}`);

type AuthSession = {
  token: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: "admin";
    credits: number;
    cashBalance: number;
  };
};

type StepResult = {
  label: string;
  expectedPath: string;
  finalPath: string;
  elapsedMs: number;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  resourceCount: number;
  heavyResources: Array<{ name: string; transferSize: number; duration: number; initiatorType: string }>;
  brokenImages: string[];
  longTasks: Array<{ duration: number; name: string }>;
};

async function createSession(): Promise<AuthSession> {
  const acceptanceToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  if (acceptanceToken) {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${acceptanceToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json() as { user?: AuthSession["user"] };
    assert.ok(response.ok && payload.user?.role === "admin", "LOCAL_ACCEPTANCE_ADMIN_REQUIRED");
    return { token: acceptanceToken, user: payload.user };
  }
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("users")
    .select("id, username, display_name, credits, cash_balance")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || "找不到管理员验收账号");
  const user = {
    id: String(data.id),
    username: String(data.username),
    displayName: String(data.display_name || "管理员验收"),
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
      sessionId: `youcai-nav-perf-${randomUUID()}`,
    }),
  };
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

async function clickNavigation(page: Page, label: string, expectedPath: string): Promise<StepResult> {
  await page.evaluate(() => {
    performance.clearResourceTimings();
    (window as typeof window & { __codexLongTasks?: unknown[] }).__codexLongTasks = [];
  });
  const locator = page.locator(`a:has-text(${jsString(label)}), button:has-text(${jsString(label)})`).first();
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  const startedAt = Date.now();
  await Promise.all([
    page.waitForURL((url) => url.pathname === expectedPath, { timeout: 20_000 }),
    locator.click(),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
  const elapsedMs = Date.now() - startedAt;

  const inspected = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const heavyResources = resources
      .filter((entry) => (
        entry.transferSize > 450_000
        || entry.encodedBodySize > 450_000
        || entry.duration > 1_200
      ))
      .map((entry) => ({
        name: entry.name,
        transferSize: Math.round(entry.transferSize || entry.encodedBodySize || 0),
        duration: Math.round(entry.duration),
        initiatorType: entry.initiatorType,
      }))
      .slice(-20);
    const brokenImages = Array.from(document.images)
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src)
      .slice(0, 20);
    return {
      finalPath: location.pathname,
      domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
      loadMs: navigation ? Math.round(navigation.loadEventEnd) : null,
      resourceCount: resources.length,
      heavyResources,
      brokenImages,
      longTasks: ((window as typeof window & { __codexLongTasks?: Array<{ duration: number; name: string }> }).__codexLongTasks || [])
        .filter((entry) => entry.duration >= 50)
        .slice(-20)
        .map((entry) => ({ duration: Math.round(entry.duration), name: entry.name || "longtask" })),
    };
  });

  assert.equal(inspected.finalPath, expectedPath, `${label} did not navigate to ${expectedPath}`);
  assert.equal(inspected.brokenImages.length, 0, `${label} has broken images`);
  return {
    label,
    expectedPath,
    elapsedMs,
    ...inspected,
  };
}

async function openMarketplace(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".marketplace-shell, .nav-pill").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const session = await createSession();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  await context.addCookies([{ name: "auth_token", value: session.token, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
    (window as typeof window & { __codexLongTasks?: Array<{ duration: number; name: string }> }).__codexLongTasks = [];
    try {
      new PerformanceObserver((list) => {
        const store = (window as typeof window & { __codexLongTasks?: Array<{ duration: number; name: string }> }).__codexLongTasks || [];
        for (const entry of list.getEntries()) {
          store.push({ duration: entry.duration, name: entry.name });
        }
        (window as typeof window & { __codexLongTasks?: Array<{ duration: number; name: string }> }).__codexLongTasks = store.slice(-80);
      }).observe({ entryTypes: ["longtask"] });
    } catch {}
  }, session);

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 260));
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText || "failed";
    if (reason === "net::ERR_ABORTED" && /\.(?:mp4|webm)(?:[?#]|$)/iu.test(request.url())) return;
    if (reason === "net::ERR_ABORTED" && /[?&]_rsc=/u.test(request.url())) return;
    if (reason === "net::ERR_ABORTED" && /\/api\/(?:bridge\/balance|youcai\/skills)(?:[/?#]|$)/u.test(request.url())) return;
    requestFailures.push(`${request.method()} ${request.url()} :: ${reason}`.slice(0, 360));
  });

  try {
    const steps: StepResult[] = [];

    const marketplaceSteps = [
      ["漫剧工作台", "/youcai"],
      ["工具箱", "/tools"],
      ["视频制作", "/video"],
      ["分镜工作台", "/storyboard-workbench"],
      ["AI生图工作台", "/image-workbench"],
      ["智音工坊", "/voice-studio/workspace"],
      ["封面制作", "/cover"],
    ] as const;

    for (const [label, expectedPath] of marketplaceSteps) {
      await openMarketplace(page);
      steps.push(await clickNavigation(page, label, expectedPath));
    }

    await openMarketplace(page);
    steps.push(await clickNavigation(page, "漫剧工作台", "/youcai"));
    steps.push(await clickNavigation(page, "Skill 专家", "/youcai/skills"));
    steps.push(await clickNavigation(page, "灵感广场", "/youcai/inspiration"));
    steps.push(await clickNavigation(page, "漫剧画布", "/youcai/tools/canvas"));
    steps.push(await clickNavigation(page, "漫剧TV", "/youcai/youcai-tv"));
    steps.push(await clickNavigation(page, "返回主页", "/"));

    const slowSteps = steps.filter((step) => step.elapsedMs > 1800 || step.longTasks.some((task) => task.duration > 180));
    const report = {
      verifier: "youcai-nav-performance",
      ok: slowSteps.length === 0 && consoleErrors.length === 0 && requestFailures.length === 0,
      baseUrl,
      generatedAt: new Date().toISOString(),
      thresholds: {
        softNavigationMs: 1800,
        longTaskMs: 180,
      },
      summary: {
        steps: steps.length,
        slowSteps: slowSteps.length,
        consoleErrors: consoleErrors.length,
        requestFailures: requestFailures.length,
      },
      steps,
      slowSteps,
      consoleErrors,
      requestFailures,
    };
    await writeFile(path.join(evidenceDir, "youcai-nav-performance.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
