import crypto from "node:crypto";

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);
const ATTEMPT_TIMEOUTS_MS = [8_000, 15_000] as const;

export class BrandAssetIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandAssetIntegrityError";
  }
}

export function verifyBrandAssetBytes(
  bytes: Uint8Array,
  expectedBytes: number,
  expectedSha256: string,
): Buffer {
  const source = Buffer.from(bytes);
  const actualSha256 = crypto.createHash("sha256").update(source).digest("hex");
  if (source.byteLength !== expectedBytes || actualSha256 !== expectedSha256) {
    throw new BrandAssetIntegrityError("BRAND_ASSET_INTEGRITY_MISMATCH");
  }
  return source;
}

/** Buffer a remote object with a hard cap before it can reach the response. */
export async function readVerifiedBrandAssetUpstream(
  response: Response,
  expectedBytes: number,
  expectedSha256: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<Buffer> {
  if (!response.body || expectedBytes < 1 || expectedBytes > maxBytes) {
    throw new BrandAssetIntegrityError("BRAND_ASSET_SIZE_INVALID");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength != null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength !== expectedBytes || parsedLength > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new BrandAssetIntegrityError("BRAND_ASSET_LENGTH_MISMATCH");
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes || total > expectedBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BrandAssetIntegrityError("BRAND_ASSET_SIZE_LIMIT_EXCEEDED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return verifyBrandAssetBytes(Buffer.concat(chunks, total), expectedBytes, expectedSha256);
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

/**
 * Brand assets are immutable and integrity-checked by their callers. Retrying
 * one transient object-store read avoids turning a brief network reset into a
 * broken logo without weakening the published-asset or sha256 contracts.
 */
export async function fetchBrandAssetUpstream(signedUrl: string): Promise<Response> {
  let lastError: unknown;

  for (let index = 0; index < ATTEMPT_TIMEOUTS_MS.length; index += 1) {
    try {
      const response = await fetch(signedUrl, {
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUTS_MS[index]),
      });
      const hasRetry = index + 1 < ATTEMPT_TIMEOUTS_MS.length;
      if (!hasRetry || !isRetryableStatus(response.status)) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (index + 1 >= ATTEMPT_TIMEOUTS_MS.length) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("BRAND_ASSET_UPSTREAM_UNAVAILABLE");
}
