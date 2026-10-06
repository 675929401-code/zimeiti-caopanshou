import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NEW_AGENT_MODEL_ROUTES } from "./new-agent-model-routing-v1";

const baseUrl = process.env.BASE_URL || process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000";

type Agent = { id: string; name: string; model?: string; model_id?: string };

const cases = [
  {
    id: "claude-copy",
    agentName: "场景共鸣文案师",
    expectedModel: "claude-sonnet-4-6",
    message: `你的领域和身份：成都通勤女装店主。\n主题/原始素材：顾客早上站在衣柜前反复换衣服，不是没有衣服，而是不知道坐地铁、办公室空调和临时见客户这三个场景怎么兼顾。店里会先问通勤方式和当天安排，再建议衬衫、针织开衫或外套。不得编造顾客反馈。\n想写给谁看：25到35岁通勤女性。\n创作方式：A 直接写成品`,
    requiredTerms: ["地铁", "空调", "客户"],
  },
  {
    id: "gpt-analysis",
    agentName: "营销方案对比助手",
    expectedModel: "gpt-5.6-terra",
    message: `想优化什么：宠物店抖音视频带来的私信咨询率。\n当前版本与表现：当前开头是“狗狗掉毛怎么办”，过去7条平均播放约3000，平均私信2条；数据为店主手工记录，暂未区分新老客。\n可测试素材/方案：A版开头讲“掉毛不等于缺营养”，B版开头讲“梳毛越勤，为什么家里反而还是有毛”。\n流量与测试周期：每周发4条，可测试两周。\n必须保持不变：同一账号、同一出镜人、发布时间相近、结尾都引导私信发犬种和年龄。`,
    requiredTerms: ["A版", "B版", "变量"],
  },
] as const;

async function callAgent(token: string, userId: string | undefined, agent: Agent, message: string) {
  const clientRequestId = `llm_${crypto.randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/llm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      "Idempotency-Key": clientRequestId,
    },
    body: JSON.stringify({
      client_request_id: clientRequestId,
      messages: [{ role: "user", content: message }],
      agentId: agent.id,
      agentName: agent.name,
      stream: false,
      userId,
      conversationId: `conv_model_route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      enableWebSearch: false,
      responseFormat: "markdown",
      timeout: 180,
    }),
    signal: AbortSignal.timeout(210_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  const output = String(payload.choices?.[0]?.message?.content || "").trim();
  return { status: response.status, ok: response.ok, error: payload.error || "", output };
}

async function localSession(): Promise<{ token: string; user?: { id?: string } }> {
  const injectedToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  if (injectedToken) {
    const identityResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${injectedToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const identity = await identityResponse.json() as { user?: { id?: string; role?: string }; error?: string };
    assert.ok(identityResponse.ok && identity.user?.role === "admin", identity.error || "verified local admin session unavailable");
    return { token: injectedToken, user: identity.user };
  }

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string; user?: { id?: string } };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");
  return { token: session.token, user: session.user };
}

export async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outDir = path.join("research-output", `new-agent-model-routing-v1-live-${stamp}`);
  await mkdir(outDir, { recursive: true });

  const session = await localSession();
  const agentsResponse = await fetch(`${baseUrl}/api/admin/agents`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const agentsPayload = await agentsResponse.json() as { agents?: Agent[]; error?: string };
  assert.ok(agentsResponse.ok && agentsPayload.agents, agentsPayload.error || "agent list unavailable");
  const agents: Agent[] = agentsPayload.agents;

  const requestedCase = process.argv.find((argument) => argument.startsWith("--case="))?.slice("--case=".length) || "";
  const selectedCases = requestedCase ? cases.filter((testCase) => testCase.id === requestedCase) : cases;
  assert.ok(selectedCases.length > 0, `unknown test case: ${requestedCase}`);
  const results = [];
  for (const testCase of selectedCases) {
    const agent: Agent | undefined = agents.find((item: Agent) => item.name === testCase.agentName);
    assert.ok(agent, `${testCase.agentName} not found`);
    const route = NEW_AGENT_MODEL_ROUTES[testCase.agentName];
    assert.ok(route, `${testCase.agentName} has no declared route`);
    assert.equal(agent.model, testCase.expectedModel, `${testCase.agentName} is bound to the wrong model`);
    assert.equal(agent.model_id, route.modelId, `${testCase.agentName} model id mismatch`);

    const response = await callAgent(session.token, session.user?.id, agent, testCase.message);
    const requiredHits = testCase.requiredTerms.filter((term) => response.output.includes(term));
    const qualityPassed = response.ok
      && response.output.length >= 180
      && requiredHits.length === testCase.requiredTerms.length
      && !/(作为AI|系统提示词|内部推理)/.test(response.output);
    const result = {
      id: testCase.id,
      agentName: testCase.agentName,
      configuredModel: agent.model,
      configuredModelId: agent.model_id,
      noFallback: true,
      status: response.status,
      upstreamOk: response.ok,
      upstreamError: response.error,
      outputChars: response.output.length,
      requiredHits,
      qualityPassed,
    };
    results.push(result);
    await writeFile(path.join(outDir, `${testCase.id}.md`), response.output || `ERROR ${response.status}: ${response.error}\n`, "utf8");
    console.log(JSON.stringify(result));
  }

  const report = {
    created_at: new Date().toISOString(),
    no_fallback_policy: true,
    route_binding_passed: results.every((item) => item.configuredModel && item.configuredModelId),
    live_passed: results.every((item) => item.qualityPassed),
    results,
  };
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outDir, ...report }, null, 2));
  if (!report.live_passed) process.exitCode = 2;
}

if (process.argv[1]?.replace(/\\/gu, "/").endsWith("/test-new-agent-model-routing-v1.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
