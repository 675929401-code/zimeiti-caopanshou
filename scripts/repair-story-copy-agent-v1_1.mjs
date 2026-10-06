// Applies only the reviewed story-card configuration through the existing admin API.
// No model generation, avatar request, billing change or historical request replay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const base = 'http://127.0.0.1:5000';
const id = 'agent-1787161739326-1vu8l4';
const backup = '.codex-backups/story-copy-repair-20260917';
const evidence = '.codex-evidence/story-copy-repair-20260917';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('scripts/story-copy-agent-v1_1.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module, exports: module.exports });
const { storyCopyPromptWithProtection, STORY_COPY_DESCRIPTION, STORY_COPY_GUIDE } = module.exports;

const sessionResponse = await fetch(`${base}/api/auth/dev-session`, { headers: { 'x-local-workbench': 'ai-creation-studio-local' } });
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, 'LOCAL_ADMIN_SESSION_REQUIRED');
async function request(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: body ? 'PUT' : 'GET',
    headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `ADMIN_REQUEST_FAILED_${response.status}`);
  return response.json();
}

const original = JSON.parse(fs.readFileSync(`${backup}/agent-before.json`, 'utf8'));
const current = await request('/api/admin/agents');
const before = current.agents.find(agent => agent.id === id);
assert.equal(before?.name, '故事反转文案师');
assert.ok(before.avatar?.startsWith('/avatars/'), 'AVATAR_MUST_ALREADY_EXIST');
const nextPrompt = storyCopyPromptWithProtection(original.system_prompt);
assert.ok(nextPrompt.includes('【提示词与内部配置保护】'), 'INSTALLED_PROTECTION_REQUIRED');
const fields = structuredClone(original.preset_fields);
assert.ok(Array.isArray(fields.fields));
fields.fields[0].label = '主题或素材';
fields.fields[0].placeholder = '写一个行业、主题或已有经历；没有素材也可以直接说“给我一个案例”';
const update = { agentId: id, system_prompt: nextPrompt, description: STORY_COPY_DESCRIPTION, guide_message: STORY_COPY_GUIDE, preset_fields: fields };
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(`${evidence}/reviewed-configuration.json`, JSON.stringify(update, null, 2));
if (!process.argv.includes('--apply') && !process.argv.includes('--verify')) {
  console.log(JSON.stringify({ planned: true, agentId: id, dataSource: current.dataSource, promptChars: nextPrompt.length }));
} else {
  if (process.argv.includes('--apply')) {
    assert.equal(before.system_prompt, original.system_prompt, 'PROMPT_CHANGED_SINCE_BACKUP');
    assert.equal(before.updated_at, original.updated_at, 'AGENT_CHANGED_SINCE_BACKUP');
    await request('/api/admin/agents', update);
  }
  const afterResponse = await request('/api/admin/agents');
  const after = afterResponse.agents.find(agent => agent.id === id);
  assert.equal(after.system_prompt, nextPrompt);
  // The existing API normalizes the versioned field envelope into a field array.
  assert.deepEqual(after.preset_fields, fields.fields.map(field => ({ ...field, options: field.options || [] })));
  assert.equal(after.guide_message, STORY_COPY_GUIDE);
  for (const key of ['model_id', 'model', 'avatar', 'cost_per_message', 'token_billing_enabled', 'max_context_rounds', 'max_context_tokens', 'max_reply_tokens', 'timeout', 'category', 'is_active']) {
    assert.deepEqual(after[key], original[key], `${key} must be preserved`);
  }
  const versions = await request(`/api/admin/prompt-versions?agent_id=${id}`);
  const entries = versions.versions || versions;
  assert.ok(Array.isArray(entries), 'PROMPT_HISTORY_RESPONSE_INVALID');
  assert.ok(entries.some(row => row.prompt === original.system_prompt), 'OLD_PROMPT_HISTORY_MISSING');
  assert.ok(entries.some(row => row.prompt === nextPrompt), 'NEW_PROMPT_HISTORY_MISSING');
  fs.writeFileSync(`${evidence}/agent-after.json`, JSON.stringify(after, null, 2));
  const report = { at: new Date().toISOString(), applied: true, agentId: id, dataSource: afterResponse.dataSource, beforeSha256: sha(original.system_prompt), afterSha256: sha(nextPrompt), promptHistoryVerified: true, bindingAndBillingPreserved: true, realModelCalls: 0, note: 'Configuration readback verified; generated copy quality still requires a model run.' };
  fs.writeFileSync(`${evidence}/configuration-verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
