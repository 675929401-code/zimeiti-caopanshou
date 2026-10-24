import { z } from "zod";
import { WorkbenchCardPersistenceFields, WorkbenchRunPersistenceFields, StoryboardImageRequestSnapshotPersistenceFields, WorkbenchVideoContractPersistenceFields } from "@/lib/storyboard-project-contract";
import { GeneratedImageReferenceSchema } from "@/lib/generated-image-reference";
import { StoryboardEnvironmentGroupSchema, StoryboardQualityCheckSchema, StoryboardSegmentSchema, StoryboardVisualAssetPlanSchema, StoryboardVisualAssetRefSchema, StoryboardWardrobePlanSchema } from "@/lib/storyboard-workbench";
import { normalizeStoryboardVisualAssetWorkspace } from "@/lib/storyboard-visual-asset-workspace";
import { StoryboardDirectorExecutionSchema } from "@/lib/storyboard-director-execution";
import { StoryboardDirectorIntakeStateSchema } from "@/lib/storyboard-director-resume";

function scalar(value: unknown): unknown {
  if (typeof value === "string") return /^(?:data:[^,]+;base64,|blob:)/iu.test(value) ? undefined : value;
  return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
}
function pickScalars(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(fields.flatMap(key => { const item = scalar(object[key]); return item === undefined ? [] : [[key,item]]; }));
}
function urls(value: unknown) { return Array.isArray(value) ? value.filter(item => typeof item === "string" && !/^(?:data|blob):/iu.test(item)) : []; }
/** Explicit persistence projection, including nested snapshots; unknown extras never enter storage. */
export function sanitizeStoryboardPersistenceValue(value: unknown): unknown {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const run = pickScalars(object, WorkbenchRunPersistenceFields);
  if (object.directorIntake !== undefined) run.directorIntake = StoryboardDirectorIntakeStateSchema.parse(object.directorIntake);
  if (object.videoContract) run.videoContract = pickScalars(object.videoContract, WorkbenchVideoContractPersistenceFields);
  if (object.visualAssetPlan !== undefined) run.visualAssetPlan = StoryboardVisualAssetPlanSchema.parse(object.visualAssetPlan);
  if (object.wardrobePlan !== undefined) run.wardrobePlan = StoryboardWardrobePlanSchema.parse(object.wardrobePlan);
  const visualAssetWorkspace = normalizeStoryboardVisualAssetWorkspace(object.visualAssetWorkspace);
  if (visualAssetWorkspace) run.visualAssetWorkspace = visualAssetWorkspace;
  const environmentGroups = z.array(StoryboardEnvironmentGroupSchema).max(24).safeParse(object.environmentGroups);
  if (environmentGroups.success) run.environmentGroups = environmentGroups.data;
  run.cards = Array.isArray(object.cards) ? object.cards.map(value => {
    const card = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const output = pickScalars(card, WorkbenchCardPersistenceFields);
    if (card.directorExecution !== undefined) output.directorExecution = StoryboardDirectorExecutionSchema.parse(card.directorExecution);
    if (card.capabilityGaps !== undefined) output.capabilityGaps = StoryboardSegmentSchema.shape.capabilityGaps.parse(card.capabilityGaps);
    if (card.dynamicState !== undefined) output.dynamicState = StoryboardSegmentSchema.shape.dynamicState.parse(card.dynamicState);
    if (card.wardrobeChangeEvents !== undefined) output.wardrobeChangeEvents = StoryboardSegmentSchema.shape.wardrobeChangeEvents.parse(card.wardrobeChangeEvents);
    if (card.qualityChecks !== undefined) output.qualityChecks = z.array(StoryboardQualityCheckSchema).max(12).parse(card.qualityChecks);
    if (card.visualAssetSelectionMode !== undefined) output.visualAssetSelectionMode = z.enum(["project", "custom"]).parse(card.visualAssetSelectionMode);
    output.referenceImageUrls = urls(card.referenceImageUrls);
    const visualAssetRefs = z.array(StoryboardVisualAssetRefSchema).max(16).safeParse(card.visualAssetRefs);
    if (visualAssetRefs.success) output.visualAssetRefs = visualAssetRefs.data;
    const reference = GeneratedImageReferenceSchema.safeParse(card.imageRef);
    if (reference.success) output.imageRef = reference.data;
    if (card.imageRequestSnapshot) {
      const snapshot = card.imageRequestSnapshot as Record<string, unknown>;
      const persistedImageRequestSnapshot: Record<string, unknown> = {
        ...pickScalars(snapshot, StoryboardImageRequestSnapshotPersistenceFields),
        referenceImageUrls: urls(snapshot.referenceImageUrls),
      };
      const snapshotVisualAssetRefs = z.array(StoryboardVisualAssetRefSchema).max(16).safeParse(snapshot.visualAssetRefs);
      if (snapshotVisualAssetRefs.success) persistedImageRequestSnapshot.visualAssetRefs = snapshotVisualAssetRefs.data;
      output.imageRequestSnapshot = persistedImageRequestSnapshot;
    }
    if (card.videoLifecycle) output.videoLifecycle = pickScalars(card.videoLifecycle, ["taskId","taskState","taskLabel","instanceState","instanceLabel","headline","detail","tone","progress","idleGraceSeconds","idleRemainingSeconds","taskTerminal","monitorComplete","observedAt"]);
    return output;
  }) : [];
  return run;
}

type PersistableStoryboardCard = {
  referenceImageUrls: string[];
  imageUrl?: string;
  videoSourceImageUrl?: string;
  videoUrl?: string;
  videoContentUrl?: string;
  imageDeliveryMode?: string;
};

type PersistableStoryboardRun = {
  cards: PersistableStoryboardCard[];
};

function stableLocalMediaUrl(value: string | undefined) {
  const normalized = String(value || "").trim();
  if (!normalized || /^(?:blob|data):/iu.test(normalized)) return undefined;
  return normalized;
}

/**
 * localStorage is only a lightweight submitted-history index. Generated image
 * bytes and temporary preview URLs remain outside every persisted snapshot.
 */
export function createStoryboardPersistenceSnapshot<T extends PersistableStoryboardRun>(run: T): T {
  return sanitizeStoryboardPersistenceValue({
    ...run,
    cards: run.cards.map((card) => ({
      ...card,
      referenceImageUrls: card.referenceImageUrls
        .map((url) => stableLocalMediaUrl(url))
        .filter((url): url is string => Boolean(url)),
      imageUrl: card.imageDeliveryMode === "inline_ephemeral" ? undefined : stableLocalMediaUrl(card.imageUrl),
      ...(card.imageDeliveryMode === "inline_ephemeral" ? { imageValidatedAt: undefined, imageRecoveryReady: false, imageRetryBlocked: true,
        imageError: "图片已成功生成且保留费用收据；临时图片仅当前页面可用，刷新后无法恢复" } : {}),
      videoSourceImageUrl: stableLocalMediaUrl(card.videoSourceImageUrl),
      videoUrl: stableLocalMediaUrl(card.videoUrl),
      videoContentUrl: stableLocalMediaUrl(card.videoContentUrl),
    })),
  }) as T;
}
