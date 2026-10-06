import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const runId = process.env.RUN_ID || `high-energy-six-segments-${Date.now()}`;
const outputDir = ".tmp-e2e";
const rawPath = `${outputDir}/${runId}-agent-raw.md`;
const suitePath = `${outputDir}/${runId}-suite.json`;
const reportPath = `${outputDir}/${runId}-agent-report.json`;
const agentName = "故事版导演｜高能夸张";
const expectedAgentId = "agent-1786633444187-594spj";
const targetDurationSeconds = process.env.TARGET_DURATION_SECONDS || "10";
assert.ok(["8", "10", "15"].includes(targetDurationSeconds), "测试时长仅支持8、10或15秒");

const segments = [
  "盘点狗狗行为解说，看看你家有中招吗？这期视频啊，盘点的是狗，不是哈士奇啊，大家不要误会。男生出门遛狗脱单的几率啊，要比不遛狗脱单的几率高三倍。",
  "不过哈士奇除外啊，这货就是让你单身的几率高三倍。狗狗歪头杀的含义：狗狗歪头啊，不是为了卖萌，是为了听得更清楚。狗狗歪头啊，可以让耳朵更好的接受声音，",
  "或者是鼻子挡住了前面的视线，需要歪一下头才能看得更清楚。而哈士奇歪头可能就是为了卖萌。狗狗眯眼，狗狗有时候喜欢眯着眼睛看着你，是因为它感到很开心，",
  "或者是在向你撒娇。不过哈士奇除外，它就是瞧不起你。狗狗无缘无故的乱叫，狗的听力啊是人类的十几倍，有时候啊甚至会听到我们听不到的声音。而狗狗没事就喜欢吠叫，",
  "有可能是听到了门外有陌生的脚步声，再或者就是看到了一些昆虫在它眼前飞过。哈士奇除外，这玩意儿没事就喜欢乱叫。狗狗在你的物品上撒尿，说明它是吃醋了。",
  "有可能是你背着它在外面有其他的狗了。哈士奇除外，它也没有其他的意思啊，就是不爽你。你能怎么办？揍它一顿，分分钟钟给你制定一套装修计划。",
] as const;

interface PresetField {
  id: string;
  label?: string;
  sendLabel?: boolean;
  sendText?: string;
  type?: string;
  order?: number;
  options?: string[];
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

function escapeTextareaNumbering(value: string): string {
  return value.replace(/^(\d+)\. /gm, "$1\\. ");
}

function buildPresetMessage(fields: PresetField[]): string {
  const values: Record<string, string> = {
    segmented_script: segments.map((segment, index) => `${index + 1}.【${segment}】`).join("\n"),
    animation_style: "高能商业3D动画喜剧（皮克斯式）",
    aspect_ratio: "16:9",
    target_duration_seconds: targetDurationSeconds,
  };

  return [...fields]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .flatMap((field) => {
      const raw = values[field.id]?.trim();
      if (!raw) return [];
      const userValue = field.type === "textarea" ? escapeTextareaNumbering(raw) : raw;
      if (field.sendLabel === false) return [userValue];
      return [`${field.sendText || field.label || field.id}：${userValue}`];
    })
    .join("\n");
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
  const pattern = /```(?:text)?\s*\r?\n([\s\S]*?)```/giu;
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

function validateAndPairBlocks(content: string) {
  const blocks = parseCodeBlocks(content);
  assert.equal(blocks.length, segments.length * 2, `应输出12个text代码框，实际${blocks.length}个`);

  return segments.map((narration, index) => {
    const imageBlock = blocks[index * 2];
    const videoBlock = blocks[index * 2 + 1];
    assert.notEqual(imageBlock.type, "video", `第${index + 1}段第一个代码框被识别为视频Prompt`);
    assert.notEqual(videoBlock.type, "image", `第${index + 1}段第二个代码框被识别为生图Prompt`);
    assert.ok(imageBlock.content.length >= 300, `第${index + 1}段生图Prompt过短`);
    assert.ok(videoBlock.content.length >= 160, `第${index + 1}段视频Prompt过短`);
    assert.match(imageBlock.content, /(16:9|横屏)/u, `第${index + 1}段生图Prompt缺少16:9`);
    assert.match(imageBlock.content, /(3D|动画)/iu, `第${index + 1}段生图Prompt缺少3D动画风格`);
    assert.match(imageBlock.content, /(格|Frame|panel)/iu, `第${index + 1}段生图Prompt缺少故事板格位`);
    assert.match(videoBlock.content, new RegExp(`(${targetDurationSeconds}秒|约${targetDurationSeconds}秒|0\\.0|镜头|秒|shot|camera)`, "iu"), `第${index + 1}段视频Prompt缺少${targetDurationSeconds}秒动作时间轴`);
    assert.doesNotMatch(videoBlock.content, /(显示故事板网格|保留分隔线|显示Frame编号)/u, `第${index + 1}段视频Prompt错误要求显示故事板版式`);
    return {
      id: `${expectedAgentId}-segment-${index + 1}`,
      name: `高能夸张｜分段${index + 1}`,
      segmentIndex: index + 1,
      narration,
      imagePrompt: imageBlock.content,
      videoPrompt: videoBlock.content,
      imagePromptLength: imageBlock.content.length,
      videoPromptLength: videoBlock.content.length,
      imageHeader: imageBlock.header,
      videoHeader: videoBlock.header,
    };
  });
}

async function waitForHistory(token: string, conversationId: string, expectedAssistant: string) {
  const deadline = Date.now() + 45_000;
  let latest: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) {
      latest = await response.json() as Record<string, unknown>;
      const conversation = latest.conversation as { messages?: Array<{ role?: string; content?: string }> } | undefined;
      const messages = conversation?.messages || [];
      const savedUser = messages.some((message) => message.role === "user");
      const savedAssistant = messages.some((message) => message.role === "assistant" && message.content === expectedAssistant);
      if (savedUser && savedAssistant) return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`真实对话历史没有在45秒内完整落库：${JSON.stringify(latest)}`);
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string; user?: { id?: string } };
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");

