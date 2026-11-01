import { createHash, createHmac } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { authorizeToken, getJwtSecretString, getTokenFromHeaders } from "@/lib/auth";
import { readFlightRuntimeIdentity } from "@/lib/operation-flight-recorder";
import {
  PRODUCT_USAGE_MAX_EVENTS_PER_MINUTE,
  PRODUCT_USAGE_MAX_REQUEST_BYTES,
  PRODUCT_USAGE_MAX_REQUESTS_PER_MINUTE,
  productUsageEventBatchSchema,
  type ProductUsageBrowserEvent,
} from "@/lib/product-usage-contract";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const RATE_WINDOW_MS = 60_000;
const EVENT_RETENTION_DAYS = 180;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Authorization, Cookie, Origin",
  "X-Content-Type-Options": "nosniff",
};

interface IngestRateBucket {
  requestCount: number;
  eventCount: number;
  resetAtMs: number;
  touchedAtMs: number;
}

declare global {
  var __agentHubProductUsageIngestRateBucketsV1: Map<string, IngestRateBucket> | undefined;
}

function rateBuckets(): Map<string, IngestRateBucket> {
  if (!globalThis.__agentHubProductUsageIngestRateBucketsV1) {
    globalThis.__agentHubProductUsageIngestRateBucketsV1 = new Map();
  }
  return globalThis.__agentHubProductUsageIngestRateBucketsV1;
}

function consumeRateLimit(userId: string, eventCount: number, nowMs = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  const buckets = rateBuckets();
  if (buckets.size > 10_000) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAtMs <= nowMs || nowMs - bucket.touchedAtMs > 10 * RATE_WINDOW_MS) buckets.delete(key);
      if (buckets.size <= 8_000) break;
    }
  }
  const key = createHash("sha256").update(userId).digest("hex");
  const current = buckets.get(key);
  const bucket = !current || current.resetAtMs <= nowMs
    ? { requestCount: 0, eventCount: 0, resetAtMs: nowMs + RATE_WINDOW_MS, touchedAtMs: nowMs }
    : current;
  bucket.touchedAtMs = nowMs;
  buckets.set(key, bucket);
  const allowed = bucket.requestCount + 1 <= PRODUCT_USAGE_MAX_REQUESTS_PER_MINUTE
    && bucket.eventCount + eventCount <= PRODUCT_USAGE_MAX_EVENTS_PER_MINUTE;
  if (allowed) {
    bucket.requestCount += 1;
    bucket.eventCount += eventCount;
  }
  return {
    allowed,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1_000)),
  };
}

function noStore(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(key, value);
  return response;
}

