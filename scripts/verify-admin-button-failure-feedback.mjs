import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const filename = 'src/app/admin/page.tsx';
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, context) {
  let initializer;
  function walk(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, walk);
  }
  walk(source);
  assert.ok(initializer, `${name} missing`);
  if (ts.isCallExpression(initializer) && initializer.expression.getText(source) === 'useCallback') initializer = initializer.arguments[0];
  const compiled = ts.transpileModule(`globalThis.subject = (${initializer.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const scope = vm.createContext({ URLSearchParams, DOMException, console: { error() {} }, ...context });
  vm.runInContext(compiled, scope, { timeout: 1000 });
  return scope.subject;
}

let checks = 0;
for (const name of ['handleCopyCodes', 'handleCopySingleCode', 'handleCopyBatchUnused', 'handleCopyAllUnused']) {
  for (const copied of [false, true]) {
    const notices = [], selected = [];
    const handler = callback(name, {
      copyToClipboard: async () => copied, alert: text => notices.push(text),
      setCopiedId: value => selected.push(value), setTimeout() {},
      codes: [{ batch_id: 'batch', code: 'audit-code', is_used: false, assigned_to: null }],
    });
    const argument = name === 'handleCopyCodes' ? ['audit-code'] : name === 'handleCopyBatchUnused' ? 'batch' : 'audit-code';
    await handler(argument, 'item');
    await Promise.resolve();
    if (!copied) { assert.ok(notices.some(text => text.includes('复制失败'))); assert.equal(selected.length, 0); }
    else assert.ok(selected.length > 0 || notices.some(text => text.includes('已复制')));
    checks++;
  }
}

for (const networkFailure of [false, true]) {
  const errors = [], refreshed = [];
  const response = () => networkFailure ? Promise.reject(new Error('AUDIT_NETWORK_FAILURE')) : Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'AUDIT_SERVICE_UNAVAILABLE' }) });
  const common = {
    token: 'audit-admin', authHeaders: { Authorization: 'Bearer audit-admin' }, fetch: response,
    setDiagError: text => { if (text) errors.push(text); }, setDiagUpdatingId() {},
    diagUpdatingId: null, diagPage: 1, diagDetailId: null,
    loadDiagLogs: () => refreshed.push('logs'), loadDiagDetail: () => refreshed.push('detail'),
  };
  await callback('updateDiagStatus', common)('audit-log', 'resolved');
  assert.equal(refreshed.length, 0); assert.equal(errors.length, 1); checks++;
  const notices = [];
  await callback('handleUserStatus', { ...common, canManageMembers: true, hasMembersManagePermission: true,
    currentUserId: 'administrator', isFixtureUser: () => false, confirm: () => true,
    showMessage: (type, text) => notices.push({ type, text }), showSuccessAndSync: () => refreshed.push('success'), loadUsers: () => refreshed.push('users'),
  })({ id: 'other-user' }, 'suspended');
  assert.equal(refreshed.length, 0); assert.equal(notices[0].type, 'error'); checks++;
}

{
  const errors = [], loaded = [];
  await callback('loadDiagLogs', {
    setDiagLoading() {}, setDiagError: message => { if (message) errors.push(message); },
    diagFilterType: '', diagFilterSeverity: '', diagFilterStatus: '', authHeaders: {},
    fetch: async () => ({ ok: false, json: async () => ({ error: 'AUDIT_DENIED' }) }),
    setDiagLogs: rows => loaded.push(rows), setDiagTotal() {}, setDiagPage() {}, setDiagSummary() {},
  })();
  assert.equal(loaded.length, 0); assert.deepEqual(errors, ['AUDIT_DENIED']); checks++;
}

{
  let release;
  const requests = [], notices = [], flight = { current: false };
  const wait = new Promise(resolve => { release = resolve; });
  const handler = callback('testCodingConnection', {
    codingTestInFlightRef: flight, setCodingTestLoading() {}, setCodingTestResult() {},
    newAgent: { botId: 'audit-project' }, authHeaders: { Authorization: 'Bearer audit-admin' },
    fetch: async (url, options) => { requests.push({ url, ...options }); await wait; return { ok: true, json: async () => ({ success: true }) }; },
    showMessage: (type, text) => notices.push({ type, text }),
  });
  const first = handler('https://audit.coze.site/stream_run', 'audit-provider');
  await handler('https://audit.coze.site/stream_run', 'audit-provider');
  assert.equal(requests.length, 1); assert.equal(flight.current, true);
  release(); await first;
  assert.equal(flight.current, false);
  assert.equal(requests[0].headers.Authorization, 'Bearer audit-admin');
  assert.deepEqual(JSON.parse(requests[0].body), { url: 'https://audit.coze.site/stream_run', token: 'audit-provider', projectId: 'audit-project' });
  assert.equal(notices[0].type, 'success'); assert.ok(notices[0].text.includes('接口已响应')); checks++;
}

for (const fixture of [
  { ok: false, body: { error: 'AUDIT_DOWNLOAD_DENIED' } },
  { ok: true, body: { error: 'not a record' } },
  { ok: true, body: { id: 'audit-log', context: null, created_at: '2026-10-16T00:00:00Z' } },
]) {
  const errors = [], downloads = [];
  await callback('handleDownloadDiagLog', {
    token: 'audit-admin', setDiagError: message => { if (message) errors.push(message); },
    fetch: async () => ({ ok: fixture.ok, json: async () => fixture.body }),
    downloadDiagLog: record => downloads.push(record),
  })('audit-log');
  const valid = fixture.ok && fixture.body.id === 'audit-log';
  assert.equal(downloads.length, valid ? 1 : 0); assert.equal(errors.length, valid ? 0 : 1); checks++;
}

for (const scenario of ['locked', 'ungranted', 'allowed', 'relocked-during-read']) {
  const requests = [], updates = [];
  const unlockedRef = { current: scenario !== 'locked' };
  await callback('loadSettings', {
    grantedPermissionKeys: new Set(), authHeaders: {}, sensitiveUnlocked: scenario !== 'locked',
    sensitiveUnlockedRef: unlockedRef, readableSettingScopes: scenario === 'ungranted' ? [] : ['brand'],
    fetch: async url => {
      requests.push(url);
      if (scenario === 'relocked-during-read') unlockedRef.current = false;
      return { ok: true, json: async () => ({ settings: { sample: 'audit-authorized-scope' } }) };
    },
    setSettings: update => updates.push(update), setSettingsBaseline: update => updates.push(update),
  })();
  assert.equal(requests.length, ['locked','ungranted'].includes(scenario) ? 0 : 1);
  assert.equal(updates.length, scenario === 'allowed' ? 2 : 0); checks++;
}

console.log(JSON.stringify({ passed: true, checks, mode: 'actual_callback_vm_contract', providerRequests: 0, databaseWrites: 0 }));
