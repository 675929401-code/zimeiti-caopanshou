import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Execute each actual browser response/action helper with rejected I/O.
// No browser, network, credentials or database is used here.
let passed = 0;
const unhandled = [];
const listener = error => unhandled.push(error);
process.on('unhandledRejection', listener);
try {
  for (const [file, helperName] of [
    ['scripts/verify-admin-plugin-live.mjs', 'mutation'],
    ['scripts/verify-manju-admin-e2e.mjs', 'waitMutation'],
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const originStatements = parsed.statements.filter(node => (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === 'origin')) || (ts.isIfStatement(node) && node.getText(parsed).includes('LOCAL_NAV_ORIGIN_MUST_BE_LOOPBACK_PREVIEW')));
    assert.equal(originStatements.length, 2);
    const originSource = originStatements.map(node => node.getText(parsed)).join('\n') + '\nthis.resolvedOrigin=origin;';
    for (const value of [undefined, 'http://127.0.0.1:5000', 'http://127.0.0.1:5002']) {
      const scope = { process: { env: { LOCAL_NAV_ORIGIN: value } } }; vm.runInNewContext(originSource, scope);
      assert.equal(scope.resolvedOrigin, value || 'http://127.0.0.1:5000');
    }
    for (const value of ['https://provider.invalid', 'http://localhost:5000', 'http://127.0.0.1:5003', ['http://', '127.0.0.1:5000@provider.invalid'].join(''), 'http://127.0.0.1:5000/path', 'http://127.0.0.1:5002?secret=value']) {
      assert.throws(() => vm.runInNewContext(originSource, { process: { env: { LOCAL_NAV_ORIGIN: value } } }), /LOCAL_NAV_ORIGIN_MUST_BE_LOOPBACK_PREVIEW/u);
    }
    passed++;
    console.log(`PASS ${helperName}: only the two exact loopback preview origins are allowed`);
    const helper = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === helperName);
    assert.ok(helper);
    for (const failure of ['wait', 'action', 'both']) {
      const expectedWait = new Error('WAIT_FAILED');
      const expectedAction = new Error('ACTION_FAILED');
      const page = { waitForResponse: () => new Promise((resolve, reject) => setTimeout(() => failure === 'action' ? resolve({ ok: () => true, status: () => 200, json: async () => ({}) }) : reject(expectedWait), 1)) };
      const context = { page, Promise, URL, Date, Error, lastDocumentChange: 0, expectedMutationMethod: '', stage: 'fixture', marker: 'fixture', ownId: '', checkpointPath: 'fixture', endpoint: '/api/admin/plugins', report: { steps: [] }, fs: { writeFileSync() {} }, check: (value, message) => { if (!value) throw new Error(message); } };
      vm.runInNewContext(helper.getText(parsed) + `\nthis.run = ${helperName};`, context);
      const action = () => new Promise((resolve, reject) => setTimeout(() => failure === 'wait' ? resolve() : reject(expectedAction), 10));
      await assert.rejects(() => helperName === 'mutation' ? context.run(action, 'POST') : context.run(action, '/api/admin/manju-workbench/assets', 'POST'), error => error === expectedWait || error === expectedAction);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(unhandled.length, 0);
      passed++;
      console.log(`PASS ${helperName}: ${failure} failure is caught without orphan rejection`);
    }
  }
} finally { process.off('unhandledRejection', listener); }
console.log(JSON.stringify({ passed, failed: 0, realNetworkRequests: 0, databaseWrites: 0 }));
