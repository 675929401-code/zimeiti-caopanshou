import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as generateImageRoute } from "@/app/api/image/generate/route";
import { POST as persistImageRoute } from "@/app/api/image-workbench/persist/route";
import { POST as generateVideoRoute } from "@/app/api/video/generate/route";
import { GET as pollVideoRoute } from "@/app/api/video/poll/route";
import { storageManager } from "@/storage/object";
import {
  burnSrtSubtitles,
  processLocalMedia,
} from "@/lib/local-media-processor";
import {
  isPersistentVideoUri,
  persistStableVideoFromUrl,
} from "@/lib/video-persistence";
import type { JsonValue, ShortDramaEntity, ShortDramaProject } from "./contracts";
import { hashShortDramaRequest } from "./idempotency";
import type { ShortDramaAuthorizationContext } from "./permissions";
import {
  ShortDramaProjectRepository,
} from "./repository";
import {
  ShortDramaProductionError,
  ShortDramaProductionRepository,
  type ProductionAsset,
  type ProductionJob,
  type ProductionShot,
} from "./production-repository";
import {
  deriveProductionPlan,
  ProductionPlanError,
} from "./production-plan";
import { validateStoryboardEpisodeReadiness } from "./episode-workflow";
import { resolveVideoStylePrompt } from "./video-style-presets";
import { signAutodlH3OwnedAssetRefForUser } from "@/lib/autodl-h3-assets";
import {
  buildShortDramaSrt,
  resolveAssemblyFrameSize,
  totalShotDuration,
} from "./final-assembly";
import type {
  AssembleProductionFinalRequest,
  CreateProductionPlanRequest,
  DeleteProductionTakeRequest,
  GenerateProductionEntityImageRequest,
  GenerateProductionImageRequest,
  GenerateProductionVideoRequest,
  PollProductionJobRequest,
  ProductionExportRequest,
  ProductionPlanSegment,
  ProductionTimelineClip,
  SaveProductionTimelineRequest,
  UpdateProductionTakeRequest,
} from "./production-contracts";
import { ProductionTimelineClipSchema } from "./production-contracts";
import { GeneratedImageReferenceSchema } from "@/lib/generated-image-reference";
import { projectGeneratedImageClientReceipt } from "@/lib/generated-image-client-delivery";
import { resolveGeneratedImageReference } from "@/lib/server/generated-image-reference";

const PRODUCTION_SURFACE = "short-drama-film-studio";
const DURABLE_PROVIDER = "tencent_cos";
const DURABLE_URI_PREFIX = `object://${DURABLE_PROVIDER}/`;
const FINAL_ASSEMBLY_MAX_SHOTS = 120;
const FINAL_ASSEMBLY_MAX_SOURCE_BYTES = 512 * 1024 * 1024;

type JsonObject = Record<string, JsonValue>;

export interface ProductionActionResult {
  status: number;
  body: JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): JsonObject {
  try {
    const serializable = JSON.parse(JSON.stringify(value ?? {})) as unknown;
    return isRecord(serializable) ? serializable as JsonObject : {};
  } catch {
    return {};
  }
}

