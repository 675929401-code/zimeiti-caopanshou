import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDirectory = process.env.BENCHMARK_OUTPUT_DIRECTORY || ".tmp-e2e/benchmark-director-v8-live/grok-samples";
const storageStatePath = ".tmp-e2e/benchmark-director-v8-live/storage-state.json";
const modelId = "grok-imagine-video-1-5-fast-chA";
const selectedShots = (process.env.BENCHMARK_SHOTS || "3,7,11")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);
const reportFileName = process.env.BENCHMARK_REPORT_NAME
  || (process.env.BENCHMARK_SHOTS ? `report-${selectedShots.map((shot) => String(shot).padStart(2, "0")).join("-")}.json` : "report.json");

type StoredNode = {
  data: {
    kind: string;
    title: string;
    outputUrl?: string;
    prompt?: string;
    outputText?: string;
    durationSeconds?: number;
  };
};

type Sample = {
  shot: number;
  title: string;
  prompt: string;
  imageUrl: string;
  duration: number;
  taskId?: string;
  status?: string;
  videoUrl?: string;
  savedPath?: string;
  error?: string;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function jsonRequest<T>(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const session = await jsonRequest<{ token?: string }>(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  assert.ok(session.token, "本地验收会话不可用");
  const headers = { Authorization: `Bearer ${session.token}` };

  const storage = JSON.parse(await readFile(storageStatePath, "utf8")) as {
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  const origin = storage.origins?.find((item) => item.origin === baseUrl);
  assert.ok(origin, "恢复文件中没有本地画布数据");
  const graphEntry = origin.localStorage.find((item) => item.name === "ai-creation-studio-graph-v1");
  assert.ok(graphEntry, "恢复文件中没有画布图");
  const graph = JSON.parse(graphEntry.value) as { nodes?: StoredNode[] };
  const nodes = graph.nodes || [];

  const samples: Sample[] = selectedShots.map((shot) => {
    const label = String(shot).padStart(2, "0");
    const image = nodes.find((node) => node.data.kind === "image" && node.data.title.startsWith(`分镜${label} · 自动关键帧`));
    const promptNode = nodes.find((node) => node.data.kind === "text" && node.data.title === `分镜${label} · 视频提示词`);
    const video = nodes.find((node) => node.data.kind === "video" && node.data.title.startsWith(`分镜${label} · 关键帧生成视频`));
    assert.ok(image?.data.outputUrl, `分镜${label}缺少已生成首帧`);
    const prompt = promptNode?.data.outputText || promptNode?.data.prompt || "";
    assert.ok(prompt, `分镜${label}缺少视频提示词`);
    return {
      shot,
      title: `对标验收分镜${label}`,
      prompt,
      imageUrl: image.data.outputUrl,
      duration: video?.data.durationSeconds || 4,
    };
  });

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (index > 0) await delay(8_000);
    const submitted = await jsonRequest<{ task_id?: string; status?: string; video_url?: string }>(`${baseUrl}/api/bridge/video/generate`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model_id: modelId,
        prompt: sample.prompt,
        image_url: sample.imageUrl,
        duration: sample.duration,
        aspect_ratio: "16:9",
        resolution_tier: "720p",
        task_label: sample.title,
        batch_id: "benchmark-v8-grok-samples",
        card_index: sample.shot,
      }),
    });
    sample.taskId = submitted.task_id;
    sample.status = submitted.status;
    sample.videoUrl = submitted.video_url;
    assert.ok(sample.taskId, `${sample.title}没有返回任务ID`);
    console.log(`[grok-sample] 已提交分镜${sample.shot}：${sample.taskId}`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30 * 60_000 && samples.some((sample) => !sample.videoUrl && !sample.error)) {
    for (const sample of samples) {
      if (!sample.taskId || sample.videoUrl || sample.error) continue;
      const params = new URLSearchParams({
        taskId: sample.taskId,
        modelId,
        prompt: sample.prompt,
        imageUrl: sample.imageUrl,
        targetDuration: String(sample.duration),
        deferTrim: "1",
      });
      try {
        const status = await jsonRequest<{ status?: string; videoUrl?: string; errorMessage?: string; progress?: number }>(`${baseUrl}/api/bridge/video/status?${params}`, { headers });
        sample.status = status.status;
        if (status.status === "completed" && status.videoUrl) sample.videoUrl = status.videoUrl;
        if (status.status === "failed") sample.error = status.errorMessage || "视频生成失败";
        console.log(`[grok-sample] 分镜${sample.shot}：${status.status || "unknown"}${typeof status.progress === "number" ? ` ${status.progress}%` : ""}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/频繁|429/u.test(message)) throw error;
      }
      await delay(1_000);
    }
    await delay(6_000);
  }

  assert.ok(samples.every((sample) => sample.videoUrl && !sample.error), `视频样片未全部成功：${samples.map((sample) => `分镜${sample.shot}=${sample.status || sample.error}`).join("，")}`);
  await writeFile(`${outputDirectory}/${reportFileName}`, `${JSON.stringify({ modelId, samples }, null, 2)}\n`, "utf8");
  for (const sample of samples) {
    const url = sample.videoUrl!.startsWith("http") ? sample.videoUrl! : `${baseUrl}${sample.videoUrl}`;
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      response = await fetch(url, { headers });
      if (response.ok) break;
      if (attempt < 8 && (response.status === 404 || response.status >= 500)) await delay(attempt * 2_000);
      else break;
    }
    assert.ok(response?.ok, `${sample.title}下载失败：HTTP ${response?.status || "unknown"}`);
    const savedPath = `${outputDirectory}/shot-${String(sample.shot).padStart(2, "0")}.mp4`;
    await writeFile(savedPath, Buffer.from(await response.arrayBuffer()));
    sample.savedPath = savedPath;
  }
  await writeFile(`${outputDirectory}/${reportFileName}`, `${JSON.stringify({ modelId, samples }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(samples, null, 2));
}

void main().catch(async (error) => {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(`${outputDirectory}/error.txt`, error instanceof Error ? error.stack || error.message : String(error), "utf8");
  console.error(error);
  process.exitCode = 1;
});
