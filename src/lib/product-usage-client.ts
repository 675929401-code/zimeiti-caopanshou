"use client";

import type {
  ProductUsageBrowserEvent,
  ProductUsageEntryPoint,
  ProductUsageEventType,
  ProductUsageFeatureKey,
  ProductUsageMilestoneKey,
  ProductUsagePageKey,
} from "@/lib/product-usage-contract";

const SESSION_STORAGE_KEY = "product_usage_session_v1";
const SEQUENCE_STORAGE_KEY = "product_usage_sequence_v1";
const COLLECTION_STATUS_TTL_MS = 60_000;
const COLLECTION_STATUS_TIMEOUT_MS = 5_000;
const collectionStatuses = new Map<string, { enabled: boolean; expiresAtMs: number }>();
const collectionStatusRequests = new Map<string, Promise<boolean | null>>();

export interface ProductUsageClientEvent {
  eventType: ProductUsageEventType;
  featureKey: ProductUsageFeatureKey;
  pageKey?: ProductUsagePageKey | null;
  journeyId?: string | null;
  milestoneKey?: ProductUsageMilestoneKey | null;
  entryPoint?: ProductUsageEntryPoint | null;
  outcomeReasonCode?: string | null;
  durationMs?: number | null;
  stepNumber?: number | null;
}

export interface ProductUsageRecordOptions {
  token?: string | null;
  endpoint?: string;
  signal?: AbortSignal;
}

export interface ProductUsageRecordResult {
  status: "accepted" | "skipped" | "unavailable";
  code: string;
  receivedCount: number;
}

function uuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function productUsageSessionId(): string {
  try {
    const current = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (current && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(current)) {
      return current;
    }
    const created = uuid();
    sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return uuid();
  }
}

