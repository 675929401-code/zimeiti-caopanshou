import { createHash } from "node:crypto";

const ATTEMPT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const STABLE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const PROVIDER_IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]{1,240}$/u;
const EVIDENCE_SOURCES = new Set([
  "provider_dashboard",
  "provider_support",
  "provider_signed_receipt",
  "bank_statement",
  "no_conclusive_evidence",
]);

export type PaymentRefundReconciliationAction =
  | "confirm_completed"
  | "confirm_rejected"
  | "keep_frozen";

export type PaymentRefundReconciliationEvidence = {
  source: "provider_dashboard" | "provider_support" | "provider_signed_receipt" | "bank_statement" | "no_conclusive_evidence";
  reference: string | null;
  observedAt: string;
  providerStatus: "CD" | "UD" | "RD" | "UNKNOWN";
  providerTradeOrderId: string | null;
  providerRefundId: string | null;
  providerRefundAmount: number | null;
};

export type PaymentRefundReconciliationRequest = {
  attemptId: string;
  action: PaymentRefundReconciliationAction;
  note: string;
  idempotencyKey: string;
  evidence: PaymentRefundReconciliationEvidence;
  requestFingerprint: string;
  evidenceDigest: string;
};

export type RefundAttemptDecisionSnapshot = {
  state: string;
  tradeOrderId: string;
  paidAmount: number;
};

export class PaymentRefundReconciliationValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PaymentRefundReconciliationValidationError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value: unknown, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) return "";
  return normalized;
}

function nullableProviderIdentifier(value: unknown): string | null {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  return PROVIDER_IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

function positiveMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function parseObservedAt(value: unknown): string {
  const normalized = normalizedText(value, 64);
  const timestamp = Date.parse(normalized);
  const now = Date.now();
  if (!normalized || !Number.isFinite(timestamp) || timestamp > now + 5 * 60_000 || timestamp < now - 10 * 365 * 86400_000) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_EVIDENCE_TIME_INVALID",
      "证据观察时间无效",
      400,
    );
  }
  return new Date(timestamp).toISOString();
}

function canonicalEvidence(evidence: PaymentRefundReconciliationEvidence): string {
  return JSON.stringify({
    source: evidence.source,
    reference: evidence.reference,
    observedAt: evidence.observedAt,
    providerStatus: evidence.providerStatus,
    providerTradeOrderId: evidence.providerTradeOrderId,
    providerRefundId: evidence.providerRefundId,
    providerRefundAmount: evidence.providerRefundAmount,
  });
}

export function paymentRefundReconciliationActionId(actorId: string, idempotencyKey: string): string {
  return sha256(`${actorId}\u0000${idempotencyKey}`);
}

