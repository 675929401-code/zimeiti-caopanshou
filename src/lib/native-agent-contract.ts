import { z } from "zod";
import { NativePlatformSchema } from "./native-operations-contract";
import { NativeAiDecimal6Schema } from "./native-ai-contract";

export const NativeAgentIdSchema = z.string().uuid();
export const NativeAgentRequestKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const revision = z.number().int().positive();
const localIds = z.array(NativeAgentIdSchema).max(30).refine(ids => new Set(ids).size === ids.length);
const modelId = z.string().min(4).max(160).regex(/^pm_[A-Za-z0-9_-]+$/u);
const prompt = z.string().trim().min(1).max(24000);

export const NativeAgentContextSchema = z.object({
  accountIds: localIds.default([]),
  collectionIds: localIds.default([]),
  draftIds: localIds.default([]),
  assetIds: localIds.default([]),
}).strict();

/** The browser selects local resources. It cannot provide credentials or a runtime. */
export const NativeAgentStartSchema = z.object({
  requestKey: NativeAgentRequestKeySchema,
  taskId: NativeAgentIdSchema.optional(),
  expectedRevision: revision.optional(),
  prompt,
  modelId,
  context: NativeAgentContextSchema.default({ accountIds: [], collectionIds: [], draftIds: [], assetIds: [] }),
}).strict().refine(value => (value.taskId !== undefined) === (value.expectedRevision !== undefined), {
  message: "Continuing a task requires its current revision",
});
export type NativeAgentStart = z.infer<typeof NativeAgentStartSchema>;
export const NativeAgentPlanStartSchema = NativeAgentStartSchema.safeExtend({ mode: z.literal("plan"), maxCredits: NativeAiDecimal6Schema });

export const NativeAgentRuntimeApprovalSchema = z.object({
  revision: revision,
  configHash: z.string().regex(/^[a-f0-9]{64}$/u),
  maxCreditsPerTurn: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u).refine(value => Number(value) > 0),
}).strict();
export type NativeAgentRuntimeApproval = z.infer<typeof NativeAgentRuntimeApprovalSchema>;
/** New member requests carry business input; the server resolves the runtime. */
const { modelId: _memberModelId, ...memberStartShape } = NativeAgentStartSchema.shape;
void _memberModelId;
export const NativeAgentMemberStartSchema = z.object({
  ...memberStartShape,
  taskId: NativeAgentIdSchema.optional(),
  expectedRevision: revision.optional(),
  runtimeApproval: NativeAgentRuntimeApprovalSchema,
}).strict().refine(value => (value.taskId !== undefined) === (value.expectedRevision !== undefined), {
  message: "Continuing a task requires its current revision",
});
export type NativeAgentMemberStart = z.infer<typeof NativeAgentMemberStartSchema>;

