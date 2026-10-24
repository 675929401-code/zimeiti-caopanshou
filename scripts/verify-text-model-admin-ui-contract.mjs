import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = process.cwd();
const files = [
  'src/components/unified-model-dialog.tsx',
  'src/components/unified-models-tab.tsx',
  'src/components/admin/PlatformConfigurationReleasePanel.tsx',
];
const source = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
for (let i = 0; i < files.length; i++) {
  const result = ts.transpileModule(source[i], {
    fileName: files[i], reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
  });
  assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, files[i]);
}
const [dialog, tab, release] = source;
assert.match(dialog, /import \{ LLM_PROVIDER_PRESETS, getLlmProviderPreset \}/);
assert.doesNotMatch(dialog, /fetch\("\/api\/admin\/llm-test"/);
for (const label of ['对话模型认证方式', 'Anthropic API 版本', '用户展示名称', '最大回复 Token', '请求超时（秒）', '思考请求策略', '输出上限字段名']) assert.ok(dialog.includes(`aria-label="${label}"`), label);
assert.match(dialog, /<option value="max_completion_tokens">max_completion_tokens<\/option>/);
assert.match(dialog, /output_token_field: "max_tokens"/);
assert.match(dialog, /delete protocolConfig\.output_token_field/);
assert.match(dialog, /form\.max_reply_tokens > form\.max_context_tokens/);
assert.match(dialog, /protocol_version: form\.api_protocol_config\.protocol_version \|\| "2023-06-01"/);
assert.match(tab, /\{ scope: "saved", model_id: model\.id, model_type: "text" \}/);
assert.match(tab, /\{ id: model\.id, model_type: "text" \}/);
assert.match(tab, /textActionLocks\.current\.has\(model\.id\)/);
assert.match(tab, /result\.evidence\?\.evidenceRecorded === true/);
assert.match(tab, /result\.activated === true/);
assert.match(tab, /model\.validation\.fingerprint_current === true/);
assert.match(tab, /model\.is_active !== false && \(model\.model_type !== "text" \|\| model\.user_access === "available"\)/);
assert.match(tab, /const isActive = isOperationalActive\(m\)/);
assert.match(tab, /const activeCount = models\.filter\(m => String\(m\.model_type\) === type && isOperationalActive\(m\)\)/);
assert.match(tab, /m\.user_access === "pending_model_activation"/);
assert.ok(tab.includes('已发布，待验证') && tab.includes('已发布，待启用'));
assert.match(tab, /await loadModels\(\)/);
assert.match(tab, /focusReleaseId=\{focusReleaseId\}/);
assert.match(release, /focusReleaseId\?: string \| null/);
assert.match(release, /setExpanded\(true\)/);
console.log(JSON.stringify({ passed: true, files, networkCalls: 0, verification: 'TSX syntax and administrator request/UI contract only; not browser or provider acceptance' }, null, 2));