  const botsResponse = await fetch(`${baseUrl}/api/bots?high_energy_six=${Date.now()}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const botsPayload = await botsResponse.json() as { bots?: AgentCard[]; error?: string };
  assert.ok(botsResponse.ok, botsPayload.error || "主站智能体列表读取失败");
  const agent = botsPayload.bots?.find((item) => item.id === expectedAgentId && item.name === agentName);
  assert.ok(agent, `主站没有找到智能体：${agentName}`);

  const fields = agent.preset_fields || [];
  for (const id of ["segmented_script", "animation_style", "aspect_ratio", "target_duration_seconds"]) {
    assert.ok(fields.some((field) => field.id === id), `${agentName}缺少接收字段：${id}`);
  }
  assert.ok(fields.find((field) => field.id === "target_duration_seconds")?.options?.includes(targetDurationSeconds), `高能版没有${targetDurationSeconds}秒选项`);

  const submittedMessage = buildPresetMessage(fields);
  const conversationId = `conv_high_energy_six_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  const content = response.headers.get("content-type")?.includes("text/event-stream")
    ? await readStreamingContent(response)
    : extractAssistantContent(await response.json() as Record<string, unknown>);
  await writeFile(rawPath, content, "utf8");

  const pairedSegments = validateAndPairBlocks(content);
  const history = await waitForHistory(session.token, conversationId, content);
  const suite = {
    passed: true,
    testedAt: new Date().toISOString(),
    source: "real-platform-agent-conversation",
    conversationId,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model,
    fullSourceCopy: segments.join("\n\n"),
    submittedMessage,
    agents: pairedSegments,
  };
  await writeFile(suitePath, JSON.stringify(suite, null, 2), "utf8");
  await writeFile(reportPath, JSON.stringify({
    ...suite,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    rawPath,
    suitePath,
    historyVerified: true,
    history,
  }, null, 2), "utf8");

  console.log(JSON.stringify({
    passed: true,
    conversationId,
    agentId: agent.id,
    agentName: agent.name,
    model: agent.model,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    segmentCount: pairedSegments.length,
    rawPath,
    suitePath,
    reportPath,
    promptLengths: pairedSegments.map((segment) => ({
      segment: segment.segmentIndex,
      image: segment.imagePromptLength,
      video: segment.videoPromptLength,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
