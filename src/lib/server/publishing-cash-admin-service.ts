import "server-only";
import { z } from "zod";
import type { getSupabase } from "@/lib/api-middleware";
import {
  PublishingCashPricingInputSchema, PublishingCashPricingPreviewSchema, PublishingCashPricingReceiptResultSchema,
  PublishingCashPricingReceiptSchema, PublishingCashPricingSaveSchema, PublishingCashPricingStateSchema,
  type PublishingCashPricingInput, type PublishingCashPricingSave,
} from "@/lib/publishing-cash-contract";
import { PublishingError } from "./publishing-service";

type Database = ReturnType<typeof getSupabase>;
const missingSchema = new Set(["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"]);
const pricingReadSchema = PublishingCashPricingStateSchema.omit({ access: true });
const actorSchema = z.string().min(1).max(200);
const knownErrors: Record<string, [number, string]> = {
  PUBLISH_CASH_PRICING_CONFLICT: [409, "价格版本已变化，请重新读取并预览。"],
  PUBLISH_REVISION_CONFLICT: [409, "价格版本已变化，请重新读取并预览。"],
  PUBLISH_CASH_PREVIEW_MISMATCH: [409, "价格预览已失效，请重新预览后确认。"],
  PUBLISH_CASH_PREVIEW_EXPIRED: [409, "价格预览已失效，请重新预览后确认。"],
  PUBLISH_IDEMPOTENCY_CONFLICT: [409, "原保存标识已关联其他内容，请核对原请求。"],
  PUBLISH_INPUT_INVALID: [400, "价格字段不符合要求。"],
  PUBLISH_CASH_INPUT_INVALID: [400, "价格字段或预览不符合要求，请重新读取并预览。"],
  PUBLISH_ADMIN_REQUIRED: [403, "当前身份不能管理发布价格。"],
  PUBLISH_ACCESS_DENIED: [403, "当前身份不能管理发布价格。"],
  PUBLISH_USER_DISABLED: [403, "当前账户已停用。"],
};
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function failure(error: unknown, mutation: boolean): never {
  const row = object(error);
  if (typeof row.code === "string" && missingSchema.has(row.code)) throw new PublishingError("PUBLISH_CASH_SCHEMA_NOT_READY", "发布现金价格结构尚未就绪，请完成数据库升级后重新读取。", 503);
  const message = typeof row.message === "string" ? row.message : "";
  const code = Object.keys(knownErrors).find(key => message === key || message.startsWith(`${key}:`) || message.startsWith(`${key} `));
  if (code) throw new PublishingError(code, knownErrors[code][1], knownErrors[code][0]);
  throw new PublishingError("PUBLISH_CASH_PRICING_UNAVAILABLE", mutation ? "价格保存结果暂不可确认，请核对原保存请求。" : "发布价格暂不可读取，请稍后重试。", 503, mutation);
}
async function call(database: Database, name: string, args: Record<string, unknown>, mutation = false) {
  let result;
  try { result = await database.rpc(name, args as never); } catch (error) { failure(error, mutation); }
  if (result.error) failure(result.error, mutation);
  return result.data as unknown;
}
function parse<T>(schema: z.ZodType<T>, value: unknown, mutation = false): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PublishingError("PUBLISH_CASH_PRICING_RESPONSE_INVALID", mutation ? "价格保存回执未能确认，请核对原保存请求。" : "价格响应未通过合同校验，请核对服务版本。", 503, mutation);
  return parsed.data;
}
function actor(value: string): string {
  const result = actorSchema.safeParse(value);
  if (!result.success) throw new PublishingError("PUBLISH_ACCESS_DENIED", "管理员身份无效。", 403);
  return result.data;
}
function input(value: PublishingCashPricingInput): PublishingCashPricingInput {
  const result = PublishingCashPricingInputSchema.safeParse(value);
  if (!result.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "价格必须为正整数分，同一平台通道不能重复设置。", 400);
  return result.data;
}
function samePrices(left: PublishingCashPricingInput, right: { defaultChargeCents: number; overrides: PublishingCashPricingInput["overrides"] }) {
  const normalized = (values: PublishingCashPricingInput["overrides"]) => [...values].sort((a, b) => `${a.platform}:${a.transport}`.localeCompare(`${b.platform}:${b.transport}`));
  return left.defaultChargeCents === right.defaultChargeCents && JSON.stringify(normalized(left.overrides)) === JSON.stringify(normalized(right.overrides));
}

/** Only SELECT RPCs; permission is established by the admin route. */
export async function readPublishingCashPricing(database: Database) {
  try {
    const result = parse(pricingReadSchema, await call(database, "read_publish_cash_pricing", {}));
    return PublishingCashPricingStateSchema.parse({ ...result, access: { canEdit: true } });
  } catch (error) {
    if (error instanceof PublishingError && error.code === "PUBLISH_CASH_SCHEMA_NOT_READY") return PublishingCashPricingStateSchema.parse({ schemaReady: false, current: null, access: { canEdit: true } });
    throw error;
  }
}
export async function previewPublishingCashPricing(database: Database, actorId: string, value: PublishingCashPricingInput) {
  const proposed = input(value);
  const result = parse(PublishingCashPricingPreviewSchema, await call(database, "preview_publish_cash_pricing", { p_actor: actor(actorId), p_input: proposed }));
  if (result.proposed.expectedRevision !== proposed.expectedRevision || (result.current?.revision ?? 0) !== proposed.expectedRevision || !samePrices(proposed, result.proposed)) throw new PublishingError("PUBLISH_CASH_PRICING_RESPONSE_INVALID", "价格预览与本次输入不一致，请重新读取。", 503);
  return result;
}
export async function savePublishingCashPricing(database: Database, actorId: string, value: PublishingCashPricingSave) {
  const parsed = PublishingCashPricingSaveSchema.safeParse(value);
  if (!parsed.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "价格保存请求不符合要求。", 400);
  const result = parse(PublishingCashPricingReceiptSchema, await call(database, "save_publish_cash_pricing_atomic", { p_actor: actor(actorId), p_request: parsed.data }, true), true);
  if (result.requestKey !== parsed.data.requestKey || result.version.revision !== parsed.data.input.expectedRevision + 1 || !samePrices(parsed.data.input, result.version)) throw new PublishingError("PUBLISH_CASH_PRICING_RESPONSE_INVALID", "价格保存回执与原请求不一致，请保留原请求核对。", 503, true);
  return result;
}
export async function readPublishingCashPricingReceipt(database: Database, actorId: string, requestKey: string) {
  const key = PublishingCashPricingSaveSchema.shape.requestKey.safeParse(requestKey);
  if (!key.success) throw new PublishingError("PUBLISH_INPUT_INVALID", "保存请求标识无效。", 400);
  try {
    const result = parse(PublishingCashPricingReceiptResultSchema, await call(database, "read_publish_cash_pricing_receipt", { p_actor: actor(actorId), p_request_key: key.data }));
    if (result.receipt && result.receipt.requestKey !== key.data) throw new PublishingError("PUBLISH_CASH_PRICING_RESPONSE_INVALID", "返回的保存回执与原请求不一致。", 503);
    return result;
  } catch (error) {
    if (error instanceof PublishingError && error.code === "PUBLISH_CASH_SCHEMA_NOT_READY") return PublishingCashPricingReceiptResultSchema.parse({ schemaReady: false, receipt: null });
    throw error;
  }
}
