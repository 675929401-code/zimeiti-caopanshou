export type DeliverableExtractVideo = {
  success?: boolean;
  asset_id?: string;
  temporary_url?: string;
  temporary_expires_at?: number;
  url?: string;
  download_url?: string;
};

const LOCAL_VIDEO_FILE_PATTERN = /^[a-f\d]{24}$/u;
const LOCAL_VIDEO_SIGNATURE_PATTERN = /^[a-f\d]{64}$/iu;
const MAX_TEMPORARY_VIDEO_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Parse only the relative, owner-bound temporary URL emitted by this app.
 * This validates its public shape; the media route still performs the HMAC check.
 */
export function signedTemporaryExtractVideoExpiry(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith("/api/extract/local-video?")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, "http://extract.local");
  } catch {
    return null;
  }
  if (
    parsed.origin !== "http://extract.local"
    || parsed.pathname !== "/api/extract/local-video"
    || parsed.hash
  ) return null;
  const allowedKeys = new Set(["file", "owner", "expires", "sig"]);
  if ([...parsed.searchParams.keys()].some(key => !allowedKeys.has(key))) return null;
  if ([...allowedKeys].some(key => parsed.searchParams.getAll(key).length !== 1)) return null;
  const file = parsed.searchParams.get("file") || "";
  const owner = parsed.searchParams.get("owner") || "";
  const expiresValue = parsed.searchParams.get("expires") || "";
  const signature = parsed.searchParams.get("sig") || "";
  if (
    !LOCAL_VIDEO_FILE_PATTERN.test(file)
    || !owner.trim()
    || owner.length > 160
    || !/^\d{13}$/u.test(expiresValue)
    || !LOCAL_VIDEO_SIGNATURE_PATTERN.test(signature)
  ) return null;
  const expires = Number(expiresValue);
  return Number.isSafeInteger(expires) ? expires : null;
}

export function temporaryExtractVideoExpiresAt(
  video: DeliverableExtractVideo | null | undefined,
): number | null {
  const signedExpiry = signedTemporaryExtractVideoExpiry(video?.temporary_url);
  const declaredExpiry = Number(video?.temporary_expires_at);
  if (!signedExpiry || !Number.isSafeInteger(declaredExpiry) || declaredExpiry <= 0) return null;
  return Math.min(signedExpiry, declaredExpiry);
}

export function isActiveTemporaryExtractVideo(
  video: DeliverableExtractVideo | null | undefined,
  now = Date.now(),
): boolean {
  const expiresAt = temporaryExtractVideoExpiresAt(video);
  return Boolean(
    expiresAt
    && expiresAt > now
    && expiresAt - now <= MAX_TEMPORARY_VIDEO_LIFETIME_MS,
  );
}

/**
 * Production extraction delivers either an owned permanent asset (legacy
 * records) or a signed 30-minute temporary file. Supplier URLs remain private.
 */
export function isDeliverableExtractVideo(
  video: DeliverableExtractVideo | null | undefined,
  now = Date.now(),
) {
  return Boolean(
    video
    && video.success !== false
    && ((typeof video.asset_id === "string" && Boolean(video.asset_id.trim())) || isActiveTemporaryExtractVideo(video, now)),
  );
}
