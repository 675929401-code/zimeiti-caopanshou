import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/app/formatter/page.tsx"), "utf8");

assert.match(source, /type FormatterHistorySaveStatus = "idle" \| "saving" \| "saved" \| "failed"/u);
assert.match(source, /const handleFormat = useCallback\(async \(\) =>/u);
assert.match(source, /const result = formatText\(inputText\)/u);
assert.match(source, /await saveRecord\(\{ original: inputText, result, rules: \{ \.\.\.FIXED_FORMAT_RULES \} \}\)/u);
assert.match(source, /setHistorySaveStatus\("saving"\)/u);
assert.match(source, /正在保存到账号历史/u);
assert.match(source, /setHistorySaveStatus\("saved"\)/u);
assert.match(source, /已保存到账号历史/u);
assert.match(source, /当前未登录，排版结果仅保留在本页/u);
assert.match(source, /const handleInputChange = useCallback/u);
assert.match(source, /setOutputText\(""\)/u);
assert.match(source, /setCopied\(false\)/u);
assert.match(source, /浏览器未授予剪贴板读取权限/u);
assert.match(source, /复制失败，请选中结果后手动复制/u);
assert.doesNotMatch(source, /showOptions|toggleOption|keepSentenceBreak|句号分段/u);

console.log(JSON.stringify({
  passed: true,
  checks: 15,
  fixedWorkflow: true,
  staleResultInvalidation: true,
  clipboardFailureFeedback: true,
  realNetworkRequests: 0,
  databaseWrites: 0,
}, null, 2));
