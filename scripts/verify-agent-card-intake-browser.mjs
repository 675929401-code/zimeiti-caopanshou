#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const outputDir = path.resolve(".codex-evidence/agent-card-intake-browser");
const themes = [
  { id: "lattice", mode: "dark" },
  { id: "soft-white", mode: "light" },
  { id: "crystal-aurora", mode: "dark" },
];
const viewports = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const user = {
  id: "agent-ui-browser-fixture-user",
  username: "agent_ui_fixture",
  displayName: "智能体界面验收夹具",
  role: "user",
  status: "active",
  is_active: true,
  memberStatus: "active",
  credits: 0,
};
const token = "agent-ui-browser-fixture-token";
const presetAgentId = "fixture-agent-intake";
const agents = [
  {
    id: presetAgentId,
    name: "内容增长策略导演",
    description: "把账号定位、目标受众和真实素材整理成可执行的内容增长方案，并保留清晰的下一步。",
    icon_url: "/avatars/cute-semantic/agent-cute-01.webp",
    source: "llm",
    bot_id: "",
    model: "fixture-zero-cost",
    category: "task:文案创作",
    sort_order: 1,
    cost_per_message: 0,
    base_fee: 0,
    is_active: true,
    user_access: "available",
    model_id: "fixture-model",
    model_public_id: "fixture-model",
    preset_fields: [
      {
        id: "goal",
        label: "核心目标",
        type: "text",
        required: true,
        placeholder: "例如：30 天内建立稳定更新节奏",
        options: [],
        order: 1,
      },
      {
        id: "audience",
        label: "目标受众",
        type: "select",
        required: false,
        placeholder: "请选择",
        options: ["新手创作者", "成熟内容团队", "本地门店经营者"],
        order: 2,
      },
      {
        id: "brief",
        label: "补充资料",
        type: "textarea",
        required: false,
        placeholder: "例如：\n1. 每周可投入的时间\n2. 已有素材和限制",
        options: [],
        order: 3,
      },
    ],
  },
  {
    id: "fixture-agent-creative",
    name: "短视频原创表达顾问",
    description: "围绕真实经历和业务证据，帮助用户形成自然、清楚且不套模板的短视频表达。",
    icon_url: "/avatars/cute-semantic/agent-cute-02.webp",
    source: "llm",
    bot_id: "",
    model: "fixture-zero-cost",
    category: "task:文案创作",
    sort_order: 2,
    cost_per_message: 0,
    base_fee: 0,
    is_active: true,
    user_access: "available",
    model_id: "fixture-model",
    model_public_id: "fixture-model",
    preset_fields: [],
  },
];

function cssColor(value) {
  const match = String(value || "").trim().match(/^rgba?\(([^)]+)\)$/iu);
  if (!match) throw new Error(`UNSUPPORTED_COLOR:${value}`);
  const parts = match[1].replace("/", " ").split(/[\s,]+/u).filter(Boolean).map(Number);
  return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
}

function composite(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: ((foreground.r * foreground.a) + (background.r * background.a * (1 - foreground.a))) / alpha,
    g: ((foreground.g * foreground.a) + (background.g * background.a * (1 - foreground.a))) / alpha,
    b: ((foreground.b * foreground.a) + (background.b * background.a * (1 - foreground.a))) / alpha,
    a: alpha,
  };
}