function jsonArray(value: unknown): JsonValue[] {
  try {
    const serializable = JSON.parse(JSON.stringify(value ?? [])) as unknown;
    return Array.isArray(serializable) ? serializable as JsonValue[] : [];
  } catch {
    return [];
  }
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timelineFromSourcePayload(sourcePayload: Record<string, JsonValue>): ProductionTimelineClip[] {
  if (!Array.isArray(sourcePayload.productionTimeline)) return [];
  return sourcePayload.productionTimeline.flatMap((candidate) => {
    const parsed = ProductionTimelineClipSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function takeSelectionKey(assetRole: string): "selectedImageAssetId" | "selectedVideoAssetId" | null {
  if (assetRole === "video") return "selectedVideoAssetId";
  if (assetRole === "image" || assetRole === "storyboard") return "selectedImageAssetId";
  return null;
}

function assetDeclaredDuration(asset: ProductionAsset, shot: ProductionShot): number {
  const declared = asFiniteNumber(asset.metadata.durationSeconds, shot.durationSeconds);
  return Math.max(0.1, Math.min(3_600, declared || shot.durationSeconds || 5));
}

function selectedShotAsset(
  shot: ProductionShot,
  assets: ProductionAsset[],
  role: "image" | "video",
): ProductionAsset | null {
  const allowed = assets
    .filter((asset) => asset.shotId === shot.id && (
      role === "video"
        ? asset.assetRole === "video"
        : asset.assetRole === "image" || asset.assetRole === "storyboard"
    ))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const selectedId = role === "video"
    ? shot.metadata.selectedVideoAssetId
    : shot.metadata.selectedImageAssetId;
  return allowed.find((asset) => asset.id === selectedId) || allowed[0] || null;
}

function bearerHeader(request: Request): string {
  const value = request.headers.get("authorization") || "";
  if (!value.startsWith("Bearer ")) {
    throw new ShortDramaProductionError(401, "UNAUTHORIZED", "请先登录");
  }
  return value;
}

function internalJsonRequest(
  outerRequest: NextRequest,
  path: string,
  method: "POST" | "GET",
  payload?: JsonObject,
): NextRequest {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers = new Headers({
    authorization: bearerHeader(outerRequest),
    accept: "application/json",
  });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    // image-workbench/persist intentionally requires an explicit bounded body.
    headers.set("content-length", String(Buffer.byteLength(body, "utf8")));
  }
  return new NextRequest(new URL(path, outerRequest.nextUrl.origin), {
    method,
    headers,
    body,
  });
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function callJsonRoute(
  handler: (request: NextRequest) => Promise<Response>,
  request: NextRequest,
  fallbackCode: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await handler(request);
  } catch {
    throw new ShortDramaProductionError(
      503,
      fallbackCode,
      "媒体服务暂时不可用，生产任务未被标记为完成",
    );
  }
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const code = String(body.code || body.error_code || fallbackCode);
    const message = String(body.error || "媒体服务暂时不可用");
    throw new ShortDramaProductionError(
      response.status,
      code,
      message,
      {
        taskSubmitted: body.task_submitted === true,
        retryable: body.retryable === true,
      },
    );
  }
  return { status: response.status, body };
}

function jobResponse(
  job: ProductionJob,
  assets: ProductionAsset[] = [],
  extra: JsonObject = {},
): JsonObject {
  return {
    job: jsonObject(job),
    assets: jsonArray(assets),
    ...extra,
  };
}

async function requireOwnedProject(
  auth: ShortDramaAuthorizationContext,
  projectId: string,
): Promise<ShortDramaProject> {
  const projects = new ShortDramaProjectRepository(auth.db);
  const project = await projects.getProject(auth.userId, projectId);
  if (!project) {
    throw new ShortDramaProductionError(404, "PROJECT_NOT_FOUND", "项目不存在");
  }
  if (project.status === "archived") {
    throw new ShortDramaProductionError(409, "PROJECT_NOT_PRODUCIBLE", "已归档项目不能创建生产任务");
  }
  return project;
}

async function withFreshPreview(asset: ProductionAsset): Promise<ProductionAsset> {
  if (asset.provider !== DURABLE_PROVIDER || !asset.objectKey) return asset;
  try {
    const previewUrl = await storageManager.getSignedUrl(
      asset.objectKey,
      { expireTime: 15 * 60 },
      DURABLE_PROVIDER,
    );
    return { ...asset, previewUrl };
  } catch {
    return { ...asset, previewUrl: "" };
  }
}

async function withFreshPreviews(assets: ProductionAsset[]): Promise<ProductionAsset[]> {
  return Promise.all(assets.map(withFreshPreview));
}

function stableObjectUri(objectKey: string): string {
  return `${DURABLE_URI_PREFIX}${encodeURIComponent(objectKey)}`;
}

function parseStableObjectUri(value: string): { provider: string; objectKey: string } | null {
  const match = /^object:\/\/([a-z0-9_][a-z0-9_-]{1,63})\/([^?#]+)$/u.exec(value);
  if (!match) return null;
  try {
    const objectKey = decodeURIComponent(match[2]);
    return objectKey ? { provider: match[1], objectKey } : null;
  } catch {
    return null;
  }
}

function plansMatch(shots: ProductionShot[], plan: ProductionPlanSegment[]): boolean {
  if (shots.length !== plan.length) return false;
  return shots.every((shot, index) => {
    const expected = plan[index];
    return shot.sequence === index + 1
      && shot.imagePrompt === expected.imagePrompt
      && shot.videoPrompt === expected.videoPrompt
      && shot.aspectRatio === expected.aspectRatio
      && Math.abs(shot.durationSeconds - expected.durationSeconds) < 0.001;
  });
}

async function markJobFailureQuietly(input: {
  repository: ShortDramaProductionRepository;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  job: ProductionJob;
  error: unknown;
  retryWait?: boolean;
  shotId?: string | null;
}): Promise<void> {
  const error = input.error instanceof ShortDramaProductionError
    ? input.error
    : new ShortDramaProductionError(500, "PRODUCTION_PIPELINE_ERROR", "生产任务执行失败");
  try {
    await input.repository.updateJob(
      input.auth.userId,
      input.projectId,
      input.job.id,
      {
        state: input.retryWait ? "retry_wait" : "failed",
        progress: input.retryWait ? Math.max(1, input.job.progress) : input.job.progress,
        errorCode: error.code,
        errorMessage: error.message.slice(0, 1_000),
        completedAt: input.retryWait ? null : new Date().toISOString(),
      },
    );
    if (input.shotId && !input.retryWait) {
      await input.repository.updateShotStatus(
        input.auth.userId,
        input.projectId,
        input.shotId,
        "failed",
      );
    }
  } catch (updateError) {
    console.error("[short-drama:production] failed to persist safe job failure", {
      publicJobId: input.job.publicJobId,
      errorType: updateError instanceof Error ? updateError.name : typeof updateError,
    });
  }
}

function imageGenerationSnapshot(body: Record<string, unknown>): JsonObject {
  const receipt = projectGeneratedImageClientReceipt(body);
  if (receipt) return jsonObject({ ...receipt, images: [],
    ...(receipt.deliveryMode === "provider_url" ? { generatedImageReference: { schema: "generated_image_ref.v1", recordId: receipt.recordId } } : { blockedOnInput: true }),
  });
  const operationId = String(body.operationId || "").trim();
  const billingReferenceId = String(body.billingReferenceId || "").trim()
    || (operationId ? `image:${operationId}` : "");
  const images = Array.isArray(body.images)
    ? body.images.filter(isRecord).filter(image => typeof image.assetId === "string" && Boolean(image.assetId)
      && typeof image.storageKey === "string" && Boolean(image.storageKey)
      && typeof image.url === "string" && /^https?:\/\//u.test(image.url)).slice(0, 1).map((image) => ({
      url: String(image.url || ""),
      assetId: String(image.assetId || ""),
      storageKey: String(image.storageKey || ""),
      width: asFiniteNumber(image.width),
      height: asFiniteNumber(image.height),
      aspectRatio: String(image.aspectRatio || ""),
      dimensionsVerified: image.dimensionsVerified === true,
    }))
    : [];
  return jsonObject({
    status: String(body.status || "completed"),
    taskId: String(body.taskId || ""),
    traceId: String(body.traceId || ""),
    operationId,
    billingReferenceId,
    modelUsed: String(body.modelUsed || ""),
    modelIdUsed: typeof body.modelIdUsed === "string" ? body.modelIdUsed : null,
    resolution: String(body.resolution || ""),
    cashCharged: Math.max(0, asFiniteNumber(body.cashCharged)),
    images,
  });
}

/** New generated results are receipts/references, never implicit durable assets. */
async function completeReferencedImageJob(input: {
  auth: ShortDramaAuthorizationContext; projectId: string; job: ProductionJob;
  repository: ShortDramaProductionRepository;
}) {
  const generation = jsonObject(input.job.resultPayload.generation);
  const receipt = projectGeneratedImageClientReceipt(generation);
  if (!receipt) return null;
  const reference = receipt.deliveryMode === "provider_url"
    ? GeneratedImageReferenceSchema.parse({ schema: "generated_image_ref.v1", recordId: receipt.recordId }) : null;
  let sourceUnavailable = false;
  if (reference) {
    // A completed owned receipt survives source expiry; availability only gates later inputs.
    const owned = await input.auth.db.from("image_generation_requests").select("state,delivery_state,response")
      .eq("record_id", reference.recordId).eq("user_id", input.auth.userId).maybeSingle();
    const response = isRecord(owned.data?.response) ? owned.data.response : {};
    if (owned.error || !owned.data || owned.data.state !== "completed" || owned.data.delivery_state !== "delivered" || response.deliveryMode !== "provider_url") {
      throw new ShortDramaProductionError(403, "GENERATED_IMAGE_NOT_OWNED", "无法确认原生成结果归属；不会重新提交或扣费");
    }
    sourceUnavailable = Boolean(response.sourceExpiredAt);
  }
  await input.repository.createSettlement({ userId: input.auth.userId, projectId: input.projectId,
    job: input.job, cashCharged: receipt.cashCharged, ledgerReference: receipt.billingReferenceId || null,
    pricingSnapshot: jsonObject({ ...receipt, source: "image_generate_response" }), });
  const job = await input.repository.updateJob(input.auth.userId, input.projectId, input.job.id, {
    state: "succeeded", progress: 100, completedAt: new Date().toISOString(), errorCode: null, errorMessage: null,
    billingSnapshot: jsonObject({ ...input.job.billingSnapshot, actualCashCharged: receipt.cashCharged }),
    resultPayload: jsonObject({ generation, imageDeliveryReceipt: receipt, generationCompleted: true,
      ...(reference ? { generatedImageReference: reference } : {}),
      ...(!reference || sourceUnavailable ? { blockedOnInput: true } : {}), }),
  });
  return { status: 200, body: jobResponse(job, [], { generationCompleted: true,
    blockedOnInput: !reference || sourceUnavailable, message: sourceUnavailable ? "图片已生成并结算，但上游图片已失效，自动编排已停止；不会重新提交或扣费" : reference ? "生成图片引用已登记；不会自动复制到素材库" : "图片已生成并结算，但该通道返回临时图片，无法继续自动编排；不会自动重试或再次扣费" }) };
}

function firstGeneratedImage(generation: JsonObject): {
  url: string;
  assetId: string;
  storageKey: string;
  width: number;
  height: number;
} | null {
  const images = Array.isArray(generation.images) ? generation.images : [];
  const image = images.find((value) => isRecord(value)) as Record<string, unknown> | undefined;
  if (!image) return null;
  const url = String(image.url || "");
  const storageKey = String(image.storageKey || "");
  if (!url && !storageKey) return null;
  return {
    url,
    assetId: String(image.assetId || ""),
    storageKey,
    width: asFiniteNumber(image.width),
    height: asFiniteNumber(image.height),
  };
}

async function persistImageJob(input: {
  request: NextRequest;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  shot: ProductionShot;
  job: ProductionJob;
  repository: ShortDramaProductionRepository;
}): Promise<ProductionActionResult> {
  const referenced = await completeReferencedImageJob(input);
  if (referenced) {
    await input.repository.updateShotStatus(input.auth.userId, input.projectId, input.shot.id, "ready");
    return referenced;
  }
  const existingAssets = await input.repository.listAssetsForJob(
    input.auth.userId,
    input.projectId,
    input.job.id,
  );
  const existingImage = existingAssets.find((asset) => asset.assetRole === "image");
  let asset = existingImage || null;
  const generation = jsonObject(input.job.resultPayload.generation);
  const generatedImage = firstGeneratedImage(generation);
  if (!asset && !generatedImage) {
    throw new ShortDramaProductionError(
      409,
      "IMAGE_RESULT_NOT_RECOVERABLE",
      "图片任务没有可恢复的生成结果，不会自动重复付费生成",
    );
  }

  const claimed = await input.repository.claimJobPersistence(
    input.auth.userId,
    input.projectId,
    input.job.id,
  );
  if (!claimed && !asset) {
    const current = await input.repository.getJob(
      input.auth.userId,
      input.projectId,
      input.job.publicJobId,
    );
    return {
      status: 202,
      body: jobResponse(current, await withFreshPreviews(existingAssets), {
        replayed: true,
        message: "图片结果正在写入稳定存储",
      }),
    };
  }
  let workingJob = claimed || input.job;

  try {
    if (!asset && generatedImage) {
      const persistPayload = generatedImage.storageKey
        ? {
            storageKey: generatedImage.storageKey,
            ...(generatedImage.assetId ? { assetId: generatedImage.assetId } : {}),
          }
        : { url: generatedImage.url, index: input.shot.sequence };
      const persisted = await callJsonRoute(
        persistImageRoute,
        internalJsonRequest(
          input.request,
          "/api/image-workbench/persist",
          "POST",
          jsonObject(persistPayload),
        ),
        "IMAGE_PERSIST_FAILED",
      );
      const objectKey = String(persisted.body.key || "").trim();
      const previewUrl = String(persisted.body.url || "").trim();
      if (persisted.body.success !== true || !objectKey || !previewUrl) {
        throw new ShortDramaProductionError(
          502,
          "IMAGE_PERSIST_INVALID_RESPONSE",
          "图片已生成，但稳定存储没有返回有效资产",
        );
      }
      asset = await input.repository.createAsset({
        userId: input.auth.userId,
        projectId: input.projectId,
        shotId: input.shot.id,
        jobId: input.job.id,
        assetRole: "image",
        provider: DURABLE_PROVIDER,
        objectKey,
        stableUri: stableObjectUri(objectKey),
        mimeType: typeof persisted.body.mimeType === "string" ? persisted.body.mimeType : null,
        byteSize: Number.isFinite(Number(persisted.body.size)) ? Number(persisted.body.size) : null,
        metadata: jsonObject({
          previewUrl,
          width: generatedImage.width,
          height: generatedImage.height,
          sourceAssetId: generatedImage.assetId,
          sourceTaskId: generation.taskId,
          operationId: generation.operationId,
          billingReferenceId: generation.billingReferenceId,
          modelPublicId: input.job.modelPublicId,
          resolution: generation.resolution,
        }),
      });
    }

    if (!asset) {
      throw new ShortDramaProductionError(503, "IMAGE_ASSET_NOT_DURABLE", "图片稳定资产登记失败");
    }
    const actualCashCharged = Math.max(
      0,
      asFiniteNumber(generation.cashCharged, asFiniteNumber(input.job.billingSnapshot.actualCashCharged)),
    );
    await input.repository.createSettlement({
      userId: input.auth.userId,
      projectId: input.projectId,
      job: input.job,
      cashCharged: actualCashCharged,
      ledgerReference: String(generation.billingReferenceId || "").trim() || null,
      pricingSnapshot: jsonObject({
        source: "image_generate_response",
        modelPublicId: input.job.modelPublicId,
        resolution: generation.resolution,
        operationId: generation.operationId,
        billingReferenceId: generation.billingReferenceId,
        actualCashCharged,
      }),
    });
    workingJob = await input.repository.updateJob(
      input.auth.userId,
      input.projectId,
      input.job.id,
      {
        state: "succeeded",
        progress: 100,
        resultPayload: jsonObject({
          ...input.job.resultPayload,
          assetId: asset.id,
          stableUri: asset.stableUri,
          operationId: generation.operationId,
          billingReferenceId: generation.billingReferenceId,
        }),
        billingSnapshot: jsonObject({
          ...input.job.billingSnapshot,
          actualCashCharged,
          operationId: generation.operationId,
          billingReferenceId: generation.billingReferenceId,
          settlementSource: "image_generate_response",
        }),
        errorCode: null,
        errorMessage: null,
        completedAt: new Date().toISOString(),
      },
    );
    await input.repository.updateShotStatus(
      input.auth.userId,
      input.projectId,
      input.shot.id,
      "ready",
    );
    return {
      status: 201,
      body: jobResponse(workingJob, [await withFreshPreview(asset)]),
    };
  } catch (error) {
    await markJobFailureQuietly({
      repository: input.repository,
      auth: input.auth,
      projectId: input.projectId,
      job: workingJob,
      error,
      retryWait: true,
      shotId: input.shot.id,
    });
    throw error;
  }
}

function entityImagePrompt(
  entity: ShortDramaEntity,
  layout: "single" | "three_view",
  animationStyle: string,
): string {
  const kind = entity.entityType === "character" ? "角色造型设定图"
    : entity.entityType === "location" ? "场景空镜设定图"
      : "关键道具设定图";
  const { assetVersions: _assetVersions, ...promptAttributes } = entity.attributes;
  const attributes = JSON.stringify(promptAttributes).slice(0, 10_000);
  return [
    kind,
    `名称：${entity.name}`,
    entity.description ? `核心说明：${entity.description}` : "",
    animationStyle ? `统一美术：${resolveVideoStylePrompt(animationStyle)}` : "",
    attributes && attributes !== "{}" ? `设定属性：${attributes}` : "",
    layout === "three_view"
      ? "三视图设定稿：同一主体、同一服装与材质，正面、侧面、背面三栏等比例完整展示，纯净背景，不添加标签文字。"
      : "单视图设定稿：主体完整、比例清晰、背景简洁。",
    "单张主体清晰、构图完整、无水印、无文字、可作为后续分镜一致性参考。",
  ].filter(Boolean).join("\n");
}

function entityAssetVersions(entity: ShortDramaEntity): Array<{
  id: string;
  uri: string;
  label: string;
  createdAt: string;
}> {
  if (!Array.isArray(entity.attributes.assetVersions)) return [];
  return entity.attributes.assetVersions.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.uri !== "string" || !candidate.uri.trim()) return [];
    return [{
      id: typeof candidate.id === "string" ? candidate.id : createHash("sha256").update(candidate.uri).digest("hex").slice(0, 24),
      uri: candidate.uri.trim(),
      label: typeof candidate.label === "string" && candidate.label.trim() ? candidate.label.trim() : "AI 生成版本",
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : "",
    }];
  }).slice(0, 50);
}

