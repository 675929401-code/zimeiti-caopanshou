import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const imageModelId = process.env.IMAGE_MODEL_ID || "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
const videoModelId = process.env.VIDEO_MODEL_ID || "pm_O31GjpRvlTXjWUM1Ha9FG0N2";
const llmModel = process.env.LLM_MODEL || "glm-5.1";
const targetDuration = Number(process.env.TARGET_DURATION || 10);
const reviewId = process.env.REVIEW_ID || `storyboard-v260-four-domain-${Date.now()}`;
const rootDir = process.cwd();
const tmpDir = path.resolve(".tmp-e2e", reviewId);
const publicDir = path.resolve("public", "storyboard-reviews");

const scripts = [
  {
    key: "cold-fact",
    title: "冷知识：狗鼻子像情报站",
    text: "你以为狗狗出门一路低头闻，是在磨蹭？其实它是在读消息。哪只狗刚来过、心情紧不紧张、有没有陌生气味，它都能闻出来。所以遛狗别一直拽，给它十几秒闻一闻，它会更放松。",
  },
  {
    key: "science",
    title: "科普：越追越兴奋",
    text: "狗狗叼了袜子就跑，你越追它越兴奋，不一定是故意气你。因为在它眼里，这像一场超级好玩的追逐游戏。你先停住，用零食或玩具交换，它学会放下，下一次才不会越跑越疯。",
  },
  {
    key: "emotion",
    title: "情感：它不是不爱你",
    text: "狗狗忽然不让你抱，不一定是不爱你了。可能是今天太累，也可能是身体不舒服，或者被突然靠近吓到了。你蹲下来，侧过身，伸手让它自己靠近，它重新把头贴过来，那才是真的信任。",
  },
  {
    key: "health",
    title: "健康：突然狂喝水要警惕",
    text: "狗狗突然疯狂喝水，尿垫一天换好几次，别只怪天气热。先看饭量有没有变大、体重有没有掉，水碗像被抽干一样，就用检查图标记录状态，尽快做安全评估。",
  },
];

const bannedPromptRe = /配音语义|口播语义|旁白|字幕|说话|开口|口型|唇形|猫叫|喵|狗叫|犬吠|腹部局部|私密|生殖|肛门|肚皮特写|牙龈特写|扫描|全息|医学解剖|抚摸线|摸肋线|Frame\s*\d+|英文说明条|Frame文字|Frame说明条|导演注释|底部小字|医院名称|科室招牌|病历小字|药品标签|医疗说明/u;
const hardNegativePrompt = [
  "split screen",
  "storyboard borders",
  "panel numbers",
  "collage layout",
  "photorealistic",
  "live action",
  "realistic human skin",
  "blurry",
  "noisy",
  "grainy",
  "low resolution",
  "compression artifacts",
  "humanoid dog",
  "bipedal dog",
].join(", ");

