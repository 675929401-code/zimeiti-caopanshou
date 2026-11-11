import { createHash } from "node:crypto";

export type CoverAnalysisTransportNormalization = {
  version: "cover-analysis-envelope/1";
  kind: "single_premature_envelope_closure" | "single_trailing_envelope_closure";
  offset: number;
  originalSha256: string;
  normalizedSha256: string;
};

function rootPropertyKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0, stringStart = -1, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (stringStart >= 0) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        if (depth === 1 && /^\s*:/u.test(text.slice(index + 1))) keys.push(JSON.parse(text.slice(stringStart, index + 1)) as string);
        stringStart = -1;
      }
    } else if (char === '"') stringStart = index;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return keys;
}

/** Preserve every value byte. Admit one extra root closing brace either before
 * the final visualObservations property or after an otherwise complete envelope.
 * This is not JSON completion: truncated, ambiguous or other malformed output
 * still throws, then the full semantic/evidence contract runs on the result. */
export function parseCoverAnalysisEnvelope(text: string): { value: unknown; normalization?: CoverAnalysisTransportNormalization } {
  try { return { value: JSON.parse(text) }; } catch { /* Inspect one closed-envelope transport defect below. */ }
  if (!/^\{\s*"analysis"\s*:/u.test(text)) throw new Error("COVER_ANALYSIS_ENVELOPE_INVALID");
  const stack: string[] = [];
  let inString = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") { stack.push(char); continue; }
    if (char !== "}" && char !== "]") continue;
    if (stack.pop() !== (char === "}" ? "{" : "[")) break;
    if (stack.length) continue;
    if (char !== "}") break;
    const suffix = text.slice(index + 1);
    let offset: number;
    let kind: CoverAnalysisTransportNormalization["kind"];
    if (/^\s*,\s*"visualObservations"\s*:/u.test(suffix)) {
      offset = index; kind = "single_premature_envelope_closure";
    } else if (/^\s*\}\s*$/u.test(suffix)) {
      // The scanner has closed the first complete root. Only one redundant
      // trailing brace is removable; no second value or trailing prose is kept.
      offset = index + 1 + suffix.indexOf("}"); kind = "single_trailing_envelope_closure";
    } else break;
    const normalized = text.slice(0, offset) + text.slice(offset + 1);
    let value: unknown;
    try { value = JSON.parse(normalized); } catch { break; }
    const keys = rootPropertyKeys(normalized);
    if (keys.length !== 2 || keys[0] !== "analysis" || keys[1] !== "visualObservations") break;
    if (!value || typeof value !== "object" || Array.isArray(value)) break;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "analysis") || !Object.hasOwn(row, "visualObservations")
      || !row.analysis || typeof row.analysis !== "object" || Array.isArray(row.analysis) || !Array.isArray(row.visualObservations)) break;
    const sha = (content: string) => createHash("sha256").update(content).digest("hex");
    return { value, normalization: { version: "cover-analysis-envelope/1", kind,
      offset, originalSha256: sha(text), normalizedSha256: sha(normalized) } };
  }
  throw new Error("COVER_ANALYSIS_ENVELOPE_INVALID");
}