async function persistEntityImageJob(input: {
  request: NextRequest;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  entityId: string;
  job: ProductionJob;
  repository: ShortDramaProductionRepository;
}): Promise<ProductionActionResult> {
  const referenced = await completeReferencedImageJob(input);
  if (referenced) {
    const projects = new ShortDramaProjectRepository(input.auth.db);
    const entity = await projects.getEntity(input.auth.userId, input.projectId, input.entityId);
    if (!entity) throw new ShortDramaProductionError(404, "ENTITY_NOT_FOUND", "实体档案不存在");
    const generation = jsonObject(input.job.resultPayload.generation);
    const receipt = projectGeneratedImageClientReceipt(generation)!;
    const updated = await projects.updateEntity(input.auth.userId, input.projectId, entity.id, {
      expectedRevision: entity.revision,
      referenceAssetUri: null,
      attributes: { ...entity.attributes, imageDeliveryReceipt: jsonObject(receipt),
        generatedImageSourceUnavailable: referenced.body.blockedOnInput === true,
        generatedImageReference: receipt.deliveryMode === "provider_url" ? jsonObject({ schema: "generated_image_ref.v1", recordId: receipt.recordId }) : null },
    });
    return { ...referenced, body: { ...referenced.body, entity: jsonObject(updated) } };
  }
  const projects = new ShortDramaProjectRepository(input.auth.db);
  let entity = await projects.getEntity(input.auth.userId, input.projectId, input.entityId);
  if (!entity) throw new ShortDramaProductionError(404, "ENTITY_NOT_FOUND", "实体档案不存在");
  const existingAssets = await input.repository.listAssetsForJob(input.auth.userId, input.projectId, input.job.id);
  let asset = existingAssets.find((candidate) => ["character_reference", "scene_reference", "source"].includes(candidate.assetRole)) || null;
  const generation = jsonObject(input.job.resultPayload.generation);
  const generatedImage = firstGeneratedImage(generation);
  if (!asset && !generatedImage) {
    throw new ShortDramaProductionError(409, "ENTITY_IMAGE_RESULT_NOT_RECOVERABLE", "实体图片任务没有可恢复结果，不会自动重复付费生成");
  }
  const claimed = await input.repository.claimJobPersistence(input.auth.userId, input.projectId, input.job.id);
  if (!claimed && !asset) {
    const current = await input.repository.getJob(input.auth.userId, input.projectId, input.job.publicJobId);
    return { status: 202, body: jobResponse(current, [], { message: "实体图片结果正在写入稳定存储", replayed: true }) };
  }
  let workingJob = claimed || input.job;
  try {
    if (!asset && generatedImage) {
      const persisted = await callJsonRoute(
        persistImageRoute,
        internalJsonRequest(
          input.request,
          "/api/image-workbench/persist",
          "POST",
          jsonObject(generatedImage.storageKey
            ? { storageKey: generatedImage.storageKey, ...(generatedImage.assetId ? { assetId: generatedImage.assetId } : {}) }
            : { url: generatedImage.url, index: 1 }),
        ),
        "ENTITY_IMAGE_PERSIST_FAILED",
      );
      const objectKey = String(persisted.body.key || "").trim();
      const previewUrl = String(persisted.body.url || "").trim();
      if (persisted.body.success !== true || !objectKey || !previewUrl) {
        throw new ShortDramaProductionError(502, "ENTITY_IMAGE_PERSIST_INVALID_RESPONSE", "实体图片已生成，但稳定存储没有返回有效资产");
      }
      asset = await input.repository.createAsset({
        userId: input.auth.userId,
        projectId: input.projectId,
        shotId: null,
        jobId: input.job.id,
        assetRole: entity.entityType === "character"
          ? "character_reference"
          : entity.entityType === "location" ? "scene_reference" : "source",
        provider: DURABLE_PROVIDER,
        objectKey,
        stableUri: stableObjectUri(objectKey),
        mimeType: typeof persisted.body.mimeType === "string" ? persisted.body.mimeType : null,
        byteSize: Number.isFinite(Number(persisted.body.size)) ? Number(persisted.body.size) : null,
        metadata: jsonObject({
          previewUrl,
          entityId: entity.id,
          entityType: entity.entityType,
          width: generatedImage.width,
          height: generatedImage.height,
          sourceAssetId: generatedImage.assetId,
          sourceTaskId: generation.taskId,
          operationId: generation.operationId,
          billingReferenceId: generation.billingReferenceId,
          modelPublicId: input.job.modelPublicId,
          resolution: generation.resolution,
        }),
      });
    }
    if (!asset) throw new ShortDramaProductionError(503, "ENTITY_IMAGE_ASSET_NOT_DURABLE", "实体图片稳定资产登记失败");
    entity = await projects.getEntity(input.auth.userId, input.projectId, input.entityId);
    if (!entity) throw new ShortDramaProductionError(404, "ENTITY_NOT_FOUND", "实体档案不存在");
    const versions = entityAssetVersions(entity);
    if (!versions.some((version) => version.uri === asset!.stableUri) || entity.referenceAssetUri !== asset.stableUri) {
      const nextVersions = [
        ...versions.filter((version) => version.uri !== asset!.stableUri),
        {
          id: asset.id,
          uri: asset.stableUri,
          label: `AI ${input.job.modelPublicId || "生成"}`,
          createdAt: asset.createdAt || new Date().toISOString(),
        },
      ].slice(-50);
      entity = await projects.updateEntity(input.auth.userId, input.projectId, entity.id, {
        expectedRevision: entity.revision,
        attributes: { ...entity.attributes, assetVersions: nextVersions as unknown as JsonValue },
        referenceAssetUri: asset.stableUri,
      });
    }
    const actualCashCharged = Math.max(0, asFiniteNumber(generation.cashCharged, asFiniteNumber(input.job.billingSnapshot.actualCashCharged)));
    await input.repository.createSettlement({
      userId: input.auth.userId,
      projectId: input.projectId,
      job: input.job,
      cashCharged: actualCashCharged,
      ledgerReference: String(generation.billingReferenceId || "").trim() || null,
      pricingSnapshot: jsonObject({
        source: "image_generate_response",
        surface: "film_entity",
        entityId: entity.id,
        modelPublicId: input.job.modelPublicId,
        resolution: generation.resolution,
        operationId: generation.operationId,
        billingReferenceId: generation.billingReferenceId,
        actualCashCharged,
      }),
    });
    workingJob = await input.repository.updateJob(input.auth.userId, input.projectId, workingJob.id, {
      state: "succeeded",
      progress: 100,
      provider: "image_api",
      resultPayload: jsonObject({
        ...workingJob.resultPayload,
        entityId: entity.id,
        entityRevision: entity.revision,
        assetId: asset.id,
        stableUri: asset.stableUri,
      }),
      billingSnapshot: jsonObject({ ...workingJob.billingSnapshot, actualCashCharged }),
      errorCode: null,
      errorMessage: null,
      completedAt: new Date().toISOString(),
    });
    return {
      status: 200,
      body: jobResponse(workingJob, [await withFreshPreview(asset)], { entity: jsonObject(entity) }),
    };
  } catch (error) {
    await markJobFailureQuietly({ repository: input.repository, auth: input.auth, projectId: input.projectId, job: workingJob, error, retryWait: true });
    throw error;
  }
}

function videoSubmissionSnapshot(body: Record<string, unknown>): JsonObject {
  return jsonObject({
    taskId: String(body.task_id || ""),
    status: String(body.status || "pending"),
    modelId: String(body.model_id || ""),
    modelName: String(body.model_name || ""),
    quotedPrice: Math.max(0, asFiniteNumber(body.price)),
    resolution: String(body.resolution || ""),
    targetDuration: asFiniteNumber(body.target_duration),
    submitDuration: asFiniteNumber(body.submit_duration),
    processingStage: String(body.processing_stage || ""),
    lifecycleState: String(body.lifecycle_state || ""),
    trackingWarning: String(body.trackingWarning || ""),
  });
}

function pollProgress(body: Record<string, unknown>): number {
  const explicit = asFiniteNumber(body.progress, -1);
  if (explicit >= 0) return Math.max(1, Math.min(95, explicit));
  const status = String(body.status || "").toLowerCase();
  if (status === "queued" || status === "pending") return 15;
  if (status === "processing") return 50;
  return 10;
}

