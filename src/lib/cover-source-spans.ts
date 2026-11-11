import type { CoverPrepareInput, CoverVisualObservation } from "./cover-workbench-contract";
import { coverNumericClaims } from "./cover-number-evidence";

export const COVER_SOURCE_SPAN_VERSION = "cover-source-spans/1";
export type CoverSourceSpan = {
  id: string; source: "text" | "manual_title" | "visual_observation";
  start: number; end: number; text: string; assetId?: string; observationId?: string;
};
export type CoverSourceAudit = {
  schemaVersion: "cover-source-audit/1";
  offsetUnit: "utf16_code_unit";
  bindings: Array<{ evidenceId: string; sourceSpanId: string; source: CoverSourceSpan["source"]; start: number; end: number; assetId?: string; observationId?: string }>;
  repairs: Array<{ kind: "empty_secondary_title" | "source_whitespace_punctuation" | "source_inserted_particles";
    fieldPath: string; evidenceId?: string; originalQuote?: string; sourceSpanId?: string; start?: number; end?: number }>;
};
export class CoverSourceSpanError extends Error {
  readonly code = "ANALYSIS_EVIDENCE_INVALID";
  constructor(message: string, readonly fieldPath: string, readonly evidenceId?: string) { super(message); this.name = "CoverSourceSpanError"; }
}
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Every model-visible text span is a real continuous slice, never a summary. */
export function buildCoverSourceSpans(materials: Pick<CoverPrepareInput, "text" | "manualTitle">, observations: readonly CoverVisualObservation[] = []): CoverSourceSpan[] {
  const spans: CoverSourceSpan[] = [];
  function split(text: string, source: "text" | "manual_title", prefix: string) {
    let start = 0, number = 0;
    const emit = (end: number) => {
      // Bound long unpunctuated inputs to the existing 2,000-char evidence cap.
      while (start < end) {
        let boundary = Math.min(end, start + 1000);
        if (boundary < end && /[\uD800-\uDBFF]/u.test(text[boundary - 1])) boundary--;
        if (text.slice(start, boundary).trim()) spans.push({ id: `${prefix}${++number}`, source, start, end: boundary, text: text.slice(start, boundary) });
        start = boundary;
      }
    };
    for (let index = 0; index < text.length; index++) if (/[。！？!?；;\n]/u.test(text[index])) emit(index + 1);
    emit(text.length);
  }
  split(materials.text, "text", "t");
  if (materials.manualTitle) split(materials.manualTitle, "manual_title", "m");
  for (const visual of observations) {
    if (visual.status === "capability_unavailable") continue;
    const values = [...visual.observations.map(item => ({ id: item.id, text: item.description })),
      ...visual.ocr.filter(item => item.readability !== "unreadable").map(item => ({ id: item.id, text: item.text }))];
    for (const value of values) if (value.text.trim()) spans.push({ id: `v:${visual.assetId}:${value.id}`, source: "visual_observation",
      assetId: visual.assetId, observationId: value.id, start: 0, end: value.text.length, text: value.text });
  }
  return spans;
}

function normalizedCharacters(text: string) {
  const characters: string[] = [], offsets: number[] = [];
  let offset = 0;
  for (const character of text) {
    if (!/[\s\p{P}\p{Z}]/u.test(character)) { characters.push(character); offsets.push(offset); }
    offset += character.length;
  }
  return { characters, offsets };
}
// Deliberately excludes 不/没/未/无, quantities (只/都/才), conjunctions
// changing logic, subject words, units and specifications. Only omissions from
// the quote may be filled from the real source, never invented into it.
const sourceParticles = new Set(["就", "呀", "啊", "呢", "吧", "嘛", "哦", "喔", "啦", "呐", "哇", "噢", "咯"]);
function numericSignature(text: string) {
  return JSON.stringify(coverNumericClaims(text).map(item => [item.value, item.unit, item.negative, item.context]));
}

