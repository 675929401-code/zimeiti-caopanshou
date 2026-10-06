import { repairLikelyMojibake } from '@/lib/display-normalization';

export const ADMIN_ACTIVITY_LOG_COLUMNS = 'id,level,source,message,created_at,auto_fixed';

/** Only accept the existing decoder when the original Latin1 bytes round-trip exactly. */
export function normalizeActivityDisplayText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const repaired = repairLikelyMojibake(value);
  if (repaired === value || repaired.includes('\uFFFD')) return value;
  const originalBytes = Array.from(new TextEncoder().encode(repaired), byte => String.fromCharCode(byte)).join('');
  // Existing Chinese, emoji, malformed byte sequences and mixed encodings stay intact.
  return originalBytes === value ? repaired : value;
}

export function normalizeAdminActivityLog(row: Record<string, unknown>) {
  return {
    id: row.id,
    level: row.level,
    source: normalizeActivityDisplayText(row.source),
    message: normalizeActivityDisplayText(row.message),
    created_at: row.created_at,
    auto_fixed: row.auto_fixed,
  };
}

export function adminActivityLogLimit(value: string | null): number {
  if (value == null || !/^\d+$/u.test(value)) return 50;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 50;
}
