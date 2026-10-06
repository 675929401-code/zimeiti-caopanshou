// 通过与后台编辑器相同的管理 API 保存一个智能体的模型绑定并做数据库回读。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/+$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || '').trim();
assert.equal(origin, 'http://127.0.0.1:5000', 'exact local runtime required');
assert.ok(token && stepUp, 'admin step-up session required');
const agentId = process.argv.find((value) => value.startsWith('--agent-id='))?.slice(11) || '';
const modelName = process.argv.find((value) => value.startsWith('--model='))?.slice(8) || '';
assert.ok(agentId && modelName && process.argv.includes('--save'), 'agent, model and explicit --save required');
const headers = { Authorization: `Bearer ${token}`, 'x-admin-step-up': stepUp, 'Content-Type': 'application/json' };

async function request(route, body) {
  const response = await fetch(`${origin}${route}`, {
    method: body ? 'PUT' : 'GET', headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store', signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${route}:HTTP_${response.status}:${data.code || data.error || 'unknown'}`);
  return data;
}

const [agentsPayload, modelsPayload] = await Promise.all([
  request('/api/admin/agents?include_configuration=1'),
  request('/api/llm-models?admin=1'),
]);
const before = agentsPayload.agents?.find((entry) => String(entry.id) === agentId);
const target = modelsPayload.models?.find((entry) => String(entry.model_name) === modelName);
assert.ok(before, 'agent not found');
assert.ok(target?.id, 'target model not found');
const saved = String(before.model_id) === String(target.id)
  ? { success: true, unchanged: true }
  : await request('/api/admin/agents', { agentId, model_id: target.id });
const readbackPayload = await request('/api/admin/agents?include_configuration=1');
const after = readbackPayload.agents?.find((entry) => String(entry.id) === agentId);
assert.equal(String(after?.model_id), String(target.id), 'agent model id readback mismatch');
assert.equal(String(after?.model), String(target.model_name), 'agent canonical model name readback mismatch');
const report = {
  checkedAt: new Date().toISOString(),
  agent: { id: agentId, name: after.name },
  before: { modelId: before.model_id, model: before.model },
  target: { modelId: target.id, model: target.model_name },
  changed: String(before.model_id) !== String(target.id),
  saveAcknowledged: saved.success !== false,
  readbackMatched: true,
  providerRequests: 0,
  paidGenerationRequests: 0,
};
const output = path.resolve('.codex-evidence/story-director-ab-20261005/high-energy-agent-model-binding-20261006.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