function luminance(color) {
  const channels = [color.r, color.g, color.b].map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrast(foregroundValue, backgroundValue, underlayValue) {
  const underlay = cssColor(underlayValue);
  const background = composite(cssColor(backgroundValue), underlay);
  const foreground = composite(cssColor(foregroundValue), background);
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

async function installFixture(context, theme, report, scope) {
  await context.addInitScript(({ selectedTheme, selectedMode, fixtureToken, fixtureUser }) => {
    localStorage.setItem("auth_token", fixtureToken);
    localStorage.setItem("auth_user", JSON.stringify({
      ...fixtureUser,
      themePreference: selectedTheme,
      theme_preference: selectedTheme,
      themeModePreference: selectedMode,
      theme_mode_preference: selectedMode,
    }));
    localStorage.setItem("user_theme_preference", selectedTheme);
    localStorage.setItem("user_theme_mode_preference", selectedMode);
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.setItem("entered_app", "1");
  }, { selectedTheme: theme.id, selectedMode: theme.mode, fixtureToken: token, fixtureUser: user });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.origin !== origin) {
      report.externalRequests.push({ scope, method, url: url.origin + url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (method === "GET" && url.pathname === "/api/auth/me") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: {
        ...user,
        themePreference: theme.id,
        theme_preference: theme.id,
        themeModePreference: theme.mode,
        theme_mode_preference: theme.mode,
      } }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/bots") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        agents,
        navigationKeys: ["task:文案创作", "task:获客转化"],
      }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/member-permissions") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ permission: {
        userId: user.id,
        role: "user",
        featureNavigationKeys: ["marketplace", "toolbox", "create"],
        agentNavigationKeys: ["task:文案创作", "task:获客转化"],
        revision: 1,
        checksum: "agent-ui-fixture",
        integrityValid: true,
        authorityStatus: "ready",
      } }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/agent-favorites") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ favorites: [] }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: { theme: theme.id, theme_mode: theme.mode } }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings/appearance") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: { theme: theme.id, theme_mode: theme.mode } }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings/layout") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ layout: null }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings/ui-preferences") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferences: {} }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/conversations/history") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [] }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/extract/history") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [], next: null, retryReady: true }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/tools/runtime-catalog") {
      const unavailable = (service) => ({ available: false, pricingReady: false, service, unitPrice: null, currency: "CNY", unit: "条" });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: {
        video: unavailable("视频提取"),
        text: unavailable("文案提取"),
        batch: unavailable("批量提取"),
        search: unavailable("搜索提取"),
        formatter: { available: true, service: "文字排版", unitPrice: 0, currency: "CNY", unit: "次", processingMode: "local_rules" },
        segmenter: { available: true, service: "智能分段", unitPrice: 0, currency: "CNY", unit: "次", processingMode: "local_rules" },
      } }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/cash/balance") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ balance: 0 }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/credits") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ credits: 0, cashBalance: 0, transactions: [] }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/notifications/user") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [], unreadCount: 0, nextCursor: null }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/announcements/inbox") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ announcements: [], unreadCount: 0, cursor: "empty" }) });
      return;
    }
    if (method === "GET" && ["/api/categories", "/api/nav-items", "/api/shortcuts"].includes(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [], items: [], shortcuts: [] }) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/video/active-tasks") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTasks: [] }) });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      report.interceptedMutations.push({ scope, method, pathname: url.pathname });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
      return;
    }
    if (/\/(?:generate|payment|billing|quotes?)(?:\/|$)/u.test(url.pathname)) {
      report.paidRequests.push({ scope, method, pathname: url.pathname });
    }
    await route.continue();
  });
}

