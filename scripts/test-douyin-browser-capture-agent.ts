import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const outDir = path.join("research-output", `douyin-browser-capture-agent-${new Date().toISOString().replace(/[:.]/g, "")}`);

type Agent = { id: string; name: string; category?: string };

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; user?: { id?: string }; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");
  const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json; charset=utf-8" };
  const agentsResponse = await fetch(`${baseUrl}/api/admin/agents`, { headers });
  const agentsPayload = await agentsResponse.json() as { agents?: Agent[]; error?: string };
  assert.ok(agentsResponse.ok, agentsPayload.error || `HTTP ${agentsResponse.status}`);
  const agent = agentsPayload.agents?.find((item) => item.name === "对标账号拆解" && item.category === "商业定位IP");
  assert.ok(agent, "对标账号拆解 not found");

  const posts = Array.from({ length: 10 }, (_, index) => ({
    aweme_id: String(900000 + index),
    url: `https://www.douyin.com/video/${900000 + index}`,
    description: index % 2 === 0
      ? `门店经营观察${index + 1}：顾客犹豫时，先回答他最担心的问题，再谈产品。`
      : `账号拆解样本${index + 1}：用真实现场开头，中段解释原因，结尾给一个具体动作。`,
    statistics: {
      likes: 12000 + index * 1700,
      comments: 120 + index * 15,
      collects: 700 + index * 90,
      shares: 180 + index * 25,
      plays: null,
    },
  }));
  const capturePackage = `DY_CAPTURE_V1\n${JSON.stringify({
    schema: "douyin_public_capture_v1",
    source: "user_browser_visible_page",
    captured_at: new Date().toISOString(),
    page_url: "https://www.douyin.com/user/test-benchmark-account",
    page_title: "门店经营测试账号",
    visible_page_text: "门店经营测试账号，分享真实门店获客和顾客决策问题。",
    loaded_post_count: posts.length,
    profile: {
      nickname: "门店经营测试账号",
      douyin_id: "store_test_001",
      signature: "只讲真实门店场景和顾客决策",
      follower_count: 86000,
      aweme_count: 126,
    },
    posts,
  })}`;
  const message = `抖音链接/浏览器采集包：${capturePackage}\n你想学来做什么：学习真实场景、顾客问题和证据表达，用在实体门店账号。\n本次重点：A 完整30维拆解\n采样数量：10条`;
  const response = await fetch(`${baseUrl}/api/llm`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: [{ role: "user", content: message }],
      agentId: agent.id,
      agentName: agent.name,
      stream: true,
      userId: session.user?.id,
      conversationId: `conv_douyin_capture_${Date.now()}`,
      maxContextRounds: 0,
      timeout: 300,
      enableWebSearch: false,
      responseFormat: "markdown",
    }),
    signal: AbortSignal.timeout(420_000),
  });
  assert.ok(response.ok && response.body, `LLM stream failed: HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  const skillEvents: Array<Record<string, unknown>> = [];
  const consume = (block: string) => {
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6).trim();
    if (!data || data === "[DONE]") return;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      if (event.type === "skill_execution") skillEvents.push(event);
      const choices = event.choices as Array<{ delta?: { content?: string }; message?: { content?: string } }> | undefined;
      output += choices?.[0]?.delta?.content || choices?.[0]?.message?.content || "";
    } catch { /* Ignore non-JSON SSE keepalive blocks. */ }
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

  const completedSkill = skillEvents.some((event) => event.status === "completed");
  const checks = {
    skillExecuted: completedSkill,
    usedBrowserCapture: output.includes("浏览器") || output.includes("采集包"),
    sampleCountVisible: output.includes("10"),
    completeFramework: output.includes("30维拆解") && output.includes("风格DNA") && output.includes("下一步"),
    evidenceLanguage: output.includes("证据") && output.includes("未取得"),
    noFalseCompleteness: !/已完整查看|全部历史作品/.test(output),
  };
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify({ checks, skillEvents, output: output.slice(0, 800) }, null, 2));
  await writeFile(path.join(outDir, "output.md"), `${output}\n`, "utf8");
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify({ passed: true, checks, skillEvents }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ passed: true, checks, outDir }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
