import { BORDER_COLLIE_HOME_SCRIPT } from "../src/lib/canvas-demo-scripts";
import { normalizeStoryboardSegments } from "../src/lib/canvas-prompt-presets";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  if (!sessionResponse.ok || !session.token) throw new Error(session.error || "本地开发会话不可用");

  const segments = normalizeStoryboardSegments(BORDER_COLLIE_HOME_SCRIPT);
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: `固定口播分段已覆盖完整原文：${JSON.stringify(segments)}` }],
      agentId: "__canvas_storyboard_compiler__",
      agentName: "画布分镜编译器",
      internal_workflow: "canvas-compiler",
      model: "deepseek-v4-flash",
      model_overridden: true,
      stream: false,
      response_format: "json_object",
      deep_thinking_type: 0,
      deep_thinking_overridden: true,
      temperature: 0.2,
      max_reply_tokens: 3600,
      timeout: 40,
      system_prompt: [
        "你是影视项目的全片语义连续性导演，只做逐段语义消解和主体、场景、道具状态规划，不写生图或视频提示词。",
        "先阅读全文，写清唯一事件主线以及核心主体和道具从开始到结束的状态变化；不得把泛称、代词或抽象句另做成无关示例。后文已经明确具体对象时，前面的泛称必须沿用该对象，不得另造遥控器、手机或其他文案没有支持的新物件。",
        "shotDirectives必须与固定口播分段等长、order逐项对应。每项只填写本段唯一可见意思、主体、核心道具当前状态和观众必须看见的因果证据。视觉变化来自机位、表演和状态推进，不来自随意换道具。",
        "保持极简：storylineBible不超过300字；semanticTask不超过30字，subject不超过20字，propState不超过45字，visualEvidence不超过50字。不要输出解释、提示词、location或continuity。",
        "只返回JSON：{\"storylineBible\":\"全片事件与道具状态主线\",\"shotDirectives\":[{\"order\":1,\"semanticTask\":\"本段唯一可见意思\",\"subject\":\"本段主体\",\"propState\":\"核心道具当前状态\",\"visualEvidence\":\"必须可见的因果证据\"}]}。",
      ].join("\n"),
    }),
  });
  const payload = await response.json() as { error?: string; choices?: Array<{ message?: { content?: string } }> };
  if (!response.ok) throw new Error(payload.error || `导演表接口返回 ${response.status}`);
  const content = payload.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as {
    storylineBible?: string;
    shotDirectives?: Array<Record<string, unknown>>;
  };
  console.log(JSON.stringify({
    durationMs: Date.now() - startedAt,
    count: parsed.shotDirectives?.length || 0,
    storylineBible: parsed.storylineBible || "",
    riskDirectives: parsed.shotDirectives?.slice(2, 4) || [],
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
