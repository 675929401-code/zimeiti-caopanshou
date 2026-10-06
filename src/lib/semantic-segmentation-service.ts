import {
  applyAtomicWalletOperation,
  calculateCredits,
  type AtomicWalletOperationResult,
} from "@/lib/billing";
import { getSelectedModelBillingSnapshot } from "@/lib/llm-billing";
import { toPublicModelId } from "@/lib/public-model-dto";
import { recordRevenue } from "@/lib/revenue";
import { safeFetchJsonPost, SafeFetchError } from "@/lib/safe-fetch";
import { buildOpenAIEndpoint } from "@/lib/api-endpoints";
import { resolveProviderSecret } from "@/lib/provider-secret";
import {
  DURATION_MODES,
  applySemanticOverlapBridges,
  buildSegmentUnits,
  countChars,
  normalizeForIntegrity,
  reconstructSegmentedText,
  segmentTextRule,
  type SegmentResult,
  type SegmentUnit,
} from "@/lib/segmenter-core";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETION_TOKENS = 1800;
const TASK_MODEL_MAP = {
  primary: process.env.SEGMENTER_LLM_MODEL || "deepseek-v4-flash",
  fallback: process.env.SEGMENTER_LLM_FALLBACK_MODEL || "glm-4.7-flash",
};

type JsonObject = Record<string, unknown>;
type LLMChoice = { groups?: number[][]; reason?: string };
type ProviderUsage = { promptTokens: number; completionTokens: number; cachedTokens: number };

type SelectedSemanticModel = {
  internalId: string;
  publicId: string;
  model: string;
  apiBase: string;
  apiKey: string;
  billingSnapshot: NonNullable<Awaited<ReturnType<typeof getSelectedModelBillingSnapshot>>>;
};

export type SemanticServiceResult = {
  status: number;
  body: JsonObject;
};

function buildChatUrl(apiBase: string): string {
  return buildOpenAIEndpoint(apiBase, "chat/completions");
}

function getSemanticBounds(duration: number) {
  const mode = DURATION_MODES[duration];
  const tolerance = Math.max(3, Math.ceil(duration * 0.5));
  return { min: Math.max(1, mode.min - tolerance), max: mode.max + tolerance };
}

function extractJson(text: string): LLMChoice | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  const raw = fenced?.[1] || trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as LLMChoice;
  } catch {
    return null;
  }
}

function buildPrompt(units: SegmentUnit[], duration: number): string {
  const mode = DURATION_MODES[duration];
  const bounds = getSemanticBounds(duration);
  return [
    "你是短视频口播文案的语义分段裁判。",
    "你只能判断哪些连续小句应该合并成一段，不能改写、删除或增加原文。",
    `当前模式：${mode.label}，推荐每段 ${mode.min}-${mode.max} 字，语义软边界 ${bounds.min}-${bounds.max} 字。`,
    "优先级：不破坏完整语义、因果与句法；其次满足字数；最后保证口播节奏自然。",
    "只返回 JSON：{\"groups\":[[0,1],[2]],\"reason\":\"简短说明\"}。",
    "groups 必须覆盖全部 index、顺序递增、不可跳号、重复或倒序。",
    JSON.stringify(units.map((unit) => ({
      index: unit.index,
      paragraph: unit.paragraphIndex,
      chars: unit.charCount,
      text: unit.text,
    }))),
  ].join("\n");
}

