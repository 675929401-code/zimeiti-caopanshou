import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const softWhiteHeroPhrases = ["推进到完整成片", "沉淀为可用资产", "让内容持续生长"];
const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", "home-content-quality-20260930", runStamp);
const themes = [
  { id: "lattice", label: "深空晶", colorScheme: "dark", mode: "dark" },
  { id: "soft-white", label: "柔光白", colorScheme: "light", mode: "light" },
  { id: "crystal-aurora", label: "黑曜霓彩", colorScheme: "dark", mode: "dark" },
];
const viewports = [
  { width: 1440, height: 900, name: "1440x900" },
  { width: 1920, height: 1080, name: "1920x1080" },
];
const sections = ["swh-value", "swh-production", "swh-capabilities", "swh-business", "swh-contact"];

async function samplePage(page) {
  return page.evaluate(() => {
    const home = document.querySelector(".soft-white-home[data-landing-version='v2']");
    const hero = home?.querySelector(".swh-hero");
    const titleLines = [...(hero?.querySelectorAll(".swh-title-line") || [])].map((node) => (
      node.getAttribute("data-full-text") || (node.textContent || "").trim()
    ));
    const lead = (hero?.querySelector(".swh-lead")?.textContent || "").replace(/\s+/gu, " ").trim();
    const textNodes = [...(home?.querySelectorAll("h1,h2,h3,p,li,dd,button,strong,small,span") || [])]
      .filter((node) => (
        (node.textContent || "").trim()
        && !node.matches(".sr-only,[aria-hidden='true']")
        && getComputedStyle(node).display !== "none"
      ));
    const fontSizes = textNodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)).filter(Number.isFinite);
    const clippedText = textNodes.filter((node) => {
      const element = node;
      const style = getComputedStyle(element);
      if (style.overflow === "visible" && style.textOverflow !== "ellipsis") return false;
      return element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2;
    }).map((node) => (node.textContent || "").trim().slice(0, 80));
    const heroStyle = hero ? getComputedStyle(hero) : null;
    const sectionNodes = [...(home?.querySelectorAll(".swh-section") || [])];
    const sectionPaddings = sectionNodes.map((node) => {
      const style = getComputedStyle(node);
      return { id: node.id, top: Number.parseFloat(style.paddingTop), bottom: Number.parseFloat(style.paddingBottom) };
    });
    const motionSelectors = [
      ".swh-aura-one",
      ".swh-signal-orbit-one",
      ".swh-signal-orbit-two",
      ".swh-signal-beacons",
      ".swh-factory-ring-one",
      ".swh-card-beam",
    ];
    return {
      theme: document.documentElement.dataset.theme || "",
      themeSelection: document.documentElement.dataset.themeSelection || "",
      mode: document.documentElement.dataset.mode || "",
      viewport: { width: innerWidth, height: innerHeight },
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      homeOverflowX: home ? home.scrollWidth - home.clientWidth : null,
      titleLines,
      leadLength: lead.length,
      heroActions: hero?.querySelectorAll(".swh-hero-actions button").length || 0,
      facts: hero?.querySelectorAll(".swh-facts > div").length || 0,
      exampleSteps: home?.querySelectorAll(".swh-project-example > li").length || 0,
      exampleOutcomes: home?.querySelectorAll(".swh-example-outcome").length || 0,
      modules: home?.querySelectorAll(".swh-module-rail-items > span").length || 0,
      valueCards: home?.querySelectorAll(".swh-value-grid > article").length || 0,
      productionCards: home?.querySelectorAll(".swh-production-grid > article").length || 0,
      availableCapabilities: home?.querySelectorAll(".swh-available-grid > article").length || 0,
      plannedCapabilities: home?.querySelectorAll(".swh-planned li").length || 0,
      businessCards: home?.querySelectorAll(".swh-business-grid > article").length || 0,
      sectionHeadings: [...(home?.querySelectorAll(".swh-section-heading h2") || [])].map((node) => (node.textContent || "").trim()),
      minimumFontSize: fontSizes.length ? Math.min(...fontSizes) : 0,
      clippedText,
      heroLayout: {
        columns: heroStyle?.gridTemplateColumns || "",
        gap: Number.parseFloat(heroStyle?.columnGap || "0"),
        paddingTop: Number.parseFloat(heroStyle?.paddingTop || "0"),
        paddingBottom: Number.parseFloat(heroStyle?.paddingBottom || "0"),
      },
      sectionPaddings,
      revealTargets: home?.querySelectorAll("[data-swh-reveal]").length || 0,
      revealedTargets: home?.querySelectorAll("[data-swh-reveal].is-visible").length || 0,
      pointerNetworkPresent: Boolean(home?.querySelector("[data-testid='swh-pointer-network']")),
      pointerMotion: home?.hasAttribute("data-pointer-motion") || false,
      pointerX: getComputedStyle(home).getPropertyValue("--swh-pointer-x").trim(),
      pointerY: getComputedStyle(home).getPropertyValue("--swh-pointer-y").trim(),
      panelCount: home?.querySelectorAll("[data-swh-panel]").length || 0,
      orbitCount: home?.querySelectorAll(".swh-signal-orbit").length || 0,
      typewriterPresent: Boolean(home?.querySelector("[data-testid='swh-typewriter'][data-full-text]")),
      contactPresent: Boolean(home?.querySelector("#swh-contact .swh-contact-visual")),
      motion: Object.fromEntries(motionSelectors.map((selector) => {
        const node = home?.querySelector(selector);
        const style = node ? getComputedStyle(node) : null;
        return [selector, { present: Boolean(node), animationName: style?.animationName || "", transform: style?.transform || "" }];
      })),
      contentLength: (home?.textContent || "").replace(/\s+/gu, " ").trim().length,
    };
  });
}

