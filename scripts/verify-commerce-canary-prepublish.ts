import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const fixture = path.resolve('.codex-evidence', `commerce-canary-prepublish-${Date.now()}`);
  process.env.COMMERCE_DATA_DIR = fixture;
  Reflect.set(process.env, 'NODE_ENV', 'development');
  process.env.SHARED_CONFIGURATION_ENABLED = '1';
  process.env.SHARED_CONFIGURATION_SUPABASE_URL = 'https://shared-config.invalid/';
  process.env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY = 'fixture-shared-role';
  process.env.COZE_SUPABASE_URL = 'https://business-data.invalid/';
  process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = 'fixture-business-role';
  process.env.MAIN_MODEL_ORIGIN = 'https://main-gateway.invalid/';
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'main-gateway.key'), 'fixture-gateway-key');

  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url.href);
    if (url.hostname === 'main-gateway.invalid' && url.pathname === '/api/commerce-model-gateway' && url.searchParams.get('kind') === 'agent') {
      return new Response(JSON.stringify({ models: [{
        id: 'fixture-agent-model', displayName: 'Fixture Agent', kind: 'agent', source: 'main', publicPrice: 1.1,
        costPrice: 1, billingUnit: 'per_use', configHash: 'fixture-agent-hash',
        capabilities: { available: true, executionSupported: true, imageParsing: true },
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'shared-config.invalid') {
      return new Response(JSON.stringify({ message: 'commerce_config_releases is unavailable in this fixture' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected test network call: ${url.href}`);
  }) as typeof fetch;

  const { createJob } = await import('../src/commerce/server/jobs');
  const base = {
    requestId: '11111111-1111-4111-8111-111111111111',
    kind: 'agent' as const,
    modelId: '',
    purpose: 'commerce-canary',
    prompt: '[COMMERCE-CANARY-FIXTURE] create only; never dispatch',
  };

  const created = await createJob('canary-owner', base, undefined, { adminCanaryModelId: 'fixture-agent-model' });
  assert.equal(created.status, 'queued');
  assert.equal(created.model.id, 'fixture-agent-model');
  assert.equal(created.route?.id, 'commerce-canary.agent');
  assert.equal(created.route?.selection, 'admin-canary');
  assert.equal(created.configurationSnapshot, undefined, 'pre-publish canary must not invent a published configuration snapshot');
  assert.match(created.compiledPrompt, /电商视觉制作助手/u);
  assert.ok(calls.some((url) => url.includes('shared-config.invalid')), 'the test must exercise the missing shared release path');
  assert.equal(calls.filter((url) => url.includes('commerce-model-gateway')).length, 1, 'create only reads the model catalog and never dispatches the provider');

  await assert.rejects(
    () => createJob('canary-owner', { ...base, requestId: '22222222-2222-4222-8222-222222222222', purpose: 'agent-chat' }, undefined, { adminCanaryModelId: 'fixture-agent-model' }),
    /管理员 canary 模型覆盖只能用于受控验收任务/u,
  );
  await assert.rejects(
    () => createJob('canary-owner', { ...base, requestId: '33333333-3333-4333-8333-333333333333' }),
    /COMMERCE_CONFIG_RELEASE_/u,
  );

  console.log(JSON.stringify({
    passed: 10,
    providerDispatchCalls: 0,
    paidCalls: 0,
    checks: ['missing-release-exercised', 'admin-canary-created', 'explicit-model-bound', 'baseline-prompt-bound', 'no-fake-release-snapshot', 'wrong-purpose-rejected', 'missing-internal-context-fails-closed'],
    fixture,
  }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