async function main() {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  await mkdir(outputDir, { recursive: true });
  const [receipt, diskBuildId, currentFingerprint, versionResponse] = await Promise.all([
    readFile(path.resolve(".next/local-source-fingerprint.v1.json"), "utf8").then(JSON.parse),
    readFile(path.resolve(".next/BUILD_ID"), "utf8").then((value) => value.trim()),
    Promise.resolve(computeLocalBuildFingerprint(process.cwd())),
    fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) }),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const servedVersion = await versionResponse.json();
  const servedBuildId = servedVersion.buildId || servedVersion.version || "";
  const runningLatest = receipt.fingerprint === currentFingerprint.fingerprint
    && receipt.fileCount === currentFingerprint.fileCount
    && receipt.buildId === diskBuildId
    && servedBuildId === diskBuildId;
  assert.equal(runningLatest, true, "RUNNING_LATEST_REQUIRED");

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    origin,
    runtime: {
      sourceVersion: servedVersion.sourceVersion,
      diskBuildId,
      servedBuildId,
      sourceFingerprintCurrent: true,
      runningLatest,
    },
    fixture: { agentCount: agents.length, presetAgentId, identitySource: "browser-fixture" },
    cases: [],
    adjacentPages: [],
    interceptedMutations: [],
    reachedServerMutations: [],
    paidRequests: [],
    externalRequests: [],
    pageErrors: [],
    consoleErrors: [],
    serverErrors: [],
  };

  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of themes) {
      for (const viewport of viewports) {
        const scope = `${theme.id}:${viewport.width}x${viewport.height}`;
        const context = await browser.newContext({ viewport, serviceWorkers: "block" });
        await installFixture(context, theme, report, scope);
        const page = await context.newPage();
        page.on("pageerror", (error) => report.pageErrors.push({ scope, message: error.message.slice(0, 400) }));
        page.on("console", (message) => {
          if (message.type() === "error" && !/favicon|React DevTools/u.test(message.text())) {
            report.consoleErrors.push({ scope, message: message.text().slice(0, 400) });
          }
        });
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.origin === origin && response.status() >= 400) {
            report.serverErrors.push({ scope, status: response.status(), pathname: url.pathname });
          }
        });
        const response = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
        assert.equal(response?.status(), 200, `${scope}:HOME_HTTP`);
        const cards = page.locator(".marketplace-agent-grid .agent-card-hover");
        await cards.first().waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction((expected) => document.querySelectorAll(".marketplace-agent-grid .agent-card-hover").length === expected, agents.length, { timeout: 15_000 });
        await page.waitForTimeout(500);
        const marketplace = await page.evaluate(() => {
          const grid = document.querySelector(".marketplace-agent-grid");
          const cardNodes = [...document.querySelectorAll(".marketplace-agent-grid .agent-card-hover")];
          const gridStyle = grid ? getComputedStyle(grid) : null;
          return {
            theme: document.documentElement.dataset.theme || "",
            mode: document.documentElement.dataset.mode || "",
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            gridColumnGap: Number.parseFloat(gridStyle?.columnGap || "0"),
            gridRowGap: Number.parseFloat(gridStyle?.rowGap || "0"),
            gridBox: grid?.getBoundingClientRect().toJSON?.() || null,
            cards: cardNodes.map((card) => {
              const box = card.getBoundingClientRect();
              const avatar = card.querySelector(".marketplace-agent-avatar");
              const image = avatar?.querySelector("img");
              const title = card.querySelector(".marketplace-agent-title");
              const description = card.querySelector(".marketplace-agent-description");
              const titleBox = title?.getBoundingClientRect();
              const descriptionBox = description?.getBoundingClientRect();
              return {
                ariaLabel: card.getAttribute("aria-label") || "",
                box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
                avatar: avatar ? { width: avatar.getBoundingClientRect().width, height: avatar.getBoundingClientRect().height } : null,
                image: image instanceof HTMLImageElement ? { complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight } : null,
                title: title ? {
                  text: title.textContent?.trim() || "",
                  fontSize: Number.parseFloat(getComputedStyle(title).fontSize),
                  visibleHeight: titleBox?.height || 0,
                  scrollHeight: title.scrollHeight,
                } : null,
                description: description ? {
                  text: description.textContent?.trim() || "",
                  fontSize: Number.parseFloat(getComputedStyle(description).fontSize),
                  lineHeight: Number.parseFloat(getComputedStyle(description).lineHeight),
                  visibleHeight: descriptionBox?.height || 0,
                } : null,
              };
            }),
          };
        });
        assert.equal(marketplace.theme, theme.id, `${scope}:THEME_MISMATCH`);
        assert.equal(marketplace.mode, theme.mode, `${scope}:MODE_MISMATCH`);
        assert.equal(marketplace.overflowX, 0, `${scope}:HORIZONTAL_OVERFLOW`);
        assert.ok(marketplace.gridColumnGap >= 12 && marketplace.gridColumnGap <= 32, `${scope}:CARD_COLUMN_GAP`);
        assert.ok(marketplace.gridRowGap >= 12 && marketplace.gridRowGap <= 32, `${scope}:CARD_ROW_GAP`);
        assert.equal(marketplace.cards.length, agents.length, `${scope}:CARD_COUNT`);
        for (const card of marketplace.cards) {
          assert.ok(card.box.left >= -1 && card.box.right <= viewport.width + 1, `${scope}:CARD_OUTSIDE_VIEWPORT`);
          assert.ok(card.box.width >= 220 && card.box.height >= 88 && card.box.height <= 150, `${scope}:CARD_PROPORTION`);
          assert.ok(card.avatar && card.avatar.width >= 52 && card.avatar.height >= 52, `${scope}:AVATAR_TOO_SMALL`);
          assert.ok(card.image?.complete && card.image.naturalWidth > 0 && card.image.naturalHeight > 0, `${scope}:AVATAR_BROKEN`);
          assert.ok(card.title?.text && card.title.fontSize >= 15 && card.title.visibleHeight > 0, `${scope}:TITLE_UNREADABLE`);
          assert.ok(card.description?.text && card.description.fontSize >= 12 && card.description.visibleHeight >= card.description.lineHeight * 1.8, `${scope}:DESCRIPTION_TOO_TIGHT`);
        }
        await page.screenshot({ path: path.join(outputDir, `${theme.id}-${viewport.width}x${viewport.height}-marketplace.png`), fullPage: false });

        const presetCard = page.getByRole("button", { name: `打开智能体：${agents[0].name}`, exact: true });
        await presetCard.click();
        const firstInput = page.locator("#preset-goal");
        await firstInput.waitFor({ state: "visible", timeout: 15_000 });
        const intake = await firstInput.evaluate((input) => {
          const root = input.closest('[role="dialog"]');
          const panel = input.closest('[data-testid="agent-preset-intake"]');
          const textarea = document.querySelector("#preset-brief");
          const select = document.querySelector("#preset-audience");
          const label = input.closest("div")?.querySelector("label");
          const startButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim().includes("开始"));
          const panelBox = panel?.getBoundingClientRect();
          const panelStyle = panel ? getComputedStyle(panel) : null;
          const inputStyle = getComputedStyle(input);
          const labelStyle = label ? getComputedStyle(label) : null;
          const buttonStyle = startButton ? getComputedStyle(startButton) : null;
          return {
            panelBox: panelBox ? { left: panelBox.left, top: panelBox.top, right: panelBox.right, bottom: panelBox.bottom, width: panelBox.width, height: panelBox.height } : null,
            rootVisible: Boolean(root && root.getClientRects().length),
            fieldCount: document.querySelectorAll('[id^="preset-"]').length,
            inputVisible: input.getClientRects().length > 0,
            selectVisible: Boolean(select && select.getClientRects().length),
            textareaVisible: Boolean(textarea && textarea.getClientRects().length),
            inputColor: inputStyle.color,
            inputBackground: inputStyle.backgroundColor,
            panelBackground: panelStyle?.backgroundColor || "rgb(255, 255, 255)",
            labelColor: labelStyle?.color || "rgb(0, 0, 0)",
            buttonColor: buttonStyle?.color || "rgb(255, 255, 255)",
            buttonBackground: buttonStyle?.backgroundColor || "rgb(0, 0, 0)",
            overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          };
        });
        assert.equal(intake.rootVisible, true, `${scope}:INTAKE_ROOT_HIDDEN`);
        assert.ok(intake.panelBox && intake.panelBox.left >= -1 && intake.panelBox.right <= viewport.width + 1
          && intake.panelBox.top >= -1 && intake.panelBox.bottom <= viewport.height + 1, `${scope}:INTAKE_OUTSIDE_VIEWPORT`);
        assert.equal(intake.fieldCount, 3, `${scope}:INTAKE_FIELD_COUNT`);
        assert.equal(intake.inputVisible && intake.selectVisible && intake.textareaVisible, true, `${scope}:INTAKE_FIELD_HIDDEN`);
        assert.equal(intake.overflowX, 0, `${scope}:INTAKE_HORIZONTAL_OVERFLOW`);
        intake.contrast = {
          label: Number(contrast(intake.labelColor, intake.panelBackground, intake.panelBackground).toFixed(2)),
          input: Number(contrast(intake.inputColor, intake.inputBackground, intake.panelBackground).toFixed(2)),
          primaryButton: Number(contrast(intake.buttonColor, intake.buttonBackground, intake.panelBackground).toFixed(2)),
        };
        assert.ok(intake.contrast.label >= 4.5, `${scope}:INTAKE_LABEL_CONTRAST:${intake.contrast.label}`);
        assert.ok(intake.contrast.input >= 4.5, `${scope}:INTAKE_INPUT_CONTRAST:${intake.contrast.input}`);
        assert.ok(intake.contrast.primaryButton >= 4.5, `${scope}:INTAKE_BUTTON_CONTRAST:${intake.contrast.primaryButton}`);
        await page.screenshot({ path: path.join(outputDir, `${theme.id}-${viewport.width}x${viewport.height}-intake.png`), fullPage: false });
        await page.keyboard.press("Escape");
        await firstInput.waitFor({ state: "detached", timeout: 10_000 });
        report.cases.push({ scope, theme, viewport, marketplace, intake });

        if (viewport.width === 1440) {
          for (const pathname of ["/tools", "/video"]) {
            const adjacentResponse = await page.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
            assert.equal(adjacentResponse?.status(), 200, `${scope}:${pathname}:HTTP`);
            await page.waitForFunction(() => (document.body?.innerText?.trim().length || 0) > 30, null, { timeout: 30_000 });
            const adjacent = await page.evaluate(() => ({
              theme: document.documentElement.dataset.theme || "",
              mode: document.documentElement.dataset.mode || "",
              overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            }));
            assert.equal(adjacent.theme, theme.id, `${scope}:${pathname}:THEME`);
            assert.equal(adjacent.mode, theme.mode, `${scope}:${pathname}:MODE`);
            assert.equal(adjacent.overflowX, 0, `${scope}:${pathname}:OVERFLOW`);
            report.adjacentPages.push({ scope, pathname, ...adjacent });
          }
        }
        await context.close();
      }
    }
    assert.deepEqual(report.pageErrors, [], `PAGE_ERRORS:${JSON.stringify(report.pageErrors)}`);
    assert.deepEqual(report.consoleErrors, [], `CONSOLE_ERRORS:${JSON.stringify(report.consoleErrors)}`);
    assert.deepEqual(report.serverErrors, [], `SERVER_ERRORS:${JSON.stringify(report.serverErrors)}`);
    assert.deepEqual(report.reachedServerMutations, [], "SERVER_MUTATIONS");
    assert.deepEqual(report.paidRequests, [], "PAID_REQUESTS");
    assert.deepEqual(report.externalRequests, [], `EXTERNAL_REQUESTS:${JSON.stringify(report.externalRequests)}`);
    report.productionWrites = 0;
    report.businessWrites = 0;
    report.paidCalls = 0;
    report.passed = true;
    await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      passed: true,
      sourceVersion: report.runtime.sourceVersion,
      cases: report.cases.length,
      adjacentPages: report.adjacentPages.length,
      minContrast: Math.min(...report.cases.flatMap((entry) => Object.values(entry.intake.contrast))),
      paidCalls: 0,
      productionWrites: 0,
      reportPath: path.relative(process.cwd(), path.join(outputDir, "report.json")),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(async (error) => {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "failure.txt"), `${error?.stack || error}\n`, "utf8");
  console.error(error);
  process.exitCode = 1;
});