export function parsePaymentRefundReconciliationRequest(
  value: unknown,
  idempotencyKeyValue: string,
): PaymentRefundReconciliationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_REQUEST_INVALID",
      "人工退款核对请求格式无效",
      400,
    );
  }
  const input = value as Record<string, unknown>;
  const attemptId = normalizedText(input.attemptId, 64);
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_ATTEMPT_INVALID",
      "退款核对记录编号无效",
      400,
    );
  }
  const action = normalizedText(input.action, 32) as PaymentRefundReconciliationAction;
  if (!(["confirm_completed", "confirm_rejected", "keep_frozen"] as string[]).includes(action)) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_ACTION_INVALID",
      "人工退款核对动作无效",
      400,
    );
  }
  const note = normalizedText(input.note, 500);
  if (note.length < 8) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_NOTE_REQUIRED",
      "请填写至少 8 个字符的核对说明",
      400,
    );
  }
  const idempotencyKey = idempotencyKeyValue.trim();
  if (!STABLE_KEY_PATTERN.test(idempotencyKey)) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_IDEMPOTENCY_KEY_REQUIRED",
      "人工退款核对缺少稳定的幂等标识",
      400,
    );
  }

  const rawEvidence = input.evidence;
  if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_EVIDENCE_REQUIRED",
      "人工退款核对缺少证据",
      400,
    );
  }
  const candidate = rawEvidence as Record<string, unknown>;
  const source = normalizedText(candidate.source, 40) as PaymentRefundReconciliationEvidence["source"];
  if (!EVIDENCE_SOURCES.has(source)) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_EVIDENCE_SOURCE_INVALID",
      "退款核对证据来源无效",
      400,
    );
  }
  const reference = nullableProviderIdentifier(candidate.reference);
  const observedAt = parseObservedAt(candidate.observedAt);
  const providerStatus = normalizedText(candidate.providerStatus, 16).toUpperCase() as PaymentRefundReconciliationEvidence["providerStatus"];
  if (!(["CD", "UD", "RD", "UNKNOWN"] as string[]).includes(providerStatus)) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_PROVIDER_STATUS_INVALID",
      "退款核对供应商状态无效",
      400,
    );
  }
  const providerTradeOrderId = nullableProviderIdentifier(candidate.providerTradeOrderId);
  const providerRefundId = nullableProviderIdentifier(candidate.providerRefundId);
  const providerRefundAmount = positiveMoney(candidate.providerRefundAmount);

  if (action === "confirm_completed") {
    if (source === "no_conclusive_evidence" || !reference || providerStatus !== "CD"
      || !providerTradeOrderId || !providerRefundId || providerRefundAmount === null) {
      throw new PaymentRefundReconciliationValidationError(
        "PAYMENT_REFUND_RECONCILIATION_COMPLETION_EVIDENCE_INCOMPLETE",
        "确认退款完成需要供应商终态、订单号、退款单号、精确金额和可追溯证据编号",
        422,
      );
    }
  } else if (action === "confirm_rejected") {
    if (source === "no_conclusive_evidence" || !reference || providerStatus !== "UD" || !providerTradeOrderId) {
      throw new PaymentRefundReconciliationValidationError(
        "PAYMENT_REFUND_RECONCILIATION_REJECTION_EVIDENCE_INCOMPLETE",
        "确认退款失败需要供应商失败终态、订单号和可追溯证据编号",
        422,
      );
    }
  } else if (providerStatus === "CD" || providerStatus === "UD") {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_FROZEN_STATUS_CONFLICT",
      "供应商已给出明确终态时不能仅登记继续冻结",
      409,
    );
  }

  const evidence: PaymentRefundReconciliationEvidence = {
    source,
    reference,
    observedAt,
    providerStatus,
    providerTradeOrderId,
    providerRefundId,
    providerRefundAmount,
  };
  const evidenceDigest = sha256(canonicalEvidence(evidence));
  const requestFingerprint = sha256(JSON.stringify({ attemptId, action, note, evidenceDigest }));
  return { attemptId, action, note, idempotencyKey, evidence, requestFingerprint, evidenceDigest };
}

export function evaluatePaymentRefundReconciliationDecision(
  attempt: RefundAttemptDecisionSnapshot,
  request: PaymentRefundReconciliationRequest,
): { terminalState: "completed" | "released" | "reconciliation_required"; walletMutation: "none" | "release" } {
  if (attempt.state !== "reconciliation_required") {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_STATE_CONFLICT",
      "该退款记录已不在待核对状态",
      409,
    );
  }
  if (!PROVIDER_IDENTIFIER_PATTERN.test(attempt.tradeOrderId) || !Number.isFinite(attempt.paidAmount) || attempt.paidAmount <= 0) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_ATTEMPT_EVIDENCE_INVALID",
      "退款记录自身证据不完整，保持冻结并停止处理",
      503,
    );
  }
  if (request.action === "keep_frozen") {
    return { terminalState: "reconciliation_required", walletMutation: "none" };
  }
  if (request.evidence.providerTradeOrderId !== attempt.tradeOrderId) {
    throw new PaymentRefundReconciliationValidationError(
      "PAYMENT_REFUND_RECONCILIATION_ORDER_MISMATCH",
      "证据中的商户订单号与退款记录不一致",
      422,
    );
  }
  if (request.action === "confirm_completed") {
    if (request.evidence.providerRefundAmount !== Math.round(attempt.paidAmount * 100) / 100) {
      throw new PaymentRefundReconciliationValidationError(
        "PAYMENT_REFUND_RECONCILIATION_AMOUNT_MISMATCH",
        "证据中的退款金额与原支付金额不一致",
        422,
      );
    }
    return { terminalState: "completed", walletMutation: "none" };
  }
  return { terminalState: "released", walletMutation: "release" };
}