function parsedConfiguredOrigin(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function parsedRequestOrigin(value: string | null): URL | null {
  const parsed = parsedConfiguredOrigin(value);
  return parsed && parsed.origin === value ? parsed : null;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function sameLoopbackOrigin(left: URL, right: URL): boolean {
  return isLoopbackHostname(left.hostname)
    && isLoopbackHostname(right.hostname)
    && left.protocol === right.protocol
    && effectivePort(left) === effectivePort(right);
}

function sameOrigin(request: NextRequest): boolean {
  const suppliedOrigin = parsedRequestOrigin(request.headers.get("origin"));
  if (!suppliedOrigin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  const allowedOrigins = [
    request.nextUrl.origin,
    process.env.BASE_URL,
    process.env.PRODUCTION_SITE_URL,
  ]
    .map((value) => parsedConfiguredOrigin(value))
    .filter((value): value is URL => value !== null);

  return allowedOrigins.some((allowedOrigin) => (
    suppliedOrigin.origin === allowedOrigin.origin
    || sameLoopbackOrigin(suppliedOrigin, allowedOrigin)
  ));
}

function safeClientOccurredAt(value: string | undefined, nowMs: number): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < nowMs - 24 * 60 * 60 * 1_000 || parsed > nowMs + 5 * 60 * 1_000) {
    return new Date(nowMs).toISOString();
  }
  return new Date(parsed).toISOString();
}

function keyedHash(secret: string, scope: string, userId: string, value: string): string {
  return createHmac("sha256", secret).update(`${scope}:v1|${userId}|${value}`).digest("hex");
}

function configuredCollectionPolicy(): { policyBasisCode: string; noticeVersion: string } | null {
  const policyBasisCode = process.env.PRODUCT_USAGE_POLICY_BASIS_CODE?.trim() || "";
  const noticeVersion = process.env.PRODUCT_USAGE_NOTICE_VERSION?.trim() || "";
  if (!/^[A-Za-z0-9._:-]{3,80}$/u.test(policyBasisCode) || !/^[A-Za-z0-9._:-]{3,64}$/u.test(noticeVersion)) {
    return null;
  }
  return { policyBasisCode, noticeVersion };
}

export async function GET() {
  return noStore(NextResponse.json({ collectionEnabled: configuredCollectionPolicy() !== null }));
}

function persistenceRows(events: ProductUsageBrowserEvent[], userId: string, nowMs: number): Record<string, unknown>[] {
  const secret = getJwtSecretString();
  const policy = configuredCollectionPolicy();
  if (!policy) throw new Error("PRODUCT_USAGE_POLICY_NOT_CONFIGURED");
  const { policyBasisCode, noticeVersion } = policy;
  const runtimeIdentity = readFlightRuntimeIdentity();
  const retainedUntil = new Date(nowMs + EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const receivedAt = new Date(nowMs).toISOString();
  return events.map((event) => ({
    id: event.id,
    user_id: userId,
    session_hmac: keyedHash(secret, "product-usage-session", userId, event.session_id),
    event_type: event.event_type,
    feature_key: event.feature_key,
    page_key: event.page_key ?? null,
    journey_hmac: event.journey_id ? keyedHash(secret, "product-usage-journey", userId, event.journey_id) : null,
    milestone_key: event.milestone_key ?? null,
    entry_point: event.entry_point ?? null,
    outcome_reason_code: event.outcome_reason_code ?? null,
    duration_ms: event.duration_ms ?? null,
    step_number: event.step_number ?? null,
    client_sequence: event.client_sequence ?? null,
    client_occurred_at: safeClientOccurredAt(event.occurred_at, nowMs),
    occurred_at: receivedAt,
    capture_source: "browser",
    purpose_code: "product_improvement",
    policy_basis_code: policyBasisCode,
    notice_version: noticeVersion,
    source_version: runtimeIdentity.sourceVersion,
    build_id: runtimeIdentity.buildId,
    retained_until: retainedUntil,
  }));
}

function storageErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === "PRODUCT_USAGE_POLICY_NOT_CONFIGURED") {
    return "PRODUCT_USAGE_POLICY_NOT_CONFIGURED";
  }
  if (!error || typeof error !== "object") return "PRODUCT_USAGE_PERSIST_FAILED";
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  if (code === "PGRST205" || code === "42P01") return "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED";
  return code ? `PRODUCT_USAGE_PERSIST_FAILED:${code}` : "PRODUCT_USAGE_PERSIST_FAILED";
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    return noStore(NextResponse.json({
      ok: false,
      code: "PRODUCT_USAGE_SAME_ORIGIN_REQUIRED",
      error: "产品使用事件只接受同源页面上报",
    }, { status: 403 }));
  }

  const token = getTokenFromHeaders(request.headers);
  if (!token) return noStore(NextResponse.json({ ok: false, code: "UNAUTHENTICATED", error: "未授权" }, { status: 401 }));
  const authorization = await authorizeToken(token);
  if (!authorization.ok) {
    return noStore(NextResponse.json({ ok: false, code: authorization.code, error: authorization.error }, { status: authorization.status }));
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return noStore(NextResponse.json({ ok: false, code: "PRODUCT_USAGE_JSON_REQUIRED", error: "仅接受 JSON" }, { status: 415 }));
  }
  const declaredBytes = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > PRODUCT_USAGE_MAX_REQUEST_BYTES) {
    return noStore(NextResponse.json({ ok: false, code: "PRODUCT_USAGE_BODY_TOO_LARGE", error: "请求体过大" }, { status: 413 }));
  }

  const raw = await request.text().catch(() => "");
  if (new TextEncoder().encode(raw).byteLength > PRODUCT_USAGE_MAX_REQUEST_BYTES) {
    return noStore(NextResponse.json({ ok: false, code: "PRODUCT_USAGE_BODY_TOO_LARGE", error: "请求体过大" }, { status: 413 }));
  }
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    return noStore(NextResponse.json({ ok: false, code: "PRODUCT_USAGE_EVENT_INVALID", error: "产品使用事件格式无效" }, { status: 400 }));
  }
  const parsed = productUsageEventBatchSchema.safeParse(input);
  if (!parsed.success) {
    return noStore(NextResponse.json({ ok: false, code: "PRODUCT_USAGE_EVENT_INVALID", error: "产品使用事件格式无效" }, { status: 400 }));
  }
  const uniqueIds = new Set(parsed.data.events.map((event) => event.id));
  if (uniqueIds.size !== parsed.data.events.length) {
    return noStore(NextResponse.json({ ok: false, code: "PRODUCT_USAGE_BATCH_DUPLICATE_ID", error: "同一批事件包含重复标识" }, { status: 400 }));
  }

  const admission = consumeRateLimit(authorization.actor.userId, parsed.data.events.length);
  if (!admission.allowed) {
    return noStore(NextResponse.json({
      ok: false,
      code: "PRODUCT_USAGE_INGEST_RATE_LIMITED",
      error: "产品事件上报过于频繁",
      retryAfterSeconds: admission.retryAfterSeconds,
      rateLimit: {
        windowMs: RATE_WINDOW_MS,
        maximumRequests: PRODUCT_USAGE_MAX_REQUESTS_PER_MINUTE,
        maximumEvents: PRODUCT_USAGE_MAX_EVENTS_PER_MINUTE,
      },
    }, {
      status: 429,
      headers: { "Retry-After": String(admission.retryAfterSeconds) },
    }));
  }

  try {
    const rows = persistenceRows(parsed.data.events, authorization.actor.userId, Date.now());
    const { error } = await getSupabaseAdminClient()
      .from("product_usage_events")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (error) {
      const code = storageErrorCode(error);
      const storageMissing = code === "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED";
      return noStore(NextResponse.json({
        ok: false,
        code,
        error: storageMissing ? "产品使用事件耐久表尚未部署" : "产品使用事件暂时无法保存",
        receivedCount: 0,
        migrationApplied: false,
      }, { status: storageMissing ? 503 : 500 }));
    }
    return noStore(NextResponse.json({
      ok: true,
      code: "PRODUCT_USAGE_ACCEPTED",
      receivedCount: parsed.data.events.length,
      persistence: "product_usage_events",
      dedupePolicy: "database_primary_key_ignore_duplicate",
      privacy: {
        userIdServerAttributed: true,
        rawSessionStored: false,
        promptOrContentAccepted: false,
        materialUrlAccepted: false,
        emailAccepted: false,
        ipStored: false,
        userAgentStored: false,
      },
    }, { status: 202 }));
  } catch (error) {
    const code = storageErrorCode(error);
    const policyMissing = code === "PRODUCT_USAGE_POLICY_NOT_CONFIGURED";
    return noStore(NextResponse.json({
      ok: false,
      code,
      error: policyMissing
        ? "产品分析政策依据与通知版本尚未配置，未采集任何事件"
        : code === "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED"
          ? "产品使用事件耐久表尚未部署"
          : "产品使用事件暂时无法保存",
      receivedCount: 0,
      migrationApplied: false,
    }, { status: policyMissing || code === "PRODUCT_USAGE_STORAGE_NOT_DEPLOYED" ? 503 : 500 }));
  }
}