function assertPage(sample, theme) {
  assert.equal(sample.theme, theme.id, `${theme.id}:THEME_MISMATCH`);
  assert.equal(sample.themeSelection, theme.id, `${theme.id}:THEME_SELECTION_MISMATCH`);
  assert.equal(sample.mode, theme.mode, `${theme.id}:MODE_MISMATCH`);
  assert.equal(sample.overflowX, 0, `${theme.id}:DOCUMENT_HORIZONTAL_OVERFLOW`);
  assert.equal(sample.homeOverflowX, 0, `${theme.id}:HOME_HORIZONTAL_OVERFLOW`);
  assert.equal(sample.titleLines[0], "把一个内容想法");
  assert.ok(["推进到完整成片", "沉淀为可用资产", "让内容持续生长"].includes(sample.titleLines[1]), `${theme.id}:TYPEWRITER_PHRASE_INVALID`);
  assert.ok(sample.leadLength >= 45 && sample.leadLength <= 110, `${theme.id}:HERO_LEAD_DENSITY`);
  assert.equal(sample.heroActions, 2);
  assert.equal(sample.facts, 3);
  assert.equal(sample.exampleSteps, 3);
  assert.equal(sample.exampleOutcomes, 3);
  assert.equal(sample.modules, 7);
  assert.equal(sample.valueCards, 6);
  assert.equal(sample.productionCards, 3);
  assert.equal(sample.availableCapabilities, 4);
  assert.equal(sample.plannedCapabilities, 4);
  assert.equal(sample.businessCards, 2);
  assert.deepEqual(sample.sectionHeadings, [
    "少一点重复开工，多一点持续产出",
    "选对呈现方式，再把每一步做到位",
    "真正有用的 AI，不只回答，还要接住下一步",
    "从持续表达，到用内容经营生意",
  ]);
  assert.ok(sample.contentLength >= 900 && sample.contentLength <= 2_400, `${theme.id}:CONTENT_DENSITY`);
  assert.ok(sample.minimumFontSize >= 10, `${theme.id}:TEXT_TOO_SMALL:${sample.minimumFontSize}`);
  assert.deepEqual(sample.clippedText, [], `${theme.id}:TEXT_CLIPPED`);
  assert.ok(sample.heroLayout.gap >= 32, `${theme.id}:HERO_COLUMNS_TOO_TIGHT`);
  assert.ok(sample.heroLayout.paddingTop >= 60 && sample.heroLayout.paddingBottom >= 60, `${theme.id}:HERO_WHITESPACE`);
  assert.ok(sample.sectionPaddings.every((entry) => entry.top >= 70 && entry.bottom >= 70), `${theme.id}:SECTION_WHITESPACE`);
  assert.ok(sample.revealTargets >= 7, `${theme.id}:REVEAL_TARGETS_MISSING`);
  assert.equal(sample.pointerNetworkPresent, false, `${theme.id}:LEGACY_POINTER_NETWORK_PRESENT`);
  assert.equal(sample.pointerMotion, false, `${theme.id}:POINTER_DRIVEN_REPAINT_PRESENT`);
  assert.equal(sample.pointerX, "", `${theme.id}:POINTER_X_VARIABLE_PRESENT`);
  assert.equal(sample.pointerY, "", `${theme.id}:POINTER_Y_VARIABLE_PRESENT`);
  assert.equal(sample.panelCount, 6, `${theme.id}:SNAP_PANEL_COUNT_MISMATCH`);
  assert.equal(sample.orbitCount, 2, `${theme.id}:SIGNAL_ORBIT_COUNT_MISMATCH`);
  assert.equal(sample.typewriterPresent, true, `${theme.id}:TYPEWRITER_MISSING`);
  assert.equal(sample.contactPresent, true, `${theme.id}:CONTACT_SECTION_MISSING`);
  for (const [selector, motion] of Object.entries(sample.motion)) {
    assert.equal(motion.present, true, `${theme.id}:MOTION_LAYER_MISSING:${selector}`);
    assert.notEqual(motion.animationName, "none", `${theme.id}:MOTION_LAYER_STATIC:${selector}`);
  }
}