async function finalizeCompletedVideo(input: {
  request: NextRequest;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  shot: ProductionShot;
  job: ProductionJob;
  repository: ShortDramaProductionRepository;
  pollBody: Record<string, unknown>;
}): Promise<ProductionActionResult> {
  const videoTask = await input.repository.findOwnedVideoTask(
    input.auth.userId,
    String(input.job.upstreamTaskId || ""),
  );
  if (!videoTask) {
    const error = new ShortDramaProductionError(
      409,
      "VIDEO_TRACKING_NOT_READY",
      "视频上游任务存在，但当前用户的任务追踪记录尚未就绪；系统不会使用非归属轮询",
    );
    await markJobFailureQuietly({
      repository: input.repository,
      auth: input.auth,
      projectId: input.projectId,
      job: input.job,
      error,
      retryWait: true,
      shotId: input.shot.id,
    });
    throw error;
  }
  if (videoTask.status !== "completed") {
    const current = await input.repository.updateJob(
      input.auth.userId,
      input.projectId,
      input.job.id,
      {
        state: "running",
        progress: 75,
        resultPayload: jsonObject({ ...input.job.resultPayload, poll: input.pollBody }),
      },
    );
    return {
      status: 200,
      body: jobResponse(current, [], { message: "视频正在完成终态结算" }),
    };
  }

  const existingAssets = await input.repository.listAssetsForJob(
    input.auth.userId,
    input.projectId,
    input.job.id,
  );
  let asset = existingAssets.find((entry) => entry.assetRole === "video") || null;
  const durableBeforeClaim = parseStableObjectUri(videoTask.storageUrl);
  const claimed = await input.repository.claimJobPersistence(
    input.auth.userId,
    input.projectId,
    input.job.id,
  );
  if (!claimed && !asset && !durableBeforeClaim) {
    const current = await input.repository.getJob(
      input.auth.userId,
      input.projectId,
      input.job.publicJobId,
    );
    return {
      status: 202,
      body: jobResponse(current, await withFreshPreviews(existingAssets), {
        message: "视频已完成，正在写入稳定存储",
      }),
    };
  }
  const workingJob = claimed || input.job;

  try {
    let stableStorageUrl = videoTask.storageUrl;
    if (!isPersistentVideoUri(stableStorageUrl)) {
      if (!videoTask.videoUrl) {
        throw new ShortDramaProductionError(
          503,
          "VIDEO_RESULT_NOT_RECOVERABLE",
          "视频任务已完成，但没有可持久化的结果地址",
        );
      }
      const config = await input.repository.getVideoPersistenceConfig(videoTask.modelId);
      if (config.persistResultImmediately) {
        const waiting = await input.repository.updateJob(
          input.auth.userId,
          input.projectId,
          input.job.id,
          {
            state: "retry_wait",
            progress: 85,
            errorCode: "VIDEO_RESULT_PERSISTING",
            errorMessage: "视频已完成，正在等待既有持久化任务写入稳定存储",
          },
        );
        return {
          status: 202,
          body: jobResponse(waiting, [], {
            message: "视频已完成，正在写入稳定存储；不会重复下载或提交模型任务",
          }),
        };
      }
      stableStorageUrl = await persistStableVideoFromUrl(
        videoTask.videoUrl,
        videoTask.id,
        input.auth.userId,
        {
          storageScope: "short-drama",
          providerProtocol: config.protocolType,
          providerEndpoint: config.apiEndpoint,
        },
      );
      await input.repository.updateVideoTaskStorage(
        input.auth.userId,
        videoTask.id,
        stableStorageUrl,
      );
    }
    const durable = parseStableObjectUri(stableStorageUrl);
    if (!durable || durable.provider !== DURABLE_PROVIDER) {
      throw new ShortDramaProductionError(
        503,
        "VIDEO_ASSET_NOT_DURABLE",
        "视频尚未获得平台稳定对象存储地址，不能标记成片完成",
      );
    }
    if (!asset) {
      asset = await input.repository.createAsset({
        userId: input.auth.userId,
        projectId: input.projectId,
        shotId: input.shot.id,
        jobId: input.job.id,
        assetRole: "video",
        provider: durable.provider,
        objectKey: durable.objectKey,
        stableUri: stableStorageUrl,
        mimeType: "video/mp4",
        metadata: jsonObject({
          videoTaskId: videoTask.id,
          upstreamTaskId: input.job.upstreamTaskId,
          modelPublicId: input.job.modelPublicId,
          resolution: videoTask.resolution,
          durationSeconds: videoTask.durationSeconds,
          previewUrl: String(input.pollBody.video_url || input.pollBody.videoUrl || ""),
        }),
      });
    }
    await input.repository.createSettlement({
      userId: input.auth.userId,
      projectId: input.projectId,
      job: input.job,
      cashCharged: videoTask.priceCharged,
      ledgerReference: input.job.upstreamTaskId
        ? `video:${input.job.upstreamTaskId}`
        : null,
      pricingSnapshot: jsonObject({
        source: "video_tasks_terminal_row",
        modelPublicId: input.job.modelPublicId,
        resolution: videoTask.resolution,
        durationSeconds: videoTask.durationSeconds,
        actualCashCharged: videoTask.priceCharged,
      }),
    });
    const completed = await input.repository.updateJob(
      input.auth.userId,
      input.projectId,
      input.job.id,
      {
        state: "succeeded",
        progress: 100,
        resultPayload: jsonObject({
          ...input.job.resultPayload,
          poll: input.pollBody,
          videoTaskId: videoTask.id,
          assetId: asset.id,
          stableUri: asset.stableUri,
        }),
        billingSnapshot: jsonObject({
          ...input.job.billingSnapshot,
          actualCashCharged: videoTask.priceCharged,
          settlementSource: "video_tasks_terminal_row",
        }),
        errorCode: null,
        errorMessage: null,
        completedAt: videoTask.completedAt || new Date().toISOString(),
      },
    );
    await input.repository.updateShotStatus(
      input.auth.userId,
      input.projectId,
      input.shot.id,
      "completed",
    );
    return {
      status: 200,
      body: jobResponse(completed, [await withFreshPreview(asset)]),
    };
  } catch (error) {
    await markJobFailureQuietly({
      repository: input.repository,
      auth: input.auth,
      projectId: input.projectId,
      job: workingJob,
      error,
      retryWait: true,
      shotId: input.shot.id,
    });
    throw error;
  }
}

async function pollVideoJob(input: {
  request: NextRequest;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  shot: ProductionShot;
  job: ProductionJob;
  repository: ShortDramaProductionRepository;
}): Promise<ProductionActionResult> {
  if (!input.job.upstreamTaskId) {
    return {
      status: 202,
      body: jobResponse(input.job, [], {
        message: "生产任务已登记，尚未获得上游任务编号，不会自动重复提交",
      }),
    };
  }
  let polled: { status: number; body: Record<string, unknown> };
  try {
    const query = new URLSearchParams({ task_id: input.job.upstreamTaskId });
    polled = await callJsonRoute(
      pollVideoRoute,
      internalJsonRequest(
        input.request,
        `/api/video/poll?${query.toString()}`,
        "GET",
      ),
      "VIDEO_POLL_FAILED",
    );
  } catch (error) {
    await markJobFailureQuietly({
      repository: input.repository,
      auth: input.auth,
      projectId: input.projectId,
      job: input.job,
      error,
      retryWait: true,
      shotId: input.shot.id,
    });
    throw error;
  }

  const status = String(polled.body.status || "").toLowerCase();
  if (status === "completed" || status === "success") {
    return finalizeCompletedVideo({ ...input, pollBody: polled.body });
  }
  if (status === "failed" || status === "cancelled") {
    const errorCode = String(polled.body.errorCode || polled.body.error_code || "VIDEO_GENERATION_FAILED");
    const errorMessage = String(polled.body.errorMessage || polled.body.error || "视频生成失败");
    const terminalState = status === "cancelled" ? "cancelled" as const : "failed" as const;
    const terminal = await input.repository.updateJob(
      input.auth.userId,
      input.projectId,
      input.job.id,
      {
        state: terminalState,
        progress: Math.max(input.job.progress, pollProgress(polled.body)),
        resultPayload: jsonObject({ ...input.job.resultPayload, poll: polled.body }),
        errorCode,
        errorMessage: errorMessage.slice(0, 1_000),
        completedAt: new Date().toISOString(),
      },
    );
    await input.repository.updateShotStatus(
      input.auth.userId,
      input.projectId,
      input.shot.id,
      terminalState === "cancelled" ? "cancelled" : "failed",
    );
    return { status: 200, body: jobResponse(terminal) };
  }

  const nextState = status === "queued" || status === "pending" ? "queued" as const : "running" as const;
  const current = await input.repository.updateJob(
    input.auth.userId,
    input.projectId,
    input.job.id,
    {
      state: nextState,
      progress: pollProgress(polled.body),
      resultPayload: jsonObject({ ...input.job.resultPayload, poll: polled.body }),
      errorCode: null,
      errorMessage: null,
    },
  );
  return { status: 200, body: jobResponse(current) };
}

export async function getProductionState(input: {
  auth: ShortDramaAuthorizationContext;
  projectId: string;
}): Promise<JsonObject> {
  const project = await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const result = await repository.listProduction(input.auth.userId, input.projectId);
  return {
    shots: jsonArray(result.shots),
    jobs: jsonArray(result.jobs),
    assets: jsonArray(await withFreshPreviews(result.assets)),
    timeline: jsonArray(timelineFromSourcePayload(project.sourcePayload)),
    projectRevision: project.revision,
  };
}

function validateTimelineClips(input: {
  clips: ProductionTimelineClip[];
  shots: ProductionShot[];
  assets: ProductionAsset[];
}): Array<{ clip: ProductionTimelineClip; shot: ProductionShot; asset: ProductionAsset }> {
  const shotById = new Map(input.shots.map((shot) => [shot.id, shot]));
  const assetById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const clipIds = new Set<string>();
  return input.clips.map((clip) => {
    if (clipIds.has(clip.id)) {
      throw new ShortDramaProductionError(422, "TIMELINE_CLIP_ID_DUPLICATED", "时间线片段编号不能重复");
    }
    clipIds.add(clip.id);
    const shot = shotById.get(clip.shotId);
    const asset = assetById.get(clip.assetId);
    if (!shot || !asset || asset.shotId !== shot.id || asset.assetRole !== "video") {
      throw new ShortDramaProductionError(
        422,
        "TIMELINE_ASSET_INVALID",
        "时间线只能引用当前项目、对应镜头且尚未删除的视频 TAKE",
      );
    }
    if (!asset.stableUri || !asset.objectKey) {
      throw new ShortDramaProductionError(409, "TIMELINE_ASSET_NOT_DURABLE", "时间线视频尚未完成稳定存储");
    }
    const duration = assetDeclaredDuration(asset, shot);
    if (clip.endSeconds > duration + 0.05) {
      throw new ShortDramaProductionError(
        422,
        "TIMELINE_RANGE_EXCEEDS_ASSET",
        `镜头 ${shot.sequence} 的时间线结束时间超过该 TAKE 的可用时长 ${duration.toFixed(1)} 秒`,
      );
    }
    return { clip, shot, asset };
  });
}

export async function updateProductionTake(input: {
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: UpdateProductionTakeRequest;
}): Promise<ProductionActionResult> {
  await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  let shot = await repository.getShot(input.auth.userId, input.projectId, input.body.shotId);
  const asset = await repository.getAsset(input.auth.userId, input.projectId, input.body.assetId);
  const selectionKey = takeSelectionKey(asset.assetRole);
  if (!selectionKey || asset.shotId !== shot.id) {
    throw new ShortDramaProductionError(422, "TAKE_ASSET_INVALID", "只能管理当前镜头的图片或视频 TAKE");
  }
  if (input.body.selected === true && shot.metadata[selectionKey] !== asset.id) {
    shot = await repository.updateShotMetadata(
      input.auth.userId,
      input.projectId,
      shot.id,
      input.body.expectedShotRevision,
      { ...shot.metadata, [selectionKey]: asset.id },
    );
  } else if (input.body.selected === false && shot.metadata[selectionKey] === asset.id) {
    const nextMetadata = { ...shot.metadata };
    delete nextMetadata[selectionKey];
    shot = await repository.updateShotMetadata(
      input.auth.userId,
      input.projectId,
      shot.id,
      input.body.expectedShotRevision,
      nextMetadata,
    );
  }
  const metadata = {
    ...asset.metadata,
    ...(input.body.rating !== undefined ? { takeRating: input.body.rating } : {}),
    ...(input.body.note !== undefined ? { takeNote: input.body.note } : {}),
    takeUpdatedAt: new Date().toISOString(),
  } as Record<string, JsonValue>;
  const updatedAsset = input.body.rating !== undefined || input.body.note !== undefined
    ? await repository.updateAssetMetadata(input.auth.userId, input.projectId, asset.id, metadata)
    : asset;
  return {
    status: 200,
    body: {
      shot: jsonObject(shot),
      asset: jsonObject(await withFreshPreview(updatedAsset)),
    },
  };
}

