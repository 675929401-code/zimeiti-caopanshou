import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const origin = process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000";
assert.equal(origin, "http://127.0.0.1:5000");
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "null");
assert.ok(token && identity?.user?.id && identity.user.role === "admin");
const run = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
const directory = path.resolve(".codex-evidence/cover-db-20261106-e29b/browser", run);
await fs.mkdir(directory, { recursive: true });
const report = { scope: "authenticated-local-rendered-pages-readonly", at: new Date().toISOString(),
  run, cases: [], errors: [], blockedWrites: [], fixtureRequests: [], paidCalls: 0, providerCalls: 0, businessMutations: 0,
  boundary: "Real authenticated page rendering; material/history/image/preview fixtures are explicitly marked. Every real write, analysis, generation and external request is blocked. Fixtures do not prove real upload, model generation, save or download delivery." };
const clean = value => String(value).split(token).join("[redacted]")
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted]").slice(0, 300);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token); localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token, user: identity.user });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (url.pathname === "/api/auth/me") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, user: identity.user }) });
    if (!["GET", "HEAD"].includes(request.method())) {
      report.blockedWrites.push({ path: url.pathname, method: request.method() });
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Read-only visual acceptance" }) });
    }
    if (/^\/api\/(?:llm(?:\/|$)|image\/generate(?:\/|$)|cover\/prepare(?:\/|$))/u.test(url.pathname)) {
      report.blockedWrites.push({ path: url.pathname, method: request.method(), reason: "analysis/generation/preparation forbidden in visual-only run" });
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Visual acceptance forbids analysis and generation" }) });
    }
    if (/\/(?:attempt|poll|status|recover)(?:\/|$)/u.test(url.pathname)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeAttempt: null, success: true }) });
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(clean(error.message)));
  const preview = page.locator('section[aria-label="封面预览与标题编辑"]');
  const expectHiddenEditing = async ({ downloadsHidden = true } = {}) => {
    assert.equal(await preview.locator("#cover-workbench-title:visible").count(), 0, "title input must remain hidden until optional editing is opened");
    assert.equal(await preview.locator('input[type="range"]:visible').count(), 0, "layout sliders must remain hidden until optional editing is opened");
    assert.equal(await preview.getByRole("button", { name: "保存排版", exact: true }).count(), 0, "save action must remain hidden until optional editing is opened");
    if (downloadsHidden) assert.equal(await preview.getByRole("button", { name: /下载/u }).count(), 0, "download action must not appear in the empty state");
  };
  let fixtureScreenshot = false;
  const screenshot = async name => {
    await page.evaluate(() => window.scrollTo(0, 0));
    if (fixtureScreenshot) await page.evaluate(() => {
      const badge = document.createElement("div"); badge.id = "readonly-visual-fixture-evidence-badge";
      badge.textContent = "只读视觉夹具 · 不代表真实生成、保存或下载验收";
      Object.assign(badge.style, { position: "fixed", zIndex: "2147483647", right: "12px", top: "8px", padding: "6px 10px",
        font: "12px sans-serif", color: "#fff", background: "#694115", borderRadius: "6px", pointerEvents: "none" });
      document.body.appendChild(badge);
    });
    try { await page.screenshot({ path: path.join(directory, name), fullPage: false }); }
    finally { if (fixtureScreenshot) await page.evaluate(() => document.getElementById("readonly-visual-fixture-evidence-badge")?.remove()); }
  };
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/cover`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/cover");
    await page.waitForFunction(() => document.querySelector("select option[value^='pm_']"));
    for (const theme of ["soft-white", "lattice", "crystal-aurora"]) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.mode = theme === "soft-white" ? "light" : "dark";
      }, theme);
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => {
        const heading = [...document.querySelectorAll("h1")].find(node => node.textContent === "封面工作台");
        const root = heading.closest("header").parentElement;
        const primary = [...root.querySelectorAll("button")].find(node => node.textContent.trim() === "生成封面");
        const bounds = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
        return { root: bounds(root), primary: primary && bounds(primary),
          primaryColor: primary && getComputedStyle(primary).backgroundColor,
          color: getComputedStyle(root).color, background: getComputedStyle(root).backgroundColor,
          width: innerWidth, height: innerHeight,
          overflow: document.documentElement.scrollWidth > innerWidth + 2,
          models: [...root.querySelectorAll("option[value^='pm_']")].map(node => node.textContent),
          sizes: [...root.querySelectorAll("button")].filter(node => /^(16:9|9:16|4:3|3:4)/u.test(node.textContent.trim())).map(node => node.textContent.trim()),
        };
      });
      assert.equal(metrics.overflow, false, `horizontal overflow: ${theme}`);
      assert.ok(metrics.primary && metrics.primary.bottom <= viewport.height + 2 && metrics.primary.y >= 0, `primary not in viewport: ${theme}`);
      assert.equal(metrics.sizes.length, 4);
      assert.ok(metrics.models.length >= 1);
      await expectHiddenEditing();
      assert.equal(await preview.getByText("封面标题", { exact: true }).count(), 0);
      const progress = await page.locator('[aria-label="封面制作进度"] ol > li').evaluateAll(nodes => nodes.map(node => ({ text: node.innerText, state: node.dataset.state })));
      assert.equal(progress.length, 3, "actual three-step progress is required");
      for (const [index, label] of ["拆解内容", "制作画面", "排版保存"].entries()) {
        assert.ok(progress[index].text.includes(label), `missing workflow step ${label}`);
        assert.equal(progress[index].state, "pending", "empty workbench must not claim completed work");
      }
      const filename = `cover-${viewport.width}-${theme}.png`;
      await screenshot(filename);
      report.cases.push({ route: "/cover", scope: "real rendered empty workbench", theme, viewport, metrics, progress,
        editingHidden: true, downloadHidden: true, screenshot: filename });
      const modeBar = page.getByRole("navigation", { name: "封面制作方式" });
      assert.equal(await modeBar.getByRole("button").count(), 4);
      await page.locator("#cover-workbench-text").fill("一本书改变了我的生活：先把小事做好，再慢慢接近目标。");
      for (const [mode, label] of [["script", "口播生成"], ["product", "商品封面"], ["reference", "参考封面"], ["background", "原图排版"]]) {
        await modeBar.getByRole("button", { name: label, exact: true }).click();
        assert.equal(await modeBar.locator(`[data-scenario="${mode}"]`).getAttribute("aria-pressed"), "true");
        assert.ok((await page.locator("#cover-workbench-text").inputValue()).includes("一本书"), "switching must preserve text");
        assert.equal(await page.locator('input[type="file"]').count(), mode === "script" ? 0 : 1);
        assert.equal(await page.locator("#cover-workbench-model").isDisabled(), mode === "background");
        assert.equal(await page.locator("#cover-workbench-resolution").isDisabled(), mode === "background");
        assert.equal(await page.locator("#cover-workbench-style").isDisabled(), mode !== "script");
        if (mode !== "script") assert.equal(await page.locator("#cover-workbench-style").inputValue(), "__custom__");
        assert.equal(await page.getByLabel("添加封面图片，支持选择、拖入或粘贴").count(), mode === "script" ? 0 : 1);
        if (mode === "reference" || mode === "background") {
          assert.equal(await page.getByRole("button", { name: "生成封面", exact: true }).isDisabled(), true, "required image must gate creation");
        }
        if (mode === "product") await page.getByText("选填", { exact: true }).first().waitFor();
        const layout = await modeBar.evaluate(node => {
          const r = node.getBoundingClientRect();
          return { width: r.width, height: r.height, overflow: document.documentElement.scrollWidth > innerWidth + 2,
            options: [...node.querySelectorAll("button")].map(button => ({ label: button.ariaLabel, y: button.getBoundingClientRect().y })) };
        });
        assert.equal(layout.overflow, false);
        assert.equal(new Set(layout.options.map(option => Math.round(option.y))).size, 1, "desktop modes must remain in one row");
        const modeScreenshot = `cover-${viewport.width}-${theme}-${mode}.png`;
        await screenshot(modeScreenshot);
        report.cases.push({ route: "/cover", scope: "real rendered four-scenario input contract", mode, theme, viewport, layout,
          textPreserved: true, requiredImageGated: ["reference", "background"].includes(mode), screenshot: modeScreenshot });
      }
      await modeBar.getByRole("button", { name: "口播生成", exact: true }).click();
      await page.locator("#cover-workbench-text").fill("");
    }
  }
  // Explicit read-only material fixtures exercise the actual workbench. They
  // do not claim real upload, analysis, generation, storage or delivery.
  const fixturePng = await sharp({ create: { width: 1080, height: 1440, channels: 3, background: "#f2eee6" } }).png().toBuffer();
  fixtureScreenshot = true;
  await page.route("**/api/storage/files/*/content", route => {
    report.fixtureRequests.push({ path: "/api/storage/files/:fixture/content", scope: "material/background image bytes" });
    return route.fulfill({ status: 200, contentType: "image/png", body: fixturePng });
  });
  await page.route("**/api/cover/preview", route => {
    report.fixtureRequests.push({ path: "/api/cover/preview", scope: "in-memory preview only; no actual renderer/storage call" });
    return route.fulfill({ status: 200, contentType: "image/png", body: fixturePng });
  });
  const draftKey = `cover-workbench-draft-v2:${identity.user.id}`;
  const fixtureAssets = [
    { assetId: "00000000-0000-4000-8000-000000000001", role: "background_canvas", name: "验收背景.png", width: 1080, height: 1440 },
    { assetId: "00000000-0000-4000-8000-000000000002", role: "style_reference", name: "验收参考.png", width: 1080, height: 1440 },
  ];
  const setDraft = async (assets, title = "", scenario, imageMode) => {
    await page.evaluate(({ key, userId, assets, title, scenario, imageMode }) => localStorage.setItem(key, JSON.stringify({
      schemaVersion: "cover-browser-draft/2", userId, text: "随行杯，日常轻松搭配。", title, manualTitle: Boolean(title),
      styleKey: "cartoon", ratio: "3:4", resolution: "2K", assets, materialRevision: 1, ...(scenario ? { scenario } : {}),
      ...(imageMode ? { imageMode, nextImageNumber: Math.max(1, ...assets.map(asset => (asset.imageNumber || 0) + 1)) } : {}),
    })), { key: draftKey, userId: identity.user.id, assets, title, scenario, imageMode });
    await page.goto(`${origin}/cover`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="封面制作方式"] button:disabled'));
    if (assets.length && scenario !== "script") await page.getByLabel(`${assets[0].name}的图片用途`).waitFor();
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await setDraft(fixtureAssets);
  assert.equal(await page.locator("#cover-workbench-style").isDisabled(), true);
  assert.equal(await page.locator("#cover-workbench-style").inputValue(), "__custom__");
  assert.equal(await page.locator("#cover-workbench-model").isDisabled(), true);
  assert.ok((await page.getByLabel("验收背景.png的图片用途").innerText()).includes("背景图"));
  assert.equal(await page.getByLabel("验收背景.png的图片用途").evaluate(node => node.tagName), "SPAN", "roles are assigned by scenario, not manual selects");
  report.cases.push({ route: "/cover", scope: "read-only material fixture", state: "background plus reference locks image model and animation preset; roles are readable badges" });
  await page.getByRole("button", { name: "参考封面", exact: true }).click();
  assert.equal(await page.locator("#cover-workbench-style").isDisabled(), true);
  assert.equal(await page.locator("#cover-workbench-style").inputValue(), "__custom__");
  assert.equal(await page.locator("#cover-workbench-model").isDisabled(), false);
  assert.equal(await page.getByLabel("验收背景.png的图片用途").inputValue(), "style_reference");
  assert.equal(await page.getByLabel("验收背景.png的图片用途").evaluate(node => node.tagName), "SELECT");
  assert.equal(await page.locator('[data-image-number="1"]').count(), 1, "old drafts receive stable image numbers before custom composition");
  assert.equal(await page.locator('[data-image-number="2"]').count(), 1);
  await expectHiddenEditing();
  console.log(JSON.stringify({diagnosticImgs:await preview.getByRole("img").evaluateAll(nodes=>nodes.map(node=>({tag:node.tagName,alt:node.getAttribute("alt"),role:node.getAttribute("role"),html:node.outerHTML.slice(0,250)})))})); await page.screenshot({path:directory+"/diagnostic-preview.png"}); assert.equal(await preview.getByRole("img").count(), 0, "uploaded composition inputs must not appear as a completed cover");
  report.cases.push({ route: "/cover", scope: "read-only material fixture", state: "reference composition keeps image model selectable, locks animation presets, exposes role hints and stable image numbers; no fake result preview" });
  await page.getByRole("button", { name: "口播生成", exact: true }).click();
  assert.equal(await page.getByLabel("验收背景.png的图片用途").count(), 0);
  await page.getByText("2 张图片已保留在草稿中", { exact: false }).waitFor();
  assert.equal(await page.locator('input[type="file"]').count(), 0);
  await page.getByRole("button", { name: "商品封面", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "智能合成", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("验收背景.png的图片用途").inputValue(), "identity_subject");
  assert.equal(await page.getByLabel("验收参考.png的图片用途").inputValue(), "style_reference");
  assert.equal(await page.locator("#cover-workbench-model").isDisabled(), false);
  assert.equal(await page.locator("#cover-workbench-resolution").isDisabled(), false);
  await expectHiddenEditing();
  await page.getByLabel("验收参考.png的图片用途").selectOption("background_canvas");
  assert.equal(await page.getByLabel("验收参考.png的图片用途").inputValue(), "background_canvas");
  assert.equal(await page.locator("#cover-workbench-model").isDisabled(), false, "background hint in composition must not switch to preserving the source");
  await page.getByRole("button", { name: "保留原图", exact: true }).click();
  assert.ok((await page.getByLabel("验收背景.png的图片用途").innerText()).includes("商品照片"));
  assert.ok((await page.getByLabel("验收参考.png的图片用途").innerText()).includes("参考封面"));
  assert.equal(await page.locator("#cover-workbench-model").isDisabled(), true);
  assert.equal(await page.locator("#cover-workbench-resolution").isDisabled(), true);
  await page.getByRole("button", { name: "智能合成", exact: true }).click();
  assert.equal(await page.locator("#cover-workbench-model").isDisabled(), false);
  await expectHiddenEditing();
  await page.getByRole("button", { name: "原图排版", exact: true }).click();
  assert.ok((await page.getByLabel("验收背景.png的图片用途").innerText()).includes("背景图"));
  assert.equal(await page.locator("#cover-workbench-text").inputValue(), "随行杯，日常轻松搭配。");
  report.cases.push({ route: "/cover", scope: "read-only two-image fixture", state: "mode switching preserves text/images; product defaults to composition with editable roles; preserve mode disables image generation and shows automatic badges; background preserves the whole source" });

  const compositionAssets = [
    { ...fixtureAssets[0], imageNumber: 1, role: "identity_subject" },
    { ...fixtureAssets[1], imageNumber: 2, role: "identity_subject" },
    { assetId: "00000000-0000-4000-8000-000000000004", imageNumber: 3, role: "background_canvas", name: "验收场景.png", width: 1080, height: 1440 },
  ];
  await setDraft(compositionAssets, "", "product", "compose");
  await page.locator("#cover-workbench-text").fill("介绍两位旅行伙伴。@图1 保留第一个人物外观，@图2 保留第二个人物外观，@图3 使用场景，让两人站在右侧。");
  assert.equal(await page.getByLabel("验收背景.png的图片用途").inputValue(), "identity_subject");
  assert.equal(await page.getByLabel("验收参考.png的图片用途").inputValue(), "identity_subject");
  assert.equal(await page.getByLabel("验收场景.png的图片用途").inputValue(), "background_canvas");
  assert.equal(await page.locator("#cover-workbench-model").isDisabled(), false);
  await expectHiddenEditing();
  assert.equal(await preview.getByRole("img").count(), 0);
  report.cases.push({ route: "/cover", scope: "explicit read-only three-image composition fixture", state: "two independent subject hints and one background hint coexist; instructions use image numbers; source images do not expose save/download or a fake finished cover" });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ["soft-white", "lattice", "crystal-aurora"]) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.mode = theme === "soft-white" ? "light" : "dark";
      }, theme);
      await page.getByRole("group", { name: "商品图片处理方式", exact: true }).scrollIntoViewIfNeeded();
      const metrics = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 2,
        labels: [...document.querySelectorAll("[data-image-number]")].map(node => ({ imageNumber: node.dataset.imageNumber,
          hasNumber: node.innerText.includes(`@图${node.dataset.imageNumber}`),
          role: node.querySelector("select")?.value })),
        primaryVisible: [...document.querySelectorAll("button")].filter(node => node.innerText.trim() === "生成封面").every(node => {
          const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 2;
        }) }));
      assert.equal(metrics.overflow, false); assert.equal(metrics.primaryVisible, true);
      assert.deepEqual(metrics.labels.map(label => label.imageNumber), ["1", "2", "3"]);
      assert.equal(metrics.labels.every(label => label.hasNumber), true);
      const filename = `fixture-three-image-compose-${viewport.width}-${theme}.png`;
      await screenshot(filename);
      report.cases.push({ route: "/cover", scope: "explicit read-only three-image composition fixture", theme, viewport, metrics,
        state: "composition/preservation controls and stable role-number labels in the actual themed desktop workbench", screenshot: filename });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "移除图片验收背景.png", exact: true }).click();
  assert.equal(await page.locator('[data-image-number="1"]').count(), 0);
  assert.equal(await page.locator('[data-image-number="2"]').count(), 1);
  assert.equal(await page.locator('[data-image-number="3"]').count(), 1);
  assert.equal(await page.getByLabel("验收参考.png的图片用途").inputValue(), "identity_subject");
  assert.equal(await page.getByLabel("验收场景.png的图片用途").inputValue(), "background_canvas");
  assert.ok((await page.locator("#cover-workbench-text").inputValue()).includes("@图2 保留第二个人物外观"));
  report.cases.push({ route: "/cover", scope: "read-only composition draft fixture", state: "deleting the first image preserves the remaining image numbers, roles and existing text; missing references are not silently retargeted" });
  const appendFixture = async route => {
    report.fixtureRequests.push({ path: "/api/cover/materials", scope: "in-memory upload-response fixture; no material stored" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true,
      assetId: "00000000-0000-4000-8000-000000000005", width: 1080, height: 1440 }) });
  };
  await page.route("**/api/cover/materials", appendFixture);
  await page.locator('input[type="file"]').setInputFiles({ name: "验收追加.png", mimeType: "image/png", buffer: fixturePng });
  await page.locator('[data-image-number="4"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="封面制作方式"] button:disabled'));
  assert.equal(await page.locator('[data-image-number="1"]').count(), 0, "deleted numbers must not be reused");
  await page.waitForFunction(key => {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    return saved?.assets?.some(asset => asset.imageNumber === 4) && saved.nextImageNumber >= 5;
  }, draftKey);
  await page.unroute("**/api/cover/materials", appendFixture);
  await page.goto(`${origin}/cover`, { waitUntil: "networkidle" });
  await page.locator('[data-image-number="4"]').waitFor();
  assert.equal(await page.locator('[data-image-number="2"]').count(), 1);
  assert.equal(await page.locator('[data-image-number="3"]').count(), 1);
  assert.equal(await page.locator('[data-image-number="1"]').count(), 0);
  await expectHiddenEditing();
  report.cases.push({ route: "/cover", scope: "in-memory upload response and browser draft fixture", state: "new image receives the next unused number and draft reload preserves 2/3/4 without renumbering; this does not validate real file upload or storage" });

  let renderAttempts = 0, paidRouteAttempts = 0;
  await page.route("**/api/cover/render", async route => { renderAttempts += 1; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "只读验收阻止保存，未写入作品" }) }); });
  page.on("request", request => { if (["/api/cover/prepare", "/api/llm", "/api/image/generate"].includes(new URL(request.url()).pathname)) paidRouteAttempts += 1; });
  await setDraft([fixtureAssets[0]], "日常轻松搭配");
  await expectHiddenEditing();
  assert.equal(await preview.locator('details[open]').count(), 0, "original-image manual editing must start collapsed");
  await page.getByRole("button", { name: "生成封面", exact: true }).waitFor();
  await preview.getByText("手动填写标题和调整排版（可选）", { exact: true }).click();
  await preview.locator("#cover-workbench-title").waitFor({ state: "visible" });
  assert.equal(await preview.locator('input[type="range"]:visible').count(), 3);
  assert.equal(await preview.locator("#cover-workbench-title").isEditable(), true);
  await preview.locator("#cover-workbench-title").fill("手工修改\nA/B应当保留");
  assert.equal(await preview.locator("#cover-workbench-title").inputValue(), "手工修改\nA/B应当保留");
  const manualSlider = preview.getByRole("slider").first();
  const originalPosition = Number(await manualSlider.inputValue());
  await manualSlider.press("ArrowRight");
  assert.equal(Number(await manualSlider.inputValue()), originalPosition + 1);
  await page.getByText("仅保存排版，无模型调用费用", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('section[aria-label="封面预览与标题编辑"] [aria-busy="true"]'));
  await page.waitForTimeout(700);
  await screenshot("fixture-original-manual-editing-open.png");
  await page.getByRole("button", { name: "生成封面", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("只读验收阻止保存"));
  assert.equal(renderAttempts, 1); assert.equal(paidRouteAttempts, 0);
  report.cases.push({ route: "/cover", scope: "read-only material and preview fixture", state: "manual title editor starts collapsed, opens with usable title/sliders; unified primary targets composition only; actual storage blocked", renderAttempts, paidRouteAttempts,
    screenshot: "fixture-original-manual-editing-open.png" });

  // Busy/uploading gates use suspended fixture responses; no request reaches
  // analysis, material storage or a provider. They exercise actual handlers.
  await setDraft([], "", "product");
  let releaseUpload;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const uploadFixture = async route => {
    report.fixtureRequests.push({ path: "/api/cover/materials", scope: "suspended upload failure fixture; no file storage" });
    await uploadGate;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "只读上传夹具：未写入图片" }) });
  };
  await page.route("**/api/cover/materials", uploadFixture);
  try {
    await page.locator('input[type="file"]').setInputFiles({ name: "只读上传夹具.png", mimeType: "image/png", buffer: fixturePng });
    await page.getByText("正在上传…", { exact: true }).waitFor();
    assert.equal(await page.locator('[aria-label="封面制作方式"] button:disabled').count(), 4);
    assert.equal(await page.locator("#cover-workbench-text").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "生成封面", exact: true }).isDisabled(), true);
    report.cases.push({ route: "/cover", scope: "suspended read-only upload fixture", state: "uploading locks all four modes and material/text mutations; generation is gated" });
  } finally { releaseUpload(); }
  await page.getByText("只读上传夹具：未写入图片", { exact: true }).waitFor();
  await page.unroute("**/api/cover/materials", uploadFixture);
  await page.getByRole("button", { name: "移除图片只读上传夹具.png", exact: true }).click();

  await page.getByRole("button", { name: "口播生成", exact: true }).click();
  let releasePrepare;
  const prepareGate = new Promise(resolve => { releasePrepare = resolve; });
  const prepareFixture = async route => {
    report.fixtureRequests.push({ path: "/api/cover/prepare", scope: "suspended free-preparation failure fixture; no analysis/generation/storage" });
    await prepareGate;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "只读准备夹具：未调用模型" }) });
  };
  await page.route("**/api/cover/prepare", prepareFixture);
  try {
    await page.getByRole("button", { name: "生成封面", exact: true }).click();
    await page.getByRole("button", { name: "准备方案中…", exact: true }).waitFor();
    assert.equal(await page.locator('[aria-label="封面制作方式"] button:disabled').count(), 4);
    assert.equal(await page.locator("#cover-workbench-text").isDisabled(), true);
    const progress = await page.locator('[aria-label="封面制作进度"] li').evaluateAll(nodes => nodes.map(node => node.dataset.state));
    assert.deepEqual(progress, ["pending", "pending", "pending"], "free preparation must not pretend analysis has started");
    report.cases.push({ route: "/cover", scope: "suspended free-preparation fixture", state: "preparing locks scene switches and inputs without claiming analysis completion", progress });
  } finally { releasePrepare(); }
  await page.getByText("只读准备夹具：未调用模型", { exact: true }).waitFor();
  await page.unroute("**/api/cover/prepare", prepareFixture);
  const pendingKey = `cover-workbench-operation-v2:${identity.user.id}`;
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ clientRequestId: "readonly_unknown_original_20261106", phase: "analysis",
    operationId: "00000000-0000-4000-8000-000000000099", materialRevision: 1 })), pendingKey);
  await page.goto(`${origin}/cover`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "查询原任务状态", exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="封面制作方式"] button:disabled').count(), 4);
  assert.equal(await page.locator("#cover-workbench-text").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "生成封面", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "查询原任务状态", exact: true }).isEnabled(), true);
  report.cases.push({ route: "/cover", scope: "read-only unresolved operation reference fixture", state: "unknown original task locks scene switches and creation while original-task query remains available" });
  await page.evaluate(key => localStorage.removeItem(key), pendingKey);

  // Feed the real account-history adapter one explicit editable V2 fixture.
  // Open it through the actual history dialog; never claim it was generated.
  const fixtureHistoryId = "cover_visual_fixture_editable_v2";
  const fixtureTitle = "只读成品夹具 · 可编辑封面";
  const fixturePlan = { title: fixtureTitle, subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-teacher-interview",
    animationStyleId: "pet-3d", coverModeId: "cartoon", materialSourceId: "upload", subjectModeId: "semantic", planVersion: 2,
    outputSpec: { aspectRatio: "3:4", width: 1080, height: 1440, format: "png", fit: "contain" },
    titleStyle: { x: .08, y: .07, width: .84, scale: 1, color: "#583A27" } };
  const fixtureRecord = { id: "cover-visual-fixture-editable-v2", ratio: "3:4", title: fixtureTitle, subtitle: "", prompt: "",
    briefText: "只读视觉验收夹具，不代表真实生成或保存。", source: "生成", createdAt: "2026-11-06T00:00:00.000Z", taskNo: 1,
    status: "done", url: `/api/media-history/content?id=${fixtureHistoryId}`, assetId: "00000000-0000-4000-8000-000000000003",
    backgroundAssetId: fixtureAssets[0].assetId, historyRecordId: fixtureHistoryId, renderPlan: fixturePlan,
    cloudStored: true, outputWidth: 1080, outputHeight: 1440, sourceWidth: 1080, sourceHeight: 1440,
    modelName: "只读成品夹具", resolution: "2K" };
  await page.route("**/api/cover/history**", route => {
    report.fixtureRequests.push({ path: "/api/cover/history", scope: "editable V2 history fixture; not a real generation/save receipt" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [fixtureRecord],
      activeAttempt: null, activeAttempts: [], activeAttemptReady: true, nextPage: null,
      failureHistory: { ready: true, code: "READ_ONLY_VISUAL_FIXTURE", message: "只读视觉验收夹具" } }) });
  });
  await page.route("**/api/media-history/content?**", route => {
    if (new URL(route.request().url()).searchParams.get("id") !== fixtureHistoryId) return route.fallback();
    report.fixtureRequests.push({ path: "/api/media-history/content", scope: "saved-cover image fixture bytes; no real storage download" });
    return route.fulfill({ status: 200, contentType: "image/png", body: fixturePng });
  });
  await page.evaluate(({ draft, pending }) => { localStorage.removeItem(draft); localStorage.removeItem(pending); },
    { draft: draftKey, pending: `cover-workbench-operation-v2:${identity.user.id}` });
  await page.goto(`${origin}/cover`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
  await page.getByRole("button", { name: "历史作品", exact: true }).click();
  const historyDialog = page.getByRole("dialog", { name: "历史作品", exact: true });
  await historyDialog.getByRole("button", { name: new RegExp(fixtureTitle) }).click();
  await historyDialog.waitFor({ state: "hidden" });
  await preview.getByRole("img", { name: `封面：${fixtureTitle}`, exact: true }).waitFor();
  await expectHiddenEditing({ downloadsHidden: false });
  const download = preview.getByRole("button", { name: "下载封面", exact: true });
  await download.waitFor({ state: "visible" });
  assert.equal(await download.isEnabled(), true, "saved fixture can expose download without opening editing");
  assert.equal(await preview.locator('details[open]').count(), 0, "saved cover editor must start collapsed");
  await screenshot("fixture-editable-result-collapsed.png");
  await preview.getByText("调整标题和排版（可选）", { exact: true }).click();
  await preview.locator("#cover-workbench-title").waitFor({ state: "visible" });
  assert.equal(await preview.locator("#cover-workbench-title").inputValue(), fixtureTitle);
  assert.equal(await preview.locator("#cover-workbench-title").isEditable(), true);
  assert.equal(await preview.locator('input[type="range"]:visible').count(), 3);
  assert.equal(await preview.getByRole("button", { name: "保存排版", exact: true }).isVisible(), true);
  await screenshot("fixture-editable-result-expanded.png");
  report.cases.push({ route: "/cover", scope: "explicit read-only editable V2 history/image fixture",
    state: "real history dialog opens fixture; direct download is visible/enabled; title and three sliders appear only after optional editor opens",
    actualGenerationValidated: false, actualSaveValidated: false, actualDownloadDeliveryValidated: false,
    screenshots: ["fixture-editable-result-collapsed.png", "fixture-editable-result-expanded.png"] });
  await page.evaluate(key => localStorage.removeItem(key), draftKey);
  fixtureScreenshot = false;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const route of ["/image-workbench", "/tools?tab=segment", "/youcai/cover"]) {
    await page.goto(origin + route, { waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, new URL(origin + route).pathname, `route redirected: ${route}`);
    const state = await page.evaluate(() => ({ headings: [...document.querySelectorAll("h1,h2")].slice(0, 5).map(node => node.textContent.trim()),
      overflow: document.documentElement.scrollWidth > innerWidth + 2, fatal: /Application error|Unhandled Runtime Error/u.test(document.body.innerText) }));
    assert.equal(state.fatal, false);
    const filename = `adjacent-${route.split("?")[0].replaceAll("/", "-").slice(1)}.png`;
    await screenshot(filename);
    report.cases.push({ route, state, screenshot: filename });
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = clean(error.message); process.exitCode = 1; }
finally { await browser.close(); await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" }); }
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, errors: report.errors, failure: report.failure,
  paidCalls: report.paidCalls, providerCalls: report.providerCalls, businessMutations: report.businessMutations, report: path.join(directory, "report.json") }));
