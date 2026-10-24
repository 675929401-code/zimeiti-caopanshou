export interface SegmentMode {
  label: string;
  min: number;
  max: number;
  ideal: number;
  desc: string;
}

export interface SegmentResult {
  segments: string[];
  counts: number[];
  compliant: boolean[];
  paragraphBreakBefore: boolean[];
  overlapPrefixes?: string[];
  method?: "rule" | "semantic" | "semantic_fallback";
  model?: string;
  note?: string;
}

export interface SegmentUnit {
  index: number;
  paragraphIndex: number;
  text: string;
  charCount: number;
  paragraphBreakBefore: boolean;
}

/**
 * 统一口播速度：每秒 5-6 个中文字符。
 * 语义智能分段只能在这个边界附近取舍，不能随意突破规则。
 */
export const DURATION_MODES: Record<number, SegmentMode> = {
  8:  { label: "分段8秒",  min: 40,  max: 48,  ideal: 44,  desc: "40-48字" },
  10: { label: "分段10秒", min: 50,  max: 60,  ideal: 55,  desc: "50-60字" },
  12: { label: "分段12秒", min: 60,  max: 72,  ideal: 66,  desc: "60-72字" },
  15: { label: "分段15秒", min: 75,  max: 90,  ideal: 82,  desc: "75-90字" },
  16: { label: "分段16秒", min: 80,  max: 96,  ideal: 88,  desc: "80-96字" },
  20: { label: "分段20秒", min: 100, max: 120, ideal: 110, desc: "100-120字" },
  25: { label: "分段25秒", min: 125, max: 150, ideal: 138, desc: "125-150字" },
};

export function countChars(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf0-9]/g) || []).length;
}

export function splitParagraphClauses(text: string): string[] {
  const clauses: string[] = [];
  let buf = "";
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    buf += char;
    if (/[。！？!?，,；;、：:]/.test(char)) {
      while (index + 1 < chars.length && /[”’」』）》】]/u.test(chars[index + 1])) {
        buf += chars[index + 1];
        index += 1;
      }
      clauses.push(buf);
      buf = "";
    }
  }
  if (buf) clauses.push(buf);
  return clauses;
}

function normalizedParagraphs(text: string): string[] {
  // Keep spaces, punctuation and genuine repetitions; only remove line breaks.
  const paragraphs = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    .split(/\n(?=[ \t]*\n)/u).map(paragraph => paragraph.replace(/\n/g, "")).filter(Boolean);
  return paragraphs.reduce<string[]>((result, paragraph) => {
    if (!paragraph.trim() && result.length) result[result.length - 1] += paragraph;
    else result.push(paragraph);
    return result;
  }, []);
}

export function buildSegmentUnits(text: string): SegmentUnit[] {
  const paragraphs = normalizedParagraphs(text);
  const units: SegmentUnit[] = [];

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const normalizedPara = paragraphs[pIdx].replace(/\n/g, "");
    const clauses = splitParagraphClauses(normalizedPara);
    for (let cIdx = 0; cIdx < clauses.length; cIdx++) {
      const text = clauses[cIdx];
      units.push({
        index: units.length,
        paragraphIndex: pIdx,
        text,
        charCount: countChars(text),
        paragraphBreakBefore: pIdx > 0 && cIdx === 0,
      });
    }
  }

  return units;
}

function boundaryPenalty(text: string) {
  const trimmed = text.trim().replace(/[”’」』）》】]+$/u, "");
  const last = trimmed.at(-1) || "";
  if (/[。！？!?]/u.test(last)) return 0;
  if (/[；;]/u.test(last)) return 5;
  if (/[，,、]/u.test(last)) return 16;
  if (/[：:]/u.test(last)) return 44;
  return 28;
}

function segmentCost(text: string, chars: number, min: number, max: number, ideal: number, isLast: boolean) {
  let score = Math.abs(chars - ideal) ** 2 + boundaryPenalty(text);
  if (chars < min) score += (min - chars) ** 2 * 14 + (isLast ? 24 : 90);
  if (chars > max) score += (chars - max) ** 2 * 18 + 72;
  return score;
}

