import { COMMERCE_V2_QUOTE_SCHEMA, type ProductionPlan, type ProductionQuote } from "./contracts";

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function createProductionQuote(input: {
  quoteId: string;
  plan: ProductionPlan;
  planHash: string;
  now: number;
  ttlMs?: number;
}): ProductionQuote {
  if (input.plan.configurationIssues.length || input.plan.executionIssues.length) throw new Error("生产计划尚未通过配置与执行门禁");
  const unitPrice = Number(input.plan.model.publicPrice);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error("模型公开价格尚未配置");
  const duration = input.plan.kind === "video" && "durationSeconds" in input.plan.settings
    ? input.plan.settings.durationSeconds
    : 1;
  const quantity = input.plan.model.billingUnit === "output_second" ? duration : 1;
  return {
    schema: COMMERCE_V2_QUOTE_SCHEMA,
    quoteId: input.quoteId,
    planHash: input.planHash,
    modelId: input.plan.model.id,
    modelConfigHash: input.plan.model.configHash,
    billingUnit: input.plan.model.billingUnit,
    quantity,
    unitPrice,
    payableTotal: money(unitPrice * quantity),
    currency: "CNY",
    expiresAt: input.now + (input.ttlMs ?? 5 * 60_000),
    confirmable: true,
  };
}

export function assertProductionQuoteConfirmation(input: {
  quote: ProductionQuote;
  planHash: string;
  modelConfigHash: string;
  expectedPayableTotal: number;
  now: number;
}) {
  if (!input.quote.confirmable) throw new Error("报价不可确认");
  if (input.quote.expiresAt <= input.now) throw new Error("报价已过期，请重新报价");
  if (input.quote.planHash !== input.planHash) throw new Error("创作内容或设置已经变化，请重新报价");
  if (input.quote.modelConfigHash !== input.modelConfigHash) throw new Error("模型配置已经变化，请重新报价");
  if (money(input.quote.payableTotal) !== money(input.expectedPayableTotal)) throw new Error("确认金额与服务端报价不一致");
  return true;
}
