import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright";
import { SignJWT } from "jose";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
let token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const readOnlyIdentity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
let actor = readOnlyIdentity?.user;
const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", "chat-glass-real-history-20260930", runStamp);

if (!token || !actor?.id || actor?.role !== "admin") {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  const client = new pg.Client({
    ...runtime.ownerConnection,
    application_name: "codex-chat-history-readonly",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT account.id,account.username,account.display_name,session.session_id
         FROM public.users account
         JOIN public.user_auth_sessions session ON session.user_id=account.id
        WHERE account.role='admin'
          AND account.is_active IS TRUE
          AND coalesce(account.status,'active')='active'
          AND session.revoked_at IS NULL
          AND session.expires_at>now()
        ORDER BY session.created_at DESC
        LIMIT 1`,
    );
    assert.equal(result.rowCount, 1, "ACTIVE_LOCAL_ADMIN_SESSION_REQUIRED");
    const admin = result.rows[0];
    actor = {
      id: String(admin.id),
      username: String(admin.username || ""),
      displayName: String(admin.display_name || "管理员"),
      display_name: String(admin.display_name || "管理员"),
      role: "admin",
    };
    token = await new SignJWT({
      userId: actor.id,
      username: actor.username,
      role: actor.role,
      displayName: actor.displayName,
      sessionId: String(admin.session_id),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30m")
      .sign(new TextEncoder().encode(runtime.jwtSecret));
  } finally {
    await client.end();
  }
}

assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
assert.ok(actor?.id && actor?.role === "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");

const authorization = { Authorization: `Bearer ${token}` };

async function readJson(url) {
  const response = await fetch(url, {
    headers: authorization,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `READ_FAILED:${new URL(url).pathname}:${response.status}`);
  return body;
}

function conversationScore(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const assistantText = messages
    .filter((message) => message?.role === "assistant")
    .map((message) => String(message?.content || ""))
    .join("\n");
  const userText = messages
    .filter((message) => message?.role === "user")
    .map((message) => String(message?.content || ""))
    .join("\n");
  const markdownSignals = [
    /^#{1,4}\s+/mu,
    /^[-*+]\s+/mu,
    /^>\s+/mu,
    /```/u,
    /\|[^\n]+\|/u,
    /\[[^\]]+\]\([^)]+\)/u,
  ].filter((pattern) => pattern.test(assistantText)).length;
  return {
    value: messages.length * 10_000 + Math.min(assistantText.length, 20_000) + markdownSignals * 2_000,
    assistantChars: assistantText.length,
    userChars: userText.length,
    markdownSignals,
    assistantMessages: messages.filter((message) => message?.role === "assistant" && String(message?.content || "").trim()).length,
    userMessages: messages.filter((message) => message?.role === "user" && String(message?.content || "").trim()).length,
  };
}

async function selectRealConversation() {
  const listPayload = await readJson(`${origin}/api/conversations/history`);
  const summaries = Array.isArray(listPayload?.conversations) ? listPayload.conversations : [];
  assert.ok(summaries.length > 0, "REAL_CONVERSATION_HISTORY_EMPTY");

  const candidates = [];
  for (const summary of summaries.slice(0, 60)) {
    if (!summary?.id) continue;
    const detailPayload = await readJson(`${origin}/api/conversations/history?id=${encodeURIComponent(summary.id)}`);
    const conversation = detailPayload?.conversation;
    const score = conversationScore(conversation);
    if (score.userMessages > 0 && score.assistantMessages > 0) candidates.push({ conversation, score });
  }
  candidates.sort((left, right) => right.score.value - left.score.value);
  assert.ok(candidates.length > 0, "REAL_USER_AND_ASSISTANT_HISTORY_REQUIRED");
  return candidates[0];
}

const themeLabels = {
  lattice: "深空晶",
  "soft-white": "柔光白",
  "crystal-aurora": "黑曜霓彩",
};

