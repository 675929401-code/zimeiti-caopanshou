import { z } from "zod";
import { GeneratedImageReferenceSchema } from "@/lib/generated-image-reference";

export const StoryboardExecutionModeSchema = z.enum(["ordinary", "reference", "chained"]);
export type StoryboardExecutionMode = z.infer<typeof StoryboardExecutionModeSchema>;
const fingerprint = z.string().regex(/^[a-f0-9]{32,64}$/u);
export const StoryboardChainAnchorConfirmationSchema = z.object({
  schema: z.literal("storyboard_chain_anchor_confirmation.v1"), recordId: z.string().regex(/^[a-f0-9]{64}$/u),
  confirmedAt: z.number().finite().positive(), inputFingerprint: fingerprint, chainRevision: z.number().int().positive(),
}).strict();
export type StoryboardChainAnchorConfirmation = z.infer<typeof StoryboardChainAnchorConfirmationSchema>;
export const StoryboardChainRequestSchema = z.object({
  schema: z.literal("storyboard_chain_request.v1"), projectId: z.string().min(8).max(160), cardId: z.string().min(1).max(160),
  chainRevision: z.number().int().positive(),
  anchor: z.object({ cardId: z.string().min(1).max(160), imageRef: GeneratedImageReferenceSchema, confirmationFingerprint: fingerprint }).strict().optional(),
  previous: z.object({ cardId: z.string().min(1).max(160), imageRef: GeneratedImageReferenceSchema, dependencyFingerprint: fingerprint }).strict().optional(),
}).strict();
export type StoryboardChainRequest = z.infer<typeof StoryboardChainRequestSchema>;
export function resolveStoryboardExecutionMode(run: { executionMode?: unknown; visualAssetPlan?: { mode?: unknown } }): StoryboardExecutionMode {
  return StoryboardExecutionModeSchema.safeParse(run.executionMode).success ? run.executionMode as StoryboardExecutionMode
    : run.visualAssetPlan?.mode === "selected" ? "reference" : "ordinary";
}
/** Stable synchronous browser/server dependency identity. This is not an authorization token. */
export function storyboardChainFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : item;
  const text = JSON.stringify(canonical(value));
  let a = 2166136261, b = 2246822507, c = 3266489909, d = 668265263;
  for (let i = 0; i < text.length; i++) { const n = text.charCodeAt(i); a = Math.imul(a ^ n, 16777619); b = Math.imul(b ^ n, 2246822519); c = Math.imul(c ^ n, 3266489917); d = Math.imul(d ^ n, 668265263); }
  return [a,b,c,d].map(n => (n >>> 0).toString(16).padStart(8, "0")).join("");
}
export type StoryboardChainCard = { id: string; order: number; imagePrompt: string; referenceImageUrls?: string[]; visualAssetRefs?: Array<{boundReferenceUrl?:string;ownedReferenceUrl?:string}>; imageRef?: z.infer<typeof GeneratedImageReferenceSchema>; imageRecordId?: string; imageAssetId?: string; imageStorageKey?: string; imageStatus?: string; imageMediaState?: unknown; imageReferenceState?: unknown; chainAnchorConfirmation?: StoryboardChainAnchorConfirmation };
export type StoryboardChainRun = { id: string; executionMode?: StoryboardExecutionMode; chainRevision?: number; imageModelId?: string; imageRatio?: string; ratio?: string; imageResolution?: string; visualAssetPlan?: { mode?: string }; cards: StoryboardChainCard[] };
export function storyboardChainInputFingerprint(run: StoryboardChainRun, card: StoryboardChainCard): string {
  return storyboardChainFingerprint({ projectId: run.id, mode: resolveStoryboardExecutionMode(run), chainRevision: run.chainRevision || 1,
    cards: [...run.cards].sort((a,b) => a.order-b.order).map(c => ({ id:c.id, order:c.order })), cardId:card.id, prompt:card.imagePrompt,
    modelId:run.imageModelId, ratio:run.imageRatio || run.ratio, resolution:run.imageResolution });
}
export function storyboardChainConfirmationFingerprint(confirmation: StoryboardChainAnchorConfirmation): string { return storyboardChainFingerprint(confirmation); }
export function storyboardChainDependencyFingerprint(run: StoryboardChainRun, card: StoryboardChainCard): string {
  return storyboardChainFingerprint({ inputFingerprint: storyboardChainInputFingerprint(run,card), imageRef:card.imageRef || (card.imageRecordId ? {schema:"generated_image_ref.v1",recordId:card.imageRecordId}:undefined), recordId:card.imageRecordId || card.imageRef?.recordId,
    predecessors: [...run.cards].sort((a,b) => a.order-b.order).filter(c => c.order < card.order).map(c => ({ id:c.id, order:c.order, prompt:c.imagePrompt, imageRef:c.imageRef || (c.imageRecordId ? {schema:"generated_image_ref.v1",recordId:c.imageRecordId}:undefined), recordId:c.imageRecordId || c.imageRef?.recordId })),
    anchorConfirmation: [...run.cards].sort((a,b) => a.order-b.order)[0]?.chainAnchorConfirmation });
}

/** Declared role bindings are retained history when chained mode disables the role plan. */
export function storyboardChainManualReferences(card: { referenceImageUrls?: string[]; visualAssetRefs?: Array<{ boundReferenceUrl?: string; ownedReferenceUrl?: string }> }): string[] {
  return (card.referenceImageUrls || []).filter(url => !card.visualAssetRefs?.some(ref => ref.boundReferenceUrl === url || ref.ownedReferenceUrl === url));
}

/** Reference roles are transport instructions; the authored card prompt remains unchanged. */
export function buildStoryboardChainReferenceInstruction(context:StoryboardChainRequest):string {
  if(!context.anchor) return "";
  return ["串联参考图用途：第1张仅锁定首段中人物、宠物的身份、外形和服饰连续性。",
    ...(context.previous && context.previous.imageRef.recordId!==context.anchor.imageRef.recordId ? ["第2张仅用于紧邻前段动作状态、人物位置和空间关系的接续。"] : []),
    "必须依据当前分段提示词重新绘制本段剧情、镜头、构图及中英文注释；不得照搬任何参考图的旧段文字、注释、分格内容或整图构图。"].join("\n");
}
