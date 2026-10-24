import type { BrowserClientAttempt } from "@/lib/browser-client-attempt";

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export type StoryboardVideoRetryIdentity = {
  currentFingerprint: string;
  previousRequestId?: string | null;
  previousFingerprint?: string | null;
  sameRequestKeyRequired?: boolean;
};

/**
 * Preserve the provider's required idempotency key for a confirmed no-task
 * retry. A payload change or missing original identity must fail before any
 * request can be dispatched; callers may use the normal attempt resolver only
 * when this returns null.
 */
export function resolveStoryboardVideoSameKeyRetryAttempt(
  input: StoryboardVideoRetryIdentity,
): BrowserClientAttempt | null {
  if (input.sameRequestKeyRequired !== true) return null;

  const currentFingerprint = String(input.currentFingerprint || "");
  if (!currentFingerprint) throw new Error("VIDEO_RETRY_FINGERPRINT_REQUIRED_NOT_DISPATCHED");

  const previousRequestId = String(input.previousRequestId || "");
  if (!CLIENT_REQUEST_ID_PATTERN.test(previousRequestId)) {
    throw new Error("VIDEO_RETRY_ORIGINAL_REQUEST_ID_REQUIRED_NOT_DISPATCHED");
  }

  const previousFingerprint = String(input.previousFingerprint || "");
  if (!previousFingerprint) throw new Error("VIDEO_RETRY_ORIGINAL_FINGERPRINT_REQUIRED_NOT_DISPATCHED");
  if (previousFingerprint !== currentFingerprint) {
    throw new Error("VIDEO_RETRY_FINGERPRINT_MISMATCH_NOT_DISPATCHED");
  }

  return {
    clientRequestId: previousRequestId,
    clientRequestFingerprint: currentFingerprint,
    reused: true,
  };
}
