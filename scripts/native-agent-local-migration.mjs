#!/usr/bin/env node
// REVIEW CANDIDATE: fixed local target and one reviewed migration only. Never invokes the prefix runner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = 'F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本';
export const TARGET = Object.freeze({ host: '127.0.0.1', port: 54322, database: 'zimeiti_local' });
export const CANDIDATE = Object.freeze({ version: '20261110150000', name: '20261110150000_native_agent_sdk_runtime.sql', slug: 'native_agent_sdk_runtime', sha256: 'd9d6a4b01330a013b8470b15c34e22f8630ee1ee715b98ec8529e9efec98aef3' });
export const RECOVERY_HASH = '92485af5b003f80443230f044428342b0e4b11160c3a0f763473f0e936574448';
export const LOCK_ID = '260830500011';
const OWNER = 'zimeiti_owner';
const SELF = fileURLToPath(import.meta.url);
const RUNNER_SHA = 'a4b0539ccb2a97597f7887330a4068240eb9ae7fe9926c2da0971db3cab651c1';
const RUNTIME = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const NEW_TABLES = ['pub_native_agent_runtime_config', 'pub_native_agent_runtime_calls', 'pub_native_agent_runtime_sessions', 'pub_native_agent_wallet_policy'];
const NEW_FUNCTIONS = ['pub_native_sdk_canonical', 'mutate_native_agent_runtime_config', 'mutate_native_agent_sdk', 'mutate_native_agent_legacy_atomic', 'native_agent_reservation_safety'];
const DEPENDENCY_TABLES = ['users', 'llm_models', 'llm_request_attempts', 'llm_credit_reservations', 'pub_native_agent_tasks', 'pub_native_agent_turns', 'pub_native_agent_events'];
// [PostgreSQL format_type, attnotnull]. These are the actual source contracts,
// including the columns used by finish-call's independent wallet/attempt joins.
const REQUIRED_COLUMNS = {
  users: { id: ['character varying(36)', true], role: ['character varying(20)', true], is_active: ['boolean', true], credits: ['numeric', true], credits_reserved: ['numeric(20,6)', true] },
  llm_models: { id: ['uuid', true], name: ['character varying(200)', true], model_name: ['character varying(200)', true], provider: ['text', false], api_protocol_config: ['jsonb', true], token_billing_enabled: ['boolean', false],
    input_cost_per_million: ['numeric', false], output_cost_per_million: ['numeric', false], cached_cost_per_million: ['numeric', false], profit_margin: ['numeric', false] },
  llm_request_attempts: { record_id: ['text', true], user_id: ['text', true], client_request_id: ['text', true], payload_fingerprint: ['text', true], state: ['text', true], attempt_no: ['integer', true],
    lease_owner: ['text', false], lease_token: ['bigint', true], lease_expires_at: ['timestamp with time zone', false], provider_call_started_at: ['timestamp with time zone', false], http_status: ['integer', false],
    response_headers: ['jsonb', true], response_body: ['text', false], response_fingerprint: ['text', false], result_reference: ['text', false], error_code: ['text', false], error_message: ['text', false], created_at: ['timestamp with time zone', true], updated_at: ['timestamp with time zone', true] },
  llm_credit_reservations: { record_id: ['text', true], user_id: ['text', true], client_request_id: ['text', true], lease_token: ['bigint', true], lease_owner: ['text', true], status: ['text', true],
    price_snapshot: ['jsonb', true], amount: ['numeric(20,6)', true], actual_amount: ['numeric(20,6)', false], receipt: ['jsonb', false], reason: ['text', false], created_at: ['timestamp with time zone', true], expires_at: ['timestamp with time zone', true], completed_at: ['timestamp with time zone', false] },
  pub_native_agent_tasks: { id: ['uuid', true], owner_id: ['character varying(36)', true], title: ['text', true], status: ['text', true], revision: ['integer', true], next_seq: ['bigint', true], archived: ['boolean', true],
    favorited_at: ['timestamp with time zone', false], rating: ['integer', false], rating_comment: ['text', true], created_at: ['timestamp with time zone', true], updated_at: ['timestamp with time zone', true] },
  pub_native_agent_turns: { id: ['uuid', true], owner_id: ['character varying(36)', true], task_id: ['uuid', true], request_key: ['text', true], request_hash: ['text', true], input_snapshot: ['jsonb', true], policy_snapshot: ['jsonb', true], model_public_id: ['text', true], main_request_key: ['text', true], main_attempt_id: ['text', false], state: ['text', true],
    response_text: ['text', true], error_code: ['text', false], revision: ['integer', true], lease_owner: ['uuid', false], lease_expires_at: ['timestamp with time zone', false], created_at: ['timestamp with time zone', true], updated_at: ['timestamp with time zone', true] },
  pub_native_agent_events: { id: ['uuid', true], owner_id: ['character varying(36)', true], task_id: ['uuid', true], turn_id: ['uuid', true], seq: ['bigint', true], event_key: ['text', true], kind: ['text', true], source: ['text', true], safe_payload: ['jsonb', true], payload_hash: ['text', true], created_at: ['timestamp with time zone', true] },
};
// Source: 20261110070000_native_agent_tasks.sql. These defaults are required
// by the reviewed INSERTs which deliberately omit the corresponding columns.
const NATIVE_DEFAULTS = {
  pub_native_agent_tasks: { status: "'idle'::text", revision: '1', next_seq: '0', archived: 'false', rating_comment: "''::text", created_at: 'now()', updated_at: 'now()' },
  pub_native_agent_turns: { state: "'prepared'::text", response_text: "''::text", revision: '1', created_at: 'now()', updated_at: 'now()' },
  pub_native_agent_events: { id: 'gen_random_uuid()', created_at: 'now()' },
};
const OWNER_TABLE_PRIVILEGES = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
const DEPENDENCY_FUNCTIONS = ['pub_assert_actor', 'pub2_assert_json_keys', 'pub3_no_credentials', 'pub_native_agent_event', 'mutate_native_agent_atomic', 'recover_llm_credit_reservations_atomic'];
const FUNCTION_CONTRACTS = {
  pub_assert_actor: { arguments: 'p_user_id text', result: 'void', definer: true, service: true },
  pub2_assert_json_keys: { arguments: 'p_value jsonb, p_allowed text[], p_required text[]', result: 'void', definer: false, service: false },
  pub3_no_credentials: { arguments: 'p_value jsonb, p_depth integer', result: 'boolean', definer: false, service: false },
  pub_native_agent_event: { arguments: 'p_owner text, p_task uuid, p_turn uuid, p_key text, p_kind text, p_source text, p_payload jsonb', result: 'jsonb', definer: false, service: false },
  mutate_native_agent_atomic: { arguments: 'p_owner text, p jsonb', result: 'jsonb', definer: true, service: true },
  recover_llm_credit_reservations_atomic: { arguments: 'p_user_id text', result: 'integer', definer: true, service: true },
};
// Exact reviewed local baseline definitions also bind DEFAULT arguments. In
// particular pub3_no_credentials(jsonb,integer) must retain p_depth DEFAULT 0.
const DEPENDENCY_DEFINITIONS = {
  pub_assert_actor: '17996593e131a1fadf68800a1e8fcf9c98227c3105af86ad9ff7e969ae1b4780',
  pub2_assert_json_keys: '1c4e4f3786e67db0edc868a45a308908bc6a58b3aa1b1a5d06368ac2b396ba57',
  pub3_no_credentials: '8a24b010dc9ffc04602294188e3abaf49d21be70701befd13c070f99c3500a10',
  pub_native_agent_event: '3afec0145f52f5241d5f426551c7238eaf669ac68a2460b6b009d2f3c7804abb',
  mutate_native_agent_atomic: 'f82ed110029d5c14058b580dac6681fc18c4a9a1ada8119221b9d6ed3d743b5b',
  recover_llm_credit_reservations_atomic: RECOVERY_HASH,
};
const DEPENDENCY_VERSIONS = ['20260901170000', '20260903074000', '20261109010000', '20261110010000', '20261110040000', '20261110070000'];
export const DEFERRED = Object.freeze(['20261101010000', '20261102060000', '20261103010000', '20261104010000', '20261105140000', '20261107180000']);
const SHA = /^[a-f0-9]{64}$/u;
const EXISTING_POLICY_EXCLUSIONS = ['20260822032000_aid_integration_bridge.sql', '20260915235500_autodl_h3_revenue_profit.sql', '20260923190000_workspace_model_explicit_assignments.sql', '20260926133000_video_upstream_direct_delivery.sql'];
export const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { localMigrationCode: code }); };
const moduleAt = relative => import(pathToFileURL(path.join(ROOT, relative)).href);
const LOADED_HELPERS = ['scripts/db-migration-release.mjs', 'scripts/lib/database-target-identity.mjs', 'scripts/lib/database-semantic-catalog.mjs'].map(file => ({ file, sha256: digest(fs.readFileSync(path.join(ROOT, file))) }));
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const LOADED_LIBRARIES = ['typescript', 'pg'].map(name => { const file = requireFromRoot.resolve(name); return { name, file, sha256: digest(fs.readFileSync(file)) }; });
const { readDatabaseTargetIdentity } = await moduleAt('scripts/lib/database-target-identity.mjs');
const { readSemanticRows, semanticSnapshotFromRows, compareSemanticSnapshots, DATABASE_SEMANTIC_SECTIONS } = await moduleAt('scripts/lib/database-semantic-catalog.mjs');
export { DATABASE_SEMANTIC_SECTIONS };