export async function deleteProductionTake(input: {
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: DeleteProductionTakeRequest;
}): Promise<ProductionActionResult> {
  await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  let shot = await repository.getShot(input.auth.userId, input.projectId, input.body.shotId);
  const asset = await repository.getAsset(input.auth.userId, input.projectId, input.body.assetId);
  const selectionKey = takeSelectionKey(asset.assetRole);
  if (!selectionKey || asset.shotId !== shot.id) {
    throw new ShortDramaProductionError(422, "TAKE_ASSET_INVALID", "只能删除当前镜头的图片或视频 TAKE");
  }
  if (shot.metadata[selectionKey] === asset.id) {
    const alternatives = await repository.listShotAssets(
      input.auth.userId,
      input.projectId,
      shot.id,
      asset.assetRole === "video" ? ["video"] : ["image", "storyboard"],
    );
    const replacement = alternatives.find((candidate) => candidate.id !== asset.id) || null;
    const nextMetadata = { ...shot.metadata };
    if (replacement) nextMetadata[selectionKey] = replacement.id;
    else delete nextMetadata[selectionKey];
    shot = await repository.updateShotMetadata(
      input.auth.userId,
      input.projectId,
      shot.id,
      input.body.expectedShotRevision,
      nextMetadata,
    );
  }
  await repository.softDeleteAsset(input.auth.userId, input.projectId, asset.id);
  const remaining = await repository.listShotAssets(input.auth.userId, input.projectId, shot.id);
  return {
    status: 200,
    body: {
      shot: jsonObject(shot),
      deletedAssetId: asset.id,
      assets: jsonArray(await withFreshPreviews(remaining)),
    },
  };
}

export async function saveProductionTimeline(input: {
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: SaveProductionTimelineRequest;
}): Promise<ProductionActionResult> {
  const project = await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const production = await repository.listProduction(input.auth.userId, input.projectId);
  validateTimelineClips({ clips: input.body.clips, shots: production.shots, assets: production.assets });
  const projects = new ShortDramaProjectRepository(input.auth.db);
  const updated = await projects.updateProject(input.auth.userId, input.projectId, {
    expectedRevision: input.body.expectedProjectRevision,
    sourcePayload: {
      ...project.sourcePayload,
      productionTimeline: input.body.clips as unknown as JsonValue,
      productionTimelineUpdatedAt: new Date().toISOString(),
    },
  });
  return {
    status: 200,
    body: {
      timeline: jsonArray(timelineFromSourcePayload(updated.sourcePayload)),
      projectRevision: updated.revision,
    },
  };
}

export async function createProductionPlan(input: {
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: CreateProductionPlanRequest;
}): Promise<ProductionActionResult> {
  const project = await requireOwnedProject(input.auth, input.projectId);
  const episodeReadinessIssue = validateStoryboardEpisodeReadiness(project.sourcePayload);
  if (episodeReadinessIssue) {
    throw new ShortDramaProductionError(
      episodeReadinessIssue.status,
      episodeReadinessIssue.code,
      episodeReadinessIssue.message,
    );
  }
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const inputHash = hashShortDramaRequest({
    action: input.body.action,
    projectId: input.projectId,
    sourcePayload: project.sourcePayload,
    settings: project.settings,
  });
  const created = await repository.createJob(input.auth.userId, {
    projectId: input.projectId,
    clientRequestId: input.body.clientRequestId,
    inputHash,
    stage: "shot_planning",
    requestPayload: jsonObject({
      action: input.body.action,
      projectId: input.projectId,
      sourceRevision: project.revision,
    }),
  });
  if (created.replayed && created.job.state === "succeeded") {
    return {
      status: 200,
      body: {
        job: jsonObject(created.job),
        shots: jsonArray(await repository.listShots(input.auth.userId, input.projectId)),
        replayed: true,
      },
    };
  }
  if (created.replayed && ["failed", "cancelled"].includes(created.job.state)) {
    throw new ShortDramaProductionError(
      409,
      "PRODUCTION_JOB_TERMINAL",
      "该 clientRequestId 对应的生产计划任务已经终止，请使用新的请求编号修正输入",
    );
  }

  let running = await repository.updateJob(
    input.auth.userId,
    input.projectId,
    created.job.id,
    {
      state: "running",
      progress: 20,
      attemptCount: Math.max(1, created.job.attemptCount),
      startedAt: created.job.startedAt || new Date().toISOString(),
      errorCode: null,
      errorMessage: null,
    },
  );
  try {
    const plan = deriveProductionPlan(project);
    const planned = await repository.createPlanShots(input.auth.userId, input.projectId, plan);
    if (!plansMatch(planned.shots, plan)) {
      throw new ShortDramaProductionError(
        409,
        "PLAN_ALREADY_EXISTS",
        "项目已经存在与当前剧本不同的生产镜头；为保护已生成资产，本次未覆盖原计划",
      );
    }
    await repository.createSettlement({
      userId: input.auth.userId,
      projectId: input.projectId,
      job: running,
      cashCharged: 0,
      pricingSnapshot: { source: "deterministic_project_plan", actualCashCharged: 0 },
    });
    running = await repository.updateJob(
      input.auth.userId,
      input.projectId,
      created.job.id,
      {
        state: "succeeded",
        progress: 100,
        resultPayload: jsonObject({
          shotCount: planned.shots.length,
          deterministic: true,
          paidExecution: false,
        }),
        billingSnapshot: { actualCashCharged: 0, billingMode: "free" },
        completedAt: new Date().toISOString(),
      },
    );
    return {
      status: created.replayed || planned.replayed ? 200 : 201,
      body: {
        job: jsonObject(running),
        shots: jsonArray(planned.shots),
        replayed: created.replayed || planned.replayed,
      },
    };
  } catch (error) {
    const mapped = error instanceof ProductionPlanError
      ? new ShortDramaProductionError(422, error.code, error.message)
      : error;
    await markJobFailureQuietly({
      repository,
      auth: input.auth,
      projectId: input.projectId,
      job: running,
      error: mapped,
    });
    throw mapped;
  }
}

export async function generateProductionEntityImage(input: {
  request: NextRequest;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: GenerateProductionEntityImageRequest;
}): Promise<ProductionActionResult> {
  const project = await requireOwnedProject(input.auth, input.projectId);
  const projects = new ShortDramaProjectRepository(input.auth.db);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const priorJob = await repository.getJobByClientRequestId(input.auth.userId, input.body.clientRequestId);
  if (priorJob) {
    const priorRequest = priorJob.requestPayload;
    const matchesOriginal = priorRequest.projectId === input.projectId
      && priorJob.stage === "entity_design"
      && priorRequest.entityId === input.body.entityId
      && priorRequest.entityRevision === input.body.expectedEntityRevision
      && priorRequest.modelId === input.body.modelId
      && String(priorRequest.resolution || "") === String(input.body.resolution || "")
      && priorRequest.mode === input.body.mode
      && priorRequest.layout === input.body.layout;
    if (!matchesOriginal) {
      throw new ShortDramaProductionError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "相同 clientRequestId 已用于不同实体生图请求",
      );
    }
    const priorAssets = await repository.listAssetsForJob(input.auth.userId, input.projectId, priorJob.id);
    if (priorJob.state === "succeeded") {
      const currentEntity = await projects.getEntity(input.auth.userId, input.projectId, input.body.entityId);
      return {
        status: 200,
        body: jobResponse(priorJob, await withFreshPreviews(priorAssets), {
          entity: currentEntity ? jsonObject(currentEntity) : null,
          replayed: true,
        }),
      };
    }
    if (["result_staging", "persisting", "retry_wait"].includes(priorJob.state) && isRecord(priorJob.resultPayload.generation)) {
      return persistEntityImageJob({ ...input, entityId: input.body.entityId, job: priorJob, repository });
    }
    return {
      status: 202,
      body: jobResponse(priorJob, await withFreshPreviews(priorAssets), {
        replayed: true,
        message: "原实体生图请求已登记；结果未明确前不会重复付费提交",
      }),
    };
  }
  const entity = await projects.getEntity(input.auth.userId, input.projectId, input.body.entityId);
  if (!entity) throw new ShortDramaProductionError(404, "ENTITY_NOT_FOUND", "实体档案不存在");
  if (entity.revision !== input.body.expectedEntityRevision) {
    throw new ShortDramaProductionError(409, "ENTITY_REVISION_CONFLICT", "实体档案已经更新，请刷新后重试");
  }
  const projectSummary = jsonObject(project.sourcePayload.summary);
  const animationStyle = String(projectSummary.animationStyle || project.settings.animationStyle || "").trim();
  const prompt = entityImagePrompt(entity, input.body.layout, animationStyle);
  let referenceImageUrls: string[] = [];
  if (input.body.mode === "repaint") {
    const generatedReference = GeneratedImageReferenceSchema.safeParse(entity.attributes.generatedImageReference);
    if (!entity.referenceAssetUri && !generatedReference.success) {
      throw new ShortDramaProductionError(422, "ENTITY_REFERENCE_REQUIRED", "参考重绘前请先为实体选择一个已保存图片版本");
    }
    try {
      referenceImageUrls = generatedReference.success && !entity.referenceAssetUri
        ? [await resolveGeneratedImageReference({ userId: input.auth.userId, reference: generatedReference.data })]
        : [await signAutodlH3OwnedAssetRefForUser({
        userId: input.auth.userId,
        assetRef: entity.referenceAssetUri!,
        category: "image",
      })];
    } catch {
      throw new ShortDramaProductionError(422, "ENTITY_REFERENCE_NOT_AVAILABLE", "实体当前参考图片不属于当前账号或已经失效");
    }
  }
  const promptSnapshotId = await repository.getOrCreatePromptSnapshot({
    userId: input.auth.userId,
    projectId: input.projectId,
    stage: "entity_design",
    prompt,
    modelPublicId: input.body.modelId,
    variables: jsonObject({
      entityId: entity.id,
      entityRevision: entity.revision,
      entityType: entity.entityType,
      mode: input.body.mode,
      layout: input.body.layout,
      resolution: input.body.resolution || "",
      referenceAssetUri: entity.referenceAssetUri || "",
      generatedImageReference: entity.attributes.generatedImageReference || null,
    }),
  });
  const requestPayload = jsonObject({
    action: input.body.action,
    projectId: input.projectId,
    projectRevision: project.revision,
    entityId: entity.id,
    entityRevision: entity.revision,
    entityType: entity.entityType,
    prompt,
    mode: input.body.mode,
    layout: input.body.layout,
    modelId: input.body.modelId,
    resolution: input.body.resolution || "",
    referenceAssetUri: entity.referenceAssetUri || "",
    generatedImageReference: entity.attributes.generatedImageReference || null,
    strictSingleSubmit: true,
    noRetry: true,
  });
  const created = await repository.createJob(input.auth.userId, {
    projectId: input.projectId,
    shotId: null,
    promptSnapshotId,
    clientRequestId: input.body.clientRequestId,
    inputHash: hashShortDramaRequest(requestPayload),
    stage: "entity_design",
    modelPublicId: input.body.modelId,
    requestPayload,
    billingSnapshot: jsonObject({ modelPublicId: input.body.modelId, resolution: input.body.resolution || "", actualCashCharged: 0 }),
  });
  const existingAssets = await repository.listAssetsForJob(input.auth.userId, input.projectId, created.job.id);
  if (created.replayed) {
    if (created.job.state === "succeeded") {
      const currentEntity = await projects.getEntity(input.auth.userId, input.projectId, entity.id);
      return {
        status: 200,
        body: jobResponse(created.job, await withFreshPreviews(existingAssets), {
          entity: currentEntity ? jsonObject(currentEntity) : null,
          replayed: true,
        }),
      };
    }
    if (["result_staging", "persisting", "retry_wait"].includes(created.job.state) && isRecord(created.job.resultPayload.generation)) {
      return persistEntityImageJob({ ...input, entityId: entity.id, job: created.job, repository });
    }
    return {
      status: 202,
      body: jobResponse(created.job, await withFreshPreviews(existingAssets), {
        replayed: true,
        message: "该实体生图请求已经登记；结果未明确前不会重复付费提交",
      }),
    };
  }
  let running = await repository.updateJob(input.auth.userId, input.projectId, created.job.id, {
    state: "running",
    progress: 20,
    attemptCount: 1,
    startedAt: new Date().toISOString(),
  });
  try {
    const generated = await callJsonRoute(
      generateImageRoute,
      internalJsonRequest(
        input.request,
        "/api/image/generate",
        "POST",
        jsonObject({
          prompt,
          modelId: input.body.modelId,
          aspectRatio: "1:1",
          resolution: input.body.resolution || undefined,
          referenceImageUrls,
          historySurface: PRODUCTION_SURFACE,
          deliveryRequirement: "recoverable_reference",
          clientTraceId: running.publicJobId,
          clientIdempotencyKey: input.body.clientRequestId,
          clientNodeId: entity.id,
          clientNodeTitle: entity.name,
          noRetry: true,
          strictSingleSubmit: true,
        }),
      ),
      "ENTITY_IMAGE_GENERATION_FAILED",
    );
    if (generated.body.success !== true || !Array.isArray(generated.body.images)) {
      throw new ShortDramaProductionError(502, "ENTITY_IMAGE_GENERATION_INVALID_RESPONSE", "图片服务没有返回有效实体图片结果");
    }
    running = await repository.updateJob(input.auth.userId, input.projectId, running.id, {
      state: "result_staging",
      provider: "image_api",
      progress: 70,
      resultPayload: { generation: imageGenerationSnapshot(generated.body) },
      billingSnapshot: jsonObject({
        ...running.billingSnapshot,
        actualCashCharged: Math.max(0, asFiniteNumber(generated.body.cashCharged)),
      }),
    });
  } catch (error) {
    await markJobFailureQuietly({ repository, auth: input.auth, projectId: input.projectId, job: running, error, retryWait: true });
    throw error;
  }
  return persistEntityImageJob({ ...input, entityId: entity.id, job: running, repository });
}

