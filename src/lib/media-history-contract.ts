export const MEDIA_HISTORY_CATEGORY_KEYS = [
  "image-workbench",
  "video-production",
  "storyboard-workbench",
  "cover-studio",
  "digital-human",
  "short-drama",
  "free-canvas",
  "agent-output",
  "commerce-agent",
  "other-tools",
] as const;

export type MediaHistoryCategoryKey = typeof MEDIA_HISTORY_CATEGORY_KEYS[number];
export type MediaHistoryKind = "image" | "video";
export type MediaHistoryStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export type MediaHistoryRetentionSource = "upstream" | "policy" | "none";

export const MEDIA_HISTORY_FALLBACK_DAYS: Readonly<Record<MediaHistoryKind, number | null>> = {
  image: null,
  video: null,
};

const TERMINAL_MEDIA_STATUSES = new Set<MediaHistoryStatus>(["completed", "failed", "cancelled"]);
const MEDIA_HISTORY_PROJECT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export function mediaHistoryProjectUuid(value: unknown): string | null {
  const candidate = String(value || "").trim();
  return MEDIA_HISTORY_PROJECT_UUID.test(candidate) ? candidate : null;
}

function validIsoTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * Only provider/upstream expiry metadata is accepted here. Platform object-store
 * lifecycle targets are deliberately excluded because they do not prove that an
 * upstream URL remains deliverable until that timestamp.
 */
export function upstreamMediaExpiry(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const row = metadata as Record<string, unknown>;
  for (const key of ["upstreamExpiresAt", "providerExpiresAt", "sourceExpiresAt", "expiresAt", "expires_at"]) {
    const parsed = validIsoTime(row[key]);
    if (parsed) return parsed;
  }
  return null;
}

export function resolveMediaHistoryRetention(input: {
  kind: MediaHistoryKind;
  status: MediaHistoryStatus;
  createdAt: string;
  completedAt?: string | null;
  upstreamExpiresAt?: string | null;
  sourceExpiredAt?: string | null;
  now?: number;
}): { expiresAt: string | null; retentionSource: MediaHistoryRetentionSource; expired: boolean } {
  if (!TERMINAL_MEDIA_STATUSES.has(input.status)) {
    return { expiresAt: null, retentionSource: "none", expired: false };
  }

  if (validIsoTime(input.sourceExpiredAt)) {
    return { expiresAt: validIsoTime(input.upstreamExpiresAt), retentionSource: "upstream", expired: true };
  }
  const upstreamExpiry = validIsoTime(input.upstreamExpiresAt);
  if (upstreamExpiry) {
    return {
      expiresAt: upstreamExpiry,
      retentionSource: "upstream",
      // An advertised URL deadline schedules a check; it is not evidence that
      // the provider actually removed the source.
      expired: Boolean(validIsoTime(input.sourceExpiredAt)),
    };
  }

  const anchor = validIsoTime(input.completedAt) || validIsoTime(input.createdAt);
  if (!anchor) return { expiresAt: null, retentionSource: "none", expired: false };
  const fallbackDays = MEDIA_HISTORY_FALLBACK_DAYS[input.kind];
  if (fallbackDays === null) {
    return { expiresAt: null, retentionSource: "none", expired: false };
  }
  const expiresAt = new Date(
    Date.parse(anchor) + fallbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  return {
    expiresAt,
    retentionSource: "policy",
    expired: Date.parse(expiresAt) <= (input.now ?? Date.now()),
  };
}

export function mediaHistoryCategoryFromImageSurface(input: {
  surface?: string | null;
  cover?: boolean;
  agentId?: string | null;
}): MediaHistoryCategoryKey {
  if (input.cover || input.surface === "cover-studio") return "cover-studio";
  if (input.surface === "storyboard-workbench") return "storyboard-workbench";
  if (input.surface === "short-drama-film-studio") return "short-drama";
  if (input.surface === "free-canvas") return "free-canvas";
  if (input.surface === "image-workbench" || input.agentId === "image-workbench") return "image-workbench";
  return "agent-output";
}

export function mediaHistoryCategoryFromVideoSource(input: {
  digitalHuman?: boolean;
  storyboard?: boolean;
  shortDrama?: boolean;
  batchId?: string | null;
}): MediaHistoryCategoryKey {
  if (input.digitalHuman) return "digital-human";
  if (input.shortDrama) return "short-drama";
  if (input.storyboard) return "storyboard-workbench";
  if (String(input.batchId || "").trim() === "manual-workflow") return "free-canvas";
  return "video-production";
}
