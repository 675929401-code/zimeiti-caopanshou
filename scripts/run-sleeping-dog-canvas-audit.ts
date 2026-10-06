import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, request as playwrightRequest, type Page } from "playwright";
import { DOG_SLEEP_WOMAN_INSTRUCTION, DOG_SLEEP_WOMAN_SCRIPT } from "../src/lib/canvas-demo-scripts";
import { auditStoryboardImagePrompt } from "../src/lib/canvas-prompt-presets";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDirectory = ".tmp-e2e/sleeping-dog-woman-canvas-audit";
const historyKey = "ai-creation-studio-free-canvas-run-history-v1";

const sourceScript = DOG_SLEEP_WOMAN_SCRIPT;

type StoredNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    prompt: string;
    outputText?: string;
    modelId?: string;
    aspectRatio?: string;
    durationSeconds?: number;
    semanticOrder?: number;
    visualOrder?: number;
    requiresExactDuration?: boolean;
    ambientSoundOnly?: boolean;
    generationBlockedReason?: string;
    status?: string;
  };
};

type StoredEdge = {
  source: string;
  target: string;
};

type RunRecord = {
  id: string;
  canvasName: string;
  status: string;
  sourceScript: string;
  styleGuide: string;
  aspectRatio: string;
  promptPreset: string;
  imageModelId: string;
  videoModelId: string;
  startedAt: string;
  nodes: StoredNode[];
  edges: StoredEdge[];
};

type CompileResponse = {
  compiler?: "ai" | "deterministic-fallback";
  compilerDiagnostics?: Array<{
    model: string;
    stage: string;
    status: "accepted" | "rejected" | "failed";
    durationMs: number;
    detail?: string;
  }>;
  qualityNotes?: string[];
  semanticSegments?: Array<{
    order: number;
    narration: string;
    durationSeconds: number;
    visualShotCount: number;
  }>;
  shots?: Array<{
    semanticOrder: number;
    visualOrder: number;
    durationSeconds: number;
    effectsPrompt: string;
    imagePrompt: string;
    videoPrompt: string;
  }>;
  error?: string;
};

type AuditIssue = {
  level: "error" | "warning" | "note";
  check: string;
  detail: string;
};

