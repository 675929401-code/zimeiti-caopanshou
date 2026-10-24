import {
  StoryboardVisualAssetPlanSchema,
  StoryboardVisualAssetRefSchema,
  type StoryboardVisualAssetRef,
  type StoryboardBottomPanelRole,
  type StoryboardQualityCheck,
  type StoryboardWardrobeChangeEvent,
} from "./storyboard-workbench";

type StoryboardVisualAssetPlan = ReturnType<typeof StoryboardVisualAssetPlanSchema.parse>;

export type StoryboardAgentOutputSegment = {
  sourceNumber: number;
  narration: string;
  imagePrompt: string;
  videoPrompt: string;
  targetDurationSeconds?: 8 | 10 | 15;
  styleLock?: string;
  sceneLock?: string;
  bottomPanelRole?: StoryboardBottomPanelRole;
  qualityChecks?: StoryboardQualityCheck[];
  wardrobeChangeEvents?: StoryboardWardrobeChangeEvent[];
  visualAssetRefs?: StoryboardVisualAssetRef[];
  sceneId?: string;
  sceneZone?: string;
  camera?: string;
  dynamicState?: string[];
  capabilityGaps?: string[];
};

export type StoryboardAgentOutputParseResult =
  | {
      ok: true;
      segments: StoryboardAgentOutputSegment[];
      visualAssetPlan?: StoryboardVisualAssetPlan;
    }
  | { ok: false; error: string };

// Keep the duration marker in the heading grammar, so “10秒” can never become
// a narration value. Both the old and the formatter headings are accepted.
const SEGMENT_HEADING =
  /^(?:\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*)(?:(?:原文案内容段落)\s*(\d+)|(?:片段)\s*(\d+)\s*(?:[·•]\s*\d+\s*秒\s*\+\s*口播)?)(?:\s*(?:\*\*)?)\s*(?:[：:]\s*(.*?))?\s*$/gimu;
const IMAGE_HEADING =
  /^(?:\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*)[^\n]*(?:故事板[^\n]*)?(?:生图|图片|image)\s*(?:Prompt|提示词)[^\n]*(?:\*\*)?\s*[：:]?\s*$/imu;
const VIDEO_HEADING =
  /^(?:\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*)?\s*)[^\n]*(?:图生视频|视频|video)\s*(?:Prompt|提示词)[^\n]*(?:\*\*)?\s*[：:]?\s*$/imu;
const CODE_FENCE = /```(?:text|txt|plaintext)?[ \t]*\r?\n([\s\S]*?)```/giu;
const ASSET_PACKAGE_FENCE = /```storyboard-assets[ \t]*\r?\n([\s\S]*?)```/giu;

function unwrapNarration(value: string) {
  const narration = value.trim();
  if (narration.startsWith("【") && narration.endsWith("】")) {
    return narration.slice(1, -1).trim();
  }
  return narration;
}

function schemaError(prefix: string, issues: { path: PropertyKey[]; message: string }[]) {
  const detail = issues
    .map((issue) => {
      const path = issue.path.length ? ` (${issue.path.join(".")})` : "";
      return `${issue.message}${path}`;
    })
    .join("；");
  return `${prefix}${detail ? `：${detail}` : ""}`;
}

function parseAssetPackage(source: string) {
  const packages = Array.from(source.matchAll(ASSET_PACKAGE_FENCE));
  if (packages.length > 1) {
    return { ok: false as const, error: "storyboard-assets 机器包只能出现一次" };
  }
  if (!packages.length) {
    return { ok: true as const, present: false as const };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(packages[0][1].trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 无法解析";
    return { ok: false as const, error: `storyboard-assets 机器包 JSON 无效：${message}` };
  }

  // The canonical payload is the plan itself. Accept the named wrapper for
  // older formatter revisions while still validating the complete payload.
  const candidate =
    payload && typeof payload === "object" && "visualAssetPlan" in payload
      ? (payload as { visualAssetPlan: unknown }).visualAssetPlan
      : payload;
  const parsed = StoryboardVisualAssetPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false as const, error: schemaError("storyboard-assets 机器包结构无效", parsed.error.issues) };
  }

  const ids = new Set<string>();
  for (const asset of parsed.data.assets) {
    if (ids.has(asset.id)) {
      return { ok: false as const, error: `storyboard-assets 机器包中的 asset id 重复：${asset.id}` };
    }
    ids.add(asset.id);
  }
  return { ok: true as const, present: true as const, plan: parsed.data, assetIds: ids };
}

