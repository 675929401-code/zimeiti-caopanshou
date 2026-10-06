import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import {
  chromium,
  request as playwrightRequest,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Request,
} from "playwright";
const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDirectory = process.env.CANVAS_TEST_OUTPUT_DIR || ".tmp-e2e/benchmark-director-v8-live";
const storageStatePath = `${outputDirectory}/storage-state.json`;
const reportPath = `${outputDirectory}/report.json`;
const videoModelId = process.env.CANVAS_VIDEO_MODEL_ID || "veo-3-1-fast-chC";
const liveGenerationEnabled = process.env.CANVAS_LIVE_GENERATION === "1";
const headful = process.env.CANVAS_HEADFUL === "1";
const keepOpenMs = Number(process.env.CANVAS_KEEP_OPEN_MS || 0);
const resumePreparedCanvas = process.env.CANVAS_RESUME === "1";
const stopAfterCompile = process.env.CANVAS_STOP_AFTER_COMPILE === "1";
const stopAfterImages = process.env.CANVAS_STOP_AFTER_IMAGES === "1";
const trialImageShots = (process.env.CANVAS_TRIAL_IMAGE_SHOTS || "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const BENCHMARK_SCRIPT = process.env.CANVAS_TEST_SCRIPT || "午后的客厅里，两岁金毛寻回犬阿麦盯上了茶几上的葡萄。30岁的中国女性主人转身接电话，它立刻压低身体，鼻尖一点点靠近果盘，前爪刚抬上桌沿，一颗紫葡萄便滚到地毯上。主人回头冲来，用手掌挡住它张开的嘴。阿麦急刹后退，耳朵贴后，前爪在地毯上连续打滑，眼睛却还死死追着葡萄。它的想象里，紫葡萄突然膨胀成冒着冷雾的危险巨球，绿色骷髅烟雾从后方升起，阿麦吓得全身炸毛、尾巴夹紧。主人把葡萄收进高柜，换成一小块去核苹果。阿麦先谨慎闻嗅，再轻轻咬住，确认安全后尾巴快速横扫沙发边缘。最后主人把果盘推远，阿麦端正坐好，目光在苹果和主人之间来回移动。葡萄和葡萄干对狗有严重风险，安全水果也要去核、切小块并少量喂食。";
const BENCHMARK_INSTRUCTION = process.env.CANVAS_TEST_INSTRUCTION || "采用高密度宠物知识微剧情：先欲望与错误逼近，再阻止、物理反馈、夸张心理切片和安全落点。普通金毛必须保持天然四足犬科结构，不穿人类衣服，不出现人手、人躯干或双足站立。每镜只呈现一个连续动作因果；参考图冻结动作将要发生的瞬间，视频第一句直接命令角色怎么演。优先用真实动作、身体状态、道具和环境反馈证明语义，只有心理想象镜头才使用完整危险切片。危险段用紫黑冷光和绿色冷雾，安全段回到暖金窗光。标题、编号、字幕、红叉和知识文字全部留给后期，不让生图模型绘制。";
const CONSISTENCY_SOURCE = process.env.CANVAS_CONSISTENCY_SOURCE || "explore";

type MediaKind = "image" | "video";

type GraphNode = {
  id: string;
  data: {
    kind: string;
    title: string;
    prompt?: string;
    outputText?: string;
    outputUrl?: string;
    status?: string;
    error?: string;
    modelId?: string;
    durationSeconds?: number;
    timelineDurationSeconds?: number;
    allowDurationTrim?: boolean;
    semanticOrder?: number;
    visualOrder?: number;
    aspectRatio?: string;
    history?: Array<{ outputUrl?: string }>;
  };
};

type StageSnapshot = {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  pending: number;
  failedNodes: Array<{ title: string; error: string }>;
};

type RequestRecord = {
  path: string;
  method: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status?: number;
  modelId?: string;
  taskLabel?: string;
  referenceImageCount?: number;
};

type AssetRecord = {
  title: string;
  kind: MediaKind;
  modelId: string;
  targetDurationSeconds?: number;
  actualDurationSeconds?: number;
  outputUrl: string;
  savedPath?: string;
  width?: number;
  height?: number;
};

type AcceptanceReport = {
  startedAt: string;
  completedAt?: string;
  source: string;
  script: string;
  instruction: string;
  aspectRatio: string;
  animationStyle: string;
  imageModel?: string;
  videoModel?: string;
  imageModelId?: string;
  videoModelId: string;
  compiler?: string;
  compileDurationMs?: number;
  semanticSegments?: number;
  visualShots?: number;
  balanceBefore?: number;
  balanceAfter?: number;
  expectedMaximumCost?: number;
  stages: Array<{
    kind: MediaKind;
    attempt: number;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    result: StageSnapshot;
  }>;
  requests: RequestRecord[];
  assets: AssetRecord[];
  promptAudit: {
    imagePromptCount: number;
    videoPromptCount: number;
    directorDecisionCount: number;
    forbiddenInternalInstructions: string[];
    vagueAssetReferences: string[];
    weakVideoDirections: string[];
  };
  pageErrors: string[];
  consoleErrors: string[];
  error?: string;
};

function graphNodesScript() {
  const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
  return graph?.nodes || [];
}

async function graphNodes(page: Page) {
  return page.evaluate(graphNodesScript);
}

async function stageSnapshot(page: Page, kind: MediaKind): Promise<StageSnapshot> {
  return page.evaluate((expectedKind) => {
    const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
    const nodes = (graph?.nodes || []).filter((node) => node.data.kind === expectedKind);
    let succeeded = 0;
    let failed = 0;
    let running = 0;
    let pending = 0;
    const failedNodes: Array<{ title: string; error: string }> = [];
    for (const node of nodes) {
      const currentStatus = node.data.outputUrl ? "succeeded" : node.data.status || "idle";
      if (currentStatus === "succeeded") succeeded += 1;
      else if (currentStatus === "failed") {
        failed += 1;
        failedNodes.push({ title: node.data.title, error: node.data.error || "未知错误" });
      } else if (currentStatus === "running") running += 1;
      else pending += 1;
    }
    return {
      total: nodes.length,
      succeeded,
      failed,
      running,
      pending,
      failedNodes,
    };
  }, kind);
}

async function persistReport(report: AcceptanceReport) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function openProPanel(page: Page) {
  const toggle = page.getByRole("button", { name: "打开制作面板" });
  await toggle.waitFor({ state: "visible" });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.locator(".free-pro-panel").waitFor({ state: "visible" });
}

async function selectLabelOption(page: Page, labelText: string, value: string) {
  const label = page.locator(".free-script-importer label").filter({ hasText: labelText }).first();
  await label.waitFor({ state: "visible" });
  await label.locator("select").selectOption(value);
}

async function installVisibleAcceptancePointer(page: Page) {
  await page.addStyleTag({ content: `
    #canvas-acceptance-pointer {
      position: fixed;
      left: 18px;
      top: 92px;
      z-index: 2147483647;
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 7px;
      color: #ecfeff;
      font: 600 12px/1 system-ui, sans-serif;
      background: rgba(10, 26, 34, .9);
      border: 1px solid #22d3ee;
      border-radius: 6px;
      padding: 7px 9px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
      transition: left .16s ease, top .16s ease;
    }
    #canvas-acceptance-pointer::before {
      content: "";
      width: 10px;
      height: 10px;
      border: 2px solid #22d3ee;
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(34, 211, 238, .2);
    }
  ` });
  await page.evaluate(() => {
    const marker = document.createElement("div");
    marker.id = "canvas-acceptance-pointer";
    marker.textContent = "自动验收记录中";
    document.body.appendChild(marker);
    document.addEventListener("click", (event) => {
      marker.style.left = `${Math.min(window.innerWidth - 145, Math.max(10, event.clientX + 12))}px`;
      marker.style.top = `${Math.min(window.innerHeight - 42, Math.max(10, event.clientY + 12))}px`;
    }, true);
  });
}

async function waitForStage(page: Page, kind: MediaKind, timeoutMs: number) {
  const started = Date.now();
  let activeObserved = false;
  let lastSummary = "";
  while (Date.now() - started < timeoutMs) {
    const snapshot = await stageSnapshot(page, kind);
    const controlsVisible = await page.locator(".free-canvas-actions .batch-control").count() > 0;
    activeObserved ||= controlsVisible || snapshot.running > 0;
    const summary = `${snapshot.succeeded}/${snapshot.total} 完成，${snapshot.running} 运行，${snapshot.failed} 失败，${snapshot.pending} 等待`;
    if (summary !== lastSummary) {
      console.log(`[acceptance] ${kind === "image" ? "图片" : "视频"}：${summary}`);
      lastSummary = summary;
    }
    if (activeObserved && !controlsVisible && snapshot.running === 0) return snapshot;
    if (!activeObserved && Date.now() - started > 15_000) return snapshot;
    await page.waitForTimeout(3_000);
  }
  throw new Error(`${kind === "image" ? "图片" : "视频"}批量阶段超过 ${Math.round(timeoutMs / 60_000)} 分钟仍未结束`);
}

async function runAllGeneration(page: Page, context: BrowserContext, report: AcceptanceReport) {
  const button = page.locator(".free-canvas-actions .run-all");
  assert.equal(await button.isDisabled(), false, "全部生成按钮不可用");
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  console.log("[acceptance] 点击真实画布‘全部生成’，等待角色定妆图、参考图、视频三个阶段依次完成");
  await button.evaluate((element: HTMLButtonElement) => element.click());

  let observedRunning = false;
  let lastSummary = "";
  const timeoutMs = 120 * 60_000;
  while (Date.now() - startedMs < timeoutMs) {
    const images = await stageSnapshot(page, "image");
    const videos = await stageSnapshot(page, "video");
    const controlsVisible = await page.locator(".free-canvas-actions .batch-control").count() > 0;
    const runButtonDisabled = await button.isDisabled();
    observedRunning ||= controlsVisible || runButtonDisabled || images.running > 0 || videos.running > 0;
    const summary = `图片 ${images.succeeded}/${images.total}（运行${images.running} 失败${images.failed}）；视频 ${videos.succeeded}/${videos.total}（运行${videos.running} 失败${videos.failed}）`;
    if (summary !== lastSummary) {
      console.log(`[acceptance] ${summary}`);
      lastSummary = summary;
    }
    const allSucceeded = images.total > 0 && videos.total > 0
      && images.succeeded === images.total && videos.succeeded === videos.total;
    if (observedRunning && !controlsVisible && !runButtonDisabled && images.running === 0 && videos.running === 0) {
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;
      report.stages.push(
        { kind: "image", attempt: 1, startedAt, completedAt, durationMs, result: images },
        { kind: "video", attempt: 1, startedAt, completedAt, durationMs, result: videos },
      );
      await context.storageState({ path: storageStatePath });
      await page.screenshot({ path: `${outputDirectory}/03-all-generation-finished.png`, fullPage: true });
      await persistReport(report);
      if (allSucceeded) return { images, videos };
      throw new Error(`全部生成未完整结束：${summary}；${[...images.failedNodes, ...videos.failedNodes].map((node) => `${node.title}：${node.error}`).join("；")}`);
    }
    await page.waitForTimeout(5_000);
  }
  throw new Error("全部生成超过120分钟仍未结束");
}

async function runStage(
  page: Page,
  context: BrowserContext,
  report: AcceptanceReport,
  kind: MediaKind,
  maxAttempts: number,
) {
  const button = page.locator(`.free-canvas-actions .workflow-step.${kind}`);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await stageSnapshot(page, kind);
    if (before.total > 0 && before.succeeded === before.total) return before;
    assert.equal(await button.isDisabled(), false, `${kind === "image" ? "批量生图" : "批量视频"}按钮不可用`);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    console.log(`[acceptance] 开始${kind === "image" ? "批量生图" : "批量视频"}，第 ${attempt} 次执行`);
    await button.evaluate((element: HTMLButtonElement) => element.click());
    await page.waitForTimeout(1_000);
    const immediateNotice = await page.locator(".free-page-notice span").textContent().catch(() => "");
    const immediateControls = await page.locator(".free-canvas-actions .batch-control").count();
    const immediateSnapshot = await stageSnapshot(page, kind);
    console.log(`[acceptance] 点击后状态：队列控件 ${immediateControls}；提示“${immediateNotice || "无"}”；运行 ${immediateSnapshot.running}，等待 ${immediateSnapshot.pending}`);
    const result = await waitForStage(page, kind, kind === "image" ? 60 * 60_000 : 90 * 60_000);
    report.stages.push({
      kind,
      attempt,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      result,
    });
    await context.storageState({ path: storageStatePath });
    await persistReport(report);
    await page.screenshot({ path: `${outputDirectory}/${kind}-${attempt}-complete.png`, fullPage: true });
    if (result.succeeded === result.total) return result;
    console.log(`[acceptance] ${kind === "image" ? "图片" : "视频"}第 ${attempt} 次结束，准备重试 ${result.failed + result.pending} 个未完成节点`);
  }
  const final = await stageSnapshot(page, kind);
  throw new Error(`${kind === "image" ? "图片" : "视频"}仍有 ${final.failed + final.pending} 个节点未完成：${final.failedNodes.map((node) => `${node.title}：${node.error}`).join("；")}`);
}

