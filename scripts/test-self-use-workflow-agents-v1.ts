import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const runId = new Date().toISOString().replace(/[:.]/g, "");
const outDir = path.join("research-output", `self-use-workflow-agents-v1-${runId}`);
const requestedCaseIds = new Set(
  (process.env.TEST_CASE_IDS || "").split(",").map((value) => value.trim()).filter(Boolean),
);

type Agent = { id: string; name: string; category?: string };
type ChatMessage = { role: "user" | "assistant"; content: string };
type Evaluation = {
  score: number;
  passed: boolean;
  checks: Record<string, boolean>;
  chars: number;
};

const cases = [
  {
    id: "website-promotion",
    agentName: "网站功能推广师",
    message: `网站/功能事实：本地自媒体工作台，应用广场里有写文案、做分镜、生图和视频提示词的智能体；用户点开智能体卡片，填写少量必要信息后进入聊天，可继续追问和修改。当前仅在本地使用，不承诺一键爆款，也没有公开用户增长数据。\n想推广给谁：自己做抖音内容、经常在多个工具间复制粘贴的创作者。\n可用证明：可以现场录屏展示应用广场、接收卡片和聊天记录。\n本次要写什么：B 单个功能推广`,
    required: ["一句话卖点", "可直接发布", "备用开头", "画面", "不能乱说", "下一步"],
    specific: ["应用广场", "智能体", "录屏", "聊天"],
    forbidden: [/保证.{0,8}爆款/, /用户增长\d+/, /全网第一/],
  },
  {
    id: "agent-naming",
    agentName: "智能体命名包装师",
    message: `智能体功能/提示词：用户粘贴一篇其他赛道的爆款文案，智能体先拆解钩子、结构、情绪和节奏，再让用户从A/B/C/D中选择改写方式，最后迁移到用户自己的赛道，保持原文大致字数但不能照抄句子。\n现在的名称：豹纹重组师\n命名任务：A 给我多组候选`,
    required: ["功能定位", "候选名称", "最推荐", "卡片描述", "命名规则"],
    specific: ["豹纹重组师", "跨赛道", "A", "版本"],
    forbidden: [/豹纹口波斯/, /保证.{0,8}爆款/],
  },
  {
    id: "course-rebuild",
    agentName: "课程架构优化师",
    message: `课程主题/现有内容：给零基础学员教“用AI智能体做抖音内容”。旧大纲顺序是：第1课直接写系统提示词；第2课认识目标用户；第3课测试输出；第4课确定智能体功能；第5课做接收卡片；第6课写一句话介绍。现在的问题是学员照着做，提示词很长，但不知道智能体到底帮谁解决什么问题，也不会验收。\n学员与基础：会使用聊天工具，不会编程；学完要能做出一个可实际使用的文案智能体。\n本次任务：B 纠错并重新排序`,
    required: ["一句话诊断", "错误与调整", "课程地图", "完整课程大纲", "保留与补充", "下一步"],
    specific: ["目标用户", "智能体功能", "接收卡片", "验收"],
    forbidden: [/保证.{0,8}学会/, /必须先学编程/],
  },
] as const;

function evaluate(
  output: string,
  required: readonly string[],
  specific: readonly string[],
  forbidden: readonly RegExp[],
  minChars = 650,
): Evaluation {
  const checks = {
    completeFormat: required.every((term) => output.includes(term)),
    substantive: output.replace(/\s+/g, "").length >= minChars,
    specific: specific.filter((term) => output.includes(term)).length >= Math.min(3, specific.length),
    noUnsupportedClaims: forbidden.every((pattern) => !pattern.test(output)),
    plainLanguage: !/(赋能|抓手|形成闭环|全链路矩阵)/.test(output),
    noPromptLeak: !/(系统提示词全文|隐藏规则|内部推理|自评分|作为AI)/.test(output),
  };
  const score =
    (checks.completeFormat ? 25 : 0) +
    (checks.substantive ? 15 : 0) +
    (checks.specific ? 15 : 0) +
    (checks.noUnsupportedClaims ? 20 : 0) +
    (checks.plainLanguage ? 15 : 0) +
    (checks.noPromptLeak ? 10 : 0);
  return {
    score,
    passed: score >= 90 && checks.completeFormat && checks.noUnsupportedClaims && checks.noPromptLeak,
    checks,
    chars: output.replace(/\s+/g, "").length,
  };
}

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
  const payload = await response.json() as T & { error?: string };
  assert.ok(response.ok, payload.error || `HTTP ${response.status}`);
  return payload;
}

async function runNonStream(token: string, userId: string | undefined, agent: Agent, messages: ChatMessage[], conversationId: string) {
  const payload = await requestJson<{ choices?: Array<{ message?: { content?: string } }> }>(`${baseUrl}/api/llm`, token, {
    method: "POST",
    body: JSON.stringify({
      messages,
      agentId: agent.id,
      agentName: agent.name,
      stream: false,
      userId,
      conversationId,
      maxContextRounds: 0,
      timeout: 240,
      enableWebSearch: false,
      responseFormat: "markdown",
    }),
    signal: AbortSignal.timeout(300_000),
  });
  return String(payload.choices?.[0]?.message?.content || "").trim();
}

