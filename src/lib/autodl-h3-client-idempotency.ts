export interface AutodlH3ClientAttemptInput {
  enabled: boolean;
  fingerprint: string;
  previousRequestId?: string | null;
  previousFingerprint?: string | null;
  previousTerminal?: boolean;
  createRequestId: () => string;
}

export interface AutodlH3ClientAttempt {
  clientRequestId: string;
  clientRequestFingerprint: string;
  reused: boolean;
}

/**
 * Keeps one idempotency key for one logical user action. The caller decides
 * when an outcome is unambiguously terminal; ambiguous network/5xx outcomes
 * deliberately retain the same key on retry.
 */
export function resolveAutodlH3ClientAttempt(input: AutodlH3ClientAttemptInput): AutodlH3ClientAttempt {
  if (!input.enabled) {
    return { clientRequestId: "", clientRequestFingerprint: "", reused: false };
  }

  const fingerprint = String(input.fingerprint || "");
  const previousRequestId = String(input.previousRequestId || "");
  const reusable = Boolean(
    previousRequestId
    && !input.previousTerminal
    && input.previousFingerprint === fingerprint
  );
  const clientRequestId = reusable ? previousRequestId : String(input.createRequestId() || "");
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(clientRequestId)) {
    throw new Error("AUTODL_H3_CLIENT_REQUEST_ID_FACTORY_INVALID");
  }
  return { clientRequestId, clientRequestFingerprint: fingerprint, reused: reusable };
}

export function isAmbiguousAutodlH3SubmissionStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
