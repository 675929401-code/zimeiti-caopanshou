import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseStructuredAgentOutput } from "../src/lib/structured-agent-output";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const suiteVersion = process.env.SUITE_VERSION || "dog-behaviors-v62-20260814";
const outputPath = `.tmp-e2e/storyboard-agent-suite-${suiteVersion}.json`;
const partialPath = `.tmp-e2e/storyboard-agent-suite-${suiteVersion}-partial.json`;
const fixturePath = process.env.STORYBOARD_FIXTURE_PATH?.trim();

const agentNames = [
  "故事版导演｜高能夸张",
  "故事版导演｜电影叙事",
  "故事版导演｜抒情情感",
] as const;
const onlyAgentName = process.env.ONLY_AGENT_NAME?.trim();
const selectedAgentNames = onlyAgentName
  ? agentNames.filter((name) => name === onlyAgentName)
  : [...agentNames];

const defaultFullSourceCopy = `狗狗向你示好却总被误会挨揍的4个行为，强烈建议大家都了解一下犬类行为学。

它不会说话，但它靠近你的每一个动作，都是它能想到的最大努力。

第一个，它咬你的手。不是攻击，是它对你没有防备，用最放松的方式跟你玩。它咬你，说明它信任你。你想让它停，暂停游戏、或者轻轻按住它的嘴等几秒就够了，不需要打它。你一打，它记住的不是"不能咬"，是"靠近你很危险"。

第二个，前脚趴地、屁股撅高、左右蹦跳还对你叫。这不是挑衅，这是狗狗的邀请动作，翻译过来就是："快来跟我玩！"它这么卖力，你却以为它在找茬。

第三个，你拿出零食，它急得低吼。很多主人第一反应是"你敢吼我"，直接把零食收走。但它不是威胁你，它是太想要了、又怕你不给，急到不知道怎么办，就像小孩馋得哼唧一样。它吼的不是你，是它自己的焦虑。

第四个，咬住你的裤脚使劲拽。不是破坏，不是皮，它是在用它唯一会的方式说："你能不能陪我一下？"尤其是幼犬，这几乎是它们最直白的撒娇。

第五个，拔河游戏里它拉着玩具低吼。那不是警告，那是它玩嗨了，在告诉你这个游戏很好玩，它舍不得输。

它所有"让你烦"的动作，本质上只有一件事——它想跟你在一起。你误解它、打骂它，它不会解释，只会变得越来越缩、越来越不敢靠近你。

你有没有哪个瞬间，事后才发现自己误会它了？评论区说说，我们一起替它们说句话。`;

// 同一篇长口播先取一个完整行为做三导演横评，避免把不同语义当成导演差异。
const defaultEvaluationSegments = [
  "第一个，它咬你的手。不是攻击，是它对你没有防备，用最放松的方式跟你玩。它咬你，说明它信任你。",
];

interface StoryboardFixture {
  fullSourceCopy?: string;
  evaluationSegments?: string[];
  animationStyle?: string;
  aspectRatio?: string;
  targetDurationSeconds?: number;
  specialNotes?: string;
  expectedDogTerms?: string[];
  expectedPanelCounts?: number[];
  expectedShotCounts?: number[];
}

const fixture: StoryboardFixture = fixturePath
  ? JSON.parse(readFileSync(fixturePath, "utf8")) as StoryboardFixture
  : {};
const fullSourceCopy = fixture.fullSourceCopy?.trim() || defaultFullSourceCopy;
const evaluationSegments = fixture.evaluationSegments?.map((item) => item.trim()).filter(Boolean)
  || defaultEvaluationSegments;
const animationStyle = fixture.animationStyle?.trim() || "高能商业3D动画喜剧（皮克斯式）";
const aspectRatio = fixture.aspectRatio?.trim() || "16:9";
const targetDurationSeconds = fixture.targetDurationSeconds || 10;
const specialNotes = fixture.specialNotes?.trim()
  || "固定主角为27岁中国女性，深棕高马尾，芥末黄连帽卫衣、蓝色牛仔裤、白色运动鞋；固定宠物为一只成年金毛犬，蜂蜜金长毛、深棕圆眼、黑鼻、红色项圈，保持自然四足犬类身份，不穿衣服。角色不说话，不生成口播字幕；不得呈现打狗或受伤画面，只通过误解、后退、压低耳朵等安全表演表达关系受伤。";
