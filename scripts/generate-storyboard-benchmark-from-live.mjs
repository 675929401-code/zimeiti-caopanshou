import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const sourceReportPath = process.env.SOURCE_REPORT || ".tmp-e2e/storyboard-agent-card-live.json";
const artifactStem = process.env.ARTIFACT_STEM || "storyboard-benchmark-v41-gpt";
const reviewId = process.env.REVIEW_ID || "benchmark-v41";

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回非JSON内容（${response.status}）：${text.slice(0, 500)}`);
  }
}

async function getSession() {
  const response = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await readJson(response);
  assert.ok(response.ok && data.token, data.error || "本地测试会话不可用");
  return data;
}

async function persistWithRetry(url, authorization) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/image-workbench/persist`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        body: JSON.stringify({ url, index: 1 }),
        signal: AbortSignal.timeout(180_000),
      });
      const data = await readJson(response);
      if (response.ok && data.url) return data;
      lastError = new Error(data.error || `图片归档失败（${response.status}）`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
  }
  throw lastError || new Error("图片归档失败");
}

const sourceReport = JSON.parse(await readFile(sourceReportPath, "utf8"));
assert.ok(sourceReport.output?.imagePrompt, "缺少智能体生图Prompt");
const session = await getSession();
const authorization = `Bearer ${session.token}`;
const traceId = crypto.randomUUID();
const startedAt = Date.now();