function splitOversizedClause(text: string, min: number, max: number, ideal: number): string[] {
  const total = countChars(text);
  if (total <= max) return [text];

  const minimumChunks = Math.ceil(total / max);
  const maximumChunks = Math.max(1, Math.floor(total / min));
  const idealChunks = Math.max(1, Math.round(total / ideal));
  const chunkCount = Math.max(minimumChunks, Math.min(Math.max(1, maximumChunks), idealChunks));
  if (chunkCount <= 1) return [text];

  const baseTarget = Math.floor(total / chunkCount);
  let remainder = total % chunkCount;
  const targets = Array.from({ length: chunkCount }, () => {
    const target = baseTarget + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return target;
  });

  const chunks: string[] = [];
  let buffer = "";
  let counted = 0;
  let targetIndex = 0;
  for (const char of Array.from(text)) {
    buffer += char;
    if (/[\u4e00-\u9fff\u3400-\u4dbf0-9]/u.test(char)) counted += 1;
    if (targetIndex < targets.length - 1 && counted >= targets[targetIndex]) {
      chunks.push(buffer);
      buffer = "";
      counted = 0;
      targetIndex += 1;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.filter(Boolean);
}

function segmentParagraphRule(text: string, min: number, max: number, ideal: number): string[] {
  const clauses = splitParagraphClauses(text)
    .flatMap(clause => splitOversizedClause(clause, min, max, ideal));
  if (!clauses.length) return [];

  const best = Array<number>(clauses.length + 1).fill(Number.POSITIVE_INFINITY);
  const previous = Array<number>(clauses.length + 1).fill(-1);
  best[0] = 0;

  for (let start = 0; start < clauses.length; start++) {
    if (!Number.isFinite(best[start])) continue;
    let candidate = "";
    for (let end = start; end < clauses.length; end++) {
      candidate += clauses[end];
      const chars = countChars(candidate);
      if (chars > max) break;
      const next = end + 1;
      const score = best[start] + segmentCost(candidate, chars, min, max, ideal, next === clauses.length);
      if (score < best[next]) {
        best[next] = score;
        previous[next] = start;
      }
    }
  }

  if (previous[clauses.length] < 0) return [text];
  const segments: string[] = [];
  for (let cursor = clauses.length; cursor > 0;) {
    const start = previous[cursor];
    segments.unshift(clauses.slice(start, cursor).join(""));
    cursor = start;
  }
  return segments;
}

export function segmentTextRule(text: string, duration: number): SegmentResult {
  const mode = DURATION_MODES[duration];
  if (!mode) return { segments: [], counts: [], compliant: [], paragraphBreakBefore: [] };
  const paragraphs = normalizedParagraphs(text);
  const allSegments: string[] = [];
  const allBreakBefore: boolean[] = [];

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const normalizedPara = paragraphs[pIdx].replace(/\n/g, "");
    const segs = segmentParagraphRule(normalizedPara, mode.min, mode.max, mode.ideal);

    for (let sIdx = 0; sIdx < segs.length; sIdx++) {
      allSegments.push(segs[sIdx]);
      allBreakBefore.push(pIdx > 0 && sIdx === 0);
    }
  }

  const counts = allSegments.map(countChars);
  // The lower bound is a pacing target; short original text must never be padded.
  const compliant = counts.map(count => count <= mode.max);

  return {
    segments: allSegments,
    counts,
    compliant,
    paragraphBreakBefore: allBreakBefore,
    method: "rule",
  };
}

export function normalizeForIntegrity(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().replace(/\n/g, "");
}

/** Legacy decoding only. New segment bodies never contain generated overlap. */
export function reconstructSegmentedText(segments: string[], overlapPrefixes: string[] = []) {
  return segments.map((segment, index) => {
    const prefix = overlapPrefixes[index] || "";
    return prefix && segment.startsWith(prefix) ? segment.slice(prefix.length) : segment;
  }).join("");
}

export function restoreSegmentResult(value: unknown, originalText: string, duration: number): SegmentResult {
  const mode = DURATION_MODES[duration];
  if (!mode || !value || typeof value !== "object") throw new Error("分段历史结果不完整");
  const parsed = value as Partial<SegmentResult>;
  if (!Array.isArray(parsed.segments) || !parsed.segments.length
    || parsed.segments.some(segment => typeof segment !== "string" || !segment.trim())) {
    throw new Error("分段历史结果不完整");
  }
  const breaks = parsed.paragraphBreakBefore ?? parsed.segments.map(() => false);
  if (!Array.isArray(breaks) || breaks.length !== parsed.segments.length
    || breaks.some(value => typeof value !== "boolean")) throw new Error("分段历史段落边界不完整");
  let segments = [...parsed.segments];
  const original = normalizeForIntegrity(originalText);
  // Original-text equality takes precedence over stale metadata, so genuine
  // repeated phrases are never removed from a valid narration.
  if (normalizeForIntegrity(segments.join("")) !== original) {
    const prefixes = parsed.overlapPrefixes;
    if (!Array.isArray(prefixes) || prefixes.length !== segments.length
      || prefixes.some((prefix, index) => typeof prefix !== "string" || (prefix !== ""
        && (index === 0 || !segments[index].startsWith(prefix) || !segments[index - 1].endsWith(prefix))))) {
      throw new Error("分段历史衔接标记不完整");
    }
    segments = segments.map((segment, index) => segment.slice(prefixes[index].length));
    if (segments.some(segment => !segment.trim()) || normalizeForIntegrity(segments.join("")) !== original) {
      throw new Error("分段历史结果与原文不一致");
    }
  }
  const counts = segments.map(countChars);
  if (counts.some(count => count > mode.max)) return segmentTextRule(originalText, duration);
  return {
    segments, counts, compliant: counts.map(count => count <= mode.max), paragraphBreakBefore: breaks,
    ...(parsed.method === "rule" || parsed.method === "semantic" || parsed.method === "semantic_fallback" ? { method: parsed.method } : {}),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
  };
}

export function formatSegmentedCopy(result: Pick<SegmentResult, "segments">, originalText: string): string {
  if (normalizeForIntegrity(result.segments.join("")) !== normalizeForIntegrity(originalText)) {
    throw new Error("分段结果与原文不一致，请重新分段后复制。");
  }
  return result.segments.map((segment, index) => `${index + 1}.【${segment}】`).join("\n");
}
