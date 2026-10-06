import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const cases = [];
const ownerUserId = 'fixture-own-user';
const workbenchUserStorageKey = (base, userId) => `${base}:user:${encodeURIComponent(userId)}`;
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const helperSource = await fs.readFile('src/lib/extract-segment-handoff.ts', 'utf8');
const helperModule = { exports: {} };
vm.runInNewContext(compile(helperSource), {
  module: helperModule,
  exports: helperModule.exports,
  sessionStorage: undefined,
  require: id => {
    assert.equal(id, '@/lib/workbench-user-storage');
    return { workbenchUserStorageKey };
  },
});
const { SEGMENTER_HANDOFF_TTL_MS, prepareExtractSegmentDraft, consumeExtractSegmentDraft, clearRetiredSegmenterDraft } = helperModule.exports;

function storage(initial = {}, failAt = 0) {
  const values = new Map(Object.entries(initial));
  let writes = 0;
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      if (++writes === failAt) throw Error('fixture quota');
      values.set(key, value);
    },
    removeItem: key => values.delete(key),
  };
}

const transferKey = workbenchUserStorageKey('segmenter_handoff', ownerUserId);
const retiredKeys = {
  app_state_segmenter_input: '"legacy draft"',
  app_state_segmenter_result: '{"method":"semantic"}',
  app_state_segmenter_duration: '12',
  [`app_state_${workbenchUserStorageKey('segmenter_input', ownerUserId)}`]: '"owned old draft"',
  [`app_state_${workbenchUserStorageKey('segmenter_result', ownerUserId)}`]: '{"method":"rule"}',
  [`app_state_${workbenchUserStorageKey('segmenter_duration', ownerUserId)}`]: '8',
};
const original = { ...retiredKeys, 'production-client-attempt:old': 'keep-original-request', extract_history: 'keep-all-history' };
const text = '第一段口播正文。\n第二段保持原始换行。';
const draft = storage(original);
prepareExtractSegmentDraft(text, ownerUserId, draft);
const storedHandoff = JSON.parse(draft.getItem(transferKey));
assert.equal(storedHandoff.version, 1);
assert.equal(storedHandoff.ownerUserId, ownerUserId);
assert.equal(storedHandoff.text, text);
assert.ok(storedHandoff.expiresAt > Date.now());
assert.ok(storedHandoff.expiresAt <= Date.now() + SEGMENTER_HANDOFF_TTL_MS);
for (const [key, value] of Object.entries(original)) assert.equal(draft.getItem(key), value);
cases.push('handoff writes only one user-scoped transfer key and leaves history plus request identity untouched');

assert.equal(consumeExtractSegmentDraft(ownerUserId, draft), text);
assert.equal(draft.getItem(transferKey), null);
assert.equal(consumeExtractSegmentDraft(ownerUserId, draft), '');
cases.push('handoff preserves exact line breaks, is consumed once, and cannot refill after refresh');

const legacy = storage({ segmenter_handoff: JSON.stringify('legacy unscoped text'), [transferKey]: JSON.stringify(text) });
assert.equal(consumeExtractSegmentDraft(ownerUserId, legacy), '');
assert.equal(legacy.getItem('segmenter_handoff'), null);
assert.equal(legacy.getItem(transferKey), null);
cases.push('legacy raw-string and unscoped handoffs are deleted without restoring creative text');

const expired = storage({ [transferKey]: JSON.stringify({ version: 1, ownerUserId, text, expiresAt: Date.now() - 1 }) });
assert.equal(consumeExtractSegmentDraft(ownerUserId, expired), '');
assert.equal(expired.getItem(transferKey), null);
cases.push('expired handoff is deleted before validation and cannot replay');

clearRetiredSegmenterDraft(ownerUserId, draft);
for (const key of Object.keys(retiredKeys)) assert.equal(draft.getItem(key), null);
assert.equal(draft.getItem('production-client-attempt:old'), original['production-client-attempt:old']);
assert.equal(draft.getItem('extract_history'), original.extract_history);
cases.push('retired segmenter draft keys are removed without touching attempts or extraction history');

