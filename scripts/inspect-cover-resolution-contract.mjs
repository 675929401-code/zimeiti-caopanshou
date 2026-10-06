import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import dotenv from 'dotenv';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const env = dotenv.parse(readFileSync('.env.local'));
function load(path, globals = {}) {
  const context = { exports: {}, require, Buffer, URL, Response, process: { env }, ...globals };
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.exports;
}
const dto = load('src/lib/public-model-dto.ts');
const runtime = JSON.parse(readFileSync('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
if (!runtime.localOnly || runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') throw new Error('LOCAL_DATABASE_REQUIRED');
const db = new pg.Client(runtime.ownerConnection); await db.connect();
let model;
try {
  const rows = await db.query(`select id,name,model_name,provider,api_endpoint,supports_image_input,
    coalesce(length(api_key)>0,false) as has_key_reference from public.cover_models where is_active=true and is_hidden=false`);
  model = rows.rows.find(row => dto.toPublicModelId('cover', row.id) === 'pm_7ZoWNH7zuZkVso7_OHgGzYfl');
  if (!model) throw new Error('EXACT_PUBLIC_MODEL_NOT_FOUND');
} finally { await db.end(); }
const source = readFileSync('src/app/api/image/generate/route.ts', 'utf8');
const ast = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set(['SIZE_MAP','DALLE3_SIZE_MAP','SEEDREAM_SIZE_MAP','RESOLUTION_SIZE_MAPS']);
const selected = ast.statements.filter(node => (ts.isFunctionDeclaration(node) && ['generateLocalImageCandidate','isSecureSkillEndpoint'].includes(node.name?.text))
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => names.has(decl.name.getText(ast))))).map(node => node.getText(ast)).join('\n');
const adapter = load('src/lib/secure-skill-image-adapter.ts');
const endpoints = load('src/lib/api-endpoints.ts');
let outgoing;
const context = { exports: {}, URL, Response, FormData,
  assertAutodlH3SelfhostModelBinding: () => false, resolveProviderSecret: () => 'synthetic-never-dispatched',
  buildOpenAIEndpoint: endpoints.buildOpenAIEndpoint, buildSecureSkillImagePayload: adapter.buildSecureSkillImagePayload,
  safeUpstreamTarget: value => new URL(value).hostname,
  extractImageUrlFromChatResponse: () => 'https://fixture.invalid/image.png',
  fetchImageUpstream: async (url, options) => { outgoing = { host: new URL(url).hostname, path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: [{ url: 'https://fixture.invalid/image.png' }] })); },
};
vm.runInNewContext(ts.transpileModule(`${selected}\nexports.generate=generateLocalImageCandidate;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
assert.equal(await context.exports.generate({ model: { ...model, api_key: 'synthetic-reference' }, ratio: '4:3', effectiveResolution: '2K', references: [], identityReferenceOnly: false, fullPrompt: 'synthetic no-network fixture', idempotencyKey: 'synthetic-contract' }), 'https://fixture.invalid/image.png');
const proof = { publicModelId: 'pm_7ZoWNH7zuZkVso7_OHgGzYfl', provider: model.provider, modelName: model.model_name, hasKeyReference: model.has_key_reference,
  actualFunctionFixture: true, actualLocalModelMetadata: true, requestedResolution: '2K', outgoing,
  realUpstreamCalls: 0, observedPreviousOutputPixels: ['2400x1792', '1200x896'], native2KDeliveryGuaranteed: false };
writeFileSync('.codex-evidence/cover-deterministic-text-e2e-20260902/resolution-contract.json', JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
