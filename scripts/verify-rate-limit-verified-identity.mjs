#!/usr/bin/env node
// Executes the actual proxy/auth/security modules in isolated VMs. JWTs use a
// fixture-only secret supplied by a fake secret reader, never real env/cookies.
// Fetches are intercepted; no app request, database write or provider call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as jose from 'jose';
import ts from 'typescript';
import * as nodeCrypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const beforeArg = process.argv.find(value => value.startsWith('--before='));
assert.ok(beforeArg, 'Provide the actual before-edit snapshot directory');
const beforeRoot = path.resolve(root, beforeArg.slice('--before='.length));
assert.ok(beforeRoot.startsWith(`${path.join(root, '.codex-backups')}${path.sep}`));
const fixtureSecret = ' fixture-only-key-never-read-from-runtime-environment ';
const cases = [];

function evaluate(file, overrides = {}) {
  const compiledModule = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = {
    module: compiledModule, exports: compiledModule.exports, Headers, Request, Response,
    TextEncoder, TextDecoder, Buffer, URL, atob, btoa, crypto: nodeCrypto.webcrypto,
    process: { env: { NODE_ENV: 'production' } },
    console: { log() {}, warn() {}, error() {} },
    setInterval() { return 1; }, clearInterval() {},
    fetch() { throw new Error('Unexpected network access'); },
    require(name) { throw new Error(`Unexpected module dependency: ${name}`); },
    ...overrides,
  };
  vm.runInNewContext(source, context, { filename: path.basename(file) });
  return compiledModule.exports;
}

function loadAuth(secret = fixtureSecret) {
  let secretReads = 0;
  const auth = evaluate(path.join(root, 'src/lib/auth.ts'), {
    require(name) {
      if (name === 'jose') return jose;
      if (name === 'crypto') return nodeCrypto;
      if (name === 'bcryptjs') return {};
      if (name === '@/lib/server-secrets') return { requireServerSecret(name) {
        assert.equal(name, 'JWT_SECRET'); secretReads += 1;
        if (secret === null) throw new Error('Fixture secret intentionally unavailable');
        return secret;
      } };
      throw new Error(`Unexpected auth dependency: ${name}`);
    },
  });
  return { auth, secretReads: () => secretReads };
}

function loadProxy(sourceRoot = root, secret = fixtureSecret) {
  const { auth, secretReads } = loadAuth(secret);
  const edge = evaluate(path.join(sourceRoot, 'src/lib/security-edge.ts'));
  const interceptedEvents = [];
  const proxy = evaluate(path.join(sourceRoot, 'src/proxy.ts'), {
    process: { env: { NODE_ENV: 'production', SECURITY_INTERNAL_KEY: 'fixture-internal-key' } },
    require(name) {
      if (name === '@/lib/security-edge') return edge;
      if (name === '@/lib/auth') return auth;
      if (name === 'next/server') return { NextResponse: {
        next: () => new Response(null, { status: 200 }),
        json: (data, init) => new Response(JSON.stringify(data), { status: init?.status || 200, headers: { 'content-type': 'application/json' } }),
      } };
      throw new Error(`Unexpected proxy dependency: ${name}`);
    },
    fetch: async (_url, init) => { interceptedEvents.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); },
  }).proxy;
  return { proxy, edge, auth, secretReads, interceptedEvents };
}

