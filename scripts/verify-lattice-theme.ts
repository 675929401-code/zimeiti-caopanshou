import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.THEME_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDir = path.resolve(".codex-screenshots/lattice-fullsite-20260815");

const routes = [
  { name: "home", url: "/", probe: ".marketplace-shell" },
  { name: "tools-format", url: "/tools?tab=format", probe: '[data-page="tools"]' },
  { name: "video", url: "/video", probe: ".voice-studio-root" },
  { name: "help", url: "/help", probe: ".help-page" },
  { name: "free-canvas", url: "/free-canvas", probe: "body" },
  { name: "storyboard", url: "/storyboard-workbench", probe: ".sbw-root" },
] as const;

async function main() {
  const injectedIdentity = process.env.LOCAL_NAV_READONLY_IDENTITY
    ? JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY) as { user?: Record<string, unknown> }
    : null;
  const injectedToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  let session: {
    token?: string;
    user?: Record<string, unknown>;
    error?: string;
  } = {
    token: injectedToken,
    user: injectedIdentity?.user,
  };

  if (!session.token) {
    const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
    });
    session = (await sessionResponse.json()) as typeof session;
    assert.ok(
      sessionResponse.ok && session.token,
      session.error || "本地测试会话不可用；请通过 with-local-admin-session.mjs 启动验收",
    );
  }

  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results: Array<Record<string, unknown>> = [];

  try {
    // The current product contract is desktop-only. Keep this legacy visual
    // replay on the supported 1440px acceptance width so a mobile fixture
    // cannot reintroduce an out-of-scope gate.
    for (const viewport of [
      { label: "desktop", width: 1440, height: 900 },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      await context.addInitScript(({ token, user }) => {
        localStorage.setItem("auth_token", token);
        localStorage.setItem("auth_user", JSON.stringify(user));
        localStorage.setItem("user_theme_preference", "lattice");
        localStorage.setItem("app_theme", "lattice");
        sessionStorage.setItem("entered_app", "1");
      }, { token: session.token, user: session.user });

      for (const route of routes) {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${baseUrl}${route.url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.evaluate(() => {
          document.documentElement.setAttribute("data-theme", "lattice");
          document.documentElement.setAttribute("data-mode", "dark");
        });
        await page.waitForTimeout(1_500);

        if (route.url === "/") {
          await page.waitForSelector(".marketplace-shell", { timeout: 30_000 });
        }

        const metrics = await page.evaluate((probe) => {
          const target = document.querySelector(probe) || document.body;
          const bodyStyle = getComputedStyle(document.body);
          const targetStyle = getComputedStyle(target);
          const marketplace = document.querySelector(".marketplace-shell");
          const marketplaceStyle = marketplace ? getComputedStyle(marketplace) : null;
          return {
            finalUrl: location.pathname + location.search,
            theme: document.documentElement.getAttribute("data-theme"),
            bodyBackgroundImage: bodyStyle.backgroundImage,
            targetBackgroundColor: targetStyle.backgroundColor,
            targetBackgroundImage: targetStyle.backgroundImage,
            marketplaceBackgroundImage: marketplaceStyle?.backgroundImage || null,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          };
        }, route.probe);

        const screenshot = path.join(outputDir, `${route.name}-${viewport.label}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        results.push({
          route: route.url,
          viewport,
          screenshot,
          pageErrors,
          ...metrics,
        });
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const homeDesktop = results.find((item) => item.route === "/" && (item.viewport as { label: string }).label === "desktop");
  assert.equal(homeDesktop?.theme, "lattice", "应用广场未启用 lattice 主题");
  assert.ok(homeDesktop?.marketplaceBackgroundImage && homeDesktop.marketplaceBackgroundImage !== "none", "应用广场格子背景缺失");
  assert.ok(results.every((item) => item.scrollWidth === item.clientWidth), "存在横向溢出");

  await writeFile(path.join(outputDir, "metrics.json"), JSON.stringify(results, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, outputDir, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
