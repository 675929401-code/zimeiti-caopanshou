"use client";

import {
  clearBrowserClientAttempt as clearPersistedAttempt,
  clearBrowserClientAttemptsById as clearPersistedAttemptsById,
  resolveBrowserClientAttempt as resolvePersistedAttempt,
  type BrowserClientAttempt,
} from "@/lib/browser-client-attempt";

export { buildClientRequestFingerprint, type BrowserClientAttempt } from "@/lib/browser-client-attempt";

// Keep unresolved requests through tab remounts and storage failures. Separate
// fingerprints also preserve A -> B -> A retries within this browser session.
const attempts = new Map<string, BrowserClientAttempt>();


/** Clear a retry key only when both execution and billing are settled. */
export function isDefinitiveExtractionFailure(status: number, responseBody?: unknown): boolean {
  const body = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
    ? responseBody as Record<string, unknown> : undefined;
  if (body?.billing_unknown === true || body?.retry_safe === false || body?.charged === true) return false;
  if (body?.provider_call_started === false) return true;
  if (body?.success === false && body?.upstream_completed === true && body?.charged === false) return true;
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

export async function readExtractionJsonResponse<T>(response: Response): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`结果暂未确认（HTTP ${response.status}），原请求已保留。请稍后刷新状态。`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("结果暂未确认，原请求已保留。请稍后刷新状态。");
  }
  return parsed as T;
}

export function resolveBrowserClientAttempt(input: Parameters<typeof resolvePersistedAttempt>[0]): BrowserClientAttempt {
  const key = `${input.storageKey}\u0000${input.fingerprint}`;
  const previous = attempts.get(key);
  const attempt = resolvePersistedAttempt({
    ...input,
    previousRequestId: previous?.clientRequestId ?? input.previousRequestId,
    previousFingerprint: previous?.clientRequestFingerprint ?? input.previousFingerprint,
  });
  attempts.set(key, attempt);
  return attempt;
}

export function clearBrowserClientAttempt(storageKey: string, expectedClientRequestId?: string | null) {
  for (const [key, attempt] of attempts) {
    if (key.startsWith(`${storageKey}\u0000`) && (!expectedClientRequestId || attempt.clientRequestId === expectedClientRequestId)) {
      attempts.delete(key);
    }
  }
  clearPersistedAttempt(storageKey, expectedClientRequestId);
}

export function clearBrowserClientAttemptsById(storageKeyPrefix: string, expectedClientRequestId: string) {
  for (const [key, attempt] of attempts) {
    const storageKey = key.split("\u0000", 1)[0];
    if (storageKey.startsWith(storageKeyPrefix) && attempt.clientRequestId === expectedClientRequestId) {
      attempts.delete(key);
    }
  }
  clearPersistedAttemptsById(storageKeyPrefix, expectedClientRequestId);
}
