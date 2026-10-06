import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const expectedSchema = "storyboard_director_output_style.v4.3.1";
const expectedPromptSha = "5c819ab803e976acce6e8bd1941557ccfcb6392cb495efcecad4fa7a1269a4f9";
const runId = `voiceover-cinematic-v431-prompt-regression-${Date.now()}`;
const outDir = path.resolve(".tmp-e2e", runId);

type AgentRecord = {
  id: string;
  name: string;
  model: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
};

const cases = [
  {
    id: "omni-10s-16x9",
    duration: 10,
    ratio: "16:9",
    minShots: 3,
    maxShots: 4,
    message: [
      "segmented_script：1.【狗狗睡觉时突然蹬腿，不一定是在做噩梦，也可能只是进入了深睡阶段。别急着把它摇醒，先看呼吸是否平稳。】",
      "animation_style：温暖家庭3D动画电影",
      "aspect_ratio：16:9",
      "target_duration_seconds：10",
      "special_notes：目标模型Omni；同一只三色长毛柯基与女主人；无画内文字。",
    ].join("\n"),
  },
  {
    id: "minimax-h3-15s-9x16",
    duration: 15,
    ratio: "9:16",
    minShots: 4,
    maxShots: 5,
    message: [
      "segmented_script：1.【门铃一响，狗狗就冲到玄关狂叫。主人别急着吼它，先挡住门口，等它回头看你，再用零食引导它回到垫子上。它安静下来后，才去处理门外的事。】",
      "animation_style：欧美反差3D动画喜剧（梦工厂式）",
      "aspect_ratio：9:16",
      "target_duration_seconds：15",
      "special_notes：目标模型MiniMax H3；同一只三色长毛柯基与女主人；入户门全段关闭；无画内文字。",
    ].join("\n"),
  },
  {
    id: "xai-10s-9x16",
    duration: 10,
    ratio: "9:16",
    minShots: 3,
    maxShots: 4,
    message: [
      "segmented_script：1.【狗狗频繁舔爪，别只当它在清洁。先看脚垫有没有发红、开裂或鼓起，再看走路时是否刻意避开那只脚。】",
      "animation_style：手工黏土定格质感3D动画",
      "aspect_ratio：9:16",
      "target_duration_seconds：10",
      "special_notes：目标模型xAI；同一只三色长毛柯基与女主人；不做疾病诊断；无画内文字。",
    ].join("\n"),
  },
] as const;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

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

function parseOutput(raw: string, testCase: typeof cases[number]) {
  const blocks = [...raw.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)].map((item) => item[1].trim());
  assert.equal(blocks.length, 2, `${testCase.id}不是两个text代码框`);
  const panelMatch = raw.match(/故事板分镜图文生图 Prompt（共([45])格）/u);
  assert.ok(panelMatch, `${testCase.id}未输出实际4或5格标题`);
  const [imagePrompt, videoPrompt] = blocks;
  const timeHeadings = [...videoPrompt.matchAll(/【\s*\d+(?:\.\d+)?\s*[-—–至]\s*\d+(?:\.\d+)?\s*秒\s*[｜|]/gu)];
  const shotLabels = [...new Set([...videoPrompt.matchAll(/镜(?:头)?\s*([1-5])/gu)].map((item) => Number(item[1])))];
  const shotCount = shotLabels.length || timeHeadings.length;
  assert.ok(shotCount >= testCase.minShots && shotCount <= testCase.maxShots, `${testCase.id}镜头数${shotCount}不在${testCase.minShots}-${testCase.maxShots}`);
  assert.ok(imagePrompt.includes(testCase.ratio), `${testCase.id}生图Prompt缺少${testCase.ratio}`);
  assert.ok(videoPrompt.includes(testCase.ratio), `${testCase.id}视频Prompt缺少${testCase.ratio}`);
  const firstLine = videoPrompt.split(/\r?\n/u)[0];
  assert.match(firstLine, /目标模型路由/u, `${testCase.id}首行缺少模型路由`);
  assert.ok(firstLine.includes(testCase.ratio), `${testCase.id}首行缺少比例`);
  assert.ok(firstLine.includes(`${testCase.duration}秒`), `${testCase.id}首行缺少时长`);
  assert.match(firstLine, /实际镜头数：[3-5]/u, `${testCase.id}首行缺少实际镜头数`);
  assert.ok(!raw.includes("共X格"), `${testCase.id}未替换X`);
  assert.match(imagePrompt, /无字|无文字|纯净无字/u);
  assert.match(videoPrompt, /接触|受力|受压|回弹|终态|停留|状态收尾|稳定收尾/u);
  return {
    panelCount: Number(panelMatch[1]),
    shotCount,
    imagePromptLength: imagePrompt.length,
    videoPromptLength: videoPrompt.length,
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; user?: { id?: string }; error?: string };
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");
  const headers = { Authorization: `Bearer ${session.token}` };
  const agentsResponse = await fetch(`${baseUrl}/api/admin/agents`, { headers });
  const agentsPayload = await agentsResponse.json() as { agents?: AgentRecord[]; error?: string };
  assert.ok(agentsResponse.ok, agentsPayload.error || "无法读取智能体");
  const agent = agentsPayload.agents?.find((item) => item.id === agentId);
  assert.ok(agent, "目标智能体不存在");
  assert.equal(agent.output_style?.schema_version, expectedSchema);
  assert.equal(sha256(agent.system_prompt), expectedPromptSha);

  const selectedCases = process.env.TEST_CASE_ID
    ? cases.filter((testCase) => testCase.id === process.env.TEST_CASE_ID)
    : cases;
  assert.ok(selectedCases.length > 0, `未找到测试用例：${process.env.TEST_CASE_ID}`);
  const results = [];
  for (const testCase of selectedCases) {
    const conversationId = `conv_${testCase.id}_${Date.now()}`;
    const response = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: testCase.message }],
        model: agent.model,
        stream: true,
        userId: session.user.id,
        agentName: agent.name,
        agentId,
        conversationId,
        maxContextRounds: 0,
        maxReplyTokens: 24_000,
        timeout: 720,
        enableWebSearch: false,
        responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(720_000),
    });
    assert.ok(response.ok, `${testCase.id}平台调用失败（${response.status}）`);
    const raw = response.headers.get("content-type")?.includes("text/event-stream")
      ? await readStream(response)
      : String((await response.json() as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || "");
    await writeFile(path.join(outDir, `${testCase.id}.md`), raw, "utf8");
    results.push({ id: testCase.id, conversationId, ...parseOutput(raw, testCase) });
  }

  const report = {
    passed: true,
    runId,
    agentId,
    schema: expectedSchema,
    promptSha256: expectedPromptSha,
    results,
  };
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
