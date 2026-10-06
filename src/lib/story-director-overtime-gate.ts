export const STORY_DIRECTOR_MOVIE_AGENT_ID = "agent-1786633444187-594spj";

export type StoryDirectorOvertimeSegment = {
  number: number;
  effectiveCharacters: number;
  limit: number;
};

export type StoryDirectorOvertimeGate = {
  code: "STORY_DIRECTOR_NARRATION_OVERTIME";
  durationSeconds: number;
  segments: StoryDirectorOvertimeSegment[];
  message: string;
};

const DURATION_PATTERNS = [
  /target_duration_seconds\s*[：:]\s*(8|10|15)(?:\s*秒)?/iu,
  /(?:目标视频时长|分段时长|单段视频时长)\s*[：:]\s*(8|10|15)(?:\s*秒)?/iu,
];

function targetDurationSeconds(input: string): number | null {
  for (const pattern of DURATION_PATTERNS) {
    const match = input.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function numberedSegments(input: string): Array<{ number: number; text: string }> {
  const segments: Array<{ number: number; text: string }> = [];
  const seen = new Set<number>();
  for (const line of input.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d{1,3})\s*[.、]\s*(?:【([^】]+)】|\[([^\]]+)\])\s*$/u);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isInteger(number) || number < 1 || seen.has(number)) continue;
    seen.add(number);
    segments.push({ number, text: String(match[2] || match[3] || "") });
  }
  return segments.sort((left, right) => left.number - right.number);
}

export function countNarrationEffectiveCharacters(value: string): number {
  return [...value.matchAll(/[\p{Script=Han}\p{Number}]/gu)].length;
}

export function evaluateStoryDirectorOvertimeGate(
  agentId: unknown,
  userInput: unknown,
): StoryDirectorOvertimeGate | null {
  if (agentId !== STORY_DIRECTOR_MOVIE_AGENT_ID || typeof userInput !== "string") return null;
  const durationSeconds = targetDurationSeconds(userInput);
  if (!durationSeconds) return null;
  const segments = numberedSegments(userInput);
  if (segments.length === 0) return null;
  const limit = durationSeconds * 6;
  const overtime = segments
    .map((segment) => ({
      number: segment.number,
      effectiveCharacters: countNarrationEffectiveCharacters(segment.text),
      limit,
    }))
    .filter((segment) => segment.effectiveCharacters > segment.limit);
  if (overtime.length === 0) return null;
  const details = overtime.map((segment) =>
    `- 第${segment.number}段：${segment.effectiveCharacters}个有效字 / 上限${segment.limit}字 / 建议压缩到${segment.limit}字以内`,
  );
  return {
    code: "STORY_DIRECTOR_NARRATION_OVERTIME",
    durationSeconds,
    segments: overtime,
    message: ["生成门禁：口播超时，请先压缩或重新分段", ...details].join("\n"),
  };
}
