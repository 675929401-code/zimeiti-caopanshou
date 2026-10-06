import "server-only";

import { createHash } from "node:crypto";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stable(nested)]));
}

export function commerceV2Sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