const listPage = z.object({ page: z.number().int().min(1).max(1000).default(1), pageSize: z.number().int().min(1).max(50).default(20) }).strict();
const modelOptions = {
  prompt,
  modelId,
  aspectRatio: z.string().min(1).max(24).regex(/^[0-9A-Za-z:_-]+$/u),
  resolution: z.string().min(1).max(32).regex(/^[0-9A-Za-z:_-]+$/u),
  referenceAssetIds: localIds.default([]),
};
export const NativeAgentToolSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list_accounts"), args: listPage }).strict(),
  z.object({ kind: z.literal("list_collections"), args: listPage }).strict(),
  z.object({ kind: z.literal("read_draft"), args: z.object({ draftId: NativeAgentIdSchema, version: revision.optional() }).strict() }).strict(),
  z.object({ kind: z.literal("list_media"), args: listPage }).strict(),
  z.object({ kind: z.literal("read_records"), args: listPage }).strict(),
  z.object({ kind: z.literal("read_analytics"), args: z.object({ recordId: NativeAgentIdSchema, source: z.enum(["browser", "official"]) }).strict() }).strict(),
  z.object({ kind: z.literal("save_draft"), args: z.object({
    draftId: NativeAgentIdSchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
    expectedMetadataRevision: z.number().int().nonnegative(),
    collectionId: NativeAgentIdSchema.nullable(),
    contentType: z.enum(["image", "video"]),
    title: z.string().max(200),
    body: z.string().max(50000),
    topics: z.array(z.string().trim().min(1).max(100)).max(30),
    assetIds: localIds,
    coverAssetId: NativeAgentIdSchema.optional(),
    platforms: z.array(NativePlatformSchema).max(14),
  }).strict() }).strict(),
  z.object({ kind: z.literal("propose_publish"), args: z.object({
    draftId: NativeAgentIdSchema,
    expectedRevision: revision,
    expectedMetadataRevision: z.number().int().nonnegative(),
    browserAccountIds: localIds,
    officialBindingIds: localIds,
    scheduledAt: z.string().datetime({ offset: true }).nullable(),
  }).strict().refine(value => value.browserAccountIds.length + value.officialBindingIds.length > 0) }).strict(),
  z.object({ kind: z.literal("generate_image"), args: z.object({ ...modelOptions, count: z.number().int().min(1).max(4).default(1) }).strict() }).strict(),
  z.object({ kind: z.literal("generate_video"), args: z.object({ ...modelOptions, duration: z.number().int().min(1).max(120) }).strict() }).strict(),
]);
export type NativeAgentTool = z.infer<typeof NativeAgentToolSchema>;
export const NATIVE_AGENT_READ_TOOLS = new Set<NativeAgentTool["kind"]>(["list_accounts", "list_collections", "read_draft", "list_media", "read_records", "read_analytics"]);

export const NativeAgentResourceRevisionSchema = z.object({
  kind: z.enum(["account", "collection", "draft", "asset", "binding"]),
  id: NativeAgentIdSchema,
  revision: z.number().int().nonnegative(),
}).strict();
export const NativeAgentQuoteSchema = z.object({
  source: z.enum(["main_image", "main_video", "publish_entitlement", "local_metadata"]),
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/u),
  unit: z.enum(["credits", "publish_count", "CNY", "metadata_write"]),
  amount: z.number().finite().nonnegative(),
  budget: z.number().finite().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().refine(value => value.amount <= value.budget, { message: "Action quote exceeds the confirmed budget" });
export const NativeAgentProposalSnapshotSchema = z.object({
  tool: NativeAgentToolSchema.refine(value => !NATIVE_AGENT_READ_TOOLS.has(value.kind)),
  resources: z.array(NativeAgentResourceRevisionSchema).max(100),
  quote: NativeAgentQuoteSchema,
}).strict();

/** The server freezes quotes and resource revisions; approve never receives replacement arguments. */
export const NativeAgentDecisionSchema = z.object({
  proposalId: NativeAgentIdSchema,
  expectedRevision: revision,
  decision: z.enum(["approve", "reject"]),
  requestKey: NativeAgentRequestKeySchema,
}).strict();
export const NativeAgentTaskEditSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rename"), taskId: NativeAgentIdSchema, expectedRevision: revision, title: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal("archive"), taskId: NativeAgentIdSchema, expectedRevision: revision, archived: z.boolean() }).strict(),
  z.object({ action: z.literal("favorite"), taskId: NativeAgentIdSchema, expectedRevision: revision, favorite: z.boolean() }).strict(),
  z.object({ action: z.literal("rate"), taskId: NativeAgentIdSchema, expectedRevision: revision, rating: z.number().int().min(1).max(5), comment: z.string().max(1000).default("") }).strict(),
  z.object({ action: z.literal("abort"), taskId: NativeAgentIdSchema, expectedRevision: revision }).strict(),
]);
export const NativeAgentListSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  keyword: z.string().max(100).default(""),
  favoriteOnly: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  archived: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
}).strict();
export const NativeAgentEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

/** Recursively sorted object keys, preserved array order, and no locale-dependent comparison. */
export function nativeAgentCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(nativeAgentCanonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${nativeAgentCanonical(row[key])}`).join(",")}}`;
  }
  throw new TypeError("NATIVE_AGENT_CANONICAL_INPUT_INVALID");
}

export function nativeAgentMainRequestKey(turnId: string, step: number): string {
  NativeAgentIdSchema.parse(turnId);
  z.number().int().min(0).max(32).parse(step);
  return `native-agent:${turnId}:llm:${step}`;
}