async function runTrialImageShots(
  page: Page,
  context: BrowserContext,
  report: AcceptanceReport,
  shotNumbers: number[],
) {
  const imageNodes = (await graphNodes(page)).filter((node) => node.data.kind === "image");
  for (let index = 0; index < shotNumbers.length; index += 1) {
    const shotNumber = shotNumbers[index];
    const shotLabel = String(shotNumber).padStart(2, "0");
    const target = imageNodes.find((node) => node.data.title.startsWith(`分镜${shotLabel} ·`));
    assert.ok(target, `没有找到分镜${shotLabel}的图片节点`);
    if (target.data.outputUrl) continue;

    const node = page.locator(`.react-flow__node[data-id="${target.id}"]`);
    const generateButton = node.locator('button[title="生成图片"]');
    assert.equal(await generateButton.count(), 1, `分镜${shotLabel}图片节点缺少生成按钮`);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    console.log(`[acceptance] 试生成分镜${shotLabel}参考图（${index + 1}/${shotNumbers.length}）`);
    await generateButton.evaluate((element: HTMLButtonElement) => element.click());

    let completed = false;
    while (Date.now() - startedMs < 20 * 60_000) {
      await page.waitForTimeout(3_000);
      const current = (await graphNodes(page)).find((item) => item.id === target.id);
      if (current?.data.outputUrl) {
        completed = true;
        break;
      }
      if (current?.data.status === "failed") {
        throw new Error(`分镜${shotLabel}生图失败：${current.data.error || "未知错误"}`);
      }
    }
    assert.ok(completed, `分镜${shotLabel}生图超过20分钟仍未完成`);
    report.stages.push({
      kind: "image",
      attempt: index + 1,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      result: await stageSnapshot(page, "image"),
    });
    await context.storageState({ path: storageStatePath });
    await persistReport(report);
  }
}

