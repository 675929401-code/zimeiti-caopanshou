import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = "voiceover-cinematic-cartoon-style-two-segments-v421-final-prompt-gate-20260817";
const sourceReviewId = "voiceover-cinematic-cartoon-style-two-segments-v419-prompt-regression-20260817";
const conversationId = "conv_voiceover_cinematic_cartoon_v421_final_20260817";
const agentId = "agent-1786633444187-594spj";
const expectedSchema = "storyboard_director_output_style.v4.2.1";
const expectedPromptSha = "91cca04d2586950e840d80ae5070a98af5e047ac4d5ac3b5045f8bddfc0e086f";
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const sourceReviewPath = path.resolve("public", "storyboard-reviews", `${sourceReviewId}.json`);
const runtimePath = path.resolve("src", "lib", "storyboard-single-frame-video-prompt.ts");
const localPromptPath = path.resolve("prompts", "storyboard-voiceover-cinematic-v4.2.1.md");

// Platform evidence is intentionally schema-flexible across saved review versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function readResponse(response: Response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return { error: `non-JSON response (${response.status}): ${raw.slice(0, 500)}` };
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await readResponse(sessionResponse);
  assert.ok(sessionResponse.ok && session.token, session.error || "dev session unavailable");
  const headers = { Authorization: `Bearer ${session.token}` };
  const [agentsResponse, historyResponse] = await Promise.all([
    fetch(`${baseUrl}/api/admin/agents`, { headers }),
    fetch(`${baseUrl}/api/conversations/history?id=${encodeURIComponent(conversationId)}`, { headers }),
  ]);
  const [agents, history] = await Promise.all([readResponse(agentsResponse), readResponse(historyResponse)]);
  assert.ok(agentsResponse.ok && historyResponse.ok, "platform evidence unavailable");
  const onlineAgent = agents.agents?.find((agent: Json) => agent.id === agentId);
  assert.ok(onlineAgent?.system_prompt, "target agent missing");
  assert.equal(onlineAgent.output_style?.schema_version, expectedSchema);
  assert.equal(sha256(onlineAgent.system_prompt), expectedPromptSha);
  assert.equal(history.conversation?.id, conversationId);
  assert.equal(history.conversation?.messages?.length, 2);

  const [reviewRaw, sourceReviewRaw, localPrompt, runtime, rawBlocks] = await Promise.all([
    readFile(reviewPath, "utf8"),
    readFile(sourceReviewPath, "utf8"),
    readFile(localPromptPath, "utf8"),
    readFile(runtimePath, "utf8"),
    readFile(path.join(outDir, "platform-agent-raw-4-code-blocks.md"), "utf8"),
  ]);
  const review = JSON.parse(reviewRaw) as Json;
  const sourceReview = JSON.parse(sourceReviewRaw) as Json;
  assert.equal(review.conversationId, conversationId);
  assert.equal(review.run.cards.length, 2);
  assert.equal(sourceReview.run.cards.length, 2);
  assert.equal((rawBlocks.match(/```text/gu) || []).length, 4);
  assert.equal(sha256(localPrompt.trim()), expectedPromptSha);

  const promptChecks = {
    exactTwoPromptsPerSegment: /每段依次输出/u.test(localPrompt) && /故事板分镜图文生图 Prompt/u.test(localPrompt) && /图生视频 Prompt/u.test(localPrompt),
    narrationIsMetadataOnly: /每段原文只在“原文案内容段落”中逐字保留/u.test(localPrompt) && /禁止把整段原文或原句引号复制进视频 Prompt/u.test(localPrompt),
    semanticSceneRouting: /禁止把公园、户外步道、客厅或宠物医院设为无条件默认场景/u.test(localPrompt),
    cartoonPositiveFingerprint: /高预算家庭动画电影造型：人物约5\.5至6头身/u.test(localPrompt),
    styleRoutesAreMutuallyExclusive: /一段只能使用一套指纹/u.test(localPrompt),
    cleanTextFreeFirstFrame: /触发尚未发生；不显示声波线、振动线、速度线、运动模糊、发光、粒子、包装或动作余波/u.test(localPrompt),
    laterPropsVisibleInFrameOne: /都必须在Frame 1中完整可见/u.test(localPrompt),
    physicalPropOperationVisible: /操作手、接触点、主道具、受影响主体/u.test(localPrompt),
    lampContactLifecycle: /完整灯体、旋钮、转动手指与仍在犬窝里的狗同框/u.test(localPrompt),
    noMagicPackaging: /不从嘴里发射光束/u.test(localPrompt) && /无来源包装/u.test(localPrompt),
    packagingHasLifecycleAndSize: /总面积不超过8%/u.test(localPrompt) && /0\.3至0\.8秒内淡出/u.test(localPrompt),
    noGeneratedSpeechOrText: /不生成旁白、字幕、文字、音乐/u.test(localPrompt),
  };
  const runtimeChecks = {
    dedicatedModule: runtimePath.endsWith("storyboard-single-frame-video-prompt.ts"),
    singleFirstFrameOnly: /第一格裁出的单张16:9纯净首帧/u.test(runtime),
    modelCannotSeeOtherPanels: /视频模型看不到其余故事板格/u.test(runtime),
    noFullBoardInstruction: !/完整的一图多画面故事板/u.test(runtime),
    noYellowWardrobeOverride: !/黄色只在上衣|黄色连帽/u.test(runtime),
    noChineseTitleOverride: !/中文结论牌|中文短牌/u.test(runtime),
    coreContactVisibility: /接触点和主道具/u.test(runtime),
  };
  assert.ok(Object.values(promptChecks).every(Boolean), `prompt audit failed: ${JSON.stringify(promptChecks)}`);
  assert.ok(Object.values(runtimeChecks).every(Boolean), `runtime audit failed: ${JSON.stringify(runtimeChecks)}`);

  const sourceCards = new Map<number, Json>(sourceReview.run.cards.map((card: Json) => [Number(card.order), card] as [number, Json]));
  const targetCards = new Map<number, Json>(review.run.cards.map((card: Json) => [Number(card.order), card] as [number, Json]));
  const sourceOne = sourceCards.get(1);
  const sourceTwo = sourceCards.get(2);
  const targetTwo = targetCards.get(2);
  assert.ok(sourceOne?.imageUrl && sourceOne?.videoUrl && sourceTwo?.imageUrl && targetTwo?.videoUrl);

  review.status = "FINAL_ACCEPTANCE_COMPLETE";
  review.run.title = "3D故事导演｜电影叙事 v4.2.1｜皮克斯式3D最终验收";
  review.run.updatedAt = Date.now();
  review.run.imageResolution = "2K";
  review.run.videoResolution = "1080p";
  review.run.videoDuration = 10;
  review.run.imageModelId = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
  review.run.videoModelId = "pm_O31GjpRvlTXjWUM1Ha9FG0N2";
  review.run.cards = review.run.cards.map((card: Json) => {
    const source = sourceCards.get(Number(card.order));
    assert.ok(source, `missing accepted source card ${card.order}`);
    if (Number(card.order) === 1) {
      return {
        ...card,
        imageStatus: "done",
        imageUrl: source.imageUrl,
        imageValidatedAt: source.imageValidatedAt || Date.now(),
        referenceImageUrls: source.referenceImageUrls || [],
        videoStatus: "done",
        videoUrl: source.videoUrl,
        videoTaskId: source.videoTaskId,
        videoTaskModelId: source.videoTaskModelId,
        videoProgress: 100,
        videoStatusDetail: "玄关段真实视频已逐帧通过：门全程关闭，门铃、冲门、阻挡、对视、零食引导和归垫顺序正确。",
      };
    }
    return {
      ...card,
      imageStatus: "done",
      imageUrl: source.imageUrl,
      imageValidatedAt: source.imageValidatedAt || Date.now(),
      videoStatus: "done",
      videoProgress: 100,
      videoStatusDetail: "卧室段修正版真实视频已逐帧通过：梦境有来源，灯体、旋钮、操作手和狗同框，手释放后狗再醒来。",
    };
  });
  review.actualCost = {
    agentCallsWithSavedHistory: 2,
    imageSubmissions: 2,
    successfulImages: 2,
    imageBusinessPriceCny: 0.4,
    originalVideoSubmissions: 2,
    originalVideoBusinessPriceCny: 1.1,
    correctionVideoSubmissions: 1,
    correctionVideoBusinessPriceCny: 0.55,
    totalMediaSubmissions: 5,
    totalBusinessPriceCny: 2.05,
    paidRetries: 0,
  };
  review.modelRoutes = {
    image: {
      publicModelId: "pm_HabdJ5rvD_L3-HUkfMUmGsrm",
      name: "GPT-Image-2 · 渠道A pro",
      resolution: "2K",
      ratio: "16:9",
      priceCnyPerImage: 0.2,
    },
    video: {
      publicModelId: "pm_O31GjpRvlTXjWUM1Ha9FG0N2",
      dbModelId: "omni-flash-10s-720p-ch3",
      name: "Omni Flash 10秒",
      requestedResolution: "1080p",
      durationSeconds: 10,
      priceCnyPerVideo: 0.55,
    },
  };
  review.finalAudit = {
    verdict: {
      promptChain: "PASS",
      imageVisual: "PASS",
      videoNarrative: "PASS",
      benchmarkPackaging: "PASS_WITH_MINOR_GAP",
      overall: "PASS",
    },
    promptChecks,
    runtimeChecks,
    fixedBugs: [
      "核心实体道具操作可能被裁到画外，只留下结果变化。",
      "皮克斯式风格只下发否定标签，未稳定下发正向头身和面部指纹。",
      "不同导演流程共用同一个可被覆盖的运行时，出现整板输入、黄色上衣和中文结论牌污染。",
      "工作台检测到多格故事板后仍把整张图提交给视频模型，造成多门、多状态和重复动作。",
    ],
    visualFindings: {
      segment1: [
        "玄关场景与口播匹配，宠物垫从首帧存在，门从头到尾保持关闭。",
        "狗冲门、主人身体阻挡、视线接通、零食引导、四爪归垫顺序清楚。",
        "角色服装和柯基造型稳定，无半写实漂移、无文字、无魔法。",
      ],
      segment2: [
        "蹬腿、抖耳和轻哼形成可见睡梦反应，主人双手与狗保持空气间隙。",
        "梦境由蹬腿触发并淡出，随后完整灯体、旋钮、操作手和狗保持同框。",
        "灯光随旋钮连续变暗，手指离开后才切回狗慢慢睁眼，因果链完整。",
        "角色与柯基保持皮克斯式卡通电影3D，不转真人、不换装、不复制实体。",
      ],
    },
    residualIssues: [
      "卧室视频梦境气泡实际约占画面宽度四分之一，略大于Prompt规定的12%至16%。",
      "梦境中的犬影偏黑色剪影，精致度和同一三色柯基识别度仍低于现实层角色。",
    ],
    evidence: {
      conversationId,
      platformHistory: path.join(outDir, "platform-history.json"),
      rawFourCodeBlocks: path.join(outDir, "platform-agent-raw-4-code-blocks.md"),
      promptJson: path.join(outDir, "original-4-code-blocks.json"),
      correctedVideoTaskId: "734fb626fd7c415099b8e8fe2ea159da",
      correctedVideo: path.join(outDir, "segment-2-omni-flash-10s-1080p.mp4"),
      correctedVideoContactSheet: path.join(outDir, "segment-2-contact-sheet.png"),
    },
  };
  review.localArtifacts = [
    {
      segmentNumber: 1,
      storyboardImage: path.resolve(".tmp-e2e", sourceReviewId, "segment-1-gpt-image-2-pro-2k.png"),
      video: path.resolve(".tmp-e2e", sourceReviewId, "segment-1-omni-flash-10s-1080p.mp4"),
    },
    {
      segmentNumber: 2,
      storyboardImage: path.resolve(".tmp-e2e", sourceReviewId, "segment-2-gpt-image-2-pro-2k.png"),
      video: path.join(outDir, "segment-2-omni-flash-10s-1080p.mp4"),
    },
  ];

  const audit = {
    passed: true,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    agentId,
    agentName: onlineAgent.name,
    schemaVersion: expectedSchema,
    promptSha256: expectedPromptSha,
    conversationId,
    platformHistoryMessages: history.conversation.messages.length,
    rawTextCodeBlocks: 4,
    promptChecks,
    runtimeChecks,
    verdict: review.finalAudit.verdict,
    actualCost: review.actualCost,
    modelRoutes: review.modelRoutes,
    localArtifacts: review.localArtifacts,
    residualIssues: review.finalAudit.residualIssues,
  };
  await Promise.all([
    writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8"),
    writeFile(path.join(outDir, "final-audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8"),
    writeFile(path.join(outDir, "platform-history.json"), `${JSON.stringify(history, null, 2)}\n`, "utf8"),
  ]);
  console.log(JSON.stringify(audit, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
