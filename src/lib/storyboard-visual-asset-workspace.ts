import { z } from "zod";
import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from "./storyboard-workbench";

const role = z.enum(["character", "pet", "environment", "prop"]);
const identifier = z.string().min(1).max(200);
// Preserve drafts verbatim. Oversize input is an explicit save failure, never truncation.
export const StoryboardVisualAssetDraftSchema = z.object({
  planId: identifier,
  role,
  name: z.string().max(120),
  prompt: z.string().max(50000),
  tagsText: z.string().max(1000),
  customCategory: z.string().max(40),
});

/** Only stable identifiers and user-authored metadata; resolve media through owned APIs on restore. */
export const StoryboardVisualAssetCandidateSchema = z.object({
  assetId: identifier,
  planId: identifier,
  role,
  name: z.string().max(120),
  prompt: z.string().max(50000).optional(),
  historyRecordId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  storageKey: z.string().min(1).max(1024).refine(value => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value), "Only an object key may be persisted").optional(),
  modelId: z.string().max(200).optional(),
  modelName: z.string().max(200).optional(),
  quotedPrice: z.number().finite().nonnegative().optional(),
  createdAt: z.string().max(80).optional(),
  projectId: identifier.optional(),
  saved: z.boolean(),
  tags: z.array(z.string().min(1).max(32)).max(12).optional(),
  customCategory: z.string().max(40).optional(),
  source: z.enum(["personal", "platform-preset"]).optional(),
  presetId: identifier.optional(),
  presetRevision: z.number().int().positive().optional(),
  sceneId: z.string().trim().regex(/^[a-z][a-z0-9_-]{2,63}$/u).optional(),
  sceneZone: z.string().trim().min(2).max(80).optional(),
  cameraCoverage: z.enum(["wide", "front", "side", "reverse", "detail"]).optional(),
  fixedAnchors: z.array(z.string().trim().min(2).max(160)).max(16).optional(),
  allowedSegmentKinds: z.array(z.string().trim().min(2).max(80)).max(24).optional(),
  derivedFromAssetId: identifier.optional(),
  identityState: z.enum(["current", "young", "senior"]).optional(),
}).superRefine((candidate, context) => {
  if (candidate.source === "platform-preset" && (!candidate.presetId || !candidate.presetRevision)) {
    context.addIssue({ code: "custom", message: "Published preset identity is incomplete" });
  }
  if (candidate.assetId.startsWith("generated_") && candidate.assetId !== `generated_${candidate.historyRecordId || ""}`) {
    context.addIssue({ code: "custom", message: "Generated candidate requires its matching stable record ID" });
  }
});

export const StoryboardReferenceImageSettingsSchema = z.object({
  modelId: z.string().max(200),
  resolution: z.string().max(40),
  ratio: z.enum(["16:9", "9:16", "1:1"]),
});
export type StoryboardReferenceImageSettings = z.infer<typeof StoryboardReferenceImageSettingsSchema>;

export const StoryboardVisualAssetWorkspaceSchema = z.object({
  generationSettings: StoryboardReferenceImageSettingsSchema.optional(),
  drafts: z.array(StoryboardVisualAssetDraftSchema).max(32),
  candidates: z.array(StoryboardVisualAssetCandidateSchema).max(32),
});
export type StoryboardVisualAssetDraft = z.infer<typeof StoryboardVisualAssetDraftSchema>;
export type StoryboardVisualAssetCandidate = z.infer<typeof StoryboardVisualAssetCandidateSchema>;
export type StoryboardVisualAssetWorkspace = z.infer<typeof StoryboardVisualAssetWorkspaceSchema>;

/** Reference defaults are independent from board framing; saved user settings remain explicit. */
export function storyboardReferenceImageSettings(run: {
  imageModelId: string; imageResolution: string; ratio: StoryboardReferenceImageSettings["ratio"];
  imageRatio?: StoryboardReferenceImageSettings["ratio"]; visualAssetWorkspace?: StoryboardVisualAssetWorkspace;
}): StoryboardReferenceImageSettings {
  return run.visualAssetWorkspace?.generationSettings || {
    modelId: run.imageModelId, resolution: '2K', ratio: '16:9',
  };
}

/** Undefined means an older document. Invalid supplied work must fail instead of being silently discarded. */
export function normalizeStoryboardVisualAssetWorkspace(value: unknown): StoryboardVisualAssetWorkspace | undefined {
  return value === undefined ? undefined : StoryboardVisualAssetWorkspaceSchema.parse(value);
}


/**
 * A newly imported project starts with only its explicit first-round creation
 * drafts. Sources remain in the plan and are resolved by the owned-media path;
 * neither old candidates nor purported generated results are copied here.
 */
export function createImportedStoryboardVisualAssetWorkspace(plan?: StoryboardVisualAssetPlan): StoryboardVisualAssetWorkspace {
  if (plan?.mode !== "selected" || !plan.generationPolicy) return { drafts: [], candidates: [] };
  // Validate policy IDs/budget before mapping; preserve the original prompt bytes.
  StoryboardVisualAssetPlanSchema.parse(plan);
  const drafts = plan.generationPolicy.initialRequiredAssetIds.flatMap(planId => {
    const asset = plan.assets.find(item => item.id === planId)!;
    if (asset.source) return [];
    return [{
      planId: asset.id, role: asset.role, name: asset.name,
      prompt: asset.referencePrompts[0].prompt,
      tagsText: (asset.tags || []).join("，"), customCategory: asset.customCategory || "",
    }];
  });
  return StoryboardVisualAssetWorkspaceSchema.parse({ drafts, candidates: [] });
}

/** Account-library items may be browsed globally, but never auto-fill another project's draft. */
export function isStoryboardVisualAssetCandidateForProject(
  candidate: { projectId?: string }, projectId?: string,
): boolean {
  return (candidate.projectId || "") === (projectId || "");
}
