import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  collectWorkflowInputs,
  WorkflowGraphSchema,
} from "../src/lib/workflow-schema";

const marker = "[PRD-E2E-20260823-CANVAS]";

async function main() {
  const [
    manualCanvas,
    freeCanvasShell,
    persistRoute,
    studioCanvasTypes,
    officialCanvasRoute,
    canvasShareShowcase,
    officialInspirationGallery,
    youcaiFreeCanvasRoute,
    newWorkspaceRoute,
    legacyShowcaseWorkspaceRoute,
    legacyInspirationWorkspaceRoute,
    ownedContentRoute,
  ] = await Promise.all([
    readFile("src/components/manual-canvas.tsx", "utf8"),
    readFile("src/components/free-canvas-shell.tsx", "utf8"),
    readFile("src/app/api/bridge/image/persist/route.ts", "utf8"),
    readFile("src/lib/studio-canvas-types.ts", "utf8"),
    readFile("src/features/official-core-routes/official-canvas-route.tsx", "utf8"),
    readFile("src/features/official-inspiration/canvas-share-showcase.tsx", "utf8"),
    readFile("src/features/official-inspiration/official-inspiration-gallery.tsx", "utf8"),
    readFile("src/app/youcai/free-canvas/page.tsx", "utf8"),
    readFile("src/app/youcai/tools/canvas/workspace/new/page.tsx", "utf8"),
    readFile("src/app/youcai/tools/canvas/workspace/[showcaseId]/page.tsx", "utf8"),
    readFile("src/app/youcai/tools/canvas/workspace/inspiration/[itemId]/page.tsx", "utf8"),
    readFile("src/app/api/storage/files/[id]/content/route.ts", "utf8"),
  ]);

  const graph = WorkflowGraphSchema.parse({
    schemaVersion: 1,
    id: "canvas-production-fix-verification",
    name: marker,
    updatedAt: "2026-08-24T00:00:00.000Z",
    nodes: [
      {
        id: "audio",
        type: "workflow",
        position: { x: 0, y: 0 },
        data: {
          kind: "upload",
          sourceMediaKind: "music",
          title: "音乐节点",
          prompt: "背景音乐",
          outputText: "",
          outputUrl: "/short-drama/example.m4a",
          taskId: "",
          assetId: "asset-music",
          storageKey: "canvas/audio/asset-music.m4a",
          historyRecordId: "history-music",
          completedAt: "2026-08-24T00:00:01.000Z",
          providerContentUrl: "",
          modelId: "",
          aspectRatio: "9:16",
          durationSeconds: 5,
          resolution: "720p",
          imageMode: "text-to-image",
          imageCount: 1,
          videoMode: "first-frame",
          status: "succeeded",
          history: [{
            id: "music-history",
            outputUrl: "/short-drama/example.m4a",
            assetId: "asset-music",
            storageKey: "canvas/audio/asset-music.m4a",
            historyRecordId: "history-music",
            createdAt: "2026-08-24T00:00:01.000Z",
          }],
        },
      },
      {
        id: "image",
        type: "workflow",
        position: { x: 500, y: 0 },
        data: {
          kind: "image",
          title: "图片节点",
          prompt: marker,
          outputText: "",
          outputUrl: "https://example.invalid/persisted.png",
          taskId: "image-task",
          providerContentUrl: "",
          modelId: "pm_image",
          publicModelName: "Public Image",
          estimatedCost: 0.2,
          actualCost: 0,
          cashRemaining: 20,
          billingReferenceId: "image:trace",
          assetId: "asset-image",
          storageKey: "canvas/image/asset-image.png",
          historyRecordId: "history-image",
          completedAt: "2026-08-24T00:00:01.000Z",
          aspectRatio: "9:16",
          durationSeconds: 5,
          resolution: "1K",
          imageMode: "text-to-image",
          imageCount: 1,
          videoMode: "first-frame",
          status: "succeeded",
          history: [{
            id: "image-history",
            outputUrl: "https://example.invalid/persisted.png",
            modelId: "pm_image",
          publicModelName: "Public Image",
          actualCost: 0,
          billingReferenceId: "image:image-task",
          assetId: "asset-image",
            storageKey: "canvas/image/asset-image.png",
            historyRecordId: "history-image",
            createdAt: "2026-08-24T00:00:01.000Z",
          }],
        },
      },
      {
        id: "video",
        type: "workflow",
        position: { x: 1000, y: 0 },
        data: {
          kind: "video",
          title: "视频节点",
          prompt: marker,
          outputText: "",
          outputUrl: "",
          taskId: "video-task",
          clientRequestId: "canvas-video-00000000-0000-4000-8000-000000000000",
          clientRequestFingerprint: "fingerprint",
          providerContentUrl: "",
          modelId: "pm_video",
          publicModelName: "Public Video",
          estimatedCost: 0.2,
          actualCost: 0,
          cashRemaining: 20,
          billingReferenceId: "video:video-task",
          aspectRatio: "9:16",
          durationSeconds: 5,
          resolution: "720p",
          imageMode: "text-to-image",
          imageCount: 1,
          videoMode: "first-frame",
          status: "running",
          history: [],
        },
      },
    ],
    edges: [
      { id: "audio-video", source: "audio", target: "video" },
      { id: "image-video", source: "image", target: "video" },
    ],
  });

  const roundTrip = WorkflowGraphSchema.parse(JSON.parse(JSON.stringify(graph)));
  const imageData = roundTrip.nodes.find((node) => node.id === "image")!.data;
  const videoData = roundTrip.nodes.find((node) => node.id === "video")!.data;
  const audioData = roundTrip.nodes.find((node) => node.id === "audio")!.data;
  assert.equal(audioData.sourceMediaKind, "music");
  assert.equal(audioData.assetId, "asset-music");
  assert.equal(audioData.storageKey, "canvas/audio/asset-music.m4a");
  assert.equal(audioData.historyRecordId, "history-music");
  assert.equal(audioData.history[0]?.assetId, "asset-music");
  assert.equal(imageData.assetId, "asset-image");
  assert.equal(imageData.storageKey, "canvas/image/asset-image.png");
  assert.equal(imageData.historyRecordId, "history-image");
  assert.equal(imageData.actualCost, 0);
  assert.equal(imageData.history[0]?.billingReferenceId, "image:image-task");
  assert.equal(videoData.taskId, "video-task");
  assert.match(videoData.clientRequestId || "", /^canvas-video-/u);

  const inputs = collectWorkflowInputs(graph, "video");
  assert.deepEqual(inputs.imageUrls, ["https://example.invalid/persisted.png"], "音频/音乐 upload 不得被误作视频首帧");
  assert.deepEqual(inputs.audioUrls, ["/short-drama/example.m4a"], "音频/音乐连线必须保留独立执行语义");
  assert.equal(inputs.audioSources[0]?.sourceMediaKind, "music");

  assert.match(manualCanvas, /sourceMediaKind === "audio"/u);
  assert.match(manualCanvas, /addNode\("upload", "audio"\)/u);
  assert.match(manualCanvas, /addNode\("upload", "music"\)/u);
  assert.match(manualCanvas, /<audio src=\{data\.outputUrl\} controls preload="metadata"/u);
  assert.match(manualCanvas, /enabled: true,[\s\S]*clientRequestFingerprint/u);
  assert.match(manualCanvas, /const serverIdempotencyVerified = model\.provider === "autodl_h3_selfhost"/u);
  assert.match(manualCanvas, /const retryable = serverIdempotencyVerified[\s\S]*response\.status === 429/u);
  assert.match(manualCanvas, /!serverIdempotencyVerified && \(response\.status === 408 \|\| response\.status === 425 \|\| response\.status === 429 \|\| response\.status >= 500\)/u);
  assert.match(manualCanvas, /停止自动重提以避免重复任务或扣费/u);
  assert.match(manualCanvas, /clientIdempotencyKey[\s\S]*strictSingleSubmit: true[\s\S]*noRetry: true/u);
  assert.match(manualCanvas, /taskId\?: string;[\s\S]*traceId\?: string;/u);
  assert.match(manualCanvas, /taskId: generatedTraceId/u);
  assert.match(manualCanvas, /returnedOperationId = generated\.operationId\?\.trim\(\) \|\| ""[\s\S]*returnedBillingReferenceId = generated\.billingReferenceId\?\.trim\(\)[\s\S]*`image:\$\{returnedOperationId\}`/u);
  assert.match(manualCanvas, /!candidateAssetId \|\| !candidateStorageKey \|\| !returnedOperationId/u, "Canvas must require the server-owned operation and permanent asset before delivery");
  assert.match(manualCanvas, /imageRequestFingerprint = JSON\.stringify/u);
  assert.match(manualCanvas, /canResumePersistence[\s\S]*pendingPersistUrl/u);
  assert.match(manualCanvas, /pendingPersistUrl: candidateUrl[\s\S]*pendingPersistCharge: generatedCharge/u);
  assert.match(manualCanvas, /重试永久保存，不会重新生成或扣费/u);
  assert.match(manualCanvas, /batchIndex: index/u);
  assert.match(manualCanvas, /audio_url: inputs\.audioUrls\[0\]/u);
  assert.match(manualCanvas, /reference_audio_urls: inputs\.audioUrls\.slice/u);
  assert.match(manualCanvas, /audioRefs: inputs\.audioUrls\.map/u);
  assert.match(manualCanvas, /submitted\.cashCharged \?\? submitted\.priceCharged \?\? submitted\.price/u);
  assert.match(manualCanvas, /&& !node\.data\.clientRequestId\)/u);
  assert.match(manualCanvas, /activeNodeRunsRef\.current\.has\(nodeId\)/u);
  assert.match(manualCanvas, /activeNodeRunsRef\.current\.has\(id\)/u);
  assert.match(manualCanvas, /source\.data\.kind === "upload" && !isAudioUpload\(source\.data\)/u);
  assert.match(manualCanvas, /actualCost: generatedCharge/u);
  assert.match(manualCanvas, /actualCost = polled\.priceCharged/u);
  assert.doesNotMatch(manualCanvas, /assetId: uploaded\.file\?\.id \|\| uploaded\.file\?\.key/u, "storage key 不得冒充个人资产 ID");
  const refreshBlock = manualCanvas.slice(
    manualCanvas.indexOf("const candidates = nodesRef.current.flatMap"),
    manualCanvas.indexOf("}, [activeCanvasId, hydrated]);", manualCanvas.indexOf("const candidates = nodesRef.current.flatMap")),
  );
  assert.match(refreshBlock, /\/api\/bridge\/image\/persist\?assetId=\$\{encodeURIComponent\(assetId\)\}/u);
  assert.match(refreshBlock, /Authorization: `Bearer \$\{token\}`/u);
  assert.match(refreshBlock, /payload\.assetId !== assetId \|\| payload\.storageKey !== storageKey/u);
  assert.match(refreshBlock, /new URL\(payload\.url \|\| "", window\.location\.origin\)/u);
  assert.match(refreshBlock, /refreshedProtocol !== "http:" && refreshedProtocol !== "https:"/u);
  assert.match(refreshBlock, /const refreshedUrl = refreshed\.toString\(\)/u);
  assert.match(refreshBlock, /outputUrl: refreshedUrl/u);
  assert.doesNotMatch(refreshBlock, /response\.blob\(\)|URL\.createObjectURL|blob:/u, "canonical 工作流 URL 不得变成仅浏览器可见的 blob URL");
  const audioUploadBlock = manualCanvas.slice(
    manualCanvas.indexOf("if (isAudioUpload(targetNode.data))"),
    manualCanvas.indexOf("} else {", manualCanvas.indexOf("if (isAudioUpload(targetNode.data))")),
  );
  assert.match(audioUploadBlock, /fetch\("\/api\/bridge\/image\/persist"/u);
  assert.match(audioUploadBlock, /mediaKind: targetNode\.data\.sourceMediaKind === "music" \? "music" : "audio"/u);
  assert.match(audioUploadBlock, /!persisted\.url \|\| !persisted\.assetId \|\| !persisted\.storageKey \|\| !persisted\.historyRecordId/u);
  assert.doesNotMatch(audioUploadBlock, /\/api\/storage\/upload/u, "音频/音乐不得走不建 ownership 的通用上传接口");
  const duplicateBlock = manualCanvas.slice(
    manualCanvas.indexOf("const duplicateSelectedNode"),
    manualCanvas.indexOf("const tidyCanvas", manualCanvas.indexOf("const duplicateSelectedNode")),
  );
  for (const field of [
    "taskId", "clientRequestId", "imageClientTraceId", "pendingPersistUrl",
    "publicModelName", "modelLocked", "lockedModelId", "actualCost",
    "billingReferenceId", "assetId", "storageKey", "historyRecordId",
    "completedAt", "progressMessage", "generationBlockedReason", "history",
  ]) {
    assert.match(duplicateBlock, new RegExp(`${field}:`, "u"), `复制节点必须清理 ${field}`);
  }
  assert.match(freeCanvasShell, /provider: "platform_public"/u);
  assert.match(freeCanvasShell, /record\.displayName \|\| record\.name/u);
  assert.match(freeCanvasShell, /record\.publicPrice \?\? record\.selling_price/u);
  assert.match(freeCanvasShell, /capabilities\.resolutionOptions/u);
  assert.match(freeCanvasShell, /minReferenceAudios: Math\.max\(0, Number\(capabilities\.minReferenceAudios\) \|\| 0\)/u);
  assert.match(freeCanvasShell, /consumeInspirationCanvasReference\(\)/u);
  assert.match(freeCanvasShell, /<ManualCanvas/u);
  assert.match(studioCanvasTypes, /minReferenceAudios\?: number;/u);
  assert.match(officialCanvasRoute, /href=\{`\/youcai\/share\/canvas\/\$\{showcase\.id\}`\}/u);
  assert.doesNotMatch(officialCanvasRoute, /href=\{`\/share\/canvas\//u, "漫剧画布入口不得落到会重定向首页的 legacy route");
  assert.match(officialCanvasRoute, /authenticated[\s\S]*\? "\/youcai\/free-canvas"[\s\S]*\/login\?redirect=%2Fyoucai%2Ffree-canvas/u);
  assert.match(canvasShareShowcase, /saveCanvasShowcaseReference\(showcase\)[\s\S]*router\.push\(`\/youcai\/free-canvas\?showcase=\$\{encodeURIComponent\(showcase\.id\)\}`\)/u);
  assert.doesNotMatch(canvasShareShowcase, /router\.push\(`\/youcai\/tools\/canvas\/workspace\//u, "示例复制不得进入静态 CanvasShareShowcase 工作区");
  assert.match(canvasShareShowcase, /href="\/youcai\/tools\/canvas"/u);
  assert.match(officialInspirationGallery, /saveInspirationCanvasReference\(item\)[\s\S]*router\.push\("\/youcai\/free-canvas"\)/u);
  assert.doesNotMatch(officialInspirationGallery, /router\.push\(`\/youcai\/tools\/canvas\/workspace\/inspiration\//u, "灵感素材继续创作不得进入静态工作区");
  assert.match(youcaiFreeCanvasRoute, /import \{ FreeCanvasShell \} from "@\/components\/free-canvas-shell";/u);
  assert.match(youcaiFreeCanvasRoute, /return <FreeCanvasShell expectedShowcaseId=\{expectedShowcaseId\} \/>;/u);
  assert.doesNotMatch(youcaiFreeCanvasRoute, /redirect\(|CanvasShareShowcase/u, "有彩自由画布入口必须直接挂载真实 ManualCanvas 执行链");
  assert.match(newWorkspaceRoute, /redirect\("\/youcai\/free-canvas"\)/u);
  assert.doesNotMatch(newWorkspaceRoute, /CanvasShareShowcase|NEW_CANVAS/u, "新建入口不得用静态画布冒充真实工作台");
  assert.match(legacyShowcaseWorkspaceRoute, /<CanvasShowcaseEditorEntry showcase=\{showcase\} \/>/u);
  assert.doesNotMatch(
    legacyShowcaseWorkspaceRoute,
    /redirect\(|<CanvasShareShowcase/u,
    "旧示例工作区必须兼容转入真实可编辑画布，不得退回只读分享页",
  );
  assert.match(legacyInspirationWorkspaceRoute, /redirect\("\/youcai\/free-canvas"\)/u);
  assert.doesNotMatch(legacyInspirationWorkspaceRoute, /<CanvasShareShowcase/u, "旧灵感工作区必须兼容转入真实工作台");
  assert.match(manualCanvas, /videoAudioMinimumMissing/u);
  assert.match(manualCanvas, /function getVideoAudioReferenceLimits[\s\S]*Math\.min\(max, model\?\.minReferenceAudios \|\| 0\)/u);
  assert.match(manualCanvas, /inputs\.audioUrls\.length < minReferenceAudios/u);
  assert.match(manualCanvas, /audioSources\.filter\(\(source\) => Boolean\(source\.data\.outputUrl\)\)\.length < audioReferenceLimits\.min/u);
  assert.match(manualCanvas, /availableAudioInputs < audioReferenceLimits\.min/u);
  assert.doesNotMatch(manualCanvas, /audio\/opus/u, "上传控件不得宣称支持校验器未支持的 OPUS MIME");

  const interruptedBlock = manualCanvas.slice(
    manualCanvas.indexOf("function normalizeInterruptedNodeStates"),
    manualCanvas.indexOf("function makeCanvasSession", manualCanvas.indexOf("function normalizeInterruptedNodeStates")),
  );
  assert.match(interruptedBlock, /node\.data\.kind === "image"[\s\S]*status: "failed"/u);
  assert.match(interruptedBlock, /node\.data\.pendingPersistUrl[\s\S]*imageClientTraceId[\s\S]*imageClientIdempotencyKey/u);
  assert.match(interruptedBlock, /node\.data\.kind === "video"[\s\S]*if \(node\.data\.taskId\)[\s\S]*status: "idle"/u);
  assert.match(interruptedBlock, /status: node\.data\.clientRequestId \? "failed" : "idle"/u);
  assert.ok((manualCanvas.match(/normalizeInterruptedNodeStates\(/gu) || []).length >= 3, "会话与 legacy graph hydration 都必须规范化中断态");

  const executeCatchBlock = manualCanvas.slice(
    manualCanvas.indexOf("const latestNode = nodesRef.current.find((item) => item.id === nodeId)"),
    manualCanvas.indexOf("if (error instanceof VideoPollingDeferredError)", manualCanvas.indexOf("const latestNode = nodesRef.current.find((item) => item.id === nodeId)")),
  );
  assert.match(executeCatchBlock, /latestNode\?\.data\.outputUrl[\s\S]*status: "failed"[\s\S]*outputUrl: latestNode\.data\.outputUrl[\s\S]*throw error/u);
  assert.doesNotMatch(executeCatchBlock, /status: "succeeded"/u, "部分输出不得被误标成功");
  assert.match(manualCanvas, /completedNode\.data\.status !== "succeeded" \|\| !completedMedia/u);
  assert.match(manualCanvas, /completedNode\.data\.kind === "video" && completedNode\.data\.playbackStatus !== "ready"/u);
  const batchSkipBlock = manualCanvas.slice(
    manualCanvas.indexOf("const hasPersistedMedia = Boolean(node.data.outputUrl)"),
    manualCanvas.indexOf("const parents = edgesRef.current", manualCanvas.indexOf("const hasPersistedMedia = Boolean(node.data.outputUrl)")),
  );
  assert.match(batchSkipBlock, /hasAcceptedMedia[\s\S]*node\.data\.kind !== "video" \|\| node\.data\.playbackStatus === "ready"/u);
  assert.match(batchSkipBlock, /node\.data\.status === "succeeded" && hasAcceptedMedia/u);
  const allMediaCompletedBlock = manualCanvas.slice(
    manualCanvas.indexOf("const allMediaCompleted = runtime"),
    manualCanvas.indexOf("updateRunRecord(runId", manualCanvas.indexOf("const allMediaCompleted = runtime")),
  );
  assert.match(allMediaCompletedBlock, /node\.data\.kind !== "video" \|\| node\.data\.playbackStatus === "ready"/u);
  const downloadBlock = manualCanvas.slice(
    manualCanvas.indexOf("async function saveWorkflowAsset"),
    manualCanvas.indexOf("function exportGraph", manualCanvas.indexOf("async function saveWorkflowAsset")),
  );
  assert.match(downloadBlock, /node\.data\.assetId && token/u);
  assert.match(downloadBlock, /\/api\/storage\/files\/\$\{encodeURIComponent\(node\.data\.assetId\)\}\/content\?download=1/u);
  assert.match(downloadBlock, /Authorization: `Bearer \$\{token\}`/u);
  assert.match(downloadBlock, /await downloadResponse\(response\)/u);
  assert.match(ownedContentRoute, /verifyToken\(token\)/u);
  assert.match(ownedContentRoute, /\.eq\("id", id\)[\s\S]*\.eq\("user_id", user\.userId\)/u);
  assert.match(ownedContentRoute, /file\.storage_key[\s\S]*file\.storage_provider/u);
  assert.match(ownedContentRoute, /storageManager\.getSignedUrl/u);
  assert.match(ownedContentRoute, /request\.nextUrl\.searchParams\.get\("download"\) === "1"/u);
  assert.match(ownedContentRoute, /download \? "attachment" : "inline"/u);

  const postRouteBlock = persistRoute.slice(persistRoute.indexOf("export async function POST"));
  assert.match(postRouteBlock, /verifyToken\(token\)/u);
  assert.ok(postRouteBlock.indexOf("verifyToken(token)") < postRouteBlock.indexOf("request.text()"), "POST 认证必须早于读取大媒体请求体");
  assert.match(postRouteBlock, /createHash\("sha256"\)[\s\S]*user\.userId/u);
  assert.match(postRouteBlock, /safeFetch\(parsedUrl/u);
  assert.match(postRouteBlock, /allowedContentTypes: \[mediaKind === "image" \? "image\/\*" : "audio\/\*"\]/u);
  assert.match(postRouteBlock, /requireOwnershipRecord: true/u);
  assert.match(postRouteBlock, /providerType: "tencent_cos" as const/u);
  assert.match(postRouteBlock, /strictProvider: true/u);
  assert.match(persistRoute, /mediaKind: z\.enum\(\["image", "audio", "music"\]\)/u);
  assert.match(postRouteBlock, /category: mediaKind === "image" \? "image" as const : "audio" as const/u);
  assert.match(postRouteBlock, /from\("user_files"\)/u);
  assert.match(postRouteBlock, /if \(!assetLookup\.data\?\.id\)/u);
  assert.match(postRouteBlock, /from\("conversation_messages"\)/u);
  assert.match(postRouteBlock, /idempotentReplay: true/u);
  assert.match(postRouteBlock, /assetId: String\(existingAsset\.data\.id\)/u);
  assert.match(postRouteBlock, /type: mediaKind === "image" \? "image_gallery" : "audio_gallery"/u);
  assert.match(postRouteBlock, /mediaKind === "image" \? \{ images: \[persistedEntry\] \} : \{ audios: \[persistedEntry\] \}/u);
  assert.match(persistRoute, /export async function GET\(request: Request\)/u);
  const accessRouteBlock = persistRoute.slice(
    persistRoute.indexOf("export async function GET"),
    persistRoute.indexOf("export async function POST"),
  );
  assert.match(accessRouteBlock, /\.eq\("id", assetId\)[\s\S]*\.eq\("user_id", user\.userId\)/u);
  assert.match(accessRouteBlock, /select\("id,storage_key,storage_provider"\)/u);
  assert.match(accessRouteBlock, /signedAssetUrl\([\s\S]*asset\.data\.storage_provider/u);
  assert.match(postRouteBlock, /url: replayUrl/u);
  assert.match(postRouteBlock, /url: accessUrl/u);
  assert.match(postRouteBlock, /temporary: false/u);
  assert.doesNotMatch(postRouteBlock, /\bstored\.url\b/u, "私有 provider 的空 stored.url 不得写入历史或响应");
  assert.doesNotMatch(postRouteBlock, /uploadFromUrl/u, "远程图片必须先下载并验证实际图片内容");
  assert.doesNotMatch(postRouteBlock, /assetLookup\.data\?\.id \|\| stored\.key/u, "永久资产 ID 不得回退为 storageKey");
  assert.doesNotMatch(postRouteBlock, /base64,\(\[\\s\\S\]\+\)/u, "不得重新引入大 data URL 全量正则捕获");

  console.log(JSON.stringify({
    ok: true,
    marker,
    checks: {
      audioMusicSemanticRoundTrip: true,
      audioExcludedFromImageInputs: true,
      audioForwardedToVideoRequest: true,
      permanentImageOwnershipAndHistory: true,
      imageTaskAndPersistenceResumeKeysPersisted: true,
      persistedAssetSignedUrlRefreshByOwnership: true,
      canonicalWorkflowUrlRemainsHttp: true,
      audioMusicPermanentOwnership: true,
      storedUrlForbidden: true,
      canvasMediaStrictBridgeableProvider: true,
      minAudioPreflight: true,
      interruptedStateRecovery: true,
      partialOutputRemainsFailed: true,
      batchSuccessRequiresTerminalAndPlayback: true,
      ownedMediaDownloadUsesControlledContent: true,
      publicVideoAmbiguousRetryGuard: true,
      videoSingleFlightAndActualCharge: true,
      duplicateClearsRuntimeBillingAssetState: true,
      taskAssetBillingNodeRoundTrip: true,
      youcaiRoutesUseRealManualCanvas: true,
      showcaseAndInspirationCopyUseNaturalManualCanvasHandoff: true,
      staticWorkspaceCompatibilityRedirectsToManualCanvas: true,
    },
  }, null, 2));
}

void main();