for (const value of ['', '  ', null]) {
  const empty = storage(original);
  assert.throws(() => prepareExtractSegmentDraft(value, ownerUserId, empty));
  assert.deepEqual(Object.fromEntries(empty.values), original);
}
cases.push('empty or invalid text leaves storage untouched');

const denied = storage({ ...original, [transferKey]: '"previous transfer"' }, 1);
assert.throws(() => prepareExtractSegmentDraft(text, ownerUserId, denied));
assert.equal(denied.getItem(transferKey), '"previous transfer"');
cases.push('storage failure preserves the prior one-time transfer and exposes an error');

async function historyFixture(file, table, authenticated) {
  const operations = [];
  const filters = [];
  const orders = [];
  let databaseAccesses = 0;
  const data = [{ id: 'own-fixture-record', created_at: '2026-09-15T00:00:00.000Z' }];
  const client = {
    from(actualTable) {
      databaseAccesses += 1;
      assert.equal(actualTable, table);
      const query = {
        delete() { operations.push('delete'); return this; },
        select() { operations.push('select'); return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        lt(key, value) { filters.push([key, value]); return this; },
        gte(key, value) { filters.push([key, value]); return this; },
        order(key, options) { orders.push([key, options]); return this; },
        limit(value) { assert.equal(value, 100); return this; },
        then(resolve) { return Promise.resolve({ data, error: null }).then(resolve); },
      };
      return query;
    },
  };
  const routeSource = await fs.readFile(file, 'utf8');
  const compiledModule = { exports: {} };
  vm.runInNewContext(compile(routeSource), {
    module: compiledModule,
    exports: compiledModule.exports,
    Headers,
    Response,
    require: id => {
      if (id === 'next/server') return { NextResponse: { json: (body, init = {}) => Response.json(body, init) } };
      if (id === '@/lib/current-api-user') return {
        authorizeCurrentApiUser: async () => authenticated
          ? { ok: true, user: { userId: ownerUserId } }
          : { ok: false, response: Response.json({ error: '未授权' }, { status: 401 }) },
      };
      if (id === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => client };
      if (id === '@/lib/text-history-validation') return {};
      throw Error(`unexpected dependency ${id}`);
    },
  });
  const response = await compiledModule.exports.GET({ headers: new Headers() });
  return { operations, filters, orders, databaseAccesses, response };
}

for (const spec of [
  { name: 'formatter', table: 'formatter_history', file: 'src/app/api/formatter/history/route.ts' },
  { name: 'segmenter', table: 'segmenter_history', file: 'src/app/api/segmenter/history/route.ts' },
]) {
  const owned = await historyFixture(spec.file, spec.table, true);
  assert.equal(owned.response.status, 200);
  assert.deepEqual(owned.operations, ['select']);
  assert.ok(owned.filters.some(([key, value]) => key === 'user_id' && value === ownerUserId));
  assert.equal(owned.filters.some(([key]) => key === 'created_at'), false);
  assert.equal(owned.orders.length, 1);
  assert.equal(owned.orders[0][0], 'created_at');
  assert.equal(owned.orders[0][1]?.ascending, false);
  cases.push(`${spec.name} history GET is owner-scoped, newest-first, bounded, and never mutates or hides older records`);

  const anonymous = await historyFixture(spec.file, spec.table, false);
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.databaseAccesses, 0);
  cases.push(`${spec.name} anonymous history request is rejected before database access`);
}

const report = {
  passed: true,
  scenarios: cases.length,
  cases,
  oneTimeUserScopedHandoff: true,
  retiredDraftMemoryCleared: true,
  formatterAndSegmenterHistoryReadOnly: true,
  realDatabaseWrites: 0,
  externalRequests: 0,
};
const out = path.resolve('.codex-evidence/toolbox-fresh-history-r217/handoff-history-fixture.json');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
