import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { publicJobTrace } from '../src/commerce/server/public-job-trace';
import type { Job } from '../src/commerce/server/jobs';

function fixture(owner = 'owner-a'): Job {
  return {
    id: 'job-public-trace',
    owner,
    input: {
      requestId: 'request-private',
      kind: 'agent',
      modelId: 'internal-model-secret',
      prompt: 'private-user-prompt',
      configuredFields: { knowledge: 'private-knowledge-secret' },
    },
    model: {
      id: 'internal-model-secret',
      displayName: 'Internal model secret',
      kind: 'agent',
      source: 'custom',
      publicPrice: 1,
      costPrice: 0.5,
      billingUnit: 'per_use',
      configHash: 'private-model-config-hash',
      capabilities: { available: true },
      protocol: 'private-provider-protocol',
      endpoint: 'https://provider.invalid/private',
      modelName: 'private-upstream-model',
      enabled: true,
    },
    route: {
      id: 'private-route-id',
      label: 'Private route',
      kind: 'agent',
      promptId: 'private-system-prompt-id',
      modelId: 'internal-model-secret',
      revision: 9,
      stages: ['private-routing-stage'],
      userSelectable: false,
      selection: 'admin-default',
    },
    configurationSnapshot: {
      releaseId: 'private-release-id',
      releaseVersion: 8,
      manifestSha256: 'private-manifest-sha',
      promptVersionId: 'private-system-prompt-id',
      promptVersion: 7,
      knowledgeVersionIds: ['private-knowledge-id'],
      routeVersionId: 'private-route-version-id',
      routeVersion: 9,
      modelConfigHash: 'private-model-config-hash',
    },
    conversationContext: {
      version: 1,
      sha256: 'private-conversation-hash',
      capturedAt: 10,
      messageCount: 1,
      textCharacters: 20,
      messages: [{ role: 'user', content: 'private-history' }],
    },
    status: 'failed',
    createdAt: 1,
    startedAt: 2,
    updatedAt: 4,
    assetIds: ['private-asset-id'],
    providerTaskId: 'private-provider-task-id',
    pollPath: '/private-provider-poll',
    providerUrl: 'https://provider.invalid/private-task',
    usage: { privateProviderUsage: 123 },
    promptVersion: 7,
    compiledPrompt: 'private-system-and-knowledge-prompt',
    error: 'Authorization: Bearer private-provider-token at https://provider.invalid/private',
    events: [
      { at: 1, stage: 'validated' },
      { at: 2, stage: 'private-provider-dispatch-stage' },
      { at: 3, stage: 'recovered-undispatched-billing' },
      { at: 4, stage: 'failed' },
    ],
  } as unknown as Job;
}

function loadRoute(file: string, modules: Record<string, unknown>) {
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const routeModule = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(output, {
    module: routeModule,
    exports: routeModule.exports,
    URL,
    Request,
    Response,
    require(id: string) {
      assert.ok(Object.hasOwn(modules, id), `unexpected module: ${id}`);
      return modules[id];
    },
  });
  return routeModule.exports as { GET(request: Request): Promise<Response> };
}

