import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = "storyboard-v2-live";

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回非JSON内容（${response.status}）：${text.slice(0, 500)}`);
  }
}

async function getSession() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/dev-session`, {
        headers: { "x-local-workbench": "ai-creation-studio-local" },
        signal: AbortSignal.timeout(30_000),
      });
      const data = await readJson(response);
      if (response.ok && data.token) return data;
      lastError = new Error(data.error || `本地会话失败（${response.status}）`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw lastError || new Error("本地测试会话不可用");
}

const directorReport = JSON.parse(await readFile(".tmp-e2e/storyboard-director-v2-live.json", "utf8"));
const project = directorReport.project;
assert.ok(project?.segments?.length, "缺少真实导演拆解结果");
const segment = project.segments[0];
assert.equal(segment.beats.length, 4, "真实媒体验收固定使用四格故事板");

const session = await getSession();
const authorization = `Bearer ${session.token}`;
const startedAt = Date.now();

console.log(JSON.stringify({ phase: "image-submit", model: "gpt-image-2-chA-2", resolution: "1K" }));
const imageResponse = await fetch(`${baseUrl}/api/image/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: authorization },
  body: JSON.stringify({
    prompt: segment.storyboardImagePrompt,
    mode: "local",
    modelId: "gpt-image-2-chA-2",
    style: "",
    aspectRatio: "16:9",
    resolution: "1K",
    coverText: "",
    clientTraceId: crypto.randomUUID(),
    clientNodeId: `${reviewId}-segment-1`,
    clientNodeTitle: "故事板真实验收片段1",
  }),
  signal: AbortSignal.timeout(360_000),
});
const imageResult = await readJson(imageResponse);
assert.ok(imageResponse.ok && imageResult.images?.[0]?.url, imageResult.error || `故事板生图失败（${imageResponse.status}）`);

console.log(JSON.stringify({ phase: "image-persist" }));
const persistResponse = await fetch(`${baseUrl}/api/image-workbench/persist`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: authorization },
  body: JSON.stringify({ url: imageResult.images[0].url, index: 1 }),
  signal: AbortSignal.timeout(120_000),
});
const persistResult = await readJson(persistResponse);
assert.ok(persistResponse.ok && /^https?:\/\//u.test(persistResult.url || ""), persistResult.error || "故事板公网转存失败");

console.log(JSON.stringify({ phase: "video-submit", model: "omni-flash-10s-1080p-ch3" }));
const videoResponse = await fetch(`${baseUrl}/api/video/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: authorization },
  body: JSON.stringify({
    model_id: "omni-flash-10s-1080p-ch3",
    prompt: segment.videoPrompt,
    image_url: persistResult.url,
    duration: 10,
    aspect_ratio: "16:9",
    resolution_tier: "1080p",
    negative_prompt: "dialogue, lip sync, narration, voice-over, subtitles, background music, readable text, split screen, storyboard borders, panel numbers, collage layout, extra characters",
    task_label: "故事板真实验收片段1",
    batch_id: reviewId,
    batch_topic: "storyboard-workbench",
    card_index: 1,
  }),
  signal: AbortSignal.timeout(180_000),
});
let videoResult = await readJson(videoResponse);
assert.ok(videoResponse.ok, videoResult.error || `视频提交失败（${videoResponse.status}）`);
const taskId = videoResult.task_id;
assert.ok(taskId || (videoResult.status === "completed" && videoResult.video_url), "视频通道没有返回任务编号或成片");

if (!(videoResult.status === "completed" && videoResult.video_url)) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 8_000));
    const pollResponse = await fetch(`${baseUrl}/api/video/poll?task_id=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(60_000),
    });
    videoResult = await readJson(pollResponse);
    assert.ok(pollResponse.ok, videoResult.error || `视频轮询失败（${pollResponse.status}）`);
    console.log(JSON.stringify({ phase: "video-poll", attempt: attempt + 1, status: videoResult.status, progress: videoResult.progress ?? null }));
    if (videoResult.status === "success" && videoResult.video_url) break;
    assert.notEqual(videoResult.status, "failed", videoResult.error || "视频模型生成失败");
  }
}

assert.ok(videoResult.video_url, "视频等待超过时限");
const playbackTaskId = taskId || new URL(videoResult.video_url, baseUrl).pathname.split("/").filter(Boolean).at(-1);
assert.ok(playbackTaskId, "无法确定视频任务编号");

await mkdir(".tmp-e2e", { recursive: true });
const imageFile = path.resolve(".tmp-e2e/storyboard-v2-live-image.png");
const imageDownload = await fetch(persistResult.url, { signal: AbortSignal.timeout(120_000) });
assert.ok(imageDownload.ok, `故事板成品下载失败（${imageDownload.status}）`);
const imageBytes = Buffer.from(await imageDownload.arrayBuffer());
await writeFile(imageFile, imageBytes);

const videoDownloadUrl = new URL(videoResult.video_url, baseUrl).toString();
const videoDownload = await fetch(videoDownloadUrl, { signal: AbortSignal.timeout(240_000) });
assert.ok(videoDownload.ok, `视频成品下载失败（${videoDownload.status}）`);
const videoFile = path.resolve(".tmp-e2e/storyboard-v2-live-video.mp4");
const videoBytes = Buffer.from(await videoDownload.arrayBuffer());
await writeFile(videoFile, videoBytes);

await mkdir("public/storyboard-reviews", { recursive: true });
const archivedImageUrl = `/storyboard-reviews/${reviewId}.png`;
const archivedVideoUrl = `/storyboard-reviews/${reviewId}.mp4`;
await writeFile(`public${archivedImageUrl}`, imageBytes);
await writeFile(`public${archivedVideoUrl}`, videoBytes);

const now = Date.now();
const reviewProject = {
  ...project,
  segments: project.segments.map((item, index) => ({
    ...item,
    imageStatus: index === 0 ? "done" : "idle",
    imageUrl: index === 0 ? archivedImageUrl : undefined,
    videoStatus: index === 0 ? "done" : "idle",
    videoUrl: index === 0 ? archivedVideoUrl : undefined,
    videoTaskId: index === 0 ? playbackTaskId : undefined,
    videoProgress: index === 0 ? 100 : undefined,
  })),
};
const run = {
  id: `storyboard-review-${reviewId}`,
  createdAt: now,
  updatedAt: now,
  script: project.segments.map((item) => item.narration).join(""),
  ratio: "16:9",
  panelMode: "fixed-4",
  style: project.styleBible,
  llmModel: "gpt-5.6-sol",
  imageModelId: "gpt-image-2-chA-2",
  videoModelId: "omni-flash-10s-1080p-ch3",
  project: reviewProject,
};
const review = {
  reviewId,
  generatedAt: new Date().toISOString(),
  run,
  localArtifacts: { imageFile, videoFile },
};

await writeFile(`public/storyboard-reviews/${reviewId}.json`, JSON.stringify(review, null, 2), "utf8");
await writeFile(".tmp-e2e/storyboard-v2-live-media.json", JSON.stringify({
  passed: true,
  elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  imageModel: imageResult.modelUsed,
  imageResolution: imageResult.resolution,
  imageUrl: persistResult.url,
  videoModel: "omni-flash-10s-1080p-ch3",
  videoTaskId: playbackTaskId,
  imageFile,
  videoFile,
  reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
}, null, 2), "utf8");

console.log(JSON.stringify({
  passed: true,
  elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  imageModel: imageResult.modelUsed,
  imageResolution: imageResult.resolution,
  videoTaskId: playbackTaskId,
  imageFile,
  videoFile,
  reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
}, null, 2));
