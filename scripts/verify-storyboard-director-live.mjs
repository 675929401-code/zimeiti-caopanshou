import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const script = "狗狗突然不吃饭，未必只是在挑食。金毛趴在饭碗旁闻了闻却把头扭开，主人刚想换罐头，它又轻轻蜷起肚子。先观察精神、饮水和排便，如果同时没精神、频繁呕吐或明显腹痛，应尽快联系兽医。";

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

const startedAt = Date.now();
const response = await fetch(`${baseUrl}/api/storyboard/compile`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    Authorization: `Bearer ${session.token}`,
  },
  body: JSON.stringify({
    script,
    style: "高品质电影级3D卡通动画，暖色家庭光影，细腻毛发，夸张但可信的表演",
    ratio: "16:9",
    panelMode: "fixed-4",
    model: "gpt-5.6-sol",
  }),
  signal: AbortSignal.timeout(150_000),
});
const result = await response.json();
assert.ok(response.ok && result.project, result.error || `导演接口失败（${response.status}）`);

const segments = result.project.segments;
assert.equal(result.project.version, "storyboard-director-v2.5.4");
assert.equal(segments.map((segment) => segment.narration).join(""), script, "口播原文发生变化");

const checks = segments.map((segment) => {
  assert.equal(segment.durationSeconds, 10);
  assert.equal(segment.beats.length, 4, "固定四格模式必须返回4格");
  assert.deepEqual(segment.beats.map((beat) => beat.order), segment.beats.map((_, index) => index + 1));
  for (const beat of segment.beats) {
    assert.ok(beat.videoPrompt.length >= 30 && beat.videoPrompt.length <= 800, `第${beat.order}格视频指令长度异常`);
    assert.ok(segment.videoPrompt.includes(`第${beat.order}格图生视频 Prompt`), `总视频提示词缺少第${beat.order}格`);
  }
  return {
    order: segment.order,
    narration: segment.narration,
    beatCount: segment.beats.length,
    beatVideoPromptLengths: segment.beats.map((beat) => beat.videoPrompt.length),
    storyboardImagePromptLength: segment.storyboardImagePrompt.length,
    composedVideoPromptLength: segment.videoPrompt.length,
    semanticEffects: segment.beats.map((beat) => beat.semanticEffect),
  };
});

const report = {
  passed: true,
  elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  version: result.project.version,
  title: result.project.title,
  segmentCount: segments.length,
  narrationExact: true,
  checks,
  project: result.project,
};

await mkdir(".tmp-e2e", { recursive: true });
await writeFile(".tmp-e2e/storyboard-director-v2-live.json", JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ ...report, project: undefined }, null, 2));
