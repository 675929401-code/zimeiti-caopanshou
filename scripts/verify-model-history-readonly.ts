import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { containsForbiddenPublicModelKey } from "@/lib/public-model-dto";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", `model-history-readonly-${stamp}`);
const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function list(value: unknown, key: string): Json[] {
  const rows = record(value)[key];
  return Array.isArray(rows) ? rows.filter((item): item is Json => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function check(name: string, action: () => string): void {
  try {
    checks.push({ name, passed: true, detail: action() });
  } catch (error) {
    checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

async function request(pathname: string, token?: string) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 160) }; }
  return { pathname, status: response.status, ok: response.ok, body };
}

async function probeMedia(label: string, url: string, token: string) {
  const relative = url.startsWith("/");
  let response: Response;
  try {
    response = await fetch(relative ? `${baseUrl}${url}` : url, {
      cache: "no-store",
      headers: {
        Range: "bytes=0-4095",
        ...(relative ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const target = relative ? url : (() => {
      try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return "invalid-external-media-url"; }
    })();
    throw new Error(`${label} 请求失败：${target}；${error instanceof Error ? error.message : String(error)}`);
  }
  assert.ok(response.ok || response.status === 206, `${label} 返回 HTTP ${response.status}`);
  const reader = response.body?.getReader();
  const first = reader ? await reader.read() : { value: undefined };
  await reader?.cancel().catch(() => {});
  const bytes = first.value?.byteLength || 0;
  assert.ok(bytes > 0, `${label} 没有返回媒体字节`);
  return { label, status: response.status, contentType: response.headers.get("content-type") || "", firstChunkBytes: bytes };
}

async function localToken(): Promise<string> {
  const root = process.cwd();
  const require = createRequire(path.join(root, "package.json"));
  const launcher = await import(pathToFileURL(path.join(root, "scripts/start-local-data-preview.mjs")).href);
  const runtime = JSON.parse(readFileSync(launcher.LOCAL_PREVIEW_RUNTIME_FILE, "utf8"));
  const baseEnvironment = require("dotenv").parse(readFileSync(path.join(root, ".env.local"), "utf8"));
  Object.assign(process.env, launcher.createLocalPreviewLaunchPlan(runtime, baseEnvironment).env);
  const { createToken } = await import(pathToFileURL(path.join(root, "src/lib/auth.ts")).href);
  const { getSupabaseClient } = await import(pathToFileURL(path.join(root, "src/storage/database/supabase-client.ts")).href);
  const db = getSupabaseClient();
  const admin = await db.from("users").select("id,username,display_name").eq("role", "admin").eq("is_active", true).limit(1).maybeSingle();
  if (admin.error || !admin.data) throw new Error("找不到本地只读验收账号");
  return createToken({
    userId: String(admin.data.id),
    username: String(admin.data.username),
    displayName: String(admin.data.display_name || "本地验收"),
    role: "admin",
    sessionId: `model-history-readonly-${randomUUID()}`,
  });
}

async function main(): Promise<void> {
const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim() || await localToken();
const publicPaths = [
  "/api/chat-models",
  "/api/youcai/chat-models",
  "/api/cover-models",
  "/api/cover-models?surface=image-workbench",
  "/api/video/models?surface=video-page",
  "/api/video/models?surface=storyboard-workbench",
  "/api/video/models?surface=digital-human",
  "/api/voice/pricing",
  "/api/voice/list?page=1&limit=500",
] as const;
const historyPaths = [
  "/api/conversations/history",
  "/api/video/history?limit=20",
  "/api/video/history?surface=digital-human&limit=20",
  "/api/digital-human/long-history?limit=20",
  "/api/image-workbench/history?page=1",
  "/api/cover/history?page=1",
  "/api/voice/history?page=1&pageSize=20",
  "/api/storyboard/projects?offset=0",
  "/api/media-history?limit=100&includeTotal=1",
] as const;

const publicResults = await Promise.all(publicPaths.map((pathname) => request(pathname)));
const historyResults = await Promise.all(historyPaths.map((pathname) => request(pathname, token)));
const protectedResults = await Promise.all(historyPaths.map((pathname) => request(pathname)));
const byPath = new Map([...publicResults, ...historyResults].map((result) => [result.pathname, result]));

check("所有模型目录和历史接口可读取", () => {
  const failures = [...publicResults, ...historyResults].filter((result) => !result.ok);
  assert.deepEqual(failures.map((result) => `${result.pathname}:${result.status}`), []);
  return `${publicResults.length + historyResults.length} 个 GET 接口均为 2xx`;
});

check("历史接口未登录保护", () => {
  const failures = protectedResults.filter((result) => ![401, 403].includes(result.status));
  assert.deepEqual(failures.map((result) => `${result.pathname}:${result.status}`), []);
  return `${protectedResults.length} 个历史接口均拒绝匿名读取`;
});

const chat = list(byPath.get("/api/chat-models")?.body, "models");
const manga = list(byPath.get("/api/youcai/chat-models")?.body, "models");
const cover = list(byPath.get("/api/cover-models")?.body, "models");
const image = list(byPath.get("/api/cover-models?surface=image-workbench")?.body, "models");
const video = list(byPath.get("/api/video/models?surface=video-page")?.body, "models");
const storyboard = list(byPath.get("/api/video/models?surface=storyboard-workbench")?.body, "models");
const human = list(byPath.get("/api/video/models?surface=digital-human")?.body, "models");

check("公开模型 DTO 与编号", () => {
  const catalogs = { chat, manga, cover, image, video, storyboard, human };
  for (const [surface, models] of Object.entries(catalogs)) {
    assert.ok(models.length > 0, `${surface} 模型目录为空`);
    assert.equal(new Set(models.map((model) => model.id)).size, models.length, `${surface} 模型编号重复`);
    assert.ok(models.every((model) => /^pm_[A-Za-z0-9_-]{20,}$/u.test(String(model.id || ""))), `${surface} 存在非公开模型编号`);
    assert.equal(containsForbiddenPublicModelKey(models), false, `${surface} 暴露内部模型字段`);
  }
  return `chat=${chat.length}, manga=${manga.length}, cover=${cover.length}, image=${image.length}, video=${video.length}, storyboard=${storyboard.length}, human=${human.length}`;
});

check("跨工作台模型分区", () => {
  const videoIds = new Set(video.map((model) => String(model.id)));
  const humanIds = new Set(human.map((model) => String(model.id)));
  assert.ok(storyboard.every((model) => videoIds.has(String(model.id))), "分镜目录不是通用视频目录的兼容子集");
  assert.ok(storyboard.every((model) => {
    const capabilities = record(model.capabilities);
    return capabilities.requiresSourceVideo !== true && capabilities.requiresLastFrame !== true && capabilities.supportsAudioInput !== true;
  }), "分镜目录混入源视频、尾帧或音频输入模型");
  assert.ok(video.every((model) => !humanIds.has(String(model.id))), "通用视频目录混入数字人专用模型");
  assert.ok(human.every((model) => (record(model.capabilities).workspaceSurfaces as unknown[] || []).includes("digital-human")), "数字人目录混入非数字人模型");
  return `分镜 ${storyboard.length} 个兼容模型；数字人 ${human.length} 个专用模型，与通用视频分离`;
});

check("视频模型健康状态可执行或有明确阻塞原因", () => {
  const models = [...new Map([...video, ...storyboard, ...human].map((model) => [String(model.id), model])).values()];
  for (const model of models) {
    const capabilities = record(model.capabilities);
    assert.equal(typeof capabilities.available, "boolean", `${String(model.displayName || model.id)} 缺少健康状态`);
    if (capabilities.available === false) {
      assert.ok(String(capabilities.availabilityMessage || "").trim(), `${String(model.displayName || model.id)} 不可用但没有给用户说明原因`);
    }
  }
  const available = models.filter((model) => record(model.capabilities).available === true).length;
  return `${available} 个可执行，${models.length - available} 个诚实阻塞且均有原因`;
});

check("对话模型头像可用", () => {
  const broken = chat.filter((model) => /[\u0080-\u009f\u00c2\u00c3\u00e2\u00f0\ufffd]/u.test(String(model.avatarUrl || "")));
  assert.equal(broken.length, 0, `运行时仍返回 ${broken.length} 个乱码头像；需激活当前源码构建`);
  return `${chat.length} 个对话模型头像字段无乱码`;
});

const normalVideoHistory = list(byPath.get("/api/video/history?limit=20")?.body, "tasks");
const humanVideoHistory = list(byPath.get("/api/video/history?surface=digital-human&limit=20")?.body, "tasks");

check("视频历史公开模型绑定", () => {
  const rows = [...normalVideoHistory, ...humanVideoHistory];
  assert.ok(rows.every((row) => /^pm_/u.test(String(row.modelId || "")) && row.modelId === row.publicModelId), "运行时历史仍暴露或回退到数据库模型编号；需激活当前源码构建");
  return `${rows.length} 条任务的 modelId/publicModelId 均为同一公开编号`;
});

check("视频与数字人历史分区", () => {
  assert.ok(normalVideoHistory.every((row) => !String(row.taskLabel || "").startsWith("digital-human:")), "视频制作历史混入数字人任务");
  assert.ok(humanVideoHistory.every((row) => String(row.taskLabel || "").startsWith("digital-human:")), "数字人历史混入通用视频任务");
  return `视频=${normalVideoHistory.length}，数字人=${humanVideoHistory.length}`;
});

check("历史结果交付字段", () => {
  const media = list(byPath.get("/api/media-history?limit=100&includeTotal=1")?.body, "items");
  const completed = media.filter((item) => item.status === "completed");
  assert.ok(completed.every((item) => String(item.previewPath || "").startsWith("/api/") && String(item.downloadPath || "").startsWith("/api/")), "完成记录存在绕过站内鉴权的播放或下载链接");
  const invalidStatus = media.filter((item) => !["queued", "processing", "completed", "failed", "cancelled"].includes(String(item.status || "")));
  assert.equal(invalidStatus.length, 0, "媒体历史存在无法识别的状态");
  return `${media.length} 条聚合历史，${completed.length} 条完成结果均走站内授权入口`;
});

const media = list(byPath.get("/api/media-history?limit=100&includeTotal=1")?.body, "items");
const deliveryProbes: Array<{ label: string; status: number; contentType: string; firstChunkBytes: number }> = [];
const videoMedia = media.find((entry) => entry.kind === "video" && entry.status === "completed");
const imageMedia = media.find((entry) => entry.kind === "image" && entry.status === "completed");
if (videoMedia?.previewPath) deliveryProbes.push(await probeMedia("已有视频预览", String(videoMedia.previewPath), token));
if (videoMedia?.downloadPath) deliveryProbes.push(await probeMedia("已有视频下载", String(videoMedia.downloadPath), token));
if (imageMedia?.previewPath) deliveryProbes.push(await probeMedia("已有图片预览", String(imageMedia.previewPath), token));
if (imageMedia?.downloadPath) deliveryProbes.push(await probeMedia("已有图片下载", String(imageMedia.downloadPath), token));
if (!imageMedia) {
  const imageRecords = list(byPath.get("/api/image-workbench/history?page=1")?.body, "records");
  const imageItem = imageRecords.flatMap((entry) => list(entry, "items")).find((entry) => entry.imageUrl);
  const coverRecords = list(byPath.get("/api/cover/history?page=1")?.body, "records");
  const coverItem = coverRecords.find((entry) => entry.url);
  const fallbackImageUrl = String(imageItem?.imageUrl || coverItem?.url || "");
  if (fallbackImageUrl) deliveryProbes.push(await probeMedia("已有图片预览", fallbackImageUrl, token));
}
const humanCompleted = humanVideoHistory.find((entry) => entry.status === "completed" && entry.videoUrl);
if (humanCompleted) deliveryProbes.push(await probeMedia("已有数字人视频预览", String(humanCompleted.videoUrl), token));
const voiceData = record(byPath.get("/api/voice/history?page=1&pageSize=20")?.body).data;
const voiceHistory = list(voiceData, "items");
const voiceCompleted = voiceHistory.find((entry) => entry.outputAudioUrl);
if (voiceCompleted) deliveryProbes.push(await probeMedia("已有语音历史试听", String(voiceCompleted.outputAudioUrl), token));

check("既有真实结果可读取", () => {
  const labels = new Set(deliveryProbes.map((probe) => probe.label));
  for (const expected of ["已有视频预览", "已有视频下载", "已有图片预览", "已有数字人视频预览", "已有语音历史试听"]) {
    assert.ok(labels.has(expected), `${expected} 没有找到可复用的已完成记录或媒体不可读`);
  }
  return deliveryProbes.map((probe) => `${probe.label}:${probe.status}/${probe.contentType}/${probe.firstChunkBytes}B`).join("；");
});

const report = {
  ok: checks.every((entry) => entry.passed),
  generatedAt: new Date().toISOString(),
  baseUrl,
  mutations: 0,
  providerCalls: 0,
  deliveryProbes,
  api: [...publicResults, ...historyResults, ...protectedResults].map((result) => ({ path: result.pathname, status: result.status })),
  counts: {
    chat: chat.length,
    manga: manga.length,
    cover: cover.length,
    image: image.length,
    video: video.length,
    storyboard: storyboard.length,
    digitalHuman: human.length,
    normalVideoHistory: normalVideoHistory.length,
    digitalHumanVideoHistory: humanVideoHistory.length,
  },
  checks,
};
await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ ...report, evidenceDir }, null, 2));
if (!report.ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