const expectedDogPattern = new RegExp(
  (fixture.expectedDogTerms?.length ? fixture.expectedDogTerms : ["成年金毛", "金毛犬", "adult Golden Retriever", "Golden Retriever"])
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "iu",
);
const expectedPanelCounts = fixture.expectedPanelCounts?.length ? fixture.expectedPanelCounts : [4, 5];

assert.ok(evaluationSegments.length > 0, "测试夹具至少需要一个完整口播分段");
assert.ok([8, 10, 15].includes(targetDurationSeconds), "测试夹具时长仅支持8、10或15秒");

const submittedMessage = [
  "segmented_script:",
  ...evaluationSegments.map((segment, index) => `${index + 1}.【${segment}】`),
  `animation_style: ${animationStyle}`,
  `aspect_ratio: ${aspectRatio}`,
  `target_duration_seconds: ${targetDurationSeconds}`,
  `special_notes: ${specialNotes}`,
].join("\n");

interface AgentCard {
  id: string;
  name: string;
  model: string;
  preset_fields?: Array<{ id?: string; options?: string[] }>;
}

function extractAssistantContent(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return String(message?.content || first?.text || payload.content || "");
}

function modeForAgent(name: string): "high_energy" | "cinematic" | "lyrical" {
  if (name.includes("高能夸张")) return "high_energy";
  if (name.includes("电影叙事")) return "cinematic";
  return "lyrical";
}