function log(event) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }, null, 2));
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回非JSON内容（${response.status}）：${text.slice(0, 800)}`);
  }
}

async function getSession() {
  const response = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await readJson(response);
  assert.ok(response.ok && data.token, data.error || `本地会话失败（${response.status}）`);
  return data;
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 180_000),
  });
  const data = await readJson(response);
  assert.ok(response.ok, data.error || `${pathname}失败（${response.status}）`);
  return data;
}

function publicUrl(fileName) {
  return `/storyboard-reviews/${fileName}`;
}

async function downloadToFile(url, filePath, timeoutMs = 240_000) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(new URL(url, baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
      assert.ok(response.ok, `下载失败 ${url}（${response.status}）`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(filePath, bytes);
      return bytes;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  throw lastError;
}

function hasCommand(command) {
  try {
    execFileSync("where.exe", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ffprobe(filePath) {
  if (!hasCommand("ffprobe")) return null;
  const result = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ], { encoding: "utf8" });
  if (result.status !== 0) return { error: result.stderr || result.stdout };
  return JSON.parse(result.stdout);
}

function makeContactSheet(videoFile, outputFile) {
  if (!hasCommand("ffmpeg")) return false;
  const result = spawnSync("ffmpeg", [
    "-y",
    "-i",
    videoFile,
    "-vf",
    "fps=2,scale=480:-1,tile=4x5:margin=6:padding=3",
    "-frames:v",
    "1",
    outputFile,
  ], { encoding: "utf8" });
  return result.status === 0 && existsSync(outputFile);
}

function auditPrompt(segment) {
  const imagePrompt = String(segment.storyboardImagePrompt || "");
  const videoPrompt = String(segment.videoPrompt || "");
  return {
    narrationChars: segment.narration?.length || 0,
    durationSeconds: segment.durationSeconds,
    beatCount: Array.isArray(segment.beats) ? segment.beats.length : 0,
    imagePromptLength: imagePrompt.length,
    videoPromptLength: videoPrompt.length,
    bannedInImage: bannedPromptRe.test(imagePrompt),
    bannedInVideo: bannedPromptRe.test(videoPrompt),
    hasHighEnergy: /红黑|金色|放射|爆|警示|粒子|速度线|问号|结论|提示牌/u.test(`${imagePrompt}\n${videoPrompt}`),
    hasSafeActionCausality: /拿起|取出|放下|先|随后|接着|递进|轨迹|从.+到/u.test(videoPrompt),
    hasNoVoiceBoundary: /现场声轨|环境声|动作声|道具声|衣物摩擦|特效拟音|自然拟音/u.test(videoPrompt),
    hasStyleLock: /商业动画电影级3D|圆润|大眼|卡通|柔和|高饱和|暖金/u.test(`${imagePrompt}\n${videoPrompt}`),
  };
}

async function main() {
  const startedAt = Date.now();
  await mkdir(tmpDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });

  log({ phase: "start", reviewId, scripts: scripts.map((item) => `${item.title}：${item.text}`), imageModelId, videoModelId, llmModel, targetDuration });
  const session = await getSession();
  const authorization = `Bearer ${session.token}`;
  const cards = [];
  const promptAudit = [];
  const localArtifacts = [];

  for (let index = 0; index < scripts.length; index += 1) {
    const item = scripts[index];
    const order = index + 1;
    log({ phase: "compile-submit", order, title: item.title });
    const compiled = await fetchJson("/api/storyboard/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({
        script: item.text,
        ratio: "16:9",
        panelMode: "fixed-5",
        targetDuration,
    style: "对标皮克斯式高能3D宠物科普动画，高能短视频包装；画面必须有商业动画电影级3D质感、圆润大眼角色、暖金光、高饱和特效包装；故事板画面仅包含角色、场景、动作道具、短中文语义牌和图标贴纸；狗狗保持四足自然行为，表情夸张但肢体符合犬类常识；医院、检查、健康风险统一用兽医十字图标贴纸、爪印盾牌、检查勾选章、手机问诊图标表达；视频现场声轨仅包含环境声、脚步声、道具声、衣物摩擦声、轻微呼吸声和特效拟音。",
        model: llmModel,
      }),
      timeoutMs: 360_000,
    });
    const project = compiled.project || compiled;
    assert.ok(project.segments?.length, "编译结果缺少segments");
    const segment = project.segments[0];
    assert.equal(segment.durationSeconds, targetDuration, `${item.title} 时长不是${targetDuration}秒`);
    const audit = auditPrompt(segment);
    promptAudit.push({ key: item.key, title: item.title, ...audit });
    if (audit.bannedInImage || audit.bannedInVideo) {
      throw new Error(`${item.title} 提示词仍含禁用/高风险词：${JSON.stringify(audit)}`);
    }

    log({ phase: "image-submit", order, title: item.title, imagePromptLength: audit.imagePromptLength });
    const imageResult = await fetchJson("/api/image/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({
        prompt: segment.storyboardImagePrompt,
        mode: "local",
        modelId: imageModelId,
        style: "",
        aspectRatio: "16:9",
        resolution: "4K",
        coverText: "",
        clientTraceId: crypto.randomUUID(),
        clientNodeId: `${reviewId}-segment-${order}`,
        clientNodeTitle: `v2.6三段媒体验收-${item.title}`,
      }),
      timeoutMs: 480_000,
    });
    const remoteImageUrl = imageResult.images?.[0]?.url;
    assert.ok(remoteImageUrl, imageResult.error || "生图未返回图片");

    const persistResult = await fetchJson("/api/image-workbench/persist", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ url: remoteImageUrl, index: order }),
      timeoutMs: 180_000,
    });
    assert.ok(/^https?:\/\//u.test(persistResult.url || ""), "图片转存没有返回公网URL");

    const imageFileName = `${reviewId}-segment-${order}.png`;
    const imageFile = path.join(tmpDir, imageFileName);
    const imageBytes = await downloadToFile(persistResult.url, imageFile, 180_000);
    await writeFile(path.join(publicDir, imageFileName), imageBytes);

    log({ phase: "video-submit", order, title: item.title, videoPromptLength: audit.videoPromptLength });
    const videoSubmit = await fetchJson("/api/video/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({
        model_id: videoModelId,
        prompt: segment.videoPrompt,
        image_url: persistResult.url,
        duration: targetDuration,
        aspect_ratio: "16:9",
        resolution_tier: "1080p",
        negative_prompt: hardNegativePrompt,
        task_label: `v2.6三段媒体验收-${item.title}`,
        batch_id: reviewId,
        batch_topic: "storyboard-workbench",
        card_index: order,
      }),
      timeoutMs: 180_000,
    });

    let videoResult = videoSubmit;
    const taskId = videoSubmit.task_id;
    if (!(videoResult.status === "completed" && videoResult.video_url)) {
      assert.ok(taskId, "视频通道没有返回任务编号");
      for (let attempt = 1; attempt <= 150; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        videoResult = await fetchJson(`/api/video/poll?task_id=${encodeURIComponent(taskId)}`, {
          headers: { Authorization: authorization },
          timeoutMs: 90_000,
        });
        log({ phase: "video-poll", order, attempt, status: videoResult.status, progress: videoResult.progress ?? null });
        if ((videoResult.status === "success" || videoResult.status === "completed") && videoResult.video_url) break;
        assert.notEqual(videoResult.status, "failed", videoResult.error || `${item.title} 视频生成失败`);
      }
    }
    assert.ok(videoResult.video_url, `${item.title} 视频等待超时`);

    const videoFileName = `${reviewId}-segment-${order}.mp4`;
    const videoFile = path.join(tmpDir, videoFileName);
    const videoBytes = await downloadToFile(videoResult.video_url, videoFile, 360_000);
    await writeFile(path.join(publicDir, videoFileName), videoBytes);

    const contactFileName = `${reviewId}-segment-${order}-contact.png`;
    const contactFile = path.join(tmpDir, contactFileName);
    const hasContactSheet = makeContactSheet(videoFile, contactFile);
    if (hasContactSheet) {
      await writeFile(path.join(publicDir, contactFileName), await readFile(contactFile));
    }
    const probe = ffprobe(videoFile);

    cards.push({
      id: `segment-${order}`,
      order,
      label: item.title,
      narration: item.text,
      imagePrompt: segment.storyboardImagePrompt,
      videoPrompt: segment.videoPrompt,
      imageStatus: "done",
      imageUrl: publicUrl(imageFileName),
      imageValidatedAt: new Date().toISOString(),
      imageModelIdUsed: imageResult.modelUsed || imageModelId,
      videoStatus: "done",
      videoUrl: publicUrl(videoFileName),
      videoTaskId: taskId || videoResult.task_id || null,
      videoTaskModelId: videoModelId,
      videoProgress: 100,
      videoStatusDetail: videoResult.status || "success",
      contactSheetUrl: hasContactSheet ? publicUrl(contactFileName) : null,
    });
    localArtifacts.push({
      title: item.title,
      imageFile,
      videoFile,
      contactSheetFile: hasContactSheet ? contactFile : null,
      ffprobe: probe,
    });
    log({ phase: "segment-done", order, title: item.title, videoFile, hasContactSheet, ffprobe: probe });
  }

  const now = Date.now();
  const review = {
    reviewId,
    generatedAt: new Date().toISOString(),
    status: "done",
    sourceTopic: "v2.6.0 高能宠物四领域陌生文案泛化测试",
    run: {
      id: `storyboard-review-${reviewId}`,
      title: "v2.6.0 四领域不同文案媒体验收",
      createdAt: now,
      updatedAt: now,
      script: scripts.map((item, index) => `${index + 1}. ${item.text}`).join("\n"),
      ratio: "16:9",
      panelMode: "fixed-5",
      targetDuration,
      style: "benchmark-high-energy-four-domain-commercial-3d-v2.6.0",
      llmModel,
      imageModelId,
      videoModelId,
      cards,
      project: {
        title: "v2.6.0 四领域不同文案媒体验收",
        styleBible: "商业动画电影级3D，高能语义包装，图文导演注释版参考图，视频全屏连续动画。",
        segments: cards.map((card) => ({
          id: card.id,
          order: card.order,
          title: card.label,
          narration: card.narration,
          storyboardImagePrompt: card.imagePrompt,
          videoPrompt: card.videoPrompt,
          durationSeconds: targetDuration,
          imageStatus: card.imageStatus,
          imageUrl: card.imageUrl,
          videoStatus: card.videoStatus,
          videoUrl: card.videoUrl,
          videoTaskId: card.videoTaskId,
          videoProgress: 100,
        })),
      },
    },
    promptAudit,
    localArtifacts,
  };
  const reviewFile = path.join(publicDir, `${reviewId}.json`);
  await writeFile(reviewFile, JSON.stringify(review, null, 2), "utf8");
  await writeFile(path.join(tmpDir, `${reviewId}.json`), JSON.stringify(review, null, 2), "utf8");
  log({
    phase: "done",
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    promptAudit,
    localArtifacts,
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ at: new Date().toISOString(), phase: "failed", message: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