function request(route, options = {}) {
  const headers = new Headers({ host: '127.0.0.1:5000', origin: 'http://127.0.0.1:5000', 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-real-ip': options.ip || '203.0.113.10' });
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.cookie) headers.set('cookie', options.cookie);
  const url = new URL(route, 'http://127.0.0.1:5000');
  return { method: 'POST', headers, nextUrl: url, url: url.toString() };
}

// This deliberately invalid wire value has no valid header or signature.
const invalidClaim = id => `invalid.${Buffer.from(JSON.stringify({ userId: id, role: 'admin' })).toString('base64')}.invalid`;

for (const [route, limit] of [['/api/auth/login', 20], ['/api/extract', 60], ['/api/video/generate', 60], ['/api/image/generate', 5]]) {
  const before = loadProxy(beforeRoot);
  const after = loadProxy();
  const oldStatuses = [];
  const newStatuses = [];
  for (let i = 0; i < limit + 2; i += 1) {
    const input = request(route, { token: invalidClaim(`untrusted-${i}`) });
    oldStatuses.push((await before.proxy(input)).status);
    const response = await after.proxy(input);
    newStatuses.push(response.status);
    if (i >= limit) {
      assert.equal((await response.json()).code, 'RATE_LIMITED');
      assert.ok(Number(response.headers.get('retry-after')) > 0);
    }
  }
  assert.ok(oldStatuses.every(status => status === 200), 'The real old proxy accepts rotating unsigned identities');
  assert.ok(newStatuses.slice(0, limit).every(status => status === 200));
  assert.deepEqual(newStatuses.slice(limit), [429, 429]);
  assert.ok(after.interceptedEvents.every(event => event.user_id === null && event.role === undefined));
  assert.ok(after.secretReads() >= limit + 2, 'Use the actual auth verifier and its protected-secret access contract');
  cases.push(`old/new proxy: unsigned identity rotation cannot reset ${route} limit`);
}

const issuer = loadAuth().auth;
const tokenA = await issuer.createToken({ userId: 'fixture-user-a', username: 'fixture-a', role: 'student', displayName: '测试用户' });
const tokenB = await issuer.createToken({ userId: 'fixture-user-b', username: 'fixture-b', role: 'student', displayName: '测试用户' });

{
  const runtime = loadProxy();
  for (let i = 0; i < 5; i += 1) assert.equal((await runtime.proxy(request('/api/image/generate', { token: tokenA }))).status, 200);
  assert.equal((await runtime.proxy(request('/api/image/generate', { token: tokenA, ip: '203.0.113.11' }))).status, 429, 'Changing IP cannot reset an authenticated user bucket');
  assert.equal((await runtime.proxy(request('/api/image/generate', { token: tokenB }))).status, 200, 'Other authenticated users sharing the IP keep separate buckets');
  const identity = await runtime.edge.extractUserIdentity(request('/api/extract', { token: tokenA }), runtime.auth.verifyToken);
  assert.equal(identity.userId, 'fixture-user-a');
  assert.equal(identity.displayName, '测试用户');
  cases.push('actual auth signatures preserve users across IPs and isolate shared-IP users');
}

{
  const runtime = loadProxy();
  const expired = await new jose.SignJWT({ userId: 'expired-fixture', role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime(1).sign(new TextEncoder().encode(fixtureSecret));
  const wrongKey = await new jose.SignJWT({ userId: 'wrong-key-fixture' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1m').sign(new TextEncoder().encode('different-fixture-only-key'));
  const tamperedParts = tokenA.split('.');
  tamperedParts[1] = Buffer.from(JSON.stringify({ userId: 'changed-payload' })).toString('base64url');
  for (const token of [expired, wrongKey, tamperedParts.join('.'), invalidClaim('unsigned'), 'malformed']) {
    assert.equal((await runtime.edge.extractUserIdentity(request('/api/extract', { token }), runtime.auth.verifyToken)).userId, null);
  }
  cases.push('expired, wrong-key, changed-payload, unsigned and malformed credentials become anonymous');
}

{
  const runtime = loadProxy();
  const identity = await runtime.edge.extractUserIdentity(request('/api/extract', { cookie: `other_cookie=1; auth_token=${tokenA}` }), runtime.auth.verifyToken);
  assert.equal(identity.userId, 'fixture-user-a');
  assert.equal((await runtime.edge.extractUserIdentity(request('/api/extract', { cookie: `not_auth_token=${tokenA}` }), runtime.auth.verifyToken)).userId, null);
  assert.equal((await runtime.edge.extractUserIdentity(request('/api/extract', { token: 'invalid', cookie: `auth_token=${tokenA}` }), runtime.auth.verifyToken)).userId, null, 'Invalid bearer must not override verifier behavior with a cookie fallback');
  const missingSecret = loadProxy(root, null);
  assert.equal((await missingSecret.edge.extractUserIdentity(request('/api/extract', { token: tokenA }), missingSecret.auth.verifyToken)).userId, null);
  cases.push('exact cookie name, bearer priority and missing secret preserve auth failure boundaries');
}

function loadTimedLimiter(sourceRoot, file) {
  let now = 1000000;
  const callbacks = [];
  class FixtureDate extends Date { static now() { return now; } }
  const limiter = evaluate(path.join(sourceRoot, file), { Date: FixtureDate, setInterval(callback) { callbacks.push(callback); return callbacks.length; } });
  return { limiter, tick(milliseconds) { now += milliseconds; }, clean() { callbacks.forEach(callback => callback()); } };
}

for (const file of ['src/lib/security-edge.ts', 'src/lib/security.ts']) {
  const before = loadTimedLimiter(beforeRoot, file);
  const after = loadTimedLimiter(root, file);
  for (const runtime of [before, after]) {
    for (let i = 0; i < 5; i += 1) assert.equal(runtime.limiter.checkRateLimit('203.0.113.42', 'POST', '/api/auth/register').allowed, true);
    assert.equal(runtime.limiter.checkRateLimit('203.0.113.42', 'POST', '/api/auth/register').allowed, false);
    runtime.tick(20 * 60 * 1000); runtime.clean();
  }
  assert.equal(before.limiter.checkRateLimit('203.0.113.42', 'POST', '/api/auth/register').allowed, true, 'Old fixed ten-minute cleanup wrongly resets a one-hour limit');
  assert.equal(after.limiter.checkRateLimit('203.0.113.42', 'POST', '/api/auth/register').allowed, false);
  after.tick(40 * 60 * 1000); after.clean();
  assert.equal(after.limiter.checkRateLimit('203.0.113.42', 'POST', '/api/auth/register').allowed, true, 'Window releases at the real one-hour expiry');
  cases.push(`old/new timer: ${file} retains one-hour registration history until expiry`);
}

const result = { ok: true, scenarios: cases.length, cases, realNetworkCalls: 0, businessDatabaseWrites: 0, productionSecretsRead: 0, realSiteTokensCreated: 0, onlyFixtureCredentialsUsed: true, beforeSnapshot: path.relative(root, beforeRoot) };
const output = path.join(root, '.codex-evidence/rate-limit-identity-20260902');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