export async function generateProductionImage(input: {
  request: NextRequest;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: GenerateProductionImageRequest;
}): Promise<ProductionActionResult> {
  await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const shot = await repository.getShot(input.auth.userId, input.projectId, input.body.shotId);
  if (!shot.imagePrompt.trim()) {
    throw new ShortDramaProductionError(422, "IMAGE_PROMPT_MISSING", "该镜头没有可执行的生图提示词");
  }
  const referenceAssetUris = Array.isArray(shot.metadata.referenceAssetUris)
    ? shot.metadata.referenceAssetUris
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .slice(0, 9)
    : [];
  let referenceImageUrls: string[] = [];
  try {
    referenceImageUrls = await Promise.all(referenceAssetUris.map((assetRef) => (
      signAutodlH3OwnedAssetRefForUser({
        userId: input.auth.userId,
        assetRef,
        category: "image",
      })
    )));
  } catch {
    throw new ShortDramaProductionError(
      422,
      "IMAGE_REFERENCE_NOT_AVAILABLE",
      "镜头参考素材不属于当前账号或已经失效，请回到分镜编辑器重新选择",
    );
  }
  const promptSnapshotId = await repository.getOrCreatePromptSnapshot({
    userId: input.auth.userId,
    projectId: input.projectId,
    stage: "image_generation",
    prompt: shot.imagePrompt,
    modelPublicId: input.body.modelId,
    variables: jsonObject({
      shotId: shot.id,
      aspectRatio: shot.aspectRatio,
      resolution: input.body.resolution || "",
      referenceAssetUris,
    }),
  });
  const requestPayload = jsonObject({
    action: input.body.action,
    projectId: input.projectId,
    shotId: shot.id,
    prompt: shot.imagePrompt,
    aspectRatio: shot.aspectRatio,
    modelId: input.body.modelId,
    resolution: input.body.resolution || "",
    strictSingleSubmit: true,
    noRetry: true,
    referenceAssetUris,
  });
  const inputHash = hashShortDramaRequest(requestPayload);
  const created = await repository.createJob(input.auth.userId, {
    projectId: input.projectId,
    shotId: shot.id,
    promptSnapshotId,
    clientRequestId: input.body.clientRequestId,
    inputHash,
    stage: "image_generation",
    modelPublicId: input.body.modelId,
    requestPayload,
    billingSnapshot: jsonObject({
      modelPublicId: input.body.modelId,
      resolution: input.body.resolution || "",
      actualCashCharged: 0,
    }),
  });

  const existingAssets = await repository.listAssetsForJob(
    input.auth.userId,
    input.projectId,
    created.job.id,
  );
  if (created.replayed) {
    if (created.job.state === "succeeded") {
      return {
        status: 200,
        body: jobResponse(created.job, await withFreshPreviews(existingAssets), { replayed: true }),
      };
    }
    if (
      ["result_staging", "persisting", "retry_wait"].includes(created.job.state)
      && isRecord(created.job.resultPayload.generation)
    ) {
      return persistImageJob({ ...input, shot, job: created.job, repository });
    }
    return {
      status: 202,
      body: jobResponse(created.job, await withFreshPreviews(existingAssets), {
        replayed: true,
        message: "该幂等请求已经登记，不会重复触发付费生图",
      }),
    };
  }

  let running = await repository.updateJob(
    input.auth.userId,
    input.projectId,
    created.job.id,
    {
      state: "running",
      progress: 20,
      attemptCount: 1,
      startedAt: new Date().toISOString(),
    },
  );
  await repository.updateShotStatus(input.auth.userId, input.projectId, shot.id, "generating");

  try {
    const generated = await callJsonRoute(
      generateImageRoute,
      internalJsonRequest(
        input.request,
        "/api/image/generate",
        "POST",
        jsonObject({
          prompt: shot.imagePrompt,
          modelId: input.body.modelId,
          aspectRatio: shot.aspectRatio,
          resolution: input.body.resolution || undefined,
          referenceImageUrls,
          historySurface: PRODUCTION_SURFACE,
          deliveryRequirement: "recoverable_reference",
          clientTraceId: running.publicJobId,
          clientIdempotencyKey: input.body.clientRequestId,
          clientNodeId: shot.id,
          clientNodeTitle: shot.title,
          noRetry: true,
          strictSingleSubmit: true,
        }),
      ),
      "IMAGE_GENERATION_FAILED",
    );
    if (generated.body.success !== true || !Array.isArray(generated.body.images)) {
      throw new ShortDramaProductionError(
        502,
        "IMAGE_GENERATION_INVALID_RESPONSE",
        "图片服务没有返回有效结果",
      );
    }
    const generation = imageGenerationSnapshot(generated.body);
    running = await repository.updateJob(
      input.auth.userId,
      input.projectId,
      running.id,
      {
        state: "result_staging",
        progress: 70,
        provider: "image_api",
        upstreamTaskId: String(generation.taskId || running.publicJobId),
        resultPayload: { generation },
        billingSnapshot: jsonObject({
          ...running.billingSnapshot,
          actualCashCharged: Math.max(0, asFiniteNumber(generation.cashCharged)),
          operationId: generation.operationId,
          billingReferenceId: generation.billingReferenceId,
          settlementSource: "image_generate_response",
        }),
      },
    );
    return persistImageJob({ ...input, shot, job: running, repository });
  } catch (error) {
    await markJobFailureQuietly({
      repository,
      auth: input.auth,
      projectId: input.projectId,
      job: running,
      error,
      retryWait: ["result_staging", "persisting", "retry_wait"].includes(running.state),
      shotId: shot.id,
    });
    throw error;
  }
}

