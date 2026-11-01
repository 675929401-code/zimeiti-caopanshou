import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const CODE = 'PLATFORM_CONFIGURATION_CREDENTIAL_REMOVAL_COMBINATION_REJECTED';
const MESSAGE = '此候选同时包含密钥变更和模型下架，请先单独发布密钥变更，再创建下架候选。';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const migrationPath = 'supabase/migrations/20261030030000_model_pool_credential_removal_combination_guard.sql';
const priorPath = 'supabase/migrations/20261030020000_platform_pending_credentials_base_and_llm_removal.sql';
const sql = fs.readFileSync(migrationPath, 'utf8'), prior = fs.readFileSync(priorPath, 'utf8');
assert.equal(sha(prior), '2b0de90f3a940d855f9be68232433bb7d67321e2ca87f9a1ad3ad1efbd1c8532', 'APPLIED_187_BYTES_MUST_NOT_CHANGE');
assert.equal(sha(fs.readFileSync('supabase/migrations/20261030010000_platform_configuration_pending_credentials.sql')), '2823d96c17df7126859ae1f2f626007a62838f8d8802fcadcbb3844d98e593c3', 'APPLIED_186_BYTES_MUST_NOT_CHANGE');
const marker = 'CREATE OR REPLACE FUNCTION public.publish_platform_configuration_release_atomic';
function publisher(text) { const start = text.indexOf(marker); assert.ok(start > 0); return text.slice(start, text.indexOf('END $function$;', start) + 'END $function$;'.length); }
const oldFunction = publisher(prior), newFunction = publisher(sql);
const guardStart = newFunction.indexOf('  -- A strict unchanged subset projects only removals');
const guardEnd = newFunction.indexOf('  -- Verify every expected revision first', guardStart);
assert.ok(guardStart > 0 && guardEnd > guardStart);
const insertedGuard = newFunction.slice(guardStart, guardEnd);
assert.equal(newFunction.slice(0, guardStart) + newFunction.slice(guardEnd), oldFunction, '188_MUST_ONLY_INSERT_ONE_GUARD');
assert.equal(sha(oldFunction.split('AS $function$')[1].split('$function$;')[0]), '462e0aa08ed4fe5418adef4d9d68b2b677ffafb3dd5dada6cb5a1a59dc2280e9');
assert.match(sql, /v_proc\.proacl::text IS DISTINCT FROM '\{zimeiti_owner=X\/zimeiti_owner,service_role=X\/zimeiti_owner\}'/u);
for (const metadata of ["pg_get_userbyid(v_proc.proowner) IS DISTINCT FROM 'zimeiti_owner'", "v_proc.prosecdef IS DISTINCT FROM true", "v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']", "v_proc.provolatile IS DISTINCT FROM 'v'", "v_proc.proparallel IS DISTINCT FROM 'u'", "v_proc.proisstrict IS DISTINCT FROM false", "v_proc.proleakproof IS DISTINCT FROM false", "v_proc.prokind IS DISTINCT FROM 'f'", "v_proc.prorettype IS DISTINCT FROM 'jsonb'::regtype", "IS DISTINCT FROM '462e0aa08ed4fe5418adef4d9d68b2b677ffafb3dd5dada6cb5a1a59dc2280e9'"]) assert.ok(sql.includes(metadata), metadata);
assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gu) || []).length, 1);
assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|ALTER\s+FUNCTION|ALTER\s+TABLE|CREATE\s+(?:TABLE|TRIGGER)|set_config)\b/iu);
assert.ok(newFunction.indexOf("IF v_candidate.is_current AND v_candidate.status='published'") < guardStart);
assert.ok(newFunction.indexOf('PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED') < guardStart);
assert.ok(guardEnd < newFunction.indexOf('UPDATE public.platform_model_credential_bindings'));
assert.ok(newFunction.indexOf("IF p_kind='workspace-models'") < guardStart);
for (const predicate of ['IF v_has_current', "WHERE release_id=p_release_id AND state='pending'", "jsonb_typeof(v_current.snapshot->'models') = 'array'", "jsonb_typeof(v_candidate.snapshot->'models') = 'array'", "jsonb_array_length(v_candidate.snapshot->'models') < jsonb_array_length(v_current.snapshot->'models')", "FROM jsonb_array_elements(v_candidate.snapshot->'models') next(model)", "FROM jsonb_array_elements(v_current.snapshot->'models') old(model)", 'WHERE old.model = next.model']) assert.ok(insertedGuard.includes(predicate), predicate);
assert.doesNotMatch(insertedGuard, /->>'id'|snapshot\s*-\s*'models'|credential_bindings|UPDATE|INSERT|DELETE/iu, 'GUARD_MUST_COMPARE_COMPLETE_MODEL_ITEMS_WITHOUT_ANY_WRITES');

