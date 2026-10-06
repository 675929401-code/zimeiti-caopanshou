import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { chromium, type Page } from "playwright";
import { countReadableCharacters } from "../src/lib/canvas-prompt-presets";
import { CAT_HEALTH_SCRIPT } from "../src/lib/canvas-demo-scripts";
import { extractPromptDurationSeconds, extractVideoPromptTimeRanges } from "../src/lib/video-prompt-timing";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const phone = process.env.CANVAS_TEST_PHONE;
const password = process.env.CANVAS_TEST_PASSWORD;
assert.ok(phone && password, "请通过环境变量提供橘猫画布演示账号");

type DemoNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    prompt: string;
    durationSeconds: number;
    status?: string;
    outputUrl?: string;
    error?: string;
  };
};

type DemoHistory = {
  id: string;
  status: string;
  sourceScript: string;
  startedAt: string;
  nodes: DemoNode[];
  events?: Array<{ nodeId: string; status: string; outputUrl?: string }>;
};

async function waitForNodeResult(page: Page, nodeId: string, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const node = await page.evaluate((id) => {
      const raw = localStorage.getItem("ai-creation-studio-free-canvas-sessions-v1");
      const sessions = raw ? JSON.parse(raw) : [];
      return sessions.flatMap((session: { nodes?: DemoNode[] }) => session.nodes || []).find((item: DemoNode) => item.id === id)?.data || null;
    }, nodeId) as DemoNode["data"] | null;
    if (node?.status === "succeeded" && node.outputUrl) return node.outputUrl;
    if (node?.status === "failed") throw new Error(node.error || "节点生成失败");
    await page.waitForTimeout(1500);
  }
  throw new Error(`节点生成等待超时：${nodeId}`);
}

