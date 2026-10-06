import {
  countChars,
  normalizeForIntegrity,
  reconstructSegmentedText,
} from "@/lib/segmenter-core";

export const TEXT_HISTORY_LIMITS = Object.freeze({
  titleChars: 200,
  originalTextChars: 100_000,
  resultTextChars: 500_000,
  rulesJsonChars: 16_384,
  segmentCount: 5_000,
});

export type TextHistoryValidationError = {
  ok: false;
  code: string;
  message: string;
};

export type TextHistoryValidationSuccess<T> = {
  ok: true;
  value: T;
};

export type TextHistoryValidationResult<T> =
  | TextHistoryValidationSuccess<T>
  | TextHistoryValidationError;

function invalid(code: string, message: string): TextHistoryValidationError {
  return { ok: false, code, message };
}

export function validateRequiredHistoryText(
  value: unknown,
  label: string,
  maxChars: number,
): TextHistoryValidationResult<string> {
  if (typeof value !== "string" || !value.trim()) {
    return invalid("HISTORY_TEXT_REQUIRED", `${label}不能为空`);
  }
  if (value.length > maxChars) {
    return invalid("HISTORY_TEXT_TOO_LARGE", `${label}不能超过 ${maxChars.toLocaleString("zh-CN")} 字符`);
  }
  return { ok: true, value };
}

export function validateHistoryTitle(value: unknown): TextHistoryValidationResult<string | null> {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return invalid("HISTORY_TITLE_INVALID", "标题格式不正确");
  const title = value.trim();
  if (title.length > TEXT_HISTORY_LIMITS.titleChars) {
    return invalid("HISTORY_TITLE_TOO_LARGE", `标题不能超过 ${TEXT_HISTORY_LIMITS.titleChars} 字符`);
  }
  return { ok: true, value: title || null };
}

export function validateHistoryRules(value: unknown): TextHistoryValidationResult<Record<string, unknown>> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalid("HISTORY_RULES_INVALID", "排版或分段规则格式不正确");
  }

  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalid("HISTORY_RULES_INVALID", "排版或分段规则格式不正确");
  }
  if (serialized.length > TEXT_HISTORY_LIMITS.rulesJsonChars) {
    return invalid("HISTORY_RULES_TOO_LARGE", "排版或分段规则内容过大");
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export function getFormatterHistoryStats(resultText: string) {
  return {
    charCount: resultText.length,
    lineCount: resultText ? resultText.split(/\r\n|\r|\n/).length : 0,
  };
}

export function getSegmenterHistoryStats(
  originalText: string,
  resultText: string,
): TextHistoryValidationResult<{ charCount: number; segmentCount: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return invalid("HISTORY_RESULT_INVALID", "分段结果格式不正确");
  }
  if (
    parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && (parsed as { method?: unknown }).method === "semantic_fallback"
  ) {
    return invalid(
      "SEMANTIC_FALLBACK_NOT_SUCCESS_HISTORY",
      "语义模型未成功，本次规则结果不会记为语义成功历史；可在分段页明确重新提交。",
    );
  }
  const segments = parsed && typeof parsed === "object"
    ? (parsed as { segments?: unknown }).segments
    : undefined;
  if (!Array.isArray(segments) || segments.length === 0
    || segments.some((item) => typeof item !== "string" || !item.trim())) {
    return invalid("HISTORY_RESULT_INVALID", "分段结果缺少有效的分段列表");
  }
  if (segments.length > TEXT_HISTORY_LIMITS.segmentCount) {
    return invalid("HISTORY_RESULT_TOO_LARGE", `分段数量不能超过 ${TEXT_HISTORY_LIMITS.segmentCount}`);
  }
  const counts = (parsed as { counts?: unknown }).counts;
  const computedCounts = segments.map(segment => countChars(segment));
  if (!Array.isArray(counts) || counts.length !== segments.length
    || counts.some((item, index) => !Number.isInteger(item) || item < 0 || item !== computedCounts[index])) {
    return invalid("HISTORY_RESULT_INVALID", "分段结果的字数统计不完整");
  }
  const compliant = (parsed as { compliant?: unknown }).compliant;
  if (!Array.isArray(compliant) || compliant.length !== segments.length
    || compliant.some((item) => typeof item !== "boolean")) {
    return invalid("HISTORY_RESULT_INVALID", "分段结果的范围状态不完整");
  }
  const paragraphBreakBefore = (parsed as { paragraphBreakBefore?: unknown }).paragraphBreakBefore;
  if (!Array.isArray(paragraphBreakBefore)
    || paragraphBreakBefore.length !== segments.length
    || paragraphBreakBefore.some((item) => typeof item !== "boolean")
  ) {
    return invalid("HISTORY_RESULT_INVALID", "分段结果的段落边界格式不正确");
  }
  const overlapPrefixes = (parsed as { overlapPrefixes?: unknown }).overlapPrefixes;
  if (overlapPrefixes !== undefined && (
    !Array.isArray(overlapPrefixes)
    || overlapPrefixes.length !== segments.length
    || overlapPrefixes.some((item) => typeof item !== "string")
  )) {
    return invalid("HISTORY_RESULT_INVALID", "分段结果的衔接信息不完整");
  }
  const reconstructed = reconstructSegmentedText(
    segments,
    Array.isArray(overlapPrefixes) ? overlapPrefixes : [],
  );
  if (normalizeForIntegrity(reconstructed) !== normalizeForIntegrity(originalText)) {
    return invalid("HISTORY_RESULT_MISMATCH", "分段结果与原文不一致，请重新分段");
  }
  return {
    ok: true,
    value: {
      charCount: countChars(originalText),
      segmentCount: segments.length,
    },
  };
}
