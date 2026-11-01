import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installPaidAuthCookie, runtimeIdentity, safeHarnessEvidence } from "./verify-image-workbench-live-e2e.mjs";

// Focused desktop acceptance for the foundation flow. This is not the separate
// model-matrix/history suite. All browser mutations are blocked or simulated.
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(source-version|build-id|run-id)=(.+)$/u.exec(arg);
  assert.ok(match, "UI_ARGUMENT_INVALID");
  return [match[1], match[2]];
}));
assert.match(args["run-id"] || "", /^[A-Za-z0-9_-]{8,100}$/u);
assert.ok(args["source-version"] && args["build-id"], "UI_RUNTIME_PINS_REQUIRED");
const origin = "http://127.0.0.1:5000";
assert.equal(process.env.LOCAL_NAV_ORIGIN, origin);
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
assert.ok(token && identity.user?.id, "UI_CONTROLLED_IDENTITY_REQUIRED");
const pins = { origin, expectedSourceVersion: args["source-version"], expectedBuildId: args["build-id"] };
const directory = path.resolve(".codex-evidence/storyboard-foundation-20261020", args["run-id"]);
await fs.mkdir(directory, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), runtimeBefore: await runtimeIdentity(pins),
  acceptanceScope: "foundation-desktop-three-cards-and-neighbors",
  actorId: identity.user.id, pages: [], pageErrors: [], consoleErrors: [],
  httpFailures: [], blockedMutations: [], simulatedMutations: [],
  paidGenerationRequests: 0, forwardedBrowserMutations: 0,
};
const browser = await chromium.launch({
  headless: process.env.STORYBOARD_FLOW_VISIBLE !== "1",
  slowMo: process.env.STORYBOARD_FLOW_VISIBLE === "1" ? 500 : 0,
  executablePath: "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe",
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await installPaidAuthCookie(context, origin, token);
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.origin === origin && url.pathname === "/api/auth/me") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(identity) });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      const event = { method: request.method(), path: url.pathname };
      if (/\/(?:image|video)\/generate$/u.test(url.pathname)) report.paidGenerationRequests++;
      if (url.origin === origin && request.method() === "POST" && ["/api/announcements/events", "/api/product-usage/events"].includes(url.pathname)) {
        report.simulatedMutations.push(event);
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      }
      if (url.origin === origin && request.method() === "POST" && url.pathname === "/api/storyboard/projects") {
        const payload = request.postDataJSON();
        const doc = payload?.document;
        assert.ok(doc?.id && Array.isArray(doc.cards), "UI_READONLY_PROJECT_PAYLOAD_INVALID");
        report.simulatedMutations.push(event);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          project: { id: doc.id, title: doc.title, revision: Number(payload.expectedRevision || 0) + 1,
            createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString(),
            submittedAt: null, cardCount: doc.cards.length, cards: doc.cards.map(card => ({
              id: card.id, order: card.order, imageStatus: card.imageStatus, videoStatus: card.videoStatus,
              imageUrl: card.imageUrl || "", videoUrl: card.videoUrl || "", videoThumbnailUrl: "",
            })) },
        }) });
      }
      report.blockedMutations.push(event);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(String(error.message).slice(0, 600)));
  page.on("console", message => {
    if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) report.httpFailures.push({ path: url.pathname, status: response.status() });
  });
  page.on("dialog", dialog => dialog.dismiss());
  for (const width of [1440, 1880]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded" });
    await page.locator("article.sbw-shot-card").nth(2).waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await page.locator("article.sbw-shot-card").count(), 3, "UI_DEFAULT_THREE_CARDS_REQUIRED");
    assert.ok(await page.getByRole("button", { name: "角色参考", exact: true }).isVisible());
    const state = await page.evaluate(() => {
      const grid = document.querySelector(".sbw-shot-grid");
      const cards = [...document.querySelectorAll("article.sbw-shot-card")];
      return {
        route: location.pathname, width: innerWidth, clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        gridColumns: getComputedStyle(grid).gridTemplateColumns,
        cards: cards.map(card => {
          const rect = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          return { x: rect.x, y: rect.y, width: rect.width, background: style.backgroundColor,
            color: style.color, fontSize: style.fontSize, textareas: card.querySelectorAll("textarea").length };
        }),
      };
    });
    assert.ok(state.scrollWidth <= state.clientWidth + 1, "UI_HORIZONTAL_OVERFLOW");
    assert.ok(state.cards.every(card => card.width > 200 && card.textareas === 2), "UI_CARD_CONTENT_INVALID");
    assert.ok(state.cards.every(card => Math.abs(card.y - state.cards[0].y) < 2), "UI_DESKTOP_THREE_COLUMNS_REQUIRED");
    await page.screenshot({ path: path.join(directory, `storyboard-${width}.png`), fullPage: true });
    report.pages.push(state);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const route of ["/cover", "/video"]) {
    await page.goto(origin + route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const state = await page.evaluate(() => ({
      route: location.pathname, width: innerWidth, clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      mainTextLength: (document.querySelector("main") || document.body).innerText.trim().length,
    }));
    assert.equal(state.route, route);
    assert.ok(state.mainTextLength > 50, "UI_NEIGHBOR_EMPTY");
    assert.ok(state.scrollWidth <= state.clientWidth + 1, "UI_NEIGHBOR_OVERFLOW");
    await page.screenshot({ path: path.join(directory, route.slice(1) + ".png"), fullPage: true });
    report.pages.push(state);
  }
  assert.equal(report.paidGenerationRequests, 0);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.httpFailures, []);
  assert.deepEqual(report.blockedMutations, []);
  assert.deepEqual(report.consoleErrors, []);
  report.runtimeAfter = await runtimeIdentity(pins);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.message || error).slice(0, 500);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.pageErrorCount = report.pageErrors.length;
  report.consoleErrorCount = report.consoleErrors.length;
  const safeReport = safeHarnessEvidence(report);
  await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(safeReport, null, 2) + "\n", { flag: "wx" });
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, pages: report.pages.length, failure: safeReport.failure,
    paidGenerationRequests: report.paidGenerationRequests, report: path.join(directory, "report.json") }));
}