export async function generateProductionVideo(input: {
  request: NextRequest;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: GenerateProductionVideoRequest;
}): Promise<ProductionActionResult> {
  await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const shot = await repository.getShot(input.auth.userId, input.projectId, input.body.shotId);
  if (!shot.videoPrompt.trim()) {
    throw new ShortDramaProductionError(422, "VIDEO_PROMPT_MISSING", "该镜头没有可执行的视频提示词");
  }
  let imageAsset = await repository.findLatestShotAsset(
    input.auth.userId,
    input.projectId,
    shot.id,
    ["image", "storyboard"],
  );
  const production = await repository.listProduction(input.auth.userId, input.projectId);
  const latestImageJob = production.jobs.find((job) => job.shotId === shot.id && job.stage === "image_generation" && job.state === "succeeded");
  const parsedReference = GeneratedImageReferenceSchema.safeParse(latestImageJob?.resultPayload.generatedImageReference);
  const selectedImageId = typeof shot.metadata.selectedImageAssetId === "string" ? shot.metadata.selectedImageAssetId.trim() : "";
  const selectedLegacy = Boolean(selectedImageId);
  if (selectedLegacy) {
    imageAsset = production.assets.find(asset => asset.id === selectedImageId && asset.shotId === shot.id
      && ["image", "storyboard"].includes(asset.assetRole)) || null;
    if (!imageAsset) throw new ShortDramaProductionError(422, "VIDEO_SELECTED_REFERENCE_NOT_AVAILABLE", "所选镜头参考图不存在或已移除；请重新选择，本次视频未提交或扣费");
  }
  if (latestImageJob?.resultPayload.blockedOnInput === true && !selectedLegacy
    && (!imageAsset || Date.parse(latestImageJob.createdAt) >= Date.parse(imageAsset.createdAt))) {
    throw new ShortDramaProductionError(422, "VIDEO_REFERENCE_NOT_RECOVERABLE", "当前镜头图片已生成并结算，但素材不可恢复，自动编排已停止；请主动选择可用参考图，不会自动重新生图");
  }
  const imageReference = parsedReference.success && !selectedLegacy
    && (!imageAsset || Date.parse(latestImageJob!.createdAt) >= Date.parse(imageAsset.createdAt)) ? parsedReference.data : null;
  let imageUrl = "";
  if (imageReference) {
    // Resolve afresh before creating/dispatching a video job; queue stores the stable typed reference.
    await resolveGeneratedImageReference({ userId: input.auth.userId, reference: imageReference });
  } else {
    if (!imageAsset || imageAsset.provider !== DURABLE_PROVIDER || !imageAsset.objectKey) {
      throw new ShortDramaProductionError(422, "VIDEO_REFERENCE_REQUIRED", "视频生成需要可恢复的生成图片引用或已保存素材；临时图片不能进入异步任务，不会自动重新生图");
    }
    try { imageUrl = await storageManager.getSignedUrl(imageAsset.objectKey, { expireTime: 60 * 60 }, DURABLE_PROVIDER); }
    catch { throw new ShortDramaProductionError(503, "VIDEO_REFERENCE_SIGN_FAILED", "镜头参考图暂时无法签发，视频任务未提交"); }
  }
  const promptSnapshotId = await repository.getOrCreatePromptSnapshot({
    userId: input.auth.userId,
    projectId: input.projectId,
    stage: "video_generation",
    prompt: shot.videoPrompt,
    modelPublicId: input.body.modelId,
    variables: jsonObject({
      shotId: shot.id,
      ...(imageReference ? { generatedImageReference: imageReference } : { imageAssetId: imageAsset!.id }),
      aspectRatio: shot.aspectRatio,
      resolution: input.body.resolution || "",
      duration: input.body.duration,
    }),
  });
  const requestPayload = jsonObject({
    action: input.body.action,
    projectId: input.projectId,
    shotId: shot.id,
    prompt: shot.videoPrompt,
    negativePrompt: shot.negativePrompt,
    ...(imageReference ? { generatedImageReference: imageReference } : { imageAssetId: imageAsset!.id }),
    ...(imageReference ? {} : { imageStorageKey: imageAsset!.objectKey }),
    modelId: input.body.modelId,
    resolution: input.body.resolution || "",
    duration: input.body.duration,
    aspectRatio: shot.aspectRatio,
    surface: PRODUCTION_SURFACE,
  });
  const inputHash = hashShortDramaRequest(requestPayload);
  const created = await repository.createJob(input.auth.userId, {
    projectId: input.projectId,
    shotId: shot.id,
    promptSnapshotId,
    clientRequestId: input.body.clientRequestId,
    inputHash,
    stage: "video_generation",
    modelPublicId: input.body.modelId,
    requestPayload,
    billingSnapshot: jsonObject({
      modelPublicId: input.body.modelId,
      resolution: input.body.resolution || "",
      duration: input.body.duration,
      actualCashCharged: 0,
    }),
  });
  if (created.replayed) {
    const assets = await repository.listAssetsForJob(
      input.auth.userId,
      input.projectId,
      created.job.id,
    );
    return {
      status: created.job.state === "succeeded" ? 200 : 202,
      body: jobResponse(created.job, await withFreshPreviews(assets), {
        replayed: true,
        message: "该幂等请求已经登记，不会重复触发付费视频生成",
      }),
    };
  }

  let running = await repository.updateJob(
    input.auth.userId,
    input.projectId,
    created.job.id,
    {
      state: "running",
      progress: 10,
      attemptCount: 1,
      startedAt: new Date().toISOString(),
    },
  );
  await repository.updateShotStatus(input.auth.userId, input.projectId, shot.id, "generating");

  try {
    const generated = await callJsonRoute(
      generateVideoRoute,
      internalJsonRequest(
        input.request,
        "/api/video/generate",
        "POST",
        jsonObject({
          model_id: input.body.modelId,
          prompt: shot.videoPrompt,
          negative_prompt: shot.negativePrompt || undefined,
          ...(imageReference ? { image_ref: imageReference } : { image_url: imageUrl, image_storage_key: imageAsset!.objectKey }),
          duration: input.body.duration,
          aspect_ratio: shot.aspectRatio,
          resolution_tier: input.body.resolution || undefined,
          task_label: shot.title,
          batch_id: input.projectId,
          batch_topic: shot.id,
          card_index: shot.sequence,
          surface: PRODUCTION_SURFACE,
          client_request_id: input.body.clientRequestId,
        }),
      ),
      "VIDEO_GENERATION_FAILED",
    );
    const submission = videoSubmissionSnapshot(generated.body);
    const upstreamTaskId = String(submission.taskId || "").trim();
    if (!upstreamTaskId) {
      throw new ShortDramaProductionError(
        502,
        "VIDEO_GENERATION_INVALID_RESPONSE",
        "视频服务没有返回可追踪的任务编号",
      );
    }
    const submissionStatus = String(submission.status || "pending").toLowerCase();
    running = await repository.updateJob(
      input.auth.userId,
      input.projectId,
      running.id,
      {
        state: submissionStatus === "queued" || submissionStatus === "pending" ? "queued" : "running",
        progress: submissionStatus === "completed" ? 70 : 15,
        provider: "video_api",
        upstreamTaskId,
        resultPayload: { submission },
        billingSnapshot: jsonObject({
          ...running.billingSnapshot,
          quotedPrice: asFiniteNumber(submission.quotedPrice),
          actualCashCharged: 0,
        }),
      },
    );
    if (submissionStatus === "completed" || submissionStatus === "processing") {
      return pollVideoJob({ ...input, shot, job: running, repository });
    }
    return {
      status: 202,
      body: jobResponse(running, [], { message: "视频任务已登记并提交，等待安全轮询" }),
    };
  } catch (error) {
    await markJobFailureQuietly({
      repository,
      auth: input.auth,
      projectId: input.projectId,
      job: running,
      error,
      retryWait: Boolean(running.upstreamTaskId),
      shotId: shot.id,
    });
    throw error;
  }
}

export async function pollProductionJob(input: {
  request: NextRequest;
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: PollProductionJobRequest;
}): Promise<ProductionActionResult> {
  await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const job = await repository.getJob(input.auth.userId, input.projectId, input.body.jobId);
  const assets = await repository.listAssetsForJob(input.auth.userId, input.projectId, job.id);
  if (["succeeded", "failed", "cancelled"].includes(job.state)) {
    return { status: 200, body: jobResponse(job, await withFreshPreviews(assets)) };
  }
  if (job.stage === "entity_design") {
    const entityId = typeof job.requestPayload.entityId === "string"
      ? job.requestPayload.entityId
      : "";
    if (!entityId) {
      throw new ShortDramaProductionError(
        409,
        "ENTITY_IMAGE_JOB_INVALID",
        "实体图片任务缺少实体标识，已停止恢复且不会重复付费生成",
      );
    }
    if (
      ["result_staging", "persisting", "retry_wait"].includes(job.state)
      && isRecord(job.resultPayload.generation)
    ) {
      return persistEntityImageJob({ ...input, entityId, job, repository });
    }
    return {
      status: 200,
      body: jobResponse(job, await withFreshPreviews(assets), {
        message: "实体图片任务已登记；轮询只恢复已返回结果，不会重复触发付费生成",
      }),
    };
  }
  if (!job.shotId) {
    return { status: 200, body: jobResponse(job, await withFreshPreviews(assets)) };
  }
  const shot = await repository.getShot(input.auth.userId, input.projectId, job.shotId);
  if (job.stage === "image_generation") {
    if (
      ["result_staging", "persisting", "retry_wait"].includes(job.state)
      && isRecord(job.resultPayload.generation)
    ) {
      return persistImageJob({ ...input, shot, job, repository });
    }
    return {
      status: 200,
      body: jobResponse(job, await withFreshPreviews(assets), {
        message: "图片任务已登记；不会通过轮询重复触发付费生成",
      }),
    };
  }
  if (job.stage !== "video_generation") {
    return { status: 200, body: jobResponse(job, await withFreshPreviews(assets)) };
  }
  return pollVideoJob({ ...input, shot, job, repository });
}

