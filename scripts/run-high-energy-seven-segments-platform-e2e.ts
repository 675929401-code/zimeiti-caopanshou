import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const runId = process.env.RUN_ID || `high-energy-third-group-seven-${Date.now()}`;
const replayConversationId = process.env.REPLAY_CONVERSATION_ID?.trim() || "";
const replayRawFile = process.env.REPLAY_RAW_FILE?.trim() || "";
const outputDir = ".tmp-e2e";
const agentId = "agent-1786633444187-594spj";
const agentName = "故事版导演｜高能夸张";
const animationStyle = "高能商业3D动画喜剧（皮克斯式）";
const aspectRatio = "16:9";
const targetDurationSeconds = "10";

const segments = [
  "狗是胖点好还是瘦点好？答案永远都是瘦点好。人类不有一句话吗？“千金难买老来瘦”。狗也一样，现在出去遛狗，主人最怕听到的一句话就是：“你家狗怎么这么瘦？",
  "”就好像是你舍不得给它吃似的，虐待它一样。现在审美都不知道怎么回事，都喜欢胖的。猫狗胖的可爱，养的太胖那不叫养的好，你那是在养猪呢，",
  "你要按斤给它卖钱呢。你要从俯视看，什么样的身材是最好的？俯视看它是凹凸有致的，顺着它的侧边摸下去是能摸到肋骨的。",
  "这样的狗它不容易生病，体格子还当当的。你就看着像一个球似的，一点腰线都没有，后背溜平，看着可爱，但是你家狗就老遭罪了，",
  "走两步就喘的不行。你等再过两年老了，什么糖尿病、心脏病、关节炎都找上门了。狗这个物种它本身就馋，有的狗甚至都不知道饥饱，",
  "你给它多少它吃多少，尤其是绝育之后，七情六欲就剩食欲了，吃的像个大气球似的。能把狗狗的体重控制特别好的主人是非常厉害的。",
  "你可以拍一下你家狗狗的俯视图，我给你看看你家的狗是胖还是瘦。",
] as const;

const numberedSegments = segments.map((segment, index) => `${index + 1}.【${segment}】`).join("\n");
const submittedMessage = [
  `segmented_script：${numberedSegments}`,
  `animation_style：${animationStyle}`,
  `aspect_ratio：${aspectRatio}`,
  `target_duration_seconds：${targetDurationSeconds}`,
].join("\n");

interface PresetField {
  id: string;
  options?: string[];
  defaultValue?: string;
}

interface AgentCard {
  id: string;
  name: string;
  model: string;
  preset_fields?: PresetField[];
}

interface CodeBlock {
  content: string;
  header: string;
  type: "image" | "video" | "unknown";
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function extractAssistantContent(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return String(message?.content || first?.text || payload.content || "");
}

async function readStreamingContent(response: Response): Promise<string> {
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
      if (data.error) {
        const message = typeof data.error === "string" ? data.error : data.error.message;
        throw new Error(message || "模型流返回错误");
      }
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
  assert.ok(receivedDone, "模型流在[DONE]前中断");
  return content;
}

function classifyHeader(header: string): CodeBlock["type"] {
  if (/(图生视频|视频\s*Prompt|视频提示词|video\s*prompt)/iu.test(header)) return "video";
  if (/(文生图|生图\s*Prompt|故事板分镜图|图片提示词|image\s*prompt)/iu.test(header)) return "image";
  return "unknown";
}

function parseCodeBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const pattern = /```text\s*\r?\n([\s\S]*?)```/giu;
  let previousEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const between = content.slice(previousEnd, match.index);
    const header = between.split(/\r?\n/).filter((line) => line.trim()).slice(-3).join("\n");
    blocks.push({ content: match[1].trim(), header, type: classifyHeader(header) });
    previousEnd = pattern.lastIndex;
  }
  return blocks;
}

function extractNarrations(content: string): string[] {
  const matches = [...content.matchAll(/\*\*原文案内容段落\s*(\d+)\*\*\s*[：:]\s*([^\r\n]*)/gu)];
  return matches.map((match, index) => {
    assert.equal(Number(match[1]), index + 1, `原文案段落编号错位：${match[1]}`);
    return match[2].trim()
      .replace(new RegExp(`^${index + 1}[.、]\\s*`), "")
      .replace(/^【/, "")
      .replace(/】$/, "");
  });
}

function uniqueNumbers(content: string, token: string): number[] {
  return [...new Set([...content.matchAll(new RegExp(`${token}\\s*([1-5])`, "giu"))]
    .map((match) => Number(match[1])))].sort((a, b) => a - b);
}

