import assert from "node:assert/strict";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const script = [
  "狗狗第一次见面时，明明彼此心动，却可能都不敢先靠近。",
  "幼犬歪着脑袋，往往是不明白对方为什么一直摇尾巴。",
  "异物进入狗狗肠道后，可能逐渐堆积并造成堵塞。",
].join("");

type Shot = {
  order: number;
  narration: string;
  visualMode: "narrative" | "hybrid-packaging" | "semantic-cutaway";
  effectsPrompt: string;
  imagePrompt: string;
  videoPrompt: string;
};

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.equal(sessionResponse.ok, true, session.error || "dev session failed");
  assert.ok(session.token, "missing dev token");

  const response = await fetch(`${baseUrl}/api/canvas/compile-script`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      script,
      presetId: "anime_story",
      style: "高品质电影级3D卡通动画，经典喜剧动画表演节奏，角色不说话",
      ratio: "16:9",
      referenceMode: "single",
      keyframeStrategy: "visual-anchor",
      effectsLevel: "rich",
      productionMode: "anime-story",
      assistantInstruction: `本轮为v24语义表演验收-${Date.now()}，输入是宠物科普口播，不是剧本。`,
      videoModelDurationMode: "fixed",
      videoModelDurationSeconds: 8,
    }),
    signal: AbortSignal.timeout(480_000),
  });
  const result = await response.json() as {
    error?: string;
    compiler?: string;
    compilerRevision?: string;
    compilerDiagnostics?: Array<{ stage: string; status: string; detail?: string }>;
    shots?: Shot[];
  };
  if (!response.ok) {
    console.error(JSON.stringify(result, null, 2));
  }
  assert.equal(response.ok, true, `${response.status}: ${result.error || "compile failed"}`);
  assert.equal(result.compiler, "ai", "strict AI director plan was not accepted");

  const shots = result.shots || [];
  const relationship = shots.find((shot) => /心动/u.test(shot.narration));
  const confusion = shots.find((shot) => /不明白|歪着脑袋/u.test(shot.narration));
  const intestine = shots.find((shot) => /肠道/u.test(shot.narration));
  assert.ok(relationship, "missing relationship shot");
  assert.ok(confusion, "missing confusion shot");
  assert.ok(intestine, "missing intestine shot");
  assert.notEqual(relationship.visualMode, "narrative", "relationship shot remained plain narrative");
  assert.match(relationship.effectsPrompt, /(?:桃心|爱心|心形)/u, "relationship packaging has no visible heart cue");
  assert.match(confusion.effectsPrompt, /(?:问号|疑问)/u, "confusion packaging has no visible question cue");
  assert.match(intestine.effectsPrompt, /【包装类型】local-inset/u, "intestine shot is not a local teaching inset");
  shots.forEach((shot) => {
    assert.doesNotMatch(shot.videoPrompt, /(?:开口说话|开始说话|念词|对白口型|嘴唇同步)/u, `shot ${shot.order} contains speech performance`);
    const anchor = shot.effectsPrompt.match(/【包装锚点】([^【；;\n]+)/u)?.[1]?.trim();
    if (anchor && anchor !== "无") {
      assert.ok(shot.imagePrompt.includes(anchor), `shot ${shot.order} image prompt missed anchor ${anchor}`);
      assert.ok(shot.videoPrompt.includes(anchor), `shot ${shot.order} video prompt missed anchor ${anchor}`);
    }
  });

  console.log(JSON.stringify({
    compiler: result.compiler,
    compilerRevision: result.compilerRevision,
    diagnostics: result.compilerDiagnostics,
    shots: shots.map((shot) => ({
      order: shot.order,
      narration: shot.narration,
      visualMode: shot.visualMode,
      packagingType: shot.effectsPrompt.match(/【包装类型】([^【；;\n]+)/u)?.[1]?.trim(),
      packagingAnchor: shot.effectsPrompt.match(/【包装锚点】([^【；;\n]+)/u)?.[1]?.trim(),
      imagePromptLength: shot.imagePrompt.length,
      videoPromptLength: shot.videoPrompt.length,
    })),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
