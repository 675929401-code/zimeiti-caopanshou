export type ImageRequestRejection = {
  code: "IMAGE_REFERENCE_READ_FAILED" | "IMAGE_REFERENCE_REJECTED" | "IMAGE_UPSTREAM_REQUEST_REJECTED"
    | "IMAGE_UPSTREAM_TERMINAL_EVENT" | "IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE"
    | "IMAGE_OUTPUT_ASPECT_RATIO_MISMATCH" | "IMAGE_OUTPUT_RESOLUTION_MISMATCH"
    | "IMAGE_BILLING_RESERVATION_REJECTED" | "IMAGE_PLATFORM_REQUEST_INTERRUPTED"
    | "IMAGE_PROVIDER_ADMISSION_BUSY" | "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE" | "IMAGE_PROVIDER_LINK_REQUIRED";
  source: "input" | "provider" | "platform";
  upstreamStatus?: number;
  /** Required when a relay wraps a definite provider refusal in a generic 5xx. */
  providerConfirmedRejection?: boolean;
  actualDimensions?: string;
  expectedAspectRatio?: string;
  expectedResolution?: string;
  expectedDimensions?: string;
  retryAfterSeconds?: number;
  admissionScope?: "global" | "provider" | "channel" | "model";
};

/** Parse only a rejection receipt bound to the exact request fingerprint. */
export function parseImageRequestRejectionReceipt(response: unknown, payloadFingerprint: string): ImageRequestRejection | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const value = response as Record<string, unknown>;
  if (value.schema !== "image_request_rejection.v1" || value.payloadFingerprint !== payloadFingerprint) return null;
  if (value.source === "provider" && value.code === "IMAGE_PROVIDER_LINK_REQUIRED" && value.upstreamStatus == null) {
    return { source: "provider", code: "IMAGE_PROVIDER_LINK_REQUIRED" };
  }
  if (value.source === "input" && value.code === "IMAGE_REFERENCE_READ_FAILED" && value.upstreamStatus == null) {
    return { source: "input", code: "IMAGE_REFERENCE_READ_FAILED" };
  }
  if (value.source === "input" && value.code === "IMAGE_BILLING_RESERVATION_REJECTED" && value.upstreamStatus == null) {
    return { source: "input", code: "IMAGE_BILLING_RESERVATION_REJECTED" };
  }
  if (value.source === "platform" && value.code === "IMAGE_PLATFORM_REQUEST_INTERRUPTED" && value.upstreamStatus == null) {
    return { source: "platform", code: "IMAGE_PLATFORM_REQUEST_INTERRUPTED" };
  }
  if (value.source === "platform"
    && (value.code === "IMAGE_PROVIDER_ADMISSION_BUSY" || value.code === "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE")
    && value.upstreamStatus == null) {
    const retryAfterSeconds = Number(value.retryAfterSeconds);
    const admissionScope = ["global", "provider", "channel", "model"].includes(String(value.admissionScope))
      ? value.admissionScope as ImageRequestRejection["admissionScope"]
      : undefined;
    if (value.code === "IMAGE_PROVIDER_ADMISSION_BUSY"
      && (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 3600)) return null;
    return {
      source: "platform",
      code: value.code,
      ...(value.code === "IMAGE_PROVIDER_ADMISSION_BUSY" ? { retryAfterSeconds } : {}),
      ...(admissionScope ? { admissionScope } : {}),
    };
  }
  const upstreamStatus = Number(value.upstreamStatus);
  const synchronousClientRejection = upstreamStatus >= 400 && upstreamStatus < 500
    && ![408, 425, 429, 499].includes(upstreamStatus);
  const confirmedWrappedRejection = upstreamStatus >= 500 && upstreamStatus <= 599
    && value.providerConfirmedRejection === true;
  if (value.source === "provider"
    && (value.code === "IMAGE_REFERENCE_REJECTED" || value.code === "IMAGE_UPSTREAM_REQUEST_REJECTED")
    && (synchronousClientRejection || confirmedWrappedRejection)) {
    return {
      source: "provider",
      code: value.code,
      upstreamStatus,
      ...(confirmedWrappedRejection ? { providerConfirmedRejection: true } : {}),
    };
  }
  if (value.source === "provider" && value.code === "IMAGE_UPSTREAM_TERMINAL_EVENT" && value.upstreamStatus == null) {
    return { source: "provider", code: "IMAGE_UPSTREAM_TERMINAL_EVENT" };
  }
  if (value.source === "provider" && value.code === "IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE"
    && Number(value.upstreamStatus) === 503) {
    return { source: "provider", code: "IMAGE_UPSTREAM_ACCOUNT_UNAVAILABLE", upstreamStatus: 503 };
  }
  if (value.source === "provider"
    && (value.code === "IMAGE_OUTPUT_ASPECT_RATIO_MISMATCH" || value.code === "IMAGE_OUTPUT_RESOLUTION_MISMATCH")
    && typeof value.actualDimensions === "string") {
    return {
      source: "provider",
      code: value.code,
      actualDimensions: value.actualDimensions,
      expectedAspectRatio: typeof value.expectedAspectRatio === "string" ? value.expectedAspectRatio : undefined,
      expectedResolution: typeof value.expectedResolution === "string" ? value.expectedResolution : undefined,
      expectedDimensions: typeof value.expectedDimensions === "string" ? value.expectedDimensions : undefined,
    };
  }
  return null;
}
