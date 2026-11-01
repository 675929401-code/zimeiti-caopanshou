import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VideoGenerateParams, VideoModelConfig } from "@/lib/video-adapter";
import type { StorageProviderType } from "@/storage/object/types";
import { gaoruiSeedanceNativeBody } from "@/lib/gaorui-seedance-native-contract";
import { gaoruiCredentialBindingFingerprint, gaoruiProviderOrigin } from "@/lib/gaorui-provider-asset-contract";
import { assertGaoruiPersonAssetFeeAuthorization, type GaoruiAssetPreparationAuthorization } from "@/lib/gaorui-person-asset-admission";
import { GaoruiProviderAssetError, prepareGaoruiPersonAsset, type GaoruiAssetDependencies, type GaoruiAssetState } from "./gaorui-provider-assets";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Matches buildVideoTaskIdentity and the existing video-task-status validator.
const VIDEO_TASK_ID = /^vt_[a-f0-9]{40}$/u;
export type GaoruiAssetSubmissionOutcome = "ready" | "processing" | "unknown" | "reconciliation_required" | "failed";
function row(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }

function outcome(state: GaoruiAssetState | undefined): GaoruiAssetSubmissionOutcome {
  return state === "ready" ? "ready" : state === "processing" ? "processing" : state === "failed" ? "failed"
    : state === "reconciliation_required" ? "reconciliation_required" : "unknown";
}

/** Safe task linkage only: never persist provider URI, signed URL, or credential. */
export async function persistGaoruiPersonAssetPreparation(input: {
  db: SupabaseClient;
  taskInternalId: string;
  userId: string;
  operationId: string;
  state: GaoruiAssetState;
  assetSubmissionOutcome: GaoruiAssetSubmissionOutcome;
}): Promise<void> {
  if (!VIDEO_TASK_ID.test(input.taskInternalId) || !UUID.test(input.userId) || !UUID.test(input.operationId)) {
    throw new GaoruiProviderAssetError("GAORUI_ASSET_TASK_METADATA_INVALID", "reconciliation_required", input.operationId);
  }
  const previous = await input.db.from("video_tasks").select("id,user_id,provider_asset_preparation")
    .eq("id", input.taskInternalId).eq("user_id", input.userId).maybeSingle();
  const task = row(previous.data);
  const existing = row(task.provider_asset_preparation);
  if (previous.error || task.id !== input.taskInternalId || task.user_id !== input.userId
    || (Object.keys(existing).length > 0 && existing.operation_id !== input.operationId)) {
    throw new GaoruiProviderAssetError("GAORUI_ASSET_TASK_METADATA_UNAVAILABLE", "reconciliation_required", input.operationId);
  }
  const metadata = { schema: "gaorui_person_asset_preparation.v1", operation_id: input.operationId,
    state: input.state, asset_submission_outcome: input.assetSubmissionOutcome };
  let update = input.db.from("video_tasks").update({ provider_asset_preparation: metadata })
    .eq("id", input.taskInternalId).eq("user_id", input.userId);
  update = task.provider_asset_preparation == null
    ? update.is("provider_asset_preparation", null)
    : update.eq("provider_asset_preparation->>operation_id", input.operationId);
  const saved = await update.select("id").maybeSingle();
  if (saved.error || row(saved.data).id !== input.taskInternalId) {
    throw new GaoruiProviderAssetError("GAORUI_ASSET_TASK_METADATA_UNAVAILABLE", "reconciliation_required", input.operationId);
  }
}

async function ownedInput(db: SupabaseClient, userId: string, id: string, category: "image" | "audio"): Promise<Row> {
  if (!UUID.test(userId) || !UUID.test(id)) throw new GaoruiProviderAssetError("GAORUI_DIGITAL_HUMAN_OWNED_INPUT_REQUIRED");
  const found = await db.from("user_files").select("*").eq("id", id).eq("user_id", userId).eq("file_category", category).maybeSingle();
  const asset = row(found.data);
  const meta = row(asset.meta);
  const acceptedSource = asset.source === "digital-human-input" || (category === "audio" && asset.source === "voice-generation");
  if (found.error || asset.id !== id || asset.user_id !== userId || asset.file_category !== category || !acceptedSource
    || asset.storage_provider !== "tencent_cos" || typeof asset.storage_key !== "string" || !asset.storage_key
    || asset.deleted_at || asset.is_deleted === true || meta.deleted_at || meta.deletedAt || meta.deleted === true
    || !String(asset.content_type).startsWith(`${category}/`) || !(Number(asset.file_size) > 0)
    || Number(asset.file_size) > (category === "image" ? 20 : 30) * 1024 * 1024) {
    throw new GaoruiProviderAssetError("GAORUI_DIGITAL_HUMAN_OWNED_INPUT_REQUIRED");
  }
  if (asset.source === "voice-generation") {
    const receipt = await db.from("voice_generation_requests").select("id")
      .eq("user_id", userId).eq("asset_id", id).eq("state", "completed").limit(1).maybeSingle();
    if (receipt.error || !receipt.data) throw new GaoruiProviderAssetError("GAORUI_DIGITAL_HUMAN_OWNED_INPUT_REQUIRED");
  }
  return asset;
}

