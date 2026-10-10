#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const evidenceDir = path.resolve(".codex-evidence/landing-motion-browser-readonly");
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const decorationCounts = {
  auroraFields: 2,
  dataBeams: 3,
  depthParticleFields: 1,
  holoOrbits: 2,
  holoCores: 1,
};
await mkdir(evidenceDir, { recursive: true });

const report = {
  schemaVersion: 1,
  suite: "landing-motion-browser-readonly",
  checkedAt: new Date().toISOString(),
  origin,
  sourceVersion: null,
  buildId: null,
  runningLatest: false,
  normalMotion: null,
  reducedMotion: null,
  pageErrors: [],
  consoleErrors: [],
  serverErrors: [],
  writeRequests: [],
  paidRequests: [],
  requestFailures: [],
  webSocketAttempts: [],
  screenshots: [],
  networkCalls: 0,
  productionWrites: 0,
};

let browser = null;
let activePage = null;
let caughtError = null;
try {
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");
  const [versionResponse, receipt, diskBuildId, currentFingerprint] = await Promise.all([
    fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) }),
    readFile(path.resolve(".next/local-source-fingerprint.v1.json"), "utf8").then(JSON.parse),
    readFile(path.resolve(".next/BUILD_ID"), "utf8").then((value) => value.trim()),
    Promise.resolve(computeLocalBuildFingerprint(process.cwd())),
  ]);
  assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
  const version = await versionResponse.json();
  const servedBuildId = version.buildId || version.version || "";
  const runningLatest = receipt?.fingerprint === currentFingerprint.fingerprint
    && receipt?.fileCount === currentFingerprint.fileCount
    && receipt?.buildId === diskBuildId
    && servedBuildId === diskBuildId;
  report.sourceVersion = version.sourceVersion || null;
  report.buildId = servedBuildId;
  report.runningLatest = runningLatest;
  assert.equal(runningLatest, true, "RUNTIME_NOT_LATEST");

  browser = await chromium.launch({ headless: true });
  const createPage = async (reducedMotion) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion,
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const requestUrl = new URL(request.url());
      const attempt = { method, pathname: requestUrl.pathname, url: request.url() };
      report.networkCalls += 1;
      if (/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\/|$)/u.test(requestUrl.pathname)) {
        report.paidRequests.push(attempt);
      }
      if (!safeMethods.has(method)) {
        report.writeRequests.push(attempt);
        report.productionWrites = report.writeRequests.length;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/React DevTools/u.test(message.text())) report.consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 500) report.serverErrors.push({ status: response.status(), url: response.url() });
    });
    page.on("requestfailed", (request) => {
      report.requestFailures.push({
        method: request.method(),
        url: request.url(),
        errorText: request.failure()?.errorText || "unknown",
      });
    });
    page.on("websocket", (socket) => {
      report.webSocketAttempts.push({ url: socket.url() });
    });
    const response = await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200);
    await page.getByTestId("soft-white-premium-home").waitFor({ state: "visible", timeout: 30_000 });
    return { context, page };
  };

  const normal = await createPage("no-preference");
  activePage = normal.page;
  try {
    const shell = normal.page.getByTestId("swh-project-card-motion");
    const card = normal.page.locator(".swh-loop");
    await shell.waitFor({ state: "visible" });

    const themeVisibility = {};
    for (const theme of [
      { id: "soft-white", mode: "light" },
      { id: "lattice", mode: "dark" },
      { id: "crystal-aurora", mode: "dark" },
    ]) {
      await normal.page.evaluate(({ id, mode }) => {
        const root = document.documentElement;
        root.setAttribute("data-theme-selection", id);
        root.setAttribute("data-theme", id);
        root.setAttribute("data-mode", mode);
      }, theme);
      await normal.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await normal.page.waitForTimeout(1_100);
      const visibility = await normal.page.evaluate(() => {
        const inspect = (selector) => [...document.querySelectorAll(selector)].map((node) => {
          const style = getComputedStyle(node);
          const before = getComputedStyle(node, "::before");
          const after = getComputedStyle(node, "::after");
          const rect = node.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            display: style.display,
            visibility: style.visibility,
            opacity: Number(style.opacity),
            animationNames: [style.animationName, before.animationName, after.animationName],
            backgrounds: [style.backgroundImage, before.backgroundImage, after.backgroundImage],
          };
        });
        return {
          theme: document.documentElement.getAttribute("data-theme"),
          mode: document.documentElement.getAttribute("data-mode"),
          auroraFields: inspect(".swh-aurora-field"),
          dataBeams: inspect(".swh-data-beam"),
          depthParticleFields: inspect(".swh-depth-particle-field"),
          holoOrbits: inspect(".swh-holo-orbit"),
          holoCores: inspect(".swh-holo-core"),
        };
      });
      assert.equal(visibility.theme, theme.id, `LANDING_THEME_NOT_APPLIED:${theme.id}`);
      assert.equal(visibility.mode, theme.mode, `LANDING_THEME_MODE_NOT_APPLIED:${theme.id}`);
      for (const [label, decorations, expectedCount] of [
        ["AURORA_FIELD", visibility.auroraFields, 2],
        ["DATA_BEAM", visibility.dataBeams, 3],
        ["DEPTH_PARTICLE_FIELD", visibility.depthParticleFields, 1],
        ["HOLO_ORBIT", visibility.holoOrbits, 2],
        ["HOLO_CORE", visibility.holoCores, 1],
      ]) {
        assert.equal(decorations.length, expectedCount, `${label}_COUNT:${theme.id}:${decorations.length}`);
        assert.ok(decorations.every((item) => (
          item.width > 0
          && item.height > 0
          && item.display !== "none"
          && item.visibility !== "hidden"
          && item.opacity > 0
        )), `${label}_NOT_VISIBLE:${theme.id}:${JSON.stringify(decorations)}`);
      }
      themeVisibility[theme.id] = visibility;
      const screenshot = `theme-${theme.id}.png`;
      await normal.page.screenshot({ path: path.join(evidenceDir, screenshot), fullPage: false });
      report.screenshots.push(screenshot);
    }
    await normal.page.evaluate(() => {
      const root = document.documentElement;
      root.setAttribute("data-theme-selection", "soft-white");
      root.setAttribute("data-theme", "soft-white");
      root.setAttribute("data-mode", "light");
    });
    await normal.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const atmosphericMotionSamples = [];
    for (let index = 0; index < 9; index += 1) {
      atmosphericMotionSamples.push(await normal.page.evaluate(() => {
        const collectKeyframeNames = () => {
          const names = new Set();
          const visitRules = (rules) => {
            for (const rule of rules) {
              if (rule.type === CSSRule.KEYFRAMES_RULE) names.add(rule.name);
              try {
                if (rule.cssRules) visitRules(rule.cssRules);
              } catch {
                // Cross-origin and browser-owned sheets are not part of this local landing contract.
              }
            }
          };
          for (const sheet of document.styleSheets) {
            try {
              visitRules(sheet.cssRules);
            } catch {
              // Ignore inaccessible sheets; local landing styles remain inspectable.
            }
          }
          return [...names];
        };
        const signature = (node, pseudo = null) => {
          const style = getComputedStyle(node, pseudo);
          return [
            style.transform,
            style.opacity,
            style.backgroundPosition,
            style.backgroundImage,
            style.filter,
            style.clipPath,
            style.maskPosition,
            style.offsetDistance,
            style.translate,
            style.scale,
            style.rotate,
          ].join("|");
        };
        const inspect = (selector) => [...document.querySelectorAll(selector)].map((node) => {
          const animations = [null, "::before", "::after"].map((pseudo) => {
            const style = getComputedStyle(node, pseudo);
            return {
              name: style.animationName,
              duration: style.animationDuration,
              delay: style.animationDelay,
              playState: style.animationPlayState,
            };
          });
          return {
            signatures: [signature(node), signature(node, "::before"), signature(node, "::after")],
            animations,
          };
        });
        return {
          keyframeNames: collectKeyframeNames(),
          auroraFields: inspect(".swh-aurora-field"),
          dataBeams: inspect(".swh-data-beam"),
          depthParticleFields: inspect(".swh-depth-particle-field"),
          holoOrbits: inspect(".swh-holo-orbit"),
          holoCores: inspect(".swh-holo-core"),
        };
      }));
      await normal.page.waitForTimeout(220);
    }
    const splitCssList = (value) => String(value || "").split(",").map((part) => part.trim());
    const parseCssTime = (value) => {
      const match = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/u.exec(String(value || "").trim());
      if (!match) return Number.NaN;
      const amount = Number(match[1]);
      return match[2] === "s" ? amount * 1_000 : amount;
    };
    const animationTracks = (item) => item.animations.flatMap((animation) => {
      const names = splitCssList(animation.name);
      const durations = splitCssList(animation.duration);
      const delays = splitCssList(animation.delay);
      const playStates = splitCssList(animation.playState);
      return names
        .map((name, index) => ({
          name,
          durationMs: parseCssTime(durations[index % durations.length]),
          delayMs: parseCssTime(delays[index % delays.length]),
          playState: playStates[index % playStates.length],
        }))
        .filter((track) => track.name && track.name !== "none");
    });
    const keyframeNames = new Set(atmosphericMotionSamples[0].keyframeNames);
    const assertDecorationProgress = (key, label, expectedCount, { allowScheduledFallback = false } = {}) => {
      const first = atmosphericMotionSamples[0][key];
      assert.equal(first.length, expectedCount, `${label}_COUNT:${first.length}`);
      atmosphericMotionSamples.forEach((sample, sampleIndex) => {
        assert.equal(sample[key].length, expectedCount, `${label}_UNSTABLE_COUNT:${sampleIndex}:${sample[key].length}`);
      });
      const progressedItems = [];
      first.forEach((item, itemIndex) => {
        const tracks = animationTracks(item);
        assert.ok(tracks.length > 0, `${label}_ANIMATION_MISSING:${itemIndex}:${JSON.stringify(item)}`);
        const samples = atmosphericMotionSamples.map((sample, sampleIndex) => {
          const current = sample[key][itemIndex];
          assert.ok(current, `${label}_MISSING_INDEX:${sampleIndex}:${itemIndex}`);
          assert.equal(current.signatures.length, 3, `${label}_SIGNATURE_COUNT:${sampleIndex}:${itemIndex}`);
          assert.ok(current.signatures.every((signature) => typeof signature === "string"), `${label}_UNDEFINED_SIGNATURE:${sampleIndex}:${itemIndex}`);
          return current.signatures.join("||");
        });
        const progressed = new Set(samples).size >= 2;
        progressedItems.push(progressed);
        const hasRunnableKeyframes = tracks.some((track) => (
          track.playState !== "paused"
          && Number.isFinite(track.durationMs)
          && track.durationMs > 0
          && Number.isFinite(track.delayMs)
          && keyframeNames.has(track.name)
        ));
        assert.ok(
          progressed || (allowScheduledFallback && hasRunnableKeyframes),
          `${label}_NOT_PROGRESSING_OR_SCHEDULED:${itemIndex}:${JSON.stringify({ tracks, samples })}`,
        );
      });
      assert.ok(progressedItems.some(Boolean), `${label}_GROUP_NOT_PROGRESSING:${JSON.stringify(progressedItems)}`);
    };
    assertDecorationProgress("auroraFields", "AURORA_FIELD", 2);
    assertDecorationProgress("dataBeams", "DATA_BEAM", 3, { allowScheduledFallback: true });
    assertDecorationProgress("depthParticleFields", "DEPTH_PARTICLE_FIELD", 1);
    assertDecorationProgress("holoOrbits", "HOLO_ORBIT", 2);
    assertDecorationProgress("holoCores", "HOLO_CORE", 1);

    const before = await normal.page.evaluate(() => {
      const root = document.querySelector(".soft-white-home");
      const shellNode = document.querySelector(".swh-loop-float-shell");
      const cardNode = document.querySelector(".swh-loop");
      const shellStyle = getComputedStyle(shellNode);
      const cardStyle = getComputedStyle(cardNode);
      const rootBefore = getComputedStyle(root, "::before");
      const inspectPainted = (selector) => [...document.querySelectorAll(selector)].map((node) => {
        const style = getComputedStyle(node);
        const beforeStyle = getComputedStyle(node, "::before");
        const afterStyle = getComputedStyle(node, "::after");
        const rect = node.getBoundingClientRect();
        return {
          className: node.className,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          opacity: Number(style.opacity),
          display: style.display,
          visibility: style.visibility,
          backgrounds: [style.backgroundImage, beforeStyle.backgroundImage, afterStyle.backgroundImage],
        };
      });
      return {
        shellOffsetTop: shellNode.offsetTop,
        shellOffsetWidth: shellNode.offsetWidth,
        shellOffsetHeight: shellNode.offsetHeight,
        rootScrollWidth: root.scrollWidth,
        rootClientWidth: root.clientWidth,
        shellAnimationName: shellStyle.animationName,
        shellAnimationDuration: shellStyle.animationDuration,
        cardOpacity: cardStyle.opacity,
        geometryCount: document.querySelectorAll(".swh-geometry").length,
        legacyWaveRippleCount: document.querySelectorAll(".swh-energy-ribbon, .swh-wave, .swh-wave-mesh, .swh-wave-signal, .swh-factory-ripple").length,
        paintedAtmosphere: {
          auroraFields: inspectPainted(".swh-aurora-field"),
          dataBeams: inspectPainted(".swh-data-beam"),
          depthParticleFields: inspectPainted(".swh-depth-particle-field"),
        },
        rootBefore: {
          opacity: Number(rootBefore.opacity),
          backgroundImage: rootBefore.backgroundImage,
          backgroundSize: rootBefore.backgroundSize,
        },
        signalCount: document.querySelectorAll(".swh-loop-signal > span").length,
        pointerNetworkCount: document.querySelectorAll(".pointer-network, [data-pointer-motion]").length,
      };
    });
    assert.match(before.shellAnimationName, /swh-project-card-float/u);
    assert.equal(before.geometryCount, 0, `RETIRED_GEOMETRY_DOM_PRESENT:${before.geometryCount}`);
    assert.equal(before.legacyWaveRippleCount, 0, `RETIRED_WAVE_RIPPLE_DOM_PRESENT:${before.legacyWaveRippleCount}`);
    for (const [label, items, expectedCount] of [
      ["AURORA_FIELD", before.paintedAtmosphere.auroraFields, 2],
      ["DATA_BEAM", before.paintedAtmosphere.dataBeams, 3],
      ["DEPTH_PARTICLE_FIELD", before.paintedAtmosphere.depthParticleFields, 1],
    ]) {
      assert.equal(items.length, expectedCount, `${label}_PAINT_COUNT:${items.length}`);
      assert.ok(items.every((item) => (
        item.width > 0
        && item.height > 0
        && item.display !== "none"
        && item.visibility !== "hidden"
        && item.opacity > 0
        && item.backgrounds.some((background) => background && background !== "none")
      )), `${label}_NOT_PAINTED:${JSON.stringify(items)}`);
    }
    assert.ok(Number.isFinite(before.rootBefore.opacity) && before.rootBefore.opacity >= 0 && before.rootBefore.opacity <= 0.35, `ROOT_BEFORE_NOT_SUBTLE:${JSON.stringify(before.rootBefore)}`);
    assert.equal(before.signalCount, 3);
    assert.equal(before.pointerNetworkCount, 0);
    assert.ok(before.rootScrollWidth - before.rootClientWidth <= 1, `HOME_HORIZONTAL_OVERFLOW:${JSON.stringify(before)}`);

    const floatSamples = [];
    for (let index = 0; index < 5; index += 1) {
      floatSamples.push(await shell.evaluate((node) => getComputedStyle(node).transform));
      await normal.page.waitForTimeout(260);
    }
    assert.ok(new Set(floatSamples).size >= 2, `PROJECT_CARD_FLOAT_NOT_PROGRESSING:${JSON.stringify(floatSamples)}`);

    const bounds = await card.boundingBox();
    assert.ok(bounds, "PROJECT_CARD_BOUNDS_REQUIRED");
    const hoverSamples = [];
    for (let index = 0; index < 12; index += 1) {
      await normal.page.mouse.move(
        index % 2 === 0 ? bounds.x + 12 : bounds.x + bounds.width + 18,
        bounds.y + bounds.height * (index % 2 === 0 ? 0.35 : 0.68),
      );
      await normal.page.waitForTimeout(45);
      hoverSamples.push(await card.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { opacity: Number(style.opacity), width: rect.width, height: rect.height };
      }));
    }
    assert.ok(hoverSamples.every((sample) => sample.opacity === 1), `PROJECT_CARD_TRANSIENT_FLASH:${JSON.stringify(hoverSamples)}`);
    const hoverBaseline = hoverSamples[0];
    assert.ok(hoverSamples.every((sample) => Math.abs(sample.width - hoverBaseline.width) <= 1 && Math.abs(sample.height - hoverBaseline.height) <= 1), `PROJECT_CARD_HOVER_LAYOUT_SHIFT:${JSON.stringify(hoverSamples)}`);

    await normal.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await normal.page.waitForTimeout(120);
    const paused = await shell.evaluate((node) => ({
      playState: getComputedStyle(node).animationPlayState,
      transform: getComputedStyle(node).transform,
    }));
    await normal.page.waitForTimeout(280);
    const pausedLater = await shell.evaluate((node) => getComputedStyle(node).transform);
    assert.equal(paused.playState, "paused", "PROJECT_CARD_FLOAT_MUST_PAUSE_ON_HOVER");
    assert.equal(pausedLater, paused.transform, "PROJECT_CARD_FLOAT_MOVED_WHILE_PAUSED");
    await normal.page.screenshot({ path: path.join(evidenceDir, "project-card-hover.png"), fullPage: false });
    report.screenshots.push("project-card-hover.png");
    await normal.page.mouse.move(4, 4);
    await normal.page.waitForTimeout(360);
    const resumed = await shell.evaluate((node) => ({
      playState: getComputedStyle(node).animationPlayState,
      transform: getComputedStyle(node).transform,
    }));
    assert.equal(resumed.playState, "running", "PROJECT_CARD_FLOAT_DID_NOT_RESUME");
    assert.notEqual(resumed.transform, paused.transform, "PROJECT_CARD_FLOAT_RESUME_DID_NOT_PROGRESS");

    const signalSamples = [];
    for (let index = 0; index < 7; index += 1) {
      signalSamples.push(await normal.page.locator(".swh-loop-signal > span").evaluateAll((nodes) => (
        nodes.map((node) => `${getComputedStyle(node).opacity}:${getComputedStyle(node).transform}`).join("|")
      )));
      await normal.page.waitForTimeout(240);
    }
    assert.ok(new Set(signalSamples).size >= 2, `PROJECT_CARD_SIGNAL_PULSE_NOT_PROGRESSING:${JSON.stringify(signalSamples)}`);

    const typewriterSamples = [];
    for (let index = 0; index < 72; index += 1) {
      typewriterSamples.push(await normal.page.getByTestId("swh-typewriter").evaluate((node) => ({
        text: node.querySelector('[aria-hidden="true"]')?.textContent || "",
        full: node.getAttribute("data-full-text") || "",
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      })));
      await normal.page.waitForTimeout(90);
    }
    const phraseSequence = typewriterSamples.map((sample) => sample.full);
    assert.ok(new Set(phraseSequence).size >= 2, `TYPEWRITER_DID_NOT_ADVANCE_PHRASE:${JSON.stringify(phraseSequence)}`);
    assert.ok(typewriterSamples.some((sample, index) => index > 0 && sample.full === typewriterSamples[index - 1].full && sample.text.length > typewriterSamples[index - 1].text.length), "TYPEWRITER_INPUT_PHASE_MISSING");
    assert.ok(typewriterSamples.some((sample, index) => index > 0 && sample.full === typewriterSamples[index - 1].full && sample.text.length < typewriterSamples[index - 1].text.length), "TYPEWRITER_DELETE_PHASE_MISSING");
    const typewriterHeights = typewriterSamples.map((sample) => Math.round(sample.height));
    assert.equal(new Set(typewriterHeights).size, 1, `TYPEWRITER_LAYOUT_HEIGHT_SHIFT:${JSON.stringify(typewriterHeights)}`);

    await normal.page.evaluate(() => {
      const root = document.querySelector(".soft-white-home");
      root.scrollTo({ top: 0, behavior: "auto" });
    });
    const panelOffsets = await normal.page.locator("[data-swh-panel]").evaluateAll((nodes) => nodes.map((node) => node.offsetTop));
    assert.ok(panelOffsets.length >= 5, `FULL_SCREEN_PANEL_COUNT:${panelOffsets.length}`);
    const readPanelState = () => normal.page.evaluate(() => {
      const root = document.querySelector(".soft-white-home");
      const panels = [...document.querySelectorAll("[data-swh-panel]")];
      const headerHeight = document.querySelector(".swh-header")?.offsetHeight || 74;
      const rootTop = root.getBoundingClientRect().top;
      const panelTops = panels.map((panel) => panel.getBoundingClientRect().top - rootTop + root.scrollTop);
      const currentTop = root.scrollTop + headerHeight;
      const currentIndex = panelTops.reduce((bestIndex, panelTop, index) => (
        Math.abs(panelTop - currentTop) < Math.abs(panelTops[bestIndex] - currentTop) ? index : bestIndex
      ), 0);
      return {
        currentIndex,
        scrollTop: root.scrollTop,
        maxScrollTop: root.scrollHeight - root.clientHeight,
        windowScrollY: window.scrollY,
        firstPanelTop: panels[0]?.getBoundingClientRect().top ?? null,
        lastPanelTop: panels.at(-1)?.getBoundingClientRect().top ?? null,
      };
    });
    const waitForPanel = async (expectedIndex) => {
      await normal.page.waitForFunction((index) => {
        const root = document.querySelector(".soft-white-home");
        const panels = [...document.querySelectorAll("[data-swh-panel]")];
        const headerHeight = document.querySelector(".swh-header")?.offsetHeight || 74;
        const rootTop = root.getBoundingClientRect().top;
        const panelTops = panels.map((panel) => panel.getBoundingClientRect().top - rootTop + root.scrollTop);
        const currentTop = root.scrollTop + headerHeight;
        const currentIndex = panelTops.reduce((bestIndex, panelTop, candidateIndex) => (
          Math.abs(panelTop - currentTop) < Math.abs(panelTops[bestIndex] - currentTop) ? candidateIndex : bestIndex
        ), 0);
        const targetTop = index === panels.length - 1
          ? root.scrollHeight - root.clientHeight
          : Math.max(0, panelTops[index] - headerHeight);
        return currentIndex === index && Math.abs(root.scrollTop - targetTop) < 3;
      }, expectedIndex, { timeout: 4_000 });
      return readPanelState();
    };
    const wheelToPanel = async (expectedIndex, deltaY, settle = true) => {
      await normal.page.mouse.wheel(0, deltaY);
      const state = await waitForPanel(expectedIndex);
      assert.equal(state.currentIndex, expectedIndex, `WHEEL_PANEL_NOT_REACHED:${expectedIndex}:${JSON.stringify(state)}`);
      if (settle) await normal.page.waitForTimeout(800);
      return state;
    };

    await normal.page.mouse.move(20, 450);
    const forwardPanelStates = [await readPanelState(), await wheelToPanel(1, 420, false)];
    const firstWheelTop = await normal.page.locator(".soft-white-home").evaluate((node) => node.scrollTop);
    await normal.page.mouse.wheel(0, 420);
    await normal.page.waitForTimeout(220);
    const lockedWheelTop = await normal.page.locator(".soft-white-home").evaluate((node) => node.scrollTop);
    const firstPanelTarget = Math.max(0, panelOffsets[1] - 74);
    const secondPanelTarget = Math.max(0, panelOffsets[2] - 74);
    const panelBoundary = firstPanelTarget + ((secondPanelTarget - firstPanelTarget) / 2);
    assert.ok(
      lockedWheelTop < panelBoundary
        && Math.abs(lockedWheelTop - firstPanelTarget) < Math.abs(lockedWheelTop - secondPanelTarget),
      `WHEEL_LOCK_SKIPPED_PANEL:${firstWheelTop}:${lockedWheelTop}:${panelBoundary}`,
    );
    await normal.page.waitForTimeout(580);
    for (let index = 2; index < panelOffsets.length; index += 1) {
      forwardPanelStates.push(await wheelToPanel(index, 420));
    }
    assert.deepEqual(
      forwardPanelStates.map((state) => state.currentIndex),
      panelOffsets.map((_, index) => index),
      "FORWARD_WHEEL_DID_NOT_VISIT_EVERY_PANEL",
    );

    const endScrollSamples = [await readPanelState()];
    assert.ok(
      Math.abs(endScrollSamples[0].scrollTop - endScrollSamples[0].maxScrollTop) <= 2,
      `LAST_SCREEN_NOT_REACHED_BY_WHEEL:${JSON.stringify(endScrollSamples[0])}`,
    );
    await normal.page.screenshot({ path: path.join(evidenceDir, "last-panel.png"), fullPage: false });
    report.screenshots.push("last-panel.png");
    for (let index = 0; index < 5; index += 1) {
      await normal.page.mouse.wheel(0, 640);
      await normal.page.waitForTimeout(140);
      endScrollSamples.push(await readPanelState());
    }
    await normal.page.waitForTimeout(700);
    endScrollSamples.push(await readPanelState());
    const endBaseline = endScrollSamples[0];
    assert.ok(endScrollSamples.every((sample) => Math.abs(sample.scrollTop - endBaseline.scrollTop) <= 2), `LAST_SCREEN_DOWNWARD_SCROLL_SHIFTED:${JSON.stringify(endScrollSamples)}`);
    assert.ok(endScrollSamples.every((sample) => Math.abs(sample.windowScrollY - endBaseline.windowScrollY) <= 1), `LAST_SCREEN_DOWNWARD_SCROLL_LEAKED_TO_WINDOW:${JSON.stringify(endScrollSamples)}`);
    assert.ok(endScrollSamples.every((sample) => sample.lastPanelTop === null || Math.abs(sample.lastPanelTop - endBaseline.lastPanelTop) <= 2), `LAST_SCREEN_DOWNWARD_SCROLL_BOUNCED:${JSON.stringify(endScrollSamples)}`);

    const backwardPanelStates = [];
    for (let index = panelOffsets.length - 2; index >= 0; index -= 1) {
      backwardPanelStates.push(await wheelToPanel(index, -420));
    }
    assert.deepEqual(
      backwardPanelStates.map((state) => state.currentIndex),
      panelOffsets.slice(0, -1).map((_, index) => panelOffsets.length - 2 - index),
      "BACKWARD_WHEEL_DID_NOT_VISIT_EVERY_PANEL",
    );
    const topScrollSamples = [await readPanelState()];
    for (let index = 0; index < 5; index += 1) {
      await normal.page.mouse.wheel(0, -640);
      await normal.page.waitForTimeout(140);
      topScrollSamples.push(await readPanelState());
    }
    await normal.page.waitForTimeout(700);
    topScrollSamples.push(await readPanelState());
    const topBaseline = topScrollSamples[0];
    assert.ok(Math.abs(topBaseline.scrollTop) <= 2, `FIRST_SCREEN_NOT_REACHED_BY_WHEEL:${JSON.stringify(topBaseline)}`);
    assert.ok(topScrollSamples.every((sample) => Math.abs(sample.scrollTop - topBaseline.scrollTop) <= 2), `FIRST_SCREEN_UPWARD_SCROLL_SHIFTED:${JSON.stringify(topScrollSamples)}`);
    assert.ok(topScrollSamples.every((sample) => Math.abs(sample.windowScrollY - topBaseline.windowScrollY) <= 1), `FIRST_SCREEN_UPWARD_SCROLL_LEAKED_TO_WINDOW:${JSON.stringify(topScrollSamples)}`);
    assert.ok(topScrollSamples.every((sample) => sample.firstPanelTop === null || Math.abs(sample.firstPanelTop - topBaseline.firstPanelTop) <= 2), `FIRST_SCREEN_UPWARD_SCROLL_BOUNCED:${JSON.stringify(topScrollSamples)}`);

    await normal.page.evaluate(() => {
      const zone = document.createElement("div");
      zone.dataset.swhFreeScroll = "true";
      zone.style.cssText = "position:fixed;left:8px;top:120px;width:120px;height:100px;overflow:auto;z-index:9999";
      zone.innerHTML = '<div style="height:600px">free scroll fixture</div>';
      document.body.appendChild(zone);
    });
    const freeScroll = normal.page.locator("[data-swh-free-scroll]");
    await freeScroll.hover();
    const homeBeforeFreeScroll = await normal.page.locator(".soft-white-home").evaluate((node) => node.scrollTop);
    await normal.page.mouse.wheel(0, 180);
    await normal.page.waitForFunction(() => document.querySelector("[data-swh-free-scroll]").scrollTop > 0);
    const homeAfterFreeScroll = await normal.page.locator(".soft-white-home").evaluate((node) => node.scrollTop);
    assert.ok(Math.abs(homeAfterFreeScroll - homeBeforeFreeScroll) < 2, "FREE_SCROLL_ZONE_TRIGGERED_PANEL_NAVIGATION");
    await freeScroll.evaluate((node) => node.remove());

    await normal.page.emulateMedia({ reducedMotion: "reduce" });
    await normal.page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="swh-typewriter"]');
      return node?.querySelector('[aria-hidden="true"]')?.textContent === node?.getAttribute("data-full-text");
    });
    // The media-query switch cancels hundreds of short CSS transitions in the
    // same rendering turn. Let their 0.01ms reduced-motion cleanup settle before
    // asserting that no animation remains active.
    await normal.page.waitForTimeout(250);
    const dynamicReduced = await normal.page.evaluate(() => {
      const animationNames = (selector) => [...document.querySelectorAll(selector)].map((node) => (
        [null, "::before", "::after"].map((pseudo) => getComputedStyle(node, pseudo).animationName)
      ));
      return {
        activeAnimations: document.querySelector(".soft-white-home").getAnimations({ subtree: true }).filter((animation) => animation.playState !== "finished").length,
        scrollSnapType: getComputedStyle(document.querySelector(".soft-white-home")).scrollSnapType,
        newMotionAnimations: {
          auroraFields: animationNames(".swh-aurora-field"),
          dataBeams: animationNames(".swh-data-beam"),
          depthParticleFields: animationNames(".swh-depth-particle-field"),
          holoOrbits: animationNames(".swh-holo-orbit"),
          holoCores: animationNames(".swh-holo-core"),
        },
      };
    });
    assert.equal(dynamicReduced.activeAnimations, 0, "DYNAMIC_REDUCED_MOTION_LEFT_ACTIVE_ANIMATIONS");
    assert.equal(dynamicReduced.scrollSnapType, "none", "DYNAMIC_REDUCED_MOTION_DID_NOT_DISABLE_SNAP");
    Object.entries(dynamicReduced.newMotionAnimations).forEach(([label, items]) => {
      assert.equal(items.length, decorationCounts[label], `DYNAMIC_REDUCED_MOTION_DECORATION_COUNT:${label}:${items.length}`);
      items.flat().forEach((animationName) => assert.equal(animationName, "none", `DYNAMIC_REDUCED_MOTION_ANIMATION_ACTIVE:${label}:${animationName}`));
    });

    const after = await normal.page.evaluate(() => {
      const root = document.querySelector(".soft-white-home");
      const shellNode = document.querySelector(".swh-loop-float-shell");
      const cardNode = document.querySelector(".swh-loop");
      const style = getComputedStyle(cardNode);
      return {
        shellOffsetTop: shellNode.offsetTop,
        shellOffsetWidth: shellNode.offsetWidth,
        shellOffsetHeight: shellNode.offsetHeight,
        rootScrollWidth: root.scrollWidth,
        rootClientWidth: root.clientWidth,
        cardOpacity: style.opacity,
        cardBackgroundImage: style.backgroundImage,
      };
    });
    assert.deepEqual(
      { top: after.shellOffsetTop, width: after.shellOffsetWidth, height: after.shellOffsetHeight },
      { top: before.shellOffsetTop, width: before.shellOffsetWidth, height: before.shellOffsetHeight },
      "MOTION_MUST_NOT_CHANGE_LAYOUT_METRICS",
    );
    assert.equal(after.cardOpacity, "1", "PROJECT_CARD_MUST_NOT_FLASH_ON_HOVER");
    assert.ok(after.rootScrollWidth - after.rootClientWidth <= 1, `HOME_HORIZONTAL_OVERFLOW_AFTER_MOTION:${JSON.stringify(after)}`);
    report.normalMotion = {
      before,
      after,
      themeVisibility,
      atmosphericMotionSamples,
      floatSamples,
      hoverSamples,
      signalSamples,
      typewriterSamples,
      panelOffsets,
      forwardPanelStates,
      backwardPanelStates,
      topScrollSamples,
      endScrollSamples,
      dynamicReduced,
    };
  } finally {
    activePage = normal.page;
  }

  const reduced = await createPage("reduce");
  activePage = reduced.page;
  try {
    await reduced.page.waitForTimeout(200);
    const reducedResult = await reduced.page.evaluate(() => {
      const selectors = [
        ".swh-loop-float-shell",
        ".swh-loop-signal",
        ".swh-title-line",
        ".swh-atmosphere::before",
        ".swh-factory-beam::after",
        ".swh-aurora-field",
        ".swh-aurora-field::before",
        ".swh-aurora-field::after",
        ".swh-data-beam",
        ".swh-data-beam::before",
        ".swh-data-beam::after",
        ".swh-depth-particle-field",
        ".swh-depth-particle-field::before",
        ".swh-depth-particle-field::after",
        ".swh-holo-orbit",
        ".swh-holo-orbit::before",
        ".swh-holo-orbit::after",
        ".swh-holo-core",
        ".swh-holo-core::before",
        ".swh-holo-core::after",
        ".swh-card-beam",
      ];
      const animations = Object.fromEntries(selectors.map((selector) => {
        const pseudo = selector.endsWith("::after")
          ? "::after"
          : selector.endsWith("::before")
            ? "::before"
            : null;
        const node = document.querySelector(pseudo ? selector.slice(0, -pseudo.length) : selector);
        return [selector, node ? getComputedStyle(node, pseudo).animationName : "missing"];
      }));
      const root = document.querySelector(".soft-white-home");
      const typewriter = document.querySelector('[data-testid="swh-typewriter"]');
      const inspectDecoration = (selector) => [...document.querySelectorAll(selector)].map((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          display: style.display,
          visibility: style.visibility,
          opacity: Number(style.opacity),
        };
      });
      return {
        animations,
        motionDecorations: {
          auroraFields: inspectDecoration(".swh-aurora-field"),
          dataBeams: inspectDecoration(".swh-data-beam"),
          depthParticleFields: inspectDecoration(".swh-depth-particle-field"),
          holoOrbits: inspectDecoration(".swh-holo-orbit"),
          holoCores: inspectDecoration(".swh-holo-core"),
        },
        activeAnimations: root.getAnimations({ subtree: true }).filter((animation) => animation.playState !== "finished").length,
        scrollSnapType: getComputedStyle(root).scrollSnapType,
        typewriterText: typewriter?.querySelector('[aria-hidden="true"]')?.textContent || "",
        typewriterFullText: typewriter?.getAttribute("data-full-text") || "",
        geometryCount: document.querySelectorAll(".swh-geometry").length,
        legacyWaveRippleCount: document.querySelectorAll(".swh-energy-ribbon, .swh-wave, .swh-wave-mesh, .swh-wave-signal, .swh-factory-ripple").length,
        signalCount: document.querySelectorAll(".swh-loop-signal > span").length,
        pointerNetworkCount: document.querySelectorAll(".pointer-network, [data-pointer-motion]").length,
        overflow: root.scrollWidth - root.clientWidth,
      };
    });
    Object.entries(reducedResult.animations).forEach(([selector, animationName]) => {
      assert.equal(animationName, "none", `REDUCED_MOTION_ANIMATION_ACTIVE:${selector}:${animationName}`);
    });
    Object.entries(reducedResult.motionDecorations).forEach(([label, items]) => {
      assert.equal(items.length, decorationCounts[label], `REDUCED_MOTION_DECORATION_COUNT:${label}:${items.length}`);
      assert.ok(items.every((item) => item.width > 0 && item.height > 0 && item.display !== "none" && item.visibility !== "hidden" && item.opacity > 0), `REDUCED_MOTION_DECORATION_NOT_RENDERED:${label}:${JSON.stringify(items)}`);
    });
    assert.equal(reducedResult.activeAnimations, 0, "REDUCED_MOTION_LEFT_ACTIVE_ANIMATIONS");
    assert.equal(reducedResult.scrollSnapType, "none");
    assert.equal(reducedResult.typewriterText, reducedResult.typewriterFullText);
    assert.equal(reducedResult.geometryCount, 0, `REDUCED_MOTION_RETIRED_GEOMETRY_DOM_PRESENT:${reducedResult.geometryCount}`);
    assert.equal(reducedResult.legacyWaveRippleCount, 0, `REDUCED_MOTION_RETIRED_WAVE_RIPPLE_DOM_PRESENT:${reducedResult.legacyWaveRippleCount}`);
    assert.equal(reducedResult.signalCount, 3);
    assert.equal(reducedResult.pointerNetworkCount, 0);
    assert.ok(reducedResult.overflow <= 1, `REDUCED_MOTION_HORIZONTAL_OVERFLOW:${reducedResult.overflow}`);
    const reducedRoot = reduced.page.locator(".soft-white-home");
    await reducedRoot.evaluate((node) => node.scrollTo({ top: 0, behavior: "auto" }));
    const reducedOffsets = await reduced.page.locator("[data-swh-panel]").evaluateAll((nodes) => nodes.map((node) => node.offsetTop));
    await reduced.page.mouse.move(20, 450);
    await reduced.page.mouse.wheel(0, 260);
    await reduced.page.waitForTimeout(180);
    const reducedWheelTop = await reducedRoot.evaluate((node) => node.scrollTop);
    assert.ok(reducedWheelTop > 0, "REDUCED_MOTION_NATIVE_WHEEL_DID_NOT_SCROLL");
    assert.ok(reducedWheelTop < reducedOffsets[1] - 120, `REDUCED_MOTION_WHEEL_WAS_FORCED_TO_PANEL:${reducedWheelTop}`);
    await reduced.page.screenshot({ path: path.join(evidenceDir, "reduced-motion.png"), fullPage: false });
    report.screenshots.push("reduced-motion.png");
    report.reducedMotion = { ...reducedResult, reducedOffsets, reducedWheelTop };
  } finally {
    activePage = reduced.page;
  }

  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.serverErrors, []);
  assert.deepEqual(report.writeRequests, []);
  assert.deepEqual(report.paidRequests, []);
  assert.deepEqual(report.requestFailures, []);
  assert.deepEqual(report.webSocketAttempts, []);
  assert.deepEqual(report.screenshots, [
    "theme-soft-white.png",
    "theme-lattice.png",
    "theme-crystal-aurora.png",
    "project-card-hover.png",
    "last-panel.png",
    "reduced-motion.png",
  ]);
  report.status = "passed";
} catch (error) {
  caughtError = error;
  report.status = "failed";
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  };
  const failureScreenshot = "failure.png";
  try {
    if (!activePage || activePage.isClosed()) {
      if (!browser?.isConnected()) throw new Error("BROWSER_NOT_AVAILABLE_FOR_FAILURE_SCREENSHOT");
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
      activePage = await context.newPage();
      await activePage.setContent(`<main style="font:20px sans-serif;padding:48px"><h1>Landing motion verification failed</h1><pre>${String(report.failure.message).replace(/[<>&]/gu, "")}</pre></main>`);
    }
    await activePage.screenshot({ path: path.join(evidenceDir, failureScreenshot), fullPage: false });
  } catch (screenshotError) {
    report.failureScreenshotError = screenshotError instanceof Error ? screenshotError.message : String(screenshotError);
    const transparentPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lC3XjAAAAABJRU5ErkJggg==", "base64");
    await writeFile(path.join(evidenceDir, failureScreenshot), transparentPng);
  }
  report.screenshots.push(failureScreenshot);
} finally {
  report.productionWrites = report.writeRequests.length;
  report.finishedAt = new Date().toISOString();
  if (browser) await browser.close().catch(() => undefined);
  await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (caughtError) throw caughtError;
