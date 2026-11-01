import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';
const baseline = process.argv.includes('--record-baseline');
const file = baseline ? '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/quick-add/before/route.ts' : 'src/app/api/admin/video-models/quick-add/route.ts';
const state = { admin: true, network: 0, stage: 0, candidate: null };
const mod = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(code, { module: mod, exports: mod.exports, URL, Request, Response, AbortSignal, Date, console,
  require(name) {
    if (name === 'next/server') return { NextResponse: { json: (body, init) => Response.json(body, init) } };
    if (name === '@/lib/auth') return { getTokenFromHeaders: () => 'fixture-only' };
    if (name === '@/lib/admin-auth') return { verifyAdminToken: async () => state.admin ? { userId: 'fixture-admin' } : null };
    if (name === '@/lib/safe-fetch') return { validateSafeUrl: async () => {} };
    if (name === 'node:crypto') return { default: crypto, ...crypto };
    if (name === '@/lib/model-retirement') return { isPermanentlyRetiredModel: () => false };
    if (name === '@/lib/server/platform-configuration-compatibility') return { stageLegacyModelPoolUpsert: async value => { state.stage++; state.candidate = value; return { releaseId: 'fixture-only-release' }; } };
    throw Error('UNMOCKED_DEPENDENCY:' + name);
  },
  fetch: async url => { state.network++; return Response.json(String(url).includes('/api/pricing') ? { data: [] } : { data: [{ id: 'test-video' }] }); },
});
const invoke = body => mod.exports.POST(new Request('http://127.0.0.1:5000/api/admin/video-models/quick-add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
if (baseline) {
  const response = await invoke({ text: 'https://gaorui.evil.example/v1 test-video 售价1.2', credential: 'FIXTURE_ONLY_NOT_A_SECRET' });
  assert.equal(response.status, 202);
  assert.equal(state.candidate.values.cost_price, 0);
  assert.equal(state.candidate.values.provider, 'gaorui_video');
  assert.equal(state.candidate.values.is_active, true);
  const report = { reproduced: true, unknownCostWrittenAsZero: true, substringHostMisclassified: true, unverifiedNewModelActive: true, networkCalls: state.network, candidateWrites: state.stage, realProviderCalls: 0, realDatabaseWrites: 0 };
  fs.writeFileSync('.codex-evidence/admin-full-acceptance-20261030-9592a6d0/quick-add/baseline-reproduction.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} else {
  for (const origin of ['https://gaorui.evil.example/v1', 'https://unknown.example/v1', 'https://provider.example/custom/v1']) {
    const response = await invoke({ text: `${origin} test-video 售价1.2`, credential: 'FIXTURE_ONLY_NOT_A_SECRET' });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.requiresDetails, true); assert.equal(body.parsed.model, 'test-video'); assert.equal(body.parsed.price, 1.2);
    assert.equal(body.success, undefined); assert.equal(body.code, 'DETAIL_CONFIGURATION_REQUIRED');
    assert.equal(body.staged, undefined); assert.equal(body.published, undefined);
    assert.doesNotMatch(JSON.stringify(body), /FIXTURE_ONLY|api_key|cost_price|protocol_type|is_active|provider"/u);
  }
  const userInfoFixture = new URL('https://provider.example/v1');
  userInfoFixture.username = 'fixture-user'; userInfoFixture.password = 'fixture-placeholder';
  const queryFixture = new URL('https://provider.example/v1');
  queryFixture.searchParams.set('key', 'fixture-placeholder');
  for (const text of ['http://provider.example/v1 test-video 售价1', `${userInfoFixture.href} test-video 售价1`, `${queryFixture.href} test-video 售价1`, 'https://provider.example/v1#private test-video 售价1', 'https://provider.example/v1 sk-fixtureprivatekey12345 售价1', 'https://provider.example/v1 test-video Bearer hidden', 'https://provider.example/v1 test-video 售价-1']) {
    const response = await invoke({ text }); assert.equal(response.status, 400);
  }
  const autoDl = await invoke({ text: 'https://www.autodl.art/v1 test-video 售价1' }); assert.equal(autoDl.status, 409);
  state.admin = false; assert.equal((await invoke({ text: 'https://provider.example/v1 test-video' })).status, 403);
  assert.equal(state.network, 0); assert.equal(state.stage, 0); assert.equal(state.candidate, null);
  console.log(JSON.stringify({ passed: true, validParseCases: 3, invalidInputCases: 7, noCredentialBindingOrCandidateWrites: true, networkCalls: 0, providerCalls: 0, databaseWrites: 0 }, null, 2));
}
