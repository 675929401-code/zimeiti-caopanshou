import { repairLikelyMojibake } from "@/lib/display-normalization";

export interface SecurityEventDisplayOptions {
  fallback?: string;
  maxLength?: number;
}

const DEFAULT_FALLBACK = "无法识别";
const DEFAULT_MAX_LENGTH = 240;
const MAX_ALLOWED_LENGTH = 2_000;

const CONTROL_OR_REPLACEMENT_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/u;
const HIGH_CONFIDENCE_MOJIBAKE_RE = /(?:Ã.|Â.|â(?:€|€™|€œ|€�)|ï¼|ã€|[åæçèä][\u0080-\u00ff])/u;

function boundedLength(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_ALLOWED_LENGTH, Math.max(1, Math.trunc(parsed)));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength === 1) return "…";
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function isIrrecoverable(value: string): boolean {
  if (!value) return true;
  if (/\?{3,}/u.test(value)) return true;
  if (CONTROL_OR_REPLACEMENT_RE.test(value)) return true;
  return HIGH_CONFIDENCE_MOJIBAKE_RE.test(value);
}

/**
 * Normalize historical security labels at the read boundary.
 *
 * The two-pass ceiling repairs the known single/double UTF-8-as-latin1 failures
 * without repeatedly guessing at legitimate accented text. Persisted audit rows
 * remain unchanged.
 */
export function normalizeSecurityEventDisplayText(
  value: unknown,
  options: SecurityEventDisplayOptions = {},
): string {
  const fallback = options.fallback === undefined
    ? DEFAULT_FALLBACK
    : String(options.fallback).trim();
  const maxLength = boundedLength(options.maxLength, DEFAULT_MAX_LENGTH);

  if (value == null) return truncate(fallback, maxLength);
  let normalized = String(value).replace(/\s+/gu, " ").trim();
  if (!normalized) return truncate(fallback, maxLength);

  for (let pass = 0; pass < 2; pass += 1) {
    const repaired = repairLikelyMojibake(normalized);
    if (!repaired || repaired === normalized) break;
    normalized = repaired.replace(/\s+/gu, " ").trim();
  }

  if (isIrrecoverable(normalized)) return truncate(fallback, maxLength);
  return truncate(normalized, maxLength);
}

export function maskSecurityPhone(value: unknown): string {
  const original = String(value ?? "").trim();
  if (!original) return "";

  const compact = original.replace(/[\s()-]/gu, "");
  if (/^\+?86\d{11}$/u.test(compact)) {
    const prefix = compact.startsWith("+86") ? "+86 " : compact.startsWith("86") ? "86 " : "";
    const local = compact.replace(/^\+?86/u, "");
    return `${prefix}${local.slice(0, 3)}****${local.slice(-4)}`;
  }
  if (/^1\d{10}$/u.test(compact)) return `${compact.slice(0, 3)}****${compact.slice(-4)}`;

  const digits = compact.replace(/\D/gu, "");
  if (digits.length >= 7) return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
  if (digits.length >= 3) return `${digits[0]}***${digits.at(-1)}`;
  return "***";
}

export function maskSecurityIp(value: unknown): string {
  const original = String(value ?? "").trim();
  if (!original) return "";

  const ipv4 = original.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255)) {
    return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.*`;
  }

  if (original.includes(":")) {
    const groups = original.split(":").filter(Boolean);
    if (groups.length > 0 && groups.every((group) => /^[0-9a-f]{1,4}$/iu.test(group))) {
      return `${groups.slice(0, 2).join(":")}::****`;
    }
  }
  return "已隐藏";
}

export function maskSecurityUserId(value: unknown): string {
  const normalized = normalizeSecurityEventDisplayText(value, { fallback: "", maxLength: 160 });
  if (!normalized) return "";
  if (/^\+?(?:86)?1\d{10}$/u.test(normalized.replace(/[\s()-]/gu, ""))) {
    return maskSecurityPhone(normalized);
  }
  if (normalized.length <= 4) return `${normalized[0] ?? ""}***`;
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}…${normalized.slice(-1)}`;
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

function redactEmail(value: string): string {
  return value.replace(
    /\b([a-z0-9._%+-])([a-z0-9._%+-]*)(@[a-z0-9.-]+\.[a-z]{2,})\b/giu,
    (_match, first: string, _middle: string, domain: string) => `${first}***${domain}`,
  );
}

/** Remove credentials and mask direct identifiers before an audit list reaches the DOM. */
export function redactSecurityListText(
  value: unknown,
  options: SecurityEventDisplayOptions = {},
): string {
  const fallback = options.fallback ?? DEFAULT_FALLBACK;
  const maxLength = boundedLength(options.maxLength, 200);
  let text = normalizeSecurityEventDisplayText(value, { fallback, maxLength: MAX_ALLOWED_LENGTH });

  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?\b/gu, "[令牌已隐藏]")
    .replace(/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}\b/giu, "[密钥已隐藏]")
    .replace(
      /\b(authorization|cookie|set-cookie|password|passwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session(?:_id)?)\s*[:=]\s*([^\s,;]+)/giu,
      (_match, key: string) => `${key}=[已隐藏]`,
    )
    .replace(/\b1\d{10}\b/gu, (phone) => maskSecurityPhone(phone))
    .replace(/\b\d{12,24}\b/gu, (identifier) => maskSecurityUserId(identifier))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, (ip) => maskSecurityIp(ip))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, (id) => maskSecurityUserId(id));

  text = redactEmail(text).replace(/\s+/gu, " ").trim();
  return truncate(text || String(fallback), maxLength);
}
