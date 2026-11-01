import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const metadata = {};
vm.runInNewContext(compile(fs.readFileSync('src/lib/server/platform-configuration-pending-credentials.ts', 'utf8')), {
  exports: metadata, Buffer, require: name => { assert.equal(name, 'node:crypto'); return crypto; },
});
class ConfigurationError extends Error { constructor(code, message) { super(message); this.code = code; } }
const releaseId = crypto.randomUUID();
let reads = 0;
let exists = true;
let data = [{ modelKey: 'llm_models:fixture-model', credentialRef: 'secret://fixture-private-ref',
  pendingRevision: crypto.randomUUID(), expectedExists: false, expectedRevision: null, state: 'pending' }];
const query = { select() { return query; }, eq() { return query; }, async maybeSingle() { reads++; return { data: exists ? { id: releaseId } : null, error: null }; } };
const api = {};
vm.runInNewContext(compile(fs.readFileSync('src/lib/server/model-pool-credential-status.ts', 'utf8')), {
  exports: api,
  require(name) {
    if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => ({ from: () => query,
      rpc: async (rpc, args) => { reads++; assert.equal(rpc, 'read_platform_model_pending_credential_metadata'); assert.equal(args.p_release_id, releaseId); return { data, error: null }; } }) };
    if (name === './platform-configuration-admin') return { PlatformConfigurationError: ConfigurationError };
    if (name === './platform-configuration-pending-credentials') return metadata;
    throw Error(`UNEXPECTED_CREDENTIAL_STATUS_DEPENDENCY:${name}`);
  },
});
await assert.rejects(() => api.modelPoolCredentialStatus('invalid'), /候选编号无效/u); assert.equal(reads, 0);
for (const state of ['pending', 'applied']) {
  data[0].state = state;
  const safe = await api.modelPoolCredentialStatus(releaseId);
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), [{ modelKey: 'llm_models:fixture-model', expectedExists: false, state }]);
  assert.doesNotMatch(JSON.stringify(safe), /credentialRef|secret:\/\/|Revision|fingerprint|secret_value/u);
}
exists = false;
await assert.rejects(() => api.modelPoolCredentialStatus(releaseId), error => error.code === 'PLATFORM_CONFIGURATION_RELEASE_NOT_FOUND');
exists = true; data = [];
assert.equal((await api.modelPoolCredentialStatus(releaseId)).length, 0);
const routeSource = fs.readFileSync('src/app/api/admin/model-pool-releases/route.ts', 'utf8');
const ast = ts.createSourceFile('release-route.ts', routeSource, ts.ScriptTarget.Latest, true);
const get = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'GET');
let authorized = true;
const route = {};
vm.runInNewContext(compile(get.getText(ast)), { exports: route, ...api, kind: 'model-pool', noStore: {},
  requireCommerceAdmin: async () => authorized ? { actor: { userId: 'fixture-actor' } } : { response: Response.json({ error: 'denied' }, { status: 403 }) },
  NextResponse: { json: (value, options) => Response.json(value, options) }, failure: () => { throw Error('UNEXPECTED_STATUS_ROUTE_FAILURE'); },
});
const request = { nextUrl: new URL(`http://127.0.0.1:5000/api/admin/model-pool-releases?credentialReleaseId=${releaseId}`) };
assert.equal((await route.GET(request)).status, 200);
const readsBefore = reads; authorized = false;
assert.equal((await route.GET(request)).status, 403); assert.equal(reads, readsBefore);
console.log(JSON.stringify({ passed: true, actualStatusHelperAndGet: true, invalidIdRejectedBeforeReads: true,
  metadataFields: ['modelKey', 'expectedExists', 'state'], privateFieldsEmitted: 0,
  historicalAppliedAndNoChangesHandled: true, unauthorizedDatabaseReads: 0,
  networkCalls: 0, databaseWrites: 0, providerCalls: 0 }));
