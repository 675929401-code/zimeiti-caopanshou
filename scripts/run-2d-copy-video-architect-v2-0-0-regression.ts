import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1785658026345-k6yy99";
const expectedSchema = "text_to_video_2d_output_style.v2.0.3";
const expectedPromptSha = "6d95a5d6db50e5c1ee46c19003dbf2f0ac9c2f39c31d2e1011c48b3079240cf1";
const runId = `2d-copy-video-architect-v203-regression-${Date.now()}`;
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
    id: "health-10s-9x16",
    duration: 10,
    ratio: "9:16",
    style: "现代清透日系动画风",
    minShots: 3,
    maxShots: 4,
    source: "狗狗频繁舔爪，别只当它在清洁。先看脚垫有没有发红、开裂或鼓起，再看走路时是否刻意避开那只脚。",
    note: "同一只三色长毛柯基与女主人；只观察外观，不做疾病诊断。",
  },
  {
    id: "relationship-15s-16x9",
    duration: 15,
    ratio: "16:9",
    style: "温馨绘本动画风",
    minShots: 4,
    maxShots: 5,
    source: "你下班回家时，狗狗没有立刻扑上来，不一定是在生气。它可能先站在远处看你，等确认你的声音和动作安全，才叼起玩具慢慢靠近。",
    note: "同一只金毛与男主人；表演克制，不拥抱、不强行接触。",
  },
  {
    id: "instinct-8s-9x16",
    duration: 8,
    ratio: "9:16",
    style: "美式复古橡皮管卡通风",
    minShots: 2,
    maxShots: 3,
    source: "猫咪一看见纸箱就往里钻，不只是贪玩。狭窄空间能挡住多个方向，让它更容易观察周围。",
    note: "同一只橘白短毛猫；动作轻快但保持自然猫科结构。",
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

function buildMessage(testCase: typeof cases[number]) {
  return [
    `分段文案：1.【${testCase.source}】`,
    `单段视频时长：${testCase.duration}秒`,
    `视频比例：${testCase.ratio} ${testCase.ratio === "9:16" ? "竖屏" : "横屏"}`,
    `视频风格：${testCase.style}`,
    `特殊备注：${testCase.note}`,
  ].join("\n");
}

function parseOutput(raw: string, testCase: typeof cases[number]) {
  assert.match(raw, /^## 接收信息/mu, `${testCase.id}缺少接收信息`);
  assert.match(raw, /^## 全局视觉资产锁定/mu, `${testCase.id}缺少全局资产`);
  assert.match(raw, /^## 内容产出/mu, `${testCase.id}缺少内容产出`);
  assert.match(raw, /本段语义任务：/u, `${testCase.id}缺少语义任务`);
  assert.ok(raw.includes(`文案：【${testCase.source}】`), `${testCase.id}原文未逐字保留`);
  const blocks = [...raw.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)].map((item) => item[1].trim());
  assert.equal(blocks.length, 1, `${testCase.id}不是一段一个text代码框`);
  const prompt = blocks[0];
  const firstLine = prompt.split(/\r?\n/u)[0];
  assert.match(firstLine, /纯2D动画/u, `${testCase.id}首行缺少2D媒介`);
  assert.ok(firstLine.includes(testCase.style), `${testCase.id}首行缺少实际风格`);
  assert.ok(firstLine.includes(`${testCase.duration}秒`), `${testCase.id}首行缺少时长`);
  assert.ok(firstLine.includes(testCase.ratio), `${testCase.id}首行缺少比例`);
  assert.match(firstLine, /(?:实际镜头数：[2-6]|[2-6](?:个实际镜头|个镜头|镜))/u, `${testCase.id}首行缺少镜头数`);
  assert.match(firstLine, /后期旁白/u, `${testCase.id}首行缺少后期配音`);
  const timeHeadings = [...prompt.matchAll(/【\s*\d+(?:\.\d+)?\s*[-—–至]\s*\d+(?:\.\d+)?\s*秒\s*[｜|]/gu)];
  const shotCount = timeHeadings.length;
  assert.ok(shotCount >= testCase.minShots && shotCount <= testCase.maxShots, `${testCase.id}镜头数${shotCount}不在${testCase.minShots}-${testCase.maxShots}`);
  assert.match(prompt, /拟音|环境声|底噪|声/u, `${testCase.id}缺少声音设计`);
  assert.match(prompt, /收尾|停留|稳定|终态/u, `${testCase.id}缺少结尾状态`);
  assert.doesNotMatch(prompt, /(?:采用|混合|结合|呈现为)[^\n]{0,20}(?:3D渲染|真人实拍|照片感)/u, `${testCase.id}混入非2D媒介`);
  if (testCase.id === "health-10s-9x16") {
    assert.match(prompt, /未定|不确认/u, `${testCase.id}未保留检查项的未定性`);
    assert.doesNotMatch(prompt, /可见[^\n]{0,40}发红[^\n]{0,40}开裂[^\n]{0,40}鼓起/u, `${testCase.id}把三项检查误写成已发生事实`);
  }
  if (testCase.id === "relationship-15s-16x9") {
    assert.match(prompt, /后期[^\n]{0,20}追加[^\n]{0,80}(?:呼唤|主人声音)|(?:呼唤|主人声音)[^\n]{0,80}后期[^\n]{0,20}追加/u, `${testCase.id}缺少原文必需的后期声音证据`);
  }
  return { shotCount, promptLength: prompt.length };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; user?: { id?: string }; error?: string };
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");
  const agentsResponse = await fetch(`${baseUrl}/api/admin/agents`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
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
  const testModel = process.env.TEST_MODEL || agent.model;
  const modelOverridden = Boolean(process.env.TEST_MODEL);
  const results = [];
  for (const testCase of selectedCases) {
    const conversationId = `conv_2d_${testCase.id}_${Date.now()}`;
    const response = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: buildMessage(testCase) }],
        model: testModel,
        model_overridden: modelOverridden,
        stream: true,
        userId: session.user.id,
        agentName: agent.name,
        agentId,
        conversationId,
        maxContextRounds: 0,
        maxReplyTokens: 16_000,
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
    results.push({ id: testCase.id, conversationId, model: testModel, modelOverridden, ...parseOutput(raw, testCase) });
  }

  const report = { passed: true, runId, agentId, schema: expectedSchema, promptSha256: expectedPromptSha, results };
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
