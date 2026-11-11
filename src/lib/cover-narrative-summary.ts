import { coverNumericClaims, type CoverNumericClaim } from "./cover-number-evidence";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj | null => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
const sameClaim = (left: CoverNumericClaim, right: CoverNumericClaim) => left.value === right.value && left.unit === right.unit
  && left.negative === right.negative && left.context === right.context;
export type CoverNarrativeSummaryNormalization = {
  version: "cover-narrative-summary/1";
  kind: "leading_indefinite_narrative_event";
  fieldPath: "contentBreakdown.summary";
  originalText: string;
  normalizedText: string;
  removedText: "一次";
  evidenceRefs: string[];
};

/** Remove only an unsupported narrative article, never a numeric assertion.
 * The complete analysis still passes the ordinary schema/evidence/number gates.
 * This helper does not rewrite the durable provider response or its billing. */
export function normalizeCoverNarrativeSummary(value: unknown, materials: { contentKind?: unknown; text: string; assets?: unknown; imageMode?: unknown }) {
  const analysis = object(value), breakdown = object(analysis?.contentBreakdown), summary = object(breakdown?.summary);
  if (materials.contentKind === "product" || !Array.isArray(materials.assets) || materials.assets.length !== 0 || materials.imageMode === "compose"
    || !analysis || !breakdown || !summary || typeof summary.text !== "string"
    || !Array.isArray(summary.evidenceRefs) || !summary.evidenceRefs.length
    || !summary.evidenceRefs.every(id => typeof id === "string") || new Set(summary.evidenceRefs).size !== summary.evidenceRefs.length
    || !Array.isArray(analysis.evidence)) return { value };
  const text = summary.text;
  // The event fragment itself must end at a comma/full stop. A quantity,
  // regimen, first/only occurrence or promised efficacy is never an article.
  if (!/^一次[\p{Script=Han}\s]{0,80}(?:经历|互动|游戏|对话|相处|观察)[，,。]/u.test(text)
    || /使用|药|疗程|治疗|用量|剂量|见效|有效|功效|疗效|训练|广告|促销|售价|价格|购买|销量|认证|保证|根治|治愈|治好|包治|永久|零风险|最低|每|单次|限次|频率|次数|仅|只有|只需|唯一|第|一次性|一次就|一次便|一次即可/u.test(text)) return { value };
  const references = summary.evidenceRefs as string[];
  const selected = references.map(id => (analysis.evidence as unknown[]).map(object).find(item => item?.id === id));
  if (selected.some(item => !item || item.source !== "text" || typeof item.quote !== "string" || !materials.text.includes(item.quote))) return { value };
  const quoted = selected.map(item => String(item!.quote)).join("\n");
  const sourceClaims = coverNumericClaims(quoted);
  const allSourceClaims = coverNumericClaims(materials.text);
  if (allSourceClaims.some(claim => claim.unit === "次" && (claim.value !== "1" || claim.negative || claim.context !== ""))
    || /每次|每逢|多次|反复|频繁|屡次|再三|不止一次|仅一次|只有一次|第一次|一次性/u.test(materials.text)) return { value };
  const unsupported = coverNumericClaims(text).filter(claim => !sourceClaims.some(source => sameClaim(claim, source)));
  if (unsupported.length !== 1 || unsupported[0].start !== 0 || unsupported[0].end !== 1
    || unsupported[0].value !== "1" || unsupported[0].unit !== "次" || unsupported[0].negative || unsupported[0].context !== "") return { value };
  const normalizedText = text.slice(2);
  const normalization: CoverNarrativeSummaryNormalization = { version: "cover-narrative-summary/1", kind: "leading_indefinite_narrative_event",
    fieldPath: "contentBreakdown.summary", originalText: text, normalizedText, removedText: "一次", evidenceRefs: [...references] };
  return { value: { ...analysis, contentBreakdown: { ...breakdown, summary: { ...summary, text: normalizedText } } }, normalization };
}
