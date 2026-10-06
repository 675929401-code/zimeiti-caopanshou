import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { chromium } from "playwright";

dotenv.config({ path: ".env.local", quiet: true });

const origin = "http://127.0.0.1:5000";
const output = process.argv[2] || ".codex-evidence/manju-current/runtime-navigation.json";
const localRuntimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
for (const name of ["JWT_SECRET", "COZE_SUPABASE_URL", "COZE_SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) throw new Error(`MISSING_${name}`);
}

const db = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const report = {
  observedAt: new Date().toISOString(),
  origin,
  mode: "local-readonly-browser",
  paidGenerationRequests: 0,
  databaseWrites: 0,
  externalRequestsBlocked: 0,
  mutationRequestsBlocked: 0,
  roles: [],
};

function safePath(value) {
  const url = new URL(value, origin);
  return url.origin === origin ? `${url.pathname}${url.search}` : "external";
}

function jwtCandidates() {
  const candidates = [process.env.JWT_SECRET];
  try {
    const runtime = JSON.parse(fs.readFileSync(localRuntimePath, "utf8"));
    candidates.push(runtime?.jwtSecret, runtime?.process?.env?.JWT_SECRET);
  } catch {
    // The checked-in .env.local candidate remains available when the runtime file is absent.
  }
  return [...new Set(candidates.filter((value) => typeof value === "string" && value.length > 0))];
}

async function tokenFor(user) {
  for (const secret of jwtCandidates()) {
    const token = await new SignJWT({
      userId: user.id,
      username: user.username || user.email || "local-acceptance",
      role: user.role,
      displayName: user.display_name || "本地验收",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30m")
      .sign(new TextEncoder().encode(secret));
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!response || response.status !== 200) continue;
    const body = await response.json().catch(() => null);
    if (body?.user?.role === user.role) return token;
  }
  throw new Error(`NO_VALID_LOCAL_RUNTIME_SESSION_FOR_${user.role}`);
}

async function inspectRole(browser, user) {
  const roleResult = {
    role: user.role,
    identityVerified: false,
    initial: {},
    transitions: [],
    httpErrors: [],
    pageErrors: [],
    requestFailures: [],
  };
  const token = await tokenFor(user);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    serviceWorkers: "block",
  });
  await context.addInitScript(({ tokenValue, expectedOrigin }) => {
    if (location.origin !== expectedOrigin) return;
    localStorage.setItem("auth_token", tokenValue);
    const samples = [];
    const started = performance.now();
    const sample = () => {
      const sidebar = document.querySelector('[data-testid="film-studio-sidebar"]');
      const main = document.querySelector('[data-testid="manju-content"]');
      const sidebarRect = sidebar?.getBoundingClientRect();
      const mainRect = main?.getBoundingClientRect();
      samples.push({
        atMs: Math.round(performance.now() - started),
        readyState: document.readyState,
        sidebarVisible: Boolean(sidebarRect && sidebarRect.width > 0 && sidebarRect.height > 0),
        sidebarWidth: sidebarRect ? Math.round(sidebarRect.width) : 0,
        mainVisible: Boolean(mainRect && mainRect.width > 0 && mainRect.height > 0),
        mainLeft: mainRect ? Math.round(mainRect.left) : 0,
        mainWidth: mainRect ? Math.round(mainRect.width) : 0,
      });
      if (performance.now() - started < 2200) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__manjuAcceptance = { samples, documentMarker: `${Date.now()}-${Math.random()}` };
  }, { tokenValue: token, expectedOrigin: origin });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      report.externalRequestsBlocked += 1;
      return route.abort("blockedbyclient");
    }
    if (!["GET", "HEAD"].includes(request.method())) {
      report.mutationRequestsBlocked += 1;
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/api/health" && !url.searchParams.has("liveness") && !url.searchParams.has("logs")) {
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => roleResult.pageErrors.push({ name: error.name, message: error.message.slice(0, 160) }));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "REQUEST_FAILED";
    if (failure.includes("ERR_BLOCKED_BY_CLIENT")) return;
    roleResult.requestFailures.push({ path: safePath(request.url()), method: request.method(), failure });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith("/api/") && response.status() >= 400) {
      roleResult.httpErrors.push({ path: `${url.pathname}${url.search}`, status: response.status() });
    }
  });

  const response = await page.goto(`${origin}/youcai`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `${user.role}: initial document must be 200`);
  await page.locator('[data-testid="film-studio-sidebar"]').waitFor({ state: "visible", timeout: 45_000 });
  await page.locator('[data-testid="manju-content"]').waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForTimeout(2300);
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${localStorage.getItem("auth_token")}` } });
    const body = await response.json();
    return { status: response.status, role: body.user?.role };
  });
  assert.equal(me.status, 200);
  assert.equal(me.role, user.role);
  roleResult.identityVerified = true;
  roleResult.initial = await page.evaluate(() => {
    const all = window.__manjuAcceptance?.samples || [];
    const visible = all.filter((item) => item.mainVisible || item.sidebarVisible);
    const firstVisible = visible[0] || null;
    const gapFrames = visible.filter((item) => item.mainVisible && !item.sidebarVisible);
    const sidebarWidths = visible.filter((item) => item.sidebarVisible).map((item) => item.sidebarWidth);
    const mainLefts = visible.filter((item) => item.mainVisible && item.sidebarVisible).map((item) => item.mainLeft);
    const sidebar = document.querySelector('[data-testid="film-studio-sidebar"]');
    if (sidebar) sidebar.dataset.acceptanceIdentity = "persistent-manju-shell";
    return {
      documentMarker: window.__manjuAcceptance?.documentMarker,
      sampleCount: all.length,
      firstVisible,
      shellGapFrameCount: gapFrames.length,
      sidebarWidthRange: sidebarWidths.length ? [Math.min(...sidebarWidths), Math.max(...sidebarWidths)] : null,
      mainLeftRange: mainLefts.length ? [Math.min(...mainLefts), Math.max(...mainLefts)] : null,
      sidebarCount: document.querySelectorAll('[data-testid="film-studio-sidebar"]').length,
      mainCount: document.querySelectorAll('[data-testid="manju-content"]').length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      fatalText: /Application error|Unhandled Runtime Error|This page could not be found/iu.test(document.body.innerText),
      performanceNavigationEntries: performance.getEntriesByType("navigation").length,
    };
  });
  assert.equal(roleResult.initial.shellGapFrameCount, 0, `${user.role}: content appeared without its left shell`);
  assert.equal(roleResult.initial.sidebarCount, 1, `${user.role}: one persistent sidebar expected`);
  assert.equal(roleResult.initial.mainCount, 1, `${user.role}: one main container expected`);
  assert.equal(roleResult.initial.horizontalOverflow, false, `${user.role}: initial horizontal overflow`);
  assert.equal(roleResult.initial.fatalText, false, `${user.role}: fatal page text`);
  assert.deepEqual(roleResult.initial.sidebarWidthRange?.[0], roleResult.initial.sidebarWidthRange?.[1], `${user.role}: sidebar width shifted during first paint`);
  assert.deepEqual(roleResult.initial.mainLeftRange?.[0], roleResult.initial.mainLeftRange?.[1], `${user.role}: main column shifted during first paint`);

  const targets = [
    ["创作中心", "/youcai/tools"],
    ["灵感广场", "/youcai/inspiration"],
    ["个人资产", "/youcai/assets"],
    ["影视工坊", "/youcai/tools/film-studio"],
  ];
  for (const [label, pathname] of targets) {
    const beforeMarker = await page.evaluate(() => window.__manjuAcceptance?.documentMarker);
    const beforeStarted = Date.now();
    const link = page.locator(`a[href="${pathname}"]`).filter({ visible: true }).first();
    if (await link.count() === 0) {
      roleResult.transitions.push({ label, pathname, available: false });
      continue;
    }
    await Promise.all([
      page.waitForURL((url) => url.pathname === pathname, { timeout: 30_000 }),
      link.click(),
    ]);
    await page.locator('[data-testid="manju-content"]').waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(350);
    const state = await page.evaluate((expectedMarker) => ({
      sameDocument: window.__manjuAcceptance?.documentMarker === expectedMarker,
      sidebarIdentityPreserved: document.querySelector('[data-testid="film-studio-sidebar"]')?.dataset.acceptanceIdentity === "persistent-manju-shell",
      sidebarCount: document.querySelectorAll('[data-testid="film-studio-sidebar"]').length,
      mainCount: document.querySelectorAll('[data-testid="manju-content"]').length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      fatalText: /Application error|Unhandled Runtime Error|This page could not be found/iu.test(document.body.innerText),
      performanceNavigationEntries: performance.getEntriesByType("navigation").length,
    }), beforeMarker);
    roleResult.transitions.push({ label, pathname, available: true, elapsedMs: Date.now() - beforeStarted, ...state });
    assert.equal(state.sameDocument, true, `${user.role}: ${pathname} caused a document reload`);
    assert.equal(state.sidebarIdentityPreserved, true, `${user.role}: ${pathname} remounted the persistent shell`);
    assert.equal(state.sidebarCount, 1, `${user.role}: ${pathname} duplicated the sidebar`);
    assert.equal(state.mainCount, 1, `${user.role}: ${pathname} duplicated main content`);
    assert.equal(state.horizontalOverflow, false, `${user.role}: ${pathname} horizontal overflow`);
    assert.equal(state.fatalText, false, `${user.role}: ${pathname} fatal page`);
    assert.equal(state.performanceNavigationEntries, 1, `${user.role}: ${pathname} added a document navigation`);
  }

  const historyResponse = await fetch(`${origin}/api/drama/projects`, { headers: { Authorization: `Bearer ${token}` } });
  const historyBody = await historyResponse.json().catch(() => ({}));
  roleResult.projectHistory = {
    status: historyResponse.status,
    code: typeof historyBody.code === "string" ? historyBody.code : undefined,
    count: Array.isArray(historyBody.projects) ? historyBody.projects.length : undefined,
  };
  if (user.role === "admin") assert.equal(historyResponse.status, 200, "admin project history must be readable");
  else assert.ok([200, 403].includes(historyResponse.status), "ordinary project history returned an unexpected status");

  await page.goto(`${origin}/admin?tab=manju-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(800);
  roleResult.adminBoundary = await page.evaluate(() => ({
    panelCount: document.querySelectorAll('[data-admin-panel="manju-workbench"]').length,
    managerCount: document.querySelectorAll('[data-admin-section="manju-showcase-catalog"]').length,
    configCount: document.querySelectorAll('[data-admin-section="manju-config-center"]').length,
    loginOrDeniedText: /请先登录|权限不足|无权|管理员/iu.test(document.body.innerText),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
  }));
  if (user.role === "admin") {
    assert.equal(roleResult.adminBoundary.panelCount, 1);
    assert.equal(roleResult.adminBoundary.managerCount, 1);
    assert.equal(roleResult.adminBoundary.configCount, 1);
  } else {
    assert.equal(roleResult.adminBoundary.managerCount, 0, "ordinary user rendered the Manju asset manager");
    assert.equal(roleResult.adminBoundary.configCount, 0, "ordinary user rendered the Manju config center");
  }
  await context.close();
  return roleResult;
}

let browser;
try {
  const usersResult = await db.from("users")
    .select("id,username,email,display_name,role,status,is_active")
    .in("role", ["admin", "student"])
    .eq("is_active", true)
    .limit(100);
  if (usersResult.error) throw usersResult.error;
  const admin = usersResult.data.find((item) => item.role === "admin" && (item.status === "active" || item.status === null));
  const ordinary = usersResult.data.find((item) => item.role === "student" && (item.status === "active" || item.status === null));
  assert.ok(admin, "ACTIVE_ADMIN_REQUIRED");
  assert.ok(ordinary, "ACTIVE_ORDINARY_USER_REQUIRED");
  browser = await chromium.launch({ headless: true });
  report.roles.push(await inspectRole(browser, admin));
  report.roles.push(await inspectRole(browser, ordinary));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error?.name || "Error", message: error?.message || "UNKNOWN" };
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
}
