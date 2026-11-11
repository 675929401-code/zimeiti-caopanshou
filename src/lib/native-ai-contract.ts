import { z } from "zod";
import { NativePlatformSchema } from "./native-operations-contract";
import { NativeMediaSourceSchema, NativeOwnedMediaRefSchema } from "./native-main-media-contract";

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/u);
const modelId = z.string().regex(/^pm_[A-Za-z0-9_-]{1,157}$/u);
const revision = z.number().int().positive();
const stamp = z.string().datetime({ offset: true });
const uniqueIds = z.array(id).max(100).refine(values => new Set(values).size === values.length);
export const NATIVE_AI_QUOTE_LIFETIME_MS = 60 * 60_000;
export const NativeAiDecimal6Schema = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{0,5}[1-9])?$/u);
export type NativeAiDecimal6 = z.infer<typeof NativeAiDecimal6Schema>;
export const NativeAiConsumerSchema = z.enum(["main_llm", "main_image", "main_video", "native_core", "publish_manifest"]);
export type NativeAiConsumer = z.infer<typeof NativeAiConsumerSchema>;
export const NativeAiSurfaceSchema = z.enum(["native-agent-text", "publish-center-image", "publish-center-video"]).nullable();
export type NativeAiSurface = z.infer<typeof NativeAiSurfaceSchema>;
export const NativeAiUnitSchema = z.enum(["credits", "CNY", "metadata_write", "publish_count"]);
export const NativeAiStateSchema = z.enum(["proposed", "approved", "rejected", "dispatch_claimed", "awaiting_result", "succeeded", "failed_known", "unknown"]);
export type NativeAiState = z.infer<typeof NativeAiStateSchema>;
export const NativeAiScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), taskId: id, turnId: id }).strict(),
  z.object({ kind: z.literal("batch"), batchId: id, itemId: id }).strict(),
]);
const prompt = z.string().trim().min(1).max(24000);
const mediaOptions = {
  modelId, prompt, aspectRatio: z.string().min(1).max(24), resolution: z.string().min(1).max(32),
  referenceAssets: z.array(NativeOwnedMediaRefSchema).max(9),
};
export const NativeAiToolSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generate_image"), args: z.object({ ...mediaOptions, count: z.number().int().min(1).max(9) }).strict() }).strict(),
  z.object({ kind: z.literal("generate_video"), args: z.object({ ...mediaOptions, duration: z.number().int().min(1).max(120) }).strict() }).strict(),
  z.object({ kind: z.literal("save_draft"), args: z.object({
    draftId: id.optional(), expectedRevision: z.number().int().nonnegative(), expectedMetadataRevision: z.number().int().nonnegative(),
    collectionId: id.nullable(), contentType: z.enum(["image", "video"]), title: z.string().max(200), body: z.string().max(50000),
    topics: z.array(z.string().trim().min(1).max(100)).max(30),
    media: z.array(z.object({ role: z.enum(["image", "video", "cover"]), source: NativeMediaSourceSchema }).strict()).max(30),
    platforms: z.array(NativePlatformSchema).max(14).refine(values => new Set(values).size === values.length),
  }).strict() }).strict(),
  z.object({ kind: z.literal("propose_publish"), args: z.object({
    draftId: id, expectedRevision: revision, expectedMetadataRevision: z.number().int().nonnegative(),
    browserAccountIds: uniqueIds, officialBindingIds: uniqueIds, scheduledAt: stamp.nullable(),
  }).strict().refine(value => value.browserAccountIds.length + value.officialBindingIds.length > 0) }).strict(),
]);
export type NativeAiTool = z.infer<typeof NativeAiToolSchema>;
const internalPlanner = z.object({ kind: z.literal("plan_text"), args: z.object({
  modelId, prompt, contextSnapshotHash: hash, maxReplyTokens: z.number().int().min(1).max(4096),
  maxContextRounds: z.number().int().min(0).max(8), maxContextTokens: z.number().int().min(1).max(32768),
}).strict() }).strict();
export const NativeAiInternalToolSchema = z.union([NativeAiToolSchema, internalPlanner]);
export type NativeAiInternalTool = z.infer<typeof NativeAiInternalToolSchema>;
export const NativeAiQuoteSchema = z.object({
  unit: NativeAiUnitSchema, quotedAmount: NativeAiDecimal6Schema, maxAmount: NativeAiDecimal6Schema, priceHash: hash, expiresAt: stamp,
}).strict().refine(value => nativeAiDecimalMicros(value.quotedAmount) <= nativeAiDecimalMicros(value.maxAmount), "Quote exceeds approved limit");
const resource = z.object({ kind: z.enum(["account", "collection", "draft", "asset", "binding"]), id, revision: z.number().int().nonnegative() }).strict();
const wireSlot = z.object({
  slot: z.number().int().min(0).max(8), consumer: NativeAiConsumerSchema, requestKey: key,
  wireRequest: z.record(z.string(), z.unknown()), wireRequestHash: hash,
}).strict();
export const NativeAiActionSnapshotSchema = z.object({
  version: z.literal("native-ai-action.v1"), kind: z.enum(["plan_text", "generate_image", "generate_video", "save_draft", "propose_publish"]),
  args: z.record(z.string(), z.unknown()), sourceActionId: id.nullable(), resources: z.array(resource).max(100),
  quote: NativeAiQuoteSchema, surface: NativeAiSurfaceSchema, permissionRevision: z.string().min(1).max(240),
  slots: z.array(wireSlot).min(1).max(9),
}).strict().superRefine((value, context) => {
  const tool = NativeAiInternalToolSchema.safeParse({ kind: value.kind, args: value.args });
  if (!tool.success) { context.addIssue({ code: "custom", path: ["args"], message: "Invalid typed action arguments" }); return; }
  const expected = value.kind === "generate_image" ? Number(value.args.count) : 1;
  const consumer = { plan_text: "main_llm", generate_image: "main_image", generate_video: "main_video", save_draft: "native_core", propose_publish: "publish_manifest" }[value.kind];
  const surface = { plan_text: "native-agent-text", generate_image: "publish-center-image", generate_video: "publish-center-video", save_draft: null, propose_publish: null }[value.kind];
  const unit = value.kind === "plan_text" ? "credits" : value.kind.startsWith("generate_") ? "CNY" : "metadata_write";
  if (value.slots.length !== expected || value.slots.some((entry, index) => entry.slot !== index || entry.consumer !== consumer) || new Set(value.slots.map(entry => entry.requestKey)).size !== value.slots.length) context.addIssue({ code: "custom", path: ["slots"], message: "Action slots must be consecutive and match the tool" });
  if (value.surface !== surface || value.quote.unit !== unit) context.addIssue({ code: "custom", message: "Tool, scene and billing unit differ" });
  try { nativeAiCanonical(value); } catch { context.addIssue({ code: "custom", message: "Action must contain canonical JSON values" }); }
});
export type NativeAiActionSnapshot = z.infer<typeof NativeAiActionSnapshotSchema>;
const resultRef = z.object({ kind: z.enum(["image_record", "image_asset", "video_task", "draft", "manifest", "llm_attempt"]), id: z.string().min(1).max(256) }).strict();
export const NativeAiSlotDtoSchema = z.object({
  slot: z.number().int().min(0).max(8), requestKey: key, consumer: NativeAiConsumerSchema, state: NativeAiStateSchema, dispatchId: id.nullable(),
  receipt: z.object({ source: z.string().min(1).max(80), id: z.string().min(1).max(256), status: z.string().min(1).max(80), resultRefs: z.array(resultRef).max(30), charged: z.object({ unit: NativeAiUnitSchema, amount: NativeAiDecimal6Schema }).strict().optional() }).strict().nullable(),
}).strict();
export type NativeAiSlotDto = z.infer<typeof NativeAiSlotDtoSchema>;
export const NativeAiActionDtoSchema = z.object({
  id, scope: NativeAiScopeSchema, revision, state: NativeAiStateSchema,
  kind: z.enum(["plan_text", "generate_image", "generate_video", "save_draft", "propose_publish"]), actionHash: hash,
  args: z.record(z.string(), z.unknown()), quote: NativeAiQuoteSchema, slots: z.array(NativeAiSlotDtoSchema).min(1).max(9),
  createdAt: stamp, updatedAt: stamp, lastError: z.string().max(160).optional(),
}).strict();
export type NativeAiActionDto = z.infer<typeof NativeAiActionDtoSchema>;
export const NativeAiConsumerInvocationResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }).strict(),
  z.object({ found: z.literal(true), action: NativeAiActionDtoSchema, slot: NativeAiSlotDtoSchema, snapshot: NativeAiActionSnapshotSchema }).strict(),
]);
export const NativeAiAdmissionResultSchema = z.object({
  action: NativeAiActionDtoSchema, slot: NativeAiSlotDtoSchema,
  admission: z.object({ newlyAdmitted: z.boolean(), reservationAmount: NativeAiDecimal6Schema, unit: z.enum(["credits", "CNY"]) }).strict(),
}).strict();
export type NativeAiAdmissionResult = z.infer<typeof NativeAiAdmissionResultSchema>;
export const NativeAiDecisionSchema = z.object({ proposalId: id, expectedRevision: revision, decision: z.enum(["approve", "reject"]), requestKey: key }).strict();
export const NativeAiPlanReplySchema = z.object({ reply: z.string().max(24000), actions: z.array(NativeAiToolSchema).max(8) }).strict();
export const NativeAiBatchPlanReplySchema = z.object({ title: z.string().max(200), body: z.string().max(50000), topics: z.array(z.string().trim().min(1).max(100)).max(30), mediaPrompt: prompt }).strict();
export const NativeAiBatchSnapshotSchema = z.object({
  version: z.literal("native-ai-batch.v1"), mode: z.enum(["image_text", "video"]), collectionId: id,
  prompt, captionPrompt: z.string().max(24000), quantity: z.number().int().min(1).max(10), imageCount: z.number().int().min(1).max(9).nullable(),
  plannerModelId: modelId, generationModelId: modelId,
  options: z.object({ aspectRatio: z.string().min(1).max(24), resolution: z.string().min(1).max(32), duration: z.number().int().min(1).max(120).nullable() }).strict(),
  platforms: z.array(NativePlatformSchema).max(14).refine(values => new Set(values).size === values.length),
  budget: z.object({ credits: NativeAiDecimal6Schema, CNY: NativeAiDecimal6Schema }).strict(), savePolicy: z.literal("confirm_resolved_drafts"),
}).strict().refine(value => value.mode === "image_text" ? value.imageCount !== null : value.imageCount === null && value.options.duration !== null);
export type NativeAiBatchSnapshot = z.infer<typeof NativeAiBatchSnapshotSchema>;
export const NativeAiBatchDtoSchema = z.object({ id, revision, state: NativeAiStateSchema, mode: z.enum(["image_text", "video"]), quantity: z.number().int().min(1).max(10), manifestHash: hash, snapshot: NativeAiBatchSnapshotSchema, createdAt: stamp, updatedAt: stamp }).strict();
export const NativeAiItemDtoSchema = z.object({ id, batchId: id, ordinal: z.number().int().min(0).max(9), revision, state: NativeAiStateSchema, rootActionId: id, actionIds: z.array(id).min(1).max(100), createdAt: stamp, updatedAt: stamp }).strict();
export const NativeAiBatchResultSchema = z.object({ batch: NativeAiBatchDtoSchema, items: z.array(NativeAiItemDtoSchema).min(1).max(10), actions: z.array(NativeAiActionDtoSchema).min(1).max(1000) }).strict();
export type NativeAiBatchResult = z.infer<typeof NativeAiBatchResultSchema>;