function bytes(file, io = fs, limit = 16 * 1024 * 1024) {
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('FILE_UNSAFE');
  const value = io.readFileSync(file); if (value.length !== stat.size || value.length > limit) fail('FILE_CHANGED'); return value;
}
export function parseArguments(argv) {
  const mode = argv[0] ?? 'plan'; if (!['plan', 'apply', 'reconcile'].includes(mode)) fail('MODE_FORBIDDEN');
  const allowed = new Set(['execute', 'plan', 'confirm-plan-sha256', 'confirm-manifest-sha256', 'confirm-tool-sha256', 'confirm-target-fingerprint', 'confirm-candidate-sha256', 'confirm-backup', 'confirm-backup-receipt-file-sha256', 'confirm-backup-archive-sha256', 'actor']);
  const options = { mode };
  for (const arg of argv.slice(1)) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/u.exec(arg);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(options, match[1]) || (match[1] === 'execute' ? match[2] !== undefined : !match[2])) fail('ARGUMENT_FORBIDDEN');
    options[match[1]] = match[1] === 'execute' ? true : match[2];
  }
  if (mode === 'plan' && Object.keys(options).length !== 1) fail('PLAN_ARGUMENT_FORBIDDEN');
  if (mode === 'reconcile' && Object.keys(options).some(key => !['mode', 'plan', 'confirm-plan-sha256', 'confirm-manifest-sha256', 'confirm-tool-sha256', 'confirm-target-fingerprint', 'confirm-candidate-sha256'].includes(key))) fail('RECONCILE_READ_ONLY_ARGUMENTS_REQUIRED');
  return options;
}
export function controlledConnection(runtime) {
  const source = runtime?.ownerConnection;
  if (runtime?.localOnly !== true || !source || source.host !== TARGET.host || Number(source.port) !== TARGET.port || source.database !== TARGET.database
    || source.user !== OWNER || typeof source.password !== 'string' || !source.password || /[\x00-\x1f]/u.test(source.password)) fail('FIXED_LOCAL_TARGET_REQUIRED');
  // Construct known fields explicitly. No URL, ambient PG setting, service, SSL or host override is accepted.
  return { ...TARGET, user: OWNER, password: source.password };
}
export function sourceManifest(io = fs, self = SELF) {
  const directory = path.join(ROOT, 'supabase/migrations');
  if (io.lstatSync(directory).isSymbolicLink()) fail('MIGRATION_DIRECTORY_SYMLINK');
  const policyBytes = bytes(path.join(ROOT, 'deploy/policies/release-policy.json'), io), policyExclusions = JSON.parse(policyBytes).database?.excludedForwardMigrations;
  if (stable(policyExclusions) !== stable(EXISTING_POLICY_EXCLUSIONS)) fail('EXISTING_POLICY_EXCLUSIONS_CHANGED');
  const rawInventory = io.readdirSync(directory).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/u.test(name)).sort().map(name => ({ name, version: name.slice(0, 14), sha256: digest(bytes(path.join(directory, name), io)) }));
  const migrations = rawInventory.filter(item => !EXISTING_POLICY_EXCLUSIONS.includes(item.name));
  if (rawInventory.length !== 223) fail('RAW_MIGRATION_INVENTORY_CHANGED');
  if (migrations.length !== 219 || new Set(migrations.map(item => item.version)).size !== migrations.length) fail('MIGRATION_INVENTORY_CHANGED');
  const candidate = migrations.find(item => item.name === CANDIDATE.name);
  if (!candidate || candidate.sha256 !== CANDIDATE.sha256) fail('CANDIDATE_SHA256_CHANGED');
  const helpers = ['scripts/db-migration-release.mjs', 'scripts/lib/database-target-identity.mjs', 'scripts/lib/database-semantic-catalog.mjs'].map(file => ({ file, sha256: digest(bytes(path.join(ROOT, file), io)) }));
  if (stable(helpers) !== stable(LOADED_HELPERS)) fail('LOADED_HELPER_SOURCE_CHANGED');
  if (helpers[0].sha256 !== RUNNER_SHA) fail('REVIEWED_BACKUP_HELPER_CHANGED');
  const libraries = LOADED_LIBRARIES.map(item => ({ ...item, sha256: digest(bytes(item.file, io)) }));
  if (stable(libraries) !== stable(LOADED_LIBRARIES)) fail('LOADED_RUNTIME_LIBRARY_CHANGED');
  const core = { kind: 'native-agent-single-local-manifest.v1', target: TARGET, candidate: CANDIDATE, toolSha256: digest(bytes(self, io)), helpers, libraries, migrations,
    existingPolicyExclusions: EXISTING_POLICY_EXCLUSIONS, policySha256: digest(policyBytes), rawSourceInventorySha256: digest(stable(rawInventory)), executeCount: 1, deferredVersions: DEFERRED };
  return { ...core, manifestSha256: digest(stable(core)) };
}

