import type { ClientSubmissionIdentity } from "@/lib/short-drama/client-submission-identity";
import { workbenchUserStorageKey } from "@/lib/workbench-user-storage";

const SUBMISSION_POINTER_VERSION = 1;
const SUBMISSION_POINTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HASHED_FINGERPRINT_PATTERN = /^[a-f0-9]{16,128}$/u;

type StoredSubmissionPointer = {
  version: typeof SUBMISSION_POINTER_VERSION;
  identity: ClientSubmissionIdentity;
  updatedAt: number;
};

function pointerKey(draftKey: string, userId: string) {
  return workbenchUserStorageKey(`${draftKey}:pending-request`, userId);
}

export function readGeneralScriptSubmission(draftKey: string, userId: string): ClientSubmissionIdentity | null {
  if (typeof window === "undefined") return null;
  const key = pointerKey(draftKey, userId);
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "null") as Partial<StoredSubmissionPointer & ClientSubmissionIdentity> | null;
    const candidate = value?.version === SUBMISSION_POINTER_VERSION ? value.identity : value;
    const identity = typeof candidate?.requestId === "string" && candidate.requestId.length > 0
      && typeof candidate.fingerprint === "string" && HASHED_FINGERPRINT_PATTERN.test(candidate.fingerprint)
      ? { requestId: candidate.requestId, fingerprint: candidate.fingerprint }
      : null;
    const updatedAt = Number(value?.updatedAt);
    const expired = value?.version === SUBMISSION_POINTER_VERSION
      && (!Number.isFinite(updatedAt) || Date.now() - updatedAt > SUBMISSION_POINTER_TTL_MS);
    if (!identity || expired) {
      window.localStorage.removeItem(key);
      if (identity) window.localStorage.removeItem(`${key}:${encodeURIComponent(identity.requestId)}`);
      return null;
    }
    // Upgrade old pointer-only records without retaining the submitted script.
    if (value?.version !== SUBMISSION_POINTER_VERSION) saveGeneralScriptSubmission(draftKey, userId, identity);
    return identity;
  } catch {
    try { window.localStorage.removeItem(key); } catch { /* unavailable storage remains fail-closed at submission */ }
    return null;
  }
}

/** Persist before POST. Separate records retain earlier unresolved requests when input changes. */
export function saveGeneralScriptSubmission(draftKey: string, userId: string, identity: ClientSubmissionIdentity): void {
  if (!HASHED_FINGERPRINT_PATTERN.test(identity.fingerprint)) {
    throw new Error("请求指纹尚未安全生成，本次尚未提交生成。");
  }
  const key = pointerKey(draftKey, userId);
  const value = JSON.stringify({
    version: SUBMISSION_POINTER_VERSION,
    identity,
    updatedAt: Date.now(),
  } satisfies StoredSubmissionPointer);
  try {
    window.localStorage.setItem(`${key}:${encodeURIComponent(identity.requestId)}`, value);
    window.localStorage.setItem(key, value);
  } catch { throw new Error("浏览器无法保留本次请求编号，请释放存储空间后重试；本次尚未提交生成。"); }
}

export function clearGeneralScriptSubmission(draftKey: string, userId: string, requestId: string): void {
  const key = pointerKey(draftKey, userId);
  try {
    if (readGeneralScriptSubmission(draftKey, userId)?.requestId === requestId) window.localStorage.removeItem(key);
    window.localStorage.removeItem(`${key}:${encodeURIComponent(requestId)}`);
  } catch { /* Keeping a confirmed identity is safe: the server replays the original result. */ }
}
