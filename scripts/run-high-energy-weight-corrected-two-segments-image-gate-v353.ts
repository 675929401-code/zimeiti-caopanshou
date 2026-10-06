import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

config({ path: ".env.local", quiet: true });

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const agentName = "故事版导演｜高能夸张";
const expectedSchema = "storyboard_director_output_style.v3.5.3";
const expectedPromptSha = "8d71d01d0d3e5f9de8562fe09ec6cfba87a80017b12d37d110de8db2d95c925d";
const replayConversationId = process.env.REPLAY_CONVERSATION_ID?.trim() || "";
const imagePublicId = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
const imageDbId = "gpt-image-2-chA-1";
const reviewId = "high-energy-weight-corrected-segments-1-2-v353-fullchain-pro2k-omni10-20260816";
const runId = `${reviewId}-run`;
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);

const narrations = [
  "狗是胖点好还是瘦点好？答案永远都是瘦点好。人类不有一句话吗？“千金难买老来瘦”。狗也一样。现在出去遛狗，主人最怕听到的一句话就是：",
  "最怕听到的一句话就是：“你家狗怎么这么瘦？”就好像是你舍不得给它吃似的，虐待它一样。现在审美都不知道怎么回事，都喜欢胖的。猫狗胖的可爱，养的太胖那不叫养的好。",
] as const;

type PresetField = { id: string; label?: string; sendLabel?: boolean; sendText?: string; order?: number };
type AgentRecord = {
  id: string;
  name: string;
  model: string;
  system_prompt?: string;
  output_style?: Record<string, unknown>;
  preset_fields?: PresetField[];
};
type Segment = {
  number: number;
  narration: string;
  panelCount: number;
  imagePrompt: string;
  videoPrompt: string;
  shotCount: number;
  shotFrameReferences: number[];
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response: Response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return { error: `non-JSON response (${response.status}): ${raw.slice(0, 500)}` };
  }
}

async function requestJson(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(init.headers || {}),
    },
  });
  return { response, data: await readJson(response) };
}

function buildMessage(fields: PresetField[]) {
  const numbered = narrations.map((value, index) => `${index + 1}.【${value}】`).join("\n");
  const values: Record<string, string> = {
    segmented_script: numbered,
    animation_style: "默认皮克斯式高端商业3D动画",
    aspect_ratio: "16:9",
    target_duration_seconds: "10",
    special_notes: "",
  };
  const result = [...fields]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .flatMap((field) => {
      const value = values[field.id]?.trim();
      if (!value) return [];
      return field.sendLabel === false ? [value] : [`${field.sendText || field.label || field.id}：${value}`];
    })
    .join("\n");
  narrations.forEach((value, index) => assert.ok(result.includes(`${index + 1}.【${value}】`)));
  return result;
}