async function snapshotHomeInlineState(page) {
  return page.evaluate(() => {
    const home = document.querySelector(".soft-white-home");
    if (!home) return null;
    const elements = [home, ...home.querySelectorAll("*")];
    const inlineStyles = elements.flatMap((element, index) => {
      const style = element.getAttribute("style");
      return style === null ? [] : [[index, element.tagName, element.className, style]];
    });
    const style = getComputedStyle(home);
    return {
      inlineStyles,
      pointerX: style.getPropertyValue("--pointer-x").trim(),
      pointerY: style.getPropertyValue("--pointer-y").trim(),
      legacyPointerX: style.getPropertyValue("--swh-pointer-x").trim(),
      legacyPointerY: style.getPropertyValue("--swh-pointer-y").trim(),
    };
  });
}

async function readPanelState(page) {
  return page.evaluate(() => {
    const home = document.querySelector(".soft-white-home");
    const header = home?.querySelector(".swh-header");
    const panels = home ? [...home.querySelectorAll("[data-swh-panel]")] : [];
    if (!home || !header || panels.length === 0) return null;
    const homeRect = home.getBoundingClientRect();
    const currentTop = home.scrollTop + header.getBoundingClientRect().height;
    const tops = panels.map((panel) => panel.getBoundingClientRect().top - homeRect.top + home.scrollTop);
    let activeIndex = 0;
    for (let index = 1; index < tops.length; index += 1) {
      if (Math.abs(tops[index] - currentTop) < Math.abs(tops[activeIndex] - currentTop)) activeIndex = index;
    }
    return {
      activeIndex,
      panelCount: panels.length,
      panelIds: panels.map((panel) => panel.id || panel.getAttribute("aria-label") || "anonymous"),
      scrollTop: home.scrollTop,
    };
  });
}

