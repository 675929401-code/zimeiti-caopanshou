import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { chromium, request as playwrightRequest, type APIRequestContext, type BrowserContext, type Page } from "playwright";
import { DOG_SLEEP_WOMAN_INSTRUCTION, DOG_SLEEP_WOMAN_SCRIPT } from "../src/lib/canvas-demo-scripts";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDirectory = ".tmp-e2e/semantic-motion-acceptance";
const storageStatePath = `${outputDirectory}/storage-state.json`;
const liveGenerationEnabled = process.env.CANVAS_LIVE_GENERATION === "1" || process.argv.includes("--live");
const resumeRequested = process.env.CANVAS_RESUME === "1" || process.argv.includes("--resume");
const videoStageEnabled = process.argv.includes("--with-videos");
const selectedShots = [2, 3, 4];

type GeneratedAsset = {
  title: string;
  kind: "image" | "video";
  startedAt: string;
  durationMs: number;
  submitDurationMs?: number;
  statusPolls?: number;
  outputUrl: string;
  savedPath?: string;
  modelId?: string;
  referenceImageCount?: number;
  reused?: boolean;
};

type RequestRecord = {
  path: string;
  method: string;
  startedAt: string;
  modelId?: string;
  taskLabel?: string;
  referenceImageCount?: number;
  status?: number;
  durationMs?: number;
};

function nodeCard(page: Page, title: string | RegExp) {
  return page
    .locator(".react-flow__node .workflow-kind > strong")
    .filter({ hasText: title })
    .first()
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' react-flow__node ')][1]");
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

async function selectNode(page: Page, card: ReturnType<typeof nodeCard>) {
  await card.waitFor({ state: "attached", timeout: 30_000 });
  await card.evaluate((element: HTMLElement) => element.click());
  await card.locator(".free-node-compose").waitFor({ state: "visible", timeout: 10_000 });
}

async function screenshotNode(page: Page, title: string, filename: string) {
  await openProPanel(page);
  const card = nodeCard(page, title);
  await selectNode(page, card);
  await page.getByRole("button", { name: "定位节点" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "关闭制作面板" }).click();
  await card.screenshot({ path: `${outputDirectory}/${filename}` });
}

async function runImageNode(page: Page, title: string, requests: RequestRecord[]) {
  const card = nodeCard(page, title);
  const existing = await page.evaluate((expectedTitle) => {
    const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as {
      nodes?: Array<{ data?: { title?: string; outputUrl?: string; modelId?: string; imageMode?: string } }>;
    } | null;
    return graph?.nodes?.find((node) => node.data?.title?.startsWith(expectedTitle))?.data || null;
  }, title);
  if (existing?.outputUrl) {
    return {
      title,
      kind: "image" as const,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      outputUrl: existing.outputUrl,
      modelId: existing.modelId,
      referenceImageCount: existing.imageMode === "image-to-image" ? 1 : 0,
      reused: true,
    };
  }
  await selectNode(page, card);
  const button = card.locator(".free-parameter-row button").last();
  await button.waitFor({ state: "attached", timeout: 10_000 });
  const blockedReason = await button.getAttribute("title");
  assert.equal(await button.isDisabled(), false, `${title}的生图按钮不可用：${blockedReason || "未给出原因"}`);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const requestCountBefore = requests.length;
  const generationResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/bridge/image/generate"
    && response.request().method() === "POST"
  ), { timeout: 300_000 });
  await button.evaluate((element: HTMLButtonElement) => element.click());
  const generationResponse = await generationResponsePromise;
  if (!generationResponse.ok()) {
    const payload = await generationResponse.json().catch(() => ({})) as { error?: string };
    throw new Error(`${title}生图失败：${payload.error || `HTTP ${generationResponse.status()}`}`);
  }
  await card.locator("img").first().waitFor({ state: "visible", timeout: 240_000 });
  const outputUrl = await card.locator("img").first().getAttribute("src");
  assert.ok(outputUrl, `${title}没有返回图片地址`);
  const generationRequest = requests.slice(requestCountBefore).find((item) => item.path === "/api/bridge/image/generate");
  return {
    title,
    kind: "image" as const,
    startedAt,
    durationMs: Date.now() - startedMs,
    outputUrl,
    modelId: generationRequest?.modelId,
    referenceImageCount: generationRequest?.referenceImageCount,
  };
}

