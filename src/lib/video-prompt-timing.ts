export type VideoPromptTimeRange = {
  start: number;
  end: number;
};

export type NormalizedVideoPromptTiming = {
  prompt: string;
  declaredDuration: number | null;
  timelineDuration: number | null;
  timelineNormalized: boolean;
};

const TARGET_DURATION_PATTERN = /((?:目标总?时长|视频时长|总时长|duration)\s*[：:]?\s*)(\d+(?:\.\d+)?)(\s*(?:秒|s))/gi;
const TIME_RANGE_PATTERN = /(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-~～—–至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/gi;

export function roundVideoDuration(value: number) {
  return Math.round(value * 10) / 10;
}

export function formatVideoDuration(value: number, fixed = false) {
  const rounded = roundVideoDuration(value);
  return fixed ? rounded.toFixed(1) : Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function extractVideoPromptTimeRanges(prompt: string): VideoPromptTimeRange[] {
  return Array.from(prompt.matchAll(TIME_RANGE_PATTERN), (match) => ({
    start: roundVideoDuration(Number(match[1])),
    end: roundVideoDuration(Number(match[2])),
  })).filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
}

export function extractPromptDurationSeconds(prompt: string): number | null {
  const explicit = [...prompt.matchAll(TARGET_DURATION_PATTERN)][0];
  if (explicit) return Math.max(0.5, roundVideoDuration(Number(explicit[2])));
  const ranges = extractVideoPromptTimeRanges(prompt);
  if (ranges.length === 0) return null;
  return Math.max(...ranges.map((range) => range.end));
}

export function normalizeVideoPromptTiming(prompt: string, targetDurationSeconds: number): NormalizedVideoPromptTiming {
  const target = Math.max(0.5, roundVideoDuration(targetDurationSeconds));
  const declaredDuration = extractPromptDurationSeconds(prompt);
  const ranges = extractVideoPromptTimeRanges(prompt);
  const timelineDuration = ranges.length > 0 ? Math.max(...ranges.map((range) => range.end)) : null;
  let normalized = prompt.replace(
    TARGET_DURATION_PATTERN,
    (_match, prefix: string, _duration: string, suffix: string) => `${prefix}${formatVideoDuration(target)}${suffix}`,
  );
  let timelineNormalized = false;

  if (timelineDuration && Math.abs(timelineDuration - target) >= 0.05) {
    const scale = target / timelineDuration;
    normalized = normalized.replace(TIME_RANGE_PATTERN, (_match, startText: string, endText: string) => {
      const start = roundVideoDuration(Number(startText) * scale);
      const end = roundVideoDuration(Number(endText) * scale);
      return `${formatVideoDuration(start, true)}-${formatVideoDuration(Math.min(target, end), true)}秒`;
    });
    timelineNormalized = true;
  }

  return { prompt: normalized, declaredDuration, timelineDuration, timelineNormalized };
}

export function buildCanonicalShotTimeline(
  durationSeconds: number,
  content: { opening: string; action: string; ending: string },
) {
  const duration = Math.max(1, roundVideoDuration(durationSeconds));
  const openingEnd = Math.min(duration - 0.6, Math.max(0.5, roundVideoDuration(duration * 0.2)));
  const endingStart = Math.max(openingEnd + 0.5, roundVideoDuration(duration - Math.max(0.5, duration * 0.2)));
  return [
    `${formatVideoDuration(0, true)}-${formatVideoDuration(openingEnd, true)}秒：${content.opening}`,
    `${formatVideoDuration(openingEnd, true)}-${formatVideoDuration(endingStart, true)}秒：${content.action}`,
    `${formatVideoDuration(endingStart, true)}-${formatVideoDuration(duration, true)}秒：${content.ending}`,
  ].join("；");
}
