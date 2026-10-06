import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, request as playwrightRequest, type Page } from "playwright";
import { BORDER_COLLIE_HOME_SCRIPT } from "../src/lib/canvas-demo-scripts";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDirectory = ".tmp-e2e/border-collie-banana-acceptance";
const storageStatePath = outputDirectory + "/storage-state.json";
const liveEnabled = process.env.CANVAS_LIVE_GENERATION === "1" || process.argv.includes("--live");
const bananaModelId = "gemini-3-1-flash-image-chA";

type GraphNode = {
  id: string;
  data: {
    kind: "text" | "image" | "video" | "upload";
    title: string;
    prompt: string;
    outputText: string;
    outputUrl: string;
    modelId: string;
    semanticOrder?: number;
    visualOrder?: number;
    durationSeconds: number;
    error?: string;
  };
};

type RequestRecord = {
  path: string;
  modelId?: string;
  status?: number;
  startedAt: string;
  durationMs?: number;
};

function nodeCard(page: Page, title: string) {
  return page
    .locator(".react-flow__node .workflow-kind > strong")
    .filter({ hasText: title })
    .first()
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' react-flow__node ')][1]");
}

async function selectNode(page: Page, title: string) {
  const card = nodeCard(page, title);
  await card.waitFor({ state: "attached", timeout: 30_000 });
  await card.evaluate((element: HTMLElement) => element.click());
  await card.locator(".free-node-compose").waitFor({ state: "visible", timeout: 10_000 });
  return card;
}

async function generateImage(page: Page, title: string) {
  const card = await selectNode(page, title);
  const button = card.locator(".free-parameter-row button").last();
  assert.equal(await button.isDisabled(), false, title + "不可生成：" + (await button.getAttribute("title") || "未知原因"));
  await button.click();
  const output = await page.waitForFunction((expectedTitle) => {
    const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as {
      nodes?: Array<{ data?: { title?: string; status?: string; outputUrl?: string } }>;
    } | null;
    const node = graph?.nodes?.find((item) => item.data?.title?.startsWith(expectedTitle));
    return node?.data?.status === "succeeded" && node.data.outputUrl
      ? { title: node.data.title || expectedTitle, outputUrl: node.data.outputUrl }
      : null;
  }, title, { timeout: 240_000 });
  const resolved = await output.jsonValue() as { title: string; outputUrl: string };
  const renderedImage = card.locator(`.workflow-node-preview img[alt="${resolved.title}"]`).first();
  await renderedImage.waitFor({ state: "visible", timeout: 30_000 });
  await renderedImage.evaluate((image: HTMLImageElement, expectedUrl) => new Promise<void>((resolve, reject) => {
    const isExpectedImage = () => {
      try {
        return new URL(image.currentSrc || image.src).pathname === new URL(expectedUrl).pathname;
      } catch {
        return false;
      }
    };
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0 && isExpectedImage()) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => reject(new Error("图片解码超时或页面仍在显示旧图")), 30_000);
    image.addEventListener("load", () => {
      if (!isExpectedImage() || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    image.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("图片链接返回后无法在浏览器中解码"));
    }, { once: true });
  }), resolved.outputUrl);
  const outputUrl = resolved.outputUrl;
  assert.ok(outputUrl, title + "没有图片结果");
  return { card, renderedImage, outputUrl };
}

function chooseRepresentativeShots(nodes: GraphNode[]) {
  const narrations = nodes
    .filter((node) => node.data.kind === "text" && /口播文案/u.test(node.data.title))
    .sort((a, b) => (a.data.semanticOrder || 0) - (b.data.semanticOrder || 0));
  const picks: GraphNode[] = [];
  const pick = (pattern: RegExp) => {
    const match = narrations.find((node) => pattern.test(node.data.outputText || node.data.prompt));
    if (match && !picks.some((item) => item.data.semanticOrder === match.data.semanticOrder)) picks.push(match);
  };
  pick(/有心机|不拆那种特别明显/u);
  pick(/翻过来|大洞|篓子/u);
  pick(/解释一下|不敢睁开眼|错觉/u);
  const fallbacks = [narrations[0], narrations[Math.floor(narrations.length / 2)], narrations.at(-1)];
  for (const fallback of fallbacks) {
    if (fallback && picks.length < 3 && !picks.some((item) => item.data.semanticOrder === fallback.data.semanticOrder)) picks.push(fallback);
  }
  assert.equal(picks.length, 3, "没有找到三个互不重复的代表镜头");
  return picks;
}

