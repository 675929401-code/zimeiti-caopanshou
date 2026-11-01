import type { SupabaseClient } from "@supabase/supabase-js";
import { parseImageFailureRequestSnapshot } from "@/lib/image-failure-history";
import { hasStoryboardDirectorAssetConfirmation, storyboardDirectorCandidateMatchesDraft } from "@/lib/storyboard-director-asset-confirmation";
import { buildStoryboardThreeViewPrompt } from "@/lib/storyboard-visual-asset-three-view";
import { StoryboardVisualAssetPlanSchema } from "@/lib/storyboard-workbench";
import { StoryboardVisualAssetCandidateSchema, type StoryboardVisualAssetCandidate } from "@/lib/storyboard-visual-asset-workspace";
import { isPublicVideoAssetUrl } from "@/lib/video-public-url";

type OwnedProject = { id: unknown; owner_id: unknown; deleted: unknown; document: unknown };
type OwnedImage = { record_id: unknown; user_id: unknown; state: unknown; delivery_state: unknown; response: unknown; request_snapshot: unknown };
export type StoryboardDirectorOriginalAssetCandidate = StoryboardVisualAssetCandidate & { previewUrl: string };
export type StoryboardDirectorOriginalAssetDependencies = {
  loadOwnedProject(projectId: string, userId: string): Promise<OwnedProject | null>;
  loadOwnedImage(recordId: string, userId: string): Promise<OwnedImage | null>;
  resolveReadableImage(recordId: string, userId: string, image: OwnedImage): Promise<{ reference: { recordId: string; previewUrl: string } }>;
};

export class StoryboardDirectorOriginalAssetError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}

const PROJECT_ID = /^[A-Za-z0-9:_-]{8,160}$/u;
const PLAN_ID = /^[a-z][a-z0-9_-]{2,63}$/u;
const HISTORY_ID = /^[a-f0-9]{64}$/u;
const LEGACY_ASSET_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unavailable(): never {
  throw new StoryboardDirectorOriginalAssetError("DIRECTOR_ORIGINAL_ASSET_UNAVAILABLE", "原生成图证据不完整或不匹配，请保留当前图片并核对原项目。");
}

export function parseStoryboardDirectorOriginalAssetQuery(params: URLSearchParams) {
  const projectId = params.get("projectId") || "";
  const assetId = params.get("assetId") || "";
  if (params.getAll("projectId").length !== 1 || params.getAll("assetId").length !== 1
    || !PROJECT_ID.test(projectId) || !PLAN_ID.test(assetId)) {
    throw new StoryboardDirectorOriginalAssetError("DIRECTOR_ORIGINAL_ASSET_QUERY_INVALID", "原生成图的项目或资产标识无效。", 400);
  }
  return { projectId, assetId };
}

/** Authenticated owner-filtered reads only; the established resolver performs its bounded safe image read. */
export function storyboardDirectorOriginalAssetDependencies(db: SupabaseClient): StoryboardDirectorOriginalAssetDependencies {
  return {
    async loadOwnedProject(projectId, userId) {
      const { data, error } = await db.from("storyboard_projects").select("id,owner_id,deleted,document")
        .eq("id", projectId).eq("owner_id", userId).eq("deleted", false)
        .abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
      if (error) throw new Error("DIRECTOR_ORIGINAL_PROJECT_LOOKUP_UNAVAILABLE");
      return data;
    },
    async loadOwnedImage(recordId, userId) {
      const { data, error } = await db.from("image_generation_requests")
        .select("record_id,user_id,state,delivery_state,response,request_snapshot")
        .eq("record_id", recordId).eq("user_id", userId)
        .abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
      if (error) throw new Error("DIRECTOR_ORIGINAL_IMAGE_LOOKUP_UNAVAILABLE");
      return data;
    },
    async resolveReadableImage(recordId, userId, image) {
      const [{ resolveStoryboardVisualAssetReference }, { validateOwnedGeneratedImageReference }, { readProviderImage }] = await Promise.all([
        import("@/lib/server/storyboard-visual-asset-reference"),
        import("@/lib/server/generated-image-reference"),
        import("@/lib/image-provider-delivery"),
      ]);
      return resolveStoryboardVisualAssetReference(userId, recordId, {
        validateOwned: (input) => validateOwnedGeneratedImageReference(input, {
          // Reuse the row read through this request's authenticated client.
          findOwned: async (requestedRecordId, requestedUserId) => image.record_id === requestedRecordId
            && image.user_id === requestedUserId ? image : null,
          validateUrl: async () => undefined,
        }),
        read: readProviderImage,
      });
    },
  };
}