function validateGroups(
  choice: LLMChoice,
  units: SegmentUnit[],
  duration: number,
  model: string,
): SegmentResult | null {
  const mode = DURATION_MODES[duration];
  const bounds = getSemanticBounds(duration);
  if (!Array.isArray(choice.groups) || choice.groups.length === 0) return null;
  const flattened = choice.groups.flat();
  if (flattened.length !== units.length || flattened.some((index, position) => index !== position)) return null;

  const segments: string[] = [];
  const paragraphBreakBefore: boolean[] = [];
  let cursor = 0;
  for (const group of choice.groups) {
    if (!Array.isArray(group) || group.length === 0 || group.some((index, position) => index !== cursor + position)) {
      return null;
    }
    const part = group.map((index) => units[index]);
    const text = part.map((unit) => unit.text).join("").trim();
    const chars = countChars(text);
    const isLast = cursor + group.length === units.length;
    const oversizedUnit = group.length === 1 && part[0].charCount > mode.max;
    const shortTail = isLast && chars < mode.min;
    if (!oversizedUnit && !shortTail && (chars < bounds.min || chars > bounds.max)) return null;
    segments.push(text);
    paragraphBreakBefore.push(part[0].paragraphBreakBefore);
    cursor += group.length;
  }
  if (segments.join("") !== units.map((unit) => unit.text).join("")) return null;
  const bridged = applySemanticOverlapBridges(segments, mode, paragraphBreakBefore);
  const counts = bridged.segments.map(countChars);
  return {
    segments: bridged.segments,
    counts,
    compliant: counts.map((count, index) => index === counts.length - 1 && count < mode.min
      ? true
      : count >= bounds.min && count <= bounds.max),
    paragraphBreakBefore,
    overlapPrefixes: bridged.overlapPrefixes,
    method: "semantic",
    model,
    note: choice.reason || "模型已优先保护语义，并在字数软边界内选择断点",
  };
}

async function resolveSemanticModel(): Promise<SelectedSemanticModel | null> {
  const db = getSupabaseAdminClient();
  const { data: settingRows } = await db
    .from("platform_settings")
    .select("setting_key, setting_value")
    .in("setting_key", ["segmenter_llm_model", "segmenter_llm_fallback_model"]);
  const settings = new Map(
    ((settingRows || []) as Array<{ setting_key: string; setting_value?: string | null }>)
      .map((row) => [row.setting_key, String(row.setting_value || "").trim()]),
  );
  const candidates = Array.from(new Set([
    settings.get("segmenter_llm_model") || TASK_MODEL_MAP.primary,
    settings.get("segmenter_llm_fallback_model") || TASK_MODEL_MAP.fallback,
  ].filter(Boolean)));
  if (candidates.length === 0) return null;

  const { data, error } = await db
    .from("llm_models")
    .select("*")
    .in("model_name", candidates)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`semantic_model_store:${error.message}`);
  const rows = (data || []) as JsonObject[];
  for (const candidate of candidates) {
    const row = rows.find((item) => String(item.model_name || "").trim() === candidate);
    if (!row) continue;
    const internalId = String(row.id || "").trim();
    const model = String(row.model_name || "").trim();
    const apiBase = String(row.api_endpoint || row.proxy_url || "").trim();
    const apiKey = String(row.api_key || "").trim();
    if (!internalId || !model || !apiBase || !apiKey) continue;
    let resolvedApiKey: string;
    try { resolvedApiKey = resolveProviderSecret(apiKey); } catch { continue; }
    const publicId = toPublicModelId("llm", internalId);
    const billingSnapshot = await getSelectedModelBillingSnapshot(publicId, row);
    if (!billingSnapshot) continue;
    return { internalId, publicId, model, apiBase, apiKey: resolvedApiKey, billingSnapshot };
  }
  return null;
}

export async function getSemanticSegmentationRuntimeCatalog() {
  const selected = await resolveSemanticModel();
  if (!selected) return null;
  const input = calculateCredits(selected.billingSnapshot.config, 1_000_000, 0, 0);
  const output = calculateCredits(selected.billingSnapshot.config, 0, 1_000_000, 0);
  return {
    provider: "OpenAI 兼容通道",
    model: selected.publicId,
    modelName: selected.model,
    inputCreditsPerMillion: stableCredits(input.creditsCharged),
    outputCreditsPerMillion: stableCredits(output.creditsCharged),
  };
}

async function applyWalletWithRetry(input: Parameters<typeof applyAtomicWalletOperation>[0]) {
  let lastResult: AtomicWalletOperationResult | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = await applyAtomicWalletOperation(input);
    if (lastResult.success) return lastResult;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 75));
  }
  return lastResult || { success: false, alreadyFulfilled: false, balanceAfter: 0, error: "钱包操作失败" };
}