/** Reuse the exact canonical backup validator. Its CLI is never evaluated or invoked. */
export function verifyCanonicalBackup(options, fingerprint, io = fs) {
  const filename = path.join(ROOT, 'scripts/db-migration-release.mjs'), source = bytes(filename, io).toString('utf8');
  if (digest(Buffer.from(source)) !== RUNNER_SHA) fail('REVIEWED_BACKUP_HELPER_CHANGED');
  const ts = createRequire(path.join(ROOT, 'package.json'))('typescript');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const topLevelFunctions = ast.statements.filter(ts.isFunctionDeclaration);
  const declarations = new Map(topLevelFunctions.map(node => [node.name?.text, node.getText(ast)]));
  const names = ['sha256', 'verifiedFileBytes', 'verifiedArchiveDigest', 'confirmedDatabaseBackup', 'assertBackupFields', 'normalizedLoopbackHost', 'isIsoTimestamp', 'verifiedBackupEvidence'];
  if (ast.parseDiagnostics.length || names.some(name => topLevelFunctions.filter(node => node.name?.text === name).length !== 1)) fail('CANONICAL_BACKUP_HELPER_MISSING_OR_AMBIGUOUS');
  const context = { fs: io, path, crypto, Buffer, root: ROOT, Date, confirmedTargetFingerprint: fingerprint, confirmedBackup: options['confirm-backup'],
    confirmedBackupReceiptFileSha256: options['confirm-backup-receipt-file-sha256'], confirmedBackupArchiveSha256: options['confirm-backup-archive-sha256'], target: TARGET };
  vm.createContext(context); return vm.runInContext(names.map(name => declarations.get(name)).join('\n') + '\nconfirmedDatabaseBackup(target)', context, { timeout: 30000 });
}

