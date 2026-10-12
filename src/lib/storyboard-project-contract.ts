import { z } from "zod";
import { GeneratedImageReferenceSchema } from "@/lib/generated-image-reference";

export const StoryboardImageRequestSnapshotPersistenceFields = ["runId","cardId","cardOrder","prompt","modelId","aspectRatio","resolution","exactText","referenceImageUrls","strictSingleSubmit","attemptOrdinal"] as const;
export const WorkbenchCardPersistenceFields = ["id","order","sourceNumber","label","narration","imagePrompt","imageExactText","imageTextLayoutEnabled","videoPrompt","referenceImageUrls","imageStatus","imageUrl","imageRef","imageRecordId","imageDeliveryMode","imageAssetId","imageStorageKey","imageWidth","imageHeight","videoSourceImageUrl","imageError","imageSubmittedAt","imageValidatedAt","imageModelIdUsed","imageModelNameUsed","imageClientRequestId","imageClientTraceId","imageClientRequestFingerprint","imageRequestSnapshot","imageAttemptOrdinal","imageQuotedPrice","imagePriceCharged","imageBillingState","imageRecoveryReady","imageRetryBlocked","videoStatus","videoUrl","videoError","videoTaskId","videoClientRequestId","videoClientRequestFingerprint","videoTaskModelId","videoTaskModelName","videoTaskDuration","videoSupportsRemoteCancel","videoContentUrl","videoProgress","videoStartedAt","videoLastCheckedAt","videoStatusDetail","videoPollFailures","videoMonitoringPaused","videoLifecycle","videoLifecycleError","videoRetryable","videoBillingState","videoPriceCharged"] as const;
export const WorkbenchVideoContractPersistenceFields = ["modelId","resolution","duration","ratio"] as const;
export const WorkbenchRunPersistenceFields = ["id","createdAt","updatedAt","lastSubmittedAt","ratio","imageResolution","videoResolution","videoDuration","imageModelId","videoModelId","videoContract","cards","title"] as const;

export const StoryboardProjectId = z.string().regex(/^[A-Za-z0-9:_-]{8,160}$/u);
const status = z.enum(["idle", "queued", "running", "done", "failed", "cancelled"]);
export const StoryboardProjectDocument = z.object({
  id: StoryboardProjectId,
  title: z.string().trim().min(1).max(160),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  lastSubmittedAt: z.number().finite().nonnegative().max(8_640_000_000_000_000).optional(),
  ratio: z.enum(["16:9", "9:16", "1:1"]),
  imageResolution: z.string().max(80),
  videoResolution: z.string().max(80),
  videoDuration: z.number().finite().positive().max(3600),
  imageModelId: z.string().max(200),
  videoModelId: z.string().max(200),
  cards: z.array(z.object({
    id: z.string().min(1).max(160),
    order: z.number().int().positive(),
    imagePrompt: z.string().max(50000),
    videoPrompt: z.string().max(50000),
    referenceImageUrls: z.array(z.string().max(4096)).max(20),
    imageStatus: status,
    imageRef: GeneratedImageReferenceSchema.optional(),
    imageRecordId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    imageDeliveryMode: z.enum(["provider_url", "inline_ephemeral"]).optional(),
    videoStatus: status,
    imageSubmittedAt: z.number().finite().nonnegative().max(8_640_000_000_000_000).optional(),
    videoStartedAt: z.number().finite().nonnegative().max(8_640_000_000_000_000).optional(),
  }).passthrough()).min(1).max(100),
}).passthrough();

export interface StoryboardProjectSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  cardCount: number;
  cards?: StoryboardProjectCardSummary[];
}

export interface StoryboardProjectCardSummary {
  id: string;
  order: number;
  imageStatus: string;
  videoStatus: string;
  imageUrl: string;
  videoTaskId: string;
  videoUrl: string;
  videoThumbnailUrl: string;
}

function finiteSubmissionTime(value: unknown, now: number): number | null {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now + 300_000
    ? timestamp
    : null;
}

export function deriveStoryboardSubmittedAt(value: unknown, now = Date.now()): string | null {
  if (!value || typeof value !== "object") return null;
  const document = value as Record<string, unknown>;
  const times: number[] = [];
  const declared = finiteSubmissionTime(document.lastSubmittedAt, now);
  if (declared !== null) times.push(declared);
  if (Array.isArray(document.cards)) {
    for (const value of document.cards) {
      if (!value || typeof value !== "object") continue;
      const card = value as Record<string, unknown>;
      const imageSubmittedAt = finiteSubmissionTime(card.imageSubmittedAt, now);
      const videoStartedAt = finiteSubmissionTime(card.videoStartedAt, now);
      if (imageSubmittedAt !== null) times.push(imageSubmittedAt);
      if (videoStartedAt !== null) times.push(videoStartedAt);
    }
  }
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function projectTimestamp(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortStoryboardProjectsBySubmission(
  projects: readonly StoryboardProjectSummary[],
): StoryboardProjectSummary[] {
  return [...projects].sort((left, right) => {
    const leftTime = projectTimestamp(left.submittedAt) || projectTimestamp(left.updatedAt) || projectTimestamp(left.createdAt);
    const rightTime = projectTimestamp(right.submittedAt) || projectTimestamp(right.updatedAt) || projectTimestamp(right.createdAt);
    return rightTime - leftTime || right.id.localeCompare(left.id);
  });
}
