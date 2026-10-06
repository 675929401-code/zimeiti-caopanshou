import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 512;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_WINDOW = 5;
const GLOBAL_REPORTS_PER_WINDOW = 100;
const MAX_RATE_BUCKETS = 1_024;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

interface RateBucket {
  count: number;
  resetAt: number;
}

interface ClientErrorPayload {
  source: "app_error_boundary";
  kind: "render_error";
  digest?: string;
}

const clientBuckets = new Map<string, RateBucket>();
let globalBucket: RateBucket = { count: 0, resetAt: 0 };

function jsonResponse(body: Record<string, unknown>, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin, Sec-Fetch-Site",
      ...headers,
    },
  });
}

function isSameOriginBrowserRequest(request: NextRequest): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;

  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = forwardedProtocol || request.nextUrl.protocol.slice(0, -1);
  if (protocol !== "http" && protocol !== "https") return false;

  try {
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[0-9]+$/u.test(value)) return Number.NaN;
  return Number(value);
}

function parsePayload(value: unknown): ClientErrorPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["source", "kind", "digest"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return null;
  if (record.source !== "app_error_boundary" || record.kind !== "render_error") return null;

  if (record.digest !== undefined) {
    if (typeof record.digest !== "string" || !DIGEST_PATTERN.test(record.digest)) return null;
    return { source: "app_error_boundary", kind: "render_error", digest: record.digest };
  }

  return { source: "app_error_boundary", kind: "render_error" };
}

function getClientKey(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const address = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || forwardedFor
    || "unknown";
  return createHash("sha256").update(address.slice(0, 128)).digest("hex").slice(0, 32);
}

function resetBucketIfExpired(bucket: RateBucket, now: number): void {
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
}

function consumeRateLimit(clientKey: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
  resetBucketIfExpired(globalBucket, now);
  if (globalBucket.count >= GLOBAL_REPORTS_PER_WINDOW) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((globalBucket.resetAt - now) / 1_000)) };
  }

  for (const [key, bucket] of clientBuckets) {
    if (bucket.resetAt <= now) clientBuckets.delete(key);
  }
  if (clientBuckets.size >= MAX_RATE_BUCKETS && !clientBuckets.has(clientKey)) {
    const oldestKey = clientBuckets.keys().next().value as string | undefined;
    if (oldestKey) clientBuckets.delete(oldestKey);
  }

  const bucket = clientBuckets.get(clientKey) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  resetBucketIfExpired(bucket, now);
  clientBuckets.set(clientKey, bucket);

  if (bucket.count >= MAX_REPORTS_PER_WINDOW) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)) };
  }

  bucket.count += 1;
  globalBucket.count += 1;
  return { allowed: true, retryAfter: 0 };
}

export async function POST(request: NextRequest) {
  if (!isSameOriginBrowserRequest(request)) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }
  if (request.headers.has("authorization") || request.headers.has("cookie")) {
    return jsonResponse({ error: "Credentials are not accepted" }, 403);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return jsonResponse({ error: "Unsupported media type" }, 415);
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES)) {
    return jsonResponse({ error: "Payload too large" }, 413);
  }

  const clientKey = getClientKey(request);
  const limit = consumeRateLimit(clientKey);
  if (!limit.allowed) {
    return jsonResponse(
      { error: "Too many reports" },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: "Payload too large" }, 413);
    }

    const payload = parsePayload(JSON.parse(rawBody) as unknown);
    if (!payload) {
      return jsonResponse({ error: "Invalid report" }, 400);
    }

    // Keep anonymous diagnostics outside the authoritative security_events table.
    // The schema accepts fixed enums plus one bounded alphanumeric digest only.
    console.warn("[ClientErrorTelemetry]", payload);
    return jsonResponse({ accepted: true }, 202);
  } catch {
    return jsonResponse({ error: "Invalid report" }, 400);
  }
}
