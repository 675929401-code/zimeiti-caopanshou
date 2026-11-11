import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import sharp from "sharp";

const origin = "http://127.0.0.1:5000";
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "null");
assert.ok(token && identity?.user?.id);
const directory = path.resolve(process.env.COVER_VISUAL_EVIDENCE_DIR || ".codex-evidence/cover-review-browser", new Date().toISOString().replace(/[:.]/gu, "-"));
await fs.mkdir(directory, { recursive: true });
const report = { boundary: "Actual latest page and browser; all workflow/model/style/history/media responses below are explicit fixtures. No real provider, fee or business mutation is permitted.", cases: [], errors: [], blockedWrites: [], requests: [], paidCalls: 0, businessMutations: 0 };
const themeSettleMs = 350;
report.themeCapture = { settleMs: themeSettleMs, globalButtonBackgroundTransitionMs: 200, contrastMinimum: 4.5,
  explanation: "Theme text changes immediately while enabled button backgrounds transition for 200ms. Immediate computed values are diagnostic only; screenshots and readability assertions use the settled theme. Disabled controls are excluded." };

function readCoverButtonColors() {
  const named = [
    ...[...document.querySelectorAll('nav[aria-label="封面制作方式"] button')].map(node => ({ name: `mode:${node.dataset.scenario}`, node, label: node.querySelector("strong") || node })),
    { name: "style-selector", node: document.querySelector("#cover-workbench-style"), label: document.querySelector("#cover-workbench-style strong") },
    { name: "history", node: [...document.querySelectorAll("button")].find(node => node.textContent.trim() === "历史作品") },
    ...[...document.querySelectorAll('section[aria-label="封面预览与标题编辑"] button')]
      .filter(node => ["拆解方案", "封面成品"].includes(node.textContent.trim())).map(node => ({ name: `tab:${node.textContent.trim()}`, node })),
  ];
  return named.map(({ name, node, label }) => {
    if (!node) return { name, missing: true };
    const style = getComputedStyle(node), textStyle = getComputedStyle(label || node);
    const backingLayers = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const backing = getComputedStyle(parent);
      if (backing.backgroundImage !== "none") break;
      backingLayers.push(backing.backgroundColor);
    }
    return { name, disabled: node.matches(":disabled"), selected: node.getAttribute("aria-pressed"),
      color: textStyle.color, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, backingLayers,
      opacity: style.opacity, transition: style.transition, inkToken: style.getPropertyValue("--cw-ink"), panelToken: style.getPropertyValue("--cw-panel") };
  });
}
function rgbColor(value) {
  if (value.startsWith("color(srgb ")) {
    const [channels, alpha] = value.slice(11, -1).split("/");
    const rgb = channels.trim().split(/\s+/u).map(channel => Number(channel) * 255);
    assert.ok(rgb.length === 3 && rgb.every(Number.isFinite), `Invalid sRGB color ${value}`);
    return [...rgb, alpha === undefined ? 1 : Number(alpha.trim())];
  }
  assert.match(value, /^rgba?\(/u, `Unsupported computed color ${value}`);
  const channels = value.match(/[\d.]+/gu).map(Number);
  assert.ok(channels.length === 3 || channels.length === 4);
  return [channels[0], channels[1], channels[2], channels[3] ?? 1];
}
function luminance(rgb) {
  const linear = rgb.slice(0, 3).map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; });
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}
function composite(front, back) { return front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3])); }
function buttonContrastMinimum(colors) {
  const foreground = rgbColor(colors.color), background = rgbColor(colors.backgroundColor);
  // A translucent card may reveal any ancestor gradient. Bounding its backing
  // by black and white proves a lower contrast bound without pretending the
  // computed backgroundColor is an opaque, actually sampled screen pixel.
  const layers = [...colors.backingLayers].reverse().map(rgbColor);
  const backgrounds = [[0, 0, 0], [255, 255, 255]].map(back => composite(background, layers.reduce((base, layer) => composite(layer, base), back)));
  const backgroundLuminance = backgrounds.map(luminance), foregroundLuminance = backgrounds.map(back => luminance(composite(foreground, back)));
  const bgLow = Math.min(...backgroundLuminance), bgHigh = Math.max(...backgroundLuminance);
  const fgLow = Math.min(...foregroundLuminance), fgHigh = Math.max(...foregroundLuminance);
  const ratio = fgLow > bgHigh ? (fgLow + .05) / (bgHigh + .05) : bgLow > fgHigh ? (bgLow + .05) / (fgHigh + .05) : 1;
  return Number(ratio.toFixed(4));
}
function assertCoverButtonReadability(colors, theme, width) {
  assert.equal(colors.filter(item => item.name.startsWith("mode:")).length, 4, "All four mode cards must be checked");
  assert.equal(colors.filter(item => item.name.startsWith("tab:")).length, 2, "Both preview tabs must be checked");
  return colors.map(item => {
    assert.notEqual(item.missing, true, `${theme}/${width}/${item.name} missing`);
    if (item.disabled) return { ...item, readability: "disabled-excluded" };
    assert.equal(item.backgroundImage, "none", `${theme}/${width}/${item.name} requires explicit pixel/gradient contrast inspection`);
    assert.equal(Number(item.opacity), 1, `${theme}/${width}/${item.name} unexpected enabled-control opacity`);
    const contrastMinimum = buttonContrastMinimum(item);
    assert.ok(contrastMinimum >= 4.5, `${theme}/${width}/${item.name} settled contrast lower bound ${contrastMinimum}: ${item.color} on ${item.backgroundColor}`);
    return { ...item, contrastMinimum, readability: "passed", method: "WCAG sRGB; translucent surface bounded over black/white backing" };
  });
}
const parentId = "00000000-0000-4000-8000-000000000011", childId = "00000000-0000-4000-8000-000000000012";
const assetId = "00000000-0000-4000-8000-000000000013", historyId = "00000000-0000-4000-8000-000000000014";
const analysis = { schemaVersion: "cover-content-analysis/1", status: "ready", topic: "停下来回应陪伴", primaryTitle: "它等的，是你的回应", secondaryTitle: null,
  visualBrief: { subject: "主人与橘猫", action: "手机平放桌面，主人右手轻摸猫头，左手自然落在桌边", scene: "温暖的书桌旁", emotion: "安心和依赖" },
  titleCandidates: [{ id: "t1", text: "它等的，是你的回应", evidenceRefs: ["e1"] }],
  contentBreakdown: { summary: { text: "橘猫等待主人停下来回应", evidenceRefs: ["e1"] }, keyPoints: [{ text: "主人放下手机摸猫", evidenceRefs: ["e1"] }], logic: { text: "停下来，回应陪伴", evidenceRefs: ["e1"] }, coverFocus: { text: "主人摸猫的单一瞬间", evidenceRefs: ["e1"] } },
  evidence: [{ id: "e1", source: "text", quote: "我放下手机，摸摸橘猫。", fields: ["topic", "primaryTitle", "visualBrief.subject", "visualBrief.action", "visualBrief.scene", "visualBrief.emotion"] }], missingInformation: [],
  layoutIntent: { structure: "relationship", focus: "action", evidenceRefs: ["e1"] } };