export const SQL = Object.freeze({
  ledger: `/* native-agent-local:ledger */ SELECT version::text AS version,coalesce(name::text,'') AS name,coalesce(hash::text,'') AS hash,coalesce(applied_by::text,'') AS applied_by,applied_at::text AS applied_at FROM supabase_migrations.schema_migrations ORDER BY version`,
  functions: `/* native-agent-local:functions */ SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_userbyid(p.proowner) AS owner,
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS definition_hash,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_hash,
    p.prosecdef AS security_definer,p.proconfig,p.proacl::text AS raw_acl,pg_get_function_result(p.oid) AS return_type,l.lanname AS language,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type),'[]') FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) AS grants
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,
  owners: `/* native-agent-local:owners */ SELECT c.relname AS name,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type),'[]') FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a) AS grants
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m') ORDER BY c.relname`,
  principal: `/* native-agent-local:principal */ SELECT current_user::text AS current_user,session_user::text AS session_user`,
  recovery: `/* native-agent-local:recovery */ SELECT encode(sha256(convert_to(pg_get_functiondef('public.recover_llm_credit_reservations_atomic(text)'::regprocedure),'UTF8')),'hex') AS original_hash,
    encode(sha256(convert_to(replace(replace(pg_get_functiondef('public.recover_llm_credit_reservations_atomic(text)'::regprocedure),
      'h.record_id=a.record_id AND h.status=''held''','h.record_id=a.record_id AND h.status=''held'' AND NOT (h.price_snapshot ? ''native_agent'')'),
      'record_id=v_attempt.record_id AND status=''held''','record_id=v_attempt.record_id AND status=''held'' AND NOT (price_snapshot ? ''native_agent'')'),'UTF8')),'hex') AS patched_hash`,
  safety: `/* native-agent-local:safety */ SELECT public.native_agent_reservation_safety() AS value`,
});
export async function capture(client) {
  const target = await readDatabaseTargetIdentity(client, TARGET.host);
  if (target.databaseName !== TARGET.database || target.configuredHost !== TARGET.host || target.serverPort !== String(TARGET.port) || !['127.0.0.1/32', '127.0.0.1'].includes(target.serverAddress)) fail('LIVE_LOCAL_TARGET_MISMATCH');
  const principal = (await client.query(SQL.principal)).rows[0];
  if (principal?.current_user !== OWNER || principal?.session_user !== OWNER) fail('LOCAL_OWNER_IDENTITY_REQUIRED');
  const ledger = (await client.query(SQL.ledger)).rows;
  const functions = (await client.query(SQL.functions)).rows, owners = (await client.query(SQL.owners)).rows;
  const semanticRows = await readSemanticRows(client), semantic = semanticSnapshotFromRows(semanticRows);
  return { target, ledger, functions, owners, semanticRows, semantic, principal };
}
const requireOne = (items, name, code) => { const found = items.filter(item => item.name === name); if (found.length !== 1) fail(code); return found[0]; };
export function validateBefore(observed, manifest, recovery) {
  if (observed.ledger.length !== 212 || new Set(observed.ledger.map(item => item.version)).size !== observed.ledger.length) fail('BASE_LEDGER_CHANGED');
  for (const entry of observed.ledger) if (manifest.migrations.find(item => item.version === entry.version)?.sha256 !== entry.hash) fail('APPLIED_SOURCE_HASH_DRIFT');
  const pending = manifest.migrations.filter(item => !observed.ledger.some(applied => applied.version === item.version));
  if (pending.length !== 7 || stable(pending.map(item => item.version).sort()) !== stable([...DEFERRED, CANDIDATE.version].sort())) fail('PENDING_SCOPE_CHANGED');
  if (DEPENDENCY_VERSIONS.some(version => !observed.ledger.some(item => item.version === version))) fail('DEPENDENCY_LEDGER_MISSING');
  for (const name of DEPENDENCY_TABLES) {
    const table = requireOne(observed.owners, name, 'DEPENDENCY_TABLE_MISSING');
    if (table.owner !== OWNER || !['r', 'p'].includes(table.relkind)) fail('DEPENDENCY_TABLE_OWNER_OR_KIND_INVALID');
    if (!observed.semanticRows.columns.some(item => item.relation_name === name) || !observed.semanticRows.constraints.some(item => item.relation_name === name && item.contype === 'p')) fail('DEPENDENCY_TABLE_SHAPE_MISSING');
    for (const [column, [type, notNull]] of Object.entries(REQUIRED_COLUMNS[name])) {
      const matches = observed.semanticRows.columns.filter(item => item.relation_name === name && item.column_name === column);
      if (matches.length !== 1) fail('DEPENDENCY_COLUMN_MISSING_OR_AMBIGUOUS');
      if (matches[0].data_type !== type || matches[0].attnotnull !== notNull) fail('DEPENDENCY_COLUMN_TYPE_OR_NULLABILITY_INVALID');
    }
    if (Object.hasOwn(NATIVE_DEFAULTS, name)) {
      for (const [column, expression] of Object.entries(NATIVE_DEFAULTS[name])) {
        const field = observed.semanticRows.columns.find(item => item.relation_name === name && item.column_name === column);
        if (digest(String(field?.default_expression ?? '')) !== digest(expression)) fail('NATIVE_REQUIRED_DEFAULT_CHANGED');
      }
      const expected = [...OWNER_TABLE_PRIVILEGES.map(privilege => ({ grantee: OWNER, privilege, grantable: false })), { grantee: 'service_role', privilege: 'SELECT', grantable: false }];
      if (table.rls !== true || !Array.isArray(table.grants) || table.grants.length !== expected.length || expected.some(grant => table.grants.filter(item => item.grantee === grant.grantee && item.privilege === grant.privilege && item.grantable === false).length !== 1)) fail('NATIVE_DEPENDENCY_RLS_ACL_CHANGED');
    }
  }
  if (!observed.semanticRows.constraints.some(item => item.relation_name === 'pub_native_agent_turns' && item.contype === 'u' && item.definition.replace(/\s+/gu, '') === 'UNIQUE(owner_id,task_id,id)')) fail('OWNED_TURN_COMPOSITE_CONSTRAINT_MISSING');
  for (const name of DEPENDENCY_FUNCTIONS) {
    const fn = requireOne(observed.functions, name, 'DEPENDENCY_FUNCTION_MISSING_OR_OVERLOADED'), expected = FUNCTION_CONTRACTS[name];
    if (fn.owner !== OWNER || !SHA.test(fn.definition_hash) || !SHA.test(fn.body_hash)) fail('DEPENDENCY_FUNCTION_IDENTITY_INVALID');
    if (fn.definition_hash !== DEPENDENCY_DEFINITIONS[name]) fail('DEPENDENCY_FUNCTION_REVIEWED_DEFINITION_CHANGED');
    if (fn.arguments !== expected.arguments || fn.return_type !== expected.result || fn.language !== 'plpgsql') fail('DEPENDENCY_FUNCTION_SIGNATURE_INVALID');
    if (fn.security_definer !== expected.definer || !Array.isArray(fn.proconfig) || fn.proconfig.length !== 1 || fn.proconfig[0].replace(/\s+/gu, '') !== 'search_path=public,pg_temp') fail('DEPENDENCY_FUNCTION_SECURITY_CONTRACT_INVALID');
    const expectedGrantees = expected.service ? [OWNER, 'service_role'] : [OWNER];
    if (!Array.isArray(fn.grants) || fn.grants.length !== expectedGrantees.length || expectedGrantees.some(grantee => fn.grants.filter(grant => grant.grantee === grantee && grant.privilege === 'EXECUTE' && grant.grantable === false).length !== 1)) fail('DEPENDENCY_FUNCTION_ACL_CONTRACT_INVALID');
  }
  if (NEW_TABLES.some(name => observed.owners.some(item => item.name === name)) || NEW_FUNCTIONS.some(name => observed.functions.some(item => item.name === name))) fail('CANDIDATE_OBJECT_ALREADY_PRESENT');
  const baseline = requireOne(observed.functions, 'recover_llm_credit_reservations_atomic', 'RECOVERY_MISSING');
  if (baseline.definition_hash !== RECOVERY_HASH || recovery.original_hash !== RECOVERY_HASH || !SHA.test(recovery.patched_hash) || recovery.patched_hash === RECOVERY_HASH) fail('RECOVERY_BASELINE_CHANGED');
  if (baseline.grants.some(item => item.grantee !== OWNER && (item.grantee !== 'service_role' || item.privilege !== 'EXECUTE' || item.grantable)) || !baseline.grants.some(item => item.grantee === 'service_role' && item.privilege === 'EXECUTE')) fail('RECOVERY_ACL_UNSAFE');
  const core = { target: observed.target, ledgerSha256: digest(stable(observed.ledger)), semanticSha256: observed.semantic.sha256,
    functionsSha256: digest(stable(observed.functions)), ownersSha256: digest(stable(observed.owners)), recovery, manifestSha256: manifest.manifestSha256 };
  const dependencyTables = DEPENDENCY_TABLES.map(name => ({ ...requireOne(observed.owners, name, 'DEPENDENCY_TABLE_MISSING'),
    columns: observed.semanticRows.columns.filter(item => item.relation_name === name).map(item => ({ name: item.column_name, type: item.data_type, notNull: item.attnotnull, defaultSha256: digest(String(item.default_expression ?? '')) })),
    constraints: observed.semanticRows.constraints.filter(item => item.relation_name === name).map(item => ({ name: item.constraint_name, type: item.contype, validated: item.convalidated, definitionSha256: digest(item.definition) })) }));
  return { ...core, preconditionsSha256: digest(stable(core)), pending, dependencyTables, dependencies: DEPENDENCY_FUNCTIONS.map(name => requireOne(observed.functions, name, 'DEPENDENCY_FUNCTION_MISSING_OR_OVERLOADED')) };
}
export function reviewedSql(io = fs) {
  const original = bytes(path.join(ROOT, 'supabase/migrations', CANDIDATE.name), io);
  if (digest(original) !== CANDIDATE.sha256) fail('CANDIDATE_SHA256_CHANGED');
  const text = original.toString('utf8');
  if (!/^(?:--[^\n]*\r?\n)*BEGIN;\r?\n/u.test(text) || !/\r?\nCOMMIT;\s*$/u.test(text)) fail('REVIEWED_OUTER_TRANSACTION_CHANGED');
  // Safe only for the single pinned, human-reviewed byte sequence above.
  return text.replace(/^((?:--[^\n]*\r?\n)*)BEGIN;\r?\n/u, '$1').replace(/\r?\nCOMMIT;\s*$/u, '\n');
}
export function validateAfter(before, after, manifest, recovery) {
  if (before.target.fingerprint !== after.target.fingerprint) fail('POST_TARGET_CHANGED');
  const expectedLedger = after.ledger.filter(item => item.version !== CANDIDATE.version), candidate = after.ledger.filter(item => item.version === CANDIDATE.version);
  if (stable(expectedLedger) !== stable(before.ledger) || candidate.length !== 1 || candidate[0].hash !== CANDIDATE.sha256 || candidate[0].name !== CANDIDATE.slug || after.ledger.length !== 213) fail('POST_LEDGER_SCOPE_CHANGED');
  const pending = manifest.migrations.filter(item => !after.ledger.some(applied => applied.version === item.version));
  if (stable(pending.map(item => item.version).sort()) !== stable([...DEFERRED].sort())) fail('DEFERRED_LEDGER_CHANGED');
  for (const name of NEW_TABLES) {
    const table = requireOne(after.owners, name, 'NEW_TABLE_MISSING');
    if (table.owner !== OWNER || table.rls !== true || table.grants.some(item => item.grantee !== OWNER && (item.grantee !== 'service_role' || item.privilege !== 'SELECT' || item.grantable)) || !table.grants.some(item => item.grantee === 'service_role' && item.privilege === 'SELECT')) fail('NEW_TABLE_RLS_OWNER_ACL_INVALID');
    if (!after.semanticRows.constraints.some(item => item.relation_name === name && item.contype === 'p') || after.semanticRows.policies.some(item => item.relation_name === name)) fail('NEW_TABLE_CONSTRAINT_OR_POLICY_INVALID');
  }
  for (const name of [...NEW_FUNCTIONS, 'mutate_native_agent_atomic']) {
    const fn = requireOne(after.functions, name, 'NEW_FUNCTION_MISSING');
    if (fn.owner !== OWNER || fn.grants.some(item => item.grantee !== OWNER && (item.grantee !== 'service_role' || item.privilege !== 'EXECUTE' || item.grantable))) fail('NEW_FUNCTION_OWNER_ACL_INVALID');
    const serviceAllowed = !['pub_native_sdk_canonical', 'mutate_native_agent_legacy_atomic'].includes(name);
    if (fn.grants.some(item => item.grantee === 'service_role') !== serviceAllowed) fail('NEW_FUNCTION_SERVICE_ACL_INVALID');
    if (serviceAllowed && (fn.security_definer !== true || !fn.proconfig?.includes('search_path=public, pg_temp') && !fn.proconfig?.includes('search_path=public,pg_temp'))) fail('NEW_FUNCTION_SECURITY_PATH_INVALID');
  }
  const oldAtomic = requireOne(before.functions, 'mutate_native_agent_atomic', 'ATOMIC_BASELINE_MISSING'), legacy = requireOne(after.functions, 'mutate_native_agent_legacy_atomic', 'LEGACY_MISSING');
  if (oldAtomic.body_hash !== legacy.body_hash) fail('LEGACY_BODY_CHANGED');
  const oldRecovery = requireOne(before.functions, 'recover_llm_credit_reservations_atomic', 'RECOVERY_MISSING'), newRecovery = requireOne(after.functions, 'recover_llm_credit_reservations_atomic', 'RECOVERY_MISSING');
  if (newRecovery.definition_hash !== recovery.patched_hash || oldRecovery.owner !== newRecovery.owner || oldRecovery.raw_acl !== newRecovery.raw_acl) fail('RECOVERY_POST_PATCH_IDENTITY_INVALID');
  const changed = compareSemanticSnapshots(before.semantic, after.semantic, { strictExtras: true }).differences;
  const allowedNames = new Set([...NEW_TABLES, ...NEW_FUNCTIONS, 'mutate_native_agent_atomic', 'recover_llm_credit_reservations_atomic']);
  if (changed.some(change => !change.key.split('|').some(part => allowedNames.has(part)))) fail('UNRELATED_CATALOG_CHANGED');
  if (before.owners.some(item => stable(item) !== stable(after.owners.find(current => current.name === item.name)))) fail('EXISTING_OWNER_ACL_CHANGED');
  for (const fn of before.functions) if (!['mutate_native_agent_atomic', 'recover_llm_credit_reservations_atomic'].includes(fn.name) && stable(fn) !== stable(after.functions.find(item => item.name === fn.name && item.arguments === fn.arguments))) fail('UNRELATED_FUNCTION_CHANGED');
  return { executeCount: 1, ledgerInsertedCount: 1, deferredPendingCount: 6, catalogSha256: after.semantic.sha256, catalogChangedObjects: changed, recoveryFingerprint: newRecovery.definition_hash };
}