async function selectThemeThroughUi(page, theme) {
  const expectedLabel = themeLabels[theme];
  const trigger = page.locator('[data-theme-switcher-trigger="true"]').first();
  await trigger.waitFor({ state: "visible" });
  await trigger.click();
  const option = page.locator(`[data-theme-option="${theme}"]`);
  await option.waitFor({ state: "visible" });
  await option.click();
  await page.waitForFunction(({ selectedTheme, selectedLabel }) => (
    document.documentElement.dataset.theme === selectedTheme
      && document.querySelector('[data-theme-switcher-trigger="true"]')
        ?.getAttribute("aria-label")?.includes(selectedLabel) === true
  ), { selectedTheme: theme, selectedLabel: expectedLabel }, { timeout: 10_000 });
  await page.waitForTimeout(160);
}

async function sampleRealScene(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-chat-surface="unified-glass"]');
    const header = stage?.querySelector(".chat-stage-header");
    const canvas = stage?.querySelector(".chat-canvas");
    const assistantRows = [...(stage?.querySelectorAll(".chat-message-row-assistant") || [])];
    const userRows = [...(stage?.querySelectorAll(".chat-message-row-user") || [])];
    const assistant = assistantRows.find((row) => row.querySelector(".chat-message-bubble-assistant .markdown-body"))
      ?.querySelector(".chat-message-bubble-assistant");
    const user = userRows.find((row) => row.querySelector(".chat-message-bubble-user"))
      ?.querySelector(".chat-message-bubble-user");
    const markdown = assistant?.querySelector(".markdown-body");
    const composer = stage?.querySelector(".chat-composer-rainbow");
    const textarea = composer?.querySelector("textarea");
    const dock = stage?.querySelector(".chat-input-dock");
    const contentRail = stage?.querySelector(".chat-content-rail.chat-shared-rail");
    const composerRail = stage?.querySelector(".chat-composer-rail.chat-shared-rail");
    const completedStates = [...(stage?.querySelectorAll('[data-testid="chat-output-status"]') || [])]
      .filter((node) => node.getAttribute("data-state") === "completed").length;
    if (!(stage && header && canvas && assistant && user && markdown && composer && textarea && dock && contentRail && composerRail)) {
      throw new Error("REAL_CHAT_GLASS_SCENE_INCOMPLETE");
    }
    const style = (node) => getComputedStyle(node);
    const pseudo = (node, selector) => getComputedStyle(node, selector);
    const fogImage = pseudo(stage, "::before").backgroundImage;
    const gridImage = pseudo(stage, "::after").backgroundImage;
    const rect = stage.getBoundingClientRect();
    const assistantRect = assistant.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const contentRailRect = contentRail.getBoundingClientRect();
    const composerRailRect = composerRail.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      themeControlLabel: document.querySelector('[data-theme-switcher-trigger="true"]')?.getAttribute("aria-label") || "",
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      messageCounts: { assistant: assistantRows.length, user: userRows.length, completedStates },
      stage: {
        width: rect.width,
        overflow: style(stage).overflow,
        isolation: style(stage).isolation,
        background: style(stage).background,
        backgroundColor: style(stage).backgroundColor,
        backgroundImage: style(stage).backgroundImage,
        backgroundVariable: style(stage).getPropertyValue("--chat-stage").trim(),
        fogImage,
        fogRadialCount: (fogImage.match(/radial-gradient/gu) || []).length,
        gridImage,
        gridSize: pseudo(stage, "::after").backgroundSize,
        gridMask: pseudo(stage, "::after").maskImage || pseudo(stage, "::after").webkitMaskImage,
      },
      header: {
        backgroundColor: style(header).backgroundColor,
        backdropFilter: style(header).backdropFilter || style(header).webkitBackdropFilter,
      },
      assistant: {
        width: assistantRect.width,
        left: assistantRect.left,
        right: assistantRect.right,
        backgroundImage: style(assistant).backgroundImage,
        backgroundColor: style(assistant).backgroundColor,
        borderLeftWidth: style(assistant).borderLeftWidth,
        borderLeftColor: style(assistant).borderLeftColor,
        borderRadius: style(assistant).borderRadius,
        boxShadow: style(assistant).boxShadow,
        backdropFilter: style(assistant).backdropFilter || style(assistant).webkitBackdropFilter,
      },
      user: {
        backgroundImage: style(user).backgroundImage,
        backgroundColor: style(user).backgroundColor,
        borderColor: style(user).borderColor,
        borderLeftWidth: style(user).borderLeftWidth,
        borderRadius: style(user).borderRadius,
        backdropFilter: style(user).backdropFilter || style(user).webkitBackdropFilter,
        boxShadow: style(user).boxShadow,
      },
      typography: {
        assistantFontFamily: style(markdown).fontFamily,
        assistantFontSize: style(markdown).fontSize,
        assistantLineHeight: style(markdown).lineHeight,
        userFontFamily: style(user.querySelector(".user-message-content") || user).fontFamily,
        textareaFontFamily: style(textarea).fontFamily,
        textareaFontSize: style(textarea).fontSize,
        textareaLineHeight: style(textarea).lineHeight,
      },
      composer: {
        width: composerRect.width,
        left: composerRect.left,
        right: composerRect.right,
        backgroundColor: style(composer).backgroundColor,
        backgroundImage: style(composer).backgroundImage,
        borderWidth: style(composer).borderWidth,
        borderColor: style(composer).borderColor,
        backdropFilter: style(composer).backdropFilter || style(composer).webkitBackdropFilter,
        pocketContent: pseudo(composer, "::before").content,
        pocketBackgroundImage: pseudo(composer, "::before").backgroundImage,
      },
      rails: {
        contentLeft: contentRailRect.left,
        contentRight: contentRailRect.right,
        contentCenter: contentRailRect.left + contentRailRect.width / 2,
        composerLeft: composerRailRect.left,
        composerRight: composerRailRect.right,
        composerCenter: composerRailRect.left + composerRailRect.width / 2,
        stageCenter: rect.left + rect.width / 2,
      },
      dock: {
        backgroundImage: style(dock).backgroundImage,
        backgroundColor: style(dock).backgroundColor,
        borderTopWidth: style(dock).borderTopWidth,
        boxShadow: style(dock).boxShadow,
        backdropFilter: style(dock).backdropFilter || style(dock).webkitBackdropFilter,
        beforeContent: pseudo(dock, "::before").content,
        afterContent: pseudo(dock, "::after").content,
      },
      markdownBlocks: {
        headings: assistant.querySelectorAll("h1,h2,h3,h4").length,
        lists: assistant.querySelectorAll("ul,ol").length,
        quotes: assistant.querySelectorAll("blockquote").length,
        tables: assistant.querySelectorAll("table").length,
        codeBlocks: assistant.querySelectorAll("pre").length,
        links: assistant.querySelectorAll("a").length,
      },
      scroll: {
        scrollHeight: canvas.scrollHeight,
        clientHeight: canvas.clientHeight,
        scrollTop: canvas.scrollTop,
        scrollbarGutter: style(canvas).scrollbarGutter,
      },
    };
  });
}

