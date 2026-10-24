import {
  countEffectiveNarrationCharacters,
  storyboardNarrationCharBudget,
  type StoryboardSupportedDuration,
} from "./storyboard-duration-contract";

export const STORY_DIRECTOR_MOVIE_AGENT_ID = "agent-1786633444187-594spj";
export const STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID = "agent-1786843330392-emdjv2";

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

const DURATION_LINE = /^\s*(?:target_duration_seconds|目标视频时长|分段时长|每段时长|单段视频时长)\s*[：:]\s*(.*?)\s*$/iu;

// These are reception-card fields, not narration. In particular, numbered
// examples in special_notes must not become additional production segments.
const HIGH_ENERGY_METADATA_LINE = /^\s*(?:target_duration_seconds|storyboard_target_duration_seconds|target_duration|duration_seconds|animation_style|storyboard_visual_style|visual_style|aspect_ratio|storyboard_aspect_ratio|owner_gender|dog_breed|storyboard_format|special_notes|storyboard_special_requirements|special_requirements|目标视频时长|分段时长|每段时长|单段视频时长|视频时长|时长|视频比例|画面比例|画幅比例|主人性别|狗狗品种|犬种|动画风格|3D动画风格|画面风格|故事板形态|特殊备注|特殊要求)\s*[：:]/iu;
const NOTES_LINE = /^\s*(?:special_notes|storyboard_special_requirements|special_requirements|特殊备注|特殊要求)\s*[：:]/iu;

export type StoryDirectorTimingInput = {
  durationSeconds: StoryboardSupportedDuration | null;
  segments: Array<{ number: number; text: string }>;
  complete: boolean;
  unambiguous: boolean;
};

/** The gate and authoritative timing context share this narration boundary. */
export function parseStoryDirectorTimingInput(agentId: unknown, input: string): StoryDirectorTimingInput {
  const highEnergy = agentId === STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID;
  const segments: Array<{ number: number; text: string }> = [];
  const seen = new Set<number>();
  const durations = new Set<StoryboardSupportedDuration>();
  let complete = highEnergy || agentId === STORY_DIRECTOR_MOVIE_AGENT_ID;
  let stopped = false;
  let active: { number: number; lines: string[]; closingBracket: string | null } | null = null;
  const finishSegment = () => {
    if (!active) return;
    let text = active.lines.join("\n").trim();
    if (active.closingBracket) {
      if (!text.endsWith(active.closingBracket)) complete = false;
      else text = text.slice(1, -1);
    }
    if (!text) complete = false;
    segments.push({ number: active.number, text });
    active = null;
  };
  for (const line of input.split(/\r?\n/u)) {
    if (NOTES_LINE.test(line)) { finishSegment(); break; }
    const duration = line.match(DURATION_LINE);
    if (duration) {
      const value = duration[1].match(/^(8|10|15)(?:\s*秒(?:版)?(?:（[^）]*）|[：:]\s*每段[1-9](?:-[1-9])?个镜头)?)?$/u);
      if (value) durations.add(Number(value[1]) as StoryboardSupportedDuration);
      else complete = false;
    }
    if (HIGH_ENERGY_METADATA_LINE.test(line)) {
      finishSegment();
      if (segments.length > 0) stopped = true;
      continue;
    }
    if (stopped) continue;
    if (!highEnergy && /^\s*\d/u.test(line) && !/^\s*\d{1,3}\s*[.、]\s*(?:【[^】]+】|\[[^\]]+\])\s*$/u.test(line)) {
      complete = false;
      continue;
    }
    const match = line.match(/^\s*(\d{1,3})\s*(?:\\?\.|、)\s*(.*)$/u);
    if (match) {
      finishSegment();
      const number = Number(match[1]);
      if (!Number.isInteger(number) || number < 1 || seen.has(number)) complete = false;
      seen.add(number);
      const text = match[2];
      active = {
        number,
        lines: [text],
        closingBracket: text.startsWith("【") ? "】" : text.startsWith("[") ? "]" : null,
      };
      if (!highEnergy && (!active.closingBracket || !text.trimEnd().endsWith(active.closingBracket))) complete = false;
    } else if (active) {
      active.lines.push(line);
    } else if (segments.length && line.trim()) {
      complete = false;
    }
    if (active?.closingBracket && line.trimEnd().endsWith(active.closingBracket)) finishSegment();
  }
  finishSegment();
  const durationSeconds = durations.size === 1 ? [...durations][0] : null;
  const unambiguous = complete && durationSeconds !== null;
  if (!segments.length || segments.some((segment, index) => segment.number !== index + 1)) complete = false;
  return { durationSeconds, segments, unambiguous, complete: complete && durationSeconds !== null };
}

export function countNarrationEffectiveCharacters(value: string): number {
  return countEffectiveNarrationCharacters(value);
}

export function evaluateStoryDirectorOvertimeGate(
  agentId: unknown,
  userInput: unknown,
): StoryDirectorOvertimeGate | null {
  const highEnergy = agentId === STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID;
  if ((!highEnergy && agentId !== STORY_DIRECTOR_MOVIE_AGENT_ID) || typeof userInput !== "string") return null;
  const { durationSeconds, segments, unambiguous } = parseStoryDirectorTimingInput(agentId, userInput);
  if (!unambiguous || !durationSeconds) return null;
  const limit = highEnergy
    ? storyboardNarrationCharBudget(durationSeconds as StoryboardSupportedDuration).recommendedMax
    : durationSeconds * 6;
  const overtime = segments
    .map((segment) => ({
      number: segment.number,
      effectiveCharacters: countNarrationEffectiveCharacters(segment.text),
      limit,
    }))
    .filter((segment) => segment.effectiveCharacters > segment.limit)
    // Preserve the existing rejection list presentation; parsed input order is untouched.
    .sort((left, right) => left.number - right.number);
  if (overtime.length === 0) return null;
  const details = overtime.map((segment) =>
    `- 第${segment.number}段：${segment.effectiveCharacters}个有效字 / 上限${segment.limit}字 / 请返回效率工具选择${durationSeconds}秒，保持原文逐字不变，重新分段至每段不超过${segment.limit}个有效字`,
  );
  return {
    code: "STORY_DIRECTOR_NARRATION_OVERTIME",
    durationSeconds,
    segments: overtime,
    message: [
      "生成门禁：口播超时，请保持原文逐字不变后重新分段，不得删字、改写或截断",
      ...details,
    ].join("\n"),
  };
}
