import assert from "node:assert/strict";
import { request as playwrightRequest } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const script = [
  "桌上的葡萄刚滚到地上，金毛就飞快凑了过去。",
  "葡萄可能让狗狗的肾脏受到严重损伤，即使暂时没反应也不能继续观察。",
  "主人要先收走剩余葡萄，记下误食时间和数量，再立刻联系宠物医生。",
].join("");

type Result = {
  error?: string;
  compiler?: string;
  compilerRevision?: string;
  storyPlan?: string;
  semanticSegments?: Array<{ order: number; narration: string }>;
  shots?: Array<{ order: number; videoPrompt: string; imagePrompt: string }>;
  compilerDiagnostics?: Array<{ stage: string; status: string; detail?: string }>;
};

async function main() {
  const api = await playwrightRequest.newContext({ baseURL: baseUrl });
  const sessionResponse = await api.get("/api/auth/dev-session", {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.equal(sessionResponse.ok(), true, session.error || "dev session failed");
  assert.ok(session.token, "missing dev token");

  const response = await api.post("/api/canvas/compile-script", {
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    data: {
      script,
      presetId: "anime_story",
      style: "高品质电影级3D卡通动画，经典喜剧动画表演节奏，角色不说话",
      ratio: "16:9",
      referenceMode: "single",
      keyframeStrategy: "visual-anchor",
      effectsLevel: "rich",
      productionMode: "anime-story",
      assistantInstruction: `口播转无对白微故事验收-${Date.now()}`,
      allowDurationTrim: true,
      videoModelDurationMode: "fixed",
      videoModelDurationSeconds: 8,
    },
    timeout: 420_000,
  });
  const result = await response.json() as Result;
  if (!response.ok()) console.error(JSON.stringify(result, null, 2));
  assert.equal(response.ok(), true, `${response.status()}: ${result.error || "compile failed"}`);
  assert.equal(result.compiler, "ai", "strict AI story director plan was not accepted");
  assert.ok(result.storyPlan && !result.storyPlan.includes("未生成"), "missing story plan");

  for (const heading of ["故事前提", "主角目标", "触发事件", "升级", "转折", "收束", "逐镜故事接力"]) {
    assert.ok(result.storyPlan.includes(`【${heading}】`), `missing ${heading}`);
  }
  const beatLines = result.storyPlan.split("\n").filter((line) => /^\d{2}｜/u.test(line));
  assert.equal(beatLines.length, result.semanticSegments?.length, "story beat count does not match narration count");
  beatLines.forEach((line, index) => {
    for (const field of ["入场：", "事件：", "动作：", "结果：", "交接："]) {
      assert.ok(line.includes(field), `beat ${index + 1} missing ${field}`);
    }
  });
  const eventValues = beatLines.map((line) => line.match(/事件：(.+?)｜动作：/u)?.[1]?.trim()).filter(Boolean);
  assert.equal(new Set(eventValues).size, eventValues.length, "story events repeat instead of escalating");
  (result.shots || []).forEach((shot) => {
    assert.doesNotMatch(shot.videoPrompt, /(?:开口说话|念词|对白口型|嘴唇同步)/u, `shot ${shot.order} contains speech performance`);
  });

  console.log(JSON.stringify({
    compiler: result.compiler,
    compilerRevision: result.compilerRevision,
    diagnostics: result.compilerDiagnostics,
    semanticSegments: result.semanticSegments,
    storyPlan: result.storyPlan,
    shots: (result.shots || []).map((shot) => ({
      order: shot.order,
      imagePrompt: shot.imagePrompt,
      videoPrompt: shot.videoPrompt,
    })),
  }, null, 2));
  await api.dispose();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
