const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const models = ["gpt-5.4", "gpt-5.6-sol", "deepseek-v4-flash"];

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  if (!sessionResponse.ok || !session.token) {
    throw new Error(session.error || "本地开发会话不可用");
  }

  const results: Array<Record<string, unknown>> = [];
  for (const model of models) {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}/api/llm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${session.token}`,
        },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          messages: [{ role: "user", content: "只返回JSON：{\"ok\":true}" }],
          agentId: "__canvas_storyboard_compiler__",
          agentName: "画布分镜编译器",
          internal_workflow: "canvas-compiler",
          model,
          model_overridden: true,
          stream: false,
          system_prompt: "你是接口健康检查器，只返回JSON。",
          response_format: "json_object",
          deep_thinking_type: 0,
          deep_thinking_overridden: true,
          temperature: 0,
          max_reply_tokens: 80,
          timeout: 20,
        }),
      });
      const text = await response.text();
      results.push({
        model,
        ok: response.ok,
        status: response.status,
        durationMs: Date.now() - startedAt,
        response: text.slice(0, 500),
      });
    } catch (error) {
      results.push({
        model,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error
          ? { name: error.name, message: error.message, cause: String(error.cause || "") }
          : String(error),
      });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