/** Locale-independent JSON representation shared by browser, server and SQL fixtures. */
export function nativeAiCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("NATIVE_AI_CANONICAL_INPUT_INVALID");
    return `[${value.map(nativeAiCanonical).join(",")}]`;
  }
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, entry]) => `${JSON.stringify(name)}:${nativeAiCanonical(entry)}`).join(",")}}`;
  }
  throw new TypeError("NATIVE_AI_CANONICAL_INPUT_INVALID");
}
export async function nativeAiHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nativeAiCanonical(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function nativeAiDecimalMicros(value: string): bigint {
  NativeAiDecimal6Schema.parse(value);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}
export function nativeAiBudgetShare(total: string, quantity: number, ordinal: number, wholeCents = false): string {
  z.number().int().min(1).max(10).parse(quantity); z.number().int().min(0).max(quantity - 1).parse(ordinal);
  const step = BigInt(wholeCents ? 10000 : 1), units = nativeAiDecimalMicros(total) / step, count = BigInt(quantity);
  const micros = (units / count + (ordinal === quantity - 1 ? units % count : BigInt(0))) * step;
  const whole = micros / BigInt(1_000_000), fraction = (micros % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}
export function nativeAiRequestKey(actionId: string, slot: number): string {
  id.parse(actionId); z.number().int().min(0).max(8).parse(slot);
  return `native_${actionId}_${slot}`;
}
