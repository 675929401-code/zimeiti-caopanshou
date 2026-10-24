import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import {
  COVER_FAILURE_HISTORY_SURFACE,
  FREE_CANVAS_FAILURE_HISTORY_SURFACE,
  SHORT_DRAMA_FAILURE_HISTORY_SURFACE,
  STORYBOARD_FAILURE_HISTORY_SURFACE,
  createImageFailureRequestSnapshot,
  imageFailureBillingReferenceId,
  imageFailureRetryEligibility,
  parseImageFailureRequestSnapshot,
  parseImageTerminalFailure,
} from "../src/lib/image-failure-history";

const root = process.cwd();
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("ZERO_NETWORK_CONTRACT");
}) as typeof fetch;

async function main() {
try {
  const signedReference = "https://storage.example.test/images/account/ref.png?signature=secret&expires=123";
  const snapshot = createImageFailureRequestSnapshot({
    surface: "image-workbench",
    prompt: "  一只在雨夜奔跑的橘猫  ",
    publicModelId: "pm_public-image-1",
    modelName: "公开图片模型",
    aspectRatio: "16:9",
    resolution: "2K",
    referenceImageUrls: [signedReference, signedReference],
    quotedPriceYuan: 0.35,
    billingExempt: false,
  });
  assert(snapshot);
  assert.equal(snapshot.prompt, "一只在雨夜奔跑的橘猫");
  assert.equal(snapshot.mode, "image-to-image");
  assert.equal(snapshot.referenceAssetRefs.length, 1);
  assert.match(snapshot.referenceAssetRefs[0], /^ref_[a-f0-9]{32}$/u);
  assert(!JSON.stringify(snapshot).includes("signature=secret"));
  assert(!JSON.stringify(snapshot).includes("storage.example.test"));
  assert.equal(parseImageFailureRequestSnapshot(snapshot)?.publicModelId, "pm_public-image-1");
  assert.equal(parseImageFailureRequestSnapshot({ ...snapshot, referenceAssetRefs: [signedReference] }), null);
  const coverSnapshot = createImageFailureRequestSnapshot({
    surface: COVER_FAILURE_HISTORY_SURFACE,
    prompt: "封面失败提示词",
    publicModelId: "pm_cover-model",
    modelName: "封面模型",
    aspectRatio: "3:4",
    resolution: "1K",
    referenceImageUrls: [signedReference],
    quotedPriceYuan: 0.2,
    billingExempt: false,
  });
  assert.equal(coverSnapshot?.surface, "cover-studio");
  assert.equal(JSON.stringify(coverSnapshot).includes("signature=secret"), false);
  const storyboardSnapshot = createImageFailureRequestSnapshot({
    surface: STORYBOARD_FAILURE_HISTORY_SURFACE,
    prompt: "故事板单镜头",
    publicModelId: "pm_storyboard-model",
    modelName: "故事板生图模型",
    aspectRatio: "16:9",
    resolution: "1K",
    referenceImageUrls: [],
    quotedPriceYuan: 0.34,
    billingExempt: false,
  });
  assert.equal(storyboardSnapshot?.surface, "storyboard-workbench");
  assert.equal(parseImageFailureRequestSnapshot(storyboardSnapshot)?.surface, "storyboard-workbench");
  for (const surface of [FREE_CANVAS_FAILURE_HISTORY_SURFACE, SHORT_DRAMA_FAILURE_HISTORY_SURFACE] as const) {
    const exactSurfaceSnapshot = createImageFailureRequestSnapshot({
      surface,
      prompt: `精确来源 ${surface}`,
      publicModelId: "pm_exact-surface-model",
      modelName: "精确来源模型",
      aspectRatio: "16:9",
      resolution: "1K",
      referenceImageUrls: [],
      quotedPriceYuan: 0,
      billingExempt: true,
    });
    assert.equal(exactSurfaceSnapshot?.surface, surface);
    assert.equal(parseImageFailureRequestSnapshot(exactSurfaceSnapshot)?.surface, surface);
  }
  assert.equal(parseImageFailureRequestSnapshot({ ...storyboardSnapshot, surface: "other" })?.surface, "other",
    "legacy other snapshots must remain readable");

  const payloadFingerprint = "fingerprint";
  assert.deepEqual(parseImageTerminalFailure({
    schema: "image_request_rejection.v1",
    payloadFingerprint,
    source: "provider",
    code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
    upstreamStatus: 422,
  }, payloadFingerprint), {
    source: "provider",
    code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
    upstreamStatus: 422,
  });
  assert.equal(parseImageTerminalFailure({
    schema: "image_request_rejection.v1",
    payloadFingerprint,
    source: "provider",
    code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
    upstreamStatus: 500,
  }, payloadFingerprint), null, "5xx must remain unresolved and must never become retryable history");
  assert.deepEqual(parseImageTerminalFailure({
    schema: "image_request_rejection.v1",
    payloadFingerprint,
    source: "provider",
    code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
    upstreamStatus: 503,
    providerConfirmedRejection: true,
  }, payloadFingerprint), {
    source: "provider",
    code: "IMAGE_UPSTREAM_REQUEST_REJECTED",
    upstreamStatus: 503,
    providerConfirmedRejection: true,
  }, "a relay-wrapped 5xx is terminal only with explicit provider rejection evidence");
  assert.equal(
    imageFailureBillingReferenceId("account-1", "request-key-1"),
    imageFailureBillingReferenceId("account-1", "request-key-1"),
  );
  assert.equal(imageFailureRetryEligibility("not_charged").canLoadForRetry, true);
  assert.equal(imageFailureRetryEligibility("exempt").canLoadForRetry, true);
  assert.equal(imageFailureRetryEligibility("charged").canLoadForRetry, false);
  assert.match(imageFailureRetryEligibility("charged").retryBlockReason || "", /对账或退款/u);
  assert.equal(imageFailureRetryEligibility("unknown").canLoadForRetry, false);

  const [migration, storyboardSurfaceMigration, exactSurfaceMigration, exactSurfaceRollback, store, generationRoute, requestContract, historyRoute, component, storyboardComponent, coverRoute, coverComponent, coverAttempt, readiness, databaseContractText] = await Promise.all([
    readFile(path.join(root, "supabase/migrations/20260915231500_image_generation_failure_history.sql"), "utf8"),
    readFile(path.join(root, "supabase/migrations/20260920104000_storyboard_image_request_snapshot_surface.sql"), "utf8"),
    readFile(path.join(root, "supabase/migrations/20260929153000_image_history_surface_expansion.sql"), "utf8"),
    readFile(path.join(root, "supabase/rollbacks/20260929153000_image_history_surface_expansion.rollback.sql"), "utf8"),
    readFile(path.join(root, "src/lib/image-exactly-once.ts"), "utf8"),
    readFile(path.join(root, "src/app/api/image/generate/route.ts"), "utf8"),
    readFile(path.join(root, "src/lib/image-generation-request.ts"), "utf8"),
    readFile(path.join(root, "src/app/api/image-workbench/failure-history/route.ts"), "utf8"),
    readFile(path.join(root, "src/components/image-workbench.tsx"), "utf8"),
    readFile(path.join(root, "src/components/storyboard-workbench.tsx"), "utf8"),
    readFile(path.join(root, "src/app/api/cover/history/route.ts"), "utf8"),
    readFile(path.join(root, "src/components/cover-studio.tsx"), "utf8"),
    readFile(path.join(root, "src/lib/cover-generation-attempt.ts"), "utf8"),
    readFile(path.join(root, "src/lib/image-generation-readiness.ts"), "utf8"),
    readFile(path.join(root, "deploy/policies/database-contract.v1.json"), "utf8"),
  ]);
  const databaseContract = JSON.parse(databaseContractText) as {
    contractVersion: string;
    tables: Array<{ name: string; columns: string[] }>;
    rpcs: Array<{ name: string; arguments: string[] }>;
  };

  for (const token of ["request_snapshot jsonb", "failure_hidden_at timestamptz", "claim_image_generation_request_v2", "visible_failure_history_idx"]) {
    assert(migration.includes(token), `migration missing ${token}`);
  }
  assert(store.includes('db.rpc("claim_image_generation_request_v2"'));
  assert(store.includes("p_request_snapshot: input.requestSnapshot || null"));
  const recordColumnsDeclaration = store.match(/const IMAGE_RECORD_COLUMNS = "([^"]+)"/u);
  assert(recordColumnsDeclaration, "Missing image record select column declaration");
  const recordColumns = new Set(recordColumnsDeclaration[1].split(","));
  for (const field of ["record_id", "user_hash", "client_idempotency_key", "client_trace_id", "payload_fingerprint", "request_snapshot",
    "provider_dispatch_receipt", "provider_submission_receipt", "state", "response", "delivery_state", "delivery_asset_id", "created_at", "updated_at"]) {
    assert(recordColumns.has(field), `image record select missing ${field}`);
  }
  assert(generationRoute.includes("createImageFailureRequestSnapshot"));
  assert(generationRoute.includes("clientNodeId, clientNodeTitle, historySurface"));
  assert(requestContract.includes('historySurface?: "image-workbench"'));
  assert(component.includes('historySurface: "image-workbench"'));
  assert(generationRoute.includes("requestSnapshot: failureRequestSnapshot"));
  assert(readiness.includes('"claim_image_generation_request_v2"'));
  const imageRequestTable = databaseContract.tables.find(table => table.name === "image_generation_requests");
  assert(imageRequestTable?.columns.includes("request_snapshot"));
  assert(imageRequestTable?.columns.includes("failure_hidden_at"));
  const claimV2 = databaseContract.rpcs.find(rpc => rpc.name === "claim_image_generation_request_v2");
  assert(claimV2?.arguments.includes("p_request_snapshot"));

  for (const token of [
    '.eq("user_id", user.id)',
    '.eq("state", "failed_unknown")',
    '.eq("response->>schema", "image_request_rejection.v1")',
    '.eq("request_snapshot->>surface", surface)',
    '.is("failure_hidden_at", null)',
    '.order("created_at", { ascending: false })',
    "IMAGE_FAILURE_HISTORY_MIGRATION_NOT_READY",
    "imageFailureRetryEligibility(billingState)",
  ]) assert(historyRoute.includes(token), `history route missing ${token}`);
  assert(historyRoute.includes("STORYBOARD_FAILURE_HISTORY_SURFACE"));
  assert(requestContract.includes('"image-workbench" | "cover-studio" | "storyboard-workbench"'));
  assert(!historyRoute.includes("localStorage"));
  assert(requestContract.includes('"cover-studio"'));
  assert(migration.includes("'cover-studio'"));
  assert(migration.includes("'storyboard-workbench'"));
  assert(storyboardSurfaceMigration.includes("'storyboard-workbench'"));
  assert(storyboardSurfaceMigration.includes("claim_image_generation_request_v2"));
  for (const token of ["'free-canvas'", "'short-drama-film-studio'", "'other'", "claim_image_generation_request_v2"]) {
    assert(exactSurfaceMigration.includes(token), `exact surface migration missing ${token}`);
  }
  assert(exactSurfaceRollback.includes("ROLLBACK_BLOCKED_IMAGE_HISTORY_SURFACES_IN_USE"));
  assert(exactSurfaceRollback.includes("claim_image_generation_request_v2"));
  assert(store.includes('"IMAGE_REQUEST_SNAPSHOT_INVALID"'));
  assert(store.includes("本次未调用图片模型或扣费"));
  assert(generationRoute.includes("requestAccepted: false"));
  assert(storyboardComponent.includes("typed.requestAccepted === false"));
  assert(storyboardComponent.includes('typed.code === "IMAGE_REQUEST_SNAPSHOT_INVALID"'));
  assert(storyboardComponent.includes('imageModelCatalogState === "loading" && imageModels.length === 0 ? "读取中"'));
  for (const token of [
    '.eq("user_id", userId)',
    '.eq("state", "failed_unknown")',
    '.eq("request_snapshot->>surface", COVER_FAILURE_HISTORY_SURFACE)',
    '.is("failure_hidden_at", null)',
    '.order("created_at", { ascending: false })',
    "imageFailureRetryEligibility(billingState)",
    "IMAGE_FAILURE_HISTORY_MIGRATION_NOT_READY",
    "failureRecordId",
  ]) assert(coverRoute.includes(token), "cover history route missing " + token);
  assert(coverAttempt.includes('historySurface: "cover-studio"'));
  assert(coverAttempt.includes("serializedAttemptState(reference, state.history)"));
  const coverTree = ts.createSourceFile("cover-generation-attempt.ts", coverAttempt, ts.ScriptTarget.Latest, true);
  const projectionNames = new Set(["persistedCoverTask", "persistedReference", "persistedCoverReceipt", "serializedAttemptState"]);
  const projectionFunctions = coverTree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && projectionNames.has(node.name.text));
  assert.equal(projectionFunctions.length, projectionNames.size, "Missing durable cover projection functions");
  const projectionJs = ts.transpileModule(projectionFunctions.map(node => node.getText(coverTree)).join("\n")
    + "\nJSON.parse(serializedAttemptState(persistedReference(pending), []));", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const projectedCover = vm.runInNewContext(projectionJs, { JSON, Date, Number,
    pending: { clientIdempotencyKey: "original-cover-key", clientTraceId: "original-cover-trace", updatedAt: 1000,
      task: { id: "cover-task", ratio: "16:9", title: "title", subtitle: "subtitle", prompt: "original prompt", source: "生成",
        createdAt: "2026-10-23T00:00:00Z", taskNo: 1, status: "running", url: "blob:sensitive-preview", token: "secret-not-persisted",
        imageUrl: "https://example.test/?signature=sensitive", readPreviewBlob: () => new Blob(["secret"]) } },
  });
  assert.equal(projectedCover.pending.clientIdempotencyKey, "original-cover-key");
  assert.equal(projectedCover.pending.clientTraceId, "original-cover-trace");
  assert.equal(projectedCover.pending.task.id, "cover-task");
  assert.equal(projectedCover.pending.task.prompt, "original prompt");
  assert.equal(projectedCover.pending.task.title, "title");
  assert.equal(projectedCover.pending.task.status, "unknown");
  assert.equal(projectedCover.history.length, 0);
  for (const forbidden of ["blob:", "secret-not-persisted", "signature=", "readPreviewBlob", '"token"']) {
    assert.equal(JSON.stringify(projectedCover).includes(forbidden), false, `Cover durable projection leaked ${forbidden}`);
  }
  assert(coverAttempt.includes("inMemoryPendingCoverRequests"));
  assert.equal(coverAttempt.includes("JSON.stringify(browserState)"), false);

  const coverRetryStart = coverComponent.indexOf("async function loadFailureForRetry");
  const coverRetryEnd = coverComponent.indexOf("async function hideFailureHistory", coverRetryStart);
  const coverRetryBlock = coverComponent.slice(coverRetryStart, coverRetryEnd);
  assert(coverRetryStart > 0 && coverRetryEnd > coverRetryStart);
  assert(coverRetryBlock.includes("if (!record.canLoadForRetry)"));
  assert(coverRetryBlock.includes("readCoverModelCatalog(true)"));
  assert(coverRetryBlock.includes("currentModel?.available"));
  assert(coverRetryBlock.includes("currentModel.priceReady"));
  assert(coverRetryBlock.includes("setPrompt(record.prompt)"));
  assert(coverRetryBlock.includes("原参考图仅保存安全哈希，请重新上传"));
  assert.equal(coverRetryBlock.includes("/api/image/generate"), false);
  assert.equal(coverRetryBlock.includes("runCoverGeneration"), false);
  assert(coverComponent.includes("失败参数已载入，尚未调用模型"));
  assert(coverComponent.includes('historySurface: "cover-studio"'));
  assert(coverComponent.includes("selectedHistoryTask.retryBlockReason"));

  const retryStart = component.indexOf("const loadFailureForRetry");
  const retryEnd = component.indexOf("const addHistoryPrompts", retryStart);
  const retryBlock = component.slice(retryStart, retryEnd);
  assert(retryStart > 0 && retryEnd > retryStart);
  assert(retryBlock.includes("if (!record.canLoadForRetry)"));
  assert(retryBlock.includes('setJobs([{ id: createId("job"), prompt: record.prompt, status: "idle" }])'));
  assert(!retryBlock.includes("generationKey"));
  assert(!retryBlock.includes("/api/image/generate"));
  assert(component.includes("失败请求参数已载入，尚未调用模型"));
  assert(component.includes("请核对当前价格后点击生成，系统会新建请求号"));
  assert(component.includes('disabled={!record.canLoadForRetry}'));
  assert(component.includes("请先完成账务对账"));
  assert(component.includes("activeReferenceLimit > 0 ? `当前模型上限 ${activeReferenceLimit} 张` : \"当前模型不支持\""));

  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({
    ok: true,
    networkCalls,
    modelCalls: 0,
    checks: {
      safeSnapshot: true,
      ownerScopedTerminalHistory: true,
      billingEvidence: true,
      softHide: true,
      loadOnlyRetry: true,
      migrationFailClosed: true,
      dynamicReferenceLabel: true,
      coverFailureHistory: true,
      coverLoadOnlyRetry: true,
      coverPendingPointerIsOpaque: true,
      storyboardSurfaceContract: true,
      preclaimErrorPreserved: true,
    },
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