async function runVideoNode(page: Page, title: string, requests: RequestRecord[]) {
  const card = nodeCard(page, title);
  const existing = await page.evaluate((expectedTitle) => {
    const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as {
      nodes?: Array<{ data?: { title?: string; outputUrl?: string; modelId?: string } }>;
    } | null;
    return graph?.nodes?.find((node) => node.data?.title?.startsWith(expectedTitle))?.data || null;
  }, title);
  if (existing?.outputUrl) {
    return {
      title,
      kind: "video" as const,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      statusPolls: 0,
      outputUrl: existing.outputUrl,
      modelId: existing.modelId,
      reused: true,
    };
  }
  await selectNode(page, card);
  const button = card.locator(".free-parameter-row.video button").last();
  await button.waitFor({ state: "attached", timeout: 10_000 });
  const blockedReason = await button.getAttribute("title");
  assert.equal(await button.isDisabled(), false, `${title}的视频按钮不可用：${blockedReason || "未给出原因"}`);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const requestCountBefore = requests.length;
  const generationResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/bridge/video/generate"
    && response.request().method() === "POST"
  ), { timeout: 300_000 });
  await button.evaluate((element: HTMLButtonElement) => element.click());
  const generationResponse = await generationResponsePromise;
  if (!generationResponse.ok()) {
    const payload = await generationResponse.json().catch(() => ({})) as { error?: string };
    throw new Error(`${title}视频提交失败：${payload.error || `HTTP ${generationResponse.status()}`}`);
  }
  await card.locator("video").first().waitFor({ state: "visible", timeout: 720_000 });
  const outputUrl = await card.locator("video").first().getAttribute("src");
  assert.ok(outputUrl, `${title}没有返回视频地址`);
  const nodeRequests = requests.slice(requestCountBefore);
  const submitRequest = nodeRequests.find((item) => item.path === "/api/bridge/video/generate");
  return {
    title,
    kind: "video" as const,
    startedAt,
    durationMs: Date.now() - startedMs,
    submitDurationMs: submitRequest?.durationMs,
    statusPolls: nodeRequests.filter((item) => item.path === "/api/bridge/video/status").length,
    outputUrl,
    modelId: submitRequest?.modelId,
  };
}

async function persistAsset(request: APIRequestContext, asset: GeneratedAsset, index: number) {
  try {
    const response = await request.get(asset.outputUrl, { timeout: 120_000 });
    if (!response.ok()) return undefined;
    const contentType = response.headers()["content-type"] || "";
    const extension = asset.kind === "video"
      ? contentType.includes("webm") ? "webm" : "mp4"
      : contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
    const filename = `${String(index + 1).padStart(2, "0")}-${asset.kind}-${asset.title.match(/镜头(\d+)/u)?.[1] || "anchor"}.${extension}`;
    const path = `${outputDirectory}/${filename}`;
    await writeFile(path, await response.body());
    return path;
  } catch {
    return undefined;
  }
}

async function checkpointCanvasStorage(context: BrowserContext, page: Page, title: string) {
  await page.waitForFunction((expectedTitle) => {
    const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as {
      nodes?: Array<{ data?: { title?: string; outputUrl?: string } }>;
    } | null;
    return Boolean(graph?.nodes?.find((node) => node.data?.title?.startsWith(expectedTitle))?.data?.outputUrl);
  }, title, { timeout: 30_000 });
  await context.storageState({ path: storageStatePath });
}

