import type { AnnouncementRecord } from "@/lib/announcement-domain";

export interface AnnouncementDisplayReceipt {
  impressions: number;
  lastImpressionAt: string | null;
}

export type AnnouncementDisplayLedger = Record<string, AnnouncementDisplayReceipt>;

export type AnnouncementAutoDisplayDecision =
  | { eligible: true; reason: "eligible" }
  | { eligible: false; reason: "max_impressions" | "frequency_window" };

export function announcementDeliveryKey(
  announcement: Pick<AnnouncementRecord, "id" | "push_revision">,
): string {
  return `${announcement.id}:${Math.max(0, Math.trunc(announcement.push_revision || 0))}`;
}

function normalizedReceipt(value: unknown): AnnouncementDisplayReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const impressions = Number(candidate.impressions);
  const lastImpressionAt = typeof candidate.lastImpressionAt === "string"
    && Number.isFinite(new Date(candidate.lastImpressionAt).getTime())
    ? candidate.lastImpressionAt
    : null;
  if (!Number.isSafeInteger(impressions) || impressions < 0) return null;
  return { impressions, lastImpressionAt };
}

export function normalizeAnnouncementDisplayLedger(value: unknown): AnnouncementDisplayLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const ledger: AnnouncementDisplayLedger = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>).slice(-500)) {
    if (!key || key.length > 300) continue;
    const receipt = normalizedReceipt(candidate);
    if (receipt) ledger[key] = receipt;
  }
  return ledger;
}

/**
 * max_impressions=0 means unlimited. A required acknowledgement still obeys
 * frequency and impression limits, but once its dialog is visible it cannot be
 * dismissed until the account read receipt succeeds.
 */
export function announcementAutoDisplayDecision(
  announcement: Pick<AnnouncementRecord, "id" | "push_revision" | "frequency_hours" | "max_impressions">,
  ledger: AnnouncementDisplayLedger,
  now = new Date(),
): AnnouncementAutoDisplayDecision {
  const receipt = ledger[announcementDeliveryKey(announcement)];
  if (!receipt) return { eligible: true, reason: "eligible" };

  const maximum = Math.max(0, Math.trunc(announcement.max_impressions || 0));
  if (maximum > 0 && receipt.impressions >= maximum) {
    return { eligible: false, reason: "max_impressions" };
  }

  const lastMs = receipt.lastImpressionAt ? new Date(receipt.lastImpressionAt).getTime() : Number.NaN;
  const frequencyMs = Math.max(1, Math.trunc(announcement.frequency_hours || 1)) * 60 * 60 * 1000;
  if (Number.isFinite(lastMs) && now.getTime() - lastMs < frequencyMs) {
    return { eligible: false, reason: "frequency_window" };
  }
  return { eligible: true, reason: "eligible" };
}

export function recordAnnouncementImpression(
  announcement: Pick<AnnouncementRecord, "id" | "push_revision">,
  ledger: AnnouncementDisplayLedger,
  at = new Date(),
): AnnouncementDisplayLedger {
  const key = announcementDeliveryKey(announcement);
  const previous = ledger[key] || { impressions: 0, lastImpressionAt: null };
  return {
    ...ledger,
    [key]: {
      impressions: previous.impressions + 1,
      lastImpressionAt: at.toISOString(),
    },
  };
}
