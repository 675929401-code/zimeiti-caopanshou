import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1785688061259-4xww99";
const expectedSchema = "text_to_video_3d_output_style.v3.0.1";
const expectedPromptSha = "cd96cde88ac29194afc1a5da2dd36ded040b1c4340e9dbfa47805744fca6b803";
const runId = `3d-copy-video-architect-v3-regression-${Date.now()}`;
const outDir = path.resolve(".tmp-e2e", runId);

type AgentRecord = { id: string; name: string; model: string; system_prompt: string; output_style?: Record<string, unknown> };
type TestCase = {
  id: string; source: string; duration: number; ratio?: string; expectedRatio: string; style: string;
  language: "zh" | "en"; note: string; minShots: number; maxShots: number;
};

const cases: TestCase[] = [
  {
    id: "pet-instinct-10s-9x16",
    source: "猫咪一看见纸箱就往里钻，不只是贪玩。狭窄空间能挡住多个方向，让它更容易观察周围。",
    duration: 10, ratio: "9:16 竖屏", expectedRatio: "9:16", style: "可信宠物卡通3D动画风格", language: "zh",
    note: "同一只橘白短毛猫，趣味自然，不拟人化。", minShots: 3, maxShots: 4,
  },
  {
    id: "relationship-15s-16x9-en",
    source: "你下班回家时，狗狗没有立刻扑上来，不一定是在生气。它可能先站在远处看你，等确认你的声音和动作安全，才叼起玩具慢慢靠近。",
    duration: 15, ratio: "16:9 横屏", expectedRatio: "16:9", style: "暖色治愈3D动画风格", language: "en",
    note: "同一只金毛和男主人；表演克制，不拥抱；声音由后期追加。", minShots: 4, maxShots: 5,
  },
  {
    id: "health-check-8s-default-ratio",
    source: "狗狗频繁舔爪，别只当它在清洁。先看脚垫有没有发红、开裂或鼓起，再看走路时是否刻意避开那只脚。",
    duration: 8, expectedRatio: "16:9", style: "干净科普3D动画风格", language: "zh",
    note: "同一只三色长毛柯基；只观察，不做疾病诊断。", minShots: 2, maxShots: 3,
  },
];

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
      if (event.event === "done" || raw === "[DONE]") { doneEvent = true; continue; }
      const data = JSON.parse(raw) as { error?: string; choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> };
      if (data.error) throw new Error(data.error);
      content += data.choices?.[0]?.delta?.content || data.choices?.[0]?.message?.content || "";
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

function buildMessage(testCase: TestCase) {
  return [
    `分段文案：1.【${testCase.source}】`,
    `单段视频时长：${testCase.duration}秒`,
    ...(testCase.ratio ? [`视频比例：${testCase.ratio}`] : []),
    `视频风格：${testCase.style}`,
    `提示词输出选项：${testCase.language === "en" ? "英文提示词输出" : "中文提示词输出"}`,
    `特殊备注：${testCase.note}`,
  ].join("\n");
}

