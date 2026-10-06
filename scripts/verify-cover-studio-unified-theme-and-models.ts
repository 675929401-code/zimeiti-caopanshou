import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const root = process.cwd();
const studio = fs.readFileSync(path.join(root, "src/components/cover-studio.tsx"), "utf8");
const css = fs.readFileSync(path.join(root, "src/app/cover/cover-studio-v2.css"), "utf8");

const checks: string[] = [];
function check(name: string, assertion: () => void) {
  assertion();
  checks.push(name);
}

check("cover exposes the platform theme switcher", () => {
  assert.match(studio, /<UserThemeSwitcher\s*\/>/u);
});

check("the three single-palette cover surfaces share the platform theme bridge", () => {
  assert.match(css, /html\[data-theme="lattice"\] \.cover-rebuild-shell/u);
  assert.match(css, /html\[data-theme="crystal-aurora"\] \.cover-rebuild-shell \.cover-rebuild-stage/u);
  assert.match(css, /html\[data-theme="soft-white"\]\[data-mode="light"\] \.cover-rebuild-shell/u);
  assert.match(css, /font-family:\s*"Microsoft YaHei UI",\s*"PingFang SC"/u);
  assert.doesNotMatch(css, /stellar-blue/u);
  assert.doesNotMatch(css, /data-theme="soft-white"\]\[data-mode="dark"/u);
  assert.doesNotMatch(css, /data-theme="crystal-aurora"\]\[data-mode="light"/u);
});

check("the three audited flagship models are the complete visible generation set", () => {
  for (const token of [
    "pm_PZ3hS353YQNbfRnz2_9Ro0aX",
    "gpt-image-25-sunburst-chA",
    "pm_sHaGkgaNoH1ZgQzpHW2dEUyF",
    "gemini-3-1-flash-image-chA",
    "pm_7y8qxRpEQYgNuYBVvqL4MJgs",
    "cover-model-seedream-5-pro",
    "GPT Image 2.5 Sunburst",
    "Nano Banana 2",
    "豆包 Seedream 5.0 Pro",
  ]) assert.ok(studio.includes(token), `missing ${token}`);
  assert.doesNotMatch(studio, /Nano Banana 2 Pro/u);
  assert.match(studio, /className="cover-flagship-models"/u);
  assert.doesNotMatch(studio, /cover-more-models|<summary>更多已配置模型/u);
});

check("the desktop workflow exposes four integrated controls, two visual modes, three exclusive sources and one generate action", () => {
  const model = studio.indexOf("cover-model-card");
  const mode = studio.indexOf("cover-mode-card");
  const source = studio.indexOf("cover-source-card");
  const ratio = studio.indexOf("cover-ratio-card");
  const brief = studio.indexOf("cover-brief-card");
  const stage = studio.indexOf("cover-rebuild-stage");
  assert.ok(model > 0 && model < mode && mode < source && source < ratio && ratio < brief && brief < stage);
  assert.doesNotMatch(studio, /cover-select-card/u);
  for (const label of ["卡通风格", "卡通搞怪", "文案直出", "参考模板", "上传参考图"]) assert.ok(studio.includes(label), `missing ${label}`);
  assert.doesNotMatch(studio, /参考创作|内置模板/u);
  assert.match(studio, /usesBuiltInTemplate/u);
  assert.match(studio, /usesUploadedReference/u);
  assert.equal((studio.match(/"生成封面"/gu) || []).length, 1);
  assert.doesNotMatch(studio, />生成封面方案<|>生成新封面<|aria-label="封面标题"|aria-label="封面副标题"|<span>封面标题<|<span>封面副标题</u);
  assert.match(studio, /className="cover-copy-result-editor" aria-label="拆解结果"/u);
  assert.match(studio, /画面描述（高级）/u);
});

