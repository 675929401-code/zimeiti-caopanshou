import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const origin = String(process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", "chat-glass-continuity-20260930", runStamp);
const conversationId = "fixture-glass-conversation";
const now = "2026-09-30T08:00:00.000Z";
let fixtureTheme = "lattice";
const fixtureUser = {
  id: "fixture-chat-glass-user",
  username: "fixture_chat_glass",
  displayName: "聊天视觉验收",
  display_name: "聊天视觉验收",
  role: "admin",
  credits: 1000,
  cashBalance: 0,
};
const fixtureAgent = {
  id: "agent-1787160183236-5fi3w8",
  bot_id: "agent-1787160183236-5fi3w8",
  bot_name: "咨询回复与跟进",
  name: "咨询回复与跟进",
  description: "咨询回复输入框零费用视觉验收夹具",
  category: "商业定位IP",
  source: "llm",
  is_active: true,
  user_access: "available",
};
const fixtureAgentNavigationKeys = ["商业IP定位", "task:影像编导", "task:文案创作", "task:获客转化", "自用"];
const messages = [
  {
    id: "fixture-glass-user-message",
    role: "user",
    content: "请把这份内容梳理成清晰的执行方案，并保留关键判断。",
    created_at: now,
  },
  {
    id: "fixture-glass-assistant-message",
    role: "assistant",
    content: [
      "## 内容执行方案",
      "",
      "先确认目标，再按优先级推进。正文保持自然节奏，避免信息堆叠。",
      "",
      "- **目标**：让读者快速理解下一步",
      "- **顺序**：先处理影响结果的关键项",
      "- **验收**：每一步都留下可复核结果",
      "",
      "> 关键判断应当独立成段，便于快速阅读。",
      "",
      "| 阶段 | 输出 |",
      "| --- | --- |",
      "| 输入 | 已确认需求 |",
      "| 完成 | 可复核结果 |",
      "",
      "```text",
      "状态：已完成",
      "```",
      "",
      "[查看执行说明](https://example.invalid/guide)",
    ].join("\n"),
    created_at: now,
  },
];

function jsonResponse(body, status = 200) {
  return { status, contentType: "application/json; charset=utf-8", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

async function installFixtures(page, evidence) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(origin).origin) {
      evidence.externalRequests.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    evidence.apiRequests.push(`${request.method()} ${url.pathname}`);
    if (request.method() !== "GET") {
      if (url.pathname === "/api/product-usage/events") {
        evidence.interceptedTelemetryWrites.push(`${request.method()} ${url.pathname}`);
        await route.fulfill(jsonResponse({ success: true, interceptedFixture: true }));
        return;
      }
      evidence.writeRequests.push(`${request.method()} ${url.pathname}`);
    }

    if (url.pathname === "/api/auth/me") {
      await route.fulfill(jsonResponse({ user: fixtureUser }));
      return;
    }
    if (url.pathname === "/api/bots") {
      await route.fulfill(jsonResponse({ agents: [fixtureAgent], navigationKeys: fixtureAgentNavigationKeys }));
      return;
    }
    if (url.pathname === "/api/member-permissions") {
      await route.fulfill(jsonResponse({ permission: {
        userId: fixtureUser.id,
        role: fixtureUser.role,
        featureNavigationKeys: ["marketplace", "toolbox", "storyboard_workbench", "image_workbench", "create", "voice", "cover", "youcai", "commerce_agent"],
        agentNavigationKeys: fixtureAgentNavigationKeys,
        revision: 1,
        checksum: "fixture-chat-glass",
        sourceProfileKey: null,
        sourceProfileVersion: null,
        updatedAt: now,
        updatedBy: fixtureUser.id,
        reason: "visual-fixture",
        integrityValid: true,
        authorityStatus: "admin",
      } }));
      return;
    }
    if (url.pathname === "/api/chat-models") {
      await route.fulfill(jsonResponse({ models: [] }));
      return;
    }
    if (url.pathname === "/api/conversations/history") {
      if (url.searchParams.get("id")) {
        await route.fulfill(jsonResponse({ conversation: {
          id: conversationId,
          agent_id: fixtureAgent.id,
          agent_name: fixtureAgent.name,
          title: "聊天玻璃连续性验收",
          source: "llm",
          created_at: now,
          updated_at: now,
          messages,
        } }));
      } else {
        await route.fulfill(jsonResponse({ conversations: [{
          id: conversationId,
          agent_id: fixtureAgent.id,
          agent_name: fixtureAgent.name,
          title: "聊天玻璃连续性验收",
          source: "llm",
          last_message: messages.at(-1).content,
          created_at: now,
          updated_at: now,
        }] }));
      }
      return;
    }
    if (url.pathname === "/api/credits") {
      await route.fulfill(jsonResponse({ credits: 1000, cash_balance: 0 }));
      return;
    }
    if (url.pathname === "/api/settings") {
      await route.fulfill(jsonResponse({ settings: { theme: fixtureTheme, theme_mode: "system" } }));
      return;
    }
    if (url.pathname === "/api/settings/ui-preferences") {
      await route.fulfill(jsonResponse({ preferences: {} }));
      return;
    }
    if (url.pathname === "/api/settings/layout") {
      await route.fulfill(jsonResponse({ layout: null }));
      return;
    }
    if (url.pathname === "/api/categories") {
      await route.fulfill(jsonResponse({ categories: [{ name: "通用" }] }));
      return;
    }
    if (url.pathname === "/api/agent-favorites") {
      await route.fulfill(jsonResponse({ favorites: [] }));
      return;
    }
    if (url.pathname === "/api/nav-items") {
      await route.fulfill(jsonResponse({ items: [] }));
      return;
    }
    if (url.pathname === "/api/shortcuts") {
      await route.fulfill(jsonResponse({ shortcuts: [] }));
      return;
    }
    if (url.pathname === "/api/version") {
      await route.fulfill(jsonResponse({ version: "fixture-current-build", hash: "fixture-current-build" }));
      return;
    }
    if (url.pathname === "/api/announcements" || url.pathname === "/api/announcements/inbox") {
      await route.fulfill(jsonResponse({ announcements: [], items: [], unread: [] }));
      return;
    }
    if (url.pathname === "/api/diagnostic-logs") {
      await route.fulfill(jsonResponse({ success: true }));
      return;
    }
    await route.fulfill(jsonResponse({ fixture: true }));
  });
}

