/**
 * History card posters are loaded by <img>, which cannot send Authorization.
 * A same-origin thumbnail URL is only usable when it carries media_ticket.
 * Bare /api/video/thumbnail/{id} stays a cookie fallback, chosen by coverFor
 * after ticketed and other safe posters are exhausted.
 */

const THUMBNAIL_PREFIX = "/api/video/thumbnail/";

function parsePoster(candidate: string): URL | null {
  try {
    return new URL(candidate, "http://video-poster.local");
  } catch {
    return null;
  }
}

export function safePoster(value: unknown): string {
  const candidate = String(value ?? "").trim();
  if (!candidate) return "";
  if (candidate.startsWith("blob:") || candidate.startsWith("data:image/")) return candidate;

  const parsed = parsePoster(candidate);
  if (!parsed) return "";

  const sameOriginPath = candidate.startsWith("/") && !candidate.startsWith("//");
  if (sameOriginPath) {
    const thumbnail = parsed.pathname.startsWith(THUMBNAIL_PREFIX);
    if (thumbnail && !parsed.searchParams.get("media_ticket")) return "";
    return candidate;
  }

  return parsed.protocol === "https:" && candidate.startsWith("https:") ? candidate : "";
}

function bareThumbnailFallback(taskId: unknown): string {
  const id = String(taskId ?? "").trim();
  if (!id || /[\\/?#\s]/.test(id) || id.includes("..")) return "";
  return `${THUMBNAIL_PREFIX}${encodeURIComponent(id)}`;
}

export function coverFor(input: {
  localPoster?: unknown;
  posterUrl?: unknown;
  firstFrameUrl?: unknown;
  taskId?: unknown;
  completed?: boolean;
}): string {
  const localPoster = safePoster(input.localPoster);
  if (localPoster) return localPoster;
  const posterUrl = safePoster(input.posterUrl);
  if (posterUrl) return posterUrl;
  const firstFrameUrl = safePoster(input.firstFrameUrl);
  if (firstFrameUrl) return firstFrameUrl;
  return input.completed ? bareThumbnailFallback(input.taskId) : "";
}
