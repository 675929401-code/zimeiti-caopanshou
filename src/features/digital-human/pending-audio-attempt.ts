export type PendingAudioAttempt = { key: string; fingerprint: string };

const POINTER_VERSION = 1;
const POINTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function hashText(source: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `v1-${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}-${source.length.toString(16)}`;
}

export function fingerprintPendingAudioPayload(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function normalizeAttempt(value: unknown): PendingAudioAttempt | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PendingAudioAttempt>;
  const key = String(candidate.key || "").trim();
  const rawFingerprint = String(candidate.fingerprint || "");
  if (!REQUEST_KEY_PATTERN.test(key) || !rawFingerprint) return null;
  // Older records stored JSON input as the fingerprint. Hash it while
  // upgrading so the retained request pointer contains no script text.
  const fingerprint = /^[A-Za-z0-9._:-]{8,128}$/u.test(rawFingerprint)
    ? rawFingerprint
    : hashText(rawFingerprint);
  return { key, fingerprint };
}

export function readPendingAudioAttempt(storage: Storage, storageKey: string, now = Date.now()): PendingAudioAttempt | undefined {
  const raw = storage.getItem(storageKey);
  if (!raw) return undefined;
  let parsed: { version?: unknown; attempt?: unknown; updatedAt?: unknown } | null;
  try {
    parsed = JSON.parse(raw) as { version?: unknown; attempt?: unknown; updatedAt?: unknown } | null;
  } catch {
    storage.removeItem(storageKey);
    return undefined;
  }
  const attempt = normalizeAttempt(parsed?.attempt);
  const updatedAt = Number(parsed?.updatedAt);
  if (!attempt || (parsed?.version === POINTER_VERSION && (!Number.isFinite(updatedAt) || now - updatedAt > POINTER_TTL_MS))) {
    storage.removeItem(storageKey);
    return undefined;
  }
  const pointer = JSON.stringify({ version: POINTER_VERSION, attempt, updatedAt: Number.isFinite(updatedAt) ? updatedAt : now });
  storage.setItem(storageKey, pointer);
  return attempt;
}

export function writePendingAudioAttempt(storage: Storage, storageKey: string, attempt?: PendingAudioAttempt): void {
  if (!attempt) {
    storage.removeItem(storageKey);
    return;
  }
  const normalized = normalizeAttempt(attempt);
  if (!normalized) throw new Error("INVALID_PENDING_AUDIO_ATTEMPT");
  const serialized = JSON.stringify({ version: POINTER_VERSION, attempt: normalized, updatedAt: Date.now() });
  storage.setItem(storageKey, serialized);
  if (storage.getItem(storageKey) !== serialized) throw new Error("PENDING_AUDIO_ATTEMPT_NOT_PERSISTED");
}