async function sign(storage: GaoruiAssetDependencies["storage"], asset: Row): Promise<string> {
  const value = await storage.getSignedUrl(String(asset.storage_key), { expireTime: 3600 }, asset.storage_provider as StorageProviderType);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port
    || decodeURIComponent(url.pathname.slice(1)) !== asset.storage_key) throw new GaoruiProviderAssetError("GAORUI_DIGITAL_HUMAN_SIGNED_INPUT_INVALID");
  return value;
}

/** Only call after a new video reservation; no request snapshot is mutated. */
export async function prepareGaoruiPersonVideoExecution(input: {
  userId: string;
  ownedPersonAssetId: string;
  ownedAudioAssetId: string;
  model: VideoModelConfig;
  taskInternalId: string;
  originalParams: VideoGenerateParams;
  authorization?: GaoruiAssetPreparationAuthorization;
}, given?: Partial<GaoruiAssetDependencies>): Promise<VideoGenerateParams> {
  let knownOperationId: string | undefined;
  try {
    const model = input.model;
    if (model.protocol_type !== "gaorui_video" || model.model_name !== "seedance-2.0-fast" || !VIDEO_TASK_ID.test(input.taskInternalId)) {
      throw new GaoruiProviderAssetError("GAORUI_PERSON_ASSET_EXECUTION_SCOPE_INVALID");
    }
    const fingerprint = gaoruiCredentialBindingFingerprint({ secret: model.api_key, modelId: model.id, endpoint: model.api_endpoint });
    const authorization = input.authorization;
    assertGaoruiPersonAssetFeeAuthorization(authorization, {
      modelId: model.id, modelName: model.model_name, providerOrigin: gaoruiProviderOrigin(model.api_endpoint), credentialBindingFingerprint: fingerprint,
    });
    const original = input.originalParams;
    if (original.lastFrameUrl || original.sourceVideoUrl || original.referenceImageUrl
      || original.imageUrls?.length || original.audioUrls?.length || original.gaoruiTrustedPersonAssets?.length) {
      throw new GaoruiProviderAssetError("GAORUI_PERSON_ASSET_EXECUTION_MODE_INVALID");
    }
    const db = given?.db ?? (await import("@/storage/database/supabase-client")).getSupabaseAdminClient();
    const storage = given?.storage ?? (await import("@/storage/object")).storageManager;
    const [person, audio] = await Promise.all([
      ownedInput(db, input.userId, input.ownedPersonAssetId, "image"), ownedInput(db, input.userId, input.ownedAudioAssetId, "audio"),
    ]);
    const [personUrl, audioUrl] = await Promise.all([sign(storage, person), sign(storage, audio)]);
    const execution: VideoGenerateParams = { ...original, inputOwnerId: input.userId,
      imageUrl: undefined, referenceImageUrl: personUrl, audioUrl,
      gaoruiOwnedPersonAssetId: input.ownedPersonAssetId };
    // Invalid video options fail before a potentially billable asset request.
    gaoruiSeedanceNativeBody(model, execution);
    let trusted;
    try {
      trusted = await prepareGaoruiPersonAsset({ userId: input.userId, ownedAssetId: input.ownedPersonAssetId,
        modelId: model.id, modelName: model.model_name, endpoint: model.api_endpoint,
        credentialBindingFingerprint: fingerprint, secret: model.api_key, authorization }, { ...given, db, storage,
        onClaim: async ({ operationId, state }) => {
          knownOperationId = operationId;
          await persistGaoruiPersonAssetPreparation({ db, taskInternalId: input.taskInternalId, userId: input.userId,
            operationId, state, assetSubmissionOutcome: outcome(state) });
        },
      });
    } catch (error) {
      if (error instanceof GaoruiProviderAssetError && error.operationId) {
        await persistGaoruiPersonAssetPreparation({ db, taskInternalId: input.taskInternalId, userId: input.userId,
          operationId: error.operationId, state: error.state ?? "reconciliation_required", assetSubmissionOutcome: outcome(error.state) });
      }
      throw error;
    }
    execution.referenceImageUrl = trusted.sourceUrl;
    execution.gaoruiTrustedPersonAssets = [trusted];
    gaoruiSeedanceNativeBody(model, execution);
    await persistGaoruiPersonAssetPreparation({ db, taskInternalId: input.taskInternalId, userId: input.userId,
      operationId: trusted.operationId, state: "ready", assetSubmissionOutcome: "ready" });
    return execution;
  } catch (error) {
    if (error instanceof GaoruiProviderAssetError) {
      if (!error.operationId && knownOperationId) throw new GaoruiProviderAssetError(error.code, error.state ?? "reconciliation_required", knownOperationId);
      throw error;
    }
    const code = error instanceof Error ? error.message.split(":")[0] : "";
    throw new GaoruiProviderAssetError(/^GAORUI_[A-Z0-9_]+$/u.test(code) ? code : "GAORUI_PERSON_ASSET_EXECUTION_UNAVAILABLE",
      knownOperationId ? "reconciliation_required" : undefined, knownOperationId);
  }
}
