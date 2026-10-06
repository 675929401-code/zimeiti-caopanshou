import { createHmac, timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { SLO_METRIC_CAPTURE_MIN_INTERVAL_MS } from "@/lib/slo-metric-registry";
import {
  persistSloMetricSnapshot,
  readSloMetricRegistrySnapshot,
} from "@/lib/server/slo-metric-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};
const MAX_BODY_BYTES = 2 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1_000;
let lastAcceptedAt = 0;
const acceptedKeys = new Map<string, number>();

function json(body: unknown, status = 200, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...headers } });
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validateRequestKey(value: string | null): string | null {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/u.test(candidate) ? candidate : null;
}

function validateSignature(input: {
  rawBody: string;
  requestKey: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  secret: string;
}): boolean {
  const timestamp = Number(input.timestampHeader);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const supplied = String(input.signatureHeader || "").trim().replace(/^sha256=/u, "").toLowerCase();
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}\n${input.requestKey}\n${input.rawBody}`)
    .digest("hex");
  return safeEqualHex(supplied, expected);
}

function captureRateLimit(requestKey: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  for (const [key, acceptedAt] of acceptedKeys) {
    if (acceptedAt + IDEMPOTENCY_TTL_MS < now) acceptedKeys.delete(key);
  }
  if (acceptedKeys.has(requestKey)) return { allowed: true, retryAfterSeconds: 0 };
  const remainingMs = Math.max(0, lastAcceptedAt + SLO_METRIC_CAPTURE_MIN_INTERVAL_MS - now);
  if (remainingMs > 0) return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1_000) };
  acceptedKeys.set(requestKey, now);
  lastAcceptedAt = now;
  return { allowed: true, retryAfterSeconds: 0 };
}

// This endpoint is intentionally service-authenticated. Browser/admin cookies
// are insufficient: an independent scheduler must sign timestamp + idempotency
// key + exact request body with SLO_METRIC_CAPTURE_SECRET.
export async function POST(request: NextRequest) {
  if (process.env.SLO_METRIC_CAPTURE_ENABLED !== "1") {
    return json({
      ok: false,
      code: "SLO_METRIC_CAPTURE_DISABLED",
      error: "指标历史采集未启用",
      historyPersistence: "unavailable",
    }, 503);
  }
  const secret = String(process.env.SLO_METRIC_CAPTURE_SECRET || "");
  if (secret.length < 32) {
    return json({
      ok: false,
      code: "SLO_METRIC_CAPTURE_SECRET_UNAVAILABLE",
      error: "指标历史采集服务身份未配置",
      historyPersistence: "unavailable",
    }, 503);
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, code: "SLO_METRIC_CAPTURE_BODY_TOO_LARGE", error: "请求体超过 2KB" }, 413);
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json({ ok: false, code: "SLO_METRIC_CAPTURE_BODY_TOO_LARGE", error: "请求体超过 2KB" }, 413);
  }
  const requestKey = validateRequestKey(request.headers.get("idempotency-key"));
  if (!requestKey) {
    return json({ ok: false, code: "SLO_METRIC_CAPTURE_KEY_INVALID", error: "缺少合法幂等键" }, 400);
  }
  if (!validateSignature({
    rawBody,
    requestKey,
    timestampHeader: request.headers.get("x-slo-capture-timestamp"),
    signatureHeader: request.headers.get("x-slo-capture-signature"),
    secret,
  })) {
    return json({ ok: false, code: "SLO_METRIC_CAPTURE_UNAUTHORIZED", error: "采集服务签名无效或已过期" }, 401);
  }

  const rateLimit = captureRateLimit(requestKey);
  if (!rateLimit.allowed) {
    return json({
      ok: false,
      code: "SLO_METRIC_CAPTURE_RATE_LIMITED",
      error: "采集频率超过最低间隔",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    }, 429, { "Retry-After": String(Math.max(1, rateLimit.retryAfterSeconds)) });
  }

  let body: UnknownRecord;
  try {
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : {};
  } catch {
    return json({ ok: false, code: "SLO_METRIC_CAPTURE_BODY_INVALID", error: "请求体不是有效 JSON" }, 400);
  }
  const requestedHours = Number(body.windowHours);
  const windowHours = Number.isFinite(requestedHours)
    ? Math.min(24 * 7, Math.max(1, Math.round(requestedHours)))
    : 24;

  try {
    const snapshot = await readSloMetricRegistrySnapshot({
      windowHours,
      historyPoints: 0,
      bypassCache: true,
    });
    const result = await persistSloMetricSnapshot({
      requestKey,
      actor: "service:slo-metric-capture",
      snapshot,
    });
    return json({
      ok: true,
      requestKey,
      capturedAt: snapshot.asOf,
      registryVersion: snapshot.registryVersion,
      metricCount: snapshot.metrics.length,
      availability: {
        available: snapshot.summary.available,
        partial: snapshot.summary.partial,
        unavailable: snapshot.summary.unavailable,
      },
      result,
      providerCalls: 0,
      businessWrites: 0,
      operationalWrites: 1,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
    return json({
      ok: false,
      code: code || "SLO_METRIC_CAPTURE_FAILED",
      error: code === "HISTORY_MIGRATION_NOT_APPLIED"
        ? "指标历史设计迁移尚未应用，采集保持不可用"
        : "指标历史采集失败",
      historyPersistence: "unavailable",
      providerCalls: 0,
      businessWrites: 0,
      operationalWrites: 0,
    }, 503);
  }
}

type UnknownRecord = Record<string, unknown>;
