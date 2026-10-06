import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const agentName = "故事版导演｜高能夸张";
const expectedSchema = "storyboard_director_output_style.v3.4.3.4.6.3";
const expectedPromptSha = "aaf24953274421c5335dc487e0f9a057d019975fba92e3e4dde63db65ff767c4";
const runId = `high-energy-snack-continuity-v343463-${Date.now()}`;
const reviewId = "high-energy-snack-continuity-prompt-v343463-20260816";
const outDir = path.resolve(".tmp-e2e", runId);
const rawPath = path.join(outDir, "agent-raw-14-code-blocks.md");
const promptPath = path.join(outDir, "original-14-code-blocks.json");
const historyPath = path.join(outDir, "platform-history.json");
const analysisPath = path.join(outDir, "quality-analysis.json");
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);

const narrations = [
  "其实这些看起来很小的动作会让狗狗难过很久。相信很多的主人都做过这样的事。",
  "急着出门时怕狗狗跟出来，就掏出一颗小零食往屋里扔进去，再趁他开心的跑过去吃的功夫，迅速关上房门离开。",
  "虽然这些举动在我们看来只是一个高效的脱身小技巧。但狗狗会把这理解成交易。",
  "它们的逻辑很简单：我吃零食，主人就走了。久而久之，狗狗开始害怕零食了。",
  "你会发现，下次你拿零食时，狗狗会犹豫，想要又不敢要。因为在它心里，吃零食就等于失去你。",
  "这时候狗狗就开始胡思乱想了。它会想：是不是我不够乖？主人才要把我支开？",
  "是不是我做错什么了？这种想法一旦开始，狗狗就变得特别敏感。",
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
  segmentNumber: number;
  narration: string;
  panelCount: 4 | 5;
  imagePrompt: string;
  videoPrompt: string;
  shotCount: number;
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${init.method || "GET"} ${url} failed (${response.status})`);
  return payload;
}

async function createDevSession() {
  const response = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await response.json() as { token?: string; user?: { id?: string }; error?: string };
  assert.ok(response.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");
  return { token: session.token, userId: session.user.id };
}

function buildPresetMessage(fields: PresetField[]) {
  const numbered = narrations.map((value, index) => `${index + 1}.【${value}】`).join("\n");
  const values: Record<string, string> = {
    segmented_script: numbered,
    animation_style: "默认皮克斯式高端商业3D动画",
    aspect_ratio: "16:9",
    target_duration_seconds: "10",
    special_notes: "",
  };
  const message = [...fields]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .flatMap((field) => {
      const value = values[field.id]?.trim();
      if (!value) return [];
      return field.sendLabel === false ? [value] : [`${field.sendText || field.label || field.id}：${value}`];
    })
    .join("\n");
  narrations.forEach((narration, index) => {
    assert.ok(message.includes(`${index + 1}.【${narration}】`), `提交内容缺少第${index + 1}段原文`);
  });
  assert.ok(!message.includes("特殊备注") && !message.includes("special_notes"), "空特殊备注必须省略");
  return message;
}

async function readStreamingContent(response: Response) {
  assert.ok(response.body, "模型流没有响应体");
  const reader = response.body.getReader();
  const decoder = new SseEventStreamDecoder();
  let content = "";
  let receivedDone = false;
  const consume = (events: ReturnType<SseEventStreamDecoder["push"]>) => {
    for (const event of events) {
      const raw = event.data.trim();
      if (!raw) continue;
      if (event.event === "done" || raw === "[DONE]") {
        receivedDone = true;
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
  while (!receivedDone) {
    const { done, value } = await reader.read();
    if (value) consume(decoder.push(value));
    if (done) break;
  }
  consume(decoder.finish());
  assert.ok(receivedDone, "模型流在 [DONE] 前结束");
  return content;
}

function parseCodeBlocks(content: string) {
  return [...content.matchAll(/```(?:text)?\s*\r?\n([\s\S]*?)```/giu)].map((match) => match[1].trim());
}

function parseSegments(raw: string): Segment[] {
  const heading = /^\*\*原文案内容段落\s*(\d+)\*\*：([^\r\n]+)\r?$/gmu;
  const matches = [...raw.matchAll(heading)];
  assert.equal(matches.length, narrations.length, `应有7个原文标题，实际${matches.length}个`);
  const segments = matches.map((match, index) => {
    const segmentNumber = Number(match[1]);
    const rawNarration = match[2].trim();
    const narration = rawNarration.startsWith("【") && rawNarration.endsWith("】")
      ? rawNarration.slice(1, -1)
      : rawNarration;
    const start = (match.index || 0) + match[0].length;
    const end = matches[index + 1]?.index ?? raw.length;
    const section = raw.slice(start, end);
    const blocks = parseCodeBlocks(section);
    const imageHeading = section.match(/故事板分镜图文生图 Prompt（共([45])格）/u);
    assert.equal(segmentNumber, index + 1, `第${index + 1}段编号错误`);
    assert.equal(narration, narrations[index], `第${segmentNumber}段原文被改写`);
    assert.ok(imageHeading, `第${segmentNumber}段缺少4/5格标题`);
    assert.equal(blocks.length, 2, `第${segmentNumber}段不是两个独立text代码框`);
    const [imagePrompt, videoPrompt] = blocks;
    const shotNumbers = [...videoPrompt.matchAll(/镜头\s*(\d+)/gu)].map((item) => Number(item[1]));
    const shotCount = Math.max(0, ...shotNumbers);
    assert.match(imagePrompt, /Frame\s*1\s*:/iu, `第${segmentNumber}段缺少英文Frame说明`);
    assert.ok(shotCount >= 2 && shotCount <= 4, `第${segmentNumber}段视频镜头数不是2至4`);
    return {
      segmentNumber,
      narration,
      panelCount: Number(imageHeading[1]) as 4 | 5,
      imagePrompt,
      videoPrompt,
      shotCount,
    };
  });
  assert.equal(parseCodeBlocks(raw).length, 14, "平台输出不是完整14个代码框");
  return segments;
}

async function waitForHistory(token: string, conversationId: string, submittedMessage: string, assistantMessage: string) {
  const deadline = Date.now() + 90_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      latest = await response.json();
      const messages = (latest as { conversation?: { messages?: Array<{ role?: string; content?: string }> } }).conversation?.messages || [];
      const hasUser = messages.some((message) => message.role === "user" && message.content === submittedMessage);
      const hasAssistant = messages.some((message) => message.role === "assistant" && message.content === assistantMessage);
      if (hasUser && hasAssistant) return latest;
    }
    await sleep(1_500);
  }
  throw new Error(`平台历史未在90秒内逐字落库：${JSON.stringify(latest)}`);
}

function includesAny(value: string, terms: string[]) {
  return terms.filter((term) => value.includes(term));
}

function removeNegatedConstraints(value: string) {
  return value
    .replace(/(?:不|未|没有|禁止|不得)[^。；\n]{0,48}(?:主人回来|主人返回|回到家|拥抱|安慰|安抚|和解|释然|恢复开心|恢复暖金|明亮回归)[^。；\n]*/gu, "")
    .replace(/不新增原文未发生的返回、和解或反转/gu, "");
}

function analyze(segments: Segment[]) {
  const forbiddenResolutionTerms = ["主人回来", "主人返回", "回到家", "拥抱", "安慰", "安抚", "和解", "释然", "恢复开心", "恢复暖金", "明亮回归"];
  const wrongAttireTerms = ["珊瑚红", "青绿色长裤", "奶白针织", "金毛犬", "浅金色金毛"];
  const perSegment = segments.map((segment) => {
    const both = `${segment.imagePrompt}\n${segment.videoPrompt}`;
    const positiveEvents = removeNegatedConstraints(both);
    return {
      segmentNumber: segment.segmentNumber,
      panelCount: segment.panelCount,
      shotCount: segment.shotCount,
      attireLock: {
        yellowTop: /黄色.*卫衣|亮黄色.*卫衣/u.test(segment.imagePrompt),
        blueJeans: segment.imagePrompt.includes("蓝色牛仔裤"),
        whiteSneakers: segment.imagePrompt.includes("白色运动鞋"),
        highPonytail: segment.imagePrompt.includes("高马尾"),
        corgi: segment.imagePrompt.includes("柯基"),
        wrongTerms: includesAny(segment.imagePrompt, wrongAttireTerms),
      },
      earlyResolutionTerms: includesAny(positiveEvents, forbiddenResolutionTerms),
      forcedSpectacleTerms: includesAny(both, ["英雄级", "巨大机关", "场景机关", "高墙", "绳桥", "心形弧线"]),
      coreMotifTerms: includesAny(both, ["零食", "门", "门缝", "离开", "关联", "交易"]),
    };
  });
  const segment2 = `${segments[1].imagePrompt}\n${segments[1].videoPrompt}`;
  const segment4 = `${segments[3].imagePrompt}\n${segments[3].videoPrompt}`;
  const doorGate = {
    inside: segment2.includes("室内"),
    outside: /室外|屋外|外廊|门外/u.test(segment2),
    sweepZone: segment2.includes("扫掠区"),
    direction: /关门方向|门板.*方向|门板[^。；\n]{0,48}(?:向门框运动|向门框合拢|闭合|关闭)|由开启向门框合拢/u.test(segment2),
    finalPositions: /(?:女性|主人)[\s\S]*在外[^。；\n]{0,32}(?:柯基|狗)[\s\S]*在内|(?:柯基|狗)[\s\S]*室内[^。；\n]{0,48}(?:女性|主人)[\s\S]*门外/u.test(segment2),
  };
  const repetitionTimeJumpGate = {
    explicitRepetition: /重复|循环|多次|一次比一次|久而久之/u.test(segment4),
    distinctDayMarker: /换日|不同日|第一天|第二天|第三天|另一天|清晨|傍晚|日历|天气|窗光/u.test(segment4),
    treatCauseRepeated: segment4.includes("零食"),
    departureCauseRepeated: /离开|关门|门缝收窄|门.*闭合/u.test(segment4),
    avoidsUnbrokenMultiDayAlone: !/独自在室内[^。；\n]{0,80}(?:多天|几天|不同日子)/u.test(segment4),
  };
  const allAttireLocked = perSegment.every((item) => Object.entries(item.attireLock)
    .filter(([key]) => key !== "wrongTerms")
    .every(([, value]) => value === true)
    && item.attireLock.wrongTerms.length === 0);
  const earlyResolutionClear = perSegment.every((item) => item.earlyResolutionTerms.length === 0);
  const doorGatePass = Object.values(doorGate).every(Boolean);
  const repetitionTimeJumpPass = Object.values(repetitionTimeJumpGate).every(Boolean);
  const shotCounts = perSegment.map((item) => item.shotCount);
  return {
    chainPass: allAttireLocked && earlyResolutionClear && doorGatePass && repetitionTimeJumpPass,
    allAttireLocked,
    earlyResolutionClear,
    doorGate,
    repetitionTimeJumpGate,
    shotCounts,
    panelShotDecoupled: shotCounts.some((count, index) => count !== perSegment[index].panelCount),
    perSegment,
  };
}

async function reanalyzeExisting(sourceDir: string) {
  const resolvedDir = path.resolve(sourceDir);
  const sourcePromptPath = path.join(resolvedDir, "original-14-code-blocks.json");
  const sourceAnalysisPath = path.join(resolvedDir, "quality-analysis.json");
  const artifact = JSON.parse(await readFile(sourcePromptPath, "utf8")) as { segments: Segment[] };
  assert.equal(artifact.segments.length, 7, "离线复核源文件不是7段");
  const quality = analyze(artifact.segments);
  await writeFile(sourceAnalysisPath, `${JSON.stringify(quality, null, 2)}\n`, "utf8");
  const review = JSON.parse(await readFile(reviewPath, "utf8")) as Record<string, unknown>;
  review.status = quality.chainPass ? "prompt-chain-pass-media-not-submitted" : "prompt-chain-fail-media-locked";
  review.quality = quality;
  review.reanalyzedAt = new Date().toISOString();
  review.reanalysisSource = "saved-platform-14-code-blocks-no-new-agent-or-media-call";
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    passed: quality.chainPass,
    phase: "reanalyze-existing",
    sourceDir: resolvedDir,
    quality,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    agentCalls: 0,
    imageSubmissions: 0,
    videoSubmissions: 0,
    costCny: 0,
  }, null, 2));
}

async function main() {
  if (process.env.REANALYZE_DIR?.trim()) return reanalyzeExisting(process.env.REANALYZE_DIR.trim());
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(reviewPath), { recursive: true });
  const session = await createDevSession();
  const admin = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const online = admin.agents.find((item) => item.id === agentId);
  assert.ok(online?.system_prompt && online.name === agentName, "线上高能版不存在");
  assert.equal(sha256(online.system_prompt), expectedPromptSha, "线上高能版Prompt SHA与待验版本不符");
  assert.equal(online.output_style?.schema_version, expectedSchema, "线上高能版schema与待验版本不符");
  assert.equal(online.output_style?.free_canvas_coupling, false, "高能版意外耦合自由画布");

  const bots = await requestJson<{ bots: AgentRecord[] }>(`${baseUrl}/api/bots?continuity=${Date.now()}`, session.token);
  const agent = bots.bots.find((item) => item.id === agentId && item.name === agentName);
  assert.ok(agent, "主站未找到高能版智能体");
  const submittedMessage = buildPresetMessage(agent.preset_fields || []);
  const conversationId = `conv_high_energy_snack_continuity_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: submittedMessage }],
      model: agent.model,
      stream: true,
      userId: session.userId,
      agentName,
      agentId,
      conversationId,
      maxContextRounds: 0,
      maxReplyTokens: 65_536,
      timeout: 720,
      enableWebSearch: false,
      responseFormat: "markdown",
    }),
    signal: AbortSignal.timeout(720_000),
  });
  assert.ok(response.ok, `智能体生成失败（${response.status}）`);
  const raw = response.headers.get("content-type")?.includes("text/event-stream")
    ? await readStreamingContent(response)
    : String(((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || "");
  await writeFile(rawPath, raw, "utf8");
  const segments = parseSegments(raw);
  const history = await waitForHistory(session.token, conversationId, submittedMessage, raw);
  const quality = analyze(segments);

  const artifact = {
    conversationId,
    agentId,
    agentName,
    model: agent.model,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    submittedMessage,
    submittedSegments: narrations.map((narration, index) => ({
      segmentNumber: index + 1,
      narration,
      characterCount: narration.length,
      sha256: sha256(narration),
    })),
    segments,
    codeBlocks: segments.flatMap((segment) => [
      { segmentNumber: segment.segmentNumber, kind: "image", content: segment.imagePrompt },
      { segmentNumber: segment.segmentNumber, kind: "video", content: segment.videoPrompt },
    ]),
  };
  await writeFile(promptPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await writeFile(analysisPath, `${JSON.stringify(quality, null, 2)}\n`, "utf8");

  const now = Date.now();
  const review = {
    reviewId,
    status: quality.chainPass ? "prompt-chain-pass-media-not-submitted" : "prompt-chain-fail-media-locked",
    createdAt: new Date().toISOString(),
    source: "real-platform-agent-single-call-zero-paid-media",
    conversationId,
    agentId,
    agentName,
    schemaVersion: expectedSchema,
    inputEvidence: {
      exactSegmentCount: narrations.length,
      totalNarrationCharacters: narrations.reduce((sum, value) => sum + value.length, 0),
      submittedMessage,
    },
    promptEvidence: {
      codeBlockCount: artifact.codeBlocks.length,
      rawPath,
      promptPath,
      historyPath,
      analysisPath,
    },
    quality,
    actualCost: {
      imageSubmissions: 0,
      videoSubmissions: 0,
      businessPriceCny: 0,
    },
    run: {
      id: `${runId}-workbench`,
      createdAt: now,
      updatedAt: now,
      ratio: "16:9",
      imageResolution: "2K",
      videoResolution: "",
      videoDuration: 10,
      imageModelId: "",
      videoModelId: "",
      title: "高能验收A｜连续叙事Prompt校正｜零媒体费用",
      cards: segments.map((segment) => ({
        id: `${runId}-card-${segment.segmentNumber}`,
        order: segment.segmentNumber,
        label: `第${segment.segmentNumber}段｜${segment.narration}`,
        imagePrompt: segment.imagePrompt,
        videoPrompt: segment.videoPrompt,
        referenceImageUrls: [],
        imageStatus: "idle",
        imageError: "本轮只做Prompt质量复验，未提交付费生图",
        videoStatus: "idle",
      })),
    },
  };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    passed: quality.chainPass,
    conversationId,
    codeBlockCount: artifact.codeBlocks.length,
    panelCounts: segments.map((segment) => segment.panelCount),
    shotCounts: quality.shotCounts,
    quality,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    rawPath,
    promptPath,
    historyPath,
    imageSubmissions: 0,
    videoSubmissions: 0,
    costCny: 0,
  }, null, 2));
}

main().catch(async (error) => {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const failure = {
    passed: false,
    at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    imageSubmissions: 0,
    videoSubmissions: 0,
    costCny: 0,
  };
  await writeFile(path.join(outDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
