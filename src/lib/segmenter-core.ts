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

// Local, deterministic boundary hints. These are fallible, not a language model
// or an audio-timing measurement. Text stays as contiguous original substrings.
function segmentParagraphRule(text: string, min: number, max: number, ideal: number, duration: number): string[] {
  const symbols = Array.from(text);
  if (!symbols.length) return [];
  const total = countChars(text);

  const offsets = [0];
  const counts = [0];
  const visible = [0];
  const speechSeconds = [0];
  for (const symbol of symbols) {
    offsets.push(offsets[offsets.length - 1] + symbol.length);
    counts.push(counts[counts.length - 1] + (/[\u4e00-\u9fff\u3400-\u4dbf0-9]/u.test(symbol) ? 1 : 0));
    visible.push(visible[visible.length - 1] + (/\S/u.test(symbol) ? 1 : 0));
    // Conservative local heuristic only. Names, number readings and actual
    // voices vary; this cannot prove real audio duration.
    const durationCost = /\p{Script=Han}/u.test(symbol) ? 1 / 5.5
      : /[0-9\p{Number}]/u.test(symbol) ? 1 / 5
      : /[A-Za-z]/u.test(symbol) ? 0.07
      : /[。！？!?；;]/u.test(symbol) ? 0.22
      : /[，,、：:]/u.test(symbol) ? 0.12 : 0;
    speechSeconds.push(speechSeconds[speechSeconds.length - 1] + durationCost);
  }
  if (total <= max && speechSeconds[symbols.length] <= duration + 0.001) return [text];

  // Prefer complete sentences and condition + consequence where each unit can
  // fit. The protection is soft so there is always an in-limit path.
  const indexByOffset = new Map(offsets.map((offset, index) => [offset, index]));
  const protectedDiff = new Int32Array(symbols.length + 2);
  const clauseDiff = new Int32Array(symbols.length + 2);
  function protectRange(startOffset: number, endOffset: number, penalty: number, clause = false) {
    const start = indexByOffset.get(startOffset);
    const end = indexByOffset.get(endOffset);
    if (start === undefined || end === undefined || end - start < 2 || counts[end] - counts[start] > max
      || speechSeconds[end] - speechSeconds[start] > duration + 0.001) return;
    const diff = clause ? clauseDiff : protectedDiff;
    diff[start + 1] += penalty;
    diff[end] -= penalty;
  }
  for (const match of text.matchAll(/[^。！？!?；;]+(?:[。！？!?；;]+[”’」』）》〉】\])]*|$)/gu)) {
    protectRange(match.index, match.index + match[0].length, 400);
  }
  // Each punctuation-delimited clause that fits is a first-class unit.
  // Oversized clauses remain splittable via character and word boundaries.
  for (const match of text.matchAll(/[^。！？!?，,；;、：:]+(?:[。！？!?，,；;、：:]+[”’」』）》〉】\])]*|$)/gu)) {
    protectRange(match.index, match.index + match[0].length, 1, true);
  }
  for (const match of text.matchAll(/(?:如果|假如|倘若|只要|一旦|要是)[^，,。！？!?；;]{0,100}[，,][^，,。！？!?；;]{1,100}/gu)) {
    protectRange(match.index, match.index + match[0].length, 3000);
  }
  const protectedCosts = Array<number>(symbols.length + 1).fill(0);
  const insideClause = Array<boolean>(symbols.length + 1).fill(false);
  let protectedCost = 0;
  let clauseDepth = 0;
  for (let index = 1; index <= symbols.length; index++) {
    protectedCost += protectedDiff[index];
    protectedCosts[index] = protectedCost;
    clauseDepth += clauseDiff[index];
    insideClause[index] = clauseDepth > 0;
  }

  const wordOffsets = new Set<number>();
  try {
    if (typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
      for (const word of segmenter.segment(text)) wordOffsets.add(word.index);
    }
  } catch {
    // Some hosts do not have Chinese word segmentation. Character boundaries
    // remain available and the same punctuation/phrase hints are still used.
  }

  const depths = [0];
  const openings = "“‘「『（(《〈【[";
  const closings = "”’」』）)》〉】]";
  let depth = 0;
  for (const symbol of symbols) {
    if (openings.includes(symbol)) depth++;
    else if (closings.includes(symbol)) depth = Math.max(0, depth - 1);
    depths.push(depth);
  }

  function boundaryCost(index: number): number {
    if (index === symbols.length) return 0;
    const prev = symbols[index - 1] || "";
    const next = symbols[index] || "";
    const before = symbols.slice(Math.max(0, index - 8), index).join("");
    const after = symbols.slice(index, index + 8).join("");
    const last = before.replace(/[”’」』）》〉】\])]+$/u, "").at(-1) || "";
    let penalty = /[。！？!?]/u.test(last) ? 0
      : /[；;]/u.test(last) ? 25
      : /[，,、]/u.test(last) ? 65
      : /[：:]/u.test(last) ? 280
      : wordOffsets.has(offsets[index]) ? 150 : 300;
    if (depths[index] > 0) penalty += 220;
    if (openings.includes(prev) || closings.includes(next)) penalty += 1500;
    if (/^[，,。！？!?；;：:、]/u.test(next)) penalty += 1500;
    if (/^[的了着过呢吗吧呀嘛]/u.test(next)) penalty += 700;
    if (/[的地得]/u.test(prev)) penalty += 700;
    if (/[前后大小]/u.test(prev) && /[\u3400-\u9fff]/u.test(next)) penalty += 400;
    if (prev === next && /[\u3400-\u9fff]/u.test(prev)) penalty += 700;
    if (/[A-Za-z0-9]/u.test(prev) && /[A-Za-z0-9]/u.test(next)) penalty += 800;
    if (/[0-9]/u.test(prev) && /^[.．][0-9]/u.test(after)) penalty += 1200;
    if (/[0-9][.．]$/u.test(before) && /[0-9]/u.test(next)) penalty += 1200;
    // A verb and its directional/result complement are one expression, e.g.
    // 表达出、看出来、拿出来. This is a soft cost so a very long word can
    // still be segmented under the hard capacity limit.
    if (/^(?:出来|出去|起来|下去|上来|出|来|去)/u.test(after)
      && /(?:表达|显现|表现|发现|看|拿|走|跑|抬|跳|冲|站|发|说|做|带|伸|露|伸展)$/u.test(before)) penalty += 1200;
    // A comma at the end of a condition often leads directly into its result.
    // Use a bounded lookback and penalize rather than forbid the boundary.
    const recent = symbols.slice(Math.max(0, index - max * 2), index).join("");
    if (/(?:如果|假如|倘若|只要|一旦|要是)[^，,。！？!?；;]{0,100}[，,]$/u.test(recent)) penalty += 1200;
    // Transitions are candidates, not mandatory cuts: their associated clauses
    // can still stay together when the complete thought fits the limit.
    if (/^(?:最后|接着|随后|第二天|后来|突然|于是|然后)/u.test(after)) penalty -= 120;
    if (/(?:检查|打开|拿起|放下|接住|握住|关上|放回|抬起|看着|看到|拿出|擦干|听见)$/u.test(before)) penalty += 600;
    if (/(?:如果|因为|虽然|不是|不仅|之所以)$/u.test(before)) penalty += 650;
    if (/^(?:所以|那么|但是|而是|就会|才会|才能)/u.test(after)) penalty += 120;
    return Math.max(0, penalty) + protectedCosts[index];
  }

  const best = Array<number>(symbols.length + 1).fill(Number.POSITIVE_INFINITY);
  const previous = Array<number>(symbols.length + 1).fill(-1);
  const boundaryCosts = Array.from({ length: symbols.length + 1 }, (_, index) =>
    index === 0 ? 0 : boundaryCost(index),
  );
  best[0] = 0;
  // Bounded scan protects against quadratic work on long Latin/emoji runs. A
  // conservative streaming fallback below handles extreme zero-count spans.
  const maxLookahead = Math.max(1024, max * 8);
  for (let start = 0; start < symbols.length; start++) {
    if (!Number.isFinite(best[start])) continue;
    const limit = Math.min(symbols.length, start + maxLookahead);
    for (let end = start + 1; end <= limit; end++) {
      const length = counts[end] - counts[start];
      if (length > max) break;
      const spoken = speechSeconds[end] - speechSeconds[start];
      if (spoken > duration * 3) break;
      if (spoken <= 0 || visible[end] === visible[start]) continue;
      if (insideClause[end]) continue;
      const equivalentLength = Math.max(length, spoken * 5.5);
      const tooShort = Math.max(0, min - equivalentLength);
      const lengthCost = Math.abs(equivalentLength - ideal) ** 2 * 0.55 + tooShort ** 2 * 0.6;
      const over = Math.max(0, spoken - duration);
      // Soft rather than absolute: phrase boundaries and indivisible words can
      // make a perfectly estimated fit unavailable. An overrun is costly so
      // another feasible, shorter segment normally wins.
      const overtimeCost = over > 0.001 ? 1500 + over ** 2 * 200 : 0;
      const cost = best[start] + 220 + lengthCost + overtimeCost + boundaryCosts[end];
      if (cost < best[end]) {
        best[end] = cost;
        previous[end] = start;
      }
    }
  }

  if (previous[symbols.length] < 0) {
    // Always make progress for pathological zero-cost runs. Prefer nearby word
    // or punctuation boundaries, with a bounded speech-estimate soft budget;
    // when a single word is longer than the budget it must be split. No text
    // is added or dropped, and the hard effective-character cap still applies.
    const result: string[] = [];
    let start = 0;
    let pendingSpace = "";
    while (start < symbols.length) {
      let end = start;
      let preferred = -1;
      while (end < symbols.length) {
        const next = end + 1;
        const tooMany = counts[next] - counts[start] > max;
        const tooLong = speechSeconds[next] - speechSeconds[start] > duration + 0.001;
        if ((tooMany || tooLong) && end > start && visible[end] > visible[start]) break;
        end = next;
        if ((wordOffsets.has(offsets[end]) || /[\s，,。！？!?；;、：:]/u.test(symbols[end - 1]))
          && speechSeconds[end] - speechSeconds[start] >= duration * 0.5) preferred = end;
      }
      if (end < symbols.length && preferred > start && preferred < end) end = preferred;
      if (end <= start) end = start + 1;
      const chunk = pendingSpace + text.slice(offsets[start], offsets[end]);
      if (chunk.trim()) { result.push(chunk); pendingSpace = ""; }
      else pendingSpace = chunk;
      start = end;
    }
    if (pendingSpace && result.length) result[result.length - 1] += pendingSpace;
    else if (pendingSpace) result.push(pendingSpace);
    return result;
  }

  const result: string[] = [];
  for (let cursor = symbols.length; cursor > 0;) {
    const start = previous[cursor];
    result.push(text.slice(offsets[start], offsets[cursor]));
    cursor = start;
  }
  return result.reverse();
}

export function segmentTextRule(text: string, duration: number): SegmentResult {
  const mode = DURATION_MODES[duration];
  if (!mode) return { segments: [], counts: [], compliant: [], paragraphBreakBefore: [] };
  const paragraphs = normalizedParagraphs(text);
  const allSegments: string[] = [];
  const allBreakBefore: boolean[] = [];

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const normalizedPara = paragraphs[pIdx].replace(/\n/g, "");
    const segs = segmentParagraphRule(normalizedPara, mode.min, mode.max, mode.ideal, duration);

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
