import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const expectedUsername = String(process.env.READONLY_UI_EXPECTED_USERNAME || "").trim();
const outputDir = path.resolve(".codex-artifacts", "20260826-app-route-shell-scroll");

async function closeWithTimeout(closeable: { close(): Promise<void> }, label: string, timeoutMs = 3_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    closeable.close().catch((error: unknown) => {
      console.error(`[app-route-shell-scroll] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[app-route-shell-scroll] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

const desktopRoutes = [
  "/youcai/skills",
  "/youcai/assets",
  "/youcai/tools",
  "/youcai/inspiration",
  "/youcai/articles",
  "/youcai/recharge",
  "/youcai/referral",
  "/youcai/youcai-tv",
] as const;

const finiteContentRoutes = new Set(["/youcai/skills", "/youcai/articles"]);

interface ScrollResult {
  route: string;
  viewport: string;
  status: number;
  clientHeight: number;
  scrollHeight: number;
  scrollable: boolean;
  wheelMoved: boolean;
  reachedBottom: boolean;
  windowScrollY: number;
}

function captureRuntimeErrors(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
}

async function verifyRouteScroll(page: Page, route: string, viewport: string, waitForAnnouncement = false): Promise<ScrollResult> {
  const response = await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, `${route} 没有返回 HTTP 200`);
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname, route, `${route} 被登录守卫或旧路由重定向，不能据此验收滚动`);
  const announcementClose = page.locator('[role="dialog"] button[aria-label*="关闭"], [role="dialog"] button[title*="关闭"]').first();
  const announcementVisible = waitForAnnouncement
    ? await announcementClose.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false)
    : await announcementClose.isVisible().catch(() => false);
  if (announcementVisible) {
    await announcementClose.click();
    await announcementClose.waitFor({ state: "hidden", timeout: 10_000 });
  }
  const main = page.locator('main[data-testid="manju-content"]').first();
  await main.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(350);

  const before = await main.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    overflowY: getComputedStyle(element).overflowY,
  }));
  assert.match(before.overflowY, /auto|scroll/u, `${route} 的主内容区没有建立纵向滚动容器`);

  const scrollable = before.scrollHeight > before.clientHeight + 2;
  let wheelMoved = false;
  let reachedBottom = !scrollable;

  if (scrollable) {
    const mainBox = await main.boundingBox();
    assert.ok(mainBox, `${route} 的主内容区没有可交互边界`);
    await main.hover({
      position: {
        x: Math.max(1, Math.floor(mainBox.width / 2)),
        y: Math.max(1, Math.floor(mainBox.height / 2)),
      },
    });
    await page.mouse.wheel(0, Math.max(720, Math.floor(before.clientHeight * 0.8)));
    await page.waitForTimeout(220);
    const afterWheel = await main.evaluate((element) => element.scrollTop);
    wheelMoved = afterWheel > before.scrollTop;
    assert.equal(wheelMoved, true, `${route} 的鼠标滚轮没有推动主内容区`);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await main.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(120);
    }
    reachedBottom = await main.evaluate((element) => (
      element.scrollTop + element.clientHeight >= element.scrollHeight - 2
    ));
    if (finiteContentRoutes.has(route)) {
      assert.equal(reachedBottom, true, `${route} 无法滚动到底部`);
    }
  }

  const windowScrollY = await page.evaluate(() => window.scrollY);
  assert.equal(windowScrollY, 0, `${route} 不应让固定侧栏所在的窗口整体滚动`);

  return {
    route,
    viewport,
    status: response?.status() ?? 0,
    clientHeight: before.clientHeight,
    scrollHeight: before.scrollHeight,
    scrollable,
    wheelMoved,
    reachedBottom,
    windowScrollY,
  };
}

async function main() {
  assert.ok(adminToken && expectedUsername, "请通过 with-local-admin-session.mjs 运行只读验收");
  const identityResponse = await fetch(`${origin}/api/auth/me`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const identityPayload = await identityResponse.json() as { user?: { username?: string; role?: string } };
  assert.ok(identityResponse.ok && identityPayload.user?.username === expectedUsername && identityPayload.user.role === "admin", "本地管理员身份不匹配");

  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const errors: string[] = [];
  const results: ScrollResult[] = [];
  const blockedRequests: Array<{ viewport: string; method: string; path: string }> = [];

  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      const viewportLabel = `${viewport.width}x${viewport.height}`;
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: "block" });
      await context.addInitScript(({ token, user }) => {
        localStorage.setItem("auth_token", token);
        localStorage.setItem("auth_user", JSON.stringify(user));
      }, { token: adminToken, user: identityPayload.user });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const diagnosticReadPost = request.method() === "POST" && url.origin === origin && url.pathname === "/__nextjs_original-stack-frames";
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !diagnosticReadPost) {
          blockedRequests.push({ viewport: viewportLabel, method: request.method(), path: url.origin === origin ? url.pathname : "external-resource" });
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      captureRuntimeErrors(page, errors);
      for (const [routeIndex, route] of desktopRoutes.entries()) {
        results.push(await verifyRouteScroll(page, route, viewportLabel, routeIndex === 0));
        if (route === "/youcai/skills") {
          await page.screenshot({ path: path.join(outputDir, `desktop-skills-bottom-${viewportLabel}.png`), fullPage: false });
        }
      }
      await closeWithTimeout(context, `${viewportLabel} context.close`);
    }

    const actionableErrors = errors.filter((message) => (
      !/favicon|ResizeObserver loop|console:Failed to load resource|ERR_BLOCKED_BY_CLIENT/u.test(message)
    ));
    assert.deepEqual(actionableErrors, [], `浏览器出现错误：\n${actionableErrors.join("\n")}`);

    const report = {
      ok: true,
      paidGenerationTriggered: false,
      routesChecked: results.length,
      scrollableRoutes: results.filter((result) => result.scrollable).length,
      results,
      screenshots: fs.readdirSync(outputDir)
        .filter((name) => /^desktop-skills-bottom-(?:1440x900|1920x1080)\.png$/u.test(name))
        .sort(),
      runtimeErrors: actionableErrors,
      blockedRequests,
      authenticatedUserMatched: true,
    };
    fs.writeFileSync(path.join(outputDir, "scroll-report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await closeWithTimeout(browser, "browser.close");
  }
}

void main().then(
  () => process.exit(Number(process.exitCode || 0)),
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  },
);
