import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parse as parseEnv } from 'dotenv';

// The actual runner executes with in-memory fs, fetch and media dependencies.
// No real runtime configuration, credentials, files or network are reachable.
const source = readFileSync('scripts/verify-extract-local-single-submit.mjs', 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace("const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');", "const root = '/fixture-project';")
  .replace('main().catch(async error => {', 'globalThis.completion = main().catch(async error => {');
const runtime = {
  ownerConnection: 'postgresql://owner:fixture-owner-secret@127.0.0.1:54322/app',
  supabaseUrl: 'http://127.0.0.1:54321', serviceRoleKey: 'fixture-service-secret', anonKey: 'fixture-anon-secret',
};
const authEnv = { EXTRACT_E2E_USERNAME: 'fixture-login-name', EXTRACT_E2E_PASSWORD: 'fixture-login-secret' };

async function scenario(options = {}) {
  const calls = { reads: 0, requests: [], extractionPosts: 0, loginPosts: 0 };
  const files = new Map(); const output = []; let attemptId; let apiBody;
  const environment = { ...authEnv, ...options.env };
  const args = ['node', 'runner', ...(options.plan ? [] : ['--execute', '--runtime-config=/restricted/runtime.json', '--request-id=fixture-extract-local-config'])];
  if (options.confirm !== false) args.push('--confirm-local-runtime');
  const context = {
    path, createHash, parseEnv, URL, AbortSignal, Response, isIP() { throw new Error('Media must not be called in this fixture'); },
    lookup() { throw new Error('DNS must not be called in this fixture'); }, https: {},
    process: { argv: args, env: environment },
    console: { log: text => output.push(text), error: text => output.push(text) },
    fs: {
      async readFile() { calls.reads++; return options.raw ?? JSON.stringify(options.runtime || runtime); },
      async mkdir() {}, async access() { if (options.dispatched) return; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      async writeFile(file, contents, writeOptions) {
        if (writeOptions?.flag === 'wx') { assert.ok(!files.has(file)); attemptId = JSON.parse(contents).attemptId; }
        files.set(file, contents);
      },
    },
    fetch: async (rawUrl, init = {}) => {
      const url = new URL(rawUrl); calls.requests.push({ host: url.host, path: url.pathname, search: url.search, method: init.method || 'GET' });
      if (url.pathname === '/api/auth/login') {
        assert.equal(url.origin, 'http://127.0.0.1:5000'); calls.loginPosts++;
        assert.deepEqual(JSON.parse(init.body), { username: authEnv.EXTRACT_E2E_USERNAME, password: authEnv.EXTRACT_E2E_PASSWORD });
        return Response.json({ token: 'fixture-normal-session-secret' });
      }
      if (url.pathname === '/api/auth/me') return Response.json({ user: { id: 'fixture-user', role: 'admin', is_active: true } });
      if (url.pathname === '/api/extract') {
        calls.extractionPosts++;
        assert.ok([...files.keys()].some(file => file.endsWith('submission-dispatched.json')), 'dispatch marker must exist before POST');
        assert.equal(init.headers['Idempotency-Key'], 'fixture-extract-local-config');
        if (options.responseLost) throw new Error('fixture acknowledgement lost');
        apiBody = { success: true, charged: false, price: 0, videos: [] };
        return Response.json(apiBody, { headers: { 'X-Extraction-Attempt-Id': attemptId } });
      }
      assert.equal(url.origin, 'http://127.0.0.1:54321');
      assert.equal(init.method || 'GET', 'GET', 'DB access is read-only');
      if (url.pathname.endsWith('/users')) return Response.json([{ id: 'fixture-user', cash_balance: 0, credits: 0 }]);
      if (url.pathname.endsWith('/plugins')) return Response.json([{
        id: 'fixture-plugin', role: 'extract_video', type: 'third_party', price_per_use: 0,
        config: { provider: 'ppt6', response_format: 'ppt6', api_base_url: 'https://provider.invalid', client_id: 'fixture-client-secret', client_secret_key: 'fixture-client-key-secret' },
      }]);
      if (url.pathname.endsWith('/wallet_ledger_entries')) return Response.json([]);
      if (url.pathname.endsWith('/revenue_records')) return Response.json(calls.extractionPosts ? [{
        model_id: 'extract_video', task_id: 'extract:fixture-extract-local-config:ppt6-video',
        cost_price: 0, selling_price: 0, profit: 0, billing_exempt: true,
        record_type: 'extract', cash_charged: 0, credits_charged: 0,
      }] : []);
      if (url.pathname.endsWith('/extraction_attempts')) return Response.json(calls.extractionPosts ? [{
        record_id: attemptId, state: options.responseLost ? 'running' : 'succeeded', http_status: 200, response: apiBody || null,
      }] : []);
      throw new Error(`Unstubbed fixture request ${url.pathname}`);
    },
  };
  runInNewContext(source, context); await context.completion;
  const serialized = output.join('\n') + [...files.values()].join('\n');
  for (const secret of [...Object.values(authEnv), runtime.ownerConnection, runtime.serviceRoleKey, runtime.anonKey, 'fixture-normal-session-secret', 'fixture-client-secret', 'fixture-client-key-secret']) {
    assert.ok(!serialized.includes(secret), 'credentials must not appear in evidence or console');
  }
  return { calls, files, output: output.join('\n'), evidence: [...files.entries()].find(([file]) => file.endsWith('result.json'))?.[1] };
}

const plan = await scenario({ plan: true });
assert.equal(plan.calls.reads, 0); assert.equal(plan.calls.requests.length, 0);
assert.ok(plan.output.includes('http://127.0.0.1:5000'));
const modern = await scenario();
assert.equal(modern.calls.loginPosts, 1); assert.equal(modern.calls.extractionPosts, 1);
assert.ok(
  modern.calls.requests.some(request => request.path.endsWith('/wallet_ledger_entries')
    && request.search.includes('idempotency_key=eq.extract%3Afixture-extract-local-config%3Appt6-video')),
  'local acceptance must reconcile the same PPT6 settlement key used by the route',
);
assert.equal(JSON.parse(modern.evidence).state, 'not-passed', 'absent media must never manufacture a real pass');
const legacy = await scenario({ confirm: false, runtime: { COZE_SUPABASE_URL: runtime.supabaseUrl, COZE_SUPABASE_SERVICE_ROLE_KEY: runtime.serviceRoleKey }, env: { EXTRACT_E2E_LOCAL_RUNTIME_CONFIRMED: 'true' } });
assert.equal(legacy.calls.extractionPosts, 1);
for (const options of [
  { confirm: false },
  { runtime: { ...runtime, supabaseUrl: 'https://remote.invalid' } },
  { runtime: { ...runtime, COZE_SUPABASE_URL: 'http://127.0.0.1:1111' } },
  { raw: '[]' },
  { raw: '{"serviceRoleKey":"fixture-service-secret",' },
  { dispatched: true },
]) {
  const blocked = await scenario(options);
  assert.equal(blocked.calls.extractionPosts, 0); assert.equal(blocked.calls.requests.length, 0);
}
const lost = await scenario({ responseLost: true });
assert.equal(lost.calls.extractionPosts, 1);
assert.equal(JSON.parse(lost.evidence).state, 'unknown');
console.log(JSON.stringify({ passed: true, scenarios: 10, actualRunner: true, realNetworkCalls: 0, realDatabaseWrites: 0, credentialFilesRead: 0 }));