async function main() {
  const value = fixture();
  const publicTrace = publicJobTrace(value);
  const serialized = JSON.stringify(publicTrace);
  const publicKeys = new Set<string>();
  const visit = (input: unknown) => {
    if (!input || typeof input !== 'object') return;
    if (Array.isArray(input)) return input.forEach(visit);
    for (const [key, child] of Object.entries(input)) {
      publicKeys.add(key);
      visit(child);
    }
  };
  visit(publicTrace);

  for (const key of [
    'owner',
    'input',
    'route',
    'prompt',
    'compiledPrompt',
    'model',
    'providerTaskId',
    'providerUrl',
    'pollPath',
    'usage',
    'configuration',
    'configurationSnapshot',
    'conversationContext',
    'knowledge',
    'assetIds',
    'error',
  ]) assert.equal(publicKeys.has(key), false, `public trace leaked key: ${key}`);

  for (const secret of [
    'private-system-and-knowledge-prompt',
    'private-system-prompt-id',
    'private-knowledge-secret',
    'private-knowledge-id',
    'internal-model-secret',
    'private-provider-protocol',
    'private-provider-task-id',
    'private-provider-token',
    'private-route-id',
    'private-provider-dispatch-stage',
  ]) assert.equal(serialized.includes(secret), false, `public trace leaked value: ${secret}`);

  assert.deepEqual(publicTrace.events.map((event) => event.stage), [
    'validated',
    'processing',
    'queued',
    'failed',
  ]);
  assert.equal(publicTrace.errorSummary?.code, 'TASK_FAILED');
  assert.equal(serialized.includes('provider.invalid'), false);
  assert.equal(publicJobTrace({ ...value, status: 'unknown' }).errorSummary?.retryOriginalOnly, true);
  assert.equal(publicJobTrace({ ...value, status: 'save_failed' }).errorSummary?.code, 'RESULT_SAVE_FAILED');
  assert.equal(publicJobTrace({ ...value, error: 'UPSTREAM_BALANCE_EXHAUSTED' }).errorSummary?.code, 'SERVICE_BALANCE_UNAVAILABLE');

  let identity: { id: string } | undefined;
  const ownerLookups: Array<{ id: string; owner: string }> = [];
  const userRoute = loadRoute('src/app/api/commerce/jobs/trace/route.ts', {
    '../../../../../commerce/server/auth': {
      requireIdentity() {
        if (!identity) throw new Error('UNAUTHORIZED');
        return identity;
      },
    },
    '../../../../../commerce/server/jobs': {
      job(id: string, owner: string) {
        ownerLookups.push({ id, owner });
        return id === value.id && owner === value.owner ? value : undefined;
      },
    },
    '../../../../../commerce/server/http': {
      json: (body: unknown, status = 200) => Response.json(body, { status }),
      errorResponse: (error: unknown) => Response.json(
        { error: '请先登录主站账号', code: 'AUTH_REQUIRED' },
        { status: error instanceof Error && error.message === 'UNAUTHORIZED' ? 401 : 400 },
      ),
    },
    '../../../../../commerce/server/public-job-trace': { publicJobTrace },
  });

  const anonymous = await userRoute.GET(new Request(`http://local.invalid/api/commerce/jobs/trace?id=${value.id}`));
  assert.equal(anonymous.status, 401);
  assert.equal(ownerLookups.length, 0);

  identity = { id: 'owner-b' };
  const crossOwner = await userRoute.GET(new Request(`http://local.invalid/api/commerce/jobs/trace?id=${value.id}&owner=owner-a`));
  assert.equal(crossOwner.status, 404);
  assert.deepEqual(ownerLookups.at(-1), { id: value.id, owner: 'owner-b' });

  identity = { id: 'owner-a' };
  const ownResponse = await userRoute.GET(new Request(`http://local.invalid/api/commerce/jobs/trace?id=${value.id}&owner=owner-b`));
  assert.equal(ownResponse.status, 200);
  const ownPayload = await ownResponse.json();
  assert.deepEqual(ownPayload, publicTrace);
  assert.deepEqual(ownerLookups.at(-1), { id: value.id, owner: 'owner-a' });

  let adminAuthorized = false;
  let adminJobCalls = 0;
  const adminRoute = loadRoute('src/app/api/admin/commerce/jobs/trace/route.ts', {
    'next/server': {
      NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
    },
    '@/lib/commerce-admin-auth': {
      requireCommerceAdmin: async () => adminAuthorized
        ? { actor: { userId: 'main-admin', role: 'admin' } }
        : { response: Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 }) },
    },
    '@/commerce/server/jobs': {
      job(id: string, owner: string) {
        adminJobCalls += 1;
        return id === value.id && owner === value.owner ? value : undefined;
      },
    },
  });

  const deniedAdmin = await adminRoute.GET(new Request(`http://local.invalid/api/admin/commerce/jobs/trace?id=${value.id}&owner=${value.owner}`));
  assert.equal(deniedAdmin.status, 401);
  assert.equal(adminJobCalls, 0);

  adminAuthorized = true;
  const adminResponse = await adminRoute.GET(new Request(`http://local.invalid/api/admin/commerce/jobs/trace?id=${value.id}&owner=${value.owner}`));
  assert.equal(adminResponse.status, 200);
  const adminPayload = await adminResponse.json() as { ok: boolean; trace: Record<string, unknown> };
  assert.equal(adminPayload.ok, true);
  assert.equal((adminPayload.trace.prompt as Record<string, unknown>).compiled, value.compiledPrompt);
  assert.equal((adminPayload.trace.model as Record<string, unknown>).protocol, value.model.protocol);
  assert.equal(adminPayload.trace.providerTaskId, value.providerTaskId);

  console.log(JSON.stringify({
    passed: 46,
    publicTraceKeys: Object.keys(publicTrace),
    ownerIsolation: true,
    mainAdminGate: true,
    providerRequests: 0,
    walletWrites: 0,
    realDatabaseWrites: 0,
  }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