async function downloadAsset(request: APIRequestContext, asset: AssetRecord, index: number) {
  try {
    const response = await request.get(asset.outputUrl, { timeout: 180_000 });
    if (!response.ok()) return undefined;
    const contentType = response.headers()["content-type"] || "";
    const extension = asset.kind === "video"
      ? contentType.includes("webm") ? "webm" : "mp4"
      : contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
    const shot = asset.title.match(/分镜(\d+)/u)?.[1] || "asset";
    const path = `${outputDirectory}/${String(index + 1).padStart(2, "0")}-${asset.kind}-${shot}.${extension}`;
    await writeFile(path, await response.body());
    return path;
  } catch {
    return undefined;
  }
}

async function inspectMedia(page: Page, asset: AssetRecord) {
  if (asset.kind === "image") {
    const dimensions = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, asset.outputUrl);
    asset.width = dimensions.width;
    asset.height = dimensions.height;
    return;
  }
  asset.actualDurationSeconds = await page.evaluate(async (url) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("视频元数据读取失败"));
    });
    return video.duration;
  }, asset.outputUrl);
}

async function main() {
  assert.ok(liveGenerationEnabled || stopAfterCompile, "付费生成必须显式设置 CANVAS_LIVE_GENERATION=1");
  await mkdir(outputDirectory, { recursive: true });
  if (resumePreparedCanvas) await access(storageStatePath);

  const report: AcceptanceReport = {
    startedAt: new Date().toISOString(),
    source: "free-canvas benchmark director v8 live acceptance",
    script: BENCHMARK_SCRIPT,
    instruction: BENCHMARK_INSTRUCTION,
    aspectRatio: "16:9",
    animationStyle: "cinematic-cartoon-realism-3d",
    videoModelId,
    stages: [],
    requests: [],
    assets: [],
    promptAudit: {
      imagePromptCount: 0,
      videoPromptCount: 0,
      directorDecisionCount: 0,
      forbiddenInternalInstructions: [],
      vagueAssetReferences: [],
      weakVideoDirections: [],
    },
    pageErrors: [],
    consoleErrors: [],
  };

  const requestStarted = new WeakMap<Request, number>();
  const browser = await chromium.launch({
    headless: !headful,
    slowMo: headful ? 90 : 0,
    args: headful ? ["--start-maximized"] : [],
  });

  try {
    const authRequest = await playwrightRequest.newContext();
    const sessionResponse = await authRequest.get(`${baseUrl}/api/auth/dev-session`, {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
    });
    const session = await sessionResponse.json() as { token?: string; error?: string };
    await authRequest.dispose();
    assert.ok(sessionResponse.ok() && session.token, session.error || "本地验收会话不可用");

    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1,
      ...(resumePreparedCanvas ? { storageState: storageStatePath } : {}),
    });
    await context.addInitScript(({ token, reset }) => {
      if (reset) {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("ai-creation-studio-free-canvas") || key === "ai-creation-studio-graph-v1") localStorage.removeItem(key);
        }
      }
      localStorage.setItem("auth_token", token);
    }, { token: session.token, reset: !resumePreparedCanvas });

    const balanceBeforeResponse = await context.request.get(`${baseUrl}/api/bridge/balance`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    report.balanceBefore = Number((await balanceBeforeResponse.json() as { balance?: number }).balance || 0);

    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/bridge/image/") && !path.startsWith("/api/bridge/video/")) return;
      requestStarted.set(request, Date.now());
      let payload: Record<string, unknown> = {};
      try {
        const body = request.postDataJSON() as unknown;
        payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
      } catch {
        payload = {};
      }
      const references = payload.referenceImageUrls;
      report.requests.push({
        path,
        method: request.method(),
        startedAt: new Date().toISOString(),
        modelId: typeof payload.modelId === "string" ? payload.modelId : typeof payload.model_id === "string" ? payload.model_id : undefined,
        taskLabel: typeof payload.task_label === "string" ? payload.task_label : undefined,
        referenceImageCount: Array.isArray(references) ? references.length : payload.image_url ? 1 : 0,
      });
    });
    page.on("response", (response) => {
      const request = response.request();
      const path = new URL(response.url()).pathname;
      if (!path.startsWith("/api/bridge/image/") && !path.startsWith("/api/bridge/video/")) return;
      const pending = [...report.requests].reverse().find((item) => item.path === path && item.status === undefined);
      if (!pending) return;
      pending.status = response.status();
      pending.completedAt = new Date().toISOString();
      pending.durationMs = Date.now() - (requestStarted.get(request) || Date.parse(pending.startedAt));
    });

    const response = await page.goto(`${baseUrl}/free-canvas?revision=full-acceptance-v1`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `自由画布返回 ${response?.status()}`);
    await installVisibleAcceptancePointer(page);
    await openProPanel(page);
    await page.waitForFunction(() => {
      const selects = [...document.querySelectorAll<HTMLSelectElement>(".free-global-models select")];
      return selects.length >= 3 && selects.every((select) => select.options.length > 0);
    });

    const globalModelSelects = page.locator(".free-global-models select");
    const imageOptions = await globalModelSelects.nth(0).locator("option").evaluateAll((options) => options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      text: (option.textContent || "").trim(),
    })));
    const preferredImage = imageOptions.find((option) => option.value === "gemini-3-1-flash-image-chA")
      || imageOptions.find((option) => /Nano Banana 2/i.test(option.text));
    assert.ok(preferredImage, "没有找到支持多角色参考的 Nano Banana 2 生图模型");
    await globalModelSelects.nth(0).selectOption(preferredImage.value);
    await globalModelSelects.nth(2).selectOption(videoModelId);
    const trimSwitch = page.getByRole("switch", { name: "下载时精确裁剪" });
    if (!await trimSwitch.isChecked()) await trimSwitch.check();
    report.imageModel = await globalModelSelects.nth(0).locator("option:checked").innerText();
    report.videoModel = await globalModelSelects.nth(2).locator("option:checked").innerText();
    report.imageModelId = preferredImage.value;
    assert.match(report.videoModel, /Veo 3\.1 Fast/i, "没有选中本轮验收指定的 Veo 3.1 Fast 模型");

    if (!resumePreparedCanvas) {
      await page.getByRole("button", { name: /动漫剧情/ }).click();
      const importerToggle = page.locator("button.free-script-toggle");
      if ((await importerToggle.innerText()).includes("打开")) await importerToggle.click();
      const importer = page.locator(".free-script-importer");
      await importer.locator("textarea").first().fill(BENCHMARK_SCRIPT);
      await selectLabelOption(page, "动画风格", "cinematic-cartoon-realism-3d");
      await selectLabelOption(page, "画面比例", "16:9");
      const advancedToggle = importer.locator("button.free-advanced-toggle");
      if ((await advancedToggle.innerText()).includes("高级设置")) await advancedToggle.click();
      await selectLabelOption(page, "一致性增强", CONSISTENCY_SOURCE);
      await selectLabelOption(page, "自动关键帧位置", "visual-anchor");
      await selectLabelOption(page, "画面修饰强度", "rich");
      const assistantToggle = importer.locator("button.free-assistant-toggle");
      if (await importer.locator(".free-assistant-field").count() === 0) await assistantToggle.click();
      await importer.locator(".free-assistant-field textarea").fill(BENCHMARK_INSTRUCTION);
      await page.screenshot({ path: `${outputDirectory}/01-configured.png`, fullPage: true });

      console.log(`[acceptance] 配置完成：${report.imageModel}；${report.videoModel}；16:9；下载时精确裁剪已开启`);
      console.log("[acceptance] 开始原生画布 AI 镜头拆分");
      const compileStartedMs = Date.now();
      const compileResponsePromise = page.waitForResponse((candidate) => (
        candidate.url().endsWith("/api/canvas/compile-script") && candidate.request().method() === "POST"
      ), { timeout: 360_000 });
      await importer.locator(":scope > button").last().click();
      const compileResponse = await compileResponsePromise;
      const compiled = await compileResponse.json() as {
        compiler?: string;
        semanticSegments?: Array<{ order: number; visualShotCount: number }>;
        shots?: Array<{ semanticOrder: number; visualOrder: number; durationSeconds: number }>;
        error?: string;
      };
      report.compileDurationMs = Date.now() - compileStartedMs;
      report.compiler = compiled.compiler;
      report.semanticSegments = compiled.semanticSegments?.length || 0;
      report.visualShots = compiled.shots?.length || 0;
      assert.ok(compileResponse.ok(), compiled.error || `镜头拆分返回 ${compileResponse.status()}`);
      assert.equal(compiled.compiler, "ai", "原生 GPT 拆镜没有成功，已在付费生成前停止");
      assert.ok((report.visualShots || 0) > 0, "AI 拆镜没有生成视觉镜头");
      assert.ok((report.visualShots || 0) >= (report.semanticSegments || 0), "视觉镜头少于语义段，存在漏拍风险");
      assert.ok(compiled.semanticSegments?.every((segment) => segment.visualShotCount >= 1), "存在没有可见镜头的口播分段");
      assert.ok(compiled.shots?.every((shot) => shot.durationSeconds >= 3 && shot.durationSeconds <= 5), "存在不符合3至5秒要求的生成镜头");

      await page.waitForFunction((visualShots) => {
        const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
        const nodes = graph?.nodes || [];
        return nodes.filter((node) => node.data.kind === "video").length === visualShots
          && nodes.filter((node) => node.data.kind === "image").length >= visualShots;
      }, report.visualShots, { timeout: 120_000 });
      await context.storageState({ path: storageStatePath });
      await page.screenshot({ path: `${outputDirectory}/02-storyboard-complete.png`, fullPage: true });
    } else {
      const resumedNodes = await graphNodes(page);
      report.compiler = "reused-ai";
      report.compileDurationMs = 0;
      report.semanticSegments = resumedNodes.filter((node) => node.data.kind === "text" && /^分镜\d+ · 口播文案/.test(node.data.title)).length;
      report.visualShots = resumedNodes.filter((node) => node.data.kind === "video").length;
      assert.ok((report.visualShots || 0) > 0, "恢复的画布中没有视觉镜头");
      assert.ok((report.visualShots || 0) >= (report.semanticSegments || 0), "恢复画布中的视觉镜头少于口播分段");
      console.log(`[acceptance] 已恢复拆镜画布：${report.semanticSegments} 个口播段，${report.visualShots} 个视觉镜头`);
    }

    const preparedNodes = await graphNodes(page);
    const imagePromptNodes = preparedNodes.filter((node) => node.data.kind === "text" && /· (?:参考图|生图)提示词(?:（[^）]+）)?$/.test(node.data.title));
    const videoPromptNodes = preparedNodes.filter((node) => node.data.kind === "text" && /· 视频提示词(?:（[^）]+）)?$/.test(node.data.title));
    const directorDecisionNodes = preparedNodes.filter((node) => node.data.kind === "text" && /· (?:导演决策 \/ 验收|语义导演卡)$/.test(node.data.title));
    report.promptAudit.imagePromptCount = imagePromptNodes.length;
    report.promptAudit.videoPromptCount = videoPromptNodes.length;
    report.promptAudit.directorDecisionCount = directorDecisionNodes.length;
    const allPromptNodes = [...imagePromptNodes, ...videoPromptNodes];
    report.promptAudit.forbiddenInternalInstructions = allPromptNodes
      .filter((node) => /(?:上游节点|自动开关键|系统生成|不得绕过|执行层|生成协议)/u.test(node.data.prompt || node.data.outputText || ""))
      .map((node) => node.data.title);
    report.promptAudit.vagueAssetReferences = allPromptNodes
      .filter((node) => /(?:同一只(?:狗|犬|宠物|动物)|同一个人|同一位(?:主人|女性|男性|人物))/u.test(node.data.prompt || node.data.outputText || ""))
      .map((node) => node.data.title);
    report.promptAudit.weakVideoDirections = videoPromptNodes
      .filter((node) => !/(?:抬|转|冲|跑|贴|盯|扑|退|摇|颤|停|咬|闻|张|缩|甩|抓|坐|站|趴|滚|滑|挡|推|收|扫)/u.test(node.data.prompt || node.data.outputText || ""))
      .map((node) => node.data.title);
    assert.equal(imagePromptNodes.length, report.visualShots, "生图提示词与视觉镜头没有一一对应");
    assert.equal(videoPromptNodes.length, report.visualShots, "视频提示词与视觉镜头没有一一对应");
    assert.equal(directorDecisionNodes.length, report.visualShots, "导演决策与验收卡片没有逐镜加载");
    assert.equal(report.promptAudit.forbiddenInternalInstructions.length, 0, "最终图视频提示词混入了画布内部说明");
    assert.equal(report.promptAudit.vagueAssetReferences.length, 0, "最终图视频提示词仍用‘同一只/同一个人’代替具体视觉资产");
    assert.equal(report.promptAudit.weakVideoDirections.length, 0, "存在没有明确可见动作的视频提示词");
    await writeFile(`${outputDirectory}/prompt-audit.json`, JSON.stringify({
      imagePrompts: imagePromptNodes.map((node) => ({ title: node.data.title, prompt: node.data.prompt || node.data.outputText || "" })),
      videoPrompts: videoPromptNodes.map((node) => ({ title: node.data.title, prompt: node.data.prompt || node.data.outputText || "" })),
      directorCards: directorDecisionNodes.map((node) => ({ title: node.data.title, content: node.data.prompt || node.data.outputText || "" })),
    }, null, 2), "utf8");
    if (stopAfterCompile) {
      report.completedAt = new Date().toISOString();
      await persistReport(report);
      console.log(`[acceptance] 拆镜和卡片质检完成：${report.semanticSegments} 个口播段，未调用图片或视频模型`);
      await context.close();
      return;
    }
    const preparedImageNodes = preparedNodes.filter((node) => node.data.kind === "image");
    const preparedVideoNodes = preparedNodes.filter((node) => node.data.kind === "video");
    assert.ok(preparedImageNodes.every((node) => node.data.modelId === preferredImage.value), "界面选择 Nano Banana 2，但实际图片节点发生模型串线");
    assert.ok(preparedVideoNodes.every((node) => node.data.modelId === videoModelId), "实际视频节点没有使用验收指定模型");
    assert.ok(preparedVideoNodes.every((node) => (node.data.durationSeconds || 0) >= 3 && (node.data.durationSeconds || 0) <= 5), "存在超出3至5秒的分镜视频");

    const imagePrice = Number(report.imageModel?.match(/¥([0-9.]+)/)?.[1] || 0);
    const videoPrice = Number(report.videoModel?.match(/¥([0-9.]+)/)?.[1] || 0);
    report.expectedMaximumCost = Number((trialImageShots.length > 0
      ? trialImageShots.length * imagePrice
      : stopAfterImages
        ? preparedImageNodes.length * imagePrice
        : preparedImageNodes.length * imagePrice + preparedVideoNodes.length * videoPrice).toFixed(2));
    assert.ok((report.balanceBefore || 0) >= report.expectedMaximumCost, `余额不足：预计最多 ¥${report.expectedMaximumCost.toFixed(2)}，当前 ¥${(report.balanceBefore || 0).toFixed(2)}`);
    await persistReport(report);
    console.log(`[acceptance] 拆镜完成：${report.semanticSegments} 个口播段，${report.visualShots} 个视觉镜头，预计最高费用 ¥${report.expectedMaximumCost.toFixed(2)}`);

    if (trialImageShots.length > 0) {
      await runTrialImageShots(page, context, report, trialImageShots);
    } else if (stopAfterImages) {
      await runStage(page, context, report, "image", 2);
    } else {
      await runAllGeneration(page, context, report);
    }
    const imageNodesAfterGeneration = (await graphNodes(page)).filter((node) => (
      node.data.kind === "image" && (trialImageShots.length === 0 || Boolean(node.data.outputUrl))
    ));
    const imageAssets: AssetRecord[] = imageNodesAfterGeneration.map((node) => ({
      title: node.data.title,
      kind: "image",
      modelId: node.data.modelId || "",
      outputUrl: node.data.outputUrl || "",
    }));
    assert.ok(imageAssets.every((asset) => asset.outputUrl), "存在没有输出地址的参考图节点");
    if (trialImageShots.length > 0) assert.equal(imageAssets.length, trialImageShots.length, "试生成图片数量与指定分镜数量不一致");
    for (let index = 0; index < imageAssets.length; index += 1) {
      await inspectMedia(page, imageAssets[index]);
      imageAssets[index].savedPath = await downloadAsset(context.request, imageAssets[index], index);
    }
    report.assets = imageAssets;
    await context.storageState({ path: storageStatePath });
    await page.screenshot({ path: `${outputDirectory}/03-images-ready-for-review.png`, fullPage: true });
    await persistReport(report);
    if (trialImageShots.length > 0) {
      report.completedAt = new Date().toISOString();
      await persistReport(report);
      console.log(`[acceptance] 代表性图片检查点完成：分镜 ${trialImageShots.join("、")} 已生成，其他图片和全部视频均未启动`);
      if (keepOpenMs > 0) await page.waitForTimeout(keepOpenMs);
      await context.close();
      return;
    }
    if (stopAfterImages) {
      report.completedAt = new Date().toISOString();
      await persistReport(report);
      console.log(`[acceptance] 图片检查点完成：${imageAssets.length} 张参考图已落盘，视频阶段尚未启动`);
      await context.close();
      return;
    }
    console.log("[acceptance] 全部参考图已生成，开始视频阶段");
    await runStage(page, context, report, "video", 2);

    const completedNodes = await graphNodes(page);
    const mediaNodes = completedNodes.filter((node) => node.data.kind === "image" || node.data.kind === "video");
    report.assets = mediaNodes.map((node) => ({
      title: node.data.title,
      kind: node.data.kind as MediaKind,
      modelId: node.data.modelId || "",
      targetDurationSeconds: node.data.kind === "video" ? node.data.durationSeconds : undefined,
      outputUrl: node.data.outputUrl || "",
    }));
    assert.ok(report.assets.every((asset) => asset.outputUrl), "存在没有输出地址的图片或视频节点");

    for (let index = 0; index < report.assets.length; index += 1) {
      const asset = report.assets[index];
      await inspectMedia(page, asset);
      asset.savedPath = await downloadAsset(context.request, asset, index);
      if (asset.kind === "video" && asset.targetDurationSeconds && Number.isFinite(asset.actualDurationSeconds)) {
        assert.ok(Math.abs((asset.actualDurationSeconds || 0) - asset.targetDurationSeconds) <= 0.12,
          `${asset.title}成片 ${asset.actualDurationSeconds}s，与目标 ${asset.targetDurationSeconds}s 不一致`);
      }
      await persistReport(report);
    }

    const balanceAfterResponse = await context.request.get(`${baseUrl}/api/bridge/balance`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    report.balanceAfter = Number((await balanceAfterResponse.json() as { balance?: number }).balance || 0);
    report.completedAt = new Date().toISOString();
    await context.storageState({ path: storageStatePath });
    await page.screenshot({ path: `${outputDirectory}/03-all-media-complete.png`, fullPage: true });
    await persistReport(report);
    console.log(`[acceptance] 全链路完成：${report.assets.filter((asset) => asset.kind === "image").length} 张图片，${report.assets.filter((asset) => asset.kind === "video").length} 条视频，实际扣费 ¥${((report.balanceBefore || 0) - (report.balanceAfter || 0)).toFixed(2)}`);

    if (keepOpenMs > 0) {
      console.log(`[acceptance] 最终画布保留 ${Math.round(keepOpenMs / 1000)} 秒供查看`);
      await page.waitForTimeout(keepOpenMs);
    }
    await context.close();
  } catch (error) {
    report.error = error instanceof Error ? error.stack || error.message : String(error);
    report.completedAt = new Date().toISOString();
    await persistReport(report);
    throw error;
  } finally {
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
