import "server-only";

import { randomUUID } from "node:crypto";

import type {
  ReliableSecurityEventType,
  ReliableSecurityRiskLevel,
  ReliableSecuritySource,
} from "@/lib/security-event-reliability-contracts";
import { getServerSecret } from "@/lib/server-secrets";

export const SECURITY_EVENT_INTERNAL_PATH = "/api/admin/security-events/internal";
export const SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS = 3;
export const SECURITY_EVENT_DELIVERY_TIMEOUT_MS = 800;
export const SECURITY_EVENT_DELIVERY_RETRY_DELAYS_MS = [75, 250] as const;

const MAX_RECEIPT_BYTES = 8_192;

export interface SecurityEventProducerPayload {
  event_type: ReliableSecurityEventType;
  risk_level: ReliableSecurityRiskLevel;
  ip: string;
  user_agent?: string;
  path?: string;
  method?: string;
  details?: string;
  blocked: boolean;
  source?: ReliableSecuritySource;
  user_id?: string | null;
  username?: string | null;
  display_name?: string | null;
  phone?: string | null;
}

export interface SecurityEventProducerConfigurationStatus {
  state: "configured" | "missing" | "invalid_origin";
  credentialConfigured: boolean;
  credentialSource: "SECURITY_INTERNAL_KEY";
  failClosed: true;
  receiverOriginConfigured: boolean;
  maxAttempts: number;
  requestTimeoutMs: number;
}

export interface SecurityEventDeliveryResult {
  status: "delivered" | "configuration_missing" | "configuration_invalid" | "rejected" | "retry_exhausted";
  code: string;
  attempts: number;
  durable: boolean;
  httpStatus: number | null;
}

interface SecurityEventDeliveryDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  internalKey?: string | null;
  receiverOrigin?: string | null;
  createIdempotencyKey?: () => string;
  timeoutMs?: number;
}

interface SecurityEventLifecycle {
  waitUntil(promise: Promise<unknown>): void;
}

interface SecurityEventReceipt {
  accepted?: unknown;
  durable?: unknown;
}

function configuredInternalKey(explicit: string | null | undefined): string | null {
  const value = explicit === undefined ? getServerSecret("SECURITY_INTERNAL_KEY") : explicit;
  return value?.trim() || null;
}

function configuredReceiverOrigin(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit?.trim().replace(/\/$/u, "") || null;
  const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT?.trim() || "";
  if (!domain) return "http://127.0.0.1:5000";
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(domain)) return null;
  return `https://${domain}`;
}

function producerConfiguration(
  internalKey: string | null,
  receiverOrigin: string | null,
): SecurityEventProducerConfigurationStatus {
  return {
    state: !internalKey ? "missing" : !receiverOrigin ? "invalid_origin" : "configured",
    credentialConfigured: Boolean(internalKey),
    credentialSource: "SECURITY_INTERNAL_KEY",
    failClosed: true,
    receiverOriginConfigured: Boolean(receiverOrigin),
    maxAttempts: SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS,
    requestTimeoutMs: SECURITY_EVENT_DELIVERY_TIMEOUT_MS,
  };
}

export function getSecurityEventProducerConfigurationStatus(
  internalKey: string | null | undefined = undefined,
  receiverOrigin: string | null | undefined = undefined,
): SecurityEventProducerConfigurationStatus {
  return producerConfiguration(
    configuredInternalKey(internalKey),
    configuredReceiverOrigin(receiverOrigin),
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readReceipt(response: Response): Promise<SecurityEventReceipt | null> {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/json")) return null;
  try {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RECEIPT_BYTES) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as SecurityEventReceipt
      : null;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function deliverSecurityEventWithRetry(
  payload: SecurityEventProducerPayload,
  dependencies: SecurityEventDeliveryDependencies = {},
): Promise<SecurityEventDeliveryResult> {
  const internalKey = configuredInternalKey(dependencies.internalKey);
  const receiverOrigin = configuredReceiverOrigin(dependencies.receiverOrigin);
  if (!internalKey) {
    return {
      status: "configuration_missing",
      code: "SECURITY_INTERNAL_KEY_MISSING",
      attempts: 0,
      durable: false,
      httpStatus: null,
    };
  }
  if (!receiverOrigin) {
    return {
      status: "configuration_invalid",
      code: "SECURITY_EVENT_RECEIVER_ORIGIN_INVALID",
      attempts: 0,
      durable: false,
      httpStatus: null,
    };
  }

  const receiverUrl = new URL(SECURITY_EVENT_INTERNAL_PATH, `${receiverOrigin}/`).toString();
  const fetchImpl = dependencies.fetchImpl || fetch;
  const sleep = dependencies.sleep || delay;
  const idempotencyKey = (dependencies.createIdempotencyKey || (() => `edge:${randomUUID()}`))();
  const timeoutMs = Math.max(100, Math.min(5_000, dependencies.timeoutMs || SECURITY_EVENT_DELIVERY_TIMEOUT_MS));
  let lastStatus: number | null = null;
  let lastCode = "SECURITY_EVENT_DELIVERY_NETWORK_ERROR";

  for (let attempt = 1; attempt <= SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(receiverUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "x-internal-key": internalKey,
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      lastStatus = response.status;
      const receipt = await readReceipt(response);
      if (receipt?.accepted === true && receipt.durable === true) {
        return {
          status: "delivered",
          code: "SECURITY_EVENT_DURABLY_ACCEPTED",
          attempts: attempt,
          durable: true,
          httpStatus: response.status,
        };
      }
      lastCode = `SECURITY_EVENT_RECEIVER_HTTP_${response.status}`;
      if (!isRetryableStatus(response.status)) {
        return {
          status: "rejected",
          code: lastCode,
          attempts: attempt,
          durable: false,
          httpStatus: response.status,
        };
      }
    } catch (error) {
      lastCode = error instanceof DOMException && error.name === "AbortError"
        ? "SECURITY_EVENT_DELIVERY_TIMEOUT"
        : "SECURITY_EVENT_DELIVERY_NETWORK_ERROR";
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS) {
      await sleep(SECURITY_EVENT_DELIVERY_RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  return {
    status: "retry_exhausted",
    code: lastCode,
    attempts: SECURITY_EVENT_DELIVERY_MAX_ATTEMPTS,
    durable: false,
    httpStatus: lastStatus,
  };
}

export function scheduleSecurityEventDelivery(
  lifecycle: SecurityEventLifecycle | null | undefined,
  payload: SecurityEventProducerPayload,
  dependencies: SecurityEventDeliveryDependencies = {},
): { scheduled: boolean; code: string; completion: Promise<SecurityEventDeliveryResult> | null } {
  if (!lifecycle) {
    console.error("[security-event-producer] delivery was not scheduled", {
      code: "SECURITY_EVENT_LIFECYCLE_MISSING",
      eventType: payload.event_type,
    });
    return { scheduled: false, code: "SECURITY_EVENT_LIFECYCLE_MISSING", completion: null };
  }

  const completion = deliverSecurityEventWithRetry(payload, dependencies).then((result) => {
    if (!result.durable) {
      console.error("[security-event-producer] delivery failed", {
        code: result.code,
        status: result.status,
        attempts: result.attempts,
        httpStatus: result.httpStatus,
        eventType: payload.event_type,
      });
    }
    return result;
  });
  lifecycle.waitUntil(completion);
  return { scheduled: true, code: "SECURITY_EVENT_DELIVERY_SCHEDULED", completion };
}