const styles = [{ styleKey: "cartoon", displayName: "暖光叙事", description: "温暖配色，关系叙事" }, { styleKey: "funny-cartoon", displayName: "趣味反差", description: "鲜明对比，醒目标题" },
  ...Array.from({ length: 10 }, (_, index) => ({ styleKey: `future-${index + 1}`, displayName: `扩展 ${index + 1}`, description: "风格规模测试夹具" }))].map((item, order) => ({ ...item, version: "1.0.0", order }));
const png = await sharp({ create: { width: 1080, height: 1440, channels: 3, background: "#dccba2" } }).png().toBuffer();
let parent, child, savedTask, rejectNextConfirmation = false, showUnknownOriginal = false;
const tempRoot = await fs.realpath(os.tmpdir());
const downloadsPath = await fs.mkdtemp(path.join(tempRoot, "cover-review-download-"));
const browser = await chromium.launch({ headless: true, downloadsPath, channel: process.platform === "win32" ? "msedge" : undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ token, user }) => { localStorage.setItem("auth_token", token); localStorage.setItem("auth_user", JSON.stringify(user)); sessionStorage.setItem("entered_app", "1"); }, { token, user: identity.user });
  const respond = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (url.pathname === "/api/auth/me") return respond(route, { success: true, user: identity.user });
    if (url.pathname === "/api/cover-styles") return respond(route, { styles, revision: 1 });
    if (url.pathname === "/api/cover-models") return respond(route, { models: [{ id: "pm_fixture", displayName: "浏览器验收模型", publicPrice: .1, capabilities: { available: true, priceReady: true, generationReady: true, protocolBindingReady: true, supportsReferenceInput: true, maxReferenceImages: 3, resolutionOptions: ["2K"], defaultResolution: "2K", resolutionPrices: { "2K": .1 } } }] });
    if (url.pathname === "/api/cover/history") return respond(route, { success: true, records: [], history: [], nextPage: null });
    if (url.pathname.startsWith("/api/storage/files/") && url.pathname.endsWith("/content")) return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (url.pathname === "/api/media-history/content" && url.searchParams.get("id") === historyId) return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (url.pathname.startsWith("/api/cover-workbench/")) {
      const body = request.method() === "POST" ? request.postDataJSON() : undefined;
      report.requests.push({ path: url.pathname, method: request.method(), ...(body ? { body } : {}) });
      if (url.pathname.endsWith("/prepare")) { parent = { workflowVersion: 3, kind: "analysis", operationId: parentId, status: "prepared", materials: body.materials, route: "new_visual",
        style: { styleKey: "cartoon", displayName: "暖光叙事", sceneBriefVersion: 1 },
        quote: { analysis: { amount: null, unit: "credits", modelName: "分析夹具" }, image: { amount: .1, unit: "yuan", ready: true }, imageQuoteHash: "b".repeat(64) } }; return respond(route, parent); }
      if (url.pathname.endsWith("/analyze")) { assert.deepEqual(body.consent, { analysis: true }); parent = { ...parent, status: "review_ready", analysis, analysisHash: "a".repeat(64) }; return respond(route, parent); }
      if (url.pathname.endsWith("/confirm")) {
        if (rejectNextConfirmation) {
          rejectNextConfirmation = false; showUnknownOriginal = true;
          return respond(route, { success: false, code: "COVER_CONFIRMATION_QUERY_ORIGINAL", action: "query_original",
            originalConfirmationId: childId, error: "夹具原确认订单结果尚未确定，请查询原单" }, 409);
        }
        child = { ...parent, kind: "confirmation", operationId: childId, confirmationId: childId, originalAnalysisOperationId: parentId, status: "confirmed", confirmedPlan: body.edits }; return respond(route, child);
      }
      if (url.pathname.endsWith("/execute")) {
        if (showUnknownOriginal) {
          assert.equal(request.method(), "GET", "Typed original-order conflicts must never POST another image");
          assert.equal(url.searchParams.get("confirmationId"), childId);
          return respond(route, { success: true, confirmationId: childId, status: "unknown", canPoll: true,
            task: { ...savedTask, status: "unknown", assetId: undefined, historyRecordId: undefined, cloudStored: false, url: undefined },
            issue: { message: "夹具原单仍待确认，仅查询" } });
        }
        if (body) assert.deepEqual(body, { confirmationId: childId });
        savedTask = { id: "cover-review-fixture", prepareOperationId: childId, title: child.confirmedPlan.primaryTitle, subtitle: "", ratio: "3:4", prompt: "", briefText: parent.materials.text, status: "done", source: "生成", createdAt: new Date().toISOString(), taskNo: 1, imageOrigin: "generated", assetId, historyRecordId: historyId, cloudStored: true, outputWidth: 1080, outputHeight: 1440, url: `/api/storage/files/${assetId}/content` };
        return respond(route, { success: true, confirmationId: childId, status: "completed", canPoll: false, task: savedTask });
      }
      if (url.pathname.endsWith("/operations")) return respond(route, url.searchParams.get("operationId") === childId ? child : parent);
      throw Error(`Unplanned workflow fixture ${url.pathname}`);
    }
    if (!["GET", "HEAD"].includes(request.method()) || /^\/api\/(?:llm|image\/generate|cover\/(?:prepare|attempt|render|preview))/u.test(url.pathname)) {
      report.blockedWrites.push({ path: url.pathname, method: request.method() });
      return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"read-only browser verification"}' });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message.slice(0, 350)));
  async function screenshot(name) {
    await page.evaluate(() => { const badge = document.createElement("div"); badge.id = "fixture-badge"; badge.textContent = "只读交互夹具 · 无真实生成或扣费"; Object.assign(badge.style, { position: "fixed", right: "8px", bottom: "5px", zIndex: "99999", padding: "5px 9px", background: "#704b16", color: "white", font: "11px sans-serif" }); document.body.appendChild(badge); });
    await page.screenshot({ path: path.join(directory, name) }); await page.locator("#fixture-badge").evaluate(node => node.remove());
  }
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 1080 });
    await page.goto(origin + "/cover", { waitUntil: "networkidle" });
    await page.locator("#cover-workbench-style").waitFor();
    for (const theme of ["soft-white", "lattice", "crystal-aurora"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.mode = theme === "soft-white" ? "light" : "dark"; }, theme);
      const immediateColors = await page.evaluate(readCoverButtonColors);
      // globals.css animates enabled button background-color for 200ms. Text
      // has already adopted the new theme, so an immediate screenshot is not
      // a valid stable-theme readability receipt.
      await page.waitForTimeout(themeSettleMs);
      const settledColors = assertCoverButtonReadability(await page.evaluate(readCoverButtonColors), theme, width);
      const metrics = await page.evaluate(() => ({ horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, button: [...document.querySelectorAll("button")].find(node => node.textContent.includes("下一步：拆解内容"))?.getBoundingClientRect().toJSON(), text: document.body.innerText }));
      assert.equal(metrics.horizontalOverflow, false); assert.ok(metrics.button?.bottom <= (width === 1440 ? 900 : 1080));
      assert.doesNotMatch(metrics.text, /好运降临|哈尼有话讲|查看参考来源/u);
      await screenshot(`empty-${width}-${theme}.png`); report.cases.push({ kind: "empty-layout", width, theme, button: metrics.button,
        themeReadability: { immediateColors, settledColors, backgroundChangedDuringSettle: immediateColors.some((item, index) => item.backgroundColor !== settledColors[index]?.backgroundColor) } });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#cover-workbench-style").click();
  const chooser = page.getByRole("dialog", { name: "选择画面风格" });
  assert.equal(await chooser.locator('[aria-label="可选画面风格"] button').count(), 12);
  const chooserBounds = await chooser.boundingBox(); assert.ok(chooserBounds.y >= 0 && chooserBounds.y + chooserBounds.height <= 900);
  await screenshot("style-chooser-12.png");
  await chooser.getByLabel("搜索画面风格").fill("扩展 10"); assert.equal(await chooser.locator('[aria-label="可选画面风格"] button').count(), 1);
  await chooser.getByRole("button", { name: "关闭风格选择" }).click(); report.cases.push({ kind: "12-style-search-and-bounded-selector" });
  await page.locator("#cover-workbench-text").fill("我放下手机，摸摸橘猫。");
  await page.getByRole("button", { name: "下一步：拆解内容", exact: true }).click();
  await page.getByRole("button", { name: "确认费用并拆解", exact: true }).click();
  await page.getByLabel("方案封面标题", { exact: true }).waitFor();
  assert.equal(report.requests.filter(item => /\/(confirm|execute)$/u.test(item.path)).length, 0);
  await page.getByLabel("方案封面标题", { exact: true }).fill("停下来，回应它");
  await page.getByLabel("方案动作与画面关系", { exact: true }).fill("手机平放桌面左侧，主人右手摸猫，左手垂在椅旁。");
  const sceneDetails = page.locator("details").filter({ has: page.getByText("生图提示词", { exact: true }) });
  await sceneDetails.locator("summary").click();
  assert.match(await sceneDetails.innerText(), /皮克斯式原创 3D动画|皮克斯式原创 3D 动画/u);
  assert.ok((await sceneDetails.innerText()).includes("手机平放桌面左侧，主人右手摸猫，左手垂在椅旁。"));
  assert.ok((await sceneDetails.innerText()).includes("停下来，回应它"));
  assert.ok(await sceneDetails.getByRole("button", { name: "复制生图提示词" }).isVisible());
  const beforeReopen = report.requests.length;
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByLabel("方案封面标题", { exact: true }).inputValue(), "停下来，回应它");
  assert.deepEqual(report.requests.slice(beforeReopen).map(item => [item.method, item.path]), [["GET", "/api/cover-workbench/operations"]]);
  assert.equal(report.requests.filter(item => /\/(confirm|execute)$/u.test(item.path)).length, 0);
  await screenshot("review-edited-restored.png");
  await page.getByRole("button", { name: "确认方案并生成封面", exact: true }).click();
  await page.getByRole("button", { name: "下载封面", exact: true }).waitFor();
  const confirmation = report.requests.find(item => item.path.endsWith("/confirm"));
  assert.equal(confirmation.body.edits.primaryTitle, "停下来，回应它");
  assert.ok(confirmation.body.edits.visualBrief.action.includes("左手垂在椅旁"));
  assert.equal(report.requests.filter(item => item.path.endsWith("/analyze")).length, 1);
  const downloadButton = page.getByRole("button", { name: "下载封面", exact: true });
  await page.evaluate(() => {
    const state = window.coverPickerTest = { mode: "success", options: [], closed: 0, aborted: 0 };
    window.showSaveFilePicker = async options => {
      state.options.push({ ...options, active: navigator.userActivation.isActive });
      if (state.mode === "cancel") throw new DOMException("Cancelled", "AbortError");
      return { name: "自选封面.png", createWritable: async () => ({
        write: async blob => {
          if (state.mode === "fail") throw new Error("夹具磁盘写入失败");
          const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          state.sha = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
        }, close: async () => { state.closed++; }, abort: async () => { state.aborted++; },
      }) };
    };
  });
  await downloadButton.click();
  await page.waitForFunction(() => window.coverPickerTest.closed === 1);
  const picker = await page.evaluate(() => window.coverPickerTest);
  assert.equal(picker.sha, createHash("sha256").update(png).digest("hex"));
  assert.equal(picker.options[0].startIn, "desktop"); assert.equal(picker.options[0].active, true);
  assert.match(picker.options[0].suggestedName, /\.png$/u);
  const automaticDownloads = [];
  page.on("download", download => automaticDownloads.push(download));
  await page.evaluate(() => { window.coverPickerTest.mode = "cancel"; });
  await downloadButton.click(); await page.getByText("已取消下载。", {exact: true}).waitFor();
  await page.evaluate(() => { window.coverPickerTest.mode = "fail"; });
  await downloadButton.click(); await page.getByText("夹具磁盘写入失败", {exact: true}).waitFor();
  assert.deepEqual(await page.evaluate(() => [window.coverPickerTest.closed, window.coverPickerTest.aborted]), [1, 1]);
  assert.equal(automaticDownloads.length, 0);
  report.cases.push({ kind: "desktop-save-location-success-cancel-write-failure", byteIdentical: true });
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  const downloadPromise = page.waitForEvent("download"); await downloadButton.click();
  const download = await downloadPromise; const file = path.join(directory, "fixture-download.png"); await download.saveAs(file);
  assert.equal(createHash("sha256").update(await fs.readFile(file)).digest("hex"), createHash("sha256").update(png).digest("hex"));
  await screenshot("fixture-completed.png"); report.cases.push({ kind: "prepare-analyze-edit-refresh-restore-confirm-execute-download", rawAnalysisUnchanged: analysis.primaryTitle === "它等的，是你的回应", actualProvider: false });
  // Render the real conflict/recovery handlers with explicit local responses.
  // The prior child is the frozen original; the next draft stays independent.
  const originalText = child.materials.text;
  child.quote = { ...child.quote, image: { ...child.quote.image, modelName: "夹具原单冻结模型" } };
  child.originalAnalysisBilling = { creditsCharged: 1.23 };
  await page.goto(origin + "/cover", { waitUntil: "networkidle" });
  await page.locator("#cover-workbench-text").fill("新的独立草稿：我关掉屏幕，陪橘猫玩。");
  await page.getByRole("button", { name: "下一步：拆解内容", exact: true }).click();
  await page.getByRole("button", { name: "确认费用并拆解", exact: true }).click();
  await page.getByLabel("方案封面标题", { exact: true }).fill("保留当前修改");
  const executePostsBeforeConflict = report.requests.filter(item => item.path.endsWith("/execute") && item.method === "POST").length;
  rejectNextConfirmation = true;
  await page.getByRole("button", { name: "确认方案并生成封面", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "夹具原确认订单结果尚未确定，请查询原单" }).waitFor();
  assert.equal(report.requests.filter(item => item.path.endsWith("/execute") && item.method === "POST").length, executePostsBeforeConflict);
  const requestsBeforeOriginalQuery = report.requests.length;
  await page.getByRole("button", { name: "查询原任务状态", exact: true }).click();
  await page.getByRole("heading", { name: "原单信息（只读）", exact: true }).waitFor();
  assert.equal(await page.locator("#cover-original-text").inputValue(), originalText);
  assert.equal(await page.locator("#cover-original-text").evaluate(node => node.readOnly), true);
  assert.equal(await page.locator("[data-original-model-name]").innerText(), "夹具原单冻结模型");
  assert.equal(await page.getByRole("button", { name: "原单待确认，仅可查询", exact: true }).isDisabled(), true);
  assert.ok(report.requests.slice(requestsBeforeOriginalQuery).every(item => item.method === "GET"));
  await screenshot("fence-original-readonly-recovery.png");
  report.cases.push({ kind: "typed-original-confirmation-conflict-and-explicit-get-only-recovery", automaticImagePosts: 0, readonlyOriginalText: true, actualProvider: false });
  // Read an already analyzed, unconfirmed material plan. No prepare/analyze
  // POST is needed for these two fixtures, including right-hand role edits.
  const roleAssetIds = ["00000000-0000-4000-8000-000000000021", "00000000-0000-4000-8000-000000000022", "00000000-0000-4000-8000-000000000023"];
  const roleMaterials = { schemaVersion: "cover-prepare/1", clientRequestId: "readonly_material_roles", materialRevision: 7,
    contentKind: "product", imageMode: "compose", text: "@图1保留人物外观，@图2保留商品外观，@图3作为场景背景。", styleKey: "cartoon", outputRatio: "3:4", modelId: "pm_fixture", resolution: "2K",
    assets: roleAssetIds.map((assetId, index) => ({ assetId, imageNumber: index + 1, role: "style_reference" })) };
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 1080 });
    showUnknownOriginal = false;
    parent = { workflowVersion: 3, kind: "analysis", operationId: parentId, status: "review_ready", route: "new_visual", materials: roleMaterials,
      analysisHash: "d".repeat(64), quote: { analysis: { amount: null, unit: "credits", modelName: "分析夹具" }, image: { amount: .1, unit: "yuan", ready: true }, imageQuoteHash: "b".repeat(64) },
      analysis: { ...analysis, topic: "人物在场景中展示商品", primaryTitle: "场景中的商品展示", secondaryTitle: null,
        visualBrief: { subject: "所提供的人物和商品", action: "人物自然展示商品", scene: "@图3提供的场景", emotion: "自然" },
        titleCandidates: [{ id: "t1", text: "场景中的商品展示", evidenceRefs: ["e1"] }],
        contentBreakdown: { summary: { text: "使用人物、商品和场景素材组合封面", evidenceRefs: ["e1"] }, keyPoints: [{ text: "保留人物与商品外观", evidenceRefs: ["e1"] }],
          logic: { text: "三张图片分别提供人物、商品与场景", evidenceRefs: ["e1"] }, coverFocus: { text: "在指定场景展示商品", evidenceRefs: ["e1"] } },
        evidence: [{ id: "e1", source: "text", quote: roleMaterials.text, fields: ["topic", "primaryTitle", "visualBrief.subject", "visualBrief.action", "visualBrief.scene", "visualBrief.emotion"] }],
        materialUsage: roleAssetIds.map((assetId, index) => ({ assetId, imageNumber: index + 1,
        role: index < 2 ? "identity_subject" : "background_canvas", source: "explicit_user", evidenceRefs: ["e1"] })) } };
    await page.evaluate(({ userId, parentId, materials }) => {
      localStorage.removeItem(`cover-review:${userId}:${parentId}`);
      localStorage.setItem(`cover-workbench-draft-v2:${userId}`, JSON.stringify({ schemaVersion: "cover-browser-draft/2", userId,
        text: materials.text, title: "", manualTitle: false, styleKey: materials.styleKey, ratio: materials.outputRatio, modelId: materials.modelId,
        resolution: materials.resolution, materialRevision: materials.materialRevision, scenario: "product", imageMode: "compose", nextImageNumber: 4,
        assets: materials.assets.map((asset, index) => ({ ...asset, name: `用途夹具 ${index + 1}`, width: 1080, height: 1440 })) }));
      localStorage.setItem(`cover-workbench-operation-v2:${userId}`, JSON.stringify({ workflowVersion: 3, operationId: parentId,
        clientRequestId: materials.clientRequestId, phase: "review", materialRevision: materials.materialRevision }));
    }, { userId: identity.user.id, parentId, materials: roleMaterials });
    const fixtureStart = report.requests.length, blockedBefore = report.blockedWrites.length;
    await page.goto(origin + "/cover", { waitUntil: "networkidle" });
    await page.getByLabel("@图3方案用途", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("@图1方案用途", { exact: true }).innerText(), "方案用途：保留主体外观");
    assert.equal(await page.getByLabel("@图2方案用途", { exact: true }).innerText(), "方案用途：保留主体外观");
    assert.equal(await page.getByLabel("@图3方案用途", { exact: true }).innerText(), "方案用途：场景背景");
    assert.equal(await page.getByLabel("原任务图片 3的图片用途", { exact: true }).count(), 0, "Reviewed materials must not expose the mutating raw-role dropdown");
    const readRaw = userId => {
      const draft = JSON.parse(localStorage.getItem(`cover-workbench-draft-v2:${userId}`));
      return { assets: draft.assets, materialRevision: draft.materialRevision };
    };
    await page.waitForFunction(({ userId, ids }) => {
      const draft = JSON.parse(localStorage.getItem(`cover-workbench-draft-v2:${userId}`) || "null");
      return draft?.assets?.length === 3 && draft.assets.every((asset, index) => asset.assetId === ids[index] && asset.role === "style_reference") && draft.assets[0].name === "原任务图片 1";
    }, { userId: identity.user.id, ids: roleAssetIds });
    const rawBefore = await page.evaluate(readRaw, identity.user.id);
    const roleButton = page.getByRole("button", { name: "编辑@图3方案用途", exact: true }), editor = page.getByLabel("方案图3用途", { exact: true });
    const editorId = await editor.getAttribute("id"); assert.ok(editorId?.includes(roleAssetIds[2]));
    assert.equal(await roleButton.getAttribute("aria-controls"), editorId);
    await page.getByRole("button", { name: "封面成品", exact: true }).click();
    await roleButton.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(id => document.activeElement?.id === id, editorId);
    assert.equal(await page.getByRole("button", { name: "拆解方案", exact: true }).getAttribute("aria-pressed"), "true");
    await editor.selectOption("style_reference");
    await page.waitForFunction(() => document.querySelector('[aria-label="@图3方案用途"]')?.textContent === "方案用途：参考风格与排版");
    assert.equal(await editor.inputValue(), "style_reference");
    assert.deepEqual(await page.evaluate(readRaw, identity.user.id), rawBefore);
    assert.ok(report.requests.slice(fixtureStart).every(item => item.method === "GET"), "Role projection/navigation/editing must not add any workflow write");
    assert.equal(report.requests.slice(fixtureStart).filter(item => /\/(?:analyze|prepare|confirm|execute)$/u.test(item.path) && item.method !== "GET").length, 0);
    assert.deepEqual(report.blockedWrites.slice(blockedBefore).filter(item => !["/api/operation-events", "/api/diagnostic-logs"].includes(item.path)), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await screenshot(`material-effective-role-${width}.png`);
    report.cases.push({ kind: "three-material-effective-plan-roles-and-keyboard-navigation", width, initialRoles: roleMaterials.assets.map(item => item.role),
      analysisRoles: parent.analysis.materialUsage.map(item => item.role), editedRole: "style_reference", rawAssetsAndRevisionUnchanged: true,
      exactEditorId: editorId, keyboardFocus: true, workflowPosts: 0, analyzePreparePosts: 0, actualProvider: false });
  }
  for (const route of ["/", "/tools?tab=segment", "/youcai/cover"]) {
    await page.goto(origin + route, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
    await screenshot(`adjacent-${route.replace(/[^a-z]+/gu, "-") || "home"}.png`); report.cases.push({ kind: "adjacent", route });
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.passed = false; report.failure = error.message; process.exitCode = 1; }
finally {
  await browser.close();
  await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, directory, cases: report.cases.length, errors: report.errors, failure: report.failure }));
  if (path.dirname(await fs.realpath(downloadsPath)) === tempRoot && path.basename(downloadsPath).startsWith("cover-review-download-")) {
    await fs.rm(downloadsPath, { recursive: true });
  }
}