async function runStream(token: string, userId: string | undefined, agent: Agent, message: string, conversationId: string) {
  const response = await fetch(`${baseUrl}/api/llm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      messages: [{ role: "user", content: message }],
      agentId: agent.id,
      agentName: agent.name,
      stream: true,
      userId,
      conversationId,
      maxContextRounds: 0,
      timeout: 300,
      enableWebSearch: false,
      responseFormat: "markdown",
    }),
    signal: AbortSignal.timeout(420_000),
  });
  assert.ok(response.ok && response.body, `stream request failed: HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  const skillEvents: Array<Record<string, unknown>> = [];

  const consume = (block: string) => {
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6).trim();
    if (!data || data === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type === "skill_execution") skillEvents.push(event);
    const choices = event.choices as Array<{ delta?: { content?: string }; message?: { content?: string } }> | undefined;
    output += choices?.[0]?.delta?.content || choices?.[0]?.message?.content || "";
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    blocks.forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return { output: output.trim(), skillEvents };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string; user?: { id?: string } };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");
  const token = session.token;
  const agentsPayload = await requestJson<{ agents?: Agent[] }>(`${baseUrl}/api/admin/agents`, token);
  const agents = agentsPayload.agents || [];
  const results: Array<Record<string, unknown>> = [];

  const selectedCases = requestedCaseIds.size > 0 ? cases.filter((item) => requestedCaseIds.has(item.id)) : cases;
  for (const testCase of selectedCases) {
    const agent = agents.find((item) => item.name === testCase.agentName && item.category === "自用");
    assert.ok(agent, `${testCase.agentName} not found`);
    const conversationId = `conv_self_use_${testCase.id}_${Date.now()}`;
    const output = await runNonStream(token, session.user?.id, agent, [{ role: "user", content: testCase.message }], conversationId);
    assert.ok(output, `${testCase.id}: empty output`);
    await writeFile(path.join(outDir, `${testCase.id}.md`), `${output}\n`, "utf8");
    const evaluation = evaluate(output, testCase.required, testCase.specific, testCase.forbidden);
    results.push({ id: testCase.id, agentName: agent.name, conversationId, ...evaluation });
    console.log(JSON.stringify({ type: "case", id: testCase.id, ...evaluation }));
  }

  const shouldRunBenchmark = requestedCaseIds.size === 0 || requestedCaseIds.has("benchmark-account") || requestedCaseIds.has("benchmark-handoff");
  if (shouldRunBenchmark) {
    const benchmarkAgent = agents.find((item) => item.name === "对标账号拆解" && item.category === "商业定位IP");
    assert.ok(benchmarkAgent, "对标账号拆解 not found");
    const benchmarkMessage = `抖音主页/作品链接：https://v.douyin.com/G2Z9zO2iEEU/\n你想学来做什么：学习观点型知识文案的选题、开头和表达方式，用在自己的自媒体网站与智能体课程内容中。\n本次重点：A 完整30维拆解\n采样数量：20条`;
    const benchmarkConversationId = `conv_self_use_benchmark_${Date.now()}`;
    const benchmark = await runStream(token, session.user?.id, benchmarkAgent, benchmarkMessage, benchmarkConversationId);
    assert.ok(benchmark.output, "benchmark: empty output");
    await writeFile(path.join(outDir, "benchmark-account.md"), `${benchmark.output}\n`, "utf8");
    const completedSkill = benchmark.skillEvents.some((event) => event.status === "completed");
    const benchmarkEvaluation = evaluate(
      benchmark.output,
      ["采集结果", "一句话看懂", "30维拆解", "高表现样本", "风格DNA", "为什么可能涨粉", "下一步"],
      ["哈尼有话讲", "样本", "证据", "观察"],
      [/保证.{0,8}涨粉/, /已采集全部作品/, /完整历史数据/],
      1800,
    );
    benchmarkEvaluation.checks.skillExecuted = completedSkill;
    if (!completedSkill) {
      benchmarkEvaluation.score = Math.max(0, benchmarkEvaluation.score - 30);
      benchmarkEvaluation.passed = false;
    }
    results.push({
      id: "benchmark-account",
      agentName: benchmarkAgent.name,
      conversationId: benchmarkConversationId,
      skillEvents: benchmark.skillEvents,
      ...benchmarkEvaluation,
    });
    console.log(JSON.stringify({ type: "case", id: "benchmark-account", ...benchmarkEvaluation, skillEvents: benchmark.skillEvents }));

    const handoff = await runNonStream(
      token,
      session.user?.id,
      benchmarkAgent,
      [
        { role: "user", content: benchmarkMessage },
        { role: "assistant", content: benchmark.output },
        { role: "user", content: "C。请把刚才的拆解整理成可交给智能体工程师的风格建模交接包。" },
      ],
      `${benchmarkConversationId}_handoff`,
    );
    assert.ok(handoff, "benchmark handoff: empty output");
    await writeFile(path.join(outDir, "benchmark-handoff.md"), `${handoff}\n`, "utf8");
    const handoffEvaluation = evaluate(
      handoff,
      ["定位", "证据", "方法", "边界", "测试", "验收"],
      ["风格", "账号", "结构", "原创"],
      [/系统提示词全文/, /隐藏提示词/, /一模一样复刻/, /复制.{0,6}标志性句子/],
      900,
    );
    results.push({ id: "benchmark-handoff", agentName: benchmarkAgent.name, ...handoffEvaluation });
    console.log(JSON.stringify({ type: "case", id: "benchmark-handoff", ...handoffEvaluation }));
  }

  assert.ok(results.length > 0, "no matching TEST_CASE_IDS were found");
  const averageScore = Math.round(results.reduce((sum, item) => sum + Number(item.score || 0), 0) / results.length);
  const report = {
    passed: results.every((item) => item.passed === true),
    averageScore,
    passCount: results.filter((item) => item.passed === true).length,
    total: results.length,
    outDir,
    results,
  };
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ type: "done", ...report }, null, 2));
  if (!report.passed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