async function connect(readOnly, dependencies) {
  if (dependencies.connect) return dependencies.connect(readOnly);
  if (Object.keys(process.env).some(key => /^PG/iu.test(key))) fail('AMBIENT_PG_ENVIRONMENT_FORBIDDEN');
  const runtime = JSON.parse(bytes(RUNTIME).toString('utf8').replace(/^\uFEFF/u, ''));
  const configuration = controlledConnection(runtime), { default: pg } = await import('pg');
  const client = new pg.Client({ ...configuration, ssl: false, application_name: 'native-agent-fixed-local-single-migration', connectionTimeoutMillis: 10000, query_timeout: 120000, statement_timeout: 120000,
    options: `-c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c lock_timeout=10000` });
  await client.connect(); return client;
}
export async function plan(dependencies = {}) {
  const io = dependencies.fs ?? fs, manifest = sourceManifest(io), client = await connect(true, dependencies); let open = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); open = true;
    const observed = await capture(client), recovery = (await client.query(SQL.recovery)).rows[0], facts = validateBefore(observed, manifest, recovery);
    const beforeSnapshot = safeSnapshot(observed);
    return { kind: 'native-agent-local-single-plan.v1', createdAt: new Date().toISOString(), manifest, facts, beforeSnapshot, beforeSnapshotSha256: digest(stable(beforeSnapshot)), migrationPlanReadyForReview: true, businessReady: false,
      executeCount: 1, deferredPendingCount: 6, deferredPending: facts.pending.filter(item => item.version !== CANDIDATE.version).map(item => ({ ...item, excludedFromThisExecution: true, disposition: 'remain-pending-no-adopt-no-policy-exclusion' })),
      databaseWrites: 0, migrationApplied: false, externalCalls: 0, requiredFinalStep: 'Independent review of exact plan/file/tool/target/backup hashes, then explicit apply. This is not business readiness.' };
  } finally { if (open) await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}
