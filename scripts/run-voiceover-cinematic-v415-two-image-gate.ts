import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

config({ path: ".env.local", quiet: true });

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const agentId = "agent-1786633444187-594spj";
const agentName = "3D故事导演｜电影叙事";
const expectedSchema = "storyboard_director_output_style.v4.1.5";
const expectedPromptSha = "8bce58f33f504ac9f8ab5ecf05192fee82f5e8e963aa2b25c69f648e7cba9940";
const reviewId = "voiceover-cinematic-random-two-segments-v415-fullchain-pro2k-omni10-20260817";
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const outDir = path.resolve(".tmp-e2e", reviewId);
const imagePublicId = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
const imageDbId = "gpt-image-2-chA-1";

type AgentRecord = {
  id: string;
  name: string;
  system_prompt?: string;
  output_style?: Record<string, unknown>;
};
type ReviewCard = {
  id: string;
  order: number;
  label?: string;
  narration?: string;
  imagePrompt: string;
  videoPrompt: string;
  referenceImageUrls: string[];
  imageStatus: string;
  imageUrl?: string;
  imageError?: string;
  imageValidatedAt?: number;
  imageModelIdUsed?: string;
  imageModelNameUsed?: string;
  videoStatus: string;
  videoError?: string;
};
type Review = {
  reviewId: string;
  conversationId: string;
  schemaVersion: string;
  promptSha256: string;
  status: string;
  run: {
    id: string;
    title: string;
    cards: ReviewCard[];
    updatedAt: number;
    imageModelId: string;
    imageResolution: string;
  };
  [key: string]: unknown;
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response: Response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: `non-JSON response (${response.status}): ${raw.slice(0, 500)}` };
  }
}

async function requestJson(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(init.headers || {}),
    },
  });
  return { response, data: await readJson(response) };
}