async function waitForPanel(page, expectedIndex) {
  await page.waitForFunction((index) => {
    const home = document.querySelector(".soft-white-home");
    const header = home?.querySelector(".swh-header");
    const panels = home ? [...home.querySelectorAll("[data-swh-panel]")] : [];
    if (!home || !header || !panels[index]) return false;
    const homeRect = home.getBoundingClientRect();
    const currentTop = home.scrollTop + header.getBoundingClientRect().height;
    const tops = panels.map((panel) => panel.getBoundingClientRect().top - homeRect.top + home.scrollTop);
    let nearest = 0;
    for (let candidate = 1; candidate < tops.length; candidate += 1) {
      if (Math.abs(tops[candidate] - currentTop) < Math.abs(tops[nearest] - currentTop)) nearest = candidate;
    }
    return nearest === index;
  }, expectedIndex, { timeout: 3_000 });
}

async function verifySoftWhiteWheel(page) {
  await page.evaluate(() => {
    const home = document.querySelector(".soft-white-home");
    if (!home) return;
    const previousBehavior = home.style.scrollBehavior;
    home.style.scrollBehavior = "auto";
    home.scrollTop = 0;
    void home.offsetHeight;
    home.style.scrollBehavior = previousBehavior;
  });
  await page.mouse.move(720, 450);
  const before = await readPanelState(page);
  assert.equal(before?.activeIndex, 0, `滚轮测试起点错误: ${JSON.stringify(before)}`);

  await page.mouse.wheel(0, 900);
  await page.mouse.wheel(0, 900);
  await page.mouse.wheel(0, 900);
  await page.mouse.wheel(0, 900);
  await waitForPanel(page, 1);
  await page.waitForTimeout(820);
  const afterRapidForward = await readPanelState(page);
  assert.equal(afterRapidForward?.activeIndex, 1, `快速连滚跨越了多个面板: ${JSON.stringify(afterRapidForward)}`);

  await page.mouse.wheel(0, -900);
  await waitForPanel(page, 0);
  const afterReverse = await readPanelState(page);
  assert.equal(afterReverse?.activeIndex, 0, `反向滚轮未回到相邻面板: ${JSON.stringify(afterReverse)}`);
  return { before, afterRapidForward, afterReverse };
}

