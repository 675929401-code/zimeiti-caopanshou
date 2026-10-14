import { z } from "zod";
import { WorkbenchCardPersistenceFields, WorkbenchRunPersistenceFields, StoryboardImageRequestSnapshotPersistenceFields, WorkbenchVideoContractPersistenceFields } from "@/lib/storyboard-project-contract";
import { GeneratedImageReferenceSchema } from "@/lib/generated-image-reference";
import { StoryboardVisualAssetPlanSchema, StoryboardVisualAssetRefSchema } from "@/lib/storyboard-workbench";

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
  if (object.videoContract) run.videoContract = pickScalars(object.videoContract, WorkbenchVideoContractPersistenceFields);
  const visualAssetPlan = StoryboardVisualAssetPlanSchema.safeParse(object.visualAssetPlan);
  if (visualAssetPlan.success) run.visualAssetPlan = visualAssetPlan.data;
  run.cards = Array.isArray(object.cards) ? object.cards.map(value => {
    const card = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const output = pickScalars(card, WorkbenchCardPersistenceFields);
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