/**
 * Reconstruct a candidate from an owned immutable request, never from a saved
 * object's UUID/key. Returning this candidate neither adopts nor confirms it.
 * All I/O is injected so contract checks cannot reach a database or provider.
 */
export async function resolveStoryboardDirectorOriginalAsset(input: {
  userId: string; projectId: string; assetId: string;
}, deps: StoryboardDirectorOriginalAssetDependencies): Promise<StoryboardDirectorOriginalAssetCandidate> {
  if (!input.userId || !PROJECT_ID.test(input.projectId) || !PLAN_ID.test(input.assetId)) {
    throw new StoryboardDirectorOriginalAssetError("DIRECTOR_ORIGINAL_ASSET_QUERY_INVALID", "原生成图的项目或资产标识无效。", 400);
  }
  const project = await deps.loadOwnedProject(input.projectId, input.userId);
  if (!project || project.id !== input.projectId || project.owner_id !== input.userId || project.deleted !== false) {
    throw new StoryboardDirectorOriginalAssetError("DIRECTOR_ORIGINAL_PROJECT_NOT_FOUND", "原项目不存在或不属于当前账号。", 404);
  }
  const document = project.document;
  if (!record(document) || !record(document.directorIntake)
    || !["assets", "planned"].includes(String(document.directorIntake.phase))) unavailable();
  const planned = document.directorIntake.phase === "planned";
  if (planned && document.id !== input.projectId) unavailable();
  const parsedPlan = StoryboardVisualAssetPlanSchema.safeParse(document.visualAssetPlan);
  if (!parsedPlan.success || parsedPlan.data.mode !== "selected") unavailable();
  const asset = parsedPlan.data.assets.find(item => item.id === input.assetId);
  if (!asset || (asset.role !== "character" && asset.role !== "pet")) unavailable();
  const turnarounds = asset.referencePrompts.filter(reference => reference.kind === "turnaround");
  if (!turnarounds.length || !record(document.visualAssetWorkspace)
    || !Array.isArray(document.visualAssetWorkspace.candidates)) unavailable();
  const candidates = document.visualAssetWorkspace.candidates.flatMap(value => {
    const parsed = StoryboardVisualAssetCandidateSchema.safeParse(value);
    if (!parsed.success) return [];
    const candidate = parsed.data;
    return candidate.planId === asset.id && candidate.role === asset.role
      && (!candidate.projectId || candidate.projectId === input.projectId)
      && candidate.source !== "platform-preset" && candidate.historyRecordId
      && (candidate.assetId === `generated_${candidate.historyRecordId}` || LEGACY_ASSET_ID.test(candidate.assetId)) ? [candidate] : [];
  });
  let candidate: StoryboardVisualAssetCandidate | undefined;
  if (asset.source) {
    const source = asset.source;
    if (source.kind !== "generated-image-history" || !source.historyRecordId || !HISTORY_ID.test(source.historyRecordId)) unavailable();
    const selected = candidates.filter(item => item.assetId === source.assetId && item.historyRecordId === source.historyRecordId);
    if (planned && (source.assetId !== `generated_${source.historyRecordId}` || source.storageKey !== undefined
      || selected.length !== 1 || !hasStoryboardDirectorAssetConfirmation(document.directorIntake.confirmedAssets, {
        planId: asset.id, sourceAssetId: source.assetId, historyRecordId: source.historyRecordId, role: asset.role,
      }))) unavailable();
    candidate = selected[0];
  } else {
    if (planned) unavailable();
    const histories = new Set(candidates.map(item => item.historyRecordId));
    if (histories.size !== 1) unavailable();
    candidate = candidates[0];
  }
  if (!candidate?.historyRecordId) unavailable();
  if (planned && (candidate.projectId !== input.projectId || candidate.storageKey !== undefined)) unavailable();
  // Planned execution must prove the currently confirmed draft against the
  // immutable generation request; editable candidate text alone is not proof.
  const drafts = planned && Array.isArray(document.visualAssetWorkspace.drafts)
    ? document.visualAssetWorkspace.drafts.filter((value): value is { planId: string; role: string; prompt: string } =>
      record(value) && value.planId === asset.id && value.role === asset.role && typeof value.prompt === "string") : [];
  if (planned && drafts.length !== 1) unavailable();
  const historyRecordId = candidate.historyRecordId;
  const image = await deps.loadOwnedImage(historyRecordId, input.userId);
  const delivery = image && record(image.response) ? image.response : {};
  if (!image || image.record_id !== historyRecordId || image.user_id !== input.userId
    || image.state !== "completed" || image.delivery_state !== "delivered"
    || delivery.deliveryMode !== "provider_url" || delivery.sourceExpiredAt
    || !isPublicVideoAssetUrl(delivery.providerUrl)) unavailable();
  const snapshot = parseImageFailureRequestSnapshot(image.request_snapshot);
  if (!snapshot || snapshot.surface !== "storyboard-workbench") unavailable();
  const matchesCompiledPrompt = planned
    ? storyboardDirectorCandidateMatchesDraft({ ...candidate, prompt: snapshot.prompt }, drafts[0], asset)
    : turnarounds.some(reference => snapshot.prompt === buildStoryboardThreeViewPrompt(asset.role as "character" | "pet", undefined, reference.prompt, false)
      || snapshot.prompt === `${buildStoryboardThreeViewPrompt(asset.role as "character" | "pet", undefined, reference.prompt, true)}\n身份锁定：${asset.identityLock.trim()}；除允许变化外保持一致。`);
  // Older UUID/library candidates (including generated IDs carrying a storage
  // key) may have had their prompt overwritten by the drawer. The key is only
  // a compatibility marker: immutable history and the compiler prove the image.
  const canonicalOriginal = candidate.assetId === `generated_${historyRecordId}` && candidate.storageKey === undefined;
  if (!matchesCompiledPrompt || (canonicalOriginal && candidate.prompt !== snapshot.prompt)) unavailable();
  let reference: { recordId: string; previewUrl: string };
  try { ({ reference } = await deps.resolveReadableImage(historyRecordId, input.userId, image)); }
  catch {
    throw new StoryboardDirectorOriginalAssetError("DIRECTOR_ORIGINAL_IMAGE_READ_UNAVAILABLE", "原生成图暂时无法安全读取，请保留当前图片后再试。", 503);
  }
  if (reference.recordId !== historyRecordId || reference.previewUrl !== delivery.providerUrl
    || !isPublicVideoAssetUrl(reference.previewUrl)) unavailable();
  return {
    assetId: `generated_${historyRecordId}`, planId: asset.id, role: asset.role,
    name: candidate.name, prompt: snapshot.prompt, historyRecordId, projectId: input.projectId,
    previewUrl: reference.previewUrl, saved: false, source: "personal",
    modelId: snapshot.publicModelId, modelName: snapshot.modelName, quotedPrice: snapshot.quotedPriceYuan,
    ...(candidate.createdAt ? { createdAt: candidate.createdAt } : {}),
    ...(candidate.tags ? { tags: [...candidate.tags] } : {}),
    ...(candidate.customCategory !== undefined ? { customCategory: candidate.customCategory } : {}),
    ...(candidate.derivedFromAssetId ? { derivedFromAssetId: candidate.derivedFromAssetId } : {}),
    ...(candidate.identityState ? { identityState: candidate.identityState } : {}),
  };
}