/** Strictly bounded spelling alignment, not fuzzy/semantic quote repair. */
export function alignCoverSourceQuote(quote: string, source: string): { quote: string; start: number; end: number; kind: "source_whitespace_punctuation" | "source_inserted_particles" } | null {
  if (typeof quote !== "string" || !quote.trim() || quote.length > 2000 || source.length > 20_000) return null;
  const wanted = normalizedCharacters(quote), actual = normalizedCharacters(source);
  if (wanted.characters.length < 8) return null;
  const matches: Array<{ start: number; end: number; inserted: number }> = [];
  for (let begin = 0; begin < actual.characters.length; begin++) {
    if (actual.characters[begin] !== wanted.characters[0]) continue;
    let target = 0, cursor = begin, inserted = 0;
    while (target < wanted.characters.length && cursor < actual.characters.length) {
      if (actual.characters[cursor] === wanted.characters[target]) { target++; cursor++; }
      else if (inserted < 2 && sourceParticles.has(actual.characters[cursor])) { inserted++; cursor++; }
      else break;
    }
    if (target !== wanted.characters.length) continue;
    const start = actual.offsets[begin], last = cursor - 1;
    const end = actual.offsets[last] + actual.characters[last].length;
    const candidate = source.slice(start, end);
    // Punctuation removal must never merge/change a decimal, SKU, range,
    // percent, unit or the polarity of a numerical assertion.
    if (candidate.length <= 2000 && numericSignature(candidate) === numericSignature(quote)) matches.push({ start, end, inserted });
  }
  if (matches.length !== 1) return null;
  const match = matches[0];
  return { quote: source.slice(match.start, match.end), start: match.start, end: match.end,
    kind: match.inserted ? "source_inserted_particles" : "source_whitespace_punctuation" };
}

/** Expand server-issued sourceSpanId references into the unchanged evidence
 * contract; narrowly repair old paid quotes and keep a reproducible audit. */
export function hydrateCoverAnalysisEvidence(value: unknown, materials: Pick<CoverPrepareInput, "text" | "manualTitle">,
  observations: readonly CoverVisualObservation[] = []) {
  const sourceAudit: CoverSourceAudit = { schemaVersion: "cover-source-audit/1", offsetUnit: "utf16_code_unit", bindings: [], repairs: [] };
  const initial = object(value);
  if (!initial) return { value, sourceAudit };
  const result: Record<string, unknown> = { ...initial };
  if (result.secondaryTitle === undefined || typeof result.secondaryTitle === "string" && !result.secondaryTitle.trim()) {
    result.secondaryTitle = null;
    sourceAudit.repairs.push({ kind: "empty_secondary_title", fieldPath: "secondaryTitle" });
  }
  const spans = buildCoverSourceSpans(materials, observations);
  if (!Array.isArray(result.evidence)) return { value: result, sourceAudit };
  result.evidence = result.evidence.map((raw, index) => {
    const evidence = object(raw);
    if (!evidence) return raw;
    const id = typeof evidence.id === "string" ? evidence.id : undefined;
    const fieldPath = `evidence.${index}`;
    if (Object.hasOwn(evidence, "sourceSpanId")) {
      if (Object.keys(evidence).some(key => !["id", "sourceSpanId", "fields"].includes(key))) {
        throw new CoverSourceSpanError("片段引用包含不允许的字段", fieldPath, id);
      }
      const span = spans.find(item => item.id === evidence.sourceSpanId);
      if (!span) throw new CoverSourceSpanError("引用的原文片段不存在或不属于本次材料", `${fieldPath}.sourceSpanId`, id);
      sourceAudit.bindings.push({ evidenceId: id || "", sourceSpanId: span.id, source: span.source, start: span.start, end: span.end,
        ...(span.assetId ? { assetId: span.assetId, observationId: span.observationId } : {}) });
      return { id: evidence.id, fields: evidence.fields, source: span.source, quote: span.text,
        ...(span.assetId ? { assetId: span.assetId, observationId: span.observationId } : {}) };
    }
    if (typeof evidence.quote !== "string") return evidence;
    const source = evidence.source === "text" ? materials.text : evidence.source === "manual_title" ? materials.manualTitle || ""
      : evidence.source === "visual_observation" ? spans.find(span => span.assetId === evidence.assetId && span.observationId === evidence.observationId)?.text || "" : "";
    if (!source || source.includes(evidence.quote)) return evidence;
    const aligned = alignCoverSourceQuote(evidence.quote, source);
    if (!aligned) throw new CoverSourceSpanError("引用无法唯一对应原文，请保留原分析核验", `${fieldPath}.quote`, id);
    const sourceSpanId = `${evidence.source}:${aligned.start}:${aligned.end}`;
    sourceAudit.bindings.push({ evidenceId: id || "", sourceSpanId, source: evidence.source as CoverSourceSpan["source"], start: aligned.start, end: aligned.end,
      ...(typeof evidence.assetId === "string" ? { assetId: evidence.assetId, observationId: String(evidence.observationId) } : {}) });
    sourceAudit.repairs.push({ kind: aligned.kind, fieldPath: `${fieldPath}.quote`, evidenceId: id,
      originalQuote: evidence.quote, sourceSpanId, start: aligned.start, end: aligned.end });
    return { ...evidence, quote: aligned.quote };
  });
  return { value: result, sourceAudit };
}
