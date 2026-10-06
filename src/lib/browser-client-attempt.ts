"use client";

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const STORAGE_PREFIX = "production-client-attempt:v1:";
const MAX_ATTEMPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredClientAttempt = {
  clientRequestId: string;
  fingerprint: string;
  updatedAt: number;
};

export type BrowserClientAttempt = {
  clientRequestId: string;
  clientRequestFingerprint: string;
  reused: boolean;
};

export function readBrowserClientAttempt(storageKey: string): BrowserClientAttempt | null {
  const stored = readStoredAttempt(storageKey);
  if (!stored) return null;
  return {
    clientRequestId: stored.clientRequestId,
    clientRequestFingerprint: stored.fingerprint,
    reused: true,
  };
}

function canonicalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizePayload(nested)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function fallbackFingerprint(source: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}${source.length.toString(16)}`;
}

export async function buildClientRequestFingerprint(payload: unknown): Promise<string> {
  const source = JSON.stringify(canonicalizePayload(payload));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackFingerprint(source);
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storageForBrowser(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStoredAttempt(storageKey: string): StoredClientAttempt | null {
  const storage = storageForBrowser();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(`${STORAGE_PREFIX}${storageKey}`) || "null") as Partial<StoredClientAttempt> | null;
    if (!parsed || !CLIENT_REQUEST_ID_PATTERN.test(String(parsed.clientRequestId || ""))) return null;
    if (!parsed.fingerprint || !Number.isFinite(parsed.updatedAt)) return null;
    if (Date.now() - Number(parsed.updatedAt) > MAX_ATTEMPT_AGE_MS) return null;
    return {
      clientRequestId: String(parsed.clientRequestId),
      fingerprint: String(parsed.fingerprint),
      updatedAt: Number(parsed.updatedAt),
    };
  } catch {
    return null;
  }
}

function persistAttempt(storageKey: string, attempt: StoredClientAttempt) {
  const storage = storageForBrowser();
  if (!storage) return;
  try {
    storage.setItem(`${STORAGE_PREFIX}${storageKey}`, JSON.stringify(attempt));
  } catch {
    // Browser storage can be unavailable or full. React state still keeps the
    // current-page retry on the same attempt.
  }
}

function createClientRequestId(prefix: string): string {
  const safePrefix = String(prefix || "request").replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 32) || "request";
  const uuid = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  const clientRequestId = `${safePrefix}-${uuid}`;
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw new Error("CLIENT_REQUEST_ID_FACTORY_INVALID");
  }
  return clientRequestId;
}

export function resolveBrowserClientAttempt(input: {
  storageKey: string;
  fingerprint: string;
  prefix: string;
  previousRequestId?: string | null;
  previousFingerprint?: string | null;
  previousTerminal?: boolean;
}): BrowserClientAttempt {
  const fingerprint = String(input.fingerprint || "");
  if (!fingerprint) throw new Error("CLIENT_REQUEST_FINGERPRINT_REQUIRED");

  const stateRequestId = String(input.previousRequestId || "");
  const stored = input.previousTerminal ? null : readStoredAttempt(input.storageKey);
  const stateReusable = Boolean(
    !input.previousTerminal
    && CLIENT_REQUEST_ID_PATTERN.test(stateRequestId)
    && input.previousFingerprint === fingerprint,
  );
  const storedReusable = Boolean(stored && stored.fingerprint === fingerprint);
  const clientRequestId = stateReusable
    ? stateRequestId
    : storedReusable
      ? stored!.clientRequestId
      : createClientRequestId(input.prefix);

  persistAttempt(input.storageKey, {
    clientRequestId,
    fingerprint,
    updatedAt: Date.now(),
  });
  return {
    clientRequestId,
    clientRequestFingerprint: fingerprint,
    reused: stateReusable || storedReusable,
  };
}

export function clearBrowserClientAttempt(storageKey: string, expectedClientRequestId?: string | null) {
  const storage = storageForBrowser();
  if (!storage) return;
  try {
    const key = `${STORAGE_PREFIX}${storageKey}`;
    if (expectedClientRequestId) {
      const stored = readStoredAttempt(storageKey);
      if (stored && stored.clientRequestId !== expectedClientRequestId) return;
    }
    storage.removeItem(key);
  } catch {
    // Best-effort cleanup only. Terminal state also separates the next action.
  }
}

/** Clear a terminal attempt when its exact per-item storage key is no longer in component state. */
export function clearBrowserClientAttemptsById(storageKeyPrefix: string, expectedClientRequestId: string) {
  if (!CLIENT_REQUEST_ID_PATTERN.test(expectedClientRequestId)) return;
  const storage = storageForBrowser();
  if (!storage) return;
  try {
    const fullPrefix = `${STORAGE_PREFIX}${storageKeyPrefix}`;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key && key.startsWith(fullPrefix)));
    for (const key of keys) {
      try {
        const parsed = JSON.parse(storage.getItem(key) || "null") as Partial<StoredClientAttempt> | null;
        if (parsed?.clientRequestId === expectedClientRequestId) storage.removeItem(key);
      } catch {
        // Invalid state is ignored here; normal age and schema checks handle it.
      }
    }
  } catch {
    // Best-effort terminal cleanup only.
  }
}