function parseOutput(raw: string, testCase: TestCase) {
  assert.ok(raw.startsWith("# 全局资产设定"), `${testCase.id}未从固定标题开始`);
  for (const title of ["## 1. 输入识别", "## 2. 全片统一人物", "## 3. 全片统一宠物/产品", "## 4. 全片统一环境", "## 5. 动画风格"]) {
    assert.ok(raw.includes(title), `${testCase.id}缺少${title}`);
  }
  assert.ok(raw.includes(`段落1＋【${testCase.source}】`), `${testCase.id}原文未保留`);
  const blocks = [...raw.matchAll(/```text\s*\r?\n([\s\S]*?)```/giu)].map((match) => match[1].trim());
  assert.equal(blocks.length, 1, `${testCase.id}不是一段一个text代码框`);
  const prompt = blocks[0];
  const firstLine = prompt.split(/\r?\n/u)[0];
  assert.ok(firstLine.includes(testCase.style), `${testCase.id}风格名未原样保留`);
  assert.ok(firstLine.includes(`${testCase.duration}秒`) || firstLine.toLowerCase().includes(`${testCase.duration} seconds`), `${testCase.id}缺少真实时长`);
  assert.ok(firstLine.includes(testCase.expectedRatio), `${testCase.id}比例错误`);
  assert.match(firstLine, /[2-6](?:镜|个镜头|个实际镜头|\s+shots?)|实际镜头数：[2-6]/iu, `${testCase.id}首行缺少镜头数`);
  const shotCount = [...prompt.matchAll(/(?:^|\n)\s*\d+(?:\.\d+)?\s*[-—–至]\s*\d+(?:\.\d+)?\s*(?:秒|seconds?)：?/gimu)].length;
  assert.ok(shotCount >= testCase.minShots && shotCount <= testCase.maxShots, `${testCase.id}镜头数${shotCount}不在${testCase.minShots}-${testCase.maxShots}`);
  assert.match(prompt, /后期旁白|post-production narration|voice-over|voiceover/iu, `${testCase.id}缺少后期旁白`);
  assert.match(prompt, /稳定|停留|settles|holds|stable/iu, `${testCase.id}缺少稳定收尾`);
  assert.doesNotMatch(raw, /Runway|Pika/iu, `${testCase.id}臆造未指定平台`);
  if (testCase.language === "en") {
    assert.ok(prompt.endsWith("Characters must not speak."), `${testCase.id}英文末行禁语不合同`);
    assert.match(prompt, /post-production[^\n]{0,80}(?:call|voice|greeting)|(?:call|voice|greeting)[^\n]{0,80}(?:post-production|post-added|added in post)/iu, `${testCase.id}缺少后期声音证据`);
  } else {
    assert.ok(prompt.endsWith("禁止人物说话。"), `${testCase.id}中文末行禁语不合同`);
  }
  if (testCase.id.includes("health")) {
    assert.match(prompt, /未定|不确认|不呈现[^\n]{0,30}已确认|不判定[^\n]{0,30}正常|不将[^\n]{0,30}当作既定/u, `${testCase.id}未保留检查结果未定性`);
  }
  return { shotCount, promptLength: prompt.length };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
  const session = await sessionResponse.json() as { token?: string; user?: { id?: string }; error?: string };
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "本地测试会话不可用");
  const agentsResponse = await fetch(`${baseUrl}/api/admin/agents`, { headers: { Authorization: `Bearer ${session.token}` } });
  const agentsPayload = await agentsResponse.json() as { agents?: AgentRecord[] };
  const agent = agentsPayload.agents?.find((item) => item.id === agentId);
  assert.ok(agent, "目标智能体不存在");
  assert.equal(agent.output_style?.schema_version, expectedSchema);
  assert.equal(sha256(agent.system_prompt), expectedPromptSha);

  const selectedCases = process.env.TEST_CASE_ID ? cases.filter((item) => item.id === process.env.TEST_CASE_ID) : cases;
  assert.ok(selectedCases.length, `未找到测试用例：${process.env.TEST_CASE_ID}`);
  const results = [];
  for (const testCase of selectedCases) {
    const conversationId = `conv_3d_arch_${testCase.id}_${Date.now()}`;
    const response = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: buildMessage(testCase) }], model: agent.model, stream: true,
        userId: session.user.id, agentName: agent.name, agentId, conversationId, maxContextRounds: 0,
        maxReplyTokens: 12_000, timeout: 120, enableWebSearch: false, responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(180_000),
    });
    assert.ok(response.ok, `${testCase.id}平台调用失败（${response.status}）`);
    const raw = await readStream(response);
    await writeFile(path.join(outDir, `${testCase.id}.md`), raw, "utf8");
    results.push({ id: testCase.id, conversationId, ...parseOutput(raw, testCase) });
  }
  const report = { passed: true, runId, agentId, schema: expectedSchema, promptSha256: expectedPromptSha, results };
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
