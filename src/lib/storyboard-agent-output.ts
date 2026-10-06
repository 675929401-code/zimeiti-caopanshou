export type StoryboardAgentOutputSegment = {
  sourceNumber: number;
  narration: string;
  imagePrompt: string;
  videoPrompt: string;
};

export type StoryboardAgentOutputParseResult =
  | { ok: true; segments: StoryboardAgentOutputSegment[] }
  | { ok: false; error: string };

const SEGMENT_HEADING = /^(?:\s*[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*原文案内容段落\s*(\d+)\s*(?:\*\*)?\s*[：:]\s*(.*)$/gmu;
const IMAGE_HEADING = /^(?:\s*[-*]\s*)?(?:\*\*)?[^\n]*故事板[^\n]*生图\s*Prompt[^\n]*(?:\*\*)?\s*[：:]?\s*$/imu;
const VIDEO_HEADING = /^(?:\s*[-*]\s*)?(?:\*\*)?[^\n]*(?:图生视频|视频)\s*Prompt[^\n]*(?:\*\*)?\s*[：:]?\s*$/imu;
const CODE_FENCE = /```(?:text|txt|plaintext)?[ \t]*\r?\n([\s\S]*?)```/giu;

function unwrapNarration(value: string) {
  const narration = value.trim();
  if (narration.startsWith("【") && narration.endsWith("】")) {
    return narration.slice(1, -1).trim();
  }
  return narration;
}

export function parseStoryboardAgentOutput(
  rawOutput: string,
  maxSegments = 20,
): StoryboardAgentOutputParseResult {
  const source = String(rawOutput || "").replace(/^\uFEFF/u, "");
  const headings = Array.from(source.matchAll(SEGMENT_HEADING));

  if (!headings.length) {
    return { ok: false, error: "没有识别到“原文案内容段落 N”，请复制智能体的完整输出" };
  }
  if (headings.length > maxSegments) {
    return { ok: false, error: `一次最多导入 ${maxSegments} 段` };
  }

  const seenNumbers = new Set<number>();
  const segments: StoryboardAgentOutputSegment[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const sourceNumber = Number(heading[1]);
    if (!Number.isInteger(sourceNumber) || sourceNumber < 1) {
      return { ok: false, error: `第 ${index + 1} 个段落编号无效` };
    }
    if (seenNumbers.has(sourceNumber)) {
      return { ok: false, error: `段落编号 ${sourceNumber} 重复` };
    }
    seenNumbers.add(sourceNumber);

    const sectionStart = heading.index ?? 0;
    const sectionEnd = headings[index + 1]?.index ?? source.length;
    const section = source.slice(sectionStart, sectionEnd);
    const imageHeading = IMAGE_HEADING.exec(section);
    const videoHeading = VIDEO_HEADING.exec(section);
    const codeBlocks = Array.from(section.matchAll(CODE_FENCE));

    if (!imageHeading || !videoHeading || codeBlocks.length !== 2) {
      return {
        ok: false,
        error: `第 ${sourceNumber} 段必须包含 1 个生图 text 代码框和 1 个视频 text 代码框`,
      };
    }

    const firstFenceIndex = codeBlocks[0].index ?? -1;
    const secondFenceIndex = codeBlocks[1].index ?? -1;
    if (
      firstFenceIndex < imageHeading.index
      || secondFenceIndex < videoHeading.index
      || secondFenceIndex <= firstFenceIndex
    ) {
      return { ok: false, error: `第 ${sourceNumber} 段的 Prompt 标题或代码框顺序不正确` };
    }

    const headingEnd = heading[0].length;
    const narrationTail = section.slice(headingEnd, imageHeading.index).trim();
    const narration = unwrapNarration([heading[2], narrationTail].filter(Boolean).join("\n"));
    const imagePrompt = codeBlocks[0][1].trim();
    const videoPrompt = codeBlocks[1][1].trim();

    if (!narration) {
      return { ok: false, error: `第 ${sourceNumber} 段缺少原文案内容` };
    }
    if (!imagePrompt || !videoPrompt) {
      return { ok: false, error: `第 ${sourceNumber} 段存在空 Prompt 代码框` };
    }

    segments.push({ sourceNumber, narration, imagePrompt, videoPrompt });
  }

  return { ok: true, segments };
}
