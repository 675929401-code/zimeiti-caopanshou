import assert from "node:assert/strict";
import {
  getFormatterHistoryStats,
  getSegmenterHistoryStats,
  TEXT_HISTORY_LIMITS,
  validateHistoryRules,
  validateHistoryTitle,
  validateRequiredHistoryText,
} from "../src/lib/text-history-validation";

const checks: string[] = [];
const verify = (name: string, run: () => void) => {
  run();
  checks.push(name);
};

verify("明确的 100000 字符原文可保存", () => {
  assert.equal(validateRequiredHistoryText("字".repeat(TEXT_HISTORY_LIMITS.originalTextChars), "原文", TEXT_HISTORY_LIMITS.originalTextChars).ok, true);
});
verify("超限原文失败关闭", () => {
  const result = validateRequiredHistoryText("字".repeat(TEXT_HISTORY_LIMITS.originalTextChars + 1), "原文", TEXT_HISTORY_LIMITS.originalTextChars);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "HISTORY_TEXT_TOO_LARGE");
});
verify("空白原文被拒绝", () => {
  assert.equal(validateRequiredHistoryText("  \n", "原文", 100).ok, false);
});
verify("标题类型与长度受限", () => {
  assert.equal(validateHistoryTitle(42).ok, false);
  assert.equal(validateHistoryTitle("题".repeat(TEXT_HISTORY_LIMITS.titleChars + 1)).ok, false);
  assert.deepEqual(validateHistoryTitle("  标题  "), { ok: true, value: "标题" });
});
verify("规则必须是有限 JSON 对象", () => {
  assert.equal(validateHistoryRules([]).ok, false);
  assert.equal(validateHistoryRules({ content: "x".repeat(TEXT_HISTORY_LIMITS.rulesJsonChars) }).ok, false);
  assert.equal(validateHistoryRules({ removeExtraSpaces: true }).ok, true);
});
verify("排版统计由结果文本计算并兼容 CRLF", () => {
  assert.deepEqual(getFormatterHistoryStats("第一行\r\n第二行\n第三行"), { charCount: 12, lineCount: 3 });
});
verify("分段统计忽略客户端伪造值", () => {
  const result = getSegmenterHistoryStats("一二三123", JSON.stringify({
    segments: ["一二", "三123"],
    counts: [2, 4],
    compliant: [false, true],
    paragraphBreakBefore: [false, false],
    overlapPrefixes: ["", ""],
  }));
  assert.deepEqual(result, { ok: true, value: { charCount: 6, segmentCount: 2 } });
});
verify("损坏或超量的分段结果被拒绝", () => {
  assert.equal(getSegmenterHistoryStats("文本", "not-json").ok, false);
  assert.equal(getSegmenterHistoryStats("文本", JSON.stringify({ segments: [1] })).ok, false);
  assert.equal(getSegmenterHistoryStats("文本", JSON.stringify({ segments: [] })).ok, false);
  assert.equal(getSegmenterHistoryStats("文本", JSON.stringify({ segments: [""] })).ok, false);
  assert.equal(getSegmenterHistoryStats("文本", JSON.stringify({ segments: ["一段"], paragraphBreakBefore: [] })).ok, false);
  assert.equal(getSegmenterHistoryStats("文本", JSON.stringify({ segments: Array(TEXT_HISTORY_LIMITS.segmentCount + 1).fill("段") })).ok, false);
  assert.equal(getSegmenterHistoryStats("原文", JSON.stringify({
    segments: ["别的结果"],
    counts: [4],
    compliant: [true],
    paragraphBreakBefore: [false],
  })).ok, false);
  assert.equal(getSegmenterHistoryStats("原文", JSON.stringify({
    segments: ["原文"],
    counts: [99],
    compliant: [true],
    paragraphBreakBefore: [false],
  })).ok, false);
});
verify("语义失败的规则 fallback 不会写入普通成功历史", () => {
  const result = getSegmenterHistoryStats("原文", JSON.stringify({
    method: "semantic_fallback",
    segments: ["原文"],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "SEMANTIC_FALLBACK_NOT_SUCCESS_HISTORY");
});

console.log(JSON.stringify({ passed: true, count: checks.length, checks }, null, 2));
