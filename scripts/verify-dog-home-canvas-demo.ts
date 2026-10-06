import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { DOG_HOME_SCRIPT } from "../src/lib/canvas-demo-scripts";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const historyKey = "ai-creation-studio-free-canvas-run-history-v1";

type DemoNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    prompt: string;
    status?: string;
  };
};

type DemoRun = {
  canvasName: string;
  status: string;
  sourceScript: string;
  styleGuide: string;
  aspectRatio: string;
  nodes: DemoNode[];
};

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const postRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(new URL(request.url()).pathname);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`${baseUrl}/free-canvas?demo=dog-home-audit`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.waitForFunction((key) => {
        const records = JSON.parse(localStorage.getItem(key) || "[]");
        return records.some((record: DemoRun) => record.canvasName === "楼房养狗观点分镜演示" && record.status === "draft");
      }, historyKey, { timeout: 45_000 });
    } catch (error) {
      const diagnostics = await page.evaluate((key) => ({
        url: location.href,
        bodyText: document.body.innerText.slice(0, 3000),
        history: localStorage.getItem(key),
        sessions: localStorage.getItem("ai-creation-studio-free-canvas-sessions-v1"),
        sessionStorage: { ...sessionStorage },
      }), historyKey);
      await mkdir(".tmp-e2e", { recursive: true });
      await page.screenshot({ path: ".tmp-e2e/dog-home-canvas-visible-demo-failure.png", fullPage: true });
      await writeFile(".tmp-e2e/dog-home-canvas-visible-demo-failure.json", `${JSON.stringify({ diagnostics, postRequests, pageErrors }, null, 2)}\n`, "utf8");
      console.error(JSON.stringify({ diagnostics, postRequests, pageErrors }, null, 2));
      throw error;
    }

    const run = await page.evaluate((key) => {
      const records = JSON.parse(localStorage.getItem(key) || "[]") as DemoRun[];
      return records.find((record) => record.canvasName === "楼房养狗观点分镜演示") || null;
    }, historyKey) as DemoRun | null;
    assert.ok(run, "演示必须写入运行历史");

    const qualityNodes = run.nodes.filter((node) => node.data.title === "生成前质检 / 纠错记录");
    const narrationNodes = run.nodes.filter((node) => /^口播段\d+/.test(node.data.title) && node.data.kind === "text");
    const directorNodes = run.nodes.filter((node) => node.data.kind === "text" && /视频提示词（先生成）$/.test(node.data.title));
    const imagePromptNodes = run.nodes.filter((node) => node.data.kind === "text" && /生图提示词（由视频提示词反推）$/.test(node.data.title));
    const imageNodes = run.nodes.filter((node) => node.data.kind === "image");
    const videoNodes = run.nodes.filter((node) => node.data.kind === "video");
    const uploadNodes = run.nodes.filter((node) => node.data.kind === "upload");
    const suspendedPostProductionNodes = run.nodes.filter((node) => /配音|字幕|三轨合成/.test(node.data.title));
    const generatedNodes = run.nodes.filter((node) => node.data.status === "succeeded" || node.data.status === "running");

    assert.equal(run.sourceScript, DOG_HOME_SCRIPT, "演示必须逐字保留用户原文");
    assert.equal(run.aspectRatio, "16:9", "演示画面比例应为16:9");
    assert.match(run.styleGuide, /电影级3D卡通半写实动画/, "演示必须使用新增动画风格");
    assert.doesNotMatch(run.styleGuide, /视频只生成画面|旁白配音|字幕统一后期/, "风格字段只能包含视觉风格，不能混入工作流说明");
    assert.equal(qualityNodes.length, 1, "画布必须显示一张生成前质检记录卡");
    assert.match(qualityNodes[0].data.prompt, /圣饼/);
    assert.match(qualityNodes[0].data.prompt, /把眼。封存/);
    assert.ok(narrationNodes.length >= 15, `口播段数量过少：${narrationNodes.length}`);
    assert.equal(directorNodes.length, imagePromptNodes.length, "每个视频提示词必须反推一份独立生图提示词");
    assert.equal(imagePromptNodes.length, imageNodes.length, "每份生图提示词必须只连接一张关键帧图片");
    assert.equal(imageNodes.length, videoNodes.length, "每个视频镜头必须只有一张对应自动关键帧");
    assert.equal(uploadNodes.length, 0, "默认全文一致性模式不得强制创建上传节点");
    assert.equal(suspendedPostProductionNodes.length, 0, "当前阶段不得创建配音、字幕或三轨合成节点");
    assert.ok(videoNodes.length >= narrationNodes.length, "剧情画面变化不应少于口播语义段");
    assert.ok(imagePromptNodes.every((node) => node.data.prompt.includes("电影级3D卡通半写实动画")), "生图提示词必须携带风格");
    assert.ok(imagePromptNodes.every((node) => !node.data.prompt.includes("不要求用户上传")), "图片模型提示词不应混入工作流解释");
    assert.ok(imagePromptNodes.every((node) => !/\d+(?:\.\d+)?-\d+(?:\.\d+)?秒/.test(node.data.prompt)), "静态生图提示词不应混入视频时间轴");
    assert.ok(imageNodes.every((node) => node.data.prompt === "{{input.text}}"), "图片生成节点必须只读取上游生图提示词");
    assert.ok(videoNodes.every((node) => node.data.prompt === "{{input.text}}"), "视频生成节点必须只读取上游视频提示词");
    assert.ok(directorNodes.every((node) => node.data.prompt.includes("使用系统自动生成的@参考图1开演")), "视频提示词必须绑定系统生成的同镜头关键帧");
    assert.ok(directorNodes.every((node) => !node.data.prompt.includes("声音：") && !node.data.prompt.includes("旁白文案")), "视频模型提示词不得混入口播或配音");
    assert.ok(directorNodes.every((node) => /环境音|动作音/.test(node.data.prompt)), "环境音和动作音必须保留在视频提示词中");
    assert.ok(directorNodes.every((node) => node.data.prompt.length <= 900), `动漫视频提示词仍然过长：${Math.max(...directorNodes.map((node) => node.data.prompt.length))}字`);
    assert.ok(imagePromptNodes.every((node) => node.data.prompt.length <= 1200), `动漫生图提示词仍然过长：${Math.max(...imagePromptNodes.map((node) => node.data.prompt.length))}字`);
    assert.equal(generatedNodes.length, 0, "镜头拆分阶段不得执行图片或视频生成");
    assert.deepEqual([...new Set(postRequests)], ["/api/canvas/compile-script"], "演示阶段只允许调用分镜编排接口");
    assert.deepEqual(pageErrors, [], "页面不应出现运行时错误");
    await page.waitForTimeout(800);
    const viewport = await page.locator(".react-flow__viewport").evaluate((element) => getComputedStyle(element).transform);
    const zoom = Number(viewport.match(/^matrix\(([^,]+)/)?.[1] || 0);
    assert.ok(zoom >= 0.5, `完成后应聚焦可读镜头行，当前缩放仅为${zoom}`);

    await mkdir(".tmp-e2e", { recursive: true });
    await page.screenshot({ path: ".tmp-e2e/dog-home-canvas-visible-demo.png", fullPage: true });
    const report = {
      generatedAt: new Date().toISOString(),
      canvasName: run.canvasName,
      status: run.status,
      narrationSegments: narrationNodes.length,
      imageNodes: imageNodes.length,
      videoNodes: videoNodes.length,
      qualityAuditNodes: qualityNodes.length,
      postRequests,
      pageErrors,
      generationTriggered: generatedNodes.length > 0,
      viewportZoom: zoom,
    };
    await writeFile(".tmp-e2e/dog-home-canvas-visible-demo.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
