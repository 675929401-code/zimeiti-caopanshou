#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installStoryboardBrowserFixture } from "./storyboard-browser-fixture.mjs";

const origin = process.env.BASE_URL || "http://127.0.0.1:5000";
const output = path.resolve(
  process.argv.find((value) => value.startsWith("--output="))?.slice(9)
    || ".codex-evidence/desktop-workbenches-ui/report.json",
);
const bundledChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const desktopViewports = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const desktopThemes = [
  { id: "lattice", mode: "dark" },
  { id: "soft-white", mode: "light" },
];

const report = {
  at: new Date().toISOString(),
  origin,
  themes: desktopThemes,
  storyboard: [],
  tools: [],
  video: [],
  toolboxLazyMount: null,
  protectedAliases: [],
  telemetryWrites: [],
  blockedWrites: [],
  pageErrors: [],
  httpErrors: [],
};

async function verifySourceContract() {
  const [badge, badgeCss, brand, storyboard, storyboardCss, video, tools, toolsCss, extractPage, formatterPage, segmenterPage, workbenchCss, softWhiteTheme, latticeTheme] = await Promise.all([
    readFile(path.resolve("src/components/model-badge.tsx"), "utf8"),
    readFile(path.resolve("src/components/model-badge.module.css"), "utf8"),
    readFile(path.resolve("src/lib/model-brand.ts"), "utf8"),
    readFile(path.resolve("src/components/storyboard-workbench.tsx"), "utf8"),
    readFile(path.resolve("src/app/storyboard-workbench/storyboard-workbench.css"), "utf8"),
    readFile(path.resolve("src/app/video/page.tsx"), "utf8"),
    readFile(path.resolve("src/app/tools/page.tsx"), "utf8"),
    readFile(path.resolve("src/app/tools/tools.module.css"), "utf8"),
    readFile(path.resolve("src/app/extract/page.tsx"), "utf8"),
    readFile(path.resolve("src/app/formatter/page.tsx"), "utf8"),
    readFile(path.resolve("src/app/segmenter/page.tsx"), "utf8"),
    readFile(path.resolve("src/app/vs-workbench.css"), "utf8"),
    readFile(path.resolve("src/app/theme-soft-white.css"), "utf8"),
    readFile(path.resolve("src/app/theme-lattice.css"), "utf8"),
  ]);

  assert.match(badge, /isModelAvatarImage\(avatar\)[\s\S]*?modelBrandAsset\(brand\)[\s\S]*?data-model-badge-source/,
    "ModelBadge 必须按头像、品牌、首字顺序回退并暴露来源");
  assert.match(badge, /data-selected=/, "ModelBadge 缺少选中态数据属性");
  assert.match(badge, /data-availability=/, "ModelBadge 缺少可用态数据属性");
  assert.match(badgeCss, /width:\s*44px[\s\S]*height:\s*44px/, "ModelBadge 视觉面积不是44px");
  assert.match(badgeCss, /\.image[\s\S]*width:\s*31px[\s\S]*height:\s*31px/, "ModelBadge 品牌图标占比不符合规范");
  assert.match(badgeCss, /html\[data-mode="dark"\]/, "ModelBadge 缺少深色主题对比度规则");
  assert.match(badgeCss, /html\[data-mode="dark"\][\s\S]*?\.badge\[data-selected="true"\]/,
    "ModelBadge 深色主题缺少明确选中反馈");
  assert.match(brand, /return "AI"/, "未知模型缺少稳定首字回退");
  assert.match(storyboard, /<ModelBadge[\s\S]*?avatarUrl=\{model\.avatarUrl\}/, "分镜模型没有使用共享徽章或头像源");
  assert.match(video, /<ModelBadge[\s\S]*?data-video-model-avatar="true"/, "视频模型没有使用共享徽章");
  assert.match(tools, /mountedPanels\.has\("extract"\)[\s\S]*mountedPanels\.has\("format"\)[\s\S]*mountedPanels\.has\("segment"\)/,
    "工具箱没有保持访问过的功能面板挂载");
  assert.match(tools, /onTabChange=\{selectTab\}/, "工具内部跳转没有统一回写工具箱URL");
  assert.match(toolsCss, /grid-template-columns:\s*312px minmax\(0, 1fr\)/, "工具箱左栏不是312px");
  assert.doesNotMatch(toolsCss, /linear-gradient|radial-gradient|backdrop-filter/iu,
    "工具箱仍含渐变或玻璃滤镜");
  assert.doesNotMatch(extractPage, /rgba\(139,\s*92,\s*246|#7c3aed/iu,
    "提取面板仍含脱离主题的紫色说明块");
  assert.doesNotMatch(segmenterPage, /color:\s*isActive\s*\?\s*["']#fff(?:fff)?["']/iu,
    "智能分段选中态仍硬编码白色文字");
  assert.doesNotMatch([extractPage, formatterPage, segmenterPage].join("\n"), /text-(?:red|green|emerald|amber|sky)-\d+/u,
    "工具状态文字仍使用脱离主题的固定色阶");
  assert.doesNotMatch(workbenchCss, /--primary-foreground:\s*#fff(?:fff)?/iu,
    "工作台仍把主操作文字强制为低对比白色");
  assert.match(storyboardCss, /data-status="done"[\s\S]*?var\(--success\)[\s\S]*?data-status="failed"[\s\S]*?var\(--error\)[\s\S]*?data-status="cancelled"[\s\S]*?var\(--warning\)/u,
    "分镜状态没有统一使用语义色变量");
  assert.doesNotMatch(softWhiteTheme, /#84adff/iu, "柔光白仍残留模型选中态饱和蓝边框");
  for (const [name, themeSource] of Object.entries({ softWhiteTheme, latticeTheme })) {
    assert.match(themeSource, /voice-studio-root[^,{]*:not\(:where\(\[data-testid="manju-content"\] \*\)\)/u,
      `${name} 没有隔离漫剧工作台的工作台主题桥`);
  }
  assert.match(toolsCss, /\[data-page="tools-utility"\][\s\S]*?\.tabs[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)[\s\S]*?flex:\s*none/u,
    "漫剧壳内旧工具入口没有恢复紧凑横向四工具栏");
  assert.match(storyboardCss, /\[data-testid="manju-content"\][\s\S]*?grid-template-columns:\s*248px minmax\(0, 1fr\)[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/u,
    "漫剧壳内分镜在1280宽度仍被双重侧栏和三列卡片挤压");
}

async function getDevSession() {
  const localAdminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  if (localAdminToken) {
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${localAdminToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    assert.ok(response.ok && body.user?.role === "admin", "本地管理员验收令牌不可用");
    return { token: localAdminToken, user: body.user };
  }
  const response = await fetch(`${origin}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  assert.ok(response.ok && body.token && body.user?.role === "admin", "本地管理员验收会话不可用");
  return body;
}

async function launchBrowser() {
  try {
    await access(bundledChromium);
    return chromium.launch({ headless: true, executablePath: bundledChromium });
  } catch {
    return chromium.launch({ headless: true });
  }
}

function attachPageDiagnostics(page, label) {
  page.on("pageerror", (error) => report.pageErrors.push({ label, message: String(error.message).slice(0, 400) }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) {
      report.httpErrors.push({ label, method: response.request().method(), path: url.pathname, status: response.status() });
    }
  });
}

async function waitForTheme(page, theme) {
  await page.waitForFunction(
    ({ id, mode }) => document.documentElement.dataset.theme === id
      && document.documentElement.dataset.mode === mode,
    theme,
    { timeout: 30_000 },
  );
}

function userForTheme(session, theme) {
  return { ...session.user, themePreference: theme.id, theme_preference: theme.id };
}

async function installThemeIdentityFixture(page, session, theme) {
  await page.route("**/api/auth/me**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET" || url.pathname !== "/api/auth/me") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: userForTheme(session, theme) }),
    });
  });
}

async function auditStoryboard(context, session, viewport, theme) {
  const page = await context.newPage();
  attachPageDiagnostics(page, `storyboard-${theme.id}-${viewport.width}`);
  await page.addInitScript((themeId) => localStorage.setItem("user_theme_preference", themeId), theme.id);
  const fixture = await installStoryboardBrowserFixture(page, {
    origin,
    token: session.token,
    user: userForTheme(session, theme),
  });
  await page.setViewportSize(viewport);
  await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await waitForTheme(page, theme);
  await page.locator(".sbw-shot-card").first().waitFor({ state: "visible", timeout: 45_000 });
  await page.locator("[data-model-badge]").first().waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForTimeout(400);

  const metrics = await page.evaluate(() => {
    const number = (value) => Number.parseFloat(String(value || "0")) || 0;
    const visible = (element) => {
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const font = (selector) => {
      const element = document.querySelector(selector);
      return element ? number(getComputedStyle(element).fontSize) : 0;
    };
    const workspace = document.querySelector(".sbw-workspace")?.getBoundingClientRect();
    const toolbarItems = [...document.querySelectorAll(".sbw-toolbar .sbw-ratio-control, .sbw-toolbar select, .sbw-toolbar .sbw-fixed-param, .sbw-toolbar-actions button")]
      .filter(visible)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      });
    const badges = [...document.querySelectorAll("[data-model-badge]")].filter(visible).map((element) => {
      const box = element.getBoundingClientRect();
      const image = element.querySelector("img");
      const imageBox = image?.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: box.width,
        height: box.height,
        imageWidth: imageBox?.width || 0,
        imageHeight: imageBox?.height || 0,
        hasImage: Boolean(image),
        imageComplete: image ? image.complete : true,
        naturalWidth: image?.naturalWidth || 0,
        naturalHeight: image?.naturalHeight || 0,
        source: element.getAttribute("data-model-badge-source"),
        selected: element.getAttribute("data-selected"),
        availability: element.getAttribute("data-availability"),
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
      };
    });
    const solidSurfaces = [...document.querySelectorAll(".sbw-image-frame, .sbw-video-frame, .sbw-toolbar-actions .sbw-batch-action")]
      .map((element) => getComputedStyle(element).backgroundImage);
    const imageCommand = document.querySelector(".sbw-media-actions button.is-image-command");
    const videoCommand = document.querySelector(".sbw-video-compact button.is-video-command, .sbw-media-actions button.is-video-command");
    const semanticProbe = document.createElement("span");
    semanticProbe.style.backgroundColor = "var(--primary)";
    semanticProbe.style.color = "var(--primary-foreground)";
    semanticProbe.style.position = "absolute";
    semanticProbe.style.pointerEvents = "none";
    document.body.appendChild(semanticProbe);
    const semanticProbeStyle = getComputedStyle(semanticProbe);
    const commandColors = [imageCommand, videoCommand].filter(Boolean).map((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        color: style.color,
        primaryForeground: style.getPropertyValue("--primary-foreground").trim(),
        ancestry: (() => {
          const chain = [];
          let current = element;
          while (current && chain.length < 10) {
            const currentStyle = getComputedStyle(current);
            chain.push({
              tag: current.tagName,
              className: current.className,
              theme: current.getAttribute("data-theme"),
              mode: current.getAttribute("data-mode"),
              primaryForeground: currentStyle.getPropertyValue("--primary-foreground").trim(),
            });
            current = current.parentElement;
          }
          return chain;
        })(),
      };
    });
    const rail = document.querySelector(".sbw-model-rail")?.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      railWidth: rail?.width || 0,
      cards: document.querySelectorAll(".sbw-shot-card").length,
      columns: getComputedStyle(document.querySelector(".sbw-shot-grid")).gridTemplateColumns.split(" ").length,
      fonts: {
        model: font(".sbw-model-name"),
        title: font(".sbw-card-title strong"),
        body: font(".sbw-flow-prompt textarea"),
        auxiliary: (() => {
          const values = [
            ".sbw-model-inline-meta",
            ".sbw-status-pair span",
            ".sbw-reference-toggle span",
            ".sbw-project-heading > small",
            ".sbw-zone-title > span:not(.sbw-stage-index)",
            ".sbw-bound-reference-line",
          ].map(font).filter((value) => value > 0);
          return values.length ? Math.min(...values) : 0;
        })(),
      },
      toolbarItems,
      toolbarContained: Boolean(workspace) && toolbarItems.every((item) => item.left >= workspace.left - 1 && item.right <= workspace.right + 1),
      badges,
      solidSurfaces,
      commandColors,
      semanticCommandColors: {
        background: semanticProbeStyle.backgroundColor,
        color: semanticProbeStyle.color,
        primaryForeground: semanticProbeStyle.getPropertyValue("--primary-foreground").trim(),
      },
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
    };
  });

  assert.deepEqual({ theme: metrics.theme, mode: metrics.mode }, { theme: theme.id, mode: theme.mode }, `${viewport.width}px 分镜主题没有按设置生效`);
  assert.ok(metrics.railWidth >= 311 && metrics.railWidth <= 313, `${viewport.width}px 分镜左栏不是312px`);
  assert.equal(metrics.cards, 3, `${viewport.width}px 分镜默认卡片数量不是3张`);
  assert.equal(metrics.columns, 3, `${viewport.width}px 分镜默认不是每行3张卡片`);
  assert.ok(metrics.fonts.model >= 14 && metrics.fonts.title >= 14, `${viewport.width}px 分镜标题层级小于14px`);
  assert.ok(metrics.fonts.body >= 13 && metrics.fonts.auxiliary >= 12, `${viewport.width}px 分镜正文或辅助文字小于13/12px`);
  assert.ok(metrics.toolbarItems.length >= 4 && metrics.toolbarContained, `${viewport.width}px 分镜参数没有完整留在工作区内`);
  assert.ok(metrics.badges.length > 0 && metrics.badges.every((badge) => badge.width >= 42 && badge.width <= 44 && badge.height >= 42 && badge.height <= 44), `${viewport.width}px 分镜模型徽章尺寸错误`);
  assert.ok(metrics.badges.every((badge) => ["avatar", "brand", "generic", "initial"].includes(badge.source) && ["true", "false"].includes(badge.selected) && ["ready", "unavailable"].includes(badge.availability)), `${viewport.width}px 分镜模型徽章状态不可审计`);
  assert.ok(metrics.badges.every((badge) => badge.source === "initial"
    ? !badge.hasImage
    : badge.hasImage && badge.imageComplete && badge.naturalWidth > 0 && badge.naturalHeight > 0),
  `${viewport.width}px 分镜模型徽章图片未成功解码`);
  const selectedBadge = metrics.badges.find((badge) => badge.selected === "true");
  const unselectedBadge = metrics.badges.find((badge) => badge.selected === "false");
  if (selectedBadge && unselectedBadge) {
    assert.notDeepEqual(
      { borderColor: selectedBadge.borderColor, boxShadow: selectedBadge.boxShadow },
      { borderColor: unselectedBadge.borderColor, boxShadow: unselectedBadge.boxShadow },
      `${viewport.width}px 分镜模型选中态不可辨识`,
    );
  }
  assert.ok(metrics.solidSurfaces.length > 0 && metrics.solidSurfaces.every((value) => value === "none"), `${viewport.width}px 分镜核心区仍使用彩色渐变`);
  assert.equal(metrics.commandColors.length, 2, `${viewport.width}px 分镜图像或视频主操作缺失`);
  assert.ok(metrics.commandColors.every((entry) => entry.background === metrics.commandColors[0].background && entry.color === metrics.commandColors[0].color), `${viewport.width}px 分镜图像与视频主操作没有使用同一语义色`);
  assert.ok(metrics.commandColors.every((entry) => entry.background === metrics.semanticCommandColors.background && entry.color === metrics.semanticCommandColors.color), `${viewport.width}px 分镜主操作没有使用主题 primary/primary-foreground 计算色：${JSON.stringify({ commandColors: metrics.commandColors, semanticCommandColors: metrics.semanticCommandColors })}`);
  assert.equal(metrics.overflow, false, `${viewport.width}px 分镜工作台发生横向溢出`);
  await page.screenshot({ path: path.join(path.dirname(output), `storyboard-${theme.id}-${viewport.width}.png`), fullPage: false });
  await page.close();
  return { expectedTheme: theme, viewport, ...metrics, inMemoryProjectWrites: fixture.projectWrites.length };
}

async function selectToolTab(page, tab) {
  await page.getByRole("tab", { name: new RegExp(tab.label, "u") }).click();
  await page.waitForFunction((id) => new URL(location.href).searchParams.get("tab") === id, tab.id);
}

async function auditTools(context, session, viewport, theme) {
  const page = await context.newPage();
  attachPageDiagnostics(page, `tools-${theme.id}-${viewport.width}`);
  await installThemeIdentityFixture(page, session, theme);
  await page.addInitScript((themeId) => localStorage.setItem("user_theme_preference", themeId), theme.id);
  await page.setViewportSize(viewport);
  await page.goto(`${origin}/tools?tab=text`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await waitForTheme(page, theme);
  await page.getByRole("tablist", { name: "工具箱功能" }).waitFor({ state: "visible", timeout: 45_000 });
  await page.locator("#tool-panel-extract").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']").waitFor({ state: "visible", timeout: 45_000 });

  const metrics = await page.evaluate(() => {
    const rail = document.querySelector("aside[aria-label='工具功能']")?.getBoundingClientRect();
    const frame = document.querySelector("main section[aria-label='短视频效率工具工作区']");
    const stage = document.querySelector("section[aria-label='短视频效率工具工作区'] > section");
    const headerTitle = document.querySelector(".sub-page-title") || stage?.querySelector(".toolbox-extract-heading h3");
    const state = document.querySelector(".toolbox-embedded-toolbar p + p") || document.querySelector("[role='status']");
    return {
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      railWidth: rail?.width || 0,
      tabs: document.querySelectorAll("[role='tab']").length,
      orientation: document.querySelector("[role='tablist']")?.getAttribute("aria-orientation"),
      titleFont: headerTitle ? Number.parseFloat(getComputedStyle(headerTitle).fontSize) : 0,
      stateFont: state ? Number.parseFloat(getComputedStyle(state).fontSize) : 0,
      frameBackgroundImage: frame ? getComputedStyle(frame).backgroundImage : "",
      railBackgroundImage: rail ? getComputedStyle(document.querySelector("aside[aria-label='工具功能']")).backgroundImage : "",
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
    };
  });
  assert.deepEqual({ theme: metrics.theme, mode: metrics.mode }, { theme: theme.id, mode: theme.mode }, `${viewport.width}px 工具箱主题没有按设置生效`);
  assert.ok(metrics.railWidth >= 311 && metrics.railWidth <= 313, `${viewport.width}px 工具箱左栏不是312px`);
  assert.equal(metrics.tabs, 4, `${viewport.width}px 工具箱不是4项纵向功能`);
  assert.equal(metrics.orientation, "vertical", `${viewport.width}px 工具箱功能导航不是纵向语义`);
  assert.ok(metrics.titleFont >= 18 && metrics.stateFont >= 12, `${viewport.width}px 工具箱标题或状态文字过小`);
  assert.ok(["none", ""].includes(metrics.frameBackgroundImage) && ["none", ""].includes(metrics.railBackgroundImage), `${viewport.width}px 工具箱仍有渐变背景`);
  assert.equal(metrics.overflow, false, `${viewport.width}px 工具箱发生横向溢出`);

  let persistence = null;
  if (viewport.width === 1440) {
    const values = {
      text: "桌面状态保留：文案提取",
      video: "桌面状态保留：https://v.douyin.com/test/",
      format: "桌面状态保留：文字排版",
      segment: "桌面状态保留：智能分段",
    };
    await page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']").fill(values.text);
    await selectToolTab(page, { id: "video", label: "视频提取" });
    await page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或视频链接']").fill(values.video);
    await selectToolTab(page, { id: "format", label: "文字排版" });
    await page.locator("#tool-panel-format textarea[placeholder*='需要排版的文案']").fill(values.format);
    await selectToolTab(page, { id: "segment", label: "智能分段" });
    await page.locator("#tool-panel-segment textarea[placeholder*='需要分段的文案内容']").fill(values.segment);

    const hiddenSegmentWritesBefore = report.blockedWrites.filter((item) => item.path === "/api/segmenter/history").length;
    await selectToolTab(page, { id: "text", label: "文案提取" });
    const textInput = page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']");
    await textInput.fill("");
    await textInput.press("Control+Enter");
    await page.waitForTimeout(250);
    const hiddenSegmentWritesAfter = report.blockedWrites.filter((item) => item.path === "/api/segmenter/history").length;
    assert.equal(hiddenSegmentWritesAfter, hiddenSegmentWritesBefore,
      "隐藏的智能分段面板响应了文案提取区快捷键");
    await textInput.fill(values.text);

    for (const tab of [
      { id: "text", label: "文案提取", selector: "#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']", value: values.text },
      { id: "video", label: "视频提取", selector: "#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或视频链接']", value: values.video },
      { id: "format", label: "文字排版", selector: "#tool-panel-format textarea[placeholder*='需要排版的文案']", value: values.format },
      { id: "segment", label: "智能分段", selector: "#tool-panel-segment textarea[placeholder*='需要分段的文案内容']", value: values.segment },
    ]) {
      await selectToolTab(page, tab);
      assert.equal(await page.locator(tab.selector).inputValue(), tab.value, `${tab.label}切换后丢失会话状态`);
    }
    persistence = await page.evaluate(() => {
      const panels = ["tool-panel-extract", "tool-panel-format", "tool-panel-segment"]
        .map((id) => document.getElementById(id))
        .filter(Boolean);
      return {
        mountedPanels: panels.map((panel) => panel.id),
        visiblePanels: panels.filter((panel) => !panel.hidden).map((panel) => panel.id),
        storedTab: localStorage.getItem("toolbox_active_tab"),
        urlTab: new URL(location.href).searchParams.get("tab"),
        embeddedEffects: [...document.querySelectorAll(".toolbox-input-surface, .toolbox-results-block")].map((element) => {
          const style = getComputedStyle(element);
          return { backdropFilter: style.backdropFilter, backgroundImage: style.backgroundImage };
        }),
      };
    });
    assert.deepEqual(new Set(persistence.mountedPanels), new Set(["tool-panel-extract", "tool-panel-format", "tool-panel-segment"]), "访问过的工具面板没有保持挂载");
    assert.deepEqual(persistence.visiblePanels, ["tool-panel-segment"], "工具箱同时显示了多个工作区");
    assert.equal(persistence.storedTab, "segment", "工具箱未记录最后访问功能");
    assert.equal(persistence.urlTab, "segment", "工具箱URL未与内部功能同步");
    assert.ok(
      persistence.embeddedEffects.every((effect) => ["none", ""].includes(effect.backdropFilter) && ["none", ""].includes(effect.backgroundImage)),
      `工具箱内嵌工作区仍使用玻璃模糊或渐变：${JSON.stringify(persistence.embeddedEffects)}`,
    );
    await page.goto(`${origin}/tools`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitForTheme(page, theme);
    await page.waitForFunction(() => new URL(location.href).searchParams.get("tab") === "segment");
    await page.getByRole("tab", { name: /智能分段/u, selected: true }).waitFor({ state: "visible", timeout: 30_000 });
    persistence.reopenedTab = new URL(page.url()).searchParams.get("tab");
  }

  if (viewport.width !== 1440) {
    await selectToolTab(page, { id: "segment", label: "智能分段" });
    await page.locator("#tool-panel-segment textarea[placeholder*='需要分段的文案内容']")
      .waitFor({ state: "visible", timeout: 30_000 });
  }
  const emptyResult = page.locator("#tool-panel-segment .toolbox-empty-result");
  await emptyResult.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const element = document.querySelector("#tool-panel-segment .toolbox-empty-result");
    return element && getComputedStyle(element).opacity === "1";
  });
  const segmentVisual = await page.evaluate(() => {
    const toolbar = document.querySelector("#tool-panel-segment .toolbox-embedded-toolbar");
    const scroller = toolbar?.querySelector(".toolbox-duration-options");
    const action = toolbar?.querySelector(".toolbox-toolbar-action");
    const toolbarRect = toolbar?.getBoundingClientRect();
    const actionRect = action?.getBoundingClientRect();
    const chips = [...(scroller?.querySelectorAll(".toolbox-duration-chip") || [])];
    const empty = document.querySelector("#tool-panel-segment .toolbox-empty-result");
    const emptyHeading = empty?.querySelector("h3");
    const emptyParagraph = empty?.querySelector("p");
    const emptyStyle = empty ? getComputedStyle(empty) : null;
    return {
      chipLabels: chips.map((chip) => (chip.textContent || "").replace(/\s+/gu, "").trim()),
      chipsFullyVisible: Boolean(toolbarRect) && chips.every((chip) => {
        const rect = chip.getBoundingClientRect();
        return rect.left >= toolbarRect.left - 1
          && rect.right <= toolbarRect.right + 1
          && rect.top >= toolbarRect.top - 1
          && rect.bottom <= toolbarRect.bottom + 1;
      }),
      chipsClearAction: chips.every((chip) => {
        if (!actionRect) return false;
        const rect = chip.getBoundingClientRect();
        return rect.right <= actionRect.left - 1 || rect.bottom <= actionRect.top || rect.top >= actionRect.bottom;
      }),
      toolbarScrollOverflow: scroller ? scroller.scrollWidth - scroller.clientWidth : -1,
      toolbarHeight: toolbarRect?.height || 0,
      emptyOpacity: emptyStyle?.opacity || "",
      emptyAnimationName: emptyStyle?.animationName || "",
      emptyHeadingColor: emptyHeading ? getComputedStyle(emptyHeading).color : "",
      emptyParagraphColor: emptyParagraph ? getComputedStyle(emptyParagraph).color : "",
    };
  });
  assert.equal(segmentVisual.chipLabels.length, 7, `${viewport.width}px 智能分段时长预设数量不完整`);
  assert.equal(segmentVisual.chipsFullyVisible, true,
    `${viewport.width}px 智能分段时长预设仍有裁切：${JSON.stringify(segmentVisual)}`);
  assert.equal(segmentVisual.chipsClearAction, true,
    `${viewport.width}px 智能分段时长预设与历史按钮重叠：${JSON.stringify(segmentVisual)}`);
  assert.ok(segmentVisual.toolbarScrollOverflow <= 1,
    `${viewport.width}px 智能分段时长预设仍依赖隐藏横向滚动：${JSON.stringify(segmentVisual)}`);
  assert.ok(segmentVisual.toolbarHeight <= 66,
    `${viewport.width}px 智能分段时长工具条仍然过高：${JSON.stringify(segmentVisual)}`);
  assert.equal(segmentVisual.emptyOpacity, "1", `${viewport.width}px 智能分段空结果态首帧不可读`);
  assert.equal(segmentVisual.emptyAnimationName, "none", `${viewport.width}px 智能分段空结果态仍被淡入动画压低可读性`);
  assert.ok(segmentVisual.emptyHeadingColor && segmentVisual.emptyParagraphColor,
    `${viewport.width}px 智能分段空结果态文字颜色未生效`);

  await page.screenshot({ path: path.join(path.dirname(output), `tools-${theme.id}-${viewport.width}.png`), fullPage: false });
  await page.close();
  return { expectedTheme: theme, viewport, ...metrics, persistence, segmentVisual };
}

async function auditVideo(context, session, viewport, theme) {
  const page = await context.newPage();
  attachPageDiagnostics(page, `video-${theme.id}-${viewport.width}`);
  await installThemeIdentityFixture(page, session, theme);
  await page.addInitScript((themeId) => localStorage.setItem("user_theme_preference", themeId), theme.id);
  await page.setViewportSize(viewport);
  await page.goto(`${origin}/video`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await waitForTheme(page, theme);
  await page.locator("[data-video-model-list]").waitFor({ state: "visible", timeout: 45_000 });
  await page.locator("[data-video-model-id]").first().waitFor({ state: "visible", timeout: 45_000 });
  await page.locator("[data-video-model-avatar='true']").first().waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForTimeout(300);

  const metrics = await page.evaluate(() => {
    const rail = document.querySelector("[data-video-model-list]")?.getBoundingClientRect();
    const cards = [...document.querySelectorAll("[data-video-model-id]")];
    const badges = [...document.querySelectorAll("[data-video-model-avatar='true']")].map((element) => {
      const box = element.getBoundingClientRect();
      const image = element.querySelector("img");
      const style = getComputedStyle(element);
      return {
        width: box.width,
        height: box.height,
        hasImage: Boolean(image),
        imageComplete: image ? image.complete : true,
        naturalWidth: image?.naturalWidth || 0,
        naturalHeight: image?.naturalHeight || 0,
        source: element.getAttribute("data-model-badge-source"),
        selected: element.getAttribute("data-selected"),
        availability: element.getAttribute("data-availability"),
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
      };
    });
    const firstContent = cards[0]?.querySelector(":scope > span > span:nth-child(2)");
    const name = firstContent?.querySelector(":scope > span:nth-child(1)");
    const state = firstContent?.querySelector(":scope > span:nth-child(2)");
    const hint = firstContent?.querySelector(":scope > span:nth-child(3)");
    const oldMode = document.documentElement.dataset.mode;
    const badge = document.querySelector("[data-video-model-avatar='true']");
    const themes = ["light", "dark"].map((mode) => {
      document.documentElement.dataset.mode = mode;
      const style = getComputedStyle(badge);
      return { mode, background: style.backgroundColor, border: style.borderColor, opacity: style.opacity };
    });
    if (oldMode) document.documentElement.dataset.mode = oldMode;
    else delete document.documentElement.dataset.mode;
    return {
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      railWidth: rail?.width || 0,
      cards: cards.length,
      cardMinHeight: Math.min(...cards.map((card) => card.getBoundingClientRect().height)),
      fonts: {
        name: name ? Number.parseFloat(getComputedStyle(name).fontSize) : 0,
        state: state ? Number.parseFloat(getComputedStyle(state).fontSize) : 0,
        hint: hint ? Number.parseFloat(getComputedStyle(hint).fontSize) : 0,
      },
      badges,
      themes,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
    };
  });

  assert.deepEqual({ theme: metrics.theme, mode: metrics.mode }, { theme: theme.id, mode: theme.mode }, `${viewport.width}px 视频工作台主题没有按设置生效`);
  assert.ok(metrics.railWidth >= 311 && metrics.railWidth <= 313, `${viewport.width}px 视频模型栏不是312px`);
  assert.ok(metrics.cards > 0 && metrics.cardMinHeight >= 76, `${viewport.width}px 视频模型卡片未加载或过密`);
  assert.ok(metrics.fonts.name >= 14 && metrics.fonts.state >= 12 && metrics.fonts.hint >= 12, `${viewport.width}px 视频模型文字小于14/12px`);
  assert.equal(metrics.badges.length, metrics.cards, `${viewport.width}px 视频模型徽章数量不完整`);
  assert.ok(metrics.badges.every((badge) => badge.width >= 42 && badge.width <= 44 && badge.height >= 42 && badge.height <= 44), `${viewport.width}px 视频模型徽章尺寸错误`);
  assert.ok(metrics.badges.every((badge) => ["avatar", "brand", "generic", "initial"].includes(badge.source) && ["true", "false"].includes(badge.selected) && ["ready", "unavailable"].includes(badge.availability)), `${viewport.width}px 视频模型徽章来源或状态不可审计`);
  assert.ok(metrics.badges.every((badge) => badge.source === "initial"
    ? !badge.hasImage
    : badge.hasImage && badge.imageComplete && badge.naturalWidth > 0 && badge.naturalHeight > 0),
  `${viewport.width}px 视频模型徽章图片未成功解码`);
  const selectedBadge = metrics.badges.find((badge) => badge.selected === "true");
  const unselectedBadge = metrics.badges.find((badge) => badge.selected === "false");
  if (selectedBadge && unselectedBadge) {
    assert.notDeepEqual(
      { borderColor: selectedBadge.borderColor, boxShadow: selectedBadge.boxShadow },
      { borderColor: unselectedBadge.borderColor, boxShadow: unselectedBadge.boxShadow },
      `${viewport.width}px 视频模型选中态不可辨识`,
    );
  }
  assert.ok(metrics.themes.every((theme) => !["rgba(0, 0, 0, 0)", "transparent", ""].includes(theme.background) && theme.border !== theme.background), `${viewport.width}px 模型徽章在深浅主题中缺少可辨边界`);
  assert.equal(metrics.overflow, false, `${viewport.width}px 视频制作工作台发生横向溢出`);
  await page.screenshot({ path: path.join(path.dirname(output), `video-${theme.id}-${viewport.width}.png`), fullPage: false });
  await page.close();
  return { expectedTheme: theme, viewport, ...metrics };
}

async function auditToolboxLazyMount(context) {
  const page = await context.newPage();
  attachPageDiagnostics(page, "tools-lazy-mount");
  const extractReads = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.origin === origin && url.pathname.startsWith("/api/extract")) {
      extractReads.push(url.pathname);
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("user_theme_preference", "lattice");
    localStorage.setItem("toolbox_active_tab", "format");
    localStorage.removeItem("toolbox_active_tab_ready");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/tools`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByRole("tab", { name: /文案提取/u, selected: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(250);
  assert.equal(new URL(page.url()).searchParams.get("tab"), "text", "效率工具无 tab 入口必须规范化到文案提取");
  assert.notEqual(await page.evaluate(() => localStorage.getItem("toolbox_active_tab")), "text", "默认入口不得依赖或改写历史 tab");

  const formatValue = "延迟挂载回归：文字排版";
  const textValue = "延迟挂载回归：文案提取";
  await page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']").fill(textValue);
  await page.getByRole("tab", { name: /文字排版/u }).click();
  await page.locator("#tool-panel-format textarea[placeholder*='需要排版的文案']").fill(formatValue);
  assert.equal(await page.locator("#tool-panel-format textarea[placeholder*='需要排版的文案']").inputValue(), formatValue, "延迟挂载后文字排版状态丢失");
  await page.getByRole("tab", { name: /文案提取/u }).click();
  assert.equal(await page.locator("#tool-panel-extract textarea[placeholder*='粘贴完整分享文本或链接']").inputValue(), textValue, "延迟挂载后文案提取状态丢失");
  await page.close();
  return { initialTab: "format", extractPanelInitiallyMounted: false, initialExtractReads: extractReads.length, statePreserved: true };
}

async function auditManjuAliases(context, session, theme) {
  const viewport = { width: 1280, height: 800 };
  const storyboardPage = await context.newPage();
  attachPageDiagnostics(storyboardPage, `manju-storyboard-${theme.id}`);
  await storyboardPage.addInitScript((themeId) => localStorage.setItem("user_theme_preference", themeId), theme.id);
  await installStoryboardBrowserFixture(storyboardPage, { origin, token: session.token, user: userForTheme(session, theme) });
  await storyboardPage.setViewportSize(viewport);
  await storyboardPage.goto(`${origin}/youcai/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await storyboardPage.locator(".sbw-shot-card").first().waitFor({ state: "visible", timeout: 45_000 });
  const storyboard = await storyboardPage.evaluate(() => ({
    manjuRoot: Boolean(document.querySelector('[data-testid="manju-content"]')),
    railWidth: document.querySelector(".sbw-model-rail")?.getBoundingClientRect().width || 0,
    columns: getComputedStyle(document.querySelector(".sbw-shot-grid")).gridTemplateColumns.split(" ").length,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
  }));
  assert.equal(storyboard.manjuRoot, true, "漫剧分镜别名未保留独立应用壳");
  assert.ok(storyboard.railWidth >= 247 && storyboard.railWidth <= 249, `漫剧分镜1280嵌套模型栏不是248px：${storyboard.railWidth}`);
  assert.equal(storyboard.columns, 2, "漫剧分镜1280仍被强制为不可用三列");
  assert.equal(storyboard.overflow, false, "漫剧分镜别名发生横向溢出");
  await storyboardPage.screenshot({ path: path.join(path.dirname(output), `manju-storyboard-${theme.id}-1280.png`), fullPage: false });
  await storyboardPage.close();

  const utilityPage = await context.newPage();
  attachPageDiagnostics(utilityPage, `manju-tools-${theme.id}`);
  await installThemeIdentityFixture(utilityPage, session, theme);
  await utilityPage.addInitScript((themeId) => localStorage.setItem("user_theme_preference", themeId), theme.id);
  await utilityPage.setViewportSize(viewport);
  await utilityPage.goto(`${origin}/youcai/tools/utility?tab=text`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const tablist = utilityPage.getByRole("tablist", { name: "工具箱功能" });
  await tablist.waitFor({ state: "visible", timeout: 45_000 });
  await utilityPage.locator("#toolbox-active-panel textarea:visible").first().waitFor({ state: "visible", timeout: 45_000 });
  const utility = await utilityPage.evaluate(() => {
    const tabs = [...document.querySelectorAll('[data-page="tools-utility"] [role="tab"]')];
    const tabTops = tabs.map((tab) => Math.round(tab.getBoundingClientRect().top));
    const tablistElement = document.querySelector('[data-page="tools-utility"] [role="tablist"]');
    return {
      manjuRoot: Boolean(document.querySelector('[data-testid="manju-content"]')),
      tabs: tabs.length,
      tabRows: new Set(tabTops).size,
      tablistDisplay: tablistElement ? getComputedStyle(tablistElement).display : "",
      tablistFlexGrow: tablistElement ? getComputedStyle(tablistElement).flexGrow : "",
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
    };
  });
  assert.equal(utility.manjuRoot, true, "漫剧工具别名未保留独立应用壳");
  assert.equal(utility.tabs, 4, "漫剧工具别名缺少四项工具");
  assert.equal(utility.tabRows, 1, "漫剧工具别名没有恢复单行工具栏");
  assert.equal(utility.tablistDisplay, "grid", "漫剧工具别名仍使用挤压工作区的纵向工具栏");
  assert.equal(utility.tablistFlexGrow, "0", "漫剧工具别名的工具栏仍吞占工作区高度");
  assert.equal(utility.overflow, false, "漫剧工具别名发生横向溢出");
  await utilityPage.screenshot({ path: path.join(path.dirname(output), `manju-tools-${theme.id}-1280.png`), fullPage: false });
  await utilityPage.close();
  return { expectedTheme: theme, viewport, storyboard, utility };
}

await verifySourceContract();
if (process.argv.includes("--source-only")) {
  console.log("[desktop-workbenches-ui] source contract passed; runtime browser audit intentionally skipped.");
  process.exit(0);
}
const session = await getDevSession();
await mkdir(path.dirname(output), { recursive: true });
const browser = await launchBrowser();
const context = await browser.newContext({ serviceWorkers: "block" });
await context.addCookies([{ name: "auth_token", value: session.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
await context.addInitScript(({ expectedOrigin, token, user }) => {
  if (location.origin !== expectedOrigin) return;
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_user", JSON.stringify(user));
  sessionStorage.setItem("entered_app", "1");
}, { expectedOrigin: origin, token: session.token, user: session.user });

await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === origin && request.method() === "GET" && url.pathname === "/api/video/active-tasks") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeTasks: [] }) });
  }
  const passiveTelemetryPath = url.origin === origin
    && request.method() === "POST"
    && ["/api/product-usage/events", "/api/operation-events", "/api/diagnostic-logs"].includes(url.pathname);
  if (passiveTelemetryPath) {
    report.telemetryWrites.push({ method: request.method(), path: url.pathname });
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ code: "LOCAL_ACCEPTANCE_TELEMETRY", receivedCount: 0, path: url.pathname }),
    });
  }
  if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue();
  report.blockedWrites.push({ method: request.method(), path: url.pathname });
  return route.abort("blockedbyclient");
});

try {
  for (const theme of desktopThemes) {
    for (const viewport of desktopViewports) report.storyboard.push(await auditStoryboard(context, session, viewport, theme));
    for (const viewport of desktopViewports) report.tools.push(await auditTools(context, session, viewport, theme));
    for (const viewport of desktopViewports) report.video.push(await auditVideo(context, session, viewport, theme));
    report.protectedAliases.push(await auditManjuAliases(context, session, theme));
  }
  report.toolboxLazyMount = await auditToolboxLazyMount(context);
  assert.equal(report.pageErrors.length, 0, `桌面工作台存在页面脚本错误：${JSON.stringify(report.pageErrors)}`);
  assert.equal(report.httpErrors.length, 0, `桌面工作台存在同源 HTTP 错误：${JSON.stringify(report.httpErrors)}`);
  assert.deepEqual(report.blockedWrites, [],
    `验收过程触发了写请求：${JSON.stringify(report.blockedWrites)}`);
  report.attemptedBlockedWrites = report.blockedWrites.length;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.stack || error.message : String(error);
  throw error;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2), "utf8");
  await context.close();
  await browser.close();
}

console.log(JSON.stringify({
  passed: report.passed,
  storyboardViewports: report.storyboard.map((item) => `${item.expectedTheme.id}:${item.viewport.width}`),
  toolsViewports: report.tools.map((item) => `${item.expectedTheme.id}:${item.viewport.width}`),
  videoViewports: report.video.map((item) => `${item.expectedTheme.id}:${item.viewport.width}`),
  telemetryWrites: report.telemetryWrites.length,
  blockedWrites: report.blockedWrites.length,
  evidence: output,
}, null, 2));