/** Hash/identity metadata only. No pg_proc source or raw SQL is persisted. */
export function safeSnapshot(observed) {
  return { target: observed.target,
    ledger: observed.ledger.map(item => ({ version: item.version, name: item.name, hash: item.hash, applied_by: item.applied_by, applied_at: item.applied_at })),
    functions: observed.functions.map(fn => ({ name: fn.name, arguments: fn.arguments, owner: fn.owner, definition_hash: fn.definition_hash, body_hash: fn.body_hash, security_definer: fn.security_definer,
      proconfig: fn.proconfig, raw_acl: fn.raw_acl, return_type: fn.return_type, language: fn.language, grants: fn.grants })),
    owners: observed.owners.map(item => ({ name: item.name, relkind: item.relkind, owner: item.owner, rls: item.rls, grants: item.grants })), semantic: observed.semantic };
}
function validateReviewedPlan(options, reviewed, planBytes, manifest) {
  if (options['confirm-plan-sha256'] !== digest(planBytes) || reviewed.kind !== 'native-agent-local-single-plan.v1' || reviewed.migrationApplied !== false || reviewed.databaseWrites !== 0 || reviewed.businessReady !== false) fail('EXACT_REVIEWED_PLAN_REQUIRED');
  if (stable(reviewed.manifest) !== stable(manifest) || options['confirm-manifest-sha256'] !== manifest.manifestSha256 || options['confirm-tool-sha256'] !== manifest.toolSha256 || options['confirm-candidate-sha256'] !== CANDIDATE.sha256) fail('MANIFEST_TOOL_CANDIDATE_CONFIRMATION_REQUIRED');
  if (!SHA.test(options['confirm-target-fingerprint'] ?? '') || options['confirm-target-fingerprint'] !== reviewed.facts.target.fingerprint) fail('TARGET_FINGERPRINT_CONFIRMATION_REQUIRED');
  const before = reviewed.beforeSnapshot, facts = reviewed.facts;
  if (!before || digest(stable(before)) !== reviewed.beforeSnapshotSha256 || stable(before.target) !== stable(facts.target) || digest(stable(before.ledger)) !== facts.ledgerSha256
    || digest(stable(before.functions)) !== facts.functionsSha256 || digest(stable(before.owners)) !== facts.ownersSha256 || before.semantic?.sha256 !== facts.semanticSha256) fail('REVIEWED_BEFORE_SNAPSHOT_INVALID');
  const core = { target: facts.target, ledgerSha256: facts.ledgerSha256, semanticSha256: facts.semanticSha256, functionsSha256: facts.functionsSha256, ownersSha256: facts.ownersSha256, recovery: facts.recovery, manifestSha256: manifest.manifestSha256 };
  if (digest(stable(core)) !== facts.preconditionsSha256 || !Number.isFinite(Date.parse(reviewed.createdAt)) || Date.parse(reviewed.createdAt) > Date.now()) fail('REVIEWED_PLAN_FACTS_INVALID');
}
export function validateConfirmations(options, reviewed, planBytes, manifest) {
  if (options.mode !== 'apply' || options.execute !== true) fail('EXPLICIT_SINGLE_APPLY_REQUIRED');
  validateReviewedPlan(options, reviewed, planBytes, manifest);
  if (Date.now() - Date.parse(reviewed.createdAt) > 3600000) fail('PLAN_EXPIRED');
  if (typeof options.actor !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/u.test(options.actor)) fail('ACTOR_REQUIRED');
}
function validateWalletSafety(security, recovery) {
  if (security?.policy !== 'native-agent-unknown-hold.v1' || security.databaseVerified !== true || security.preservesUnknownHolds !== true || security.preservesExpiredProviderHolds !== true || security.policyFingerprint !== recovery.patched_hash) fail('ACTUAL_WALLET_POLICY_UNVERIFIED');
}
/** Unknown COMMIT outcomes are inspected, never retried, refunded or cleaned up. */
export async function reconcile(options, dependencies = {}) {
  if (options.mode !== 'reconcile' || options.execute !== undefined) fail('RECONCILE_READ_ONLY_ARGUMENTS_REQUIRED');
  const io = dependencies.fs ?? fs, manifest = sourceManifest(io), planBytes = bytes(options.plan, io), reviewed = JSON.parse(planBytes);
  validateReviewedPlan(options, reviewed, planBytes, manifest);
  let client, open = false;
  const result = { kind: 'native-agent-local-single-status.v1', planSha256: digest(planBytes), manifestSha256: manifest.manifestSha256, targetFingerprint: reviewed.facts.target.fingerprint,
    candidate: CANDIDATE, databaseWrites: 0, externalCalls: 0, businessReady: false, fullInstalledSemanticVerified: false, automaticRetry: false, cleanup: false };
  try {
    client = await connect(true, dependencies); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); open = true;
    const observed = await capture(client), current = safeSnapshot(observed);
    if (digest(stable(current)) === reviewed.beforeSnapshotSha256) {
      const recovery = (await client.query(SQL.recovery)).rows[0], facts = validateBefore(observed, manifest, recovery);
      if (facts.preconditionsSha256 !== reviewed.facts.preconditionsSha256) fail('LIVE_PREREQUISITE_DRIFT');
      return { ...result, classification: 'not-applied', migrationApplied: false, deferredPendingCount: 6, action: 'Read-only determination only; no automatic apply or retry.' };
    }
    const checked = validateAfter(reviewed.beforeSnapshot, observed, manifest, reviewed.facts.recovery);
    validateWalletSafety((await client.query(SQL.safety)).rows[0]?.value, reviewed.facts.recovery);
    return { ...result, classification: 'installed-ledger-and-guards-verified', migrationApplied: null, candidateLedgerRecorded: true, candidateObjectsPresent: true, ...checked,
      limitation: 'Expected full post-migration semantics were not independently bound before the unknown COMMIT. This verifies installed ledger and listed security guards only.' };
  } catch (error) {
    return { ...result, classification: 'indeterminate', migrationApplied: null, code: error?.localMigrationCode ?? 'LOCAL_SINGLE_STATUS_UNCONFIRMED', action: 'Preserve the original evidence; no automatic retry, apply or cleanup.' };
  } finally { if (open) await client.query('ROLLBACK').catch(() => {}); if (client) await client.end().catch(() => {}); }
}
export async function apply(options, dependencies = {}) {
  const io = dependencies.fs ?? fs, manifest = sourceManifest(io), planBytes = bytes(options.plan, io), reviewed = JSON.parse(planBytes);
  validateConfirmations(options, reviewed, planBytes, manifest);
  verifyCanonicalBackup(options, reviewed.facts.target.fingerprint, io);
  const client = await connect(false, dependencies); let transactionOpen = false, commitAttempted = false, commitConfirmed = false, stage = 'begin';
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_ID]);
    await client.query('LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE'); stage = 'revalidate';
    const before = await capture(client), recovery = (await client.query(SQL.recovery)).rows[0], facts = validateBefore(before, manifest, recovery);
    if (facts.preconditionsSha256 !== reviewed.facts.preconditionsSha256 || before.target.fingerprint !== options['confirm-target-fingerprint']) fail('LIVE_PREREQUISITE_DRIFT');
    if (sourceManifest(io).manifestSha256 !== manifest.manifestSha256) fail('SOURCE_MANIFEST_CHANGED');
    verifyCanonicalBackup(options, before.target.fingerprint, io);
    stage = 'single-migration'; await client.query(reviewedSql(io));
    stage = 'same-transaction-ledger';
    const inserted = await client.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(version) DO NOTHING RETURNING version`,
      [CANDIDATE.version, CANDIDATE.slug, [CANDIDATE.name], CANDIDATE.sha256, options.actor + ':native-agent-local-single']);
    if (inserted.rowCount !== 1) fail('CANDIDATE_LEDGER_CONFLICT');
    stage = 'transaction-postcheck'; const after = await capture(client), checked = validateAfter(before, after, manifest, recovery), security = (await client.query(SQL.safety)).rows[0]?.value;
    validateWalletSafety(security, recovery);
    stage = 'commit'; commitAttempted = true; await client.query('COMMIT'); transactionOpen = false; commitConfirmed = true;
    stage = 'committed-readback'; const persisted = await capture(client); validateAfter(before, persisted, manifest, recovery);
    if (persisted.semantic.sha256 !== after.semantic.sha256) fail('COMMITTED_CATALOG_READBACK_CHANGED');
    const persistedSafety = (await client.query(SQL.safety)).rows[0]?.value;
    if (stable(persistedSafety) !== stable(security)) fail('COMMITTED_WALLET_POLICY_READBACK_CHANGED');
    return { kind: 'native-agent-local-single-apply.v1', commitConfirmed: true, migrationApplied: true, manifestSha256: manifest.manifestSha256, planSha256: digest(planBytes), targetFingerprint: before.target.fingerprint,
      ...checked, businessReady: false, externalCalls: 0, automaticRetry: false, cleanup: false };
  } catch (error) {
    let rollbackConfirmed = false;
    if (transactionOpen && !commitAttempted) { try { await client.query('ROLLBACK'); rollbackConfirmed = true; } catch {} }
    const code = typeof error?.localMigrationCode === 'string' ? error.localMigrationCode : 'LOCAL_SINGLE_OPERATION_UNCONFIRMED';
    throw Object.assign(new Error(code), { localMigrationCode: code, stage, commitState: commitConfirmed ? 'committed-readback-unconfirmed' : commitAttempted || !rollbackConfirmed && transactionOpen ? 'unknown-do-not-retry' : 'not-committed', automaticRetry: false });
  } finally { await client.end().catch(() => {}); }
}
export async function main(argv = process.argv.slice(2)) { const options = parseArguments(argv); return options.mode === 'plan' ? plan() : options.mode === 'reconcile' ? reconcile(options) : apply(options); }
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error?.localMigrationCode ?? 'LOCAL_SINGLE_OPERATION_UNCONFIRMED', stage: error?.stage ?? 'preflight', commitState: error?.commitState ?? 'not-started', automaticRetry: false, businessReady: false })); process.exitCode = 1; }
}
