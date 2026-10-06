import { sanitizeVideoChannelError } from "@/lib/video-channel-health-circuit";

type VideoAvailabilityMessageInput = {
  available: boolean;
  active: boolean;
  /** Internal acceptance evidence is diagnostic and must not affect public availability. */
  activationReady: boolean;
  priceReady: boolean;
  healthReadable: boolean;
  healthRecorded: boolean;
  circuitState: string;
  lastError: unknown;
};

export const VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED = "VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED";

export type VideoBillingAdapterAdmission = {
  ready: boolean;
  code: "" | typeof VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED;
  message: string;
};

/**
 * Some relay channels report their final supplier charge only through
 * usage.total_tokens.  A flat per-use/per-second quote cannot safely reserve
 * or settle those jobs.  Keep such models in the catalog, but fail closed
 * until the exact token settlement adapter has been explicitly enabled.
 */
export function videoBillingAdapterAdmission(
  protocolConfig: Record<string, unknown> | null | undefined,
): VideoBillingAdapterAdmission {
  const config = protocolConfig && typeof protocolConfig === "object" ? protocolConfig : {};
  const providerBillingUnit = String(config.provider_billing_unit || "").trim().toLowerCase();
  const tokenAdapterReady = config.token_billing_adapter_ready === true
    && config.public_billing_pending !== true;
  if (providerBillingUnit !== "token" || tokenAdapterReady) {
    return { ready: true, code: "", message: "" };
  }

  return {
    ready: false,
    code: VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED,
    message: "上游按 Token 计费，平台精确结算适配尚未完成；模型保留展示，暂不提交",
  };
}

/**
 * Customer-facing copy for models that cannot currently accept a request.
 * Funding errors never arrive here when the model is otherwise configured:
 * the funding_required circuit state remains selectable and the provider
 * response is shown only after the customer submits.
 */
export function videoModelAvailabilityMessage(input: VideoAvailabilityMessageInput): string {
  if (input.available) return "";
  if (!input.active || !input.priceReady) return "当前未开放";
  if (!input.healthReadable || !input.healthRecorded) return "渠道检查中";

  const errorCode = sanitizeVideoChannelError(input.lastError).code;
  if (errorCode === "UPSTREAM_AUTH" || errorCode === "UPSTREAM_MODEL_OR_CHANNEL_UNAVAILABLE") return "渠道维护中";
  if (errorCode === "UPSTREAM_TIMEOUT" || errorCode === "UPSTREAM_SERVER_ERROR"
    || input.circuitState === "open" || input.circuitState === "canary_ready") return "渠道恢复中";
  return "当前未开放";
}
