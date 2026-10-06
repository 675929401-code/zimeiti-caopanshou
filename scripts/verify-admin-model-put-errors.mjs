import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
function load(source, globals = {}, requireModule = nativeRequire) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, Date, Number, String, Object, JSON, Error, process: { env: {} }, require: requireModule, console: { error() {}, warn() {} }, ...globals });
  return module.exports;
}
const gate = load(await readFile('src/lib/model-activation-gate.ts', 'utf8'), {}, name => name === '@/lib/provider-secret' ? { resolveProviderSecret: () => 'synthetic-resolved-credential' } : nativeRequire(name));
const source = await readFile('src/app/api/admin/models/route.ts', 'utf8');
const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const node = file.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'PUT'); assert.ok(node);
const handlerSource = ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, file);
let admin = true, writes = 0, lastUpdate = null;
const pending = gate.forceNewVideoModelPending({ id: 'synthetic-video', provider: 'openai_compatible', protocol_type: 'openai_compatible', model_name: 'synthetic-upstream', api_endpoint: 'https://example.invalid/v1', api_key: 'fixture-not-a-provider-key', api_protocol_config: {} });
const db = { from() { const query = { select() { return query; }, eq() { return query; }, async maybeSingle() { return { data: pending, error: null }; } }; return query; } };
const handler = load(handlerSource, { ...gate, authorizeModelWrite: async () => admin ? { ok: true, actor: { userId: '00000000-0000-4000-8000-000000000001' } } : { ok: false, response: Response.json({ error: 'forbidden' }, { status: 403 }) }, getSupabaseClient: () => db, NextResponse: { json: (body, options) => Response.json(body, options) }, RETIRED_MODEL_PROVIDER: 'retired_configuration', isPermanentlyRetiredModel: () => false, AUTODL_H3_SELFHOST_PROVIDER: 'synthetic-selfhost', AUTODL_H3_SELFHOST_PROTOCOL: 'synthetic-selfhost', AUTODL_COMFYUI_WORKFLOW_PROTOCOL: 'synthetic-comfyui', matchesAutodlH3SelfhostVideoEndpoint: () => false, assertAdminAutodlH3SelfhostBinding() {}, replacementApiKey: () => undefined, normalizeAutodlH3SelfhostVideoFields: fields => fields, videoPriceConfigurationError: () => null, stageLegacyModelPoolUpsert: async ({ values }) => { writes++; lastUpdate = values; return { release: { id: '00000000-0000-4000-8000-000000000002' } }; }, ImageAdminValidationError: class extends Error {}, AutodlH3SelfhostConfigError: class extends Error {}, ModelActivationGateError: gate.ModelActivationGateError });
const request = body => new Request('http://127.0.0.1:5002/api/admin/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const activation = await handler.PUT(request({ id: pending.id, model_type: 'video', is_active: false, is_hidden: true }));
assert.equal(activation.status, 202); const updated = await activation.json(); assert.equal(updated.staged, true); assert.equal(updated.published, false); assert.equal(lastUpdate.is_active, true); assert.equal(lastUpdate.is_hidden, false); assert.equal(writes, 1);
admin = false; assert.equal((await handler.PUT(request({ id: pending.id, model_type: 'video', is_active: false }))).status, 403); assert.equal(writes, 1);
admin = true; assert.equal((await handler.PUT(request({ model_type: 'video' }))).status, 400); assert.equal(writes, 1);
console.log(JSON.stringify({ passed: 3, actualPutHandler: true, forcedActiveVisible: true, fixtureWrites: writes, realNetwork: 0, realDatabaseWrites: 0 }));