async function observeSoftWhiteTypewriter(page) {
  const observation = await page.evaluate(async (expectedPhrases) => {
    const typewriter = document.querySelector('[data-testid="swh-typewriter"]');
    const visibleText = typewriter?.querySelector('span[aria-hidden="true"]');
    const title = typewriter?.closest("h1");
    if (!typewriter || !visibleText || !title) return null;
    const samples = [];
    const completed = new Set();
    const seenFullTexts = new Set();
    let incrementalChanges = 0;
    let previous = null;
    const deadline = performance.now() + 10_000;

    while (performance.now() < deadline) {
      const fullText = typewriter.getAttribute("data-full-text") || "";
      const text = visibleText.textContent || "";
      const box = typewriter.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const sample = {
        fullText,
        text,
        width: box.width,
        height: box.height,
        titleWidth: titleBox.width,
        titleHeight: titleBox.height,
      };
      if (!previous || previous.fullText !== fullText || previous.text !== text) {
        samples.push(sample);
        seenFullTexts.add(fullText);
        if (previous && previous.fullText === fullText && Math.abs(previous.text.length - text.length) === 1) {
          incrementalChanges += 1;
        }
        if (text === fullText && expectedPhrases.includes(fullText)) completed.add(fullText);
        previous = sample;
      }
      if (incrementalChanges >= 3 && completed.size >= 2 && seenFullTexts.size >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const drift = (key) => {
      const values = samples.map((sample) => sample[key]);
      return Math.max(...values) - Math.min(...values);
    };
    return {
      sampleCount: samples.length,
      incrementalChanges,
      completedPhrases: [...completed],
      seenFullTexts: [...seenFullTexts],
      boxWidthDrift: drift("width"),
      boxHeightDrift: drift("height"),
      titleWidthDrift: drift("titleWidth"),
      titleHeightDrift: drift("titleHeight"),
    };
  }, softWhiteHeroPhrases);

  assert.ok(observation, "未找到 soft-white 打字机节点");
  assert.ok(observation.incrementalChanges >= 3, `未观察到逐字变化: ${JSON.stringify(observation)}`);
  assert.ok(
    observation.completedPhrases.length >= 2 && observation.seenFullTexts.length >= 2,
    `未观察到完整短语切换: ${JSON.stringify(observation)}`,
  );
  assert.ok(
    observation.boxWidthDrift <= 1
      && observation.boxHeightDrift <= 1
      && observation.titleWidthDrift <= 1
      && observation.titleHeightDrift <= 1,
    `打字期间标题盒尺寸漂移: ${JSON.stringify(observation)}`,
  );
  return observation;
}

async function verifyContinuousPointerStability(page) {
  const before = await snapshotHomeInlineState(page);
  assert.ok(before, "未找到 soft-white 首页根节点");
  for (let index = 0; index < 18; index += 1) {
    await page.mouse.move(80 + ((index * 97) % 1_260), 120 + ((index * 61) % 680), { steps: 2 });
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await snapshotHomeInlineState(page);
  assert.deepEqual(after, before, "连续鼠标移动不应改写首页内联样式或指针变量");
  return { inlineStyleCount: before.inlineStyles.length, pointerX: before.pointerX, pointerY: before.pointerY };
}

async function verifySection(page, sectionId, theme, viewport, report) {
  const locator = page.locator(`#${sectionId}`);
  await locator.scrollIntoViewIfNeeded();
  await page.waitForFunction((id) => {
    const node = document.getElementById(id);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return node.classList.contains("is-visible")
      && Number.parseFloat(getComputedStyle(node).opacity) >= 0.98
      && rect.bottom > 0
      && rect.top < innerHeight;
  }, sectionId, { timeout: 10_000 });
  await page.waitForTimeout(160);
  const section = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const heading = node.querySelector("h2");
    const cards = [...node.querySelectorAll("article")];
    const childRects = [...node.querySelectorAll("h2,p,article,aside,.swh-proof-bar")]
      .filter((child) => getComputedStyle(child).display !== "none")
      .map((child) => ({
        text: (child.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 60),
        left: child.getBoundingClientRect().left,
        right: child.getBoundingClientRect().right,
      }));
    return {
      id: node.id,
      visible: rect.bottom > 0 && rect.top < innerHeight,
      heading: (heading?.textContent || "").trim(),
      headingFontSize: Number.parseFloat(heading ? getComputedStyle(heading).fontSize : "0"),
      cardCount: cards.length,
      overruns: childRects.filter((child) => child.left < rect.left - 2 || child.right > rect.right + 2),
      overflowX: node.scrollWidth - node.clientWidth,
    };
  });
  assert.equal(section.visible, true, `${theme.id}:${sectionId}:NOT_VISIBLE`);
  assert.ok(section.heading.length > 8, `${theme.id}:${sectionId}:HEADING_WEAK`);
  assert.ok(section.headingFontSize >= 30, `${theme.id}:${sectionId}:HEADING_HIERARCHY`);
  assert.ok(
    section.overflowX <= Math.ceil(viewport.width * 0.09),
    `${theme.id}:${sectionId}:UNBOUNDED_DECORATIVE_OVERFLOW:${section.overflowX}`,
  );
  assert.deepEqual(section.overruns, [], `${theme.id}:${sectionId}:CONTENT_OVERRUN`);
  const screenshot = path.join(evidenceDir, `${theme.id}-${viewport.name}-${sectionId}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  report.sections.push({ ...section, screenshot });
}

async function verifyReducedMotion(browser, report) {
  const theme = themes.find((candidate) => candidate.id === "soft-white");
  const viewport = { width: 1440, height: 900, name: "1440x900" };
  const scope = "soft-white:1440x900:reduced-motion";
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme.colorScheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });

  try {
    await context.addInitScript(({ selectedTheme }) => {
      localStorage.setItem("platform_theme", selectedTheme);
      localStorage.setItem("platform_theme_mode", "system");
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      localStorage.removeItem("user_theme_preference");
      localStorage.removeItem("user_theme_mode_preference");
      sessionStorage.removeItem("entered_app");
    }, { selectedTheme: theme.id });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(origin).origin) {
        report.externalRequests.push({ theme: theme.id, viewport: viewport.name, scope, url: request.url() });
        await route.abort("blockedbyclient");
        return;
      }
      if (request.method() === "GET" && url.pathname === "/api/settings") {
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({ settings: { theme: theme.id, theme_mode: "system" } }),
        });
        return;
      }
      if (request.method() === "GET" && url.pathname === "/api/settings/appearance") {
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify({
            settings: { theme: theme.id, theme_mode: theme.mode },
            authority: { source: "platform_settings", authoritative: true, publishedAt: null },
          }),
        });
        return;
      }
      if (!["GET", "HEAD"].includes(request.method())) {
        report.blockedWrites.push({
          theme: theme.id,
          viewport: viewport.name,
          scope,
          method: request.method(),
          pathname: url.pathname,
        });
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme.colorScheme });
    page.on("pageerror", (error) => report.pageErrors.push({ scope, message: error.message.slice(0, 500) }));
    page.on("console", (message) => {
      const messageText = message.text();
      if (message.type() === "error" && !/fonts\.googleapis|ERR_BLOCKED_BY_CLIENT|favicon|ResizeObserver/iu.test(messageText)) {
        report.consoleErrors.push({ scope, message: messageText.slice(0, 500) });
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === new URL(origin).origin && response.status() >= 500) {
        report.serverErrors.push({ scope, status: response.status(), pathname: url.pathname });
      }
    });

    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.getByTestId("soft-white-premium-home").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => {
      const typewriter = document.querySelector('[data-testid="swh-typewriter"]');
      const visible = typewriter?.querySelector('span[aria-hidden="true"]')?.textContent || "";
      return matchMedia("(prefers-reduced-motion: reduce)").matches
        && visible.length > 0
        && visible === typewriter?.getAttribute("data-full-text");
    }, null, { timeout: 10_000 });

    const first = await page.evaluate(() => {
      const typewriter = document.querySelector('[data-testid="swh-typewriter"]');
      const visible = typewriter?.querySelector('span[aria-hidden="true"]');
      const title = typewriter?.closest("h1");
      const caret = typewriter?.querySelector(":scope > i");
      const motionSelectors = [".swh-signal-orbit-one", ".swh-signal-orbit-two", ".swh-signal-beacons"];
      const box = typewriter?.getBoundingClientRect();
      const titleBox = title?.getBoundingClientRect();
      return {
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        fullText: typewriter?.getAttribute("data-full-text") || "",
        visibleText: visible?.textContent || "",
        caretDisplay: caret ? getComputedStyle(caret).display : "missing",
        motion: Object.fromEntries(motionSelectors.map((selector) => {
          const node = document.querySelector(selector);
          return [selector, node ? getComputedStyle(node).animationName : "missing"];
        })),
        box: box ? { width: box.width, height: box.height } : null,
        titleBox: titleBox ? { width: titleBox.width, height: titleBox.height } : null,
      };
    });
    await page.waitForTimeout(700);
    const second = await page.evaluate(() => {
      const typewriter = document.querySelector('[data-testid="swh-typewriter"]');
      const title = typewriter?.closest("h1");
      const box = typewriter?.getBoundingClientRect();
      const titleBox = title?.getBoundingClientRect();
      return {
        fullText: typewriter?.getAttribute("data-full-text") || "",
        visibleText: typewriter?.querySelector('span[aria-hidden="true"]')?.textContent || "",
        box: box ? { width: box.width, height: box.height } : null,
        titleBox: titleBox ? { width: titleBox.width, height: titleBox.height } : null,
      };
    });

    assert.equal(first.reducedMotion, true, `${scope}:MEDIA_EMULATION_INACTIVE`);
    assert.equal(first.fullText, softWhiteHeroPhrases[0], `${scope}:STATIC_PHRASE_NOT_FIRST`);
    assert.equal(first.visibleText, first.fullText, `${scope}:STATIC_PHRASE_INCOMPLETE`);
    assert.equal(first.caretDisplay, "none", `${scope}:TYPEWRITER_CARET_ACTIVE`);
    for (const [selector, animationName] of Object.entries(first.motion)) {
      assert.equal(animationName, "none", `${scope}:KEY_MOTION_ACTIVE:${selector}`);
    }
    assert.deepEqual(second, {
      fullText: first.fullText,
      visibleText: first.visibleText,
      box: first.box,
      titleBox: first.titleBox,
    }, `${scope}:REDUCED_MOTION_CONTENT_CHANGED`);
    report.interactions.push({ scope, kind: "reduced-motion", ...first, stableAfterMs: 700 });
  } finally {
    await context.close();
  }
}

async function main() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) });
  assert.ok(versionResponse.ok, `VERSION_HTTP_${versionResponse.status}`);
  const version = await versionResponse.json();
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    origin,
    sourceVersion: version.sourceVersion || version.version || version.hash,
    buildId: version.buildId || version.build_id || null,
    scenes: [],
    sections: [],
    interactions: [],
    blockedWrites: [],
    externalRequests: [],
    consoleErrors: [],
    pageErrors: [],
    serverErrors: [],
    providerCalls: 0,
    paidCalls: 0,
    businessWrites: 0,
  };
  const browser = await chromium.launch({ headless: true });

  try {
    for (const viewport of viewports) {
      for (const theme of themes) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme.colorScheme,
          serviceWorkers: "block",
        });
        await context.addInitScript(({ selectedTheme }) => {
          localStorage.setItem("platform_theme", selectedTheme);
          localStorage.setItem("platform_theme_mode", "system");
          localStorage.removeItem("auth_token");
          localStorage.removeItem("auth_user");
          localStorage.removeItem("user_theme_preference");
          localStorage.removeItem("user_theme_mode_preference");
          sessionStorage.removeItem("entered_app");
        }, { selectedTheme: theme.id });
        await context.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== new URL(origin).origin) {
            report.externalRequests.push({ theme: theme.id, viewport: viewport.name, url: request.url() });
            await route.abort("blockedbyclient");
            return;
          }
          if (request.method() === "GET" && url.pathname === "/api/settings") {
            await route.fulfill({
              status: 200,
              contentType: "application/json; charset=utf-8",
              headers: { "Cache-Control": "private, no-store" },
              body: JSON.stringify({ settings: { theme: theme.id, theme_mode: "system" } }),
            });
            return;
          }
          if (request.method() === "GET" && url.pathname === "/api/settings/appearance") {
            await route.fulfill({
              status: 200,
              contentType: "application/json; charset=utf-8",
              headers: { "Cache-Control": "private, no-store" },
              body: JSON.stringify({
                settings: { theme: theme.id, theme_mode: theme.mode },
                authority: { source: "platform_settings", authoritative: true, publishedAt: null },
              }),
            });
            return;
          }
          if (!["GET", "HEAD"].includes(request.method())) {
            report.blockedWrites.push({ theme: theme.id, viewport: viewport.name, method: request.method(), pathname: url.pathname });
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        });

        const page = await context.newPage();
        const scope = `${theme.id}:${viewport.name}`;
        page.on("pageerror", (error) => report.pageErrors.push({ scope, message: error.message.slice(0, 500) }));
        page.on("console", (message) => {
          const messageText = message.text();
          if (message.type() === "error" && !/fonts\.googleapis|ERR_BLOCKED_BY_CLIENT|favicon|ResizeObserver/iu.test(messageText)) {
            report.consoleErrors.push({ scope, message: messageText.slice(0, 500) });
          }
        });
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.origin === new URL(origin).origin && response.status() >= 500) {
            report.serverErrors.push({ scope, status: response.status(), pathname: url.pathname });
          }
        });

        await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 45_000 });
        const home = page.getByTestId("soft-white-premium-home");
        await home.waitFor({ state: "visible", timeout: 30_000 });
        await page.waitForFunction(({ selectedTheme, selectedMode }) => {
          const root = document.documentElement;
          const hero = document.querySelector(".swh-hero[data-swh-reveal]");
          return root.dataset.theme === selectedTheme
            && root.dataset.themeSelection === selectedTheme
            && root.dataset.mode === selectedMode
            && hero?.classList.contains("is-visible") === true
            && Number.parseFloat(getComputedStyle(hero).opacity) >= 0.99;
        }, { selectedTheme: theme.id, selectedMode: theme.mode }, { timeout: 15_000 });
        await page.mouse.move(viewport.width * 0.24, viewport.height * 0.26);
        await page.waitForTimeout(160);
        const pointerBefore = await home.evaluate((node) => ({
          x: getComputedStyle(node).getPropertyValue("--swh-pointer-x").trim(),
          y: getComputedStyle(node).getPropertyValue("--swh-pointer-y").trim(),
          background: getComputedStyle(node).backgroundImage,
          factoryTransform: document.querySelector('[data-testid="swh-content-factory"]')
            ? getComputedStyle(document.querySelector('[data-testid="swh-content-factory"]')).transform
            : "none",
        }));
        await page.mouse.move(viewport.width * 0.78, viewport.height * 0.62);
        await page.waitForTimeout(180);
        const sample = await samplePage(page);
        assertPage(sample, theme);
        const pointerAfter = await home.evaluate((node) => ({
          x: getComputedStyle(node).getPropertyValue("--swh-pointer-x").trim(),
          y: getComputedStyle(node).getPropertyValue("--swh-pointer-y").trim(),
          background: getComputedStyle(node).backgroundImage,
          factoryTransform: document.querySelector('[data-testid="swh-content-factory"]')
            ? getComputedStyle(document.querySelector('[data-testid="swh-content-factory"]')).transform
            : "none",
        }));
        assert.deepEqual(pointerAfter, pointerBefore, `${scope}:MOUSE_MOVE_CHANGED_LANDING_PAINT`);
        if (theme.id === "soft-white" && viewport.name === "1440x900") {
          const typewriter = await observeSoftWhiteTypewriter(page);
          const pointer = await verifyContinuousPointerStability(page);
          const wheel = await verifySoftWhiteWheel(page);
          report.interactions.push({ scope, kind: "typewriter", ...typewriter });
          report.interactions.push({ scope, kind: "pointer-stability", ...pointer });
          report.interactions.push({ scope, kind: "wheel-navigation", ...wheel });
        }
        const heroScreenshot = path.join(evidenceDir, `${theme.id}-${viewport.name}-hero.png`);
        await page.screenshot({ path: heroScreenshot, fullPage: false });
        report.scenes.push({ ...sample, heroScreenshot });

        for (const sectionId of sections) {
          await verifySection(page, sectionId, theme, viewport, report);
        }
        await context.close();
      }
    }

    await verifyReducedMotion(browser, report);

    assert.deepEqual(report.blockedWrites, [], "HOMEPAGE_ATTEMPTED_WRITE");
    assert.deepEqual(report.consoleErrors, [], "HOMEPAGE_CONSOLE_ERRORS");
    assert.deepEqual(report.pageErrors, [], "HOMEPAGE_PAGE_ERRORS");
    assert.deepEqual(report.serverErrors, [], "HOMEPAGE_SERVER_ERRORS");
    report.ok = true;
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sourceVersion: report.sourceVersion,
      buildId: report.buildId,
      scenes: report.scenes.length,
      sectionScreenshots: report.sections.length,
      paidCalls: 0,
      businessWrites: 0,
      evidenceDir,
    }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

await main();
