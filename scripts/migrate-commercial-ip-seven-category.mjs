import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const apply = process.argv.includes('--apply');
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const targetCategory = '商业定位IP';
const expected = [
  ['agent-1787079707230-h0sdiq', '商业IP定位'],
  ['agent-1787158020109-cj3wnh', '账号主页包装'],
  ['agent-1787163731976-5xntwm', '对标账号拆解'],
  ['agent-1787160182534-uk29g4', '内容选题策划'],
  ['agent-bip-script-2', '短视频文案成稿'],
  ['agent-1787160183236-5fi3w8', '咨询回复与跟进'],
  ['agent-1787160184111-bj5hi3', '运营数据复盘'],
];

const runtime = JSON.parse((await fs.readFile(runtimePath, 'utf8')).replace(/^\uFEFF/u, ''));
const databaseOrigin = new URL(runtime.supabaseUrl).origin;
assert.equal(databaseOrigin, 'http://127.0.0.1:54321', '只允许修改隔离的本地数据库');
assert.ok(runtime.serviceRoleKey, '本地数据库服务凭据缺失');

const headers = {
  apikey: runtime.serviceRoleKey,
  Authorization: `Bearer ${runtime.serviceRoleKey}`,
  'Content-Type': 'application/json; charset=utf-8',
};

async function readAgents() {
  const url = new URL('/rest/v1/agents', databaseOrigin);
  url.searchParams.set('select', 'id,name,category,sort_order,updated_at,deleted_at,is_active,model_id,source,system_prompt,preset_fields,guide_message,avatar');
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json();
  assert.ok(response.ok && Array.isArray(payload), `读取智能体失败：HTTP ${response.status}`);
  return payload.filter((agent) => expected.some(([id]) => id === agent.id));
}

function protectedDigest(agent) {
  const protectedFields = {
    model_id: agent.model_id,
    source: agent.source,
    system_prompt: agent.system_prompt,
    preset_fields: agent.preset_fields,
    guide_message: agent.guide_message,
    avatar: agent.avatar,
  };
  return createHash('sha256').update(JSON.stringify(protectedFields)).digest('hex');
}

async function patchAgent(id, values) {
  const url = new URL('/rest/v1/agents', databaseOrigin);
  url.searchParams.set('id', `eq.${id}`);
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(values),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => []);
  assert.ok(response.ok && Array.isArray(payload) && payload.length === 1, `更新 ${id} 失败：HTTP ${response.status}`);
  return payload[0];
}

const before = await readAgents();
assert.equal(before.length, expected.length, '七个目标智能体必须全部存在');
for (const [id, name] of expected) {
  const agent = before.find((item) => item.id === id);
  assert.ok(agent, `缺少智能体：${name}`);
  assert.equal(agent.name, name, `${id} 名称不匹配`);
  assert.equal(agent.deleted_at, null, `${name} 已在回收站`);
  assert.equal(agent.is_active, true, `${name} 当前未启用`);
}

const snapshot = expected.map(([id]) => {
  const agent = before.find((item) => item.id === id);
  return {
    id: agent.id,
    name: agent.name,
    category: agent.category,
    sort_order: agent.sort_order,
    updated_at: agent.updated_at,
    model_id: agent.model_id,
    source: agent.source,
    protected_digest: protectedDigest(agent),
  };
});

const stamp = new Date().toISOString().replace(/[:.]/gu, '');
const backupDir = path.resolve(`.codex-backups/commercial-ip-seven-category-${stamp}`);
await fs.mkdir(backupDir, { recursive: true });
await fs.writeFile(path.join(backupDir, 'before.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

if (!apply) {
  console.log(JSON.stringify({ applied: false, backupDir, planned: expected.map(([id, name], index) => ({ id, name, category: targetCategory, sort_order: (index + 1) * 10 })) }, null, 2));
  process.exit(0);
}

const changed = [];
try {
  for (let index = 0; index < expected.length; index += 1) {
    const [id, name] = expected[index];
    const updated = await patchAgent(id, {
      category: targetCategory,
      sort_order: (index + 1) * 10,
      updated_at: new Date().toISOString(),
    });
    changed.push({ id, name, category: updated.category, sort_order: updated.sort_order });
  }
} catch (error) {
  for (const item of snapshot.filter((record) => changed.some((entry) => entry.id === record.id)).reverse()) {
    await patchAgent(item.id, { category: item.category, sort_order: item.sort_order });
  }
  throw error;
}

const after = await readAgents();
const verified = expected.map(([id, name], index) => {
  const agent = after.find((item) => item.id === id);
  assert.equal(agent.category, targetCategory, `${name} 分类迁移失败`);
  assert.equal(agent.sort_order, (index + 1) * 10, `${name} 顺序迁移失败`);
  const baseline = snapshot.find((item) => item.id === id);
  assert.equal(agent.model_id, baseline.model_id, `${name} 模型绑定被意外改动`);
  assert.equal(agent.source, baseline.source, `${name} 来源被意外改动`);
  assert.equal(protectedDigest(agent), baseline.protected_digest, `${name} 提示词、资料卡、头像或模型被意外改动`);
  return { id, name, category: agent.category, sort_order: agent.sort_order, model_id: agent.model_id, protected_digest: protectedDigest(agent) };
});
await fs.writeFile(path.join(backupDir, 'after.json'), `${JSON.stringify(verified, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(backupDir, 'result.json'), `${JSON.stringify({ applied: true, targetCategory, verified }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ applied: true, backupDir, verified }, null, 2));