async function setTheme(page, theme) {
  fixtureTheme = theme;
  const mode = theme === "soft-white" ? "light" : "dark";
  await page.evaluate(({ selectedTheme, selectedMode }) => {
    localStorage.setItem("user_theme_preference", selectedTheme);
    localStorage.setItem("user_theme_mode_preference", "system");
    localStorage.setItem("app_theme", selectedTheme);
    localStorage.setItem("app_mode", selectedMode);
    document.documentElement.dataset.themeSelection = selectedTheme;
    document.documentElement.dataset.theme = selectedTheme;
    document.documentElement.dataset.modePreference = "system";
    document.documentElement.dataset.mode = selectedMode;
    document.documentElement.classList.toggle("dark", selectedMode === "dark");
  }, { selectedTheme: theme, selectedMode: mode });
  // The composer deliberately transitions between theme surfaces. Wait past
  // that transition so a screenshot cannot accidentally capture the previous
  // theme and report a false pass.
  await page.waitForTimeout(420);
}

async function sampleScene(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-chat-surface="unified-glass"]');
    const header = stage?.querySelector(".chat-stage-header");
    const assistant = stage?.querySelector(".chat-message-bubble-assistant");
    const user = stage?.querySelector(".chat-message-bubble-user");
    const markdown = assistant?.querySelector(".markdown-body");
    const composer = stage?.querySelector(".chat-composer-rainbow");
    const textarea = composer?.querySelector("textarea");
    const dock = stage?.querySelector(".chat-input-dock");
    const canvas = stage?.querySelector(".chat-canvas.chat-scroll");
    const contentRail = stage?.querySelector(".chat-content-rail.chat-shared-rail");
    const composerRail = stage?.querySelector(".chat-composer-rail.chat-shared-rail");
    const assistantRow = stage?.querySelector('[data-message-role="assistant"]');
    const userRow = stage?.querySelector('[data-message-role="user"]');
    const assistantRole = assistantRow?.querySelector('[data-testid="chat-message-role-label"]');
    const userRole = userRow?.querySelector('[data-testid="chat-message-role-label"]');
    const prose = markdown?.querySelector("p");
    const tableSurface = markdown?.querySelector(".table-wrapper") || markdown?.querySelector("table")?.parentElement;
    const codeSurface = markdown?.querySelector(".code-block-wrapper") || markdown?.querySelector("pre")?.parentElement;
    if (!(stage && header && assistant && user && markdown && composer && textarea && dock && canvas && contentRail && composerRail && assistantRow && userRow && assistantRole && prose && tableSurface && codeSurface)) {
      throw new Error("chat glass scene is incomplete");
    }
    const style = (node) => getComputedStyle(node);
    const rect = stage.getBoundingClientRect();
    const bounds = (node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, center: box.left + box.width / 2 };
    };
    return {
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stage: {
        bounds: bounds(stage),
        overflow: style(stage).overflow,
        isolation: style(stage).isolation,
        backgroundColor: style(stage).backgroundColor,
        width: rect.width,
        upperFog: getComputedStyle(stage, "::before").backgroundImage,
        gridBackground: getComputedStyle(stage, "::after").backgroundImage,
        gridSize: getComputedStyle(stage, "::after").backgroundSize,
        gridMask: getComputedStyle(stage, "::after").maskImage || getComputedStyle(stage, "::after").webkitMaskImage,
      },
      header: {
        backgroundImage: style(header).backgroundImage,
        backgroundColor: style(header).backgroundColor,
        backdropFilter: style(header).backdropFilter || style(header).webkitBackdropFilter,
      },
      assistant: {
        bounds: bounds(assistant),
        backgroundImage: style(assistant).backgroundImage,
        backgroundColor: style(assistant).backgroundColor,
        borderColor: style(assistant).borderColor,
        borderLeftWidth: style(assistant).borderLeftWidth,
        borderRadius: style(assistant).borderRadius,
        boxShadow: style(assistant).boxShadow,
        backdropFilter: style(assistant).backdropFilter || style(assistant).webkitBackdropFilter,
      },
      user: {
        backgroundImage: style(user).backgroundImage,
        backgroundColor: style(user).backgroundColor,
        borderColor: style(user).borderColor,
        borderLeftWidth: style(user).borderLeftWidth,
        boxShadow: style(user).boxShadow,
        backdropFilter: style(user).backdropFilter || style(user).webkitBackdropFilter,
      },
      typography: {
        assistantFontFamily: style(markdown).fontFamily,
        assistantFontSize: style(markdown).fontSize,
        assistantLineHeight: style(markdown).lineHeight,
        userFontFamily: style(user.querySelector(".user-message-content") || user).fontFamily,
        textareaFontFamily: style(textarea).fontFamily,
      },
      reading: {
        prose: bounds(prose),
        cjkColumns: prose.getBoundingClientRect().width / Number.parseFloat(style(prose).fontSize),
        tableSurface: bounds(tableSurface),
        codeSurface: bounds(codeSurface),
      },
      roles: {
        assistant: {
          label: assistantRole.textContent?.trim() || "",
          fontSize: Number.parseFloat(style(assistantRole).fontSize),
          visible: assistantRole.getBoundingClientRect().width > 0,
          accessibleName: assistantRow.getAttribute("aria-label") || "",
        },
        user: {
          labelPresent: Boolean(userRole),
          label: userRole?.textContent?.trim() || "",
          accessibleName: userRow.getAttribute("aria-label") || "",
        },
      },
      composer: {
        bounds: bounds(composer),
        backgroundImage: style(composer).backgroundImage,
        backgroundColor: style(composer).backgroundColor,
        borderWidth: style(composer).borderWidth,
        borderColor: style(composer).borderColor,
        boxShadow: style(composer).boxShadow,
        backdropFilter: style(composer).backdropFilter || style(composer).webkitBackdropFilter,
        pocketContent: getComputedStyle(composer, "::before").content,
        pocketBackgroundImage: getComputedStyle(composer, "::before").backgroundImage,
        uploadButtonVisible: Boolean(composer.querySelector('button[title="上传图片"]')?.getBoundingClientRect().width),
        sendButtonVisible: Boolean(composer.querySelector('button[title="发送"]')?.getBoundingClientRect().width),
        fileInputAccept: composer.querySelector('input[type="file"]')?.getAttribute("accept") || "",
        fileInputMultiple: composer.querySelector('input[type="file"]')?.hasAttribute("multiple") || false,
      },
      rails: {
        content: bounds(contentRail),
        composer: bounds(composerRail),
        stageCenter: rect.left + rect.width / 2,
        contentComputed: { width: style(contentRail).width, maxWidth: style(contentRail).maxWidth, boxSizing: style(contentRail).boxSizing, padding: `${style(contentRail).paddingLeft} ${style(contentRail).paddingRight}` },
        composerComputed: { width: style(composerRail).width, maxWidth: style(composerRail).maxWidth, boxSizing: style(composerRail).boxSizing, padding: `${style(composerRail).paddingLeft} ${style(composerRail).paddingRight}` },
      },
      canvas: {
        bounds: bounds(canvas),
        backgroundImage: style(canvas).backgroundImage,
        backgroundColor: style(canvas).backgroundColor,
        scrollbarGutter: style(canvas).scrollbarGutter,
        scrollbarWidth: style(canvas).scrollbarWidth,
        paddingInline: `${style(canvas).paddingLeft} ${style(canvas).paddingRight}`,
        marginInline: `${style(canvas).marginLeft} ${style(canvas).marginRight}`,
      },
      dock: {
        bounds: bounds(dock),
        backgroundImage: style(dock).backgroundImage,
        backgroundColor: style(dock).backgroundColor,
        borderTopWidth: style(dock).borderTopWidth,
        borderLeftWidth: style(dock).borderLeftWidth,
        boxShadow: style(dock).boxShadow,
        backdropFilter: style(dock).backdropFilter || style(dock).webkitBackdropFilter,
        paddingTop: style(dock).paddingTop,
        paddingBottom: style(dock).paddingBottom,
        beforeContent: getComputedStyle(dock, "::before").content,
        afterContent: getComputedStyle(dock, "::after").content,
      },
      markdownBlocks: {
        headings: assistant.querySelectorAll("h1,h2,h3,h4").length,
        lists: assistant.querySelectorAll("ul,ol").length,
        quotes: assistant.querySelectorAll("blockquote").length,
        tables: assistant.querySelectorAll("table").length,
        codeBlocks: assistant.querySelectorAll("pre").length,
        links: assistant.querySelectorAll("a").length,
      },
      actionButtons: assistant.parentElement?.querySelectorAll("button").length || 0,
    };
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

