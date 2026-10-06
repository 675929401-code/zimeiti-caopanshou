import {
  parseReliableSecurityEvent,
  parseReliableSecurityIdempotencyKey,
  SecurityEventReliabilityValidationError,
} from "@/lib/security-event-reliability-contracts";
import {
  acceptReliableSecurityEvent,
  SecurityEventReliabilityError,
  securityEventReliabilityErrorStatus,
} from "@/lib/server/security-event-reliability";
import { getServerSecret, safeCompareSecret } from "@/lib/server-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16_384;

function getInternalSecret(): string | null {
  return getServerSecret("SECURITY_INTERNAL_KEY");
}

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[0-9]+$/u.test(value)) return Number.NaN;
  return Number(value);
}

export async function POST(request: Request) {
  try {
    const internalKey = request.headers.get("x-internal-key");
    const expectedKey = getInternalSecret();
    if (!expectedKey || !safeCompareSecret(internalKey, expectedKey)) {
      return jsonResponse({ accepted: false, durable: false, error: "Forbidden" }, 403);
    }

    // This receiver is server-to-server only. Browser fetch metadata is rejected.
    if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
      return jsonResponse({ accepted: false, durable: false, error: "Forbidden" }, 403);
    }

    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return jsonResponse({ accepted: false, durable: false, error: "Unsupported media type" }, 415);
    }

    const contentLength = parseContentLength(request.headers.get("content-length"));
    if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES)) {
      return jsonResponse({ accepted: false, durable: false, error: "Payload too large" }, 413);
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonResponse({ accepted: false, durable: false, error: "Payload too large" }, 413);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      return jsonResponse({ accepted: false, durable: false, error: "Invalid event" }, 400);
    }

    const event = parseReliableSecurityEvent(parsedBody);
    const idempotencyKey = parseReliableSecurityIdempotencyKey(request.headers.get("idempotency-key"));
    const accepted = await acceptReliableSecurityEvent({
      event,
      secret: expectedKey,
      idempotencyKey,
    });

    const duplicate = accepted.enqueue.duplicate === true;
    const receipt = {
      outboxId: accepted.receipt.id,
      eventId: accepted.receipt.materialized_event_id,
      status: accepted.receipt.status,
      observationCount: accepted.receipt.observation_count,
      attemptCount: accepted.receipt.attempt_count,
    };

    if (accepted.materialized) {
      return jsonResponse({
        accepted: true,
        durable: true,
        materialized: true,
        duplicate,
        coverageScope: "receiver_after_authentication",
        receipt,
      }, duplicate ? 200 : 201);
    }

    if (accepted.receipt.status === "dead_letter") {
      return jsonResponse({
        accepted: true,
        durable: true,
        materialized: false,
        retryPending: false,
        deadLettered: true,
        duplicate,
        coverageScope: "receiver_after_authentication",
        receipt,
      }, 503);
    }

    return jsonResponse({
      accepted: true,
      durable: true,
      materialized: false,
      retryPending: true,
      duplicate,
      drainCode: accepted.drainCode,
      coverageScope: "receiver_after_authentication",
      receipt,
    }, 202);
  } catch (error) {
    if (error instanceof SecurityEventReliabilityValidationError) {
      return jsonResponse({
        accepted: false,
        durable: false,
        error: "Invalid event",
        code: error.code,
      }, 400);
    }
    if (error instanceof SecurityEventReliabilityError) {
      console.error("[Security Internal API] reliable intake failed", error.code);
      return jsonResponse({
        accepted: false,
        durable: false,
        error: "Security event unavailable",
        code: error.code,
      }, securityEventReliabilityErrorStatus(error));
    }
    console.error("[Security Internal API] request failed");
    return jsonResponse({
      accepted: false,
      durable: false,
      error: "Internal error",
    }, 500);
  }
}