function validatePromptPair(imagePrompt: string, videoPrompt: string, index: number) {
  const frames = uniqueNumbers(imagePrompt, "Frame");
  const shots = uniqueNumbers(videoPrompt, "镜头");
  const captionFrames = [...new Set([...imagePrompt.matchAll(/Frame\s*([1-5])\s*:\s*[A-Za-z]/gu)]
    .map((match) => Number(match[1])))];
  const captionSentences = [...imagePrompt.matchAll(/Frame\s*[1-5]\s*:\s*([A-Za-z][^\r\n]*)/gu)]
    .map((match) => match[1].trim());

  assert.ok(frames.length === 4 || frames.length === 5, `第${index}段不是4/5格`);
  assert.equal(captionFrames.length, frames.length, `第${index}段英文说明条数量与格数不一致`);
  assert.ok(captionSentences.every((sentence) => {
    const words = sentence.match(/[A-Za-z]+(?:'[A-Za-z]+)?/gu)?.length || 0;
    return words >= 8 && words <= 14;
  }), `第${index}段英文说明未控制在8至14词`);
  assert.ok(shots.length >= 3 && shots.length <= 4, `第${index}段视频不是10秒3至4镜`);
  assert.match(imagePrompt, /16:9/u, `第${index}段生图Prompt缺少16:9`);
  assert.match(imagePrompt, /高端商业3D动画电影|高能商业(?:风格化)?3D动画电影|商业级3D动画电影|高能商业3D动画喜剧|影院级风格/u, `第${index}段缺少商业3D风格`);
  assert.match(imagePrompt, /成年亚洲女性/u, `第${index}段未落实默认成年亚洲女性`);
  assert.match(imagePrompt, /自然四足/u, `第${index}段缺少犬类自然四足约束`);
  assert.match(imagePrompt, /接触点|接触|压住|踩住|触碰|轻触|贴住|按住|握住|扶住|托住|指腹|滑下|抚|拂/u, `第${index}段缺少接触点表达`);
  assert.match(imagePrompt, /功能色|警示|对抗|回归|暖|冷|青|蓝|红|绿/u, `第${index}段缺少功能色表达`);
  assert.match(videoPrompt, /10\.0秒|10秒/u, `第${index}段视频Prompt缺少10秒终点`);
  assert.match(videoPrompt, /保持(?:参考图的高端商业|统一)风格化3D动画形象/u, `第${index}段视频Prompt缺少风格连续定义`);
  assert.doesNotMatch(`${imagePrompt}\n${videoPrompt}`, /裸露器官|完整内脏剖面|血腥解剖/u, `第${index}段出现不适解剖要求`);

  return {
    frameCount: frames.length,
    shotCount: shots.length,
    captionFrameCount: captionFrames.length,
    imagePromptSha256: sha256(imagePrompt),
    videoPromptSha256: sha256(videoPrompt),
  };
}

async function waitForHistory(token: string, conversationId: string, assistantContent: string) {
  const deadline = Date.now() + 60_000;
  let latest: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      latest = await response.json() as Record<string, unknown>;
      const messages = (latest.conversation as { messages?: Array<{ role?: string; content?: string }> } | undefined)?.messages || [];
      const savedUser = messages.some((message) => message.role === "user" && message.content === submittedMessage);
      const savedAssistant = messages.some((message) => message.role === "assistant" && message.content === assistantContent);
      if (savedUser && savedAssistant) return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`真实对话历史没有在60秒内逐字落库：${JSON.stringify(latest)}`);
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; user?: { id?: string }; error?: string };
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");

  const botsResponse = await fetch(`${baseUrl}/api/bots?third_group=${Date.now()}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const botsPayload = await botsResponse.json() as { bots?: AgentCard[]; error?: string };
  assert.ok(botsResponse.ok, botsPayload.error || "主站智能体列表读取失败");
  const agent = botsPayload.bots?.find((item) => item.id === agentId && item.name === agentName);
  assert.ok(agent, `主站未找到智能体：${agentName}`);
  const fields = agent.preset_fields || [];
  for (const id of ["segmented_script", "animation_style", "aspect_ratio", "target_duration_seconds", "special_notes"]) {
    assert.ok(fields.some((field) => field.id === id), `${agentName}缺少接收字段：${id}`);
  }
  assert.equal(fields.find((field) => field.id === "animation_style")?.defaultValue, animationStyle, "平台默认3D风格不匹配");
  assert.ok(fields.find((field) => field.id === "aspect_ratio")?.options?.includes(aspectRatio), "平台缺少16:9选项");
  assert.ok(fields.find((field) => field.id === "target_duration_seconds")?.options?.includes(targetDurationSeconds), "平台缺少10秒选项");

  const conversationId = replayConversationId
    || `conv_high_energy_third_group_seven_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  let content = "";
  let replayHistory: Record<string, unknown> | null = null;
  if (replayConversationId) {
    const historyResponse = await fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.ok(historyResponse.ok, `真实历史恢复失败（${historyResponse.status}）`);
    replayHistory = await historyResponse.json() as Record<string, unknown>;
    const messages = (replayHistory.conversation as { messages?: Array<{ role?: string; content?: string }> } | undefined)?.messages || [];
    assert.ok(messages.some((message) => message.role === "user" && message.content === submittedMessage), "真实历史中的用户输入不是七段原样文案");
    content = [...messages].reverse().find((message) => message.role === "assistant")?.content || "";
    assert.ok(content, `真实历史缺少assistant输出：${conversationId}`);
  } else if (replayRawFile) {
    content = await readFile(replayRawFile, "utf8");
    assert.ok(content.trim(), `离线复验文件为空：${replayRawFile}`);
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
        agentName: agent.name,
        agentId: agent.id,
        conversationId,
        maxContextRounds: 0,
        maxReplyTokens: 32768,
        timeout: 300,
        enableWebSearch: false,
        responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(420_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      assert.fail(String(payload.error || `${agentName}请求失败（${response.status}）`));
    }
    content = response.headers.get("content-type")?.includes("text/event-stream")
      ? await readStreamingContent(response)
      : extractAssistantContent(await response.json() as Record<string, unknown>);
  }
  const rawPath = `${outputDir}/${runId}-agent-raw.md`;
  await writeFile(rawPath, content, "utf8");

  const narrations = extractNarrations(content);
  assert.deepEqual(narrations, [...segments], "平台输出 narration 与七段原文不一致");
  const blocks = parseCodeBlocks(content);
  assert.equal(blocks.length, 14, `应输出14个text代码框，实际${blocks.length}个`);

  const agents = segments.map((narration, index) => {
    const imageBlock = blocks[index * 2];
    const videoBlock = blocks[index * 2 + 1];
    assert.equal(imageBlock.type, "image", `第${index + 1}段第一个代码框不是生图Prompt`);
    assert.equal(videoBlock.type, "video", `第${index + 1}段第二个代码框不是视频Prompt`);
    const validation = validatePromptPair(imageBlock.content, videoBlock.content, index + 1);
    return {
      id: `${agentId}-segment-${index + 1}`,
      name: `第三组｜分段${index + 1}`,
      segmentIndex: index + 1,
      narration,
      narrationExactMatch: narrations[index] === narration,
      imagePrompt: imageBlock.content,
      videoPrompt: videoBlock.content,
      imageHeader: imageBlock.header,
      videoHeader: videoBlock.header,
      imagePromptLength: imageBlock.content.length,
      videoPromptLength: videoBlock.content.length,
      ...validation,
    };
  });
  assert.equal(new Set(agents.map((item) => item.imagePromptSha256)).size, 7, "七段生图Prompt存在重复");

  const history = replayHistory || (replayRawFile
    ? { source: "saved-real-platform-output", rawFile: replayRawFile }
    : await waitForHistory(session.token, conversationId, content));
  const suitePath = `${outputDir}/${runId}-suite.json`;
  const reportPath = `${outputDir}/${runId}-agent-report.json`;
  const suite = {
    passed: true,
    source: "real-platform-agent-conversation",
    testedAt: new Date().toISOString(),
    runId,
    conversationId,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model,
    settings: {
      targetDurationSeconds: Number(targetDurationSeconds),
      aspectRatio,
      animationStyle,
      specialNotes: "",
    },
    numberedSegments,
    submittedMessage,
    codeBlockCount: blocks.length,
    narrationExactMatchCount: agents.filter((item) => item.narrationExactMatch).length,
    agents,
  };
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
  await writeFile(reportPath, `${JSON.stringify({
    ...suite,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    rawPath,
    suitePath,
    historyVerified: true,
    history,
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    passed: true,
    conversationId,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    segmentCount: agents.length,
    codeBlockCount: blocks.length,
    narrationExactMatchCount: agents.filter((item) => item.narrationExactMatch).length,
    rawPath,
    suitePath,
    reportPath,
    prompts: agents.map((item) => ({
      segment: item.segmentIndex,
      frames: item.frameCount,
      shots: item.shotCount,
      imageLength: item.imagePromptLength,
      videoLength: item.videoPromptLength,
      imagePromptSha256: item.imagePromptSha256,
      videoPromptSha256: item.videoPromptSha256,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
