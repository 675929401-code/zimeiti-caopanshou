import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import sharp from "sharp";

// Bounded real-product operator for the user's full local acceptance authority.
// Every case consumes a permanent marker before its paid confirmation. Unknown
// requests are reconciled by original IDs only; this operator never retries POST.
const ORIGIN = "http://127.0.0.1:5000";
const ROOT = ".codex-evidence/cover-paid-20261106-3fd15654/four-modes";
const MODEL = "pm_PZ3hS353YQNbfRnz2_9Ro0aX";
const hash = value => createHash("sha256").update(value).digest("hex");
const cases = {
  recovered_dog_story: { scenario: "script", style: "cartoon", ratio: "16:9", width: 1920, height: 1080,
    text: "", originalPaidAnalysisReuse: true, files: [] },
  warm_story: { scenario: "script", style: "cartoon", ratio: "16:9", width: 1920, height: 1080,
    text: "小时候总嫌妈妈反复叮嘱，出门时还催她快一点。离家工作后，生病的那个晚上，我第一次主动给她打电话。她没有责怪，只说锅里还给我留着汤。原来那些曾经嫌烦的话，一直是有人在惦记我。", files: [] },
  warm_relationship_layout: { scenario: "script", style: "cartoon", ratio: "3:4", width: 1080, height: 1440, requireSemanticLayout: true,
    text: "以前回家吃饭，我总一边刷手机一边应付妈妈说的话。那天她把刚热好的饭菜推到我面前，想讲讲她白天遇到的小事。我看到她等着回应的眼神，终于把手机扣在桌上，认真听她说完。陪伴不是坐得多近，而是愿意把注意力交给眼前的人。", files: [] },
  funny_action: { scenario: "script", style: "funny-cartoon", ratio: "3:4", width: 1080, height: 1440,
    text: "我每次打开电脑都想先找个好状态。桌面整理好了，咖啡泡好了，待办清单也换了颜色，真正的工作却还没开始。后来我把准备时间换成先做十分钟，才发现最需要被整理的是拖延的借口。", files: [] },
  funny_fresh_layout: { scenario: "script", style: "funny-cartoon", ratio: "3:4", width: 1080, height: 1440, requireSemanticLayout: true,
    text: "我说今天一定早点睡，结果拿起手机只是想回个消息。回完又看一眼群聊，再刷一会儿短视频，越刷越精神。终于把手机放下的时候，我发现自己根本没在休息，只是把困意拖到了明天。睡前最难放下的，原来是那个还想再看一眼的念头。", files: [] },
  product_description: { scenario: "product", style: "cartoon", ratio: "3:4", width: 1080, height: 1440,
    text: "一款500mL米白色不锈钢保温杯，杯盖带提手，圆润杯身，适合通勤时随身携带。请突出日常使用场景和便携设计；没有提供保温时长、价格、品牌或检测信息，请不要添加。无实物照片，本次制作不带品牌的商品创意示意图。", files: [] },
  reference_visual: { scenario: "reference", style: "cartoon", ratio: "9:16", width: 1080, height: 1920,
    text: "下班后的年轻人不再盯着手机刷到深夜，而是走进厨房认真给自己做一顿晚饭。食材不复杂，热汤和灯光让疲惫慢慢放松。这条视频讲的是好好照顾自己的日常。制作要求：@图1 仅参考暖色配色与标题位置，画面采用真实摄影质感，生成全新的年轻中国女性在厨房准备晚餐的画面，保留自然皮肤、真实衣物和环境细节。图片里的原人物和原文字不搬入新图。", files: ["warm_story/downloaded-cover.png"] },
  product_photo_reference: { scenario: "product", imageMode: "preserve", style: "cartoon", ratio: "3:4", width: 1080, height: 1440,
    text: "500mL米白色不锈钢保温杯，杯盖带提手。第一张是本次测试生成的无品牌商品示意图，请完整保留照片内容；第二张参考封面仅用于标题层次和配色。封面突出通勤携带方便，不新增保温时长、价格、销量或功效。", files: ["product_description/background.png", "funny_action/downloaded-cover.png"] },
  background_layout: { scenario: "background", style: "cartoon", ratio: "16:9", width: 1920, height: 1080,
    text: "工作再忙，也别忘了回应家人的关心。那些提醒吃饭、早点休息的话，藏着最朴素的牵挂。这条视频讲述离家后才懂得的亲情。保留上传的暖色原图，提炼简短标题并避开主体排版。", files: ["warm_story/background.png"] },
  person_product_scene: { scenario: "reference", style: "cartoon", ratio: "4:3", width: 1440, height: 1080,
    text: "自媒体日常分享：下班后给自己留一点休息时间，喝一杯水，在窗边安静地看书。制作要求：@图1 使用人物的面部、发型和衣着外观，@图2 使用随行杯商品外观，@图3 仅参考卧室空间、窗户和暖色灯光，移除场景中的原人物。把图1中的人物自然放入图3的卧室窗边，手里拿着图2的杯子；画面采用真实摄影质感，人物和杯子放在右侧，左上方自然留出标题空间。新画面只保留图1对应的模特，不搬入参考封面原文字，不新增商品参数、品牌或功效。", files: ["reference_visual/background.png", "product_description/background.png", "warm_story/background.png"] },
};

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute-authorized-four-mode-acceptance"), "EXPLICIT_REAL_ACCEPTANCE_FLAG_REQUIRED");
  const arg = name => args.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  const name = arg("case"), fixture = cases[name];
  assert.ok(fixture, "UNKNOWN_ACCEPTANCE_CASE");
  const continuing = args.includes('--continue-original-case');
  const retryFree = args.includes('--retry-free-preparation');
  assert.ok(!retryFree || !continuing && name === 'reference_visual', 'FREE_RETRY_SCOPE_INVALID');
  const continuations = { funny_action: '4bf23348-c46f-4be5-9961-0214980010fe', warm_relationship_layout: '3fb0283d-38f4-41fe-97e4-15d503837d70', product_description: '0cce5c55-764d-432b-a5d7-6bea45650e06' };
  assert.ok(!continuing || Object.hasOwn(continuations, name), 'CONTINUATION_RESTRICTED_TO_KNOWN_ORIGINAL_ANALYSIS_FAILURE');
  if (fixture.originalPaidAnalysisReuse) {
    const original = JSON.parse(await fs.readFile('.codex-evidence/cover-paid-20261106-3fd15654/analysis-failure/owned-reparse-input.json', 'utf8'));
    assert.equal(original.operationId, '910c6b76-312f-4bcb-97f1-b078589f653e'); fixture.text = original.materials.text;
  }
  assert.equal(process.env.LOCAL_ACCEPTANCE_PREVIEW, "true");
  assert.equal(process.env.LOCAL_NAV_ORIGIN, ORIGIN);
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "null");
  assert.ok(token && identity?.user?.id, "VERIFIED_LOCAL_SESSION_REQUIRED");
  const root = path.resolve(ROOT), directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  const originalMarker = path.join(directory, "paid-confirmation-consumed.json");
  const marker = continuing ? path.join(directory, 'original-image-continuation-consumed.json') : originalMarker;
  try { await fs.access(marker); throw new Error("THIS_CASE_ALREADY_SUBMITTED_QUERY_ORIGINAL_ONLY"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if(retryFree){const previous=JSON.parse(await fs.readFile(path.join(directory,'report.json'),'utf8'));
    assert.ok(!previous.passed&&previous.counts.prepare===0&&previous.counts.analyze===0&&previous.counts.dispatch===0,'FREE_RETRY_MUST_PRECEDE_ANY_ANALYSIS_OR_IMAGE');}
  const report = { schemaVersion: 1, case: name, scenario: fixture.scenario, startedAt: new Date().toISOString(),
    authority: "user_full_local_implementation_material_generation_and_paid_acceptance_20261106", origin: ORIGIN,
    inputSha256: hash(fixture.text), fixtureImages: fixture.files, simulatedUnbrandedProduct: name.startsWith("product_"),
    expected: { ratio: fixture.ratio, width: fixture.width, height: fixture.height },
    counts: { prepare: 0, analyze: 0, claim: 0, dispatch: 0, render: 0, upload: 0 },
    requests: [], pageErrors: [], blocked: [], passed: false, downloaded: false };
  let browser, page, parent, plan, receipt, fatal;
  const auth = { Authorization: `Bearer ${token}` };
  const check = (condition, code) => { if (!condition) { fatal ||= code; throw new Error(code); } };
  async function version() {
    const response = await fetch(`${ORIGIN}/api/version`, { cache: "no-store" });
    const data = await response.json();
    check(response.ok && data.sourceVersion === arg("expected-source-version") && data.buildId === arg("expected-build-id"), "EXPECTED_RUNTIME_CHANGED");
    report.runtime = { sourceVersion: data.sourceVersion, buildId: data.buildId };
  }
  async function readParent() {
    const response = await fetch(`${ORIGIN}/api/cover/prepare?operationId=${parent.operationId}`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(45_000) });
    const body = await response.json();
    check(response.ok && body.operationId === parent.operationId, "ORIGINAL_PARENT_READ_FAILED");
    report.parentState = body.status; report.analysisBilling = body.billing;
    if (body.status === "plan_ready") plan = body;
    if (["failed", "needs_input"].includes(body.status)) check(false, body.code || "ANALYSIS_NOT_READY");
    return body;
  }
  function takeReceipt(body) {
    const candidate = body?.completed === true ? body.result : body;
    if (candidate?.persisted === true && candidate.cloudStored === true && candidate.assetId && candidate.historyRecordId) {
      receipt = { assetId: candidate.assetId, historyRecordId: candidate.historyRecordId, backgroundAssetId: candidate.backgroundAssetId || candidate.sourceAssetId,
        width: candidate.width, height: candidate.height, persisted: true, cloudStored: true };
    }
  }
  try {
    await version();
    if (continuing) {
      const original = JSON.parse(await fs.readFile(originalMarker, 'utf8'));
      const failed = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
      check(original.operationId === continuations[name] && failed.operationId === original.operationId
        && failed.passed === false && failed.counts.dispatch === 0, 'ORIGINAL_CONTINUATION_BINDING_INVALID');
      parent = { operationId: original.operationId }; report.operationId = parent.operationId;
      const recovered = await readParent();
      check(recovered.status === 'plan_ready' && recovered.materials?.text === fixture.text, 'ORIGINAL_ANALYSIS_NOT_RECOVERED');
      parent = recovered; report.clientRequestId = recovered.materials.clientRequestId;
      const checkAttempt = await fetch(`${ORIGIN}/api/cover/attempt?${new URLSearchParams(recovered.generationIdentity)}`, {headers:auth, cache:'no-store'});
      const absence = await checkAttempt.json();
      check(checkAttempt.ok && absence.success === true && absence.activeAttempt === null && !absence.completed && !absence.terminalAttempt,
        'ORIGINAL_IMAGE_ALREADY_EXISTS_QUERY_ONLY');
      report.continuation = { originalOperationId: parent.operationId, analysisReusedWithoutNewModelCall: true, originalFailureReport: 'report.json' };
    }
    const files = [];
    for (const sourceName of fixture.files) {
      const sourcePath = path.join(root, sourceName); const bytes = await fs.readFile(sourcePath);
      if (bytes.length <= 5 * 1024 * 1024) { files.push(sourcePath); continue; }
      const destination = path.join(directory, `upload-${files.length + 1}.jpg`);
      const compressed = await sharp(bytes).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      check(compressed.length <= 5 * 1024 * 1024, "FIXTURE_EXCEEDS_REAL_UPLOAD_LIMIT");
      await fs.writeFile(destination, compressed, { flag: "wx" }); files.push(destination);
      (report.fixtureCompression ||= []).push({ source: sourceName, sourceSha256: hash(bytes), uploadedSha256: hash(compressed), pixelResizing: false });
    }
    const browserTemp = path.resolve('.codex-evidence/cover-paid-20261106-3fd15654/playwright-temp');
    await fs.mkdir(browserTemp, { recursive: true }); process.env.TEMP = browserTemp; process.env.TMP = browserTemp;
    const nativeDownloads = path.join(process.env.USERPROFILE, 'Downloads', 'CodexCoverAcceptance');
    await fs.mkdir(nativeDownloads, { recursive: true });
    browser = await chromium.launch({ headless: true, channel: 'msedge', downloadsPath: nativeDownloads });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true, serviceWorkers: "block" });
    await context.addCookies([{ name: "auth_token", value: token, url: ORIGIN, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(({ sessionToken, user, originalPending }) => {
      localStorage.setItem("auth_token", sessionToken); localStorage.setItem("auth_user", JSON.stringify(user)); sessionStorage.setItem("entered_app", "1");
      if (originalPending) localStorage.setItem('cover-workbench-operation-v2:'+user.id, JSON.stringify(originalPending));
    }, { sessionToken: token, user: identity.user, originalPending: continuing ? {clientRequestId:parent.materials.clientRequestId,
      operationId:parent.operationId,materialRevision:parent.materials.materialRevision,phase:'analysis'} : null });
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
      if (url.pathname === "/api/auth/me" && method === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, user: identity.user }) });
      const block = async code => { fatal ||= code; report.blocked.push({ path: url.pathname, method, code }); return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ success: false, code }) }); };
      const relay = async action => {
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 360_000 });
          const body = await response.json().catch(() => null);
          report.requests.push({ path: url.pathname, method, action, httpStatus: response.status(), state: body?.status || body?.state, code: body?.code || body?.error_code });
          if (url.pathname === "/api/cover/prepare") {
            if (action === "prepare" && response.ok()) { parent = body; report.operationId = body.operationId; report.clientRequestId = body.materials?.clientRequestId; }
            if (body?.status === "plan_ready") plan = body;
            if (body?.billing) report.analysisBilling = body.billing;
          }
          if (["/api/cover/attempt", "/api/cover/render"].includes(url.pathname)) takeReceipt(body);
          if (["prepare", "analyze", "claim", "dispatch", "render"].includes(action)) console.log(JSON.stringify({ case: name, action, operationId: parent?.operationId, httpStatus: response.status(), state: body?.status || body?.state, code: body?.code || body?.error_code, saved: Boolean(receipt) }));
          await route.fulfill({ response });
        } catch { report.requests.push({ path: url.pathname, method, action, code: "ORIGINAL_RESPONSE_UNCONFIRMED" }); await route.abort("failed").catch(() => {}); }
      };
      if (url.pathname === "/api/cover/prepare") {
        if (method === "GET") return parent && url.searchParams.get("operationId") === parent.operationId ? relay("get") : block("UNBOUND_PARENT_GET");
        const body = request.postDataJSON();
        if (body.action === "prepare") {
          if (++report.counts.prepare !== 1 || body.materials?.text !== fixture.text || body.materials?.styleKey !== fixture.style
            || body.materials?.outputRatio !== fixture.ratio || (fixture.scenario === "product") !== (body.materials?.contentKind === "product")) return block("MUTATED_OR_SECOND_PREPARE");
          return relay("prepare");
        }
        if (body.action === "analyze" && parent && body.operationId === parent.operationId && body.consent?.analysis === true
          && body.consent?.image === true && ++report.counts.analyze === 1) return relay("analyze");
        return block("SECOND_OR_UNBOUND_ANALYSIS");
      }
      if (url.pathname === "/api/cover/attempt") {
        const keys = plan?.generationIdentity;
        if (!keys) return block("IMAGE_BEFORE_PLAN");
        if (method === "GET") return url.searchParams.get("clientIdempotencyKey") === keys.clientIdempotencyKey && url.searchParams.get("clientTraceId") === keys.clientTraceId ? relay("get") : block("UNBOUND_ATTEMPT_GET");
        const body = request.postDataJSON();
        if (body.clientIdempotencyKey !== keys.clientIdempotencyKey || body.clientTraceId !== keys.clientTraceId) return block("IMAGE_IDENTITY_CHANGED");
        if (body.action === "claim" && ++report.counts.claim === 1) return relay("claim");
        if (body.action === "dispatch" && ++report.counts.dispatch === 1 && report.counts.claim === 1) return relay("dispatch");
        return block("SECOND_OR_UNEXPECTED_IMAGE_ACTION");
      }
      if (url.pathname === "/api/cover/render" && method === "POST") {
        if (++report.counts.render !== 1 || !["product", "background"].includes(fixture.scenario) || !fixture.files.length) return block("UNEXPECTED_OR_SECOND_RENDER");
        return relay("render");
      }
      if (url.pathname === "/api/cover/materials" && method === "POST") {
        if (++report.counts.upload > fixture.files.length) return block("EXTRA_MATERIAL_UPLOAD");
        // CDP postData omits native file bytes; APIRequestContext.fetch would
        // resend an empty File part. Let the actual browser stream its upload.
        return route.continue();
      }
      if (url.pathname === "/api/cover/preview" && method === "POST") return route.continue();
      if (["/api/operation-events", "/api/diagnostic-logs"].includes(url.pathname) && method === "POST") return route.continue();
      if (!["GET", "HEAD"].includes(method)) return block("UNRELATED_WRITE_BLOCKED");
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(40_000);
    page.on('response',async response=>{if(new URL(response.url()).pathname==='/api/cover/materials'&&response.request().method()==='POST'){
      const body=await response.json().catch(()=>({}));report.requests.push({path:'/api/cover/materials',method:'POST',action:'native-browser-upload',httpStatus:response.status(),success:body.success,error:body.error});
    }});
    page.on("pageerror", () => report.pageErrors.push("BROWSER_RUNTIME_ERROR"));
    await page.goto(`${ORIGIN}/cover`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "封面工作台", exact: true }).waitFor();
    if (continuing) {
      await page.getByRole('button', {name:'查询原任务状态',exact:true}).click();
      await page.getByRole('button', {name:'恢复原任务材料',exact:true}).click();
      await page.getByRole('button', {name:'继续原任务制作',exact:true}).waitFor();
    } else {
    const labels = { script: "口播生成", product: "商品封面", reference: "参考封面", background: "原图排版" };
    await page.getByRole("button", { name: labels[fixture.scenario], exact: true }).click();
    if (files.length) {
      await page.locator('input[type="file"]').setInputFiles(files);
      await page.waitForFunction(count => document.querySelectorAll('button[aria-label^="移除图片"]').length === count && !document.body.textContent.includes("正在上传…"), files.length);
    }
    if (fixture.imageMode === "preserve") await page.getByRole("button", { name: "保留原图", exact: true }).click();
    const model = page.locator("#cover-workbench-model");
    if (await model.isEnabled()) { await model.selectOption(MODEL); await page.locator("#cover-workbench-resolution").selectOption("2K"); }
    const style = page.locator("#cover-workbench-style");
    if (await style.isEnabled()) await style.selectOption(fixture.style);
    await page.getByRole("button", { name: new RegExp(`^${fixture.ratio}\\s`) }).click();
    await page.locator("#cover-workbench-text").fill(fixture.text);
    await page.getByRole("button", { name: "生成封面", exact: true }).click();
    await page.getByRole("button", { name: "确认费用并制作", exact: true }).waitFor();
    check(parent?.status === "prepared" && report.counts.prepare === 1, "PREPARE_NOT_CONFIRMED");
    }
    report.prepared = { route: parent.route, analysisModel: parent.quote?.analysis?.modelName, imageQuote: parent.quote?.image?.amount,
      imageUnit: parent.quote?.image?.unit, reuseAnalysis: Boolean(parent.reuseAnalysisOperationId), roles: parent.materials?.assets?.map(asset => asset.role) };
    if (fixture.originalPaidAnalysisReuse) check(parent.quote?.analysis?.amount === 0 && parent.reuseAnalysisOperationId, "ORIGINAL_PAID_ANALYSIS_MUST_BE_REUSED_WITHOUT_NEW_CHARGE");
    const noNewImage = fixture.scenario === "background" || fixture.imageMode === "preserve";
    check(noNewImage ? parent.route === "original_layout" : parent.quote?.image?.amount === .3 && parent.quote?.image?.modelId === MODEL, "ROUTE_OR_IMAGE_QUOTE_CHANGED");
    await fs.writeFile(marker, JSON.stringify({ operationId: parent.operationId, clientRequestId: parent.materials.clientRequestId,
      at: new Date().toISOString(), scenario: fixture.scenario, quote: report.prepared, authority: report.authority }, null, 2), { flag: "wx" });
    await page.screenshot({ path: path.join(directory, "prepared.png"), fullPage: false });
    await page.getByRole("button", { name: continuing ? "继续原任务制作" : "确认费用并制作", exact: true }).click();
    const deadline = Date.now() + 14 * 60_000;
    let lastRead = 0;
    while (!receipt && Date.now() < deadline && !fatal) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (Date.now() - lastRead > 15_000 && parent) {
        lastRead = Date.now(); await readParent();
        const keys = plan?.generationIdentity;
        if (keys && report.counts.claim) {
          const response = await fetch(`${ORIGIN}/api/cover/attempt?${new URLSearchParams(keys)}`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(120_000) });
          const body = await response.json(); takeReceipt(body);
          report.requests.push({ path: "/api/cover/attempt", method: "GET", action: "reconcile-original-only", httpStatus: response.status, completed: body.completed === true });
          if (body.terminalAttempt || ["failed", "cancelled", "rejected"].includes(body.state)) check(false, body.code || "ORIGINAL_IMAGE_TERMINAL_FAILURE");
        }
      }
    }
    check(!fatal && receipt, fatal || "ORIGINAL_RESULT_STILL_UNKNOWN_DO_NOT_RESUBMIT");
    check(receipt.width === fixture.width && receipt.height === fixture.height, "ACTUAL_OUTPUT_DIMENSIONS_CHANGED");
    const historyResponse = await fetch(`${ORIGIN}/api/cover/history?page=1`, { headers: auth, cache: "no-store" });
    const history = await historyResponse.json();
    const saved = history.records?.find(record => record.assetId === receipt.assetId && record.historyRecordId === receipt.historyRecordId);
    check(historyResponse.ok && saved?.cloudStored === true && ["done", "display_pending"].includes(saved.status), "OWNED_CLOUD_HISTORY_NOT_FOUND");
    const analysisCard = page.getByRole('region', { name: '文案拆解结果', exact: true });
    await analysisCard.waitFor({ state: 'visible', timeout: 30_000 });
    check((await analysisCard.innerText()).includes(plan.analysis.primaryTitle), 'EXTRACTED_TITLE_MUST_BE_VISIBLE_BEFORE_DOWNLOAD');
    report.analysisDisplay = { visible: true, primaryTitle: plan.analysis.primaryTitle, topic: plan.analysis.topic,
      layout: plan.layoutPlan ? { templateId: plan.layoutPlan.templateId, displayName: plan.layoutPlan.displayName, source: plan.layoutPlan.source,
        titleZone: plan.layoutPlan.titleZone, subjectZone: plan.layoutPlan.subjectZone } : null };
    if (plan.analysis.contentBreakdown) {
      await analysisCard.locator('summary').click();
      const visible = await analysisCard.innerText();
      for (const label of ['文案摘要', '内容重点', '表达逻辑']) check(visible.includes(label), 'CONTENT_BREAKDOWN_NOT_VISIBLE');
      check(visible.includes(plan.analysis.contentBreakdown.summary.text), 'CONTENT_SUMMARY_NOT_BOUND_TO_ORIGINAL_ANALYSIS');
      report.analysisDisplay.contentBreakdown = plan.analysis.contentBreakdown;
      await page.screenshot({path:path.join(directory,'analysis-visible.png'),fullPage:false});
      await analysisCard.locator('summary').click();
    }
    if (fixture.requireSemanticLayout) check(plan.layoutPlan?.source === 'semantic_intent' && plan.analysis.layoutIntent, 'SEMANTIC_LAYOUT_PLAN_REQUIRED');
    receipt.backgroundAssetId ||= saved.backgroundAssetId;
    report.receipt = receipt; report.title = saved.title;
    const download = page.getByRole("button", { name: "下载封面", exact: true });
    await download.waitFor({ state: "visible" });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "下载封面" && !button.disabled));
    const downloading = page.waitForEvent("download", { timeout: 60_000 });
    await download.click(); const delivered = await downloading;
    check(!await delivered.failure(), "BROWSER_DOWNLOAD_FAILED");
    const destination = path.join(directory, "downloaded-cover.png"); await delivered.saveAs(destination);
    const bytes = await fs.readFile(destination), metadata = await sharp(bytes).metadata();
    check(metadata.format === "png" && metadata.width === fixture.width && metadata.height === fixture.height, "DOWNLOADED_PNG_INVALID");
    report.download = { sha256: hash(bytes), bytes: bytes.length, width: metadata.width, height: metadata.height };
    report.downloaded = true;
    if (receipt.backgroundAssetId) {
      const response = await fetch(`${ORIGIN}/api/storage/files/${receipt.backgroundAssetId}/content`, { headers: auth, cache: "no-store" });
      check(response.ok, "BACKGROUND_FIXTURE_READ_FAILED"); const source = Buffer.from(await response.arrayBuffer());
      await sharp(source).png().toFile(path.join(directory, "background.png"));
      report.background = { assetId: receipt.backgroundAssetId, sha256: hash(source), dimensions: await sharp(source).metadata().then(meta => ({ width: meta.width, height: meta.height })) };
    }
    await page.screenshot({ path: path.join(directory, "saved-and-download.png"), fullPage: false });
    await readParent(); await version();
    check(report.counts.analyze === 1 && (noNewImage ? report.counts.dispatch === 0 && report.counts.render === 1 : report.counts.dispatch === 1), "UNEXPECTED_MODEL_OR_RENDER_COUNTS");
    check(report.pageErrors.length === 0 && report.blocked.length === 0, "BROWSER_OR_SCOPE_ERRORS");
    report.passed = true;
  } catch (error) {
    report.failure = { code: /^[A-Z0-9_]{3,140}$/u.test(error.message || "") ? error.message : "ACCEPTANCE_FAILED_INSPECT_UI", lastParentState: report.parentState };
    if (page) { report.visibleStatus = (await page.locator('main').innerText().catch(() => "")).slice(-3500); await page.screenshot({ path: path.join(directory, "failure.png"), fullPage: false }).catch(() => {}); }
    process.exitCode = 1;
  } finally {
    await browser?.close(); report.finishedAt = new Date().toISOString();
    const output = JSON.stringify(report, null, 2); assert.ok(!output.includes(token));
    const reportName = continuing ? 'continuation-report.json' : retryFree ? 'free-retry-report.json' : 'report.json';
    await fs.writeFile(path.join(directory, reportName), output + "\n", { flag: "wx" });
    console.log(JSON.stringify({ case: name, passed: report.passed, counts: report.counts, operationId: report.operationId, receipt: report.receipt, failure: report.failure, report: path.join(directory, reportName) }));
  }
}