async function main() {
  assert.ok(liveEnabled, "此脚本会产生真实生图费用；确认后使用 --live 运行");
  await mkdir(outputDirectory, { recursive: true });
  const report: {
    startedAt: string;
    completedAt?: string;
    compiler?: string;
    imageModel?: string;
    shotCount?: number;
    selectedShots: Array<{ order: number; narration: string; imagePrompt: string; outputUrl?: string; durationMs?: number }>;
    requests: RequestRecord[];
    qualityNotes?: string;
    screenshots: string[];
    error?: string;
  } = {
    startedAt: new Date().toISOString(),
    selectedShots: [],
    requests: [],
    screenshots: [],
  };

  const authRequest = await playwrightRequest.newContext();
  const sessionResponse = await authRequest.get(baseUrl + "/api/auth/dev-session", {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await authRequest.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: process.env.CANVAS_HEADFUL !== "1" });
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1040 }, deviceScaleFactor: 1 });
    await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
    const page = await context.newPage();
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path !== "/api/bridge/image/generate" && path !== "/api/bridge/image/persist") return;
      let body: Record<string, unknown> = {};
      try { body = request.postDataJSON() as Record<string, unknown>; } catch {}
      report.requests.push({
        path,
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
        startedAt: new Date().toISOString(),
      });
    });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      const pending = [...report.requests].reverse().find((item) => item.path === path && item.status === undefined);
      if (!pending) return;
      pending.status = response.status();
      pending.durationMs = Date.now() - Date.parse(pending.startedAt);
    });

    const demoUrl = baseUrl + "/free-canvas?revision=border-collie-banana-acceptance&panel=production&demo=border-collie-banana-audit";
    const response = await page.goto(demoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.ok(response?.ok(), "自由画布返回 " + response?.status());
    await page.waitForFunction(() => {
      const history = JSON.parse(localStorage.getItem("ai-creation-studio-free-canvas-run-history-v1") || "[]") as Array<{
        canvasName?: string;
        compiler?: string;
        nodes?: Array<unknown>;
      }>;
      return history.some((record) => record.canvasName === "边牧拆家 · Banana验收" && record.compiler === "ai" && (record.nodes?.length || 0) > 20);
    }, undefined, { timeout: 360_000 });

    const state = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      const history = JSON.parse(localStorage.getItem("ai-creation-studio-free-canvas-run-history-v1") || "[]") as Array<{
        canvasName?: string;
        compiler?: string;
      }>;
      return {
        nodes: graph?.nodes || [],
        run: history.find((record) => record.canvasName === "边牧拆家 · Banana验收"),
      };
    });
    assert.equal(state.run?.compiler, "ai", "本轮没有使用 AI 语义拆镜");
    report.compiler = state.run?.compiler;
    const brief = state.nodes.find((node) => node.data.title === "完整文案 Brief");
    assert.equal(brief?.data.outputText, BORDER_COLLIE_HOME_SCRIPT, "原始文案被改写");
    const qualityNode = state.nodes.find((node) => node.data.title === "生成前质检 / 纠错记录");
    report.qualityNotes = qualityNode?.data.outputText || "";
    assert.match(report.qualityNotes, /新眼子多/u);
    assert.match(report.qualityNotes, /尸狗哪有不拆家的/u);

    const narrationNodes = state.nodes.filter((node) => node.data.kind === "text" && /口播文案/u.test(node.data.title));
    const imageNodes = state.nodes.filter((node) => node.data.kind === "image" && /自动关键帧图片/u.test(node.data.title));
    const videoNodes = state.nodes.filter((node) => node.data.kind === "video" && /关键帧生成视频/u.test(node.data.title));
    assert.equal(imageNodes.length, narrationNodes.length, "口播与参考图不是一一对应");
    assert.equal(videoNodes.length, narrationNodes.length, "口播与视频不是一一对应");
    assert.ok(narrationNodes.every((node) => node.data.durationSeconds >= 3 && node.data.durationSeconds <= 5), "存在超出3至5秒规则的分镜");
    assert.ok(imageNodes.every((node) => node.data.modelId === bananaModelId), "有关键帧没有使用 Banana 模型");
    report.imageModel = bananaModelId;
    report.shotCount = narrationNodes.length;

    const selectedNarrations = chooseRepresentativeShots(state.nodes);
    report.selectedShots = selectedNarrations.map((narration) => {
      const order = narration.data.semanticOrder || 0;
      const promptNode = state.nodes.find((node) => node.data.kind === "text" && node.data.visualOrder === order && /生图提示词/u.test(node.data.title));
      assert.ok(promptNode, "分镜" + order + "缺少独立生图提示词");
      assert.match(promptNode.data.outputText, /必画语义证据（优先执行）：/u, "分镜" + order + "缺少语义证据");
      assert.match(promptNode.data.outputText, /【剧情表演】/u, "分镜" + order + "缺少剧情表演");
      assert.match(promptNode.data.outputText, /【叙事道具】/u, "分镜" + order + "缺少叙事道具");
      assert.match(promptNode.data.outputText, /【图形特效】/u, "分镜" + order + "缺少特效决策");
      return { order, narration: narration.data.outputText, imagePrompt: promptNode.data.outputText };
    });

    const beforePath = outputDirectory + "/01-compiled-canvas.png";
    await page.screenshot({ path: beforePath, fullPage: true });
    report.screenshots.push(beforePath);

    const anchor = state.nodes.find((node) => node.data.kind === "image" && /全片角色 \/ 风格锚点/u.test(node.data.title));
    if (anchor) {
      assert.equal(anchor.data.modelId, bananaModelId, "角色锚点没有使用 Banana 模型");
      await generateImage(page, anchor.data.title);
      await context.storageState({ path: storageStatePath });
    }

    for (const selected of report.selectedShots) {
      const padded = String(selected.order).padStart(2, "0");
      const title = "分镜" + padded + " · 自动关键帧图片";
      const started = Date.now();
      const generated = await generateImage(page, title);
      selected.outputUrl = generated.outputUrl;
      selected.durationMs = Date.now() - started;
      const screenshot = outputDirectory + "/image-shot-" + padded + ".png";
      await generated.renderedImage.screenshot({ path: screenshot });
      report.screenshots.push(screenshot);
      await context.storageState({ path: storageStatePath });
      await writeFile(outputDirectory + "/report.json", JSON.stringify(report, null, 2), "utf8");
    }

    const imageRequests = report.requests.filter((item) => item.path === "/api/bridge/image/generate");
    assert.equal(imageRequests.length, anchor ? 4 : 3, "实际生图请求数量不符合测试范围");
    assert.ok(imageRequests.every((item) => item.modelId === bananaModelId), "实际请求中出现非 Banana 模型");
    assert.ok(imageRequests.every((item) => item.status === 200), "存在失败的 Banana 生图请求");
    report.completedAt = new Date().toISOString();
    await writeFile(outputDirectory + "/report.json", JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = error instanceof Error ? error.stack || error.message : String(error);
    report.completedAt = new Date().toISOString();
    await writeFile(outputDirectory + "/report.json", JSON.stringify(report, null, 2), "utf8");
    throw error;
  } finally {
    await browser.close();
  }
}

void main();