async function readStream(response: Response) {
  assert.ok(response.body, "模型流没有响应体");
  const reader = response.body.getReader();
  const decoder = new SseEventStreamDecoder();
  let content = "";
  let doneEvent = false;
  const consume = (events: ReturnType<SseEventStreamDecoder["push"]>) => {
    for (const event of events) {
      const raw = event.data.trim();
      if (!raw) continue;
      if (event.event === "done" || raw === "[DONE]") {
        doneEvent = true;
        continue;
      }
      const data = JSON.parse(raw) as {
        error?: string | { message?: string };
        content?: string;
        delta?: { content?: string };
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      if (data.error) throw new Error(typeof data.error === "string" ? data.error : data.error.message || "模型流错误");
      content += data.choices?.[0]?.delta?.content
        || data.choices?.[0]?.message?.content
        || data.delta?.content
        || data.content
        || "";
    }
  };
  while (!doneEvent) {
    const { done, value } = await reader.read();
    if (value) consume(decoder.push(value));
    if (done) break;
  }
  consume(decoder.finish());
  assert.ok(doneEvent, "模型流在[DONE]前结束");
  return content;
}

function parse(raw: string): Segment[] {
  const heading = /^\*\*原文案内容段落\s*(\d+)\*\*：([^\r\n]+)\r?$/gmu;
  const headings = [...raw.matchAll(heading)];
  assert.equal(headings.length, 2, `原文标题应为2个，实际${headings.length}个`);
  assert.equal([...raw.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)].length, 4, "平台输出不是4个text代码框");
  return headings.map((match, index) => {
    const number = Number(match[1]);
    const narration = match[2].trim().replace(/^【|】$/gu, "");
    const start = (match.index || 0) + match[0].length;
    const end = headings[index + 1]?.index ?? raw.length;
    const section = raw.slice(start, end);
    const blocks = [...section.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)].map((item) => item[1].trim());
    const panelMatch = section.match(/故事板分镜图文生图 Prompt（共([45])格）/u);
    assert.equal(number, index + 1, `段落编号错位：${number}`);
    assert.equal(narration, narrations[index], `第${number}段原文被改写`);
    assert.ok(panelMatch, `第${number}段缺少4/5格标题`);
    assert.equal(blocks.length, 2, `第${number}段不是两个代码框`);
    const [imagePrompt, videoPrompt] = blocks;
    const frames = [...new Set([...imagePrompt.matchAll(/Frame\s*([1-5])\s*:/giu)].map((item) => Number(item[1])))];
    const shots = [...new Set([...videoPrompt.matchAll(/镜头\s*([1-5])/gu)].map((item) => Number(item[1])))];
    const shotFrameReferences = [...videoPrompt.matchAll(/唯一参考\s*Frame\s*([1-5])/giu)].map((item) => Number(item[1]));
    assert.equal(frames.length, Number(panelMatch[1]), `第${number}段Frame数量不匹配`);
    assert.ok(shots.length >= 3 && shots.length <= 4, `第${number}段不是3至4镜`);
    assert.equal(shotFrameReferences.length, shots.length, `第${number}段未逐镜唯一绑定Frame`);
    assert.equal([...videoPrompt.matchAll(/对应口播/gu)].length, shots.length, `第${number}段未逐镜绑定口播锚点`);
    assert.match(videoPrompt, /镜头1[^\n]*唯一参考\s*Frame\s*1/iu, `第${number}段首镜未从Frame 1按原文起播`);
    assert.doesNotMatch(videoPrompt, /参考格[^\n。；]{0,20}合并|综合多格/u, `第${number}段仍在合并参考格`);
    assert.match(videoPrompt, /不融合|不变形/u, `第${number}段缺少防融合约束`);
    assert.match(imagePrompt, /黄色[^\n。；]{0,24}卫衣/u, `第${number}段默认人物服装未锁定`);
    assert.match(imagePrompt, /蓝色牛仔裤/u, `第${number}段蓝色牛仔裤未锁定`);
    assert.match(imagePrompt, /白色运动鞋/u, `第${number}段白色运动鞋未锁定`);
    assert.match(imagePrompt, /柯基/u, `第${number}段默认犬种未锁定`);
    return {
      number,
      narration,
      panelCount: Number(panelMatch[1]),
      imagePrompt,
      videoPrompt,
      shotCount: shots.length,
      shotFrameReferences,
    };
  });
}

async function waitForHistory(token: string, conversationId: string, userContent: string, assistantContent: string) {
  const deadline = Date.now() + 90_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      latest = await response.json();
      const messages = (latest as { conversation?: { messages?: Array<{ role?: string; content?: string }> } }).conversation?.messages || [];
      if (messages.some((item) => item.role === "user" && item.content === userContent)
        && messages.some((item) => item.role === "assistant" && item.content === assistantContent)) return latest;
    }
    await sleep(1_500);
  }
  throw new Error(`平台历史未逐字落库：${JSON.stringify(latest)}`);
}

function validateSemanticDirection(segments: Segment[]) {
  const first = `${segments[0].imagePrompt}\n${segments[0].videoPrompt}`;
  const second = `${segments[1].imagePrompt}\n${segments[1].videoPrompt}`;
  const result = {
    firstHasLeanAnswer: /瘦点好|偏瘦|瘦而健康|千金难买老来瘦/u.test(first),
    firstHasWalkSetup: /遛狗|公园|步道|牵引绳/u.test(first) && /最怕听到|一句话|侧目|评论/u.test(first),
    secondHasSocialJudgment: /太瘦|舍不得|虐待|误解/u.test(second),
    secondHasFatAesthetic: /审美|胖得可爱|可爱/u.test(second),
    secondHasOverweightNotHealthy: /太胖|不叫养的好|过度喂养|健康/u.test(second),
    perShotSingleFrame: segments.every((segment) => segment.shotFrameReferences.length === segment.shotCount),
  };
  return { passed: Object.values(result).every(Boolean), checks: result };
}

