export const STORYBOARD_EFFECTIVE_CHARS_PER_SECOND = 6;
export const STORYBOARD_SUPPORTED_DURATIONS = [8, 10, 15] as const;
export type StoryboardSupportedDuration = (typeof STORYBOARD_SUPPORTED_DURATIONS)[number];

export function countEffectiveNarrationCharacters(value: string) {
  // Chinese characters and numbers are spoken payload. Latin letters are kept
  // in the prompt but do not silently increase the Chinese voice budget.
  return Array.from(String(value || "")).filter((character) => /[\p{Script=Han}\p{Number}]/u.test(character)).length;
}

export function storyboardNarrationCharBudget(duration: StoryboardSupportedDuration) {
  const target = duration * STORYBOARD_EFFECTIVE_CHARS_PER_SECOND;
  return {
    duration,
    charsPerSecond: STORYBOARD_EFFECTIVE_CHARS_PER_SECOND,
    recommendedMin: Math.round(target * 0.83),
    recommendedMax: target,
    target,
  };
}

export function validateStoryboardNarrationCapacity(
  narration: string,
  duration: StoryboardSupportedDuration,
) {
  const effectiveCharacters = countEffectiveNarrationCharacters(narration);
  const budget = storyboardNarrationCharBudget(duration);
  return {
    ok: effectiveCharacters <= budget.recommendedMax,
    effectiveCharacters,
    ...budget,
  };
}

/**
 * Preserve user supplied numbered paragraphs as immutable production units.
 * The compiler may segment unnumbered prose, but it must never silently move
 * an explicit boundary that the author or an upstream agent already chose.
 */
export function parseExplicitStoryboardSegments(script: string): string[] | null {
  const normalized = String(script || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return null;
  const starts = [...normalized.matchAll(/(?:^|\n)\s*(\d+)\s*[.、:：]\s*/gu)];
  if (!starts.length) return null;
  const segments = starts.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = starts[index + 1]?.index ?? normalized.length;
    const value = normalized
      .slice(start, end)
      .trim()
      .replace(/^【/u, "")
      .replace(/】$/u, "")
      .trim();
    return value ? [value] : [];
  });
  return segments.length === starts.length ? segments : null;
}