function parseVisualAssetRefs(section: string, sourceNumber: number, assetIds: Set<string>) {
  const marker = /^\s*(?:视觉资产引用|Visual\s+asset\s+refs?)\s*[：:]\s*(.+?)\s*$/imu.exec(section);
  if (!marker) return { ok: true as const, present: false as const };

  let payload: unknown;
  try {
    payload = JSON.parse(marker[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 无法解析";
    return { ok: false as const, error: `第 ${sourceNumber} 段视觉资产引用 JSON 无效：${message}` };
  }
  if (!Array.isArray(payload)) {
    return { ok: false as const, error: `第 ${sourceNumber} 段视觉资产引用必须是 JSON 数组` };
  }
  const parsed = payload.map((item) => StoryboardVisualAssetRefSchema.safeParse(item));
  const failed = parsed.find((item) => !item.success);
  if (failed && !failed.success) {
    return { ok: false as const, error: schemaError(`第 ${sourceNumber} 段视觉资产引用结构无效`, failed.error.issues) };
  }
  const refs = parsed.map((item) => (item as { success: true; data: StoryboardVisualAssetRef }).data);
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.assetId)) {
      return { ok: false as const, error: `第 ${sourceNumber} 段视觉资产引用重复：${ref.assetId}` };
    }
    seen.add(ref.assetId);
    if (!assetIds.has(ref.assetId)) {
      return { ok: false as const, error: `第 ${sourceNumber} 段引用了未知视觉资产：${ref.assetId}` };
    }
  }
  return { ok: true as const, present: true as const, refs };
}

function narrationFromSection(headingNarration: string, section: string, headingLength: number, imageIndex: number) {
  const inline = unwrapNarration(headingNarration);
  if (inline) return inline;

  // Only an explicit label is accepted when the narration is on a following
  // line; prose such as “多维拆解：…” is never guessed as narration.
  const labelled = /(?:^|\n)\s*(?:口播|原文案|narration)\s*[：:]\s*([^\n]+(?:\n(?!\s*(?:视觉资产引用|多维拆解|故事板|图生视频|视频|图片|生图)\b)[^\n]+)*)/imu.exec(
    section.slice(headingLength, imageIndex),
  );
  return labelled ? unwrapNarration(labelled[1]) : "";
}

export function parseStoryboardAgentOutput(rawOutput: string, maxSegments = 20): StoryboardAgentOutputParseResult {
  const source = String(rawOutput || "").replace(/^\uFEFF/u, "");
  const assetPackage = parseAssetPackage(source);
  if (!assetPackage.ok) return assetPackage;

  const headings = Array.from(source.matchAll(SEGMENT_HEADING));
  if (!headings.length) {
    return { ok: false, error: "没有识别到“原文案内容段落 N”或“片段 N · 10秒+口播”，请复制智能体的完整输出" };
  }
  if (headings.length > maxSegments) {
    return { ok: false, error: `一次最多导入 ${maxSegments} 段` };
  }

  const seenNumbers = new Set<number>();
  const segments: StoryboardAgentOutputSegment[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const sourceNumber = Number(heading[1] || heading[2]);
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
      return { ok: false, error: `第 ${sourceNumber} 段必须包含 1 个图片/生图 Prompt 代码框和 1 个视频 Prompt 代码框` };
    }

    const imageHeadingIndex = imageHeading.index ?? -1;
    const videoHeadingIndex = videoHeading.index ?? -1;
    const firstFenceIndex = codeBlocks[0].index ?? -1;
    const secondFenceIndex = codeBlocks[1].index ?? -1;
    if (
      imageHeadingIndex < 0 ||
      videoHeadingIndex < 0 ||
      imageHeadingIndex >= videoHeadingIndex ||
      firstFenceIndex < imageHeadingIndex ||
      secondFenceIndex < videoHeadingIndex ||
      secondFenceIndex <= firstFenceIndex
    ) {
      return { ok: false, error: `第 ${sourceNumber} 段必须先出现图片 Prompt，再出现视频 Prompt，且代码框顺序一致` };
    }

    const narration = narrationFromSection(heading[3] || "", section, heading[0].length, imageHeadingIndex);
    const imagePrompt = codeBlocks[0][1].trim();
    const videoPrompt = codeBlocks[1][1].trim();
    if (!narration) return { ok: false, error: `第 ${sourceNumber} 段缺少原文案内容` };
    if (!imagePrompt || !videoPrompt) return { ok: false, error: `第 ${sourceNumber} 段存在空 Prompt 代码框` };

    const styleMarker = /(?:^|\n)\s*(?:风格锁|style[_ -]?lock)\s*[：:]\s*([^\n]+)/imu.exec(section);
    const sceneMarker = /(?:^|\n)\s*(?:场景锁|scene[_ -]?lock)\s*[：:]\s*([^\n]+)/imu.exec(section);
    const styleLock = styleMarker?.[1]?.trim();
    const sceneLock = sceneMarker?.[1]?.trim();
    if (styleLock && (styleLock.length < 20 || styleLock.length > 500)) {
      return { ok: false, error: `第 ${sourceNumber} 段风格锁长度必须为 20 至 500 字` };
    }
    if (sceneLock && (sceneLock.length < 12 || sceneLock.length > 500)) {
      return { ok: false, error: `第 ${sourceNumber} 段场景锁长度必须为 12 至 500 字` };
    }
    const segment: StoryboardAgentOutputSegment = {
      sourceNumber,
      narration,
      imagePrompt,
      videoPrompt,
      ...(styleLock ? { styleLock } : {}),
      ...(sceneLock ? { sceneLock } : {}),
    };
    if (assetPackage.present) {
      const refs = parseVisualAssetRefs(section, sourceNumber, assetPackage.assetIds);
      if (!refs.ok) return refs;
      if (refs.present) segment.visualAssetRefs = refs.refs;
    }
    segments.push(segment);
  }

  return assetPackage.present ? { ok: true, segments, visualAssetPlan: assetPackage.plan } : { ok: true, segments };
}