check("title auxiliary copy and generation prompt are derived only after the explicit analysis action", () => {
  assert.match(studio, /onClick=\{analyzeBrief\}/u);
  assert.match(studio, /const nextTitle = makeTitle\(briefText, pattern, coverModeId\)/u);
  assert.match(studio, /const nextSubtitle = makeSubtitle\(briefText, pattern, coverModeId\)/u);
  assert.match(studio, /setPrompt\(buildCoverPrompt\(/u);
  assert.match(studio, /setAnalysisFingerprint\(coverAnalysisFingerprint/u);
});

check("reference creation sends exactly one active reference and preserves stable storage keys", () => {
  assert.match(studio, /readCoverReferenceAsDataUrl\(layoutTemplate\.previewImage, "模板参考图"\)/u);
  assert.match(studio, /const referenceImageUrls = usesBuiltInTemplate[\s\S]*?\? \[templateReference\]\.filter\(Boolean\)[\s\S]*?: usesUploadedReference && hasReferenceMaterial[\s\S]*?\? \[referenceImage\][\s\S]*?: \[\]/u);
  assert.match(studio, /referenceImageUrls,/u);
  assert.match(studio, /const usesBuiltInTemplate = materialSourceId === "template"/u);
  assert.match(studio, /const usesUploadedReference = materialSourceId === "upload"/u);
  assert.match(studio, /ai-cover-director-draft-v5:/u);
  assert.match(studio, /ai-cover-director-favorite-templates-v1/u);
  assert.match(studio, /ai-cover-director-draft-assets-v1/u);
  assert.match(studio, /clearLegacyCoverEditorDraft/u);
  assert.doesNotMatch(studio, /localStorage\.setItem\(draftKey\(/u);
});

check("desktop workspace keeps the four controls full width above copy and results", () => {
  const canonical = css.slice(css.lastIndexOf("B3 canonical desktop layout"));
  assert.match(canonical, /\.cover-rebuild-shell \.cover-setup-deck\s*\{[\s\S]*?grid-column:\s*1 \/ -1;[\s\S]*?grid-row:\s*1/u);
  assert.match(canonical, /\.cover-rebuild-shell \.cover-setup-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4/u);
  assert.match(canonical, /\.cover-rebuild-shell \.cover-director-panel\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*2/u);
  assert.match(canonical, /\.cover-rebuild-shell \.cover-rebuild-stage\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?grid-row:\s*2/u);
  assert.match(canonical, /\.cover-rebuild-shell \.cover-template-library-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(6[\s\S]*?overflow-y:\s*auto/u);
  assert.match(css, /\.cover-rebuild-shell \.cover-template-launch-thumb img\s*\{[\s\S]*?object-fit:\s*contain/u);
  assert.match(canonical, /\.cover-rebuild-shell \.cover-template-library-option > img\s*\{[\s\S]*?object-fit:\s*contain;[\s\S]*?object-position:\s*center/u);
  assert.match(canonical, /Desktop legibility floor[\s\S]*?\.cover-rebuild-shell \.cover-rebuild-brand small,[\s\S]*?\.cover-rebuild-shell \.cover-decomposition-tools button,[\s\S]*?font-size:\s*11px/u);
  assert.match(css, /\.cover-rebuild-shell \.cover-toast\s*\{[\s\S]*?position:\s*fixed/u);
});

check("automatic title extraction does not invent a numbered list", () => {
  assert.match(studio, /return match\?\.\[0\] \?\? ""/u);
  assert.doesNotMatch(studio, /return match\?\.\[0\] \?\? "3"/u);
  assert.ok(studio.includes("狗狗摇尾巴\\n不只是在开心"));
  assert.ok(studio.includes("小狗不会说话\\n却用一生爱你"));
});

type Viewport = { width: number; height: number };
type ThemeCase = { id: "lattice" | "crystal-aurora" | "soft-white"; mode: "dark" | "light"; label: string };

const FLAGSHIP_LABELS = ["GPT Image 2.5", "Banana", "豆包 5.0"] as const;
const VIEWPORTS: Viewport[] = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const THEMES: ThemeCase[] = [
  { id: "lattice", mode: "dark", label: "深空晶" },
  { id: "crystal-aurora", mode: "dark", label: "黑曜霓彩" },
  { id: "soft-white", mode: "light", label: "柔光白" },
];

function relativeLuminance(rgb: string) {
  const channels = rgb.match(/[\d.]+/gu)?.slice(0, 3).map(Number) || [];
  assert.equal(channels.length, 3, `cannot read RGB color: ${rgb}`);
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

async function assertReadableCover(page: Page, theme: ThemeCase, viewport: Viewport) {
  const metrics = JSON.parse(await page.evaluate<string>(`JSON.stringify((() => {
    const root = document.documentElement;
    const shell = document.querySelector(".cover-rebuild-shell");
    const topbar = document.querySelector(".cover-rebuild-topbar");
    const brand = document.querySelector(".cover-rebuild-brand strong");
    const workspace = document.querySelector(".cover-rebuild-workspace");
    const setup = document.querySelector(".cover-setup-deck");
    const director = document.querySelector(".cover-director-panel");
    const stage = document.querySelector(".cover-rebuild-stage");
    const generate = document.querySelector(".cover-generate-submit");
    const stageToolbar = document.querySelector(".cover-stage-toolbar");
    const mainState = document.querySelector(".cover-main-state");
    const mainStateTitle = mainState ? mainState.querySelector("strong") : null;
    if (!shell || !topbar || !brand || !workspace || !setup || !director || !stage || !generate || !stageToolbar || !mainState || !mainStateTitle) throw new Error("cover shell is incomplete");
    const box = (element) => {
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const effectiveBackground = (element) => {
      let current = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        const channels = color.match(/[\d.]+/g)?.map(Number) || [];
        if (channels.length >= 3 && (channels.length < 4 || channels[3] > .05)) return color;
        current = current.parentElement;
      }
      return "rgb(255, 255, 255)";
    };
    const setupCards = Array.from(setup.querySelectorAll(".cover-setup-card")).map(box);
    const verticalOffenders = Array.from(document.body.querySelectorAll("*"))
      .map((element) => ({ element, rect: element.getBoundingClientRect(), style: getComputedStyle(element) }))
      .filter(({ rect, style }) => rect.height > 0 && rect.bottom > window.innerHeight + 1 && style.position !== "fixed")
      .sort((left, right) => right.rect.bottom - left.rect.bottom)
      .slice(0, 8)
      .map(({ element, rect, style }) => ({
        selector: element.tagName.toLowerCase() + (element.id ? "#" + element.id : "") + Array.from(element.classList).slice(0, 3).map((name) => "." + name).join(""),
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        position: style.position,
      }));
    const visibleTextBelowFloor = Array.from(document.querySelectorAll("button, input, textarea, select, small, em, .cover-card-title, .cover-auto-plan-status"))
      .filter((element) => {
        const value = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return value.width > 0 && value.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Boolean((element.textContent || element.getAttribute("aria-label") || "").trim());
      })
      .map((element) => ({ label: (element.textContent || element.getAttribute("aria-label") || element.tagName).trim().slice(0, 48), size: Number.parseFloat(getComputedStyle(element).fontSize) }))
      .filter((item) => item.size < 11)
      .sort((left, right) => left.size - right.size)
      .slice(0, 32);
    return {
      theme: root.getAttribute("data-theme"), mode: root.getAttribute("data-mode"),
      documentOverflowX: root.scrollWidth - root.clientWidth, documentOverflowY: root.scrollHeight - root.clientHeight,
      shellOverflowX: shell.scrollWidth - shell.clientWidth,
      workspaceOverflowY: workspace.scrollHeight - workspace.clientHeight,
      directorOverflowY: director.scrollHeight - director.clientHeight,
      directorOverflowStyle: getComputedStyle(director).overflowY,
      workspaceChildren: workspace.children.length,
      workspaceColumns: getComputedStyle(workspace).gridTemplateColumns,
      workspaceRows: getComputedStyle(workspace).gridTemplateRows,
      setup: box(setup), director: box(director), stage: box(stage), generate: box(generate), setupCards,
      shellBackground: getComputedStyle(shell).backgroundColor,
      topbarBackground: getComputedStyle(topbar).backgroundColor,
      brandColor: getComputedStyle(brand).color,
      stageToolbarBackground: getComputedStyle(stageToolbar).backgroundColor,
      mainStateBackground: getComputedStyle(mainState).getPropertyValue("--cover-stage-surface-raised").trim() || effectiveBackground(mainState),
      mainStateTitleColor: getComputedStyle(mainStateTitle).color,
      verticalOffenders,
      visibleTextBelowFloor,
    };
  })())`));

  assert.equal(metrics.theme, theme.id);
  assert.equal(metrics.mode, theme.mode);
  assert.ok(metrics.documentOverflowX <= 1, `${theme.label} ${viewport.width} document x overflow ${metrics.documentOverflowX}`);
  assert.ok(metrics.documentOverflowY <= 1, `${theme.label} ${viewport.width} document y overflow ${metrics.documentOverflowY}: ${JSON.stringify({ workspace: metrics.workspaceRows, setup: metrics.setup, director: metrics.director, stage: metrics.stage, offenders: metrics.verticalOffenders })}`);
  assert.ok(metrics.shellOverflowX <= 1, `${theme.label} ${viewport.width} shell x overflow ${metrics.shellOverflowX}`);
  assert.ok(metrics.workspaceOverflowY <= 1, `${theme.label} ${viewport.width} workspace y overflow ${metrics.workspaceOverflowY}`);
  assert.ok(metrics.directorOverflowY <= 1, `${theme.label} ${viewport.width} left rail overflow ${metrics.directorOverflowY}`);
  assert.equal(metrics.directorOverflowStyle, "hidden", `${theme.label} left rail must not scroll`);
  assert.equal(metrics.workspaceChildren, 3);
  assert.equal(metrics.workspaceColumns.trim().split(/\s+/u).length, 2, metrics.workspaceColumns);
  assert.equal(metrics.workspaceRows.trim().split(/\s+/u).length, 2, metrics.workspaceRows);
  assert.ok(metrics.setup.left <= metrics.director.left + 1 && metrics.setup.right >= metrics.stage.right - 1, "settings must span the full workspace width");
  assert.ok(metrics.setup.bottom <= metrics.director.top + 1 && metrics.setup.bottom <= metrics.stage.top + 1, "settings must stay above copy and results");
  assert.ok(Math.abs(metrics.director.top - metrics.stage.top) <= 1, "copy and result workspaces must align below settings");
  assert.ok(metrics.director.right <= metrics.stage.left + 1, "copy and result workspaces must not overlap");
  assert.equal(metrics.setupCards.length, 4);
  assert.ok(Math.max(...metrics.setupCards.map((card: { height: number }) => card.height)) - Math.min(...metrics.setupCards.map((card: { height: number }) => card.height)) <= 1, "four setup cards must have equal height");
  for (const card of metrics.setupCards) assert.ok(card.top >= 0 && card.bottom <= viewport.height + 1, `setup card is outside viewport: ${JSON.stringify(card)}`);
  assert.ok(metrics.generate.top >= 0 && metrics.generate.bottom <= viewport.height + 1, "generate action must be visible without scrolling");
  assert.deepEqual(metrics.visibleTextBelowFloor, [], `unreadable text: ${JSON.stringify(metrics.visibleTextBelowFloor)}`);

  const shellLuminance = relativeLuminance(metrics.shellBackground);
  assert.ok(theme.mode === "light" ? shellLuminance > 0.72 : shellLuminance < 0.18, metrics.shellBackground);
  const brandContrast = (Math.max(relativeLuminance(metrics.brandColor), relativeLuminance(metrics.topbarBackground)) + 0.05) / (Math.min(relativeLuminance(metrics.brandColor), relativeLuminance(metrics.topbarBackground)) + 0.05);
  assert.ok(brandContrast >= 4.5, `${theme.label} brand contrast ${brandContrast.toFixed(2)}`);
  const emptyStateContrast = (Math.max(relativeLuminance(metrics.mainStateTitleColor), relativeLuminance(metrics.mainStateBackground)) + 0.05) / (Math.min(relativeLuminance(metrics.mainStateTitleColor), relativeLuminance(metrics.mainStateBackground)) + 0.05);
  assert.ok(emptyStateContrast >= 4.5, `${theme.label} empty state contrast ${emptyStateContrast.toFixed(2)} (${metrics.mainStateTitleColor} on ${metrics.mainStateBackground})`);
  const toolbarLuminance = relativeLuminance(metrics.stageToolbarBackground);
  assert.ok(theme.mode === "light" ? toolbarLuminance > 0.72 : toolbarLuminance < 0.22, metrics.stageToolbarBackground);
  return metrics;
}

async function verifyLive() {
  const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
  const baseOrigin = new URL(baseUrl).origin;
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  const localBuildId = fs.readFileSync(path.join(root, ".next", "BUILD_ID"), "utf8").trim();
  const versionResponse = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(20_000) });
  assert.ok(versionResponse.ok, `local version unavailable: ${versionResponse.status}`);
  const version = await versionResponse.json() as { buildId?: string };
  assert.equal(version.buildId, localBuildId, "served runtime is not the current local build");

  const evidenceDir = path.resolve(root, ".codex-evidence", "cover-unified-theme-live");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const scenarios: Array<Record<string, unknown>> = [];
  const providerCalls: string[] = [];
  const blockedWrites: string[] = [];
  const externalRequests: string[] = [];
  const browserErrors: string[] = [];
  const httpErrors: string[] = [];
  const passiveTelemetry: Array<{ theme: string; viewport: number; problemType: string; severity: string; description: string }> = [];

  try {
    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({ viewport, serviceWorkers: "block", colorScheme: theme.mode });
        await context.addInitScript(({ themeId, authToken }) => {
          localStorage.setItem("app_theme", themeId);
          localStorage.setItem("user_theme_preference", themeId);
          localStorage.removeItem("app_mode");
          localStorage.setItem("auth_token", authToken);
          for (const key of Object.keys(localStorage)) if (key.startsWith("ai-cover-director-draft-v5:")) localStorage.removeItem(key);
        }, { themeId: theme.id, authToken: token });
        const page = await context.newPage();
        page.on("pageerror", (error) => browserErrors.push(`${theme.id}/${viewport.width}: ${error.message}`));
        page.on("response", (response) => {
          if (response.status() >= 400) httpErrors.push(`${theme.id}/${viewport.width}: ${response.status()} ${new URL(response.url()).pathname}`);
        });
        page.on("console", (message) => {
          if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) browserErrors.push(`${theme.id}/${viewport.width}: ${message.text()}`);
        });
        await page.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (!["http:", "https:"].includes(url.protocol)) return route.continue();
          if (url.origin !== baseOrigin) {
            externalRequests.push(request.url());
            return route.abort("blockedbyclient");
          }
          if (request.method() === "POST" && url.pathname === "/api/diagnostic-logs") {
            let payload: Record<string, unknown> = {};
            try {
              payload = request.postDataJSON() as Record<string, unknown>;
            } catch {
              payload = {};
            }
            passiveTelemetry.push({
              theme: theme.id,
              viewport: viewport.width,
              problemType: String(payload.problem_type || "unknown"),
              severity: String(payload.severity || "unknown"),
              description: String(payload.description || "").slice(0, 240),
            });
            return route.fulfill({ status: 204, body: "" });
          }
          if (request.method() === "GET" && url.pathname === "/api/auth/me") {
            const identity = await route.fetch();
            assert.ok(identity.ok(), `local administrator identity unavailable: ${identity.status()}`);
            const payload = await identity.json() as { user?: Record<string, unknown> };
            assert.ok(payload.user && typeof payload.user.id === "string", "local administrator identity is incomplete");
            return route.fulfill({
              response: identity,
              contentType: "application/json; charset=utf-8",
              body: JSON.stringify({
                ...payload,
                user: {
                  ...payload.user,
                  themePreference: theme.id,
                  theme_preference: theme.id,
                },
              }),
            });
          }
          if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
            const requestLabel = `${request.method()} ${url.pathname}`;
            blockedWrites.push(requestLabel);
            if (/\/(?:generate|image-generation|cover\/attempt|cover\/render)(?:\/|$)/iu.test(url.pathname)) providerCalls.push(requestLabel);
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });

        try {
          const response = await page.goto(`${baseUrl}/cover?zero-cost-theme-check=1`, { waitUntil: "domcontentloaded", timeout: 45_000 });
          assert.equal(response?.status(), 200);
          await page.locator(".cover-rebuild-shell").waitFor({ state: "visible" });
          await page.locator("[data-theme-switcher-trigger='true']").waitFor({ state: "visible" });
          const flagshipButtons = page.locator(".cover-flagship-models button");
          await flagshipButtons.first().waitFor({ state: "visible" });
          await page.waitForFunction(async (labels) => {
            if (!labels.every((label) => [...document.querySelectorAll(".cover-flagship-models button")]
              .some((button) => button.textContent?.includes(label)))) return false;
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            return labels.every((label) => [...document.querySelectorAll(".cover-flagship-models button")]
              .some((button) => button.textContent?.includes(label)));
          }, FLAGSHIP_LABELS, { timeout: 20_000 });
          const modelLabels = await flagshipButtons.allTextContents();
          for (const label of FLAGSHIP_LABELS) assert.ok(modelLabels.some((option) => option.includes(label)), `${label} is missing`);
          const enabledFlagshipCount = await flagshipButtons.evaluateAll((buttons) => buttons.filter((button) => !(button as HTMLButtonElement).disabled).length);
          const activeFlagshipCount = await page.locator(".cover-flagship-models button.is-active").count();
          assert.equal(activeFlagshipCount, enabledFlagshipCount > 0 ? 1 : 0, "Flagship selection must match current generation admission");
          assert.ok(await page.locator(".cover-more-models summary").count() <= 1);
          assert.equal(await page.getByLabel("封面标题").count(), 0);
          assert.equal(await page.getByLabel("封面副标题").count(), 0);

          const modeButtons = page.locator(".cover-mode-switch button");
          assert.equal(await modeButtons.count(), 2);
          await page.getByRole("button", { name: /^卡通搞怪/u }).click();
          assert.equal(await page.locator(".cover-mode-switch button.is-active").count(), 1);
          const sourceButtons = page.locator(".cover-source-options button");
          assert.equal(await sourceButtons.count(), 3);
          assert.equal(await page.locator(".cover-source-options button.is-active").count(), 1);
          await page.getByRole("button", { name: /^参考模板/u }).click();
          await page.locator(".cover-reference-dock").waitFor({ state: "visible" });
          assert.equal(await page.locator(".cover-source-options button.is-active").count(), 1);
          await page.getByRole("button", { name: "浏览模板库", exact: true }).click();
          const templateDialog = page.locator(".cover-template-library-dialog");
          await templateDialog.waitFor({ state: "visible" });
          await page.waitForFunction(() => {
            const dialog = document.querySelector<HTMLElement>(".cover-template-library-dialog");
            const entrance = dialog?.getAnimations()[0];
            return !entrance || entrance.playState === "finished";
          }, undefined, { timeout: 2_000 });
          const visibleTemplates = page.locator(".cover-template-library-option");
          const visibleTemplateCount = await visibleTemplates.count();
          assert.equal(visibleTemplateCount, 112, "The complete reference-template catalog should be available");
          await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".cover-template-library-option > img")].every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0), undefined, { timeout: 20_000 });
          const templateImageStyles = await page.locator(".cover-template-library-option > img").evaluateAll((images) => images.map((image) => {
            const style = getComputedStyle(image);
            const box = image.getBoundingClientRect();
            return { objectFit: style.objectFit, objectPosition: style.objectPosition, width: box.width, height: box.height };
          }));
          for (const image of templateImageStyles) {
            assert.equal(image.objectFit, "contain");
            assert.ok(image.objectPosition.includes("50%"), image.objectPosition);
            assert.ok(image.width > 0 && image.height > 0, JSON.stringify(image));
          }
          const dialogBox = await templateDialog.boundingBox();
          const templateLayout = await page.evaluate(() => {
            const dialog = document.querySelector<HTMLElement>(".cover-template-library-dialog");
            const backdrop = document.querySelector<HTMLElement>(".cover-template-library-backdrop");
            const shell = document.querySelector<HTMLElement>(".cover-rebuild-shell");
            const dialogRect = dialog?.getBoundingClientRect();
            const backdropRect = backdrop?.getBoundingClientRect();
            const shellRect = shell?.getBoundingClientRect();
            return {
              dialog: dialog && dialogRect ? { box: { x: dialogRect.x, y: dialogRect.y, width: dialogRect.width, height: dialogRect.height, right: dialogRect.right, bottom: dialogRect.bottom }, position: getComputedStyle(dialog).position, transform: getComputedStyle(dialog).transform, zoom: getComputedStyle(dialog).zoom, overflow: getComputedStyle(dialog).overflow } : null,
              backdrop: backdrop && backdropRect ? { box: { x: backdropRect.x, y: backdropRect.y, width: backdropRect.width, height: backdropRect.height, right: backdropRect.right, bottom: backdropRect.bottom }, position: getComputedStyle(backdrop).position, transform: getComputedStyle(backdrop).transform, zoom: getComputedStyle(backdrop).zoom, overflow: getComputedStyle(backdrop).overflow } : null,
              shell: shell && shellRect ? { box: { x: shellRect.x, y: shellRect.y, width: shellRect.width, height: shellRect.height, right: shellRect.right, bottom: shellRect.bottom }, position: getComputedStyle(shell).position, transform: getComputedStyle(shell).transform, zoom: getComputedStyle(shell).zoom, overflow: getComputedStyle(shell).overflow } : null,
              document: {
                clientWidth: document.documentElement.clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
                clientHeight: document.documentElement.clientHeight,
                scrollHeight: document.documentElement.scrollHeight,
              },
            };
          });
          assert.ok(
            dialogBox
              && dialogBox.x >= 0
              && dialogBox.y >= 0
              && dialogBox.x + dialogBox.width <= viewport.width + 1
              && dialogBox.y + dialogBox.height <= viewport.height + 1,
            `template dialog must fit viewport: ${JSON.stringify({ dialogBox, viewport, templateLayout })}`,
          );
          await page.keyboard.press("Escape");
          await templateDialog.waitFor({ state: "hidden" });

          await page.getByRole("button", { name: /^上传参考图/u }).first().click();
          await page.locator(".cover-reference-dock.is-upload").waitFor({ state: "visible" });
          assert.equal(await page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]').count(), 1);
          await page.getByRole("button", { name: /^文案直出/u }).click();
          assert.equal(await page.locator(".cover-reference-dock").count(), 0);

          const brief = page.getByRole("textbox", { name: "输入文案" });
          await brief.fill("很多人以为狗狗摇尾巴就是开心，其实方向和速度藏着完全不同的情绪信号。今天用三个动作，教你快速看懂狗狗的真实情绪。");
          const generateButton = page.getByRole("button", { name: "生成封面", exact: true });
          assert.equal(await generateButton.count(), 1);
          assert.equal(await generateButton.isDisabled(), true, "generation must wait for the explicit analysis action");
          await page.getByRole("button", { name: "拆解文案", exact: true }).click();
          await page.locator(".cover-decomposition-editor.is-ready").waitFor({ state: "visible", timeout: 10_000 });
          const decomposition = page.getByRole("textbox", { name: "拆解结果" });
          assert.match(await decomposition.inputValue(), /狗狗摇尾巴\s*\n\s*真是在开心\?/u);
          assert.equal(await page.locator(".cover-prompt-editor").count(), 0);
          await page.getByRole("button", { name: /^画面描述（高级）/u }).click();
          const advancedPrompt = page.getByRole("textbox", { name: "拆解后的画面描述" });
          await advancedPrompt.waitFor({ state: "visible" });
          assert.ok((await advancedPrompt.inputValue()).length > 100);
          await page.getByRole("button", { name: /^9:16/u }).click();
          assert.equal(await generateButton.isDisabled(), true, "ratio changes must invalidate the old analysis without locking the editor");
          await page.getByRole("button", { name: "拆解文案", exact: true }).click();
          assert.equal(await generateButton.isEnabled(), true, "the refreshed analysis should enable the real generation action without submitting it");
          const enabledModels = page.locator(".cover-flagship-models button:not([disabled])");
          if (await enabledModels.count() > 1) await enabledModels.nth(1).click();
          assert.equal(await page.locator(".cover-flagship-models button.is-active").count(), 1);
          assert.ok(await page.locator(".cover-rebuild-shell svg:visible").count() >= 8);

          const screenshot = path.join(evidenceDir, `${theme.id}-${viewport.width}x${viewport.height}.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          const metrics = await assertReadableCover(page, theme, viewport);
          scenarios.push({ theme: theme.id, viewport, screenshot, metrics, modelOptions: modelLabels.length, templatePageSize: visibleTemplateCount, explicitAnalysisReady: true });
        } finally {
          await page.unrouteAll({ behavior: "wait" }).catch(() => undefined);
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(externalRequests, [], `external requests: ${externalRequests.join(", ")}`);
  assert.deepEqual(blockedWrites, [], `write requests: ${blockedWrites.join(", ")}`);
  assert.deepEqual(providerCalls, [], `provider calls: ${providerCalls.join(", ")}`);
  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join(" | ")}; http errors: ${httpErrors.join(" | ")}`);
  assert.deepEqual(httpErrors, [], `http errors: ${httpErrors.join(" | ")}`);
  assert.deepEqual(passiveTelemetry, [], `unexpected passive telemetry: ${JSON.stringify(passiveTelemetry)}`);
  const report = {
    passed: true, runningLatest: true, buildId: localBuildId, scenarios,
    providerCalls: 0, paidRequests: 0, databaseMutations: 0, externalRequests: 0, browserErrors: 0,
    passiveTelemetry,
  };
  fs.writeFileSync(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function main() {
  const live = process.argv.includes("--live") ? await verifyLive() : null;
  console.log(JSON.stringify({ passed: true, checks, live, providerCalls: live?.providerCalls ?? 0, paidRequests: 0, productionWrites: live?.databaseMutations ?? 0 }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
