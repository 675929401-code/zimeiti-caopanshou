import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  agentConfigCache,
  invalidateAgentConfigCache,
} from '../src/app/api/llm/llm-state';

const targetAgentId = 'agent-cache-invalidation-target';
const neighborAgentId = 'agent-cache-invalidation-neighbor';
const promptSentinel = ['PRIVATE', 'SYSTEM', 'PROMPT', 'SENTINEL'].join('_');

agentConfigCache.clear();
agentConfigCache.set(targetAgentId, {
  data: { name: '旧名称', system_prompt: promptSentinel },
  expiry: Date.now() + 60_000,
});
agentConfigCache.set(neighborAgentId, {
  data: { name: '相邻智能体' },
  expiry: Date.now() + 60_000,
});

assert.equal(invalidateAgentConfigCache(targetAgentId), true, '目标智能体缓存必须被删除');
assert.equal(agentConfigCache.has(targetAgentId), false, '下一次 LLM 请求不能命中旧配置');
assert.equal(agentConfigCache.has(neighborAgentId), true, '按 ID 失效不得清空其他智能体缓存');
assert.equal(invalidateAgentConfigCache(targetAgentId), false, '重复失效应保持幂等');

const routeSource = readFileSync(resolve(process.cwd(), 'src/app/api/admin/agents/route.ts'), 'utf8');
assert.match(
  routeSource,
  /import \{ invalidateAgentConfigCache \} from '@\/app\/api\/llm\/llm-state';/u,
  '后台智能体路由必须导入 LLM 缓存失效函数',
);

const updateStart = routeSource.indexOf('// PUT - Update agent');
const deleteStart = routeSource.indexOf('// DELETE - Delete agent');
assert.ok(updateStart >= 0 && deleteStart > updateStart, '必须能定位智能体更新处理器');
const updateSource = routeSource.slice(updateStart, deleteStart);
const successfulWrite = updateSource.indexOf(".update(fields)");
const invalidation = updateSource.indexOf('invalidateAgentConfigCache(agentId);');
const successResponse = updateSource.lastIndexOf(
  'return NextResponse.json({ success: true, agent: publicAgent(data as Record<string, unknown>) });',
);
assert.ok(successfulWrite >= 0, '更新处理器必须写入 agents 表');
assert.ok(invalidation > successfulWrite, '仅可在数据库更新路径之后失效运行缓存');
assert.ok(successResponse > invalidation, '成功响应前必须完成运行缓存失效');

assert.match(
  routeSource,
  /options: \{ includeConfiguration\?: boolean; includePrompt\?: boolean \} = \{\}/u,
  '公开响应必须默认不包含系统提示词',
);
assert.match(
  routeSource,
  /\.\.\.\(options\.includePrompt \? \{ system_prompt: agent\.system_prompt \|\| '' \} : \{\}\)/u,
  '只有显式授权的 includePrompt 读取路径可以返回系统提示词',
);
assert.doesNotMatch(
  successResponse >= 0 ? updateSource.slice(invalidation, successResponse) : updateSource,
  /system_prompt\s*:/u,
  '缓存失效到更新成功响应之间不得拼入系统提示词明文',
);

agentConfigCache.clear();

process.stdout.write(JSON.stringify({
  ok: true,
  assertions: 12,
  targetInvalidated: true,
  neighborPreserved: true,
  promptReturnedByMutation: false,
}) + '\n');

// llm-state keeps the application cleanup timer alive; this standalone verifier
// has completed all assertions and must not wait for that production interval.
process.exit(0);