async function main() {
  assert.ok(liveGenerationEnabled, "此脚本会产生真实费用；确认后使用 CANVAS_LIVE_GENERATION=1 运行");
  await mkdir(outputDirectory, { recursive: true });
  let resumePreparedCanvas = false;
  if (resumeRequested) {
    try {
      await access(storageStatePath);
      resumePreparedCanvas = true;
    } catch {
      resumePreparedCanvas = false;
    }
  }
  const browser = await chromium.launch({ headless: process.env.CANVAS_HEADFUL !== "1" });
  const report: {
    startedAt: string;
    completedAt?: string;
    source: string;
    selectedShots: number[];
    balanceBefore?: number;
    balanceAfter?: number;
    imageModel?: string;
    referenceImageModel?: string;
    videoModel?: string;
    compiler?: string;
    compileDurationMs?: number;
    compilerDiagnostics?: Array<{ model: string; status: string; durationMs: number; detail?: string }>;
    imagePrompts: Record<string, string>;
    videoPrompts: Record<string, string>;
    assets: GeneratedAsset[];
    requests: RequestRecord[];
    pageErrors: string[];
    consoleErrors: string[];
    error?: string;
  } = {
    startedAt: new Date().toISOString(),
    source: "free-canvas native UI",
    selectedShots,
    imagePrompts: {},
    videoPrompts: {},
    assets: [],
    requests: [],
    pageErrors: [],
    consoleErrors: [],
  };

  try {
    const authRequest = await playwrightRequest.newContext();
    const sessionResponse = await authRequest.get(`${baseUrl}/api/auth/dev-session`, {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
    });
    const session = await sessionResponse.json() as { token?: string; error?: string };
    await authRequest.dispose();
    assert.ok(sessionResponse.ok() && session.token, session.error || "本地测试会话不可用");

    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1,
      ...(resumePreparedCanvas ? { storageState: storageStatePath } : {}),
    });
    await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
    const balanceBeforeResponse = await context.request.get(`${baseUrl}/api/bridge/balance`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    report.balanceBefore = Number((await balanceBeforeResponse.json() as { balance?: number }).balance || 0);
    const minimumBalance = videoStageEnabled ? 0.9 : 0.6;
    assert.ok(report.balanceBefore >= minimumBalance, `余额不足，本阶段预计需要约¥${minimumBalance.toFixed(2)}，当前¥${report.balanceBefore.toFixed(2)}`);

    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/bridge/image/") && !path.startsWith("/api/bridge/video/")) return;
      let payload: Record<string, unknown> = {};
      try {
        const parsed = request.postDataJSON() as unknown;
        payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
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
      const path = new URL(response.url()).pathname;
      const pending = [...report.requests].reverse().find((item) => item.path === path && item.status === undefined);
      if (pending) {
        pending.status = response.status();
        pending.durationMs = Date.now() - Date.parse(pending.startedAt);
      }
    });

    const response = await page.goto(`${baseUrl}/free-canvas?revision=semantic-motion-acceptance-v1`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `自由画布返回 ${response?.status()}`);
    await openProPanel(page);
    if (!resumePreparedCanvas) {
      await page.getByRole("button", { name: /动漫剧情/ }).click();
      const importerToggle = page.locator("button.free-script-toggle");
      if ((await importerToggle.innerText()).includes("打开")) await importerToggle.click();
      const importer = page.locator(".free-script-importer");
      await importer.locator("textarea").first().fill(DOG_SLEEP_WOMAN_SCRIPT);
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

      await page.screenshot({ path: `${outputDirectory}/01-before-compile.png`, fullPage: true });
      const compileStartedMs = Date.now();
      const compileResponsePromise = page.waitForResponse((candidate) => (
        candidate.url().endsWith("/api/canvas/compile-script") && candidate.request().method() === "POST"
      ), { timeout: 360_000 });
      await importer.locator(":scope > button").last().click();
      const compileResponse = await compileResponsePromise;
      const compiled = await compileResponse.json() as {
        compiler?: string;
        compilerDiagnostics?: Array<{ model: string; status: string; durationMs: number; detail?: string }>;
        error?: string;
      };
      report.compiler = compiled.compiler;
      report.compilerDiagnostics = compiled.compilerDiagnostics;
      report.compileDurationMs = Date.now() - compileStartedMs;
      assert.ok(compileResponse.ok(), compiled.error || `镜头拆分返回 ${compileResponse.status()}`);
      assert.equal(compiled.compiler, "ai", "原生GPT拆镜没有成功，已在付费生图前停止");
    } else {
      report.compiler = "reused-ai";
      report.compileDurationMs = 0;
    }

    await nodeCard(page, "全片角色 / 风格设定（全文提取）").waitFor({ state: "attached", timeout: 60_000 });
    if (!resumePreparedCanvas) {
      await page.waitForFunction(() => {
        const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as {
          nodes?: Array<{ data?: { title?: string } }>;
        } | null;
        const history = JSON.parse(localStorage.getItem("ai-creation-studio-free-canvas-run-history-v1") || "[]") as Array<{
          compiler?: string;
          nodes?: Array<unknown>;
        }>;
        const latestRun = history[0];
        return latestRun?.compiler === "ai"
          && Boolean(latestRun.nodes?.length)
          && latestRun.nodes?.length === graph?.nodes?.length
          && graph?.nodes?.some((node) => node.data?.title?.startsWith("分镜14 · 关键帧生成视频"));
      }, undefined, { timeout: 60_000 });
      await context.storageState({ path: storageStatePath });
    }
    await openProPanel(page);
    await page.waitForFunction(() => {
      const selects = [...document.querySelectorAll<HTMLSelectElement>(".free-global-models select")];
      return selects.length >= 3 && selects.every((select) => select.options.length > 0);
    });
    const globalModelSelects = page.locator(".free-global-models select");
    const preferredVideoOption = await globalModelSelects.nth(2).locator("option").evaluateAll((options) => (
      options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent || "" }))
        .find((option) => option.value === "veo-3-1-fast-chC" || /Veo 3\.1 Fast[\s\S]*¥0\.30/i.test(option.text))
    ));
    assert.ok(preferredVideoOption, "没有找到¥0.30的Veo 3.1 Fast验收模型");
    await globalModelSelects.nth(2).selectOption(preferredVideoOption.value);
    await page.getByRole("button", { name: /应用到当前全部图片和视频节点/ }).click();
    await page.waitForTimeout(300);
    report.imageModel = await globalModelSelects.nth(0).locator("option:checked").innerText();
    const referenceImageModelId = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as {
        nodes?: Array<{ data?: { title?: string; modelId?: string } }>;
      } | null;
      return graph?.nodes?.find((node) => node.data?.title?.startsWith("分镜02 · 自动关键帧"))?.data?.modelId || "";
    });
    assert.ok(referenceImageModelId, "自动关键帧没有配置参考图模型");
    report.referenceImageModel = await globalModelSelects.nth(0).locator(`option[value="${referenceImageModelId}"]`).innerText();
    report.videoModel = await globalModelSelects.nth(2).locator("option:checked").innerText();
    assert.match(report.imageModel, /GPT-Image-2/i, "自动锚点没有使用GPT最高图片模型");
    for (const shot of selectedShots) {
      const promptCard = nodeCard(page, new RegExp(`分镜${String(shot).padStart(2, "0")} · 生图提示词`));
      const videoPromptCard = nodeCard(page, new RegExp(`分镜${String(shot).padStart(2, "0")} · 视频提示词`));
      report.imagePrompts[String(shot)] = (await promptCard.locator(".free-text-preview p").textContent()) || "";
      report.videoPrompts[String(shot)] = (await videoPromptCard.locator(".free-text-preview p").textContent()) || "";
      assert.match(report.imagePrompts[String(shot)], /必画语义证据（优先执行）：/u, `分镜${shot}缺少语义证据层`);
      assert.match(report.videoPrompts[String(shot)], /音频硬约束：/u, `分镜${shot}缺少环境或动作声音设计`);
    }

    for (const shot of selectedShots) {
      const title = `分镜${String(shot).padStart(2, "0")} · 自动关键帧图片`;
      const asset = await runImageNode(page, title, report.requests);
      report.assets.push(asset);
      await checkpointCanvasStorage(context, page, asset.title);
      await writeFile(`${outputDirectory}/report.json`, JSON.stringify(report, null, 2), "utf8");
      console.log(`[live-sample] shot ${shot} image completed in ${asset.durationMs}ms`);
      assert.equal(asset.modelId, referenceImageModelId, `镜头${shot}没有使用画布配置的参考图模型`);
      assert.equal(asset.referenceImageCount || 0, 0, `分镜${shot}的自动文本生图不应强制依赖额外上传图`);
    }
    await page.screenshot({ path: `${outputDirectory}/02-images-complete.png`, fullPage: true });
    for (const shot of selectedShots) {
      const padded = String(shot).padStart(2, "0");
      await screenshotNode(page, `分镜${padded} · 自动关键帧图片`, `image-shot-${padded}.png`);
    }

    if (videoStageEnabled) {
      for (const shot of selectedShots) {
        const title = `分镜${String(shot).padStart(2, "0")} · 关键帧生成视频`;
        const asset = await runVideoNode(page, title, report.requests);
        report.assets.push(asset);
        await checkpointCanvasStorage(context, page, asset.title);
        await writeFile(`${outputDirectory}/report.json`, JSON.stringify(report, null, 2), "utf8");
        console.log(`[live-sample] shot ${shot} video completed in ${asset.durationMs}ms after ${asset.statusPolls || 0} polls`);
      }
      await page.screenshot({ path: `${outputDirectory}/03-videos-complete.png`, fullPage: true });
    }

    for (let index = 0; index < report.assets.length; index += 1) {
      report.assets[index].savedPath = await persistAsset(context.request, report.assets[index], index);
    }
    const balanceAfterResponse = await context.request.get(`${baseUrl}/api/bridge/balance`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    report.balanceAfter = Number((await balanceAfterResponse.json() as { balance?: number }).balance || 0);
    report.completedAt = new Date().toISOString();
    await context.close();
  } catch (error) {
    report.error = error instanceof Error ? error.stack || error.message : String(error);
    report.completedAt = new Date().toISOString();
    throw error;
  } finally {
    await writeFile(`${outputDirectory}/report.json`, JSON.stringify(report, null, 2), "utf8");
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
