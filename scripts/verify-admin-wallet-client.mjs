#!/usr/bin/env node
// Execute the actual client module and admin callbacks against isolated HTTP/storage fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = fs.readFileSync(path.join(root, 'src/lib/admin-wallet-client.ts'), 'utf8');
const current = path.join(root, 'src/app/admin/page.tsx');
const before = path.join(root, '.codex-backups/20260902-admin-wallet-browser/page.tsx');
const cases = [];
const input = { adminId: 'fixture-admin', kind: 'cash_topup', payload: { userId: 'fixture-user', amount: 50, description: '管理员充值 ¥50' }, headers: {} };
const unknown = () => Response.json({ outcome: 'unknown', error: 'synthetic unknown' }, { status: 503 });
const denied = () => Response.json({ outcome: 'not_applied', code: 'ADMIN_WALLET_MIGRATION_NOT_READY', error: 'synthetic preflight' }, { status: 503 });
const success = body => Response.json({ success: true, idempotencyKey: body.idempotencyKey, operationId: '123', balanceBefore: 2, balanceAfter: 52, delta: 50 });

function harness({ store = new Map(), respond = success, brokenStorage = false, locks } = {}) {
  const compiledModule = { exports: {} };
  const requests = [];
  const effects = { messages: [], syncs: 0, loads: 0, pending: [] };
  let sequence = 0;
  const context = vm.createContext({
    module: compiledModule, exports: compiledModule.exports, Response, Error, Math, Number, JSON, Date,
    crypto: { randomUUID: () => `fixture-key-${++sequence}` }, navigator: locks ? { locks } : {},
    window: { localStorage: {
      getItem: key => store.get(key) ?? null,
      setItem(key, value) { if (brokenStorage) throw new Error('fixture storage full'); store.set(key, value); },
      removeItem: key => store.delete(key),
    } },
    fetch: async (url, options) => {
      const request = { url, method: options.method, body: JSON.parse(options.body), key: options.headers['Idempotency-Key'] };
      requests.push(request);
      return respond(request.body, request);
    },
    users: [{ id: 'fixture-user', name: 'fixture', role: 'student' }], userInfo: { id: 'fixture-admin' },
    isFixtureUser: () => false, cashTopupUserId: 'fixture-user', cashTopupAmount: 50,
    rechargeUserId: 'fixture-user', rechargeYuan: 1, bonusCredits: 0, settings: { credits_per_yuan: 50 },
    adjustUserId: 'fixture-user', adjustCredits: 50, authHeaders: {}, walletBusyRef: { current: false },
    setWalletBusy() {}, setPendingWalletAttempts(value) { effects.pending = value; },
    showMessage(type, text) { effects.messages.push({ type, text }); },
    showSuccessAndSync() { effects.syncs += 1; }, loadUsers: async () => { effects.loads += 1; },
    setCashTopupUserId() {}, setCashTopupAmount() {}, setRechargeUserId() {}, setBonusCredits() {}, setAdjustUserId() {}, setAdjustCredits() {},
  });
  vm.runInContext(ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  Object.assign(context, compiledModule.exports);
  function loadCallbacks(file) {
    const source = fs.readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const snippets = [];
    function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'makeAdminIdempotencyKey') snippets.push(node.getText(tree));
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ['runAdminWallet', 'handleRecharge', 'handleAdjustCredits', 'handleCashTopup'].includes(node.name.text)) {
        snippets.push(`var ${node.name.text} = ${node.initializer.getText(tree)};`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    vm.runInContext(ts.transpileModule(snippets.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context;
  }
  return { api: compiledModule.exports, requests, store, effects, loadCallbacks };
}

{
  const old = harness({ respond: unknown });
  const callbacks = old.loadCallbacks(before);
  await callbacks.handleCashTopup(); await callbacks.handleCashTopup();
  assert.equal(old.requests.length, 2);
  assert.notEqual(old.requests[0].key, old.requests[1].key);
  cases.push('actual previous admin callback creates a new key after an unknown result');
}
for (const handler of ['handleCashTopup', 'handleRecharge', 'handleAdjustCredits']) {
  let release;
  const h = harness({ respond: () => new Promise(resolve => { release = resolve; }) });
  const callbacks = h.loadCallbacks(current);
  const first = callbacks[handler]();
  await callbacks[handler]();
  assert.equal(h.requests.length, 1);
  release(unknown()); await first;
  assert.equal(h.effects.pending.length, 1);
  assert.equal(h.effects.syncs, 0);
  cases.push(`actual ${handler} synchronously blocks double clicks and retains unknown request`);
}
{
  const first = harness({ respond: unknown });
  await assert.rejects(first.api.submitAdminWalletRequest(input), /保留原操作/u);
  const key = first.requests[0].key;
  const reloaded = harness({ store: first.store });
  await reloaded.api.submitAdminWalletRequest(input);
  assert.equal(reloaded.requests[0].key, key);
  assert.deepEqual(reloaded.requests[0].body, first.requests[0].body);
  assert.equal(reloaded.store.size, 0);
  cases.push('reload uses original request and exact payload, clears only a matching successful receipt');
}
{
  const h = harness({ respond: unknown });
  await assert.rejects(h.api.submitAdminWalletRequest(input));
  await assert.rejects(h.api.submitAdminWalletRequest({ ...input, payload: { ...input.payload, amount: 51 } }), /核对原操作/u);
  assert.equal(h.requests.length, 1);
  cases.push('changing the amount of an unresolved operation cannot create another request');
}
{
  const h = harness({ respond: denied });
  await assert.rejects(h.api.submitAdminWalletRequest(input), /preflight/u);
  assert.equal(h.store.size, 0);
  const original = harness({ respond: unknown });
  await assert.rejects(original.api.submitAdminWalletRequest(input));
  const retried = harness({ store: original.store, respond: denied });
  await assert.rejects(retried.api.submitAdminWalletRequest(input));
  assert.equal(retried.store.size, 1);
  assert.equal(retried.requests[0].key, original.requests[0].key);
  cases.push('first preflight rejection unlocks; rejection after an unknown original cannot erase it');
}
{
  for (const respond of [() => { throw new Error('synthetic disconnect'); }, () => new Response('bad json', { status: 200 }), () => Response.json({ success: true, balance: 52 }), () => Response.json({ outcome: 'not_applied', code: 'ADMIN_WALLET_IDEMPOTENCY_CONFLICT' }, { status: 409 })]) {
    const h = harness({ respond });
    await assert.rejects(h.api.submitAdminWalletRequest(input));
    assert.equal(h.store.size, 1);
  }
  cases.push('disconnect, malformed success, incomplete receipt and conflict all preserve original identity');
}
{
  for (const patch of [{ operationId: '' }, { operationId: 'not-a-number' }, { balanceBefore: -2, balanceAfter: 48 }, { balanceAfter: 53, delta: 51 }, { noChange: true, operationId: undefined, adjustmentId: '7', balanceAfter: 2, delta: 0 }]) {
    const h = harness({ respond: body => Response.json({ success: true, idempotencyKey: body.idempotencyKey, operationId: '12', balanceBefore: 2, balanceAfter: 52, delta: 50, ...patch }) });
    await assert.rejects(h.api.submitAdminWalletRequest(input));
    assert.equal(h.store.size, 1);
  }
  const set = harness({ respond: body => Response.json({ success: true, idempotencyKey: body.idempotencyKey, operationId: '12', adjustmentId: '13', balanceBefore: 2, balanceAfter: 52, delta: 50 }) });
  await assert.rejects(set.api.submitAdminWalletRequest({ ...input, kind: 'credit_set', payload: { userId: 'fixture-user', credits: 50 } }));
  assert.equal(set.store.size, 1);
  cases.push('invalid operation IDs, negative balances, wrong amount/target and a top-up no-op cannot clear pending evidence');
}
{
  const h = harness({ brokenStorage: true });
  await assert.rejects(h.api.submitAdminWalletRequest(input));
  assert.equal(h.requests.length, 0);
  h.store.set('admin-wallet-pending:v1:fixture-admin:cash_topup', 'malformed');
  await assert.rejects(h.api.submitAdminWalletRequest(input), /记录无法读取/u);
  assert.equal(h.requests.length, 0);
  cases.push('storage failure and malformed prior evidence stop before sending');
}
{
  let locked = false;
  const locks = { request: async (_key, _options, callback) => {
    if (locked) return callback(null);
    locked = true;
    try { return await callback({ name: 'fixture-lock' }); } finally { locked = false; }
  } };
  let release;
  const first = harness({ locks, respond: () => new Promise(resolve => { release = resolve; }) });
  const second = harness({ store: first.store, locks });
  const original = first.api.submitAdminWalletRequest(input);
  await assert.rejects(second.api.submitAdminWalletRequest(input), /另一页面/u);
  assert.equal(second.requests.length, 0);
  release(success(first.requests[0].body)); await original;
  cases.push('actual browser-lock branch blocks concurrent submissions from a second module/tab');
}
{
  const h = harness({ respond: body => Response.json({ success: true, noChange: true, adjustmentId: '77', idempotencyKey: body.idempotencyKey, balanceBefore: 50, balanceAfter: 50, delta: 0 }) });
  await h.api.submitAdminWalletRequest({ ...input, kind: 'credit_set', payload: { userId: 'fixture-user', credits: 50 } });
  assert.equal(h.requests[0].method, 'PUT'); assert.equal(h.store.size, 0);
  cases.push('durable no-op receipt completes a target adjustment without inventing a wallet operation');
}
{
  const h = harness();
  await h.loadCallbacks(current).handleCashTopup();
  assert.equal(h.effects.syncs, 0); assert.equal(h.effects.loads, 1);
  assert.equal(h.effects.pending.length, 0);
  cases.push('actual successful admin callback refreshes users without triggering deployment synchronization');
}

const result = { checkedAt: new Date().toISOString(), passed: true, groups: cases.length, cases, realNetworkCalls: 0, databaseWrites: 0, upstreamCalls: 0 };
const output = path.join(root, '.codex-evidence/admin-wallet-client-20260902');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