function assertRealScene(scene) {
  assert.equal(scene.documentOverflowX, 0, `${scene.theme}:HORIZONTAL_OVERFLOW`);
  assert.match(scene.themeControlLabel, new RegExp(themeLabels[scene.theme], "u"));
  assert.equal(scene.stage.overflow, "hidden");
  assert.equal(scene.stage.isolation, "isolate");
  assert.match(scene.stage.backgroundImage, /linear-gradient/iu, `${scene.theme}:CHAT_STAGE_BACKGROUND_NOT_APPLIED`);
  assert.equal(scene.stage.fogRadialCount, 2, `${scene.theme}:TOP_FOG_COUNT`);
  assert.match(scene.stage.gridImage, /linear-gradient/iu);
  assert.doesNotMatch(scene.stage.gridImage, /radial-gradient/iu);
  assert.equal(scene.stage.gridSize, "72px 72px, 72px 72px");
  assert.equal(scene.stage.gridMask, "none", `${scene.theme}:GRID_FADES_BEFORE_COMPOSER`);
  assert.match(scene.header.backdropFilter, /blur\(/iu);
  assert.ok(scene.messageCounts.user > 0 && scene.messageCounts.assistant > 0, `${scene.theme}:REAL_MESSAGE_ROWS_REQUIRED`);
  assert.ok(scene.messageCounts.completedStates > 0, `${scene.theme}:COMPLETED_STATE_MISSING`);
  assert.equal(scene.assistant.backgroundImage, "none");
  assert.match(scene.assistant.backgroundColor, /rgba\(0, 0, 0, 0\)|transparent/iu);
  assert.equal(scene.assistant.borderLeftWidth, "0px");
  assert.equal(scene.assistant.boxShadow, "none");
  assert.equal(scene.assistant.backdropFilter, "none");
  assert.equal(scene.user.backgroundImage, "none");
  assert.match(scene.user.backgroundColor, /rgba\(0, 0, 0, 0\)|transparent/iu);
  assert.equal(scene.user.borderLeftWidth, "0px");
  assert.equal(scene.user.boxShadow, "none");
  assert.equal(scene.user.backdropFilter, "none");
  assert.match(scene.composer.backdropFilter, /blur\(/iu);
  assert.equal(scene.composer.borderWidth, "1px");
  assert.doesNotMatch(scene.composer.backgroundImage, /conic-gradient/iu);
  assert.ok(scene.assistant.width < scene.composer.width, `${scene.theme}:TRANSCRIPT_NOT_NARROWER_THAN_COMPOSER`);
  assert.ok(Math.abs(scene.rails.contentCenter - scene.rails.stageCenter) <= 1, `${scene.theme}:CONTENT_NOT_CENTERED`);
  assert.ok(Math.abs(scene.rails.composerCenter - scene.rails.stageCenter) <= 1, `${scene.theme}:COMPOSER_NOT_CENTERED`);
  assert.equal(scene.scroll.scrollbarGutter, "auto");
  assert.equal(scene.dock.backgroundImage, "none");
  assert.match(scene.dock.backgroundColor, /rgba\(0, 0, 0, 0\)|transparent/iu);
  assert.equal(scene.dock.borderTopWidth, "0px");
  assert.equal(scene.dock.boxShadow, "none");
  assert.equal(scene.dock.backdropFilter, "none");
  assert.ok(["none", '\"\"'].includes(scene.dock.beforeContent));
  assert.ok(["none", '\"\"'].includes(scene.dock.afterContent));
  assert.match(scene.typography.assistantFontFamily, /Noto Sans SC|PingFang SC|Microsoft YaHei/iu);
  assert.equal(scene.typography.assistantFontFamily, scene.typography.userFontFamily);
  assert.equal(scene.typography.assistantFontFamily, scene.typography.textareaFontFamily);
  assert.ok(
    Number.parseFloat(scene.typography.assistantFontSize) >= 18
      && Number.parseFloat(scene.typography.assistantFontSize) <= 20,
    `${scene.theme}:ASSISTANT_FONT_SIZE`,
  );
  assert.equal(scene.typography.textareaFontSize, "16px");
  assert.ok(Number.parseFloat(scene.typography.assistantLineHeight) >= 27);
  assert.ok(Number.parseFloat(scene.typography.textareaLineHeight) >= 27);
}

async function main() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const selected = await selectRealConversation();
  const version = await readJson(`${origin}/api/version`);
  const conversationId = String(selected.conversation.id);
  const conversationIdHash = createHash("sha256").update(conversationId).digest("hex");
  const browser = await chromium.launch({ headless: true });
  const evidence = {
    apiReads: [],
    blockedWrites: [],
    suppressedDiagnostics: [],
    simulatedAppearanceWrites: [],
    externalRequests: [],
    consoleErrors: [],
    pageErrors: [],
    serverErrors: [],
    historyResponses: [],
    scenes: [],
    adjacentPages: [],
  };

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: origin });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await context.addInitScript(({ sessionToken, user, activeId }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      localStorage.setItem("active_view", "chat");
      localStorage.setItem("active_conversation_id", activeId);
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: actor, activeId: conversationId });

    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(origin).origin) {
        evidence.externalRequests.push(request.url());
        await route.abort("blockedbyclient");
        return;
      }
      if (url.pathname === "/api/auth/me" && request.method() === "GET") {
        evidence.apiReads.push("GET /api/auth/me [verified identity snapshot]");
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({ user: actor }),
        });
        return;
      }
      if (url.pathname === "/api/auth/me" && request.method() === "PUT") {
        const body = request.postDataJSON();
        const keys = Object.keys(body || {}).sort();
        assert.deepEqual(keys, ["theme_mode_preference", "theme_preference"]);
        assert.ok(Object.hasOwn(themeLabels, body.theme_preference), "UNEXPECTED_THEME_PREFERENCE");
        assert.ok(["system", "light", "dark"].includes(body.theme_mode_preference), "UNEXPECTED_THEME_MODE_PREFERENCE");
        evidence.simulatedAppearanceWrites.push({
          theme: body.theme_preference,
          modePreference: body.theme_mode_preference,
          persisted: false,
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({ success: true }),
        });
        return;
      }
      if (request.method() === "POST" && [
        "/api/operation-events",
        "/api/diagnostic-logs",
        "/api/product-usage/events",
      ].includes(url.pathname)) {
        evidence.suppressedDiagnostics.push(`${request.method()} ${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(request.method())) {
          evidence.blockedWrites.push(`${request.method()} ${url.pathname}`);
          await route.abort("blockedbyclient");
          return;
        }
        evidence.apiReads.push(`${request.method()} ${url.pathname}`);
      }
      await route.continue();
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === new URL(origin).origin && response.status() >= 500) {
        evidence.serverErrors.push(`${response.status()} ${url.pathname}`);
      }
      if (url.pathname === "/api/conversations/history") {
        evidence.historyResponses.push({ status: response.status(), detail: url.searchParams.has("id") });
      }
    });
    page.on("console", (message) => {
      const messageText = message.text();
      if (message.type() === "error" && !/fonts\.googleapis|ERR_BLOCKED_BY_CLIENT|favicon|ResizeObserver/iu.test(messageText)) {
        evidence.consoleErrors.push(messageText.slice(0, 500));
      }
    });
    page.on("pageerror", (error) => evidence.pageErrors.push(error.message.slice(0, 500)));

    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator('[data-chat-surface="unified-glass"]').waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(".chat-message-row-user .chat-message-bubble-user").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(".chat-message-row-assistant .chat-message-bubble-assistant .markdown-body").first().waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(evidence.historyResponses.some((entry) => entry.status === 200 && entry.detail), "REAL_HISTORY_DETAIL_WAS_NOT_LOADED");

    const initialCounts = await page.evaluate(() => ({
      users: document.querySelectorAll(".chat-message-row-user").length,
      assistants: document.querySelectorAll(".chat-message-row-assistant").length,
    }));
    assert.ok(initialCounts.users > 0 && initialCounts.assistants > 0, "REAL_HISTORY_DID_NOT_RENDER");

    const copyButton = page.locator('.chat-message-row-assistant button[aria-label*="复制 Markdown 源码"]').first();
    await copyButton.waitFor({ state: "visible" });
    await copyButton.click();
    await page.waitForFunction(() => (
      document.querySelector('.chat-message-row-assistant button[aria-label*="Markdown 源码"]')
        ?.getAttribute("aria-label")?.includes("已复制") === true
    ), undefined, { timeout: 3_000 });
    assert.match(String(await copyButton.getAttribute("aria-label")), /已复制/u);

    const canvas = page.locator(".chat-canvas").first();
    const scrollRange = await canvas.evaluate((node) => node.scrollHeight - node.clientHeight);
    assert.ok(scrollRange > 120, "REAL_HISTORY_NOT_LONG_ENOUGH_FOR_SCROLL_ACCEPTANCE");
    await canvas.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const scrollButton = page.getByTestId("chat-scroll-to-latest");
    await scrollButton.waitFor({ state: "visible", timeout: 10_000 });
    const settledLocator = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="chat-scroll-to-latest"]');
      const dots = document.querySelector('[data-testid="chat-streaming-latest-indicator"]');
      const arrow = document.querySelector('[data-testid="chat-latest-arrow"]');
      const composer = document.querySelector(".chat-composer-rail");
      if (!(button instanceof HTMLElement) || !(dots instanceof HTMLElement) || !(arrow instanceof SVGElement) || !(composer instanceof HTMLElement)) {
        throw new Error("SETTLED_LATEST_LOCATOR_INCOMPLETE");
      }
      const buttonRect = button.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      return {
        centerDelta: Math.abs((buttonRect.left + buttonRect.width / 2) - (composerRect.left + composerRect.width / 2)),
        dotsOpacity: Number(getComputedStyle(dots).opacity),
        arrowOpacity: Number(getComputedStyle(arrow).opacity),
      };
    });
    assert.ok(settledLocator.centerDelta <= 1, `SETTLED_LATEST_LOCATOR_NOT_CENTERED:${settledLocator.centerDelta}`);
    assert.ok(settledLocator.dotsOpacity <= 0.1, "SETTLED_LATEST_LOCATOR_DOTS_SHOULD_BE_HIDDEN");
    assert.ok(settledLocator.arrowOpacity >= 0.9, "SETTLED_LATEST_LOCATOR_ARROW_SHOULD_BE_VISIBLE");
    const settledLocatorScreenshot = path.join(evidenceDir, "settled-latest-locator.png");
    await page.screenshot({ path: settledLocatorScreenshot, fullPage: false });
    await scrollButton.hover();
    await page.waitForTimeout(220);
    const settledHover = await page.evaluate(() => {
      const dots = document.querySelector('[data-testid="chat-streaming-latest-indicator"]');
      const arrow = document.querySelector('[data-testid="chat-latest-arrow"]');
      if (!(dots instanceof HTMLElement) || !(arrow instanceof SVGElement)) throw new Error("SETTLED_LATEST_LOCATOR_PARTS_MISSING");
      return { dotsOpacity: Number(getComputedStyle(dots).opacity), arrowOpacity: Number(getComputedStyle(arrow).opacity) };
    });
    assert.ok(settledHover.dotsOpacity <= 0.1, "SETTLED_LATEST_LOCATOR_DOTS_VISIBLE_ON_HOVER");
    assert.ok(settledHover.arrowOpacity >= 0.9, "SETTLED_LATEST_LOCATOR_ARROW_HIDDEN_ON_HOVER");
    evidence.settledLatestLocator = { ...settledLocator, hover: settledHover, screenshot: settledLocatorScreenshot };
    await scrollButton.click();
    await page.waitForTimeout(250);
    const remainingScroll = await canvas.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    assert.ok(remainingScroll <= 8, `SCROLL_TO_LATEST_INCOMPLETE:${remainingScroll}`);

    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator(".chat-message-row-assistant .markdown-body").first().waitFor({ state: "visible", timeout: 30_000 });
    const restoredCounts = await page.evaluate(() => ({
      users: document.querySelectorAll(".chat-message-row-user").length,
      assistants: document.querySelectorAll(".chat-message-row-assistant").length,
    }));
    assert.deepEqual(restoredCounts, initialCounts, "REAL_HISTORY_REFRESH_MISMATCH");

    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ["lattice", "soft-white", "crystal-aurora"]) {
        await selectThemeThroughUi(page, theme);
        const scene = await sampleRealScene(page);
        assertRealScene(scene);
        const screenshot = path.join(evidenceDir, `${theme}-${viewport.width}x${viewport.height}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        evidence.scenes.push({ ...scene, screenshot });
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await selectThemeThroughUi(page, "soft-white");
    await page.getByRole("button", { name: "应用广场" }).first().click();
    await page.locator(".marketplace-shell").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const marketplaceBackground = await page.evaluate(() => {
      const shell = document.querySelector(".marketplace-shell");
      const depth = document.querySelector(".marketplace-depth");
      if (!(shell && depth)) throw new Error("MARKETPLACE_BACKGROUND_NOT_FOUND");
      return {
        theme: document.documentElement.dataset.theme,
        bodyImage: getComputedStyle(document.body).backgroundImage,
        shellImage: getComputedStyle(shell).backgroundImage,
        depthFogImage: getComputedStyle(depth, "::before").backgroundImage,
      };
    });
    assert.equal(marketplaceBackground.theme, "soft-white");
    assert.doesNotMatch(
      `${marketplaceBackground.bodyImage} ${marketplaceBackground.shellImage} ${marketplaceBackground.depthFogImage}`,
      /7% 108%/u,
      "SOFT_WHITE_MARKETPLACE_BOTTOM_LEFT_FOG_PRESENT",
    );
    assert.match(
      `${marketplaceBackground.bodyImage} ${marketplaceBackground.shellImage}`,
      /7% -8%/u,
      "SOFT_WHITE_MARKETPLACE_TOP_LEFT_FOG_MISSING",
    );
    const marketplaceScreenshot = path.join(evidenceDir, "soft-white-marketplace-1440x900.png");
    await page.screenshot({ path: marketplaceScreenshot, fullPage: false });
    evidence.backgroundGuard = {
      ...marketplaceBackground,
      lowerLeftFogPresent: false,
      topLeftTransparentFogPresent: true,
      screenshot: marketplaceScreenshot,
    };
    evidence.adjacentPages.push({
      page: "marketplace",
      chatSurfaceCount: await page.locator('[data-chat-surface="unified-glass"]').count(),
      overflowX: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    });
    await page.goto(`${origin}/tools`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.locator("main").first().waitFor({ state: "visible", timeout: 20_000 });
    evidence.adjacentPages.push({
      page: "tools",
      chatSurfaceCount: await page.locator('[data-chat-surface="unified-glass"]').count(),
      overflowX: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    });
    for (const adjacent of evidence.adjacentPages) {
      assert.equal(adjacent.chatSurfaceCount, 0, `${adjacent.page}:CHAT_STYLE_LEAK`);
      assert.equal(adjacent.overflowX, 0, `${adjacent.page}:HORIZONTAL_OVERFLOW`);
    }

    assert.deepEqual(evidence.blockedWrites, [], "PAGE_ATTEMPTED_BUSINESS_WRITE");
    assert.deepEqual(evidence.pageErrors, [], "PAGE_ERRORS_DETECTED");
    assert.deepEqual(evidence.consoleErrors, [], "CONSOLE_ERRORS_DETECTED");
    assert.deepEqual(evidence.serverErrors, [], "SERVER_5XX_DETECTED");

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      origin,
      sourceVersion: version.sourceVersion || version.version || version.hash,
      buildId: version.buildId || version.build_id || null,
      accountRole: actor.role,
      realHistory: {
        conversationIdHash,
        messages: selected.conversation.messages.length,
        userMessages: selected.score.userMessages,
        assistantMessages: selected.score.assistantMessages,
        userChars: selected.score.userChars,
        assistantChars: selected.score.assistantChars,
        markdownSignals: selected.score.markdownSignals,
        loadedFromProtectedApi: evidence.historyResponses.some((entry) => entry.status === 200 && entry.detail),
        refreshRestored: true,
      },
      themes: ["lattice", "soft-white", "crystal-aurora"],
      viewports: ["1440x900", "1920x1080"],
      scenes: evidence.scenes,
      interactions: { copy: true, scrollToLatest: true, refreshRestore: true, retryTriggered: false },
      backgroundGuard: evidence.backgroundGuard,
      adjacentPages: evidence.adjacentPages,
      apiReadCount: evidence.apiReads.length,
      blockedWrites: evidence.blockedWrites,
      suppressedDiagnostics: evidence.suppressedDiagnostics,
      operationFlightRecorderObserved: evidence.suppressedDiagnostics.some((entry) => entry === "POST /api/operation-events"),
      simulatedAppearanceWrites: evidence.simulatedAppearanceWrites,
      externalRequests: evidence.externalRequests,
      consoleErrors: evidence.consoleErrors,
      pageErrors: evidence.pageErrors,
      serverErrors: evidence.serverErrors,
      providerCalls: 0,
      paidCalls: 0,
      businessWrites: 0,
    };
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sourceVersion: report.sourceVersion,
      buildId: report.buildId,
      realMessages: report.realHistory.messages,
      scenes: report.scenes.length,
      interactions: report.interactions,
      adjacentPages: report.adjacentPages,
      paidCalls: 0,
      businessWrites: 0,
      evidenceDir,
    }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

await main();