function compact(value: string, maxLength = 260) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}…`;
}

function pushCheck(issues: AuditIssue[], condition: boolean, check: string, detail: string, level: AuditIssue["level"] = "error") {
  if (!condition) issues.push({ level, check, detail });
}

async function openProPanel(page: Page) {
  const toggle = page.locator(".free-canvas-actions button[aria-pressed]");
  await toggle.waitFor({ state: "visible" });
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.locator(".free-pro-panel").waitFor({ state: "visible" });
}

async function selectLabelOption(page: Page, labelText: string, value: string) {
  const label = page.locator(".free-script-importer label").filter({ hasText: labelText }).first();
  await label.waitFor({ state: "visible" });
  await label.locator("select").selectOption(value);
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: process.env.CANVAS_HEADFUL !== "1" });
  try {
    const authRequest = await playwrightRequest.newContext();
    const sessionResponse = await authRequest.get(`${baseUrl}/api/auth/dev-session`, {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
    });
    const session = await sessionResponse.json() as { token?: string; error?: string };
    await authRequest.dispose();
    assert.ok(sessionResponse.ok() && session.token, session.error || "本地验收会话不可用");

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript(({ token }) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("ai-creation-studio-free-canvas") || key === "ai-creation-studio-graph-v1") {
          localStorage.removeItem(key);
        }
      }
      localStorage.setItem("auth_token", token);
    }, { token: session.token });

    const page = await context.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const postRequests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      postRequests.push(pathname);
    });

    const response = await page.goto(`${baseUrl}/free-canvas`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `自由画布返回 ${response?.status()}`);
    await page.locator(".free-canvas-workspace").waitFor({ state: "visible" });
    await openProPanel(page);

    await page.getByRole("button", { name: /动漫剧情/ }).click();
    const importerToggle = page.locator("button.free-script-toggle");
    if ((await importerToggle.innerText()).includes("打开")) await importerToggle.click();
    const importer = page.locator(".free-script-importer");
    await importer.waitFor({ state: "visible" });
    await importer.locator("textarea").first().fill(sourceScript);
    await selectLabelOption(page, "动画风格", "cinematic-cartoon-realism-3d");
    await selectLabelOption(page, "画面比例", "16:9");

    const advancedToggle = importer.locator("button.free-advanced-toggle");
    if ((await advancedToggle.innerText()).includes("高级设置")) await advancedToggle.click();
    await selectLabelOption(page, "一致性增强", "auto");
    await selectLabelOption(page, "自动关键帧位置", "visual-anchor");
    await selectLabelOption(page, "画面修饰强度", "rich");
    const assistantToggle = importer.locator("button.free-assistant-toggle");
    if (await importer.locator(".free-assistant-field").count() === 0) await assistantToggle.click();
    await importer.locator(".free-assistant-field textarea").fill(DOG_SLEEP_WOMAN_INSTRUCTION);

    await page.waitForFunction(() => {
      const selects = [...document.querySelectorAll<HTMLSelectElement>(".free-global-models select")];
      return selects.length === 3 && selects.every((select) => select.options.length > 0);
    });
    const globalModelSelects = page.locator(".free-global-models select");
    const imageOptions = await globalModelSelects.nth(0).locator("option").evaluateAll((options) => options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      text: option.textContent || "",
    })));
    const preferredImage = imageOptions.find((option) => /GPT-Image-2/i.test(option.text));
    assert.ok(preferredImage, "没有找到 GPT-Image-2 生图模型");
    await globalModelSelects.nth(0).selectOption(preferredImage.value);
    await globalModelSelects.nth(2).selectOption("veo-3-1-fast-chC");
    const trimSwitch = page.getByRole("switch", { name: "下载时精确裁剪" });
    if (!await trimSwitch.isChecked()) await trimSwitch.check();
    const selectedImageModel = await globalModelSelects.nth(0).locator("option:checked").innerText();
    const selectedVideoModel = await globalModelSelects.nth(2).locator("option:checked").innerText();

    await page.screenshot({ path: `${outputDirectory}/01-configured.png`, fullPage: true });

    const compileResponsePromise = page.waitForResponse((candidate) => (
      candidate.url().endsWith("/api/canvas/compile-script") && candidate.request().method() === "POST"
    ), { timeout: 300_000 });
    const compileButton = importer.locator(":scope > button").last();
    const compileStartedAt = Date.now();
    await compileButton.click();
    const compileResponse = await compileResponsePromise;
    const compileDurationMs = Date.now() - compileStartedAt;
    const compileRequestBody = compileResponse.request().postDataJSON() as Record<string, unknown>;
    const compiled = await compileResponse.json() as CompileResponse;
    assert.ok(compileResponse.ok(), compiled.error || `镜头拆分返回 ${compileResponse.status()}`);

    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length >= 4, null, { timeout: 30_000 });
    await page.screenshot({ path: `${outputDirectory}/02-building.png`, fullPage: true });

    await page.waitForFunction(({ key, script }) => {
      const records = JSON.parse(localStorage.getItem(key) || "[]") as RunRecord[];
      return records.some((record) => record.sourceScript === script && record.status === "draft");
    }, { key: historyKey, script: sourceScript }, { timeout: 90_000 });
    await page.waitForTimeout(900);

    const run = await page.evaluate(({ key, script }) => {
      const records = JSON.parse(localStorage.getItem(key) || "[]") as RunRecord[];
      return records.find((record) => record.sourceScript === script) || null;
    }, { key: historyKey, script: sourceScript }) as RunRecord | null;
    assert.ok(run, "画布没有写入本次运行历史");

    const nodes = run.nodes;
    const briefNode = nodes.find((node) => node.data.title === "完整文案 Brief");
    const qualityNode = nodes.find((node) => node.data.title === "生成前质检 / 纠错记录");
    const analysisNode = nodes.find((node) => node.data.title.startsWith("AI拆镜"));
    const consistencyNode = nodes.find((node) => node.data.title === "全片角色 / 风格设定（全文提取）");
    const suspendedPostProductionNodes = nodes.filter((node) => /配音|字幕|三轨合成/.test(node.data.title));
    const narrationNodes = nodes
      .filter((node) => /^分镜\d+ · 口播文案/.test(node.data.title))
      .sort((a, b) => (a.data.semanticOrder || 0) - (b.data.semanticOrder || 0));
    const directorNodes = nodes
      .filter((node) => /分镜\d+ · 视频提示词（先生成）$/.test(node.data.title))
      .sort((a, b) => (a.data.visualOrder || 0) - (b.data.visualOrder || 0));
    const imagePromptNodes = nodes
      .filter((node) => node.data.kind === "text" && /分镜\d+ · 生图提示词（由视频提示词反推）$/.test(node.data.title))
      .sort((a, b) => (a.data.visualOrder || 0) - (b.data.visualOrder || 0));
    const imageNodes = nodes
      .filter((node) => node.data.kind === "image" && /自动关键帧/.test(node.data.title))
      .sort((a, b) => (a.data.visualOrder || 0) - (b.data.visualOrder || 0));
    const videoNodes = nodes
      .filter((node) => node.data.kind === "video" && /关键帧生成视频/.test(node.data.title))
      .sort((a, b) => (a.data.visualOrder || 0) - (b.data.visualOrder || 0));
    const uploadNodes = nodes.filter((node) => node.data.kind === "upload");
    const imagePromptQuality = imagePromptNodes.map((node) => {
      const narration = narrationNodes.find((candidate) => candidate.data.semanticOrder === node.data.semanticOrder)?.data.prompt || "";
      return {
        title: node.data.title,
        length: node.data.prompt.replace(/\s+/g, " ").trim().length,
        issues: auditStoryboardImagePrompt(node.data.prompt, narration, 780),
      };
    });
    const imagePromptCores = imagePromptNodes.map((node) => (
      node.data.prompt.match(/静态画面：([\s\S]*?)\n角色连续性：/u)?.[1]?.trim() || node.data.prompt
    ));

    const issues: AuditIssue[] = [];
    pushCheck(issues, run.sourceScript === sourceScript, "原文保真", "运行历史中的原始文案发生了变化");
    pushCheck(issues, briefNode?.data.prompt === sourceScript, "Brief保真", "完整文案 Brief 未逐字保留用户原文");
    pushCheck(issues, narrationNodes.map((node) => node.data.prompt).join("").replace(/\s+/g, "") === sourceScript.replace(/\s+/g, ""), "口播覆盖", "口播语义段未连续、完整覆盖原文");
    pushCheck(issues, run.aspectRatio === "16:9", "横屏比例", `实际比例为 ${run.aspectRatio}`);
    pushCheck(issues, compileRequestBody?.effectsLevel === "rich", "动漫剧情默认包装", `实际请求强度为 ${String(compileRequestBody?.effectsLevel || "未设置")}`);
    pushCheck(issues, run.styleGuide.includes("电影级3D卡通半写实"), "动画风格", "运行记录没有锁定电影级3D卡通半写实风格");
    pushCheck(issues, /gpt-image-2/i.test(selectedImageModel), "默认生图模型", `实际选中：${selectedImageModel}`);
    pushCheck(issues, run.imageModelId === preferredImage.value && imageNodes.every((node) => node.data.modelId === preferredImage.value), "生图模型落地", `界面选中 ${preferredImage.value}，运行记录为 ${run.imageModelId}，节点实际模型：${[...new Set(imageNodes.map((node) => node.data.modelId))].join("、")}`);
    pushCheck(issues, /veo 3\.1 fast/i.test(selectedVideoModel), "验收视频模型", `实际选中：${selectedVideoModel}`);
    pushCheck(issues, Boolean(analysisNode), "拆镜分析", "缺少原生画布拆镜分析节点");
    pushCheck(issues, Boolean(consistencyNode), "全片一致性", "缺少全文角色与风格设定节点");
    pushCheck(issues, consistencyNode?.data.prompt.includes("成年女主人") === true, "女主人锁定", "全片设定没有固定成年女主人");
    pushCheck(issues, suspendedPostProductionNodes.length === 0, "聚焦媒体生成", "当前阶段仍创建了配音、字幕或三轨合成节点");
    pushCheck(issues, uploadNodes.length === 0, "自动化入口", "全文自动一致性模式不应强制创建上传节点");
    pushCheck(issues, narrationNodes.length >= 3, "语义分段", `只生成了 ${narrationNodes.length} 个口播语义段`);
    pushCheck(issues, narrationNodes.length === directorNodes.length && directorNodes.length === imagePromptNodes.length && imagePromptNodes.length === imageNodes.length && imageNodes.length === videoNodes.length, "分镜一一对应", `口播文案 ${narrationNodes.length}、视频提示词 ${directorNodes.length}、生图提示词 ${imagePromptNodes.length}、参考图 ${imageNodes.length}、视频 ${videoNodes.length}`);
    pushCheck(issues, (compiled.semanticSegments || []).every((segment) => segment.visualShotCount === 1), "每分镜单镜头", "存在一个分镜拆成两个或更多视频镜头");
    pushCheck(issues, (compiled.shots || []).every((shot) => shot.semanticOrder === shot.visualOrder), "分镜序号对齐", "存在参考图或视频序号与口播分镜序号不一致");
    pushCheck(issues, imagePromptNodes.every((node) => node.data.prompt.trim().length > 0), "生图提示词可见", "存在空白或缺失的独立生图提示词节点");
    pushCheck(issues, imagePromptNodes.every((node) => node.data.prompt.includes("必画语义证据（优先执行）：")), "参考图语义强化层", "存在未把语义重点、剧情表演、叙事道具、环境反馈和特效决策前置的生图提示词");
    pushCheck(issues, (compiled.shots || []).every((shot) => shot.imagePrompt.includes(shot.effectsPrompt)), "语义传递闭环", "生图提示词没有落实对应镜头的effectsPrompt");
    pushCheck(issues, (compiled.shots || []).every((shot) => !/(?:保持干净|可加入|例如|根据语义)/u.test(shot.effectsPrompt)), "语义执行性", "存在空泛、候选式或未决的语义强化提示词");
    pushCheck(issues, (compiled.shots || []).every((shot) => ["语义重点", "剧情表演", "叙事道具", "环境反馈", "图形特效"].every((layer) => shot.effectsPrompt.includes(`【${layer}】`))), "语义视觉决策", "存在缺少语义重点、剧情表演、叙事道具、环境反馈或图形特效决策的镜头");
    pushCheck(issues, imageNodes.every((node) => node.data.prompt === "{{input.text}}"), "生图输入隔离", "图片生成节点没有只读取上游生图提示词");
    pushCheck(issues, videoNodes.every((node) => node.data.prompt === "{{input.text}}"), "视频输入隔离", "视频生成节点没有只读取上游视频提示词");
    pushCheck(issues, videoNodes.length === narrationNodes.length, "剧情画面密度", `口播分镜 ${narrationNodes.length}、视频 ${videoNodes.length}`);
    pushCheck(issues, imageNodes.every((node) => node.data.aspectRatio === "16:9"), "关键帧比例", "存在非16:9关键帧");
    pushCheck(issues, imagePromptNodes.every((node) => node.data.prompt.includes("电影级3D卡通半写实")), "关键帧风格", "存在未携带动画风格的生图提示词");
    pushCheck(issues, imagePromptNodes.every((node) => !/画面：固定为|角色锁定：固定为/u.test(node.data.prompt)), "主体提取纯度", "补充要求中的操作词被错误写入主体名称");
    pushCheck(issues, imagePromptNodes.every((node) => !/(?:\d+(?:\.\d+)?\s*[-—至]\s*\d+(?:\.\d+)?\s*秒|镜头(?:推进|拉远|摇移)|随后|逐渐|最后)/u.test(node.data.prompt)), "静态提示词纯度", "生图提示词混入时间轴、运镜或过程词");
    pushCheck(issues, imagePromptQuality.every((item) => item.issues.length === 0), "对标级生图提示词", imagePromptQuality.filter((item) => item.issues.length > 0).map((item) => `${item.title}：${item.issues.join("；")}`).join(" | "));
    pushCheck(issues, new Set(imagePromptCores).size === imagePromptCores.length, "静态构图查重", `共 ${imagePromptCores.length} 个镜头，去除节点标题后只有 ${new Set(imagePromptCores).size} 个独立静态方案`);
    pushCheck(issues, videoNodes.every((node) => (node.data.durationSeconds || 0) >= 3 && (node.data.durationSeconds || 0) <= 5), "分镜时长", "存在超出3到5秒的分镜视频");
    pushCheck(issues, videoNodes.every((node) => Number.isInteger(node.data.durationSeconds)), "整数秒直出", "存在需要向上取整并裁剪的半秒镜头");
    pushCheck(issues, videoNodes.every((node) => node.data.requiresExactDuration === true), "精确时长", "存在未要求精确时长的视频节点");
    pushCheck(issues, videoNodes.every((node) => node.data.ambientSoundOnly === true), "仅场景原声", "存在未启用场景原声硬约束的视频节点");
    pushCheck(issues, directorNodes.every((node) => /使用系统自动生成的@?参考图1开演/u.test(node.data.prompt)), "参考图绑定", "存在未绑定同镜头自动关键帧的视频提示词");
    pushCheck(issues, directorNodes.every((node) => ["入镜", "预备", "主动作", "反应", "落幅"].every((tag) => node.data.prompt.includes(`【${tag}】`))), "五段动作链", "存在未写清入镜、预备、主动作、反应或落幅的镜头");
    pushCheck(issues, directorNodes.every((node) => /夸张但连贯/u.test(node.data.prompt)), "剧情表演强度", "视频提示词仍把动画化夸张表演作为可选项");
    pushCheck(issues, directorNodes.every((node) => /保持屏幕方向、视线、道具状态与光线连续/u.test(node.data.prompt)), "跨镜连续锚点", "视频提示词没有锁定屏幕方向、视线、道具状态与光线连续");
    pushCheck(issues, directorNodes.every((node) => /音频硬约束：仅生成与本镜画面逐拍同步的现场原声：[^。\n]{6,}/u.test(node.data.prompt)), "场景动作音", "视频提示词缺少与可见动作同步的具体现场原声");
    pushCheck(issues, directorNodes.every((node) => /音轨必须完全没有背景音乐、配乐、BGM/u.test(node.data.prompt)), "后期音轨隔离", "视频提示词没有明确禁止背景音乐、旁白和配音");
    pushCheck(issues, directorNodes.every((node) => !/(?:旁白文案|口播文案|字幕内容|TTS|配音：|(?:加入|使用|配上|伴随|铺设|播放)[^。；]{0,12}(?:背景音乐|配乐|BGM)|(?:背景音乐|配乐|BGM)\s*[：:]\s*(?!无|禁止|不))/iu.test(node.data.prompt)), "视频提示词纯度", "视频模型提示词混入口播、配音、字幕或正向背景音乐指令");
    pushCheck(issues, compiled.compiler !== "deterministic-fallback" || Boolean(qualityNode), "回退质检记录", "稳定规则预览没有生成醒目的质检节点");
    pushCheck(issues, compiled.compiler !== "deterministic-fallback" || [...imageNodes, ...videoNodes].every((node) => Boolean(node.data.generationBlockedReason)), "回退费用保护", "稳定规则预览仍允许直接执行付费媒体节点");
    pushCheck(issues, pageErrors.length === 0, "页面稳定性", pageErrors.join(" | "));
    pushCheck(issues, [...new Set(postRequests)].every((path) => path === "/api/canvas/compile-script" || path === "/api/diagnostic-logs"), "费用隔离", `拆镜阶段出现了付费媒体或其他未知POST请求：${[...new Set(postRequests)].join("、")}`);
    pushCheck(issues, compiled.compiler === "ai", "原生AI编排", compiled.compiler === "deterministic-fallback" ? "当前浏览器未连接主平台，画布使用稳定规则回退，未调用GPT拆镜模型" : "编排器未返回AI状态", "warning");

    await page.screenshot({ path: `${outputDirectory}/03-final-canvas.png`, fullPage: true });
    await openProPanel(page);
    const runHistoryList = page.locator(".free-run-history-list");
    if (await runHistoryList.count() > 0 && await runHistoryList.isVisible()) {
      await runHistoryList.scrollIntoViewIfNeeded();
    } else {
      await page.locator(".free-pro-panel").evaluate((panel) => panel.scrollTo({ top: panel.scrollHeight }));
    }
    await page.screenshot({ path: `${outputDirectory}/04-history-and-record.png`, fullPage: true });

    const report = {
      generatedAt: new Date().toISOString(),
      executionSurface: "free-canvas native UI",
      sourcePreserved: run.sourceScript === sourceScript,
      compiler: compiled.compiler || "unknown",
      compileDurationMs,
      compilerDiagnostics: compiled.compilerDiagnostics || [],
      productionMode: compileRequestBody?.productionMode || "unknown",
      promptPreset: run.promptPreset,
      styleGuide: run.styleGuide,
      aspectRatio: run.aspectRatio,
      selectedImageModel,
      selectedImageModelId: preferredImage.value,
      selectedVideoModel,
      imageModelId: run.imageModelId,
      videoModelId: run.videoModelId,
      narrationSegments: narrationNodes.length,
      visualShots: videoNodes.length,
      directorPromptNodes: directorNodes.length,
      imagePromptNodes: imagePromptNodes.length,
      keyframeImageNodes: imageNodes.length,
      videoPromptNodes: directorNodes.length,
      videoGenerationNodes: videoNodes.length,
      qualityAuditNode: Boolean(qualityNode),
      qualityNotes: compiled.qualityNotes || [],
      generationTriggered: nodes.some((node) => node.data.status === "running" || node.data.status === "succeeded"),
      postRequests: [...new Set(postRequests)],
      pageErrors,
      consoleErrors,
      issues,
      imagePromptQuality,
      samples: {
        firstNarration: narrationNodes[0]?.data.prompt || "",
        firstDirectorPrompt: compact(directorNodes[0]?.data.prompt || ""),
        firstImagePrompt: compact(imagePromptNodes[0]?.data.prompt || ""),
        firstVideoPrompt: compact(directorNodes[0]?.data.prompt || ""),
        qualityRecord: compact(qualityNode?.data.prompt || "没有生成纠错节点"),
      },
    };
    await writeFile(`${outputDirectory}/audit-report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(`${outputDirectory}/canvas-run-record.json`, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));

    assert.equal(issues.filter((issue) => issue.level === "error").length, 0, `发现阻断问题：${issues.filter((issue) => issue.level === "error").map((issue) => issue.check).join("、")}`);

    if (process.env.SKIP_DEMO_ENTRY === "1") return;

    const demoPage = await context.newPage();
    const demoResponse = await demoPage.goto(`${baseUrl}/free-canvas?demo=dog-sleep-woman-audit`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.ok(demoResponse?.ok(), `睡醒守候演示入口返回 ${demoResponse?.status()}`);
    await demoPage.waitForFunction(({ key, script }) => {
      const records = JSON.parse(localStorage.getItem(key) || "[]") as RunRecord[];
      return records.some((record) => record.canvasName === "女主人守护睡眠 · 16:9复测" && record.sourceScript === script);
    }, { key: historyKey, script: sourceScript }, { timeout: 180_000 });
    const demoRun = await demoPage.evaluate((key) => {
      const records = JSON.parse(localStorage.getItem(key) || "[]") as RunRecord[];
      return records.find((record) => record.canvasName === "女主人守护睡眠 · 16:9复测") || null;
    }, historyKey) as RunRecord | null;
    assert.ok(demoRun, "睡醒守候演示入口没有写入当前浏览器画布历史");
    assert.equal(demoRun.aspectRatio, "16:9", "演示入口必须保持横屏比例");
    assert.match(demoRun.styleGuide, /电影级3D卡通半写实/u, "演示入口必须保持选定动画风格");
    const demoQualityNode = demoRun.nodes.find((node) => node.data.title === "生成前质检 / 纠错记录");
    const demoConsistencyNode = demoRun.nodes.find((node) => node.data.title === "全片角色 / 风格设定（全文提取）");
    const demoVideoNodes = demoRun.nodes.filter((node) => node.data.kind === "video" && /关键帧生成视频/.test(node.data.title));
    assert.match(demoQualityNode?.data.prompt || "", /女主人设定只进入角色与画面约束/u, "演示入口没有开启本轮纠错记录");
    assert.match(demoConsistencyNode?.data.prompt || "", /成年女主人/u, "演示入口没有锁定女主人身份");
    assert.ok(demoVideoNodes.every((node) => Number.isInteger(node.data.durationSeconds)), "演示入口仍存在需要裁剪的半秒镜头");
    assert.ok(demoVideoNodes.every((node) => (node.data.durationSeconds || 0) >= 3 && (node.data.durationSeconds || 0) <= 5), "演示入口仍存在超出3到5秒的分镜视频");
    await writeFile(`${outputDirectory}/demo-canvas-run-record.json`, `${JSON.stringify(demoRun, null, 2)}\n`, "utf8");
    await demoPage.screenshot({ path: `${outputDirectory}/05-shareable-demo-entry.png`, fullPage: true });
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
