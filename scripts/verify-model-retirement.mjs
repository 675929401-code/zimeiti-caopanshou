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

const retirement = load(await readFile('src/lib/model-retirement.ts', 'utf8'));
const source = await readFile('src/app/api/admin/models/route.ts', 'utf8');
const parsed = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'DELETE');
const handlerSource = ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, parsed);
let admin = true, deleteError = null, failUpdate = false, updates = [], retired = null;
const db = { from() { return {
  delete() { return { eq: async () => ({ error: deleteError }) }; },
  update(patch) { updates.push(patch); retired = { id: 'fixture', ...patch }; const q = { eq() { return q; }, select() { return q; }, maybeSingle: async () => ({ data: retired, error: failUpdate ? { code: 'FIXTURE' } : null }) }; return q; },
}; } };
const handler = load(handlerSource, { ...retirement, getSupabaseClient: () => db, requireAdmin: async () => admin ? { role: 'admin' } : null, NextResponse: { json: (body, options) => Response.json(body, options) } });
const run = (kind = 'video') => handler.DELETE(new Request('http://localhost/api/admin/models?model_type='+kind+'&id=fixture', { method: 'DELETE' }));
assert.equal((await run()).status, 200); assert.equal(updates.length, 0);
deleteError = { code: '23503' }; const response = await run(); assert.equal(response.status, 200); assert.equal((await response.json()).historyReferencePreserved, true);
assert.equal(retired.api_key, ''); assert.equal(retired.api_endpoint, ''); assert.equal(retired.is_active, false); assert.equal(retired.provider, retirement.RETIRED_MODEL_PROVIDER);
assert.deepEqual(JSON.parse(JSON.stringify(retired.api_protocol_config)), {});
await run('drawing'); assert.equal('admin_notes' in retired, false, 'cover_models has no admin_notes column');
updates = []; deleteError = { code: '42501' }; assert.equal((await run()).status, 500); assert.equal(updates.length, 0, 'permission failures must not turn into false success');
deleteError = { code: '23503' }; failUpdate = true; assert.equal((await run()).status, 500);
admin = false; updates = []; assert.equal((await run()).status, 403); assert.equal(updates.length, 0);
console.log(JSON.stringify({ passed: 6, actualDeleteHandler: true, realDatabaseWrites: 0, realNetwork: 0 }));
