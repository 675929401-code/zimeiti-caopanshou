import {
  LlmRequestIdempotencyError,
  validateLlmClientRequestId,
} from "@/lib/llm-request-idempotency";

type RequestWithHeaders = {
  readonly headers: {
    get(name: string): string | null;
  };
};

/**
 * Resolve the one stable identity used by a billable Film Studio text request.
 *
 * The route must reject a missing, malformed, or conflicting identity before it
 * selects or calls a paid model. This keeps browser retries and internal route
 * delegation bound to the same main-site LLM idempotency claim and wallet key.
 */
export function requireShortDramaPaidRequestId(
  request: RequestWithHeaders,
  bodyClientRequestId = "",
): string {
  const headerClientRequestId = request.headers.get("idempotency-key")?.trim() || "";
  const normalizedBodyClientRequestId = bodyClientRequestId.trim();

  if (
    headerClientRequestId
    && normalizedBodyClientRequestId
    && headerClientRequestId !== normalizedBodyClientRequestId
  ) {
    throw new LlmRequestIdempotencyError(
      "LLM_IDEMPOTENCY_CONFLICT",
      "影视工坊请求标识不一致，为避免重复扣费，本次没有调用模型",
      409,
    );
  }

  const clientRequestId = headerClientRequestId || normalizedBodyClientRequestId;
  if (!clientRequestId) {
    throw new LlmRequestIdempotencyError(
      "LLM_IDEMPOTENCY_KEY_INVALID",
      "影视工坊付费请求必须携带稳定请求标识",
      400,
    );
  }

  validateLlmClientRequestId(clientRequestId);
  return clientRequestId;
}
