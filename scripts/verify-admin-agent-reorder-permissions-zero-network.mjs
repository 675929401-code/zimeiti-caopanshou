import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const compile = (file) => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const visibilityModule = { exports: {} };
new Function('module', 'exports', compile('src/lib/admin-agent-catalog-visibility.ts'))(visibilityModule, visibilityModule.exports);

let state;
const json = (body, init = {}) => Response.json(body, init);
const client = {
  from(table) {
    return {
      select() {
        if (table === 'categories') return { in: async () => ({ data: state.categories, error: state.categoryError }) };
        return {
          in: () => ({ is: async () => ({ data: state.agents, error: null }) }),
          is: async () => ({ data: state.completeRows, error: null }),
        };
      },
    };
  },
  async rpc(name, payload) { state.rpc.push({ name, payload }); return { data: { updated: state.agents.length }, error: null }; },
};
const dependencies = {
  'next/server': { NextResponse: { json } },
  '@/storage/database/supabase-client': { getSupabaseClient: () => client },
  '@/lib/server/admin-governance-authority': {
    authorizeAdminCapability: async (_request, capability) => {
      state.auth.push(capability);
      return capability === 'internal_tools.manage' && !state.internal
        ? { ok: false, response: json({ error: 'denied' }, { status: 403 }) }
        : { ok: true };
    },
  },
  '@/lib/bots-cache': { invalidateBotsCache: () => {} },
  '@/app/api/llm/llm-state': { invalidateAgentConfigCache: () => {} },
  '@/lib/admin-agent-catalog-visibility': visibilityModule.exports,
  '@/lib/server/agent-config-cas': {
    parseExpectedAgentRevision: value => Number.isSafeInteger(value.expected_revision) ? value.expected_revision : null,
    agentRevisionConflict: () => json({ error: 'revision conflict' }, { status: 409 }),
    agentBatchConflict: body => json(body, { status: 409 }),
    isAgentBatchConflict: () => false,
  },
};
const route = { exports: {} };
new Function('require', 'module', 'exports', compile('src/app/api/admin/agents/reorder/route.ts'))(
  name => { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`); return dependencies[name]; },
  route, route.exports,
);
function reset({ category = '公开', visibility = 'normal', active = true, access = 'available', internal = false, missing = false, categoryError = null } = {}) {
  state = {
    agents: [{ id: 'a', category, user_access: access, config_revision: 3 }],
    completeRows: [{ id: 'a', category }],
    categories: missing ? [] : [{ name: category || '通用', visibility, is_active: active }],
    categoryError, internal, auth: [], rpc: [],
  };
}
const invoke = () => route.exports.PUT({ json: async () => ({ agents: [{ id: 'a', expected_revision: 3 }] }) });
reset();
assert.equal((await invoke()).status, 200);
assert.deepEqual(state.auth, ['agents.manage']);
assert.equal(state.rpc.length, 1);

for (const options of [
  { visibility: 'private' }, { active: false }, { active: null }, { missing: true },
  { category: '自用' }, { access: 'hidden' }, { category: '   ' },
]) {
  reset(options);
  assert.equal((await invoke()).status, 403, JSON.stringify(options));
  assert.deepEqual(state.auth, ['agents.manage', 'internal_tools.manage']);
  assert.equal(state.rpc.length, 0);
  reset({ ...options, internal: true });
  assert.equal((await invoke()).status, 200, JSON.stringify(options));
  assert.equal(state.rpc.length, 1);
}
reset({ categoryError: { message: 'offline' }, internal: true });
assert.equal((await invoke()).status, 500);
assert.equal(state.rpc.length, 0);
reset({ visibility: 'private' });
state.completeRows.push({ id: 'b', category: '公开' });
assert.equal((await invoke()).status, 403, 'Internal authorization precedes category completeness disclosure');
assert.equal(state.rpc.length, 0);
reset();
state.completeRows.push({ id: 'b', category: '公开' });
assert.equal((await invoke()).status, 409);
assert.equal(state.rpc.length, 0);
reset();
state.agents[0].config_revision = 4;
assert.equal((await invoke()).status, 409);
assert.equal(state.rpc.length, 0);
console.log('PASS reorder route visibility, denied access, category failure, CAS conflict: no network');
