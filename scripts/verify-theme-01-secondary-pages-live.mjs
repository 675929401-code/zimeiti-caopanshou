import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const outputDir = path.resolve(process.env.THEME_01_EVIDENCE_DIR || ".codex-evidence/theme-01-secondary-pages-R001135");
const user = {
  id: "theme-01-fixture-user",
  username: "theme_01_fixture",
  displayName: "黑曜霓彩验收",
  role: "admin",
  status: "active",
  is_active: true,
  credits: 0,
};
const permission = {
  permission: {
    userId: user.id,
    role: "admin",
    featureNavigationKeys: ["marketplace", "toolbox", "storyboard_workbench", "image_workbench", "create", "voice", "cover", "youcai", "commerce_agent"],
    agentNavigationKeys: ["商业IP定位", "task:影像编导", "task:文案创作", "task:获客转化", "自用"],
    revision: 1,
    checksum: "theme-01-fixture",
    integrityValid: true,
    authorityStatus: "admin",
  },
};
const routes = [
  { id: "announcements", path: "/announcements" },
  { id: "digital-human", path: "/digital-human", anonymous: true },
  { id: "extract", path: "/extract" },
  { id: "formatter", path: "/formatter" },
  { id: "media-history", path: "/media-history" },
  { id: "segmenter", path: "/segmenter" },
  { id: "tools", path: "/tools" },
  { id: "tools-utility", path: "/tools/utility" },
  { id: "cover", path: "/cover" },
  { id: "image-workbench", path: "/image-workbench" },
  { id: "video", path: "/video" },
  { id: "voice-studio-workspace", path: "/voice-studio/workspace" },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { schemaVersion: 1, origin, theme: "crystal-aurora", mode: "dark", routes: [], blockedWrites: [], pageErrors: [], consoleErrors: [] };

try {
  for (const routeInfo of routes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, authUser, routePath, anonymous }) => {
      if (anonymous) {
        localStorage.removeItem("auth_token");
        localStorage.removeItem("auth_user");
        localStorage.removeItem("entered_app");
        sessionStorage.removeItem("entered_app");
      } else {
        localStorage.setItem("auth_token", sessionToken);
        localStorage.setItem("auth_user", JSON.stringify(authUser));
        localStorage.setItem("entered_app", "1");
        sessionStorage.setItem("entered_app", "1");
      }
      localStorage.setItem("active_view", routePath === "/" ? "chat" : "marketplace");
      localStorage.setItem("user_theme_preference", "crystal-aurora");
      localStorage.setItem("user_theme_mode_preference", "dark");
      localStorage.setItem("platform_theme", "crystal-aurora");
      localStorage.setItem("platform_theme_mode", "dark");
    }, { sessionToken: "theme-01-fixture-token", authUser: user, routePath: routeInfo.path, anonymous: routeInfo.anonymous === true });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push({ route: routeInfo.id, message: error.message }));
    page.on("console", (message) => { if (message.type() === "error") report.consoleErrors.push({ route: routeInfo.id, message: message.text() }); });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin && /^https?:$/u.test(url.protocol)) return route.abort("blockedbyclient");
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (request.method() !== "GET") {
        if (url.pathname === "/api/product-usage/events" || url.pathname === "/api/client-error-report") {
          return route.fulfill({ status: 204, body: "" });
        }
        report.blockedWrites.push({ route: routeInfo.id, method: request.method(), pathname: url.pathname });
        return route.fulfill({ status: 204, body: "" });
      }
      const body = url.pathname === "/api/auth/me"
        ? { user: routeInfo.anonymous ? null : user }
        : url.pathname === "/api/member-permissions" ? permission
          : url.pathname === "/api/settings" || url.pathname === "/api/settings/appearance" ? { settings: { theme: "crystal-aurora", theme_mode: "dark" } }
                      : url.pathname === "/api/credits" ? { credits: 0, cash_balance: 0 }
                        : url.pathname === "/api/cash/balance" ? { balance: 0, cashBalance: 0 }
                          : url.pathname === "/api/video/models" ? { models: [] }
                            : url.pathname === "/api/digital-human/assets" ? { assets: [] }
                                : url.pathname === "/api/video/history" ? { tasks: [], nextOffset: null }
                                  : url.pathname === "/api/digital-human/long-history" ? { tasks: [], nextOffset: null }
              : url.pathname === "/api/bots" ? { agents: [], navigationKeys: permission.permission.agentNavigationKeys }
                : url.pathname === "/api/categories" ? { categories: [] }
                  : url.pathname === "/api/nav-items" ? { items: [] }
                    : url.pathname === "/api/chat-models" ? { models: [] }
                      : url.pathname === "/api/notifications" ? { notifications: [] }
                        : url.pathname === "/api/announcements" ? { announcements: [] }
                          : url.pathname === "/api/version" ? { buildId: "theme-01-fixture", sourceVersion: "theme-01-fixture" }
                            : {};
      return route.fulfill({ status: routeInfo.anonymous && url.pathname === "/api/auth/me" ? 401 : 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    const response = await page.goto(`${origin}${routeInfo.path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assert.equal(response?.status(), 200, `${routeInfo.id} HTTP status`);
    await page.waitForTimeout(900);
    const view = await page.evaluate(() => {
      const root = document.documentElement;
      const header = document.querySelector(".sub-page-header");
      const surface = document.querySelector(".secondary-workbench:not(.sbw-root), [data-page=tools], .help-page, .media-history-page, main.page:has(> .sub-page-header), [data-chat-surface=unified-glass]");
      const style = surface ? getComputedStyle(surface) : null;
      const headerStyle = header ? getComputedStyle(header) : null;
      return {
        theme: root.getAttribute("data-theme"),
        mode: root.getAttribute("data-mode"),
        headerCount: document.querySelectorAll(".sub-page-header").length,
        chatSurfaceCount: document.querySelectorAll("[data-chat-surface=unified-glass]").length,
        bodyTextLength: document.body.innerText.length,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
        surfaceBackground: style?.backgroundImage || style?.backgroundColor || "",
        surfaceBorder: style?.borderTopColor || "",
        headerBackground: headerStyle?.backgroundImage || headerStyle?.backgroundColor || "",
        headerBorder: headerStyle?.borderBottomColor || "",
      };
    });
    assert.equal(view.theme, "crystal-aurora", `${routeInfo.id} theme selection`);
    assert.equal(view.mode, "dark", `${routeInfo.id} theme mode`);
    assert.equal(view.overflowX, false, `${routeInfo.id} horizontal overflow`);
    assert.ok(view.bodyTextLength > 20, `${routeInfo.id} rendered too little content`);
    assert.equal(view.chatSurfaceCount, 0, `${routeInfo.id} unexpectedly rendered the chat-only surface`);
    await page.screenshot({ path: path.join(outputDir, `${routeInfo.id}-1440x900.png`), fullPage: false });
    report.routes.push({ ...routeInfo, http: response?.status() || null, view, screenshot: path.join(outputDir, `${routeInfo.id}-1440x900.png`) });
    await context.close();
  }
} finally {
  await browser.close();
}

assert.equal(report.blockedWrites.length, 0, `THEME_01_BLOCKED_WRITES:${JSON.stringify(report.blockedWrites)}`);
assert.equal(report.pageErrors.length, 0, `THEME_01_PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
assert.equal(report.consoleErrors.length, 0, `THEME_01_CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
await writeFile(path.join(outputDir, "report.json"), JSON.stringify({ passed: true, ...report }, null, 2), "utf8");
console.log(JSON.stringify({ passed: true, routes: report.routes.length, outputDir, blockedWrites: 0 }, null, 2));