function pngDimensions(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "生成图片不是PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const review = JSON.parse(await readFile(reviewPath, "utf8")) as Review;
  assert.equal(review.reviewId, reviewId);
  assert.equal(review.schemaVersion, expectedSchema);
  assert.equal(review.promptSha256, expectedPromptSha);
  assert.equal(review.run.cards.length, 2, "图片门禁必须恰好两张卡");
  assert.ok(review.run.cards.every((card) => card.imageStatus === "idle" && card.videoStatus === "idle"), "卡片不是未提交状态");

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const session = await readJson(sessionResponse) as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");
  const token = session.token;

  const admin = await requestJson(`${baseUrl}/api/admin/agents`, token);
  const agents = (admin.data.agents || []) as AgentRecord[];
  const online = agents.find((item) => item.id === agentId);
  assert.ok(admin.response.ok && online?.system_prompt && online.name === agentName, "线上电影级口播智能体不存在");
  assert.equal(sha256(online.system_prompt), expectedPromptSha, "线上v4.1.5 Prompt SHA不符，停止付费提交");
  assert.equal(online.output_style?.schema_version, expectedSchema, "线上v4.1.5 schema不符，停止付费提交");

  const models = await requestJson(`${baseUrl}/api/cover-models`, token);
  const publicModels = (models.data.models || []) as Array<{ id?: string; name?: string }>;
  const publicModel = publicModels.find((item) => item.id === imagePublicId);
  assert.ok(models.response.ok && publicModel, "GPT-Image-2 渠道A pro公网路由不存在");

  const dbUrl = process.env.COZE_SUPABASE_URL;
  const dbKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
  assert.ok(dbUrl && dbKey, "数据库配置缺失");
  const db = createClient(dbUrl, dbKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const imageModelResult = await db.from("cover_models")
    .select("id,name,model_name,selling_price")
    .eq("id", imageDbId)
    .single();
  if (imageModelResult.error) throw imageModelResult.error;
  const imageModel = imageModelResult.data as { id: string; name: string; model_name: string; selling_price: number };
  assert.equal(imageModel.model_name, "gpt-image-2");
  assert.equal(Number(imageModel.selling_price), 0.2);

  const submissions: Array<Record<string, unknown>> = [];
  for (let index = 0; index < review.run.cards.length; index += 1) {
    if (index > 0) await sleep(5_200);
    const card = review.run.cards[index];
    const submission: Record<string, unknown> = {
      order: card.order,
      promptSha256: sha256(card.imagePrompt),
      status: "submitting",
      apiAttempts: 1,
      submittedAt: new Date().toISOString(),
    };
    submissions.push(submission);
    await writeFile(path.join(outDir, "image-gate-state.json"), `${JSON.stringify({ submissions }, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: "image-submit", card: card.order, model: imagePublicId, resolution: "2K" }));

    const generated = await requestJson(`${baseUrl}/api/image/generate`, token, {
      method: "POST",
      body: JSON.stringify({
        prompt: card.imagePrompt,
        mode: "local",
        modelId: imagePublicId,
        style: "",
        aspectRatio: "16:9",
        resolution: "2K",
        coverText: "",
        referenceImageUrls: [],
        referenceUsage: "general",
        clientTraceId: randomUUID(),
        clientNodeId: `${review.run.id}-shot-${card.order}`,
        clientNodeTitle: `分镜工作台镜头${card.order}`,
      }),
      signal: AbortSignal.timeout(360_000),
    });
    const generatedImages = generated.data.images as Array<{ url?: string }> | undefined;
    const generatedUrl = generatedImages?.[0]?.url;
    if (!generated.response.ok || !generatedUrl) {
      submission.status = "failed";
      submission.error = generated.data.error || `生图失败（${generated.response.status}）`;
      card.imageStatus = "failed";
      card.imageError = String(submission.error);
      await writeFile(path.join(outDir, "image-gate-state.json"), `${JSON.stringify({ submissions }, null, 2)}\n`, "utf8");
      break;
    }

    const download = await fetch(generatedUrl, { signal: AbortSignal.timeout(120_000) });
    assert.ok(download.ok, `第${card.order}张原图下载失败（${download.status}）`);
    const bytes = Buffer.from(await download.arrayBuffer());
    const dimensions = pngDimensions(bytes);
    assert.deepEqual(dimensions, { width: 2560, height: 1440 }, `第${card.order}张不是2K 16:9`);
    const localPath = path.join(outDir, `segment-${card.order}-gpt-image-2-pro-2k.png`);
    const publicFilename = `${reviewId}-segment-${card.order}.png`;
    const publicPath = path.resolve("public", "storyboard-reviews", publicFilename);
    await Promise.all([writeFile(localPath, bytes), writeFile(publicPath, bytes)]);

    const persisted = await requestJson(`${baseUrl}/api/image-workbench/persist`, token, {
      method: "POST",
      body: JSON.stringify({ url: generatedUrl, index: card.order }),
      signal: AbortSignal.timeout(120_000),
    });
    const persistedUrl = String(persisted.data.url || "");
    assert.ok(persisted.response.ok && /^https?:\/\//u.test(persistedUrl), String(persisted.data.error || `第${card.order}张持久化失败`));

    submission.status = "done";
    submission.completedAt = new Date().toISOString();
    submission.generatedUrl = generatedUrl;
    submission.persistedUrl = persistedUrl;
    submission.localOriginalPath = localPath;
    submission.publicReviewPath = `/storyboard-reviews/${publicFilename}`;
    submission.dimensions = dimensions;
    submission.bytes = bytes.length;
    submission.sha256 = sha256(bytes);
    card.imageStatus = "done";
    card.imageUrl = `/storyboard-reviews/${publicFilename}`;
    card.imageValidatedAt = Date.now();
    card.imageModelIdUsed = imagePublicId;
    card.imageModelNameUsed = imageModel.name;
    card.videoStatus = "idle";
    card.videoError = "图片待人工审核，视频尚未提交";
    await writeFile(path.join(outDir, "image-gate-state.json"), `${JSON.stringify({ submissions }, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: "image-complete", card: card.order, dimensions, bytes: bytes.length }));
  }

  const successfulImages = submissions.filter((item) => item.status === "done").length;
  review.status = successfulImages === 2
    ? "IMAGES_GENERATED_AWAITING_USER_APPROVAL_VIDEO_LOCKED"
    : "IMAGE_GATE_COMPLETE_WITH_FAILURES_VIDEO_LOCKED";
  review.run.updatedAt = Date.now();
  review.run.imageModelId = imagePublicId;
  review.run.imageResolution = "2K";
  review.actualCost = {
    agentCalls: 1,
    imageSubmissions: submissions.length,
    successfulImages,
    videoSubmissions: 0,
    paidRetries: 0,
    imageBusinessPriceCny: Number((successfulImages * Number(imageModel.selling_price)).toFixed(2)),
  };
  review.imageGate = {
    modelRoute: { publicId: imagePublicId, dbId: imageDbId, upstreamModel: imageModel.model_name, resolution: "2K", pixels: "2560x1440" },
    submissions,
  };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1100 } });
    await context.addInitScript((authToken) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.removeItem("storyboard_prompt_workbench_current_v2");
      localStorage.removeItem("storyboard_prompt_workbench_history_v2");
    }, token);
    const page = await context.newPage();
    const response = await page.goto(`${baseUrl}/storyboard-workbench?review=${reviewId}`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `review页面打开失败（${response?.status()}）`);
    await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(".sbw-shot-card").count(), 2);
    assert.equal(await page.locator('.sbw-shot-card img[alt^="镜头"]').count(), successfulImages);
    await page.screenshot({ path: path.join(outDir, "image-review-page.png"), fullPage: true });
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({
    passed: successfulImages === 2,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    conversationId: review.conversationId,
    modelRoute: { publicId: imagePublicId, dbId: imageDbId, resolution: "2K", pixels: "2560x1440" },
    cost: { businessPriceCny: Number((successfulImages * Number(imageModel.selling_price)).toFixed(2)), imageSubmissions: submissions.length, videoSubmissions: 0, paidRetries: 0 },
    images: submissions.map((item) => ({ order: item.order, path: item.localOriginalPath, dimensions: item.dimensions, sha256: item.sha256 })),
  }, null, 2));
}

main().catch(async (error) => {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const failure = {
    passed: false,
    at: new Date().toISOString(),
    error: error instanceof Error ? error.stack || error.message : JSON.stringify(error),
    retryPolicy: "no automatic paid retry",
    videoSubmissions: 0,
  };
  await writeFile(path.join(outDir, "image-gate-fatal-error.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
