import {
  ExternalSiteMonitorError,
  externalSiteMonitorIngestSecret,
  ingestExternalSiteProbe,
  verifyExternalSiteMonitorSignature,
} from "@/lib/server/external-site-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 65_536;
const MIN_INGEST_INTERVAL_MS = 5_000;
const lastAcceptedByKey = new Map<string, number>();

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

function json(body: Record<string, unknown>, status: number, extraHeaders: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extraHeaders } });
}

function contentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) return Number.NaN;
  return Number(value);
}

function pruneAdmission(nowMs: number): void {
  for (const [key, lastAt] of lastAcceptedByKey) {
    if (nowMs - lastAt > 10 * 60_000) lastAcceptedByKey.delete(key);
  }
}

export async function POST(request: Request) {
  const secret = externalSiteMonitorIngestSecret();
  if (!secret) {
    return json({
      accepted: false,
      durable: false,
      code: "EXTERNAL_SITE_MONITOR_INGEST_SECRET_REQUIRED",
      error: "外部站点监测摄取密钥尚未配置",
    }, 503);
  }
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    return json({ accepted: false, durable: false, code: "BROWSER_REQUEST_REJECTED", error: "Forbidden" }, 403);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ accepted: false, durable: false, code: "CONTENT_TYPE_REQUIRED", error: "Unsupported media type" }, 415);
  }
  const declaredLength = contentLength(request.headers.get("content-length"));
  if (declaredLength !== null && (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES)) {
    return json({ accepted: false, durable: false, code: "PAYLOAD_TOO_LARGE", error: "Payload too large" }, 413);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json({ accepted: false, durable: false, code: "PAYLOAD_TOO_LARGE", error: "Payload too large" }, 413);
  }

  try {
    const verified = verifyExternalSiteMonitorSignature({
      secret,
      rawBody,
      timestamp: request.headers.get("x-external-probe-timestamp"),
      nonce: request.headers.get("x-external-probe-nonce"),
      signature: request.headers.get("x-external-probe-signature"),
      keyId: request.headers.get("x-external-probe-key-id"),
    });
    const nowMs = Date.now();
    pruneAdmission(nowMs);
    const lastAcceptedAt = lastAcceptedByKey.get(verified.keyId) || 0;
    if (nowMs - lastAcceptedAt < MIN_INGEST_INTERVAL_MS) {
      const retryAfterSeconds = Math.max(1, Math.ceil((MIN_INGEST_INTERVAL_MS - (nowMs - lastAcceptedAt)) / 1_000));
      return json({
        accepted: false,
        durable: false,
        code: "EXTERNAL_SITE_MONITOR_INGEST_RATE_LIMITED",
        error: "探针摄取频率过高",
      }, 429, { "Retry-After": String(retryAfterSeconds) });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return json({ accepted: false, durable: false, code: "INVALID_JSON", error: "Invalid payload" }, 400);
    }
    const receipt = await ingestExternalSiteProbe({
      payload,
      replayKey: verified.replayKey,
      keyId: verified.keyId,
      nowMs,
    });
    lastAcceptedByKey.set(verified.keyId, nowMs);
    return json({
      accepted: true,
      durable: true,
      externalVantage: true,
      duplicate: receipt.duplicate,
      receipt: {
        probeId: receipt.probeId,
        hostname: receipt.hostname,
        receivedAt: receipt.receivedAt,
      },
    }, receipt.duplicate ? 200 : 201);
  } catch (error) {
    if (error instanceof ExternalSiteMonitorError) {
      return json({
        accepted: false,
        durable: false,
        code: error.code,
        error: error.message,
      }, error.status);
    }
    console.error("[external-site-monitor] signed ingest failed", error);
    return json({
      accepted: false,
      durable: false,
      code: "EXTERNAL_SITE_MONITOR_INGEST_UNAVAILABLE",
      error: "外部站点监测证据暂时无法接收",
    }, 503);
  }
}

export function GET() {
  return json({
    accepted: false,
    durable: false,
    code: "METHOD_NOT_ALLOWED",
    error: "探针摄取仅接受签名 POST",
  }, 405, { Allow: "POST" });
}
