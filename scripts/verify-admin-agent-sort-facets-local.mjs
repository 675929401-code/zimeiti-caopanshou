import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual page handlers with isolated state and a mocked atomic API.
const source = fs.readFileSync('src/app/admin/page.tsx', 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) nodes.set(node.name.text, node.getText(ast));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    nodes.set(node.name.text, `const ${node.name.text} = ${node.initializer.getText(ast)};`);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function run(name, context) {
  assert.ok(nodes.has(name), `missing handler ${name}`);
  const js = ts.transpile(`{ ${nodes.get(name)}\n;globalThis.__handler = ${name}; }`, { target: ts.ScriptTarget.ES2022 });
  vm.runInNewContext(js, context);
  return context.__handler;
}

const agents = [
  { id: 'a', name: 'A', category: 'one', sort_order: 10, config_revision: '2' },
  { id: 'b', name: 'B', category: 'one', sort_order: 20, config_revision: 3 },
  { id: 'c', name: 'C', category: 'one', sort_order: 30, config_revision: 4 },
  { id: 'd', name: 'D', category: 'two', sort_order: 10, config_revision: 5 },
];
let pending = {};
const snapshots = { current: {} };
const messages = [];
const ctx = {
  agents, pendingAgentSortOrders: pending, pendingAgentRevisionsRef: snapshots,
  canDragAgentRows: true, showMessage: (...args) => messages.push(args),
  setPendingAgentSortOrders: update => { pending = typeof update === 'function' ? update(pending) : update; ctx.pendingAgentSortOrders = pending; },
};
const drag = run('handleDragReorderAgent', ctx);
await drag('a', 'c', 'before');
assert.deepEqual(Object.fromEntries(Object.entries(pending)), { b: 10, a: 20, c: 30 });
assert.equal(snapshots.current.a.revision, 2);
assert.equal(pending.d, undefined);
await drag('c', 'b', 'before');
assert.deepEqual(Object.fromEntries(Object.entries(pending)), { b: 20, a: 30, c: 10 });
const before = JSON.stringify(pending);
await drag('a', 'd', 'after');
assert.equal(JSON.stringify(pending), before);
ctx.canDragAgentRows = false;
await drag('a', 'b', 'before');
assert.equal(JSON.stringify(pending), before);

let request;
Object.assign(ctx, {
  hasAgentSearchQuery: false, agentSortSavingRef: { current: false },
  setAgentSortSaving: () => {}, authHeaders: {}, loadAgents: async () => true,
  showSuccessAndSync: () => {},
  fetch: async (url, options) => { request = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ success: true }) }; },
});
await run('handleSaveAgentSortOrders', ctx)();
assert.equal(request.url, '/api/admin/agents/reorder');
assert.deepEqual(request.body.agents.map(x => [x.id, x.expected_revision]), [['c', 4], ['b', 3], ['a', 2]]);
assert.deepEqual(Object.keys(pending), []);
assert.deepEqual(Object.keys(snapshots.current), []);

// A stale or incomplete category must retain the draft; it cannot partly save.
pending = { a: 10, b: 20, c: 30 };
ctx.pendingAgentSortOrders = pending;
snapshots.current = { a: { revision: 2, category: 'one' }, b: { revision: 3, category: 'one' }, c: { revision: 4, category: 'one' } };
ctx.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: '分类不完整' }) });
await run('handleSaveAgentSortOrders', ctx)();
assert.equal(Object.keys(pending).length, 3);
assert.ok(messages.at(-1)[1].includes('分类不完整'));

const payloadCtx = {
  AGENT_EDITABLE_FIELDS: [], comparableAgentValue: () => '', normalizedAgentPresetFields: () => null,
};
const buildPayload = run('buildAgentUpdatePayload', payloadCtx);
assert.equal(buildPayload({ id: 'a' }, { config_revision: '42' }, false).expected_revision, 42);
assert.equal(buildPayload({ id: 'a' }, { config_revision: '9007199254740992' }, false).expected_revision, undefined);
const facetCtx = {
  agents, selectedDisplayCategory: 'display:visual', selectedCategoryId: null,
  categories: [{ id: 'raw-one', name: 'one' }],
  displayCategory: agent => agent.id === 'c' ? 'display:visual' : 'display:other',
};
const filter = run('getCategoryFilteredAgents', facetCtx);
assert.deepEqual(Array.from(filter(), agent => agent.id), ['c']);
facetCtx.selectedDisplayCategory = null;
facetCtx.selectedCategoryId = 'raw-one';
assert.deepEqual(Array.from(filter(), agent => agent.id), ['a', 'b', 'c']);
console.log('PASS admin sorting: insertion, full category, CAS conflict, draft retention, edit revisions');