function pngDimensions(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "生成图片不是PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(reviewPath), { recursive: true });

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const session = await readJson(sessionResponse);
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");
  const token = String(session.token);

  const admin = await requestJson(`${baseUrl}/api/admin/agents`, token);
  assert.ok(admin.response.ok, admin.data.error || "线上智能体读取失败");
  const online = admin.data.agents?.find((item: AgentRecord) => item.id === agentId);
  assert.ok(online?.system_prompt && online.name === agentName, "线上高能版不存在");
  assert.equal(sha256(online.system_prompt), expectedPromptSha, "线上高能Prompt SHA不符，停止付费提交");
  assert.equal(online.output_style?.schema_version, expectedSchema, "线上高能schema不符，停止付费提交");
  assert.equal(online.output_style?.free_canvas_coupling, false, "高能版意外耦合自由画布");

  const bots = await requestJson(`${baseUrl}/api/bots?weight_test=${Date.now()}`, token);
  assert.ok(bots.response.ok, bots.data.error || "主站智能体列表读取失败");
  const agent = bots.data.bots?.find((item: AgentRecord) => item.id === agentId && item.name === agentName) as AgentRecord | undefined;
  assert.ok(agent, "主站未找到高能版智能体");
  const submittedMessage = buildMessage(agent.preset_fields || []);
  const conversationId = replayConversationId
    || `conv_high_energy_weight_two_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  let raw = "";
  let history: unknown;
  if (replayConversationId) {
    const historyResponse = await requestJson(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, token);
    assert.ok(historyResponse.response.ok, historyResponse.data.error || "平台历史恢复失败");
    history = historyResponse.data;
    const messages = historyResponse.data.conversation?.messages || [];
    assert.ok(messages.some((item: { role?: string; content?: string }) => item.role === "user" && item.content === submittedMessage), "恢复历史中的用户输入不一致");
    raw = [...messages].reverse().find((item: { role?: string; content?: string }) => item.role === "assistant")?.content || "";
    assert.ok(raw, "恢复历史中缺少assistant输出");
  } else {
    const llmResponse = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: submittedMessage }],
        model: agent.model,
        stream: true,
        userId: session.user.id,
        agentName,
        agentId,
        conversationId,
        maxContextRounds: 0,
        maxReplyTokens: 32_768,
        timeout: 720,
        enableWebSearch: false,
        responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(720_000),
    });
    assert.ok(llmResponse.ok, `平台智能体调用失败（${llmResponse.status}）`);
    raw = llmResponse.headers.get("content-type")?.includes("text/event-stream")
      ? await readStream(llmResponse)
      : String((await readJson(llmResponse)).choices?.[0]?.message?.content || "");
  }
  const segments = parse(raw);
  const semanticGate = validateSemanticDirection(segments);
  assert.ok(semanticGate.passed, `Prompt语义门禁未通过：${JSON.stringify(semanticGate.checks)}`);
  history ||= await waitForHistory(token, conversationId, submittedMessage, raw);

  await writeFile(path.join(outDir, "platform-agent-raw-4-code-blocks.md"), raw, "utf8");
  await writeFile(path.join(outDir, "original-4-code-blocks.json"), `${JSON.stringify({
    conversationId,
    agentId,
    agentName,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    submittedMessage,
    narrations,
    segments,
    semanticGate,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "platform-history.json"), `${JSON.stringify(history, null, 2)}\n`, "utf8");

  const models = await requestJson(`${baseUrl}/api/cover-models`, token);
  assert.ok(models.response.ok && models.data.models?.some((item: { id?: string }) => item.id === imagePublicId), "GPT-Image-2 pro公网路由不存在");
  const dbUrl = process.env.COZE_SUPABASE_URL;
  const dbKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
  assert.ok(dbUrl && dbKey, "数据库配置缺失");
  const db = createClient(dbUrl, dbKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const imageModelResult = await db.from("cover_models")
    .select("id,name,model_name,selling_price")
    .eq("id", imageDbId)
    .single();
  if (imageModelResult.error) throw imageModelResult.error;
  const imageModel = imageModelResult.data;
  assert.equal(imageModel.model_name, "gpt-image-2");
  assert.equal(Number(imageModel.selling_price), 0.2);

  const cards: Array<Record<string, any>> = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (index > 0) await sleep(5_200);
    const segment = segments[index];
    const card: Record<string, any> = {
      order: index + 1,
      sourceSegmentNumber: segment.number,
      narration: segment.narration,
      originalImagePrompt: segment.imagePrompt,
      originalImagePromptSha256: sha256(segment.imagePrompt),
      originalVideoPrompt: segment.videoPrompt,
      originalVideoPromptSha256: sha256(segment.videoPrompt),
      image: { status: "submitting", apiAttempts: 1, submittedAt: new Date().toISOString() },
      video: { status: "locked-pending-image-approval", apiAttempts: 0 },
    };
    cards.push(card);
    await writeFile(path.join(outDir, "image-gate-state.json"), `${JSON.stringify({ cards }, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: "image-submit", card: card.order, segment: segment.number, model: imagePublicId, resolution: "2K" }));

    const request = await requestJson(`${baseUrl}/api/image/generate`, token, {
      method: "POST",
      body: JSON.stringify({
        prompt: segment.imagePrompt,
        mode: "local",
        modelId: imagePublicId,
        style: "",
        aspectRatio: "16:9",
        resolution: "2K",
        coverText: "",
        referenceImageUrls: [],
        referenceUsage: "general",
        clientTraceId: randomUUID(),
        clientNodeId: `${runId}-shot-${card.order}`,
        clientNodeTitle: `分镜工作台镜头${card.order}`,
      }),
      signal: AbortSignal.timeout(360_000),
    });
    card.image.httpStatus = request.response.status;
    card.image.response = request.data;
    const generatedUrl = request.data.images?.[0]?.url;
    if (!request.response.ok || !generatedUrl) {
      card.image.status = "failed";
      card.image.error = request.data.error || `生图失败（${request.response.status}）`;
      await writeFile(path.join(outDir, "image-gate-state.json"), `${JSON.stringify({ cards }, null, 2)}\n`, "utf8");
      continue;
    }

    const download = await fetch(generatedUrl, { signal: AbortSignal.timeout(120_000) });
    assert.ok(download.ok, `第${segment.number}段原图下载失败（${download.status}）`);
    const bytes = Buffer.from(await download.arrayBuffer());
    const dimensions = pngDimensions(bytes);
    assert.deepEqual(dimensions, { width: 2560, height: 1440 }, `第${segment.number}段不是2K 16:9`);
    const localPath = path.join(outDir, `segment-${segment.number}-gpt-image-2-pro-2k.png`);
    const publicPath = path.resolve("public", "storyboard-reviews", `${reviewId}-segment-${segment.number}.png`);
    await Promise.all([writeFile(localPath, bytes), writeFile(publicPath, bytes)]);
    const persist = await requestJson(`${baseUrl}/api/image-workbench/persist`, token, {
      method: "POST",
      body: JSON.stringify({ url: generatedUrl, index: card.order }),
      signal: AbortSignal.timeout(120_000),
    });
    assert.ok(persist.response.ok && /^https?:\/\//u.test(persist.data.url || ""), persist.data.error || `第${segment.number}段图片持久化失败`);
    card.image = {
      ...card.image,
      status: "done",
      completedAt: new Date().toISOString(),
      generatedUrl,
      persistedUrl: persist.data.url,
      localOriginalPath: localPath,
      publicReviewUrl: `/storyboard-reviews/${reviewId}-segment-${segment.number}.png`,
      bytes: bytes.length,
      dimensions,
      sha256: sha256(bytes),
    };
    await writeFile(path.join(outDir, "image-gate-state.json"), `${JSON.stringify({ cards }, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: "image-complete", card: card.order, segment: segment.number, dimensions, bytes: bytes.length }));
  }

  const successfulImages = cards.filter((card) => card.image.status === "done").length;
  const now = Date.now();
  const review = {
    reviewId,
    status: successfulImages === 2 ? "images-generated-awaiting-user-approval-video-locked" : "image-generation-complete-with-failures-video-locked",
    createdAt: new Date().toISOString(),
    source: "real-platform-agent-prompts-plus-real-gpt-image-2-pro-2k-images",
    conversationId,
    agentId,
    agentName,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    inputEvidence: { exactNarrations: narrations, characterCounts: narrations.map((value) => value.length) },
    promptEvidence: {
      codeBlockCount: 4,
      rawPath: path.join(outDir, "platform-agent-raw-4-code-blocks.md"),
      blocksPath: path.join(outDir, "original-4-code-blocks.json"),
      historyPath: path.join(outDir, "platform-history.json"),
      semanticGate,
    },
    modelRoute: {
      publicId: imagePublicId,
      dbId: imageDbId,
      name: imageModel.name,
      upstreamModel: imageModel.model_name,
      resolution: "2K",
      pixels: "2560x1440",
      priceCny: Number(imageModel.selling_price),
    },
    actualCost: {
      agentCalls: 1,
      recoveryAgentCalls: 0,
      imageSubmissions: cards.length,
      successfulImages,
      imageBusinessPriceCny: Number((successfulImages * Number(imageModel.selling_price)).toFixed(2)),
      videoSubmissions: 0,
      videoBusinessPriceCny: 0,
      paidRetries: 0,
    },
    localArtifacts: cards.map((card) => ({ segmentNumber: card.sourceSegmentNumber, image: card.image.localOriginalPath })),
    run: {
      id: runId,
      createdAt: now,
      updatedAt: now,
      ratio: "16:9",
      panelMode: "auto",
      imageResolution: "2K",
      videoResolution: "1080p",
      videoDuration: 10,
      imageModelId: imagePublicId,
      videoModelId: "omni-flash-10s-720p-ch3",
      title: "高能验证｜修正分段1-2｜Omni 10秒图片审核门",
      cards: cards.map((card) => ({
        id: `${runId}-card-${card.order}`,
        order: card.order,
        label: `第${card.sourceSegmentNumber}段｜${card.narration}`,
        narration: card.narration,
        imagePrompt: card.originalImagePrompt,
        videoPrompt: card.originalVideoPrompt,
        referenceImageUrls: [],
        imageStatus: card.image.status === "done" ? "done" : "failed",
        imageUrl: card.image.publicReviewUrl,
        imageError: card.image.error,
        imageValidatedAt: card.image.status === "done" ? now : undefined,
        imageModelIdUsed: card.image.status === "done" ? imagePublicId : undefined,
        imageModelNameUsed: card.image.status === "done" ? imageModel.name : undefined,
        videoStatus: "idle",
        videoError: "图片审核通过后才允许提交视频；当前视频提交次数为0",
        videoProgress: 0,
      })),
    },
  };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "image-gate-state.json"), `${JSON.stringify({ ...review, cards }, null, 2)}\n`, "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1100 } });
    await context.addInitScript((authToken) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.removeItem("storyboard_prompt_workbench_current_v2");
      localStorage.removeItem("storyboard_prompt_workbench_history_v2");
    }, token);
    const page = await context.newPage();
    const response = await page.goto(`${baseUrl}/storyboard-workbench?review=${reviewId}`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `review页面打开失败（${response?.status()}）`);
    await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(".sbw-shot-card").count(), 2);
    await page.screenshot({ path: path.join(outDir, "review-page.png"), fullPage: true });
    await context.close();
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({
    passed: successfulImages === 2,
    conversationId,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    semanticGate,
    costCny: Number((successfulImages * Number(imageModel.selling_price)).toFixed(2)),
    videoSubmissions: 0,
    images: cards.map((card) => ({
      segmentNumber: card.sourceSegmentNumber,
      path: card.image.localOriginalPath,
      dimensions: card.image.dimensions,
      sha256: card.image.sha256,
    })),
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
}

main().catch(async (error) => {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const failure = {
    passed: false,
    at: new Date().toISOString(),
    error: error instanceof Error ? error.stack || error.message : JSON.stringify(error),
    retryPolicy: "no automatic paid retry",
    videoSubmissions: 0,
  };
  await writeFile(path.join(outDir, "fatal-error.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
