import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractionHistoryEntry } from "../src/lib/extraction-history";

const root = process.cwd();
const read = (path: string) => readFile(resolve(root, path), "utf8");

async function main() {
  const [
    wrapper,
    migration,
    reconciliation,
    downloadRoute,
    ticketRoute,
    ticketClient,
    extractPage,
    legacyTool,
    voiceWorkspace,
    semanticRoute,
    segmenterPage,
    extractRoute,
    extractionHistoryHook,
    extractionHistory,
    requestSnapshotMigration,
    toolboxCatalogRoute,
    toolboxCatalogHook,
    formatterHistoryRoute,
    segmenterHistoryRoute,
    extractBatchRoute,
    extractSearchRoute,
    unifiedModelsTab,
    adminPluginsRoute,
    cozeExtractionHandler,
  ] = await Promise.all([
    read("src/lib/extraction-exactly-once.ts"),
    read("supabase/migrations/20260901093000_extraction_attempts_exactly_once.sql"),
    read("src/app/api/extract/reconciliation/route.ts"),
    read("src/app/api/extract/download/route.ts"),
    read("src/app/api/extract/download-ticket/route.ts"),
    read("src/lib/extract-download-client.ts"),
    read("src/app/extract/page.tsx"),
    read("src/components/extract-tool.tsx"),
    read("src/app/voice-studio/workspace/page.tsx"),
    read("src/app/api/segmenter/semantic/route.ts"),
    read("src/app/segmenter/page.tsx"),
    read("src/app/api/extract/route.ts"),
    read("src/hooks/use-extraction-history.ts"),
    read("src/lib/extraction-history.ts"),
    read("supabase/migrations/20260915233500_extraction_request_snapshot.sql"),
    read("src/app/api/tools/runtime-catalog/route.ts"),
    read("src/hooks/use-tool-runtime-catalog.ts"),
    read("src/app/api/formatter/history/route.ts"),
    read("src/app/api/segmenter/history/route.ts"),
    read("src/app/api/extract/batch/route.ts"),
    read("src/app/api/extract/search/route.ts"),
    read("src/components/unified-models-tab.tsx"),
    read("src/app/api/admin/plugins/route.ts"),
    read("src/lib/coze-extraction-handler.ts"),
  ]);

  // Every authenticated provider-capable request must carry a stable identity.
  assert.match(wrapper, /EXTRACTION_CLIENT_REQUEST_ID_REQUIRED/);
  assert.match(wrapper, /EXTRACTION_CLIENT_REQUEST_ID_CONFLICT/);
  const identityGate = wrapper.slice(wrapper.indexOf("const requestIdentity"), wrapper.indexOf("const payloadFingerprint"));
  assert.match(identityGate, /return withCheckpointOnlyProof\(errorResponse/);
  assert.doesNotMatch(identityGate, /handler\(/, "request identity failure must not bypass the durable claim");
  assert.ok(wrapper.indexOf("store.claim(") < wrapper.indexOf("response = await extractionExecution.run"));
  assert.match(wrapper, /extractionExecution\.run\(\{ store, record: claimed\.record \}, \(\) => handler\(request\)\)/);

  // Completed video output is checkpointed before temporary delivery, and the
  // 30-minute local file is confirmed before idempotent settlement.
  assert.match(wrapper, /recoverFromProviderCheckpoint/);
  assert.match(wrapper, /bodyEvidence\.recovery_pending === true/);
  const cozeSettlement = extractRoute.slice(
    extractRoute.indexOf("async function persistAndSettleCozeVideos"),
    extractRoute.indexOf("async function recoverVideoFromCheckpoint"),
  );
  assert.ok(cozeSettlement.indexOf("attachTemporaryExtractionVideos") < cozeSettlement.indexOf("deductCash("));
  assert.ok(cozeSettlement.indexOf("deductCash(") < cozeSettlement.indexOf("success: true"));
  assert.match(extractRoute, /schema:\s*"coze_video_provider_result\.v1"/);
  // New video submissions use the same active Coze three-in-one plugin as
  // text, batch and search. PPT6 remains readable only for old checkpoints.
  const videoBranchStart = extractRoute.indexOf("// 视频与文案共用同一个 active coze_multifunction_extract 三合一插件");
  const videoBranchEnd = extractRoute.indexOf("// 🔒 20260914", videoBranchStart);
  assert.ok(videoBranchStart >= 0 && videoBranchEnd > videoBranchStart, "shared Coze video branch must remain explicit and bounded");
  const videoBranch = extractRoute.slice(videoBranchStart, videoBranchEnd);
  assert.match(videoBranch, /getCozeMultifunctionConfig\(\)/);
  assert.match(videoBranch, /callCozeWorkflow\(cozeVideoConfig,[\s\S]*?"video"/);
  assert.match(videoBranch, /schema:\s*"coze_video_provider_result\.v1"/);
  assert.doesNotMatch(videoBranch, /getActiveVideoExtractConfig|fetchExtractionProviderGetOnce|schema:\s*"extract_video_ppt6_result\.v1"/);
  assert.match(extractRoute, /schema:\s*"extract_video_ppt6_result\.v1"/);
  assert.match(extractRoute, /function readPpt6VideoCheckpoint/);
  assert.match(extractRoute, /recovery_pending:\s*true/);
  assert.doesNotMatch(extractRoute, /视频转存失败\(降级返回直链\)/);
  assert.match(extractRoute, /EXTRACTION_BALANCE_PRECHECK_UNAVAILABLE/);
  assert.match(extractRoute, /provider_call_started:\s*false/);
  assert.match(extractRoute, /unitPrice === 0/);
  assert.match(extractRoute, /recoverFromProviderCheckpoint:\s*recoverVideoFromCheckpoint/);
  assert.match(extractRoute, /keySuffix:\s*"coze-video"/);
  assert.match(extractRoute, /keySuffix:\s*"ppt6-video"/);
  assert.match(cozeSettlement, /const deliveredVideos = videoResults\.map/);
  assert.match(cozeSettlement, /delete deliveredVideo\.url;[\s\S]*delete deliveredVideo\.download_url/);
  assert.match(cozeSettlement, /videos: deliveredVideos/);
  assert.doesNotMatch(cozeSettlement.slice(cozeSettlement.indexOf("return NextResponse.json")), /failed:\s*failedVideos/);
  assert.doesNotMatch(cozeSettlement.slice(cozeSettlement.indexOf("return NextResponse.json")), /videos:\s*ownedVideos/);
  assert.match(extractionHistory, /PROVIDER_MEDIA_FIELDS/);
  assert.match(extractionHistory, /sanitizeVideoCandidate/);
  assert.match(extractionHistory, /response\.results\.map/);
  assert.match(extractionHistory, /text\(item\.temporary_url\) \|\| text\(item\.asset_id\)/);
  assert.match(extractRoute, /cacheExtractVideoForTemporaryOwner/);
  assert.match(extractRoute, /temporary_expires_at/);
  assert.match(extractRoute, /EXTRACTION_TEMPORARY_MEDIA_FAILED/);
  assert.doesNotMatch(extractRoute, /persistExtractionVideo/);
  assert.match(extractPage, /const hasOwnedVideo = Boolean\(videoItem\?\.asset_id\?\.trim\(\)\)/);
  assert.match(extractPage, /const temporaryVideoUrl = videoItem\?\.temporary_url \|\| ""/);
  assert.match(extractPage, /const \[currentTime, setCurrentTime\] = useState\(0\)/);
  assert.match(extractPage, /setCurrentTime\(Date\.now\(\)\)/);
  assert.match(extractPage, /window\.setTimeout\(\(\) => setCurrentTime\(Date\.now\(\)\), delay\)/);
  assert.match(extractPage, /temporaryExpiresAt <= currentTime/);
  assert.doesNotMatch(extractPage, /temporaryExpiresAt <= Date\.now\(\)/);
  assert.match(extractPage, /temporaryExtractVideoExpiresAt\(videoItem\)/);
  assert.match(extractPage, /const canPlay = hasOwnedVideo \|\| Boolean\(activeTemporaryVideoUrl\)/);
  assert.match(extractPage, /if \(temporaryExpired\)[\s\S]*setDownloadError\("临时视频已过期，请重新提取"\)/);
  assert.match(extractPage, /临时视频已过期，已停止播放、下载和复制；请重新提取/);
  assert.match(extractPage, /30分钟内可播放\/下载/);
  assert.match(extractBatchRoute, /tryCozeMultiModeExtraction\([\s\S]*?'batch'\)/);
  assert.match(extractSearchRoute, /tryCozeMultiModeExtraction\([\s\S]*?'search'\)/);
  assert.match(cozeExtractionHandler, /\.eq\("role", "coze_multifunction_extract"\)[\s\S]*?\.limit\(2\)/);
  assert.match(cozeExtractionHandler, /pluginRows\.length > 1/);
  assert.match(cozeExtractionHandler, /configuredCozeEndpoint/);
  assert.match(cozeExtractionHandler, /三合一提取插件未启用，本次未调用上游服务/);
  assert.doesNotMatch(cozeExtractionHandler, /if \(!config\) return null/);
  assert.match(extractBatchRoute, /https:\/\/apis\.ppt6\.top/);
  assert.doesNotMatch(extractBatchRoute, /http:\/\/apis\.ppt6\.top/);
  const pluginLoader = unifiedModelsTab.slice(unifiedModelsTab.indexOf("const loadPlugins"), unifiedModelsTab.indexOf("const handleSavePlugin"));
  assert.match(pluginLoader, /fetch\("\/api\/admin\/plugins\?role=coze_multifunction_extract"/);
  assert.match(pluginLoader, /setSingleTextPlugins\(plugins\)[\s\S]*setBatchTextPlugins\(plugins\)[\s\S]*setVideoPlugins\(plugins\)/);
  assert.doesNotMatch(pluginLoader, /fetch\("\/api\/admin\/plugins\?role=extract_video"/);
  assert.doesNotMatch(unifiedModelsTab, /role=extract_video/);
  assert.match(unifiedModelsTab, /视频、(?:单条)?文案、批量与搜索共用/);
  const mutuallyExclusiveRoleLists = [...adminPluginsRoute.matchAll(/const SINGLE_TEXT_EXTRACT_ROLES\s*=\s*\[([^\]]+)\]/g)];
  assert.ok(mutuallyExclusiveRoleLists.length >= 2, "POST and PUT must enforce the same plugin exclusivity contract");
  for (const [, roles] of mutuallyExclusiveRoleLists) {
    assert.match(roles, /"coze_multifunction_extract"/);
    assert.match(roles, /"extract_workflow"/);
    assert.match(roles, /"extract_text_third_party"/);
  }
  assert.match(adminPluginsRoute, /旧视频提取角色仅保留历史数据兼容/);
  assert.match(toolboxCatalogRoute, /const sharedQuote = quote\(coze, "三合一提取工作流"\)/);
  for (const tool of ["video", "text", "batch", "search"]) {
    assert.match(toolboxCatalogRoute, new RegExp(`${tool}: publicQuote\\(sharedQuote`));
  }
  assert.doesNotMatch(toolboxCatalogRoute, /quoteVideo\(|byRole\("extract_video"\)/);
  const ownedHistory = extractionHistoryEntry({
    record_id: "a".repeat(64), client_request_id: "extract-video-fixture", request_kind: "single", state: "succeeded",
    created_at: "2026-09-15T00:00:00.000Z",
    response: { success: true, videos: [{ success: true, asset_id: "asset-owned", url: "https://provider.invalid/temp.mp4", download_url: "https://provider.invalid/download.mp4" }] },
  });
  const ownedHistoryJson = JSON.stringify(ownedHistory);
  assert.doesNotMatch(ownedHistoryJson, /provider\.invalid/, "new owned history must not expose provider media URLs");
  assert.match(ownedHistoryJson, /asset-owned/, "owned history must retain the protected asset identity");
  const temporaryExpiry = Date.now() + 20 * 60 * 1000;
  const temporaryUrl = `/api/extract/local-video?file=${"a".repeat(24)}&owner=fixture-user&expires=${temporaryExpiry}&sig=${"b".repeat(64)}`;
  const temporaryHistoryJson = JSON.stringify(extractionHistoryEntry({
    record_id: "c".repeat(64), client_request_id: "extract-video-temporary", request_kind: "single", state: "succeeded",
    created_at: "2026-09-18T00:00:00.000Z",
    response: { success: true, videos: [{ success: true, title: "临时视频", cover: "https://provider.invalid/cover.jpg", temporary_url: temporaryUrl, temporary_expires_at: temporaryExpiry, url: "https://provider.invalid/temp.mp4" }] },
  }));
  assert.match(temporaryHistoryJson, /\/api\/extract\/local-video/, "temporary history must retain its signed local delivery URL");
  assert.doesNotMatch(temporaryHistoryJson, /provider\.invalid/, "temporary history must not expose provider media URLs");
  assert.doesNotMatch(temporaryHistoryJson, /asset_id/, "temporary delivery must not create a permanent asset identity");
  const legacyHistoryJson = JSON.stringify(extractionHistoryEntry({
    record_id: "b".repeat(64), client_request_id: "extract-video-legacy", request_kind: "single", state: "succeeded",
    created_at: "2026-09-14T00:00:00.000Z",
    response: { success: true, videos: [{ success: true, url: "https://legacy.invalid/video.mp4" }] },
  }));
  assert.doesNotMatch(legacyHistoryJson, /legacy\.invalid/, "legacy provider URLs must never be replayed to the browser");
  assert.match(legacyHistoryJson, /历史临时视频已过期或未保存为站内资产/, "legacy raw-only history must explain that delivery is no longer available");
  const nestedLegacyHistoryJson = JSON.stringify(extractionHistoryEntry({
    record_id: "d".repeat(64), client_request_id: "extract-text-nested", request_kind: "single", state: "succeeded",
    created_at: "2026-09-13T00:00:00.000Z",
    response: {
      source: "douyin_wtf",
      results: [{ success: true, transcript: "保留的口播文案", video: {
        desc: "保留的标题", videoUrl: "https://provider.invalid/video.mp4",
        downloadUrl: "https://provider.invalid/download.mp4", coverUrl: "https://provider.invalid/cover.jpg",
        dynamicCover: "https://provider.invalid/dynamic.jpg", avatarUrl: "https://provider.invalid/avatar.jpg",
        musicUrl: "https://provider.invalid/music.mp3",
      } }],
    },
  }));
  assert.doesNotMatch(nestedLegacyHistoryJson, /provider\.invalid/, "nested provider media fields must be removed");
  assert.match(nestedLegacyHistoryJson, /保留的口播文案/, "non-media transcript evidence must remain available");

  // Account history comes from the authenticated server only. The retired
  // browser shadow is deleted once and never hydrated or rewritten.
  assert.doesNotMatch(extractionHistoryHook, /localStorage\.setItem\(cacheKey/);
  assert.doesNotMatch(extractionHistoryHook, /localStorage\.getItem\(cacheKey/);
  assert.match(extractionHistoryHook, /localStorage\.removeItem\(cacheKey\)/);
  assert.match(extractionHistoryHook, /15_000/);
  assert.match(extractionHistoryHook, /visibilitychange/);
  assert.match(extractionHistoryHook, /window\.addEventListener\("focus"/);
  assert.match(extractPage, />\s*转为状态跟踪\s*</);
  assert.match(extractPage, /任务仍会在历史中继续处理/);
  assert.match(extractPage, /正在跟踪原请求状态/);

  // Persistence failure is bounded, visible to the caller, and reconcilable without replay.
  assert.match(wrapper, /finalizeWithRetry/);
  assert.match(wrapper, /X-Extraction-Attempt-Id/);
  assert.match(wrapper, /attempt_id/);
  assert.match(wrapper, /charged:\s*knownUncharged\s*\?\s*false\s*:\s*null/);
  assert.match(wrapper, /billing_unknown:\s*!knownUncharged/);
  assert.match(wrapper, /retry_safe:\s*false/);
  assert.match(migration, /request_kind IN \('single', 'batch', 'search', 'coze', 'semantic'\)/);
  assert.match(migration, /extraction_attempt_reconciliation_audit/);
  assert.match(migration, /list_extraction_attempts_for_reconciliation/);
  assert.match(migration, /reconcile_extraction_attempt_atomic/);
  assert.match(migration, /updated_at <= now\(\) - interval '30 minutes'/);
  assert.match(migration, /EXTRACTION_RECONCILIATION_ATTEMPT_ACTIVE/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.reconcile_extraction_attempt_atomic[\s\S]*?GRANT EXECUTE ON FUNCTION public\.reconcile_extraction_attempt_atomic[\s\S]*?TO service_role/);
  assert.match(reconciliation, /import \{ authorizeAdminCapability \} from "@\/lib\/server\/admin-governance-authority"/);
  assert.match(reconciliation, /async function requireReconciliationAccess\(/);
  assert.match(reconciliation, /authorizeAdminCapability\(request, permission, \{/);
  assert.match(reconciliation, /requireReconciliationAccess\(request, "billing\.view", false\)/, "对账读取必须要求 billing.view");
  assert.match(reconciliation, /requireReconciliationAccess\(request, "wallet\.adjust", true\)/, "人工终态修正必须要求 wallet.adjust 与二次验证");
  assert.match(reconciliation, /p_actor_user_id:\s*guard\.actor\.userId/, "对账审计必须记录统一能力鉴权返回的管理员身份");
  assert.match(reconciliation, /list_extraction_attempts_for_reconciliation/);
  assert.match(reconciliation, /reconcile_extraction_attempt_atomic/);
  assert.match(reconciliation, /provider_calls:\s*0/);
  assert.doesNotMatch(reconciliation, /\bfetch\(/, "reconciliation must never resubmit upstream work");

  // Browser playback/download exchanges Bearer auth for a short signed URL.
  assert.match(downloadRoute, /verifyExtractDownloadSignature/);
  assert.match(downloadRoute, /getTokenFromHeaders/);
  assert.match(ticketRoute, /createSignedExtractDownloadParams/);
  assert.match(ticketRoute, /getTokenFromHeaders/);
  assert.match(ticketClient, /requestExtractDownloadTicket/);
  assert.match(ticketClient, /downloadExtractMedia/);
  assert.match(ticketClient, /link\.href = ticket\.url/);
  for (const [name, ui] of Object.entries({ extractPage, legacyTool })) {
    assert.match(ui, /requestExtractDownloadTicket/, `${name} playback must request a short ticket`);
    assert.match(ui, /downloadExtractMedia/, `${name} download must use a short ticket`);
    assert.doesNotMatch(ui, /["'`]\/api\/extract\/download\?url=/, `${name} must not render an unsigned protected download URL`);
  }

  // Every browser caller of /api/extract mirrors one stable key in header and body.
  for (const [name, caller] of Object.entries({ extractPage, legacyTool, voiceWorkspace })) {
    assert.match(caller, /["']Idempotency-Key["']:\s*attempt\.clientRequestId/, `${name} missing stable Idempotency-Key`);
    assert.match(caller, /client_request_id:\s*attempt\.clientRequestId/, `${name} missing body request identity`);
  }

  // Segmenting is now a local rule-only tool. The compatibility route must
  // reject stale bundles before any provider, wallet, or attempt activity.
  assert.match(semanticRoute, /SEGMENTER_RULE_ONLY/);
  assert.match(semanticRoute, /provider_call_started:\s*false/);
  assert.match(semanticRoute, /charged:\s*false/);
  assert.match(semanticRoute, /status:\s*410/);
  assert.match(semanticRoute, /X-Segmenter-Provider-Call.*blocked/s);
  assert.doesNotMatch(semanticRoute, /runBillableSemanticSegmentation|withExtractionExactlyOnce|\bfetch\(/);
  assert.doesNotMatch(segmenterPage, /\/api\/segmenter\/semantic/);
  assert.match(segmenterPage, /segmentTextRule/);
  assert.match(segmenterPage, /分段规则：按所选时长对应的字数范围/);

  // Failed input recovery is server-only and always user-confirmed. The
  // migration can remain pending without cutting off the established main chain.
  assert.match(wrapper, /checkpoint_extraction_request_atomic/);
  assert.match(wrapper, /unactivated migration must not interrupt ordinary extraction|unactivated migration/i);
  assert.match(requestSnapshotMigration, /request_snapshot jsonb/);
  assert.match(requestSnapshotMigration, /checkpoint_extraction_request_atomic/);
  assert.match(requestSnapshotMigration, /a\.request_snapshot/);
  assert.match(extractPage, /载入原输入后重试/);
  assert.match(extractPage, /window\.confirm/);
  assert.doesNotMatch(extractionHistory, /localStorage|sessionStorage/);

  // Tool submission reads a private runtime catalog; missing paid config keeps
  // the submit buttons closed. Formatter/segmenter history is never cached.
  assert.match(toolboxCatalogRoute, /Cache-Control.*private, no-store/s);
  assert.match(toolboxCatalogRoute, /付费提交已关闭/);
  assert.match(toolboxCatalogHook, /cache:\s*"no-store"/);
  assert.match(extractPage, /通道已配置/);
  assert.doesNotMatch(extractPage, /服务状态：可用/);
  assert.match(extractPage, /publicRuntimePriceLabel/);
  assert.match(extractPage, /runtimeGate\.loading \|\| runtimeGate\.error \|\| !runtimeGate\.quote\?\.available/);
  assert.match(formatterHistoryRoute, /private, no-store/);
  assert.match(segmenterHistoryRoute, /private, no-store/);

  console.log("[extraction-commercial-closure-zero-cost] PASS: video, text, batch and search share the active Coze three-in-one plugin; new video submissions cannot enter PPT6, while legacy PPT6 checkpoint recovery, durable claim/replay, temporary media, signed playback/download, history sanitization and rule-only segmentation remain protected. No provider, wallet, remote migration, build, restart, or deployment was executed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
