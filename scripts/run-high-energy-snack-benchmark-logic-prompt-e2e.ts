import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const agentName = "故事版导演｜高能夸张";
const expectedSchema = "storyboard_director_output_style.v3.5.0";
const expectedPromptSha = "b08b3c5ab902f92fb5a8a570d301c6227cd557b7827b56ca4df9cafffd600e27";
const replayConversationId = process.env.REPLAY_CONVERSATION_ID?.trim() || "";
const runId = `high-energy-snack-benchmark-logic-v350-${Date.now()}`;
const reviewId = "high-energy-snack-benchmark-logic-prompt-v350-20260816";
const outDir = path.resolve(".tmp-e2e", runId);
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
type ParsedSegment = {
  number: number;
  narration: string;
  panelCount: number;
  frameNumbers: number[];
  shotNumbers: number[];
  shotFrameReferences: number[];
  imagePrompt: string;
  videoPrompt: string;
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${url} failed (${response.status})`);
  return payload;
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

function parse(raw: string): ParsedSegment[] {
  const heading = /^\*\*原文案内容段落\s*(\d+)\*\*：([^\r\n]+)\r?$/gmu;
  const headings = [...raw.matchAll(heading)];
  assert.equal(headings.length, 7, `原文标题应为7个，实际${headings.length}个`);
  const allBlocks = [...raw.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)];
  assert.equal(allBlocks.length, 14, `text代码框应为14个，实际${allBlocks.length}个`);
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
    assert.equal(blocks.length, 2, `第${number}段不是两个text代码框`);
    const [imagePrompt, videoPrompt] = blocks;
    const frameNumbers = [...new Set([...imagePrompt.matchAll(/Frame\s*([1-5])\s*:/giu)].map((item) => Number(item[1])))];
    const shotNumbers = [...new Set([...videoPrompt.matchAll(/镜头\s*([1-5])/gu)].map((item) => Number(item[1])))];
    const shotFrameReferences = [...videoPrompt.matchAll(/唯一参考\s*Frame\s*([1-5])/giu)].map((item) => Number(item[1]));
    assert.equal(frameNumbers.length, Number(panelMatch[1]), `第${number}段Frame数量不匹配`);
    assert.ok(shotNumbers.length >= 2 && shotNumbers.length <= 3, `第${number}段不是2至3镜`);
    assert.equal(shotFrameReferences.length, shotNumbers.length, `第${number}段不是每镜唯一绑定一个Frame`);
    assert.doesNotMatch(videoPrompt, /参考格[^\n。；]{0,20}合并|综合多格/u, `第${number}段仍在合并参考格`);
    assert.match(videoPrompt, /不融合|不变形/u, `第${number}段缺少跨Frame防融合约束`);
    assert.match(imagePrompt, /大而清澈|大而明亮|大而有神|圆亮|大眼|湿润眼睛/u, `第${number}段角色眼神风格未落实`);
    assert.match(imagePrompt, /黄色[^\n。；]{0,24}卫衣/u, `第${number}段默认服装未锁定`);
    assert.match(imagePrompt, /蓝色牛仔裤/u, `第${number}段牛仔裤未锁定`);
    assert.match(imagePrompt, /白色运动鞋/u, `第${number}段运动鞋未锁定`);
    assert.match(imagePrompt, /柯基/u, `第${number}段犬种未锁定`);
    return {
      number,
      narration,
      panelCount: Number(panelMatch[1]),
      frameNumbers,
      shotNumbers,
      shotFrameReferences,
      imagePrompt,
      videoPrompt,
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

function positiveOnly(value: string) {
  return value
    .replace(/[^。；\n]*(?:禁止|不得|不|无)[^。；\n]{0,90}(?:扔|抛|投掷|关门|闭合|关闭|重演)[^。；\n]*/gu, "")
    .replace(/不复制人物、宠物、门或主道具/gu, "")
    .replace(/不重演已完成动作/gu, "");
}

function analyze(segments: ParsedSegment[]) {
  const segment2 = segments[1];
  const segment3 = segments[2];
  const segment4 = segments[3];
  const segment5 = segments[4];
  const laterPositive = positiveOnly([
    segment3.imagePrompt,
    segment3.videoPrompt,
    segment4.imagePrompt,
    segment4.videoPrompt,
    segment5.imagePrompt,
    segment5.videoPrompt,
  ].join("\n"));
  const actionOwnership = {
    segment2HasTreatThrow: /抛|扔/u.test(segment2.imagePrompt) && /抛|扔/u.test(segment2.videoPrompt),
    segment2HasOneCloseEvent: /只(?:闭合|关闭|收窄)一次|只完成一次|唯一.*关门/u.test(`${segment2.imagePrompt}\n${segment2.videoPrompt}`),
    laterSegmentsDoNotReplayThrow: !/(?:再次|重新|又一次)[^。；\n]{0,20}(?:抛|扔)|(?:抛|扔)[^。；\n]{0,20}(?:零食|小食)/u.test(laterPositive),
    laterSegmentsDoNotReplayClosing: !/(?:再次|重新|又一次)[^。；\n]{0,20}(?:关门|闭合|关闭)|门缝[^。；\n]{0,20}(?:再次|重新)[^。；\n]{0,20}收窄/u.test(laterPositive),
  };
  const videoReferenceGate = segments.every((segment) => (
    segment.shotFrameReferences.length === segment.shotNumbers.length
    && !/参考格[^\n。；]{0,20}合并|综合多格/u.test(segment.videoPrompt)
    && /不融合|不变形/u.test(segment.videoPrompt)
  ));
  const styleGate = segments.every((segment) => (
    /动画|卡通/u.test(segment.imagePrompt)
    && /大而清澈|大而明亮|大而有神|圆亮|大眼|湿润眼睛/u.test(segment.imagePrompt)
    && /眉|嘴|耳|尾巴|重心/u.test(segment.imagePrompt)
  ));
  const verdict = Object.values(actionOwnership).every(Boolean) && videoReferenceGate && styleGate;
  return {
    verdict,
    actionOwnership,
    videoReferenceGate,
    styleGate,
    segmentSummaries: segments.map((segment) => ({
      number: segment.number,
      panelCount: segment.panelCount,
      shotCount: segment.shotNumbers.length,
      shotFrameReferences: segment.shotFrameReferences,
      imagePromptSha256: sha256(segment.imagePrompt),
      videoPromptSha256: sha256(segment.videoPrompt),
    })),
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(reviewPath), { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; user?: { id?: string }; error?: string };
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");

  const admin = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const online = admin.agents.find((item) => item.id === agentId);
  assert.ok(online?.system_prompt && online.name === agentName, "线上高能版不存在");
  assert.equal(sha256(online.system_prompt), expectedPromptSha, "线上Prompt SHA不符");
  assert.equal(online.output_style?.schema_version, expectedSchema, "线上schema不符");
  assert.equal(online.output_style?.free_canvas_coupling, false, "高能版耦合自由画布");

  const bots = await requestJson<{ bots: AgentRecord[] }>(`${baseUrl}/api/bots?logic=${Date.now()}`, session.token);
  const agent = bots.bots.find((item) => item.id === agentId && item.name === agentName);
  assert.ok(agent, "主站未找到高能版智能体");
  const submittedMessage = buildMessage(agent.preset_fields || []);
  const conversationId = replayConversationId
    || `conv_high_energy_snack_benchmark_logic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  let raw = "";
  let history: unknown;
  if (replayConversationId) {
    history = await requestJson<{ conversation?: { messages?: Array<{ role?: string; content?: string }> } }>(
      `${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`,
      session.token,
    );
    const messages = (history as { conversation?: { messages?: Array<{ role?: string; content?: string }> } }).conversation?.messages || [];
    assert.ok(messages.some((item) => item.role === "user" && item.content === submittedMessage), "恢复历史中的用户输入不一致");
    raw = [...messages].reverse().find((item) => item.role === "assistant")?.content || "";
    assert.ok(raw, "恢复历史中缺少assistant输出");
  } else {
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
        userId: session.user.id,
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
    assert.ok(response.ok, `智能体调用失败（${response.status}）`);
    raw = response.headers.get("content-type")?.includes("text/event-stream")
      ? await readStream(response)
      : String(((await response.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || "");
  }
  const segments = parse(raw);
  history ||= await waitForHistory(session.token, conversationId, submittedMessage, raw);
  const quality = analyze(segments);
  const completedAt = Date.now();

  await writeFile(path.join(outDir, "platform-agent-raw-14-code-blocks.md"), raw, "utf8");
  await writeFile(path.join(outDir, "original-14-code-blocks.json"), `${JSON.stringify({
    conversationId,
    agentId,
    agentName,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    submittedMessage,
    narrations,
    segments,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "platform-history.json"), `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "prompt-quality.json"), `${JSON.stringify(quality, null, 2)}\n`, "utf8");

  const review = {
    reviewId,
    status: quality.verdict ? "prompt-chain-pass-media-not-submitted" : "prompt-chain-fail-media-locked",
    createdAt: new Date().toISOString(),
    source: replayConversationId
      ? "recovered-real-platform-agent-single-call-zero-paid-media"
      : "real-platform-agent-single-call-zero-paid-media",
    conversationId,
    agentId,
    agentName,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    benchmarkEvidence: {
      sourceUrl: "https://sss.chatai8.com/#/shop/5",
      localDir: ".tmp-e2e/benchmark-site-evidence-20260816",
      imageExamples: 3,
      videoExamples: 2,
    },
    inputEvidence: {
      segmentCount: narrations.length,
      totalCharacters: narrations.reduce((sum, value) => sum + value.length, 0),
      exactNarrations: narrations,
    },
    promptEvidence: {
      codeBlockCount: 14,
      rawPath: path.join(outDir, "platform-agent-raw-14-code-blocks.md"),
      blocksPath: path.join(outDir, "original-14-code-blocks.json"),
      historyPath: path.join(outDir, "platform-history.json"),
      qualityPath: path.join(outDir, "prompt-quality.json"),
    },
    quality,
    actualCost: { agentCalls: 1, recoveryAgentCalls: 0, imageSubmissions: 0, videoSubmissions: 0, businessPriceCny: 0 },
    elapsedMs: completedAt - startedAt,
    run: {
      id: `${runId}-workbench`,
      createdAt: completedAt,
      updatedAt: completedAt,
      ratio: "16:9",
      imageResolution: "2K",
      videoDuration: 10,
      title: "高能验收A｜v3.5.0叙事动作逻辑｜零媒体费用",
      cards: segments.map((segment) => ({
        id: `${runId}-card-${segment.number}`,
        order: segment.number,
        label: `第${segment.number}段｜${segment.narration}`,
        imagePrompt: segment.imagePrompt,
        videoPrompt: segment.videoPrompt,
        referenceImageUrls: [],
        imageStatus: "idle",
        imageError: "本轮先做平台原始Prompt结构门禁，未提交付费媒体",
        videoStatus: "idle",
      })),
    },
  };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    passed: quality.verdict,
    conversationId,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    codeBlocks: 14,
    quality,
    outputDir: outDir,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    costCny: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
