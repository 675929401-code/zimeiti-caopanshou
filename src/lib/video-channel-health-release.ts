export const VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION = "video-channel-health.v2";

export type ReleaseVideoChannelHealthRow = {
  channel_id?: unknown;
  is_healthy?: unknown;
  last_success_at?: unknown;
  health_protocol_version?: unknown;
  verification_state?: unknown;
  verified_at?: unknown;
  verification_evidence?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Release activation requires evidence from the current health protocol. A
 * legacy boolean or a backfilled row is intentionally insufficient.
 */
export function isReleaseVerifiedVideoChannelHealth(
  row: ReleaseVideoChannelHealthRow | null | undefined,
): boolean {
  if (!row || row.is_healthy !== true) return false;
  if (row.health_protocol_version !== VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION) return false;
  if (row.verification_state !== "verified") return false;
  if (typeof row.last_success_at !== "string" || !Number.isFinite(Date.parse(row.last_success_at))) return false;
  if (typeof row.verified_at !== "string" || !Number.isFinite(Date.parse(row.verified_at))) return false;
  if (Date.parse(row.verified_at) < Date.parse(row.last_success_at)) return false;
  if (!isRecord(row.verification_evidence)) return false;
  const evidenceId = String(row.verification_evidence.evidence_id || "").trim();
  const taskId = String(row.verification_evidence.task_id || "").trim();
  return evidenceId.length >= 8 && taskId.length >= 8;
}