async function sampleBoundaryPixels(screenshot, scene) {
  const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const boundaryY = Math.round(scene.dock.bounds.top);
  const stageLeft = Math.round(scene.stage.bounds.left);
  const stageRight = Math.round(scene.stage.bounds.right);
  const sampleXs = [stageLeft + 12, stageLeft + 32, stageRight - 32, stageRight - 12]
    .map((value) => Math.max(2, Math.min(info.width - 3, value)));
  const patchColor = (centerX, fromY, toY) => {
    const channels = [[], [], []];
    for (let y = Math.max(0, fromY); y <= Math.min(info.height - 1, toY); y += 1) {
      for (let x = centerX - 2; x <= centerX + 2; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        for (let channel = 0; channel < 3; channel += 1) channels[channel].push(data[offset + channel]);
      }
    }
    return channels.map(median);
  };
  const samples = sampleXs.map((x) => {
    const above = patchColor(x, boundaryY - 7, boundaryY - 3);
    const below = patchColor(x, boundaryY + 3, boundaryY + 7);
    const delta = Math.sqrt(above.reduce((sum, value, index) => sum + ((value - below[index]) ** 2), 0));
    return { x, above, below, delta: Number(delta.toFixed(3)) };
  });
  const deltas = samples.map((sample) => sample.delta);
  return {
    boundaryY,
    sampleXs,
    meanDelta: Number((deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(3)),
    maxDelta: Math.max(...deltas),
    samples,
  };
}

function assertScene(scene) {
  assert.equal(scene.documentOverflowX, 0, `${scene.theme} has horizontal overflow`);
  assert.equal(scene.stage.overflow, "hidden");
  assert.equal(scene.stage.isolation, "isolate");
  assert.match(scene.stage.upperFog, /radial-gradient/iu);
  assert.match(scene.stage.gridBackground, /linear-gradient/iu);
  assert.equal(scene.stage.gridSize, "72px 72px, 72px 72px");
  assert.equal(scene.stage.gridMask, "none", `${scene.theme} grid still fades into a bottom wall`);
  assert.equal(scene.canvas.backgroundImage, "none", `${scene.theme} canvas still paints a second background plane`);
  assert.match(scene.canvas.backgroundColor, /rgba\(0, 0, 0, 0\)|transparent/iu, `${scene.theme} canvas is not transparent to the unified stage`);
  assert.match(scene.header.backdropFilter, /blur\(/iu);
  assert.equal(scene.assistant.backgroundImage, "none", `${scene.theme} assistant reply restored a detached card`);
  assert.match(scene.assistant.backgroundColor, /rgba\(0, 0, 0, 0\)|transparent/iu);
  assert.equal(scene.assistant.borderLeftWidth, "0px");
  assert.equal(scene.assistant.boxShadow, "none");
  assert.equal(scene.assistant.backdropFilter, "none");
  assert.equal(scene.user.backgroundImage, "none", `${scene.theme} user turn restored a detached card`);
  assert.match(scene.user.backgroundColor, /rgba\(0, 0, 0, 0\)|transparent/iu);
  assert.equal(scene.user.borderLeftWidth, "0px");
  assert.equal(scene.user.boxShadow, "none");
  assert.equal(scene.user.backdropFilter, "none");
  assert.match(scene.composer.backgroundImage, /linear-gradient\(145deg/iu, `${scene.theme} lost the accepted historical composer surface`);
  assert.doesNotMatch(scene.composer.backgroundImage, /conic-gradient/iu);
  assert.equal(scene.composer.borderWidth, "1px");
  const expectedComposerGradient = {
    lattice: [/rgba\(14, 37, 65, 0\.72\)/u, /rgba\(7, 24, 47, 0\.62\)/u],
    "soft-white": [/rgba\(255, 255, 255, 0\.8\)/u, /rgba\(247, 251, 248, 0\.67\)/u],
    "crystal-aurora": [/rgba\(9, 43, 51, 0\.92\)/u, /rgba\(5, 27, 34, 0\.9\)/u],
  }[scene.theme];
  assert.ok(expectedComposerGradient, `${scene.theme} has no historical composer contract`);
  for (const stop of expectedComposerGradient) assert.match(scene.composer.backgroundImage, stop, `${scene.theme} composer captured the wrong historical surface`);
  const expectedComposerBorder = {
    lattice: "rgba(135, 205, 226, 0.22)",
    "soft-white": "rgba(78, 126, 117, 0.18)",
    "crystal-aurora": "rgba(94, 181, 188, 0.24)",
  }[scene.theme];
  assert.equal(scene.composer.borderColor, expectedComposerBorder, `${scene.theme} composer did not restore the R598 border`);
  assert.notEqual(scene.composer.boxShadow, "none", `${scene.theme} composer lost the R598 soft shadow`);
  assert.match(scene.composer.backdropFilter, /blur\(22px\) saturate\(1\.16\)/iu);
  assert.equal(scene.composer.uploadButtonVisible, true, `${scene.theme} lost the image upload control`);
  assert.equal(scene.composer.sendButtonVisible, true, `${scene.theme} lost the send control`);
  assert.match(scene.composer.fileInputAccept, /image\/png/u);
  assert.equal(scene.composer.fileInputMultiple, true);
  assert.ok(scene.rails.content.width < scene.rails.composer.width, `${scene.theme} transcript must be narrower than composer: ${JSON.stringify(scene.rails)}`);
  assert.ok(scene.assistant.bounds.width < scene.composer.bounds.width, `${scene.theme} reply must be narrower than composer: ${JSON.stringify({ assistant: scene.assistant.bounds, composer: scene.composer.bounds })}`);
  assert.ok(Math.abs(scene.rails.content.center - scene.rails.stageCenter) <= 1, `${scene.theme} content rail is not centered`);
  assert.ok(Math.abs(scene.rails.composer.center - scene.rails.stageCenter) <= 1, `${scene.theme} composer rail is not centered`);
  assert.equal(scene.rails.composerComputed.padding, "20px 20px", `${scene.theme} composer lost the R598 side spacing`);
  assert.equal(scene.canvas.scrollbarGutter, "auto", `${scene.theme} transcript still reserves a side gutter`);
  assert.equal(scene.dock.backgroundImage, "none");
  assert.match(scene.dock.backgroundColor, /rgba\(0, 0, 0, 0\)|transparent/iu);
  assert.equal(scene.dock.borderTopWidth, "0px");
  assert.equal(scene.dock.borderLeftWidth, "0px");
  assert.equal(scene.dock.boxShadow, "none");
  assert.equal(scene.dock.backdropFilter, "none");
  assert.equal(scene.dock.paddingTop, "18px");
  assert.equal(scene.dock.paddingBottom, "8px");
  assert.ok(scene.boundaryPixelContinuity.meanDelta <= 8, `${scene.theme} canvas/dock boundary has a visible mean color jump: ${JSON.stringify(scene.boundaryPixelContinuity)}`);
  assert.ok(scene.boundaryPixelContinuity.maxDelta <= 18, `${scene.theme} canvas/dock boundary has a visible local color jump: ${JSON.stringify(scene.boundaryPixelContinuity)}`);
  assert.ok(["none", '""'].includes(scene.dock.beforeContent));
  assert.ok(["none", '""'].includes(scene.dock.afterContent));
  assert.match(scene.typography.assistantFontFamily, /PingFang SC|Microsoft YaHei|Inter/iu);
  assert.equal(scene.typography.assistantFontFamily, scene.typography.userFontFamily);
  assert.equal(scene.typography.assistantFontFamily, scene.typography.textareaFontFamily);
  assert.ok(Number.parseFloat(scene.typography.assistantFontSize) >= 18, `${scene.theme} Chinese body copy is still too small`);
  assert.ok(Number.parseFloat(scene.typography.assistantLineHeight) >= 27);
  assert.ok(scene.reading.prose.width <= 880.5, `${scene.theme} prose is wider than the 55rem reading measure: ${JSON.stringify(scene.reading)}`);
  assert.ok(scene.reading.cjkColumns <= 50, `${scene.theme} prose line is too long for Chinese scanning: ${JSON.stringify(scene.reading)}`);
  assert.ok(scene.reading.tableSurface.width <= scene.rails.content.width + 1, `${scene.theme} table exceeds the transcript rail`);
  assert.ok(scene.reading.codeSurface.width <= scene.rails.content.width + 1, `${scene.theme} code exceeds the transcript rail`);
  assert.equal(scene.roles.user.labelPresent, false, `${scene.theme} still renders the redundant visible user role label`);
  assert.equal(scene.roles.user.label, "");
  assert.ok(scene.roles.assistant.label.length > 0, `${scene.theme} assistant role label is missing`);
  assert.equal(scene.roles.assistant.visible, true);
  assert.ok(scene.roles.assistant.fontSize >= 12, `${scene.theme} assistant role label is too small`);
  assert.equal(scene.roles.user.accessibleName, "你的消息", `${scene.theme} user message lost its accessible name`);
  assert.notEqual(scene.roles.user.accessibleName, scene.roles.assistant.accessibleName, `${scene.theme} message roles have the same accessible name`);
  for (const [kind, count] of Object.entries(scene.markdownBlocks)) {
    assert.ok(count >= 1, `${scene.theme} lost Markdown ${kind}`);
  }
  assert.ok(scene.actionButtons >= 1, `${scene.theme} lost message actions`);
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const evidence = { apiRequests: [], writeRequests: [], interceptedTelemetryWrites: [], externalRequests: [], consoleErrors: [], pageErrors: [], scenes: [], adjacentPages: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: origin });
    await context.addInitScript(({ user, activeId }) => {
      localStorage.setItem("auth_token", "fixture-chat-glass-token");
      localStorage.setItem("auth_user", JSON.stringify(user));
      localStorage.setItem("active_view", "chat");
      localStorage.setItem("active_conversation_id", activeId);
      sessionStorage.setItem("entered_app", "1");
    }, { user: fixtureUser, activeId: conversationId });
    const page = await context.newPage();
    await installFixtures(page, evidence);
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|ResizeObserver|ERR_BLOCKED_BY_CLIENT/iu.test(message.text())) evidence.consoleErrors.push(message.text().slice(0, 500));
    });
    page.on("pageerror", (error) => evidence.pageErrors.push(error.message.slice(0, 500)));
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator('[data-chat-surface="unified-glass"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(".chat-message-bubble-assistant .markdown-body").waitFor({ state: "visible", timeout: 20_000 });

    const composerInput = page.locator('.chat-composer-rainbow textarea');
    assert.match(await composerInput.getAttribute("placeholder") || "", /向 咨询回复与跟进 补充信息或提出任务/u);
    const fileChooserEvent = page.waitForEvent("filechooser");
    await page.locator('.chat-composer-rainbow button[title="上传图片"]').click();
    assert.equal((await fileChooserEvent).isMultiple(), true, "image upload control did not open the multi-file chooser");
    await composerInput.fill("对话框功能验收");
    const sendButton = page.locator('.chat-composer-rainbow button[title="发送"]');
    assert.equal(await sendButton.isEnabled(), true, "send control did not enable after typing");
    const expandButton = page.getByRole("button", { name: "展开输入框" });
    await expandButton.click();
    await page.getByRole("button", { name: "收起输入框" }).waitFor({ state: "visible" });
    await composerInput.fill("");
    await composerInput.blur();

    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ["lattice", "soft-white", "crystal-aurora"]) {
        await setTheme(page, theme);
        const scene = await sampleScene(page);
        const screenshot = path.join(evidenceDir, `${theme}-${viewport.width}x${viewport.height}.png`);
        await page.screenshot({ path: screenshot, fullPage: false, animations: "disabled", caret: "hide" });
        scene.boundaryPixelContinuity = await sampleBoundaryPixels(screenshot, scene);
        assertScene(scene);
        evidence.scenes.push({ ...scene, screenshot });
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await setTheme(page, "soft-white");
    await page.getByRole("button", { name: "应用广场" }).first().click();
    await page.locator(".marketplace-shell").waitFor({ state: "visible", timeout: 10_000 });
    const marketplaceScreenshot = path.join(evidenceDir, "adjacent-marketplace-soft-white-1440x900.png");
    await page.screenshot({ path: marketplaceScreenshot, fullPage: false, animations: "disabled", caret: "hide" });
    evidence.adjacentPages.push({
      page: "marketplace",
      theme: await page.evaluate(() => document.documentElement.dataset.theme || ""),
      chatSurfaceCount: await page.locator('[data-chat-surface="unified-glass"]').count(),
      chatDockCount: await page.locator(".chat-input-dock,.chat-composer-rail").count(),
      overflowX: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      bodyTextLength: (await page.locator("body").innerText()).trim().length,
      screenshot: marketplaceScreenshot,
    });
    await page.goto(`${origin}/tools`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("main").first().waitFor({ state: "visible", timeout: 15_000 });
    const toolsScreenshot = path.join(evidenceDir, "adjacent-tools-soft-white-1440x900.png");
    await page.screenshot({ path: toolsScreenshot, fullPage: false, animations: "disabled", caret: "hide" });
    evidence.adjacentPages.push({
      page: "tools",
      theme: await page.evaluate(() => document.documentElement.dataset.theme || ""),
      chatSurfaceCount: await page.locator('[data-chat-surface="unified-glass"]').count(),
      chatDockCount: await page.locator(".chat-input-dock,.chat-composer-rail").count(),
      overflowX: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      bodyTextLength: (await page.locator("body").innerText()).trim().length,
      screenshot: toolsScreenshot,
    });
    for (const adjacent of evidence.adjacentPages) {
      assert.equal(adjacent.chatSurfaceCount, 0, `${adjacent.page} inherited chat-only surface`);
      assert.equal(adjacent.chatDockCount, 0, `${adjacent.page} inherited the chat composer dock`);
      assert.equal(adjacent.theme, "soft-white", `${adjacent.page} lost the selected theme`);
      assert.equal(adjacent.overflowX, 0, `${adjacent.page} has horizontal overflow`);
      assert.ok(adjacent.bodyTextLength > 0, `${adjacent.page} rendered an empty body`);
    }
    assert.deepEqual(evidence.writeRequests, [], "visual acceptance attempted an API write");
    assert.ok(
      evidence.externalRequests.every((url) => /^https:\/\/fonts\.googleapis\.cn\//u.test(url)),
      `visual acceptance attempted an unexpected external request: ${JSON.stringify(evidence.externalRequests)}`,
    );
    assert.deepEqual(evidence.pageErrors, [], "page errors detected");
    assert.deepEqual(evidence.consoleErrors, [], "console errors detected");

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      acceptanceVersion: "chat-ux.v2",
      origin,
      viewports: ["1440x900", "1920x1080"],
      themes: ["lattice", "soft-white", "crystal-aurora"],
      scenes: evidence.scenes,
      adjacentPages: evidence.adjacentPages,
      writeRequests: evidence.writeRequests,
      interceptedTelemetryWrites: evidence.interceptedTelemetryWrites,
      externalRequests: evidence.externalRequests,
      externalRequestsCompleted: 0,
      consoleErrors: evidence.consoleErrors,
      pageErrors: evidence.pageErrors,
      paidCalls: 0,
    };
    fs.writeFileSync(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: report.ok, scenes: report.scenes.length, adjacentPages: report.adjacentPages, paidCalls: 0, evidenceDir }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

await main();
