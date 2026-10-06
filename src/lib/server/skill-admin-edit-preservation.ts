import "server-only";

import { SKILL_PAYLOAD_MAX_DEPTH, SkillPayloadValidationError, sanitizeSkillAdminValue } from "@/lib/server/skill-package-contract";

const MASK_PATTERN = /\[REDACTED(?:_[A-Z0-9_]+)?\]/u;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Restore only an unchanged display mask from the same trusted server-side field. */
export function restoreSkillAdminRedactedValues(incoming: unknown, original?: unknown, path = "$", fieldName?: string, depth = 0): unknown {
  if (depth > SKILL_PAYLOAD_MAX_DEPTH) {
    throw new SkillPayloadValidationError("SKILL_PAYLOAD_TOO_DEEP", "Skill 配置嵌套层级过深", path);
  }
  if (typeof incoming === "string") {
    if (!MASK_PATTERN.test(incoming)) return incoming;
    const sanitized = fieldName === undefined
      ? sanitizeSkillAdminValue(original)
      : record(sanitizeSkillAdminValue({ [fieldName]: original }))?.[fieldName];
    if (typeof original === "string" && original !== incoming && sanitized === incoming) return original;
    throw new SkillPayloadValidationError("SKILL_REDACTED_VALUE_UNRESOLVED", "脱敏配置缺少匹配的原始版本，请重新载入后再保存", path);
  }
  if (Array.isArray(incoming)) {
    const baseline = Array.isArray(original) ? original : [];
    return incoming.map((entry, index) => {
      const id = record(entry)?.id;
      const matches = typeof id === "string" ? baseline.filter((candidate) => record(candidate)?.id === id) : [];
      const previous = typeof id === "string" ? matches.length === 1 ? matches[0] : undefined : baseline[index];
      return restoreSkillAdminRedactedValues(entry, previous, `${path}[${index}]`, undefined, depth + 1);
    });
  }
  const object = record(incoming);
  if (!object) return incoming;
  const baseline = record(original);
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [
    key,
    restoreSkillAdminRedactedValues(value, baseline?.[key], `${path}.${key}`, key, depth + 1),
  ]));
}