function nextSequence(): number {
  try {
    const current = Number(sessionStorage.getItem(SEQUENCE_STORAGE_KEY) || 0);
    const next = Number.isSafeInteger(current) && current >= 0 ? Math.min(current + 1, 2_147_483_647) : 1;
    sessionStorage.setItem(SEQUENCE_STORAGE_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

export function buildProductUsageBrowserEvent(
  input: ProductUsageClientEvent,
  context: { id?: string; sessionId?: string; sequence?: number; occurredAt?: string } = {},
): ProductUsageBrowserEvent {
  return {
    id: context.id ?? uuid(),
    session_id: context.sessionId ?? productUsageSessionId(),
    event_type: input.eventType,
    feature_key: input.featureKey,
    page_key: input.pageKey ?? null,
    journey_id: input.journeyId ?? null,
    milestone_key: input.milestoneKey ?? null,
    entry_point: input.entryPoint ?? null,
    outcome_reason_code: input.outcomeReasonCode ?? null,
    duration_ms: input.durationMs ?? null,
    step_number: input.stepNumber ?? null,
    client_sequence: context.sequence ?? nextSequence(),
    occurred_at: context.occurredAt ?? new Date().toISOString(),
  };
}

function collectionEnabled(endpoint: string): Promise<boolean | null> {
  const cached = collectionStatuses.get(endpoint);
  if (cached && cached.expiresAtMs > Date.now()) return Promise.resolve(cached.enabled);
  const pending = collectionStatusRequests.get(endpoint);
  if (pending) return pending;

  // The shared deadline covers both headers and body parsing. Its controller
  // is independent of callers, and the race releases even if abort is ignored.
  const request = (async () => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<null>((resolve) => {
        timeout = setTimeout(() => { controller.abort(); resolve(null); }, COLLECTION_STATUS_TIMEOUT_MS);
      });
      const lookup = (async () => {
        const response = await fetch(endpoint, { method: "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (response.status !== 200) return null;
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || Array.isArray(body)
          || !("collectionEnabled" in body) || typeof body.collectionEnabled !== "boolean") return null;
        return body.collectionEnabled;
      })();
      return await Promise.race([lookup, deadline]);
    } catch {
      return null;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  })().then((enabled) => {
    if (enabled !== null) collectionStatuses.set(endpoint, { enabled, expiresAtMs: Date.now() + COLLECTION_STATUS_TTL_MS });
    return enabled;
  }).finally(() => { collectionStatusRequests.delete(endpoint); });
  collectionStatusRequests.set(endpoint, request);
  return request;
}

/**
 * Explicit, best-effort product usage recorder.
 *
 * It accepts only typed enum fields and numeric timing. There is deliberately
 * no generic metadata bag, so callers cannot attach prompts, generated text,
 * media URLs, e-mail addresses, IP addresses or user-agent text by accident.
 */
export async function recordProductUsageEvents(
  inputs: ProductUsageClientEvent[],
  options: ProductUsageRecordOptions = {},
): Promise<ProductUsageRecordResult> {
  if (typeof window === "undefined") return { status: "skipped", code: "BROWSER_REQUIRED", receivedCount: 0 };
  if (!Array.isArray(inputs) || inputs.length === 0) return { status: "skipped", code: "NO_EVENTS", receivedCount: 0 };
  if (document.visibilityState === "hidden") return { status: "skipped", code: "PAGE_HIDDEN", receivedCount: 0 };
  if (navigator.onLine === false) return { status: "skipped", code: "OFFLINE", receivedCount: 0 };
  if (options.signal?.aborted) return { status: "skipped", code: "ABORTED", receivedCount: 0 };

  const token = options.token ?? localStorage.getItem("auth_token");
  if (!token) return { status: "skipped", code: "UNAUTHENTICATED", receivedCount: 0 };

  const endpoint = options.endpoint ?? "/api/product-usage/events";
  const enabled = await collectionEnabled(endpoint);
  if (options.signal?.aborted) return { status: "skipped", code: "ABORTED", receivedCount: 0 };
  if (String(document.visibilityState) === "hidden") return { status: "skipped", code: "PAGE_HIDDEN", receivedCount: 0 };
  if ((navigator.onLine as boolean) === false) return { status: "skipped", code: "OFFLINE", receivedCount: 0 };
  if (enabled === false) return { status: "skipped", code: "COLLECTION_DISABLED", receivedCount: 0 };
  if (enabled !== true) return { status: "unavailable", code: "COLLECTION_STATUS_UNKNOWN", receivedCount: 0 };

  const events = inputs.slice(0, 20).map((input) => buildProductUsageBrowserEvent(input));
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events }),
      cache: "no-store",
      credentials: "same-origin",
      keepalive: true,
      signal: options.signal,
    });
    const parsedBody: unknown = await response.json().catch(() => null);
    const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? parsedBody as { ok?: unknown; code?: unknown; receivedCount?: unknown } : {};
    if (response.ok && response.status === 202 && body.ok === true && body.code === "PRODUCT_USAGE_ACCEPTED"
      && typeof body.receivedCount === "number" && Number.isInteger(body.receivedCount)
      && body.receivedCount > 0 && body.receivedCount <= events.length) {
      return {
        status: "accepted",
        code: "PRODUCT_USAGE_ACCEPTED",
        receivedCount: body.receivedCount,
      };
    }
    if (response.ok) return { status: "unavailable", code: "PRODUCT_USAGE_RESPONSE_INVALID", receivedCount: 0 };
    return {
      status: response.status === 429 ? "skipped" : "unavailable",
      code: typeof body.code === "string" ? body.code : `HTTP_${response.status}`,
      receivedCount: 0,
    };
  } catch (error) {
    return {
      status: options.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "skipped" : "unavailable",
      code: options.signal?.aborted ? "ABORTED" : "NETWORK_UNAVAILABLE",
      receivedCount: 0,
    };
  }
}

export async function recordProductUsageEvent(
  input: ProductUsageClientEvent,
  options: ProductUsageRecordOptions = {},
): Promise<ProductUsageRecordResult> {
  return recordProductUsageEvents([input], options);
}