console.log(JSON.stringify({ phase: "image-submit", traceId, model: "gpt-image-2-chA-2", resolution: "1K" }));
const response = await fetch(`${baseUrl}/api/image/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: authorization },
  body: JSON.stringify({
    prompt: sourceReport.output.imagePrompt,
    mode: "local",
    modelId: "gpt-image-2-chA-2",
    style: "",
    aspectRatio: "16:9",
    resolution: "1K",
    coverText: "",
    clientTraceId: traceId,
    clientNodeId: artifactStem,
    clientNodeTitle: "三张清晰对标-v4.1高能3D故事板",
  }),
  signal: AbortSignal.timeout(360_000),
});
const generated = await readJson(response);
assert.ok(response.ok && generated.images?.[0]?.url, generated.error || `故事板生图失败（${response.status}）`);

await mkdir(".tmp-e2e", { recursive: true });
await writeFile(
  `.tmp-e2e/${artifactStem}-provider.json`,
  JSON.stringify({ traceId, generatedAt: new Date().toISOString(), generated }, null, 2),
  "utf8",
);

console.log(JSON.stringify({ phase: "image-persist", modelUsed: generated.modelUsed, resolution: generated.resolution }));
const persisted = await persistWithRetry(generated.images[0].url, authorization);
const download = await fetch(persisted.url, { signal: AbortSignal.timeout(180_000) });
assert.ok(download.ok, `成图下载失败（${download.status}）`);
const bytes = Buffer.from(await download.arrayBuffer());

const localFile = path.resolve(`.tmp-e2e/${artifactStem}.png`);
const archivePath = path.resolve(`public/storyboard-reviews/${artifactStem}-20260814.png`);
await mkdir(path.dirname(archivePath), { recursive: true });
await writeFile(localFile, bytes);
await writeFile(archivePath, bytes);

const segment = {
  order: 1,
  narration: "狗狗突然爱舔墙、啃土、钻花盆，可能不是嘴馋。主人刚想把它抱走，它却顶着满鼻子泥在客厅疯狂打转，吓得主人一路追。别只顾着笑，这些反常动作可能是在发出营养警报，先检查饮食和身体状况，千万不要盲目乱补。",
  durationSeconds: 10,
  storyGoal: "把舔墙和钻花盆的异常行为升级为泥土追逐，再用异食警报与先检查盾牌完成知识揭示。",
  continuityIn: "从客厅墙角的舔墙异常开始。",
  continuityOut: "主人用检查盾牌挡开盲目补充，画面稳定落幅。",
  beats: [
    { order: 1, timeRange: "0.0-1.8秒", shotSize: "极近景", visual: "柯基贴地舔墙，主人抱衣篮发现异常。", action: "舔墙与急停", semanticEffect: "墙灰震动", transition: "柯基转头看向花盆", videoPrompt: "Fast push-in as the corgi licks the wall and the owner freezes." },
    { order: 2, timeRange: "1.8-3.6秒", shotSize: "广角近景", visual: "柯基钻入花盆，泥土迎面喷发，主人飞扑抓空。", action: "钻盆与抓空", semanticEffect: "泥土冲击云", transition: "柯基冲向客厅", videoPrompt: "Smash zoom as the corgi dives into the planter and soil bursts forward." },
    { order: 3, timeRange: "3.6-5.6秒", shotSize: "超广角", visual: "柯基绕客厅急转，主人滑步追赶，家具被泥土旋风卷动。", action: "高速追逐", semanticEffect: "泥土旋风与速度线", transition: "旋风撞出金色裂光", videoPrompt: "Rapid tracking shot follows the corgi while dirt spirals through the room." },
    { order: 4, timeRange: "5.6-7.8秒", shotSize: "冲撞式近景", visual: "黑金知识舞台升起异食警报门，柯基急刹错愕。", action: "急刹与警报升起", semanticEffect: "金色能量环", transition: "警报纹章投射金光", videoPrompt: "Explosive push-in reveals the warning gate as both characters recoil." },
    { order: 5, timeRange: "7.8-10.0秒", shotSize: "英雄式中广景", visual: "主人推动先检查盾牌，柯基专注观察，补充剂瓶被挡开。", action: "推动盾牌", semanticEffect: "蓝金盾牌与冲击波", transition: "稳定英雄式落幅", videoPrompt: "Rapid tilt up reveals the check-first shield pushing supplements away." },
  ],
  storyboardImagePrompt: sourceReport.output.imagePrompt,
  videoPrompt: sourceReport.output.videoPrompt,
  qualityChecklist: ["原文与语义对应", "角色和道具连续", "5格构成完整微故事", "知识包装来自当前语义", "英文制作条与画面一一对应"],
  imageStatus: "done",
  imageUrl: `/storyboard-reviews/${artifactStem}-20260814.png`,
  videoStatus: "idle",
};
const now = Date.now();
const project = {
  version: "storyboard-director-v4.1",
  title: "异食行为警报｜v4.1 对标复测",
  styleBible: "高能皮克斯式3D动画喜剧",
  characterBible: "26岁中国女性，深棕高马尾、黄色连帽卫衣、蓝色牛仔裤、白色运动鞋；3岁三色短腿柯基，保持自然四足犬类身份。",
  environmentBible: "明亮现代客厅、米白墙面、蓝绿色沙发、原木家具与大型陶土花盆；知识揭示时局部转入黑金及蓝金舞台。",
  segments: [segment],
};
const run = {
  id: `storyboard-review-${reviewId}`,
  createdAt: now,
  updatedAt: now,
  script: segment.narration,
  ratio: "16:9",
  panelMode: "auto",
  style: project.styleBible,
  llmModel: "gpt-5.6-sol",
  imageModelId: "gpt-image-2-chA-2",
  videoModelId: "omni-flash-10s-1080p-ch3",
  project,
};
const review = {
  reviewId,
  generatedAt: new Date().toISOString(),
  run,
  localArtifacts: { imageFile: localFile },
};
await writeFile(`public/storyboard-reviews/${reviewId}.json`, JSON.stringify(review, null, 2), "utf8");

const report = {
  passed: true,
  elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  traceId,
  modelUsed: generated.modelUsed,
  resolution: generated.resolution,
  providerUrl: generated.images[0].url,
  persistedUrl: persisted.url,
  persistedKey: persisted.key,
  imageFile: localFile,
  archivePath,
  reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
};
await writeFile(`.tmp-e2e/${artifactStem}.json`, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
