#!/usr/bin/env node
// Isolated route execution with a deliberately lazy database thenable.
// No .env, network, real password verification, JWT creation or business write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const beforeArg = process.argv.find(argument => argument.startsWith('--before='));
assert.ok(beforeArg, 'Provide the actual timestamped before-edit route snapshot');
const beforePath = path.resolve(root, beforeArg.slice('--before='.length));
assert.ok(beforePath.startsWith(`${path.join(root, '.codex-backups')}${path.sep}`));
const currentPath = path.join(root, 'src/app/api/auth/login/route.ts');
const warning = '[auth/login] Login activity timestamp was not saved';

async function executeRoute(sourcePath, options = {}) {
  const state = { updatesConstructed: 0, updatesSent: 0, persisted: false, updatePayload: null, updateFilter: null, warnings: [], errors: [], loginLogs: 0, tokensRequested: 0 };
  const fixtureUser = { id: '11111111-1111-4111-8111-111111111111', username: 'fixture', display_name: 'fixture', password_hash: 'fixture-unused', phone: null, email: null, role: 'student', credits: 0, is_active: options.suspended ? false : true, status: options.suspended ? 'suspended' : 'active', allowed_categories: [], member_status: 'inactive', theme_preference: null };
  let releaseUpdate;
  const pendingUpdate = new Promise(resolve => { releaseUpdate = resolve; });
  const db = {
    from(table) {
      if (table === 'login_logs') return { async insert() { state.loginLogs += 1; return { error: null }; } };
      assert.equal(table, 'users');
      return {
        select() { return { eq() { return { async maybeSingle() { return { data: fixtureUser, error: null }; } }; } }; },
        update(payload) {
          state.updatesConstructed += 1;
          state.updatePayload = payload;
          return { eq(field, value) {
            state.updateFilter = { field, value };
            return {
              then(onFulfilled, onRejected) {
                state.updatesSent += 1;
                const operation = (async () => {
                  if (options.defer) await pendingUpdate;
                  if (options.reject) throw new Error('SENSITIVE_DATABASE_ERROR_DO_NOT_LOG');
                  if (options.returnError) return { error: { code: 'FIXTURE_ERROR', message: 'SENSITIVE_DATABASE_ERROR_DO_NOT_LOG' } };
                  state.persisted = true;
                  return { error: null };
                })();
                return operation.then(onFulfilled, onRejected);
              },
            };
          } };
        },
      };
    },
  };
  const exports = {};
  const compiledModule = { exports };
  const sandbox = {
    module: compiledModule, exports, process: { env: { NODE_ENV: 'test' } }, Date,
    console: { warn: (...args) => state.warnings.push(args), error: (...args) => state.errors.push(args) },
    require(name) {
      if (name === 'next/server') return { NextResponse: { json(payload, init) { return { payload, status: init?.status || 200, cookies: { set() {} } }; } } };
      if (name === 'crypto') return require('node:crypto');
      if (name === '@/lib/auth') return { createToken: async () => { state.tokensRequested += 1; return 'fixture-placeholder-not-a-jwt'; }, verifyPassword: async () => !options.invalidPassword };
      if (name === '@/lib/security') return { logSecurityEvent: async () => undefined };
      if (name === '@/storage/database/supabase-client') return { getSupabaseClient: () => db };
      throw new Error(`Unexpected route dependency: ${name}`);
    },
  };
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, sandbox, { filename: 'isolated-login-route.js' });
  let settled = false;
  const responsePromise = compiledModule.exports.POST({ headers: new Headers({ 'user-agent': 'isolated-fixture' }), nextUrl: { protocol: 'http:' }, json: async () => ({ username: 'fixture', password: 'fixture-unused' }) }).then(response => { settled = true; return response; });
  if (options.defer) {
    for (let i = 0; i < 15; i += 1) await Promise.resolve();
    assert.equal(state.updatesSent, 1, 'Await must start the lazy database operation');
    assert.equal(settled, false, 'Login route must observe the update result before returning');
    releaseUpdate();
  }
  const response = await responsePromise;
  return { state, response };
}

const legacy = await executeRoute(beforePath);
assert.equal(legacy.response.status, 200);
assert.equal(legacy.state.updatesConstructed, 1);
assert.equal(legacy.state.updatesSent, 0, 'Actual old source constructs but never consumes the lazy update');
assert.equal(legacy.state.persisted, false);

const success = await executeRoute(currentPath, { defer: true });
assert.equal(success.response.status, 200);
assert.equal(success.state.updatesSent, 1);
assert.equal(success.state.persisted, true);
assert.deepEqual(Object.keys(success.state.updatePayload), ['last_sign_in_at']);
assert.ok(Number.isFinite(Date.parse(success.state.updatePayload.last_sign_in_at)));
assert.equal(success.state.updateFilter.field, 'id');
assert.equal(success.state.updateFilter.value, '11111111-1111-4111-8111-111111111111');
assert.equal(success.state.warnings.length, 0);

for (const options of [{ returnError: true }, { reject: true }]) {
  const failure = await executeRoute(currentPath, options);
  assert.equal(failure.response.status, 200, 'Metadata failure must preserve verified login');
  assert.equal(failure.response.payload.success, true);
  assert.equal(failure.state.updatesSent, 1);
  assert.equal(failure.state.persisted, false);
  assert.equal(failure.state.warnings.length, 1);
  assert.equal(failure.state.warnings[0].length, 1);
  assert.equal(failure.state.warnings[0][0], warning);
  assert.equal(failure.state.errors.length, 0);
  assert.equal('last_sign_in_at' in failure.response.payload.user, false, 'Do not claim a timestamp was persisted');
}

for (const options of [{ invalidPassword: true }, { suspended: true }]) {
  const rejected = await executeRoute(currentPath, options);
  assert.ok([401, 403].includes(rejected.response.status));
  assert.equal(rejected.state.updatesConstructed, 0);
  assert.equal(rejected.state.updatesSent, 0);
  assert.equal(rejected.state.tokensRequested, 0);
}
console.log(JSON.stringify({ ok: true, scenarios: 6, oldSourceLazyUpdateSent: legacy.state.updatesSent, currentSourceLazyUpdateSent: success.state.updatesSent, metadataErrorPreservesLogin: true, sensitiveErrorDetailsEmitted: false, rejectedAuthenticationDoesNotUpdateActivity: true, networkCalls: 0, realTokensCreated: 0, businessDatabaseWrites: 0 }, null, 2));
