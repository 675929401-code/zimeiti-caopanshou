#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const source = fs.readFileSync('src/app/api/auth/login/route.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const now = Date.parse('2026-10-30T00:00:00Z');
const user = { id: 'fixture-user', username: 'fixture', display_name: 'Fixture',
  password_hash: 'unused-fixture', role: 'student', credits: 0, is_active: true,
  status: 'active', allowed_categories: [], member_status: 'inactive' };
class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }

async function run(remember, { persist = true, ip = '127.0.0.1' } = {}) {
  const state = { sessions: [], tokens: [], cookies: [], logs: 0 };
  const db = { from(table) {
    if (table === 'login_logs') return { async insert() { state.logs++; return { error: null }; } };
    assert.equal(table, 'users');
    return { select() { return { eq() { return { async maybeSingle() { return { data: user, error: null }; } }; } }; } };
  } };
  const exports = {};
  const module = { exports };
  vm.runInNewContext(compiled, { exports, module, Date: FixtureDate,
    process: { env: { NODE_ENV: 'test' } }, console: { error() {}, warn() {} },
    require(name) {
      if (name === 'crypto') return crypto;
      if (name === 'next/server') return { NextResponse: { json(body, init) {
        return { body, status: init?.status || 200, cookies: { set(...args) { state.cookies.push(args); } } };
      } } };
      if (name === '@/lib/auth') return { verifyPassword: async () => true,
        createToken: async (claims, options) => { state.tokens.push({ claims, options }); return 'fixture-not-a-token'; } };
      if (name === '@/lib/security') return { logSecurityEvent: async () => {} };
      if (name === '@/storage/database/supabase-client') return { getSupabaseClient: () => db };
      if (name === '@/lib/auth-session-store') return { issueUserAuthSession: async (_client, value) => {
        state.sessions.push(value); return { ok: persist };
      } };
      if (name === '@/lib/agent-category-access') return { publicAllowedAgentCategoryIds: () => [] };
      if (name === '@/lib/server/user-appearance-preference') return { readUserAppearancePreference: async () => ({ preference: null, status: 'none' }) };
      if (name === '@/lib/auth-session-client-ip') return { getAuthSessionClientIP: () => ip };
      throw Error(`UNEXPECTED_LOGIN_DEPENDENCY:${name}`);
    },
  }, { timeout: 1000 });
  const response = await module.exports.POST({ headers: new Headers(), nextUrl: { protocol: 'http:' },
    json: async () => ({ username: 'fixture', password: 'fixture', ...(remember === undefined ? {} : { remember }) }) });
  return { state, response };
}

for (const remember of [undefined, false, true, 'true', 1]) {
  const { state, response } = await run(remember);
  assert.equal(response.status, 200);
  assert.equal(state.sessions.length, 1); assert.equal(state.tokens.length, 1); assert.equal(state.cookies.length, 1);
  const days = remember === true ? 30 : 3;
  assert.equal(Date.parse(state.sessions[0].expiresAt) - now, days * 86_400_000);
  assert.equal(state.tokens[0].options.expiresIn, `${days}d`);
  assert.equal(state.cookies[0][2].maxAge, days * 86_400);
  assert.equal(state.tokens[0].claims.sessionId, state.sessions[0].sessionId);
  assert.equal(state.cookies[0][2].httpOnly, true);
}
const failed = await run(true, { persist: false });
assert.equal(failed.response.status, 503); assert.equal(failed.state.tokens.length, 0); assert.equal(failed.state.cookies.length, 0);
const noIp = await run(true, { ip: null });
assert.equal(noIp.response.status, 503); assert.equal(noIp.state.sessions.length, 0);
console.log(JSON.stringify({ passed: true, scenarios: 7, sharedDatabaseJwtCookieTtl: true,
  failedSessionIssuesNoToken: true, networkCalls: 0, databaseWrites: 0, providerCalls: 0 }));
