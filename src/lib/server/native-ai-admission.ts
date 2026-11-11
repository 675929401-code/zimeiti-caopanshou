import { z } from "zod";
import {
  NativeAiAdmissionResultSchema, NativeAiConsumerInvocationResultSchema, NativeAiDecimal6Schema,
  nativeAiCanonical, nativeAiDecimalMicros, nativeAiHash,
  type NativeAiAdmissionResult, type NativeAiConsumer, type NativeAiSurface,
} from "@/lib/native-ai-contract";
import type { getSupabaseClient } from "@/storage/database/supabase-client";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";

type Consumer = Extract<NativeAiConsumer, "main_llm" | "main_image" | "main_video">;
type Db = Pick<ReturnType<typeof getSupabaseClient>, "rpc">;
type Permission = { authorityStatus: string; integrityValid: boolean; checksum: string; featureNavigationKeys: readonly string[] };
export type NativeAiInvocation = Readonly<{
  actionId: string; slot: number; dispatchId: string; wireRequestHash: string; consumer: Consumer;
  requestKey: string; modelPublicId: string; surface: NativeAiSurface; priceHash: string; maxAmount: string; unit: string;
}>;
export class NativeAiAdmissionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "NativeAiAdmissionError"; }
}
const reject = (code: string, message: string, status = 409): never => { throw new NativeAiAdmissionError(code, message, status); };
const expectedSurface = { main_llm: "native-agent-text", main_image: "publish-center-image", main_video: "publish-center-video" } as const;
const fields: Record<Consumer, ReadonlySet<string>> = {
  main_llm: new Set(["messages", "model", "modelId", "agentId", "stream", "client_request_id", "max_reply_tokens", "maxReplyTokens", "max_context_rounds", "maxContextRounds", "max_context_tokens", "maxContextTokens", "deep_thinking_type", "deepThinkingType", "deep_thinking_overridden", "deepThinkingOverridden", "enable_web_search", "enableWebSearch", "enable_web_search_overridden", "enableWebSearchOverridden", "model_overridden", "response_format", "responseFormat", "temperature", "persist_user_message"]),
  main_image: new Set(["prompt", "modelId", "mode", "aspectRatio", "resolution", "referenceImageUrls", "referenceUsage", "historySurface", "clientTraceId", "clientIdempotencyKey", "noRetry", "strictSingleSubmit", "deliveryRequirement"]),
  main_video: new Set(["model_id", "prompt", "duration", "aspect_ratio", "resolution", "resolution_tier", "negative_prompt", "image_url", "last_frame_url", "reference_image_url", "reference_image_urls", "reference_audio_urls", "audio_url", "source_video_url", "image_storage_key", "reference_asset_refs", "client_request_id", "surface", "tokenBilling", "generate_audio", "generateAudio", "fps", "seed"]),
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return reject("NATIVE_AI_WIRE_INVALID", "原生请求必须是冻结的 JSON 对象", 400);
  return value as Record<string, unknown>;
}
function checkWire(consumer: Consumer, wire: Record<string, unknown>, requestKey: string, modelPublicId: string) {
  if (Object.keys(wire).some(key => !fields[consumer].has(key))) reject("NATIVE_AI_WIRE_INVALID", "原生请求含未开放字段，未调用模型", 400);
  const model = consumer === "main_video" ? wire.model_id : consumer === "main_image" ? wire.modelId : wire.model || wire.modelId;
  if (model !== modelPublicId || wire.model && wire.modelId && wire.model !== wire.modelId) reject("NATIVE_AI_MODEL_MISMATCH", "原生请求与冻结模型不一致");
  const key = consumer === "main_image" ? wire.clientIdempotencyKey : wire.client_request_id;
  if (key !== requestKey) reject("NATIVE_AI_WIRE_INVALID", "原生请求标识不一致", 400);
  if (consumer === "main_image") {
    if (wire.historySurface !== expectedSurface.main_image || wire.noRetry !== true || wire.strictSingleSubmit !== true || wire.mode !== undefined && wire.mode !== "local" || wire.deliveryRequirement !== undefined && wire.deliveryRequirement !== "recoverable_reference") reject("NATIVE_AI_SURFACE_REQUIRED", "原生生图须使用发布中心场景和单次提交合同");
  } else if (consumer === "main_video") {
    if (wire.surface !== expectedSurface.main_video) reject("NATIVE_AI_SURFACE_REQUIRED", "原生视频须使用发布中心场景");
  } else {
    if (wire.agentId !== "__free_chat__" || wire.stream !== true || wire.enable_web_search === true || wire.enableWebSearch === true || wire.deep_thinking_type === 1 || wire.deepThinkingType === 1) reject("NATIVE_AI_TEXT_UNBOUNDED", "本次原生任务只支持有预算上限的单次文字流式调用");
    if (!Array.isArray(wire.messages) || wire.messages.some(message => { const row = object(message); return Object.keys(row).some(key => !["role", "content"].includes(key)) || !["system", "user", "assistant"].includes(String(row.role)) || typeof row.content !== "string"; })) reject("NATIVE_AI_TEXT_UNBOUNDED", "原生任务尚未开放工具或多模态调用");
  }
}
function databaseFailure(error: unknown): never {
  const text = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  for (const code of ["NATIVE_AI_BUDGET_EXCEEDED", "NATIVE_AI_PRICE_CHANGED", "NATIVE_AI_REVISION_CONFLICT", "NATIVE_AI_PERMISSION_CHANGED", "NATIVE_AI_QUOTE_EXPIRED"]) if (text.includes(code)) return reject(code, "原生动作的预算、价格或权限已变化，请核对原动作");
  return reject("NATIVE_AI_ADMISSION_UNAVAILABLE", "原生动作状态暂不可确认，请读取原动作；不会重新提交", 503);
}
/** An ordinary main-site key never enters native admission. Reserved native keys never fall back. */
export async function resolveNativeAiConsumer(args: { db: Db; userId: string; consumer: Consumer; requestKey: string; wireRequest: unknown }): Promise<NativeAiInvocation | null> {
  const reserved = args.requestKey.startsWith("native_");
  const parsedKey = /^native_([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})_([0-8])$/iu.exec(args.requestKey);
  if (reserved && !parsedKey) return reject("NATIVE_AI_KEY_INVALID", "原生动作请求标识无效", 400);
  if (!reserved && !args.requestKey.startsWith("native-agent:")) return null;
  const response = await args.db.rpc("read_native_ai_atomic" as never, { p_user_id: args.userId, p_input: { action: "consumer-invocation", consumer: args.consumer, mainRequestKey: args.requestKey } } as never);
  if (response.error) return databaseFailure(response.error);
  const parsed = NativeAiConsumerInvocationResultSchema.safeParse(response.data);
  if (!parsed.success) return reject("NATIVE_AI_ADMISSION_UNAVAILABLE", "原生动作读取合同尚未确认", 503);
  if (!parsed.data.found) return reserved ? reject("NATIVE_AI_ACTION_REQUIRED", "原生请求缺少当前会员的有效动作") : null;
  const { action, slot, snapshot } = parsed.data;
  const frozen = snapshot.slots.find(value => value.slot === slot.slot);
  if (!frozen || frozen.consumer !== args.consumer || frozen.requestKey !== args.requestKey || slot.consumer !== args.consumer || slot.requestKey !== args.requestKey || !slot.dispatchId || action.kind !== snapshot.kind || action.actionHash !== await nativeAiHash(snapshot)
    || nativeAiCanonical(action.args) !== nativeAiCanonical(snapshot.args) || nativeAiCanonical(action.quote) !== nativeAiCanonical(snapshot.quote)
    || parsedKey && (action.id.toLowerCase() !== parsedKey[1].toLowerCase() || slot.slot !== Number(parsedKey[2]))) return reject("NATIVE_AI_BINDING_MISMATCH", "原生动作与请求归属不一致");
  const modelPublicId = z.string().regex(/^pm_[A-Za-z0-9_-]+$/u).parse(snapshot.args.modelId);
  if (snapshot.surface !== expectedSurface[args.consumer] || await nativeAiHash(args.wireRequest) !== frozen.wireRequestHash || await nativeAiHash(frozen.wireRequest) !== frozen.wireRequestHash) return reject("NATIVE_AI_WIRE_MISMATCH", "原生请求已偏离冻结动作，未调用模型");
  checkWire(args.consumer, object(args.wireRequest), args.requestKey, modelPublicId);
  return Object.freeze({ actionId: action.id, slot: slot.slot, dispatchId: slot.dispatchId, wireRequestHash: frozen.wireRequestHash, consumer: args.consumer, requestKey: args.requestKey, modelPublicId, surface: snapshot.surface, priceHash: snapshot.quote.priceHash, maxAmount: snapshot.quote.maxAmount, unit: snapshot.quote.unit });
}
/** Main wallets settle at six or fewer decimal places. Never turn an invalid/tiny amount into free use. */
export function toNativeAiReservationAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0 || amount >= 1_000_000_000_000) return reject("NATIVE_AI_AMOUNT_INVALID", "实际预留金额无效");
  const canonical = amount.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "") || "0";
  if (Math.abs(Number(canonical) - amount) > Number.EPSILON * Math.max(1, amount) * 4) return reject("NATIVE_AI_AMOUNT_INVALID", "实际预留金额精度超出已确认预算");
  return NativeAiDecimal6Schema.parse(canonical);
}
export async function buildNativeAiPriceHash(args: { consumer: Consumer; modelPublicId: string; surface: NativeAiSurface; pricing: unknown }): Promise<string> {
  const pricing = { ...object(args.pricing) };
  const allowed = args.consumer === "main_llm" ? ["schemaVersion", "publicModelId", "internalModelId", "modelName", "inputCostPerMillion", "outputCostPerMillion", "cachedCostPerMillion", "profitMargin", "creditsPerYuan", "tokenRoundingEnabled", "tokenRoundingUnit", "tokenRoundingMin", "tokenRoundingMax"]
    : args.consumer === "main_image" ? ["mode", "resolution", "costPrice", "sellingPrice", "imageCount"] : ["priceYuan", "costPriceYuan", "billingUnit", "billingQuantity", "resolution", "explicitlyFree", "tokenQuote"];
  if (Object.keys(pricing).some(key => !allowed.includes(key))) return reject("NATIVE_AI_PRICE_INVALID", "原生价格快照含未开放字段");
  if (args.consumer === "main_video" && pricing.tokenQuote !== undefined) { const tokenQuote = { ...object(pricing.tokenQuote) }; delete tokenQuote.requestPayloadHash; pricing.tokenQuote = tokenQuote; }
  if (/(?:"(?:api_?key|secret|authorization|cookie|password|credential[^" ]*)"\s*:)/iu.test(JSON.stringify(pricing))) return reject("NATIVE_AI_PRICE_INVALID", "原生价格快照不能包含凭据");
  return nativeAiHash({ version: "native-ai-price.v1", consumer: args.consumer, modelPublicId: args.modelPublicId, surface: args.surface, pricing });
}
/** This records budget consumption only; the original main-site wallet remains the sole charging authority. */
export async function admitNativeAiConsumer(args: { db: Db; userId: string; invocation: NativeAiInvocation | null; modelPublicId: string; surface: NativeAiSurface; priceHash: string; reservationAmount: string; unit: "credits" | "CNY" }, options: { readPermission?: (userId: string) => Promise<Permission> } = {}): Promise<NativeAiAdmissionResult | null> {
  const invocation = args.invocation;
  if (!invocation) return null;
  const amount = NativeAiDecimal6Schema.safeParse(args.reservationAmount);
  if (!amount.success || invocation.modelPublicId !== args.modelPublicId || invocation.surface !== args.surface || invocation.priceHash !== args.priceHash || invocation.unit !== args.unit) return reject("NATIVE_AI_PRICE_CHANGED", "实际模型、场景或价格已变化，未预留费用");
  if (nativeAiDecimalMicros(amount.data) > nativeAiDecimalMicros(invocation.maxAmount)) return reject("NATIVE_AI_BUDGET_EXCEEDED", "实际预留金额超过原生动作确认上限");
  const permission = await (options.readPermission ?? readMemberPermissionSnapshot)(args.userId);
  if (permission.authorityStatus !== "ready" || !permission.integrityValid || permission.checksum === "legacy-schema-absent") return reject("NATIVE_AI_PERMISSION_UNAVAILABLE", "会员权限暂不可确认", 503);
  if (!permission.featureNavigationKeys.includes("publish_center")) return reject("NATIVE_AI_ACCESS_DENIED", "当前会员未开通发布中心", 403);
  const response = await args.db.rpc("mutate_native_ai_atomic" as never, { p_user_id: args.userId, p_input: { action: "admit-consumer", requestKey: `admit:${invocation.requestKey}`, actionId: invocation.actionId, slot: invocation.slot, dispatchId: invocation.dispatchId, wireRequestHash: invocation.wireRequestHash, consumer: invocation.consumer, modelPublicId: args.modelPublicId, surface: args.surface, priceHash: args.priceHash, reservationAmount: amount.data, unit: args.unit } } as never);
  if (response.error) return databaseFailure(response.error);
  const parsed = NativeAiAdmissionResultSchema.safeParse(response.data);
  if (!parsed.success) return reject("NATIVE_AI_ADMISSION_UNAVAILABLE", "原生预算收据尚未确认，未调用模型", 503);
  const result = parsed.data;
  if (result.action.id !== invocation.actionId || result.slot.slot !== invocation.slot || result.slot.requestKey !== invocation.requestKey || result.slot.dispatchId !== invocation.dispatchId || result.admission.reservationAmount !== amount.data || result.admission.unit !== args.unit) return reject("NATIVE_AI_BINDING_MISMATCH", "原生预算收据归属不一致");
  if (!result.admission.newlyAdmitted) return reject("NATIVE_AI_ALREADY_ADMITTED", "原生动作已领取预算，只能读取原结果，不会再次提交");
  return result;
}
export function nativeAiAdmissionFailure(error: unknown) {
  return error instanceof NativeAiAdmissionError ? { status: error.status, body: { error: error.message, code: error.code, error_code: error.code, retryable: false, retry_safe: false, task_submitted: false, upstreamCalled: false, billed: false } } : null;
}