function stableCredits(value: number) {
  return Math.ceil(Math.max(0, value) * 100) / 100;
}

async function refundCredits(input: {
  userId: string;
  clientRequestId: string;
  amount: number;
  scope: string;
  model: SelectedSemanticModel;
}) {
  return applyWalletWithRetry({
    userId: input.userId,
    operationKind: "credit_refund",
    idempotencyKey: `semantic:${input.clientRequestId}:refund:${input.scope}`,
    amount: stableCredits(input.amount),
    description: "智能语义分段退款",
    metadata: {
      source: "segmenter.semantic",
      phase: input.scope,
      public_model_id: input.model.publicId,
      internal_model_id: input.model.internalId,
      price_snapshot: input.model.billingSnapshot.priceSnapshot,
    },
  });
}

function billingUnknownResult(
  message: string,
  chargeInfo: JsonObject,
  upstreamCompleted: boolean | null = true,
): SemanticServiceResult {
  return {
    status: 503,
    body: {
      error: message,
      error_code: "SEMANTIC_BILLING_RECONCILIATION_REQUIRED",
      provider_call_started: true,
      upstream_completed: upstreamCompleted,
      billing_unknown: true,
      charged: null,
      chargeInfo,
    },
  };
}

async function callSemanticProvider(model: SelectedSemanticModel, prompt: string) {
  const chatUrl = buildChatUrl(model.apiBase);
  // DeepSeek V4 enables high-effort thinking by default. This bounded task
  // needs the final JSON, not a reasoning pass that can consume its token cap.
  // https://api-docs.deepseek.com/guides/thinking_mode/
  const directDeepSeekV4 = new URL(chatUrl).hostname === "api.deepseek.com" && /^deepseek-v4-/u.test(model.model);
  const response = await safeFetchJsonPost<JsonObject>(chatUrl, JSON.stringify({
      model: model.model,
      messages: [
        { role: "system", content: "只做受约束的结构化判断，必须返回合法 JSON，不得改写用户原文。" },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: MAX_COMPLETION_TOKENS,
      response_format: { type: "json_object" },
      stream: false,
      ...(directDeepSeekV4 ? { thinking: { type: "disabled" } } : {}),
    }), {
    authorization: { origin: new URL(chatUrl).origin, value: `Bearer ${model.apiKey}` },
    timeoutMs: 20_000,
    maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
  });
  const data = response.json;
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as JsonObject | undefined;
  const message = first && typeof first.message === "object" && first.message
    ? first.message as JsonObject
    : null;
  const content = typeof message?.content === "string" ? message.content : "";
  const choice = extractJson(content);
  const usageRaw = data.usage && typeof data.usage === "object" ? data.usage as JsonObject : null;
  const promptTokens = Number(usageRaw?.prompt_tokens);
  const completionTokens = Number(usageRaw?.completion_tokens);
  const cachedTokens = Number(
    usageRaw && typeof usageRaw.prompt_tokens_details === "object" && usageRaw.prompt_tokens_details
      ? (usageRaw.prompt_tokens_details as JsonObject).cached_tokens
      : 0,
  );
  const usage = Number.isFinite(promptTokens) && promptTokens >= 0
    && Number.isFinite(completionTokens) && completionTokens >= 0
    && Number.isFinite(cachedTokens) && cachedTokens >= 0
    ? { promptTokens, completionTokens, cachedTokens } satisfies ProviderUsage
    : null;
  return {
    choice,
    usage,
    providerRequestId: typeof data.id === "string" ? data.id.slice(0, 240) : "",
    diagnostics: {
      finish_reason: typeof first?.finish_reason === "string" ? first.finish_reason.slice(0, 40) : null,
      has_final_content: content.trim().length > 0,
      has_group_json: choice !== null,
      has_usage: usage !== null,
    },
  };
}

export async function runBillableSemanticSegmentation(input: {
  text: string;
  duration: number;
  userId: string;
  userRole: "admin" | "student";
  clientRequestId: string;
}): Promise<SemanticServiceResult> {
  const ruleResult = segmentTextRule(input.text, input.duration);
  const units = buildSegmentUnits(input.text);
  // Multiple punctuation units can still fit in one duration segment. In that
  // case the rule result is already complete, so calling a paid model cannot
  // improve the segmentation and only creates avoidable billing/fallback risk.
  if (ruleResult.segments.length <= 1) {
    return {
      status: 200,
      body: {
        success: true,
        result: { ...ruleResult, method: "rule", note: "文本无需调用语义模型" },
        semantic_status: "not_required",
        provider_call_started: false,
        upstream_completed: false,
        charged: false,
      },
    };
  }

  let model: SelectedSemanticModel | null;
  try {
    model = await resolveSemanticModel();
  } catch {
    model = null;
  }
  if (!model) {
    return {
      status: 503,
      body: {
        error: "智能分段模型未形成启用渠道与价格快照，本次未调用上游",
        error_code: "SEMANTIC_MODEL_NOT_READY",
        provider_call_started: false,
        upstream_completed: false,
        charged: false,
      },
    };
  }

  const prompt = buildPrompt(units, input.duration);
  const reserveQuote = calculateCredits(
    model.billingSnapshot.config,
    Math.max(200, prompt.length + 100),
    MAX_COMPLETION_TOKENS,
    0,
  );
  const reserveCredits = stableCredits(reserveQuote.creditsCharged);
  let reservation: AtomicWalletOperationResult | null = null;
  if (reserveCredits <= 0) {
    return {
      status: 503,
      body: {
        error: "智能分段模型尚未配置可结算价格，本次未调用上游",
        error_code: "SEMANTIC_PRICE_NOT_READY",
        provider_call_started: false,
        upstream_completed: false,
        charged: false,
      },
    };
  }
  reservation = await applyWalletWithRetry({
    userId: input.userId,
    operationKind: "credit_charge",
    idempotencyKey: `semantic:${input.clientRequestId}:reserve`,
    amount: reserveCredits,
    description: "智能语义分段额度预留",
    metadata: {
      source: "segmenter.semantic",
      phase: "reserve",
      public_model_id: model.publicId,
      internal_model_id: model.internalId,
      price_snapshot: model.billingSnapshot.priceSnapshot,
      maximum_completion_tokens: MAX_COMPLETION_TOKENS,
    },
  });
  if (!reservation.success) {
    const unavailable = /迁移|服务|不可用|原子钱包/u.test(reservation.error || "");
    return {
      status: unavailable ? 503 : 402,
      body: {
        error: reservation.error || "智能分段额度预留失败",
        error_code: unavailable ? "SEMANTIC_WALLET_NOT_READY" : "INSUFFICIENT_CREDITS",
        provider_call_started: false,
        upstream_completed: false,
        billing_unknown: unavailable,
        charged: unavailable ? null : false,
        chargeInfo: { reservation_operation_id: `semantic:${input.clientRequestId}:reserve` },
      },
    };
  }

  let provider: Awaited<ReturnType<typeof callSemanticProvider>>;
  try {
    provider = await callSemanticProvider(model, prompt);
  } catch (error) {
    const providerCallStarted = !(error instanceof SafeFetchError && error.requestDispatched === false);
    const providerFailure = {
      provider_error_code: error instanceof SafeFetchError ? error.code : "PROVIDER_RESPONSE_INVALID",
      ...(error instanceof SafeFetchError && error.upstreamStatus ? { provider_http_status: error.upstreamStatus } : {}),
    };
    if (reservation) {
      const refund = await refundCredits({
        userId: input.userId,
        clientRequestId: input.clientRequestId,
        amount: reserveCredits,
        scope: "provider_failed",
        model,
      });
      if (!refund.success) {
        return billingUnknownResult("语义模型失败且预留退款未确认，请按 attempt_id 对账", {
          reservation_operation_id: reservation.operationId || `semantic:${input.clientRequestId}:reserve`,
          refund_operation_id: `semantic:${input.clientRequestId}:refund:provider_failed`,
          credits_reserved: reserveCredits,
        }, null);
      }
      return {
        status: 200,
        body: {
          success: false,
          fallback_delivered: true,
          retry_safe: true,
          result: { ...ruleResult, method: "semantic_fallback", note: "语义模型暂不可用，预留积分已退回并使用规则分段" },
          semantic_status: "provider_failed_refunded",
          provider_call_started: providerCallStarted,
          ...providerFailure,
          upstream_completed: false,
          source: "semantic_llm",
          channel: model.publicId,
          charged: false,
          billing_replayed: Boolean(reservation.alreadyFulfilled || refund.alreadyFulfilled),
          chargeInfo: {
            reservation_operation_id: reservation.operationId || `semantic:${input.clientRequestId}:reserve`,
            refund_operation_id: refund.operationId || `semantic:${input.clientRequestId}:refund:provider_failed`,
            credits_reserved: reserveCredits,
            credits_refunded: reserveCredits,
          },
        },
      };
    }
    return billingUnknownResult("语义模型失败且退款状态无法确认，请按 attempt_id 对账", {
      reservation_operation_id: `semantic:${input.clientRequestId}:reserve`,
      refund_operation_id: `semantic:${input.clientRequestId}:refund:provider_failed`,
      credits_reserved: reserveCredits,
    }, null);
  }

  const semanticResult = provider.choice
    ? validateGroups(provider.choice, units, input.duration, model.model)
    : null;
  const integrityPassed = semanticResult
    && normalizeForIntegrity(reconstructSegmentedText(semanticResult.segments, semanticResult.overlapPrefixes))
      === normalizeForIntegrity(input.text);
  if (!provider.usage || !semanticResult || !integrityPassed) {
    const validation = { ...provider.diagnostics, groups_valid: semanticResult !== null, integrity_passed: Boolean(integrityPassed) };
    const invalidNote = !provider.usage ? "模型未返回可核对的用量"
      : !provider.choice ? "模型未返回完整的分组 JSON"
        : !semanticResult ? "模型分组未满足顺序或长度约束" : "模型结果未通过原文完整性校验";
    if (reservation) {
      const refund = await refundCredits({
        userId: input.userId,
        clientRequestId: input.clientRequestId,
        amount: reserveCredits,
        scope: "invalid_result",
        model,
      });
      if (!refund.success) {
        return billingUnknownResult("语义结果未通过校验且退款未确认，请按 attempt_id 对账", {
          reservation_operation_id: reservation.operationId || `semantic:${input.clientRequestId}:reserve`,
          refund_operation_id: `semantic:${input.clientRequestId}:refund:invalid_result`,
          credits_reserved: reserveCredits,
        });
      }
      return {
        status: 200,
        body: {
          success: false,
          fallback_delivered: true,
          retry_safe: true,
          result: { ...ruleResult, method: "semantic_fallback", note: `${invalidNote}，预留积分已退回` },
          semantic_validation: validation,
          semantic_status: "invalid_result_refunded",
          provider_call_started: true,
          upstream_completed: true,
          provider_task_id: provider.providerRequestId || undefined,
          source: "semantic_llm",
          channel: model.publicId,
          charged: false,
          chargeInfo: {
            reservation_operation_id: reservation.operationId || `semantic:${input.clientRequestId}:reserve`,
            refund_operation_id: refund.operationId || `semantic:${input.clientRequestId}:refund:invalid_result`,
            credits_reserved: reserveCredits,
            credits_refunded: reserveCredits,
          },
        },
      };
    }
    return billingUnknownResult("语义结果未通过校验且退款状态无法确认，请按 attempt_id 对账", {
      reservation_operation_id: `semantic:${input.clientRequestId}:reserve`,
      refund_operation_id: `semantic:${input.clientRequestId}:refund:invalid_result`,
      credits_reserved: reserveCredits,
    });
  }

  const actualQuote = calculateCredits(
    model.billingSnapshot.config,
    provider.usage.promptTokens,
    provider.usage.completionTokens,
    provider.usage.cachedTokens,
  );
  const actualCredits = stableCredits(actualQuote.creditsCharged);
  let adjustment: AtomicWalletOperationResult | null = null;
  let refundAmount = 0;
  let extraAmount = 0;
  if (reservation) {
    if (actualCredits < reserveCredits) {
      refundAmount = stableCredits(reserveCredits - actualCredits);
      if (refundAmount > 0) {
        adjustment = await refundCredits({
          userId: input.userId,
          clientRequestId: input.clientRequestId,
          amount: refundAmount,
          scope: "unused_reserve",
          model,
        });
      }
    } else if (actualCredits > reserveCredits) {
      extraAmount = stableCredits(actualCredits - reserveCredits);
      adjustment = await applyWalletWithRetry({
        userId: input.userId,
        operationKind: "credit_charge",
        idempotencyKey: `semantic:${input.clientRequestId}:settle-extra`,
        amount: extraAmount,
        description: "智能语义分段补充结算",
        metadata: {
          source: "segmenter.semantic",
          phase: "settle-extra",
          public_model_id: model.publicId,
          price_snapshot: model.billingSnapshot.priceSnapshot,
        },
      });
    }
    if (adjustment && !adjustment.success) {
      return billingUnknownResult("语义模型已完成但最终钱包调整未确认，请按 attempt_id 对账", {
        reservation_operation_id: reservation.operationId || `semantic:${input.clientRequestId}:reserve`,
        adjustment_operation_id: refundAmount > 0
          ? `semantic:${input.clientRequestId}:refund:unused_reserve`
          : `semantic:${input.clientRequestId}:settle-extra`,
        credits_reserved: reserveCredits,
        credits_expected: actualCredits,
      });
    }
  }

  try {
    await recordRevenue({
      userId: input.userId,
      userRole: input.userRole,
      modelId: `segmenter:${model.publicId}`,
      taskId: `semantic:${input.clientRequestId}:revenue`,
      costPrice: actualQuote.actualCostRmb,
      sellingPrice: actualQuote.sellPriceRmb,
      recordType: "chat",
      creditsCharged: actualCredits,
    });
  } catch {
    return billingUnknownResult("语义模型已完成但收益记录未确认，请按 attempt_id 对账", {
      reservation_operation_id: reservation?.operationId || `semantic:${input.clientRequestId}:reserve`,
      revenue_idempotency_key: `semantic:${input.clientRequestId}:revenue`,
      credits_expected: actualCredits,
    });
  }

  return {
    status: 200,
    body: {
      success: true,
      result: semanticResult,
      semantic_status: "succeeded",
      semantic_validation: { ...provider.diagnostics, groups_valid: true, integrity_passed: true },
      provider_call_started: true,
      upstream_completed: true,
      provider_task_id: provider.providerRequestId || undefined,
      source: "semantic_llm",
      channel: model.publicId,
      charged: actualCredits > 0,
      billing_replayed: Boolean(reservation?.alreadyFulfilled || adjustment?.alreadyFulfilled),
      price: actualCredits,
      cost: actualQuote.actualCostRmb,
      usage: {
        prompt_tokens: provider.usage.promptTokens,
        completion_tokens: provider.usage.completionTokens,
        cached_tokens: provider.usage.cachedTokens,
      },
      chargeInfo: {
        reservation_operation_id: reservation?.operationId || `semantic:${input.clientRequestId}:reserve`,
        adjustment_operation_id: adjustment?.operationId || null,
        credits_reserved: reserveCredits,
        credits_refunded: refundAmount,
        credits_extra: extraAmount,
        credits_charged: actualCredits,
        balance_after: adjustment?.balanceAfter ?? reservation?.balanceAfter,
      },
    },
  };
}