export async function assembleProductionFinal(input: {
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: AssembleProductionFinalRequest;
}): Promise<ProductionActionResult> {
  const project = await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const production = await repository.listProduction(input.auth.userId, input.projectId);
  const shots = [...production.shots].sort((left, right) => left.sequence - right.sequence);
  if (shots.length === 0) {
    throw new ShortDramaProductionError(409, "FINAL_ASSEMBLY_NO_SHOTS", "请先创建并保存分镜计划");
  }
  if (shots.length > FINAL_ASSEMBLY_MAX_SHOTS) {
    throw new ShortDramaProductionError(
      422,
      "FINAL_ASSEMBLY_TOO_MANY_SHOTS",
      `单次整片合成最多支持 ${FINAL_ASSEMBLY_MAX_SHOTS} 个镜头`,
    );
  }

  const persistedTimeline = timelineFromSourcePayload(project.sourcePayload);
  const requestedTimeline = input.body.timeline ?? persistedTimeline;
  const usesTimeline = requestedTimeline.length > 0;
  let timelineEntries: Array<{ clip: ProductionTimelineClip; shot: ProductionShot; asset: ProductionAsset }>;
  if (usesTimeline) {
    timelineEntries = validateTimelineClips({
      clips: requestedTimeline,
      shots,
      assets: production.assets,
    }).filter((entry) => entry.clip.enabled);
    if (timelineEntries.length === 0) {
      throw new ShortDramaProductionError(422, "TIMELINE_HAS_NO_ENABLED_CLIPS", "时间线没有启用的片段，不能生成整片");
    }
  } else {
    const defaultEntries = shots.map((shot) => {
      const asset = selectedShotAsset(shot, production.assets, "video");
      return asset ? { shot, asset } : null;
    });
    const missingShots = defaultEntries.flatMap((entry, index) => entry ? [] : [shots[index]]);
    if (missingShots.length > 0) {
      throw new ShortDramaProductionError(
        409,
        "FINAL_ASSEMBLY_INCOMPLETE",
        `还有 ${missingShots.length} 个镜头没有已持久化视频，不能生成整片`,
        { missingSequences: missingShots.map((shot) => shot.sequence) },
      );
    }
    timelineEntries = defaultEntries.map((entry) => {
      const resolved = entry!;
      return {
        ...resolved,
        clip: {
          id: `default-${resolved.shot.id}`,
          shotId: resolved.shot.id,
          assetId: resolved.asset.id,
          enabled: true,
          startSeconds: 0,
          endSeconds: assetDeclaredDuration(resolved.asset, resolved.shot),
        },
      };
    });
  }
  const sourceAssets = timelineEntries.map((entry) => entry.asset);
  const assemblyShots = timelineEntries.map((entry, index) => ({
    ...entry.shot,
    sequence: index + 1,
    durationSeconds: entry.clip.endSeconds - entry.clip.startSeconds,
  }));
  for (const asset of sourceAssets) {
    const stable = parseStableObjectUri(asset.stableUri);
    if (
      asset.provider !== DURABLE_PROVIDER
      || !asset.objectKey
      || stable?.provider !== DURABLE_PROVIDER
      || stable.objectKey !== asset.objectKey
    ) {
      throw new ShortDramaProductionError(
        409,
        "FINAL_ASSEMBLY_SOURCE_NOT_DURABLE",
        "整片合成只接受当前项目内已登记的腾讯 COS 稳定视频资产",
      );
    }
  }
  const declaredSourceBytes = sourceAssets.reduce(
    (total, asset) => total + Math.max(0, Number(asset.byteSize) || 0),
    0,
  );
  if (declaredSourceBytes > FINAL_ASSEMBLY_MAX_SOURCE_BYTES) {
    throw new ShortDramaProductionError(413, "FINAL_ASSEMBLY_SOURCE_TOO_LARGE", "整片源视频超过单次安全处理上限");
  }

  const requestPayload = jsonObject({
    projectId: input.projectId,
    action: input.body.action,
    burnSubtitles: input.body.burnSubtitles,
    sourceAssetIds: sourceAssets.map((asset) => asset.id),
    sourceShotIds: timelineEntries.map((entry) => entry.shot.id),
    timeline: requestedTimeline as unknown as JsonValue,
    usesTimeline,
  });
  const created = await repository.createJob(input.auth.userId, {
    projectId: input.projectId,
    shotId: null,
    clientRequestId: input.body.clientRequestId,
    inputHash: hashShortDramaRequest(requestPayload),
    stage: "final_assembly",
    modelPublicId: null,
    requestPayload,
    billingSnapshot: {
      billingMode: "free_local_assembly",
      estimatedCash: 0,
      actualCashCharged: 0,
    },
  });
  if (created.replayed) {
    const assets = await repository.listAssetsForJob(input.auth.userId, input.projectId, created.job.id);
    if (created.job.state === "succeeded") {
      return {
        status: 200,
        body: jobResponse(created.job, await withFreshPreviews(assets), { replayed: true }),
      };
    }
    if (["failed", "cancelled"].includes(created.job.state)) {
      throw new ShortDramaProductionError(
        409,
        "FINAL_ASSEMBLY_PREVIOUS_TERMINAL",
        "该成片请求已经结束；如需重新合成，请创建新的请求",
      );
    }
  }

  const claimed = await repository.claimLocalJobExecution(
    input.auth.userId,
    input.projectId,
    created.job.id,
  );
  if (!claimed) {
    const current = await repository.getJob(input.auth.userId, input.projectId, created.job.publicJobId);
    const assets = await repository.listAssetsForJob(input.auth.userId, input.projectId, current.id);
    return {
      status: 202,
      body: jobResponse(current, await withFreshPreviews(assets), {
        replayed: true,
        message: "整片合成正在执行，不会并发重复处理",
      }),
    };
  }

  let workingJob = claimed;
  try {
    const mediaInputs: Array<{ bytes: Buffer; extension: string }> = [];
    const sourceBytesByAssetId = new Map<string, Buffer>();
    let actualSourceBytes = 0;
    for (const entry of timelineEntries) {
      const asset = entry.asset;
      let bytes = sourceBytesByAssetId.get(asset.id);
      if (!bytes) {
        bytes = await storageManager.read(asset.objectKey, DURABLE_PROVIDER);
        sourceBytesByAssetId.set(asset.id, bytes);
      }
      actualSourceBytes += bytes.length;
      if (actualSourceBytes > FINAL_ASSEMBLY_MAX_SOURCE_BYTES) {
        throw new ShortDramaProductionError(413, "FINAL_ASSEMBLY_SOURCE_TOO_LARGE", "整片源视频超过单次安全处理上限");
      }
      if (!bytes.length) {
        throw new ShortDramaProductionError(502, "FINAL_ASSEMBLY_SOURCE_EMPTY", "稳定视频资产内容为空，已停止合成");
      }
      if (usesTimeline) {
        const trimmed = await processLocalMedia({
          action: "trim",
          inputs: [{ bytes, extension: ".mp4" }],
          startSeconds: entry.clip.startSeconds,
          endSeconds: entry.clip.endSeconds,
        });
        mediaInputs.push({ bytes: trimmed.bytes, extension: trimmed.extension });
      } else {
        mediaInputs.push({ bytes, extension: ".mp4" });
      }
    }

    const frame = resolveAssemblyFrameSize(assemblyShots[0]?.aspectRatio || "16:9");
    const concatenated = mediaInputs.length === 1
      ? {
          bytes: mediaInputs[0].bytes,
          contentType: "video/mp4",
          extension: ".mp4",
          filename: `${workingJob.publicJobId}.mp4`,
        }
      : await processLocalMedia({
          action: "concat",
          inputs: mediaInputs,
          targetWidth: frame.width,
          targetHeight: frame.height,
        });
    const subtitleText = buildShortDramaSrt(assemblyShots);
    const assembled = input.body.burnSubtitles && subtitleText
      ? await burnSrtSubtitles(
          { bytes: concatenated.bytes, extension: concatenated.extension },
          subtitleText,
        )
      : concatenated;

    workingJob = await repository.updateJob(
      input.auth.userId,
      input.projectId,
      workingJob.id,
      { state: "persisting", progress: 82 },
    );

    let subtitleAsset: ProductionAsset | null = null;
    if (subtitleText) {
      const subtitleBytes = Buffer.from(subtitleText, "utf8");
      const subtitleUpload = await storageManager.upload(
        subtitleBytes,
        `${workingJob.publicJobId}.srt`,
        "application/x-subrip; charset=utf-8",
        {
          category: "document",
          prefix: "short-drama/final/",
          fileName: `${workingJob.publicJobId}.srt`,
          providerType: DURABLE_PROVIDER,
          strictProvider: true,
          userId: input.auth.userId,
          requireOwnershipRecord: true,
          source: "影视工坊整片字幕",
          meta: { projectId: input.projectId, publicJobId: workingJob.publicJobId },
        },
      );
      subtitleAsset = await repository.createAsset({
        userId: input.auth.userId,
        projectId: input.projectId,
        shotId: null,
        jobId: workingJob.id,
        assetRole: "subtitle",
        provider: DURABLE_PROVIDER,
        objectKey: subtitleUpload.key,
        stableUri: stableObjectUri(subtitleUpload.key),
        mimeType: "application/x-subrip; charset=utf-8",
        byteSize: subtitleUpload.size,
        checksumSha256: createHash("sha256").update(subtitleBytes).digest("hex"),
        metadata: jsonObject({
          format: "srt",
          shotCount: assemblyShots.length,
          totalDurationSeconds: totalShotDuration(assemblyShots),
          burnedIntoVideo: input.body.burnSubtitles,
          timeline: requestedTimeline as unknown as JsonValue,
        }),
      });
    }

    const finalUpload = await storageManager.upload(
      assembled.bytes,
      `${workingJob.publicJobId}.mp4`,
      "video/mp4",
      {
        category: "video",
        prefix: "short-drama/final/",
        fileName: `${workingJob.publicJobId}.mp4`,
        providerType: DURABLE_PROVIDER,
        strictProvider: true,
        userId: input.auth.userId,
        requireOwnershipRecord: true,
        source: "影视工坊统一成片",
        meta: { projectId: input.projectId, publicJobId: workingJob.publicJobId },
      },
    );
    const finalAsset = await repository.createAsset({
      userId: input.auth.userId,
      projectId: input.projectId,
      shotId: null,
      jobId: workingJob.id,
      assetRole: "export",
      provider: DURABLE_PROVIDER,
      objectKey: finalUpload.key,
      stableUri: stableObjectUri(finalUpload.key),
      mimeType: "video/mp4",
      byteSize: finalUpload.size,
      checksumSha256: createHash("sha256").update(assembled.bytes).digest("hex"),
      metadata: jsonObject({
        sourceAssetIds: sourceAssets.map((asset) => asset.id),
        shotCount: assemblyShots.length,
        totalDurationSeconds: totalShotDuration(assemblyShots),
        aspectRatio: assemblyShots[0]?.aspectRatio || "16:9",
        width: frame.width,
        height: frame.height,
        subtitlesBurned: input.body.burnSubtitles && Boolean(subtitleText),
        subtitleAssetId: subtitleAsset?.id || null,
        timeline: requestedTimeline as unknown as JsonValue,
      }),
    });
    await repository.createSettlement({
      userId: input.auth.userId,
      projectId: input.projectId,
      job: workingJob,
      cashCharged: 0,
      creditsCharged: 0,
      costAmount: 0,
      pricingSnapshot: {
        source: "local_ffmpeg_final_assembly",
        modelInvoked: false,
        cashCharged: 0,
      },
    });
    workingJob = await repository.updateJob(
      input.auth.userId,
      input.projectId,
      workingJob.id,
      {
        state: "succeeded",
        provider: DURABLE_PROVIDER,
        progress: 100,
        resultPayload: jsonObject({
          finalAssetId: finalAsset.id,
          finalStableUri: finalAsset.stableUri,
          subtitleAssetId: subtitleAsset?.id || null,
          sourceAssetIds: sourceAssets.map((asset) => asset.id),
          shotCount: assemblyShots.length,
          totalDurationSeconds: totalShotDuration(assemblyShots),
          timeline: requestedTimeline as unknown as JsonValue,
        }),
        billingSnapshot: {
          billingMode: "free_local_assembly",
          estimatedCash: 0,
          actualCashCharged: 0,
          modelInvoked: false,
        },
        errorCode: null,
        errorMessage: null,
        completedAt: new Date().toISOString(),
      },
    );
    return {
      status: 201,
      body: jobResponse(
        workingJob,
        await withFreshPreviews([finalAsset, ...(subtitleAsset ? [subtitleAsset] : [])]),
        { replayed: created.replayed },
      ),
    };
  } catch (error) {
    await markJobFailureQuietly({
      repository,
      auth: input.auth,
      projectId: input.projectId,
      job: workingJob,
      error,
    });
    if (error instanceof ShortDramaProductionError) throw error;
    throw new ShortDramaProductionError(
      500,
      "FINAL_ASSEMBLY_FAILED",
      "整片合成失败，未把任务标记为完成；可检查源视频后创建新请求",
    );
  }
}

export async function prepareProductionExport(input: {
  auth: ShortDramaAuthorizationContext;
  projectId: string;
  body: ProductionExportRequest;
}): Promise<{ taskId: string; job: ProductionJob }> {
  await requireOwnedProject(input.auth, input.projectId);
  const repository = ShortDramaProductionRepository.fromAuth(input.auth);
  await repository.assertProductionMigrationReady(input.auth.userId, input.projectId);
  const job = await repository.getJob(input.auth.userId, input.projectId, input.body.jobId);
  if (job.stage !== "video_generation" || job.state !== "succeeded" || !job.upstreamTaskId) {
    throw new ShortDramaProductionError(
      409,
      "VIDEO_JOB_NOT_EXPORTABLE",
      "只有已经成功并登记稳定资产的视频任务可以导出",
    );
  }
  const assets = await repository.listAssetsForJob(input.auth.userId, input.projectId, job.id);
  if (!assets.some((asset) => asset.assetRole === "video" && asset.stableUri.startsWith(DURABLE_URI_PREFIX))) {
    throw new ShortDramaProductionError(
      409,
      "VIDEO_ASSET_NOT_DURABLE",
      "视频稳定资产尚未登记，不能导出",
    );
  }
  return { taskId: job.upstreamTaskId, job };
}

export function productionErrorBody(error: ShortDramaProductionError): JsonObject {
  return {
    error: error.message,
    code: error.code,
    ...(error.details ? { details: error.details } : {}),
  };
}