function declaration(file, name) {
  const text = fs.readFileSync(file, 'utf8'), tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(item => (ts.isFunctionDeclaration(item) || ts.isClassDeclaration(item)) && item.name?.text === name);
  assert.ok(node, `ACTUAL_DECLARATION_REQUIRED:${name}`); return node.getText(tree).replace(/^export\s+/u, '');
}
function evaluate(code, globals = {}) {
  const module = { exports: null };
  vm.runInNewContext(ts.transpileModule('module.exports=' + code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { module, Error, ...globals });
  return module.exports;
}
const adminPath = 'src/lib/server/platform-configuration-admin.ts';
const PlatformConfigurationError = evaluate(declaration(adminPath, 'PlatformConfigurationError'));
const classifier = evaluate(declaration('src/lib/server/model-pool-mutation-http.ts', 'modelPoolMutationFailure'), {
  PlatformConfigurationError, UUID: /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu,
  NextResponse: { json: (body, options) => Response.json(body, options) },
});
const actorId = '53000000-0000-4000-8000-000000000001', releaseId = '53000000-0000-4000-8000-000000000002';
const existing = { id: releaseId, status: 'validated', is_current: false };
async function actualPublish(message, { kind = 'model-pool', row = existing, success = false } = {}) {
  const counters = { rpc: 0, readback: 0, preview: 0, validation: 0 };
  const preview = { previewSha256: 'preview', candidate: { snapshotSha256: 'a'.repeat(64) }, current: { releaseId: 'previous', snapshotSha256: 'b'.repeat(64) } };
  const publish = evaluate(declaration(adminPath, 'publishPlatformConfigurationRelease'), {
    PlatformConfigurationError, requireUuid: value => value, release: async () => row,
    previewPlatformConfigurationRelease: async () => { counters.preview++; return preview; },
    assertPlatformConfigurationPublishReady: async () => {}, validatePlatformConfigurationCandidate: async () => { counters.validation++; },
    assertWorkspaceDependencyIsCurrent: async () => {}, snapshotFromRow: () => ({}),
    getSupabaseAdminClient: () => ({ rpc: async (name, args) => { counters.rpc++; assert.equal(name, 'publish_platform_configuration_release_atomic'); assert.equal(args.p_kind, kind); return success ? { data: {}, error: null } : { error: { message, details: 'PRIVATE_DATABASE_ROW_FIXTURE' } }; } }),
    currentRelease: async () => { counters.readback++; return { id: releaseId, status: 'published', is_current: true, snapshot_sha256: 'a'.repeat(64) }; },
  });
  try { return { result: await publish(actorId, kind, releaseId, 'preview'), counters }; }
  catch (error) { return { error, counters }; }
}
const denied = await actualPublish(CODE);
assert.ok(denied.error instanceof PlatformConfigurationError); assert.equal(denied.error.code, CODE); assert.equal(denied.error.message, MESSAGE);
assert.equal(denied.counters.rpc, 1); assert.equal(denied.counters.readback, 0);
const response = classifier(denied.error), payload = await response.json();
assert.equal(response.status, 409); assert.equal(payload.error, MESSAGE); assert.equal(payload.code, CODE); assert.equal(payload.success, false);
assert.equal(payload.published, undefined); assert.equal(payload.outcome, undefined); assert.equal(payload.result, undefined);
assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_DATABASE_ROW_FIXTURE|secret_value|fingerprint/u);
for (const message of [CODE + '_EXTRA', 'PRIVATE_DATABASE_ROW_FIXTURE ' + CODE, 'unreviewed_provider_failure']) {
  const unknown = await actualPublish(message); assert.equal(unknown.error.code, 'PLATFORM_CONFIGURATION_PUBLISH_FAILED');
  const classified = classifier(unknown.error); assert.equal(classified.status, 503); assert.doesNotMatch(await classified.text(), /PRIVATE_DATABASE_ROW_FIXTURE|unreviewed_provider_failure/u);
}
for (const code of ['PLATFORM_CONFIGURATION_CREDENTIAL_CANDIDATE_BASE_CHANGED', 'PLATFORM_CONFIGURATION_CREDENTIAL_CONFLICT', 'PLATFORM_CONFIGURATION_ALREADY_PUBLISHED_NOT_CURRENT']) {
  const result = await actualPublish(code); assert.equal(result.error.code, code); assert.equal(classifier(result.error).status, 409);
}
for (const kind of ['model-pool', 'workspace-models']) { const result = await actualPublish(null, { kind, success: true }); assert.equal(result.result.is_current, true); assert.equal(result.counters.rpc, 1); assert.equal(result.counters.readback, 1); }
const replay = await actualPublish(CODE, { row: { ...existing, status: 'published', is_current: true } });
assert.equal(replay.result.status, 'published'); assert.equal(replay.counters.rpc, 0); assert.equal(replay.counters.preview, 0);
const report = { passed: true, staticSqlContract: 'Only exact 187 publisher guard insertion, full-item JSONB subset semantics and exact metadata precondition; no SQL execution claimed.',
  actualFunctions: ['publishPlatformConfigurationRelease', 'PlatformConfigurationError', 'modelPoolMutationFailure'], checks: ['exact reviewed SQL code maps to409+specified Chinese without published success', 'unknown/suffixed/private PG error remains503 and redacted', 'existing stale-parent/CAS/superseded errors preserved', 'model-pool/workspace success and current replay preserved'],
  migrationSha256: sha(sql), expectedPriorProsrcSha256: '462e0aa08ed4fe5418adef4d9d68b2b677ffafb3dd5dada6cb5a1a59dc2280e9', newProsrcSha256: sha(newFunction.split('AS $function$')[1].split('$function$;')[0]), networkCalls: 0, databaseCalls: 0, providerCalls: 0 };
const evidence = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/model-pending-credentials/followup188'; fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(evidence + '/zero-network-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