function unwrapNarration(value: string): string {
  return value.trim().replace(/^\d+\s*[.、]\s*【/, "").replace(/】$/, "").trim();
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

async function main() {
  await mkdir(".tmp-e2e", { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string; user?: { id?: string } };
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");

  const botsResponse = await fetch(`${baseUrl}/api/bots?storyboard_v62_test=${Date.now()}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const botsPayload = await botsResponse.json() as { bots?: AgentCard[]; error?: string };
  assert.ok(botsResponse.ok, botsPayload.error || "主站智能体列表读取失败");

  const results: Array<Record<string, unknown>> = [];
  assert.ok(selectedAgentNames.length > 0, `没有匹配到指定智能体：${onlyAgentName || ""}`);
  for (const agentName of selectedAgentNames) {
    const agent = botsPayload.bots?.find((item) => item.name === agentName);
    assert.ok(agent, `主站没有找到智能体：${agentName}`);
    const fieldIds = new Set((agent.preset_fields || []).map((field) => field.id));
    for (const id of ["segmented_script", "animation_style", "aspect_ratio", "target_duration_seconds", "special_notes"]) {
      assert.ok(fieldIds.has(id), `${agentName}缺少稳定接收字段：${id}`);
    }

    const startedAt = Date.now();
    const rawPath = `.tmp-e2e/storyboard-agent-suite-${suiteVersion}-${modeForAgent(agentName)}-raw.md`;
    let content = "";
    if (process.env.REUSE_RAW === "1") {
      content = await readFile(rawPath, "utf8").catch(() => "");
    }
    if (!content) {
      const response: Response = await fetch(`${baseUrl}/api/llm`, {
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
          maxContextRounds: 1,
          maxContextTokens: 0,
          maxReplyTokens: 12000,
          timeout: 300,
          enableWebSearch: false,
          responseFormat: "markdown",
        }),
        signal: AbortSignal.timeout(360_000),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        assert.fail(String(payload.error || `${agentName}请求失败（${response.status}）`));
      }
      content = response.headers.get("content-type")?.includes("text/event-stream")
        ? await readStreamingContent(response)
        : extractAssistantContent(await response.json() as Record<string, unknown>);
      await writeFile(rawPath, content, "utf8");
    }
    const parsed = parseStructuredAgentOutput(content, true);
    assert.equal(parsed.status, "valid", `${agentName}没有产出可解析的稳定协议：${parsed.status === "valid" ? "" : parsed.errors.join("；")}`);
    assert.equal(parsed.kind, "storyboard_director", `${agentName}输出的不是故事版导演产物`);
    assert.equal(parsed.source, "stable_json", `${agentName}仍在依赖旧双代码框兼容解析`);
    assert.equal(parsed.segments.length, evaluationSegments.length, `${agentName}输出段落数不一致`);

    const mode = modeForAgent(agentName);
    const expectedShots = fixture.expectedShotCounts?.length
      ? fixture.expectedShotCounts
      : mode === "high_energy" ? [3, 4] : mode === "cinematic" ? [2, 3] : [1, 2];
    for (const [index, segment] of parsed.segments.entries()) {
      assert.equal(unwrapNarration(segment.narration), evaluationSegments[index], `${agentName}改写了第${index + 1}段口播`);
      assert.equal(segment.target_duration_seconds, targetDurationSeconds, `${agentName}没有按${targetDurationSeconds}秒规划`);
      assert.ok(expectedPanelCounts.includes(segment.panel_count), `${agentName}故事板格数不符合测试预期`);
      assert.ok(expectedShots.includes(segment.actual_shot_count), `${agentName}实际镜头数不符合导演模式`);
      assert.equal(segment.shot_time_ranges.at(-1)?.end_seconds, targetDurationSeconds, `${agentName}时间轴没有覆盖${targetDurationSeconds}秒`);
      assert.match(segment.image_prompt, expectedDogPattern, `${agentName}没有锁定具体犬种`);
      assert.match(segment.image_prompt, /27岁中国女性|中国女性|27-year-old Chinese woman|adult Chinese woman/iu, `${agentName}没有锁定具体人物`);
      assert.doesNotMatch(segment.image_prompt, /同一只狗|同一个人/u, `${agentName}仍使用模糊资产指代`);
      assert.match(segment.video_prompt, /(镜头|秒|推进|跟拍|推近|环绕|横移|固定机位|shot|seconds?|push-in|tracking|pan|orbit|locked camera)/iu, `${agentName}视频提示词缺少可执行镜头语言`);
      assert.doesNotMatch(
        segment.video_prompt,
        /(人物开口说出|人物开始说话|狗狗开口说出|狗狗开始说话|同步对白口型|speaks? dialogue|talking mouth animation)/iu,
        `${agentName}违反无口型要求`,
      );
    }

    const selectedSegment = parsed.segments[0];
    assert.ok(selectedSegment.video_prompt.length <= 2000, `${agentName}代表段视频Prompt超过MiniMax H3的2000字限制`);
    const result = {
      id: agent.id,
      name: agent.name,
      mode,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      content,
      parseSource: parsed.source,
      schemaVersion: parsed.schema_version,
      segmentCount: parsed.segments.length,
      segments: parsed.segments,
      selectedSegmentId: selectedSegment.segment_id,
      selectedNarration: selectedSegment.narration,
      imagePrompt: selectedSegment.image_prompt,
      videoPrompt: selectedSegment.video_prompt,
      imagePromptLength: selectedSegment.image_prompt.length,
      videoPromptLength: selectedSegment.video_prompt.length,
      panelCount: selectedSegment.panel_count,
      layout: selectedSegment.layout,
      actualShotCount: selectedSegment.actual_shot_count,
    };
    results.push(result);
    await writeFile(partialPath, JSON.stringify({ fullSourceCopy, submittedMessage, agents: results }, null, 2), "utf8");
  }

  if (results.length === 3) {
    assert.equal(new Set(results.map((item) => item.imagePrompt)).size, 3, "三导演生图Prompt完全相同，没有策略差异");
    assert.equal(new Set(results.map((item) => item.videoPrompt)).size, 3, "三导演视频Prompt完全相同，没有策略差异");
  }

  const report = {
    passed: true,
    testedAt: new Date().toISOString(),
    fullSourceCopy,
    evaluationScope: "从用户完整口播中抽取第一个行为的首个10秒段落；三种导演模式均使用同一句输入完成一图一视频横评。",
    submittedMessage,
    agents: results,
  };
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    passed: true,
    outputPath,
    agents: results.map((item) => ({
      name: item.name,
      elapsedSeconds: item.elapsedSeconds,
      segmentCount: item.segmentCount,
      panelCount: item.panelCount,
      actualShotCount: item.actualShotCount,
      imagePromptLength: item.imagePromptLength,
      videoPromptLength: item.videoPromptLength,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