function withoutAuthToken(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value, baseUrl);
    url.searchParams.delete("token");
    return value.startsWith("http") ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const loginResponse = await context.request.post(`${baseUrl}/api/auth/login`, {
      headers: { "User-Agent": "Mozilla/5.0 Cat canvas demonstration" },
      data: { phone, password },
    });
    const login = await loginResponse.json() as { token?: string; error?: string };
    assert.ok(loginResponse.ok() && login.token, login.error || "橘猫演示账号登录失败");
    await context.addInitScript((token) => localStorage.setItem("auth_token", token), login.token);

    const page = await context.newPage();
    await page.goto(`${baseUrl}/free-canvas`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.getByRole("button", { name: "文案生成" }).click();
    await page.getByLabel("原始文案").fill(CAT_HEALTH_SCRIPT);
    await page.getByLabel("画面比例").selectOption("16:9");
    await page.getByRole("button", { name: "高级设置" }).click();
    await page.getByLabel("3D动画整体观感").selectOption("disney-3d");
    await page.getByLabel("默认参考方式").selectOption("single");
    await page.getByLabel("单参考图取帧策略").selectOption("visual-anchor");
    await page.getByLabel("动画修饰强度").selectOption("rich");
    await page.getByRole("button", { name: "和创作助手聊一聊" }).click();
    await page.getByLabel("用大白话补充要求").fill("保持同一只圆润橘白猫；参考图截取动作和情绪最清晰的关键瞬间；允许问号、警示图标、对比图和情绪线，不要字幕，角色不要开口说话。");

    await page.getByRole("button", { name: "生成分镜草稿" }).click();
    await page.getByText(/已使用“.+”完成(?:AI语义拆镜|稳定规则拆镜)/).waitFor({ timeout: 180_000 });
    await page.getByTitle("打开专业画布面板（不改变画布缩放）").click();
    await page.getByText("默认保留 3 天并自动清理。", { exact: false }).waitFor();

    const history = await page.evaluate(() => {
      const raw = localStorage.getItem("ai-creation-studio-free-canvas-run-history-v1");
      return raw ? JSON.parse(raw) : [];
    }) as DemoHistory[];
    assert.ok(history.length > 0, "生成分镜后必须写入运行历史");
    const record = history[0];
    assert.equal(record.status, "draft", "生成分镜后应保存为可编辑草稿");
    assert.equal(record.sourceScript, CAT_HEALTH_SCRIPT, "历史记录必须完整保存原文");

    const narrationNodes = record.nodes.filter((node) => node.data.kind === "text" && /完整口播/.test(node.data.title));
    const directorNodes = record.nodes.filter((node) => node.data.kind === "text" && /视觉镜头\d+提示词/.test(node.data.title));
    const consistencyNode = record.nodes.find((node) => node.data.kind === "text" && /角色 \/ 场景统一设定/.test(node.data.title));
    const imageNodes = record.nodes.filter((node) => node.data.kind === "image" && /关键帧/.test(node.data.title));
    const videoNodes = record.nodes.filter((node) => node.data.kind === "video" && /视频/.test(node.data.title));

    assert.ok(narrationNodes.length >= 5, `完整口播语义段数量异常：${narrationNodes.length}`);
    assert.ok(videoNodes.length >= 10, `视觉镜头数量过少：${videoNodes.length}`);
    assert.equal(imageNodes.length, videoNodes.length, "每个视频镜头必须对应一张参考图");
    assert.equal(directorNodes.length, videoNodes.length, "每个视频镜头必须对应一份导演提示词");
    assert.ok(imageNodes.every((node) => countReadableCharacters(node.data.prompt) >= 50), "每张参考图提示词必须不少于50个有效字");
    assert.ok(imageNodes.every((node) => /橘白猫|橘猫/.test(node.data.prompt)), "参考图提示词必须锁定橘猫角色");
    assert.match(consistencyNode?.data.prompt || "", /橘白猫|橘猫/, "全片统一设定必须明确锁定橘猫毛色");
    assert.doesNotMatch(consistencyNode?.data.prompt || "", /毛色.{0,8}(?:未提及|不作额外设定)|无任何花纹描述/, "全片统一设定不能用未指定描述覆盖明确毛色");
    assert.ok(videoNodes.every((node) => {
      const duration = extractPromptDurationSeconds(node.data.prompt);
      const ranges = extractVideoPromptTimeRanges(node.data.prompt);
      return duration === node.data.durationSeconds
        && ranges.length >= 3
        && ranges[0].start === 0
        && ranges.at(-1)?.end === duration;
    }), "视频提示词的目标时长和时间轴必须与任务卡一致");
    assert.ok(videoNodes.every((node) => node.data.prompt.includes("不生成字幕") && node.data.prompt.includes("不做说话口型")), "视频提示词必须关闭字幕和说话口型");
    assert.ok(videoNodes.every((node) => !/[。；，][，；]/u.test(node.data.prompt)), "视频提示词不应出现重复或冲突的拼接标点");

    await fs.mkdir(".tmp-e2e", { recursive: true });
    const report = {
      generatedAt: new Date().toISOString(),
      historyId: record.id,
      historyStatus: record.status,
      narrationSegments: narrationNodes.length,
      directorPrompts: directorNodes.length,
      imagePrompts: imageNodes.length,
      videoPrompts: videoNodes.length,
      durations: videoNodes.map((node) => node.data.durationSeconds),
      sample: {
        narration: narrationNodes[0]?.data.prompt,
        imagePrompt: imageNodes[0]?.data.prompt,
        videoPrompt: videoNodes[0]?.data.prompt,
      },
    };
    await page.getByTitle("打开专业画布面板（不改变画布缩放）").click();
    await page.getByRole("button", { name: "按镜头横向整理" }).click();
    let generatedImageUrl = "";
    let generatedVideoUrl = "";
    let actualVideoDuration = 0;
    let refreshRestored = false;
    if (process.env.CANVAS_RUN_FIRST_SHOT === "1") {
      const imageNode = imageNodes[0];
      const videoNode = videoNodes[0];
      assert.ok(imageNode && videoNode, "缺少第1镜图片或视频节点");
      const imageShell = page.locator(`.react-flow__node[data-id="${imageNode.id}"]`);
      await imageShell.dispatchEvent("click");
      await imageShell.locator(".free-parameter-row").getByRole("button", { name: "生成" }).dispatchEvent("click");
      generatedImageUrl = await waitForNodeResult(page, imageNode.id, 5 * 60_000);
      const videoShell = page.locator(`.react-flow__node[data-id="${videoNode.id}"]`);
      await videoShell.dispatchEvent("click");
      await videoShell.locator(".free-parameter-row").getByRole("button", { name: "生成" }).dispatchEvent("click");
      generatedVideoUrl = await waitForNodeResult(page, videoNode.id, 10 * 60_000);
      actualVideoDuration = await page.evaluate((source) => new Promise<number>((resolve, reject) => {
        const video = document.createElement("video");
        const timer = window.setTimeout(() => reject(new Error("读取视频时长超时")), 60_000);
        video.preload = "metadata";
        video.onloadedmetadata = () => {
          window.clearTimeout(timer);
          resolve(video.duration);
        };
        video.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error("生成视频无法加载"));
        };
        video.src = source.startsWith("http") ? source : new URL(source, window.location.origin).toString();
      }), generatedVideoUrl);
      assert.ok(Math.abs(actualVideoDuration - videoNode.data.durationSeconds) <= 0.15,
        `首镜目标 ${videoNode.data.durationSeconds} 秒，实际 ${actualVideoDuration.toFixed(2)} 秒`);

      await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
      await page.locator(`.react-flow__node[data-id="${videoNode.id}"]`).waitFor({ timeout: 30_000 });
      const restored = await page.evaluate(({ imageId, videoId, historyId }) => {
        const sessions = JSON.parse(localStorage.getItem("ai-creation-studio-free-canvas-sessions-v1") || "[]");
        const histories = JSON.parse(localStorage.getItem("ai-creation-studio-free-canvas-run-history-v1") || "[]");
        const sessionNodes = sessions.flatMap((session: { nodes?: DemoNode[] }) => session.nodes || []);
        const history = histories.find((item: DemoHistory) => item.id === historyId) as DemoHistory | undefined;
        return {
          imageUrl: sessionNodes.find((item: DemoNode) => item.id === imageId)?.data.outputUrl || "",
          videoUrl: sessionNodes.find((item: DemoNode) => item.id === videoId)?.data.outputUrl || "",
          historyImageUrl: history?.nodes.find((item) => item.id === imageId)?.data.outputUrl || "",
          historyVideoUrl: history?.nodes.find((item) => item.id === videoId)?.data.outputUrl || "",
          imageEvent: history?.events?.find((item) => item.nodeId === imageId)?.status || "",
          videoEvent: history?.events?.find((item) => item.nodeId === videoId)?.status || "",
        };
      }, { imageId: imageNode.id, videoId: videoNode.id, historyId: record.id });
      assert.ok(restored.imageUrl && restored.videoUrl, "刷新后画布必须恢复首镜图片和视频");
      assert.ok(restored.historyImageUrl && restored.historyVideoUrl, "运行历史必须保存首镜图片和视频");
      assert.equal(restored.imageEvent, "succeeded", "运行历史中的图片节点状态异常");
      assert.equal(restored.videoEvent, "succeeded", "运行历史中的视频节点状态异常");
      refreshRestored = true;
    }
    const finalReport = {
      ...report,
      generatedImageUrl,
      generatedVideoUrl: withoutAuthToken(generatedVideoUrl),
      actualVideoDuration,
      refreshRestored,
    };
    await fs.writeFile(".tmp-e2e/cat-canvas-demo-report.json", JSON.stringify(finalReport, null, 2), "utf8");
    await page.screenshot({ path: ".tmp-e2e/cat-canvas-demo.png", fullPage: true });
    console.log(JSON.stringify(finalReport, null, 2));
  } finally {
    await browser.close();
  }
}

void main();
