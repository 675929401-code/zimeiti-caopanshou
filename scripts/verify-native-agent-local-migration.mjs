#!/usr/bin/env node
// Zero live DB/network/filesystem writes. Executes candidate tool functions with memory PG/backup ports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as tool from './native-agent-local-migration.mjs';

const status = JSON.parse(fs.readFileSync(path.join(tool.ROOT, '.codex-evidence/native-agent-first-repair-acb6ffc7/db-target-status.json'), 'utf8'));
// Prior read-only catalog is fixture DATA only. Its approval/hash is never used
// to authorize the new tool; every malformed variant below must fail anew.
const catalogFixture = JSON.parse(fs.readFileSync(path.join(tool.ROOT, '.codex-evidence/native-agent-first-repair-acb6ffc7/local-single-plan-candidate.json'), 'utf8')).facts;
const baseLedger = status.migrations.filter(item => item.applied).map(item => ({ version: item.version, name: item.name.replace(/^\d+_|\.sql$/gu, ''), hash: item.sha256, applied_by: 'offline-fixture', applied_at: '2026-11-10 00:00:00+00' }));
const baselineOwner = 'zimeiti_owner', patchedHash = 'd'.repeat(64);
const newTables = ['pub_native_agent_runtime_config', 'pub_native_agent_runtime_calls', 'pub_native_agent_runtime_sessions', 'pub_native_agent_wallet_policy'];
const newFunctions = ['pub_native_sdk_canonical', 'mutate_native_agent_runtime_config', 'mutate_native_agent_sdk', 'mutate_native_agent_legacy_atomic', 'native_agent_reservation_safety'];
const columns = Object.fromEntries(catalogFixture.dependencyTables.map(table => [table.name, table.columns.map(column => column.name)]));
const fnNames = ['pub_assert_actor', 'pub2_assert_json_keys', 'pub3_no_credentials', 'pub_native_agent_event', 'mutate_native_agent_atomic', 'recover_llm_credit_reservations_atomic'];
const defaultFixture = {
  pub_native_agent_tasks: { status: "'idle'::text", revision: '1', next_seq: '0', archived: 'false', rating_comment: "''::text", created_at: 'now()', updated_at: 'now()' },
  pub_native_agent_turns: { state: "'prepared'::text", response_text: "''::text", revision: '1', created_at: 'now()', updated_at: 'now()' },
  pub_native_agent_events: { id: 'gen_random_uuid()', created_at: 'now()' },
};
const grants = (service = 'EXECUTE') => [{ grantee: baselineOwner, privilege: service, grantable: false }, ...(service ? [{ grantee: 'service_role', privilege: service, grantable: false }] : [])];
const functionFact = name => {
  const previous = catalogFixture.dependencies.find(fn => fn.name === name);
  return previous ? { ...structuredClone(previous), language: 'plpgsql', return_type: ({ pub_assert_actor: 'void', pub2_assert_json_keys: 'void', pub3_no_credentials: 'boolean', recover_llm_credit_reservations_atomic: 'integer' })[name] ?? 'jsonb' }
    : { name, arguments: name + '_arguments', owner: baselineOwner, definition_hash: tool.digest(name), body_hash: tool.digest(name + ':body'), security_definer: true, proconfig: ['search_path=public, pg_temp'], raw_acl: '{owner=X/owner,service_role=X/owner}', grants: grants() };
};

function fixture() {
  const manifest = tool.sourceManifest();
  const state = { applied: false, committed: false, ledger: structuredClone(baseLedger), queries: [], connects: 0, sqlExecutions: 0, ledgerInserts: 0, commits: 0, rollbacks: 0,
    failLedger: false, unknownCommit: false, postAclUnsafe: false, safetyInvalid: false, changedTarget: false, changedDependency: false, missingColumn: false, existingNewTable: false, missingDependencyLedger: false };
  let transactionBaseline = null;
  const identity = { database_name: 'zimeiti_local', server_version: '150019', server_address: '127.0.0.1/32', server_port: '54322' };
  const functions = () => {
    const result = fnNames.map(functionFact);
    if (state.changedDependency) result[0].definition_hash = tool.digest('changed dependency');
    if (state.applied) {
      const atomic = result.find(item => item.name === 'mutate_native_agent_atomic'); atomic.body_hash = tool.digest('new wrapper'); atomic.definition_hash = tool.digest('new wrapper definition');
      const recovery = result.find(item => item.name === 'recover_llm_credit_reservations_atomic'); recovery.definition_hash = patchedHash; recovery.body_hash = tool.digest('new recovery');
      for (const name of newFunctions) {
        const fn = functionFact(name);
        if (name === 'mutate_native_agent_legacy_atomic') fn.body_hash = functionFact('mutate_native_agent_atomic').body_hash;
        if (['pub_native_sdk_canonical', 'mutate_native_agent_legacy_atomic'].includes(name)) fn.grants = fn.grants.filter(item => item.grantee === baselineOwner);
        result.push(fn);
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  };
  const owners = () => [...Object.keys(columns), ...(state.applied ? newTables : state.existingNewTable ? [newTables[0]] : [])].map(name => ({ name, relkind: 'r', owner: baselineOwner, rls: true,
    grants: [...structuredClone(catalogFixture.dependencyTables.find(table => table.name === name)?.grants ?? grants('SELECT')), ...(state.applied && state.postAclUnsafe && newTables.includes(name) ? [{ grantee: 'PUBLIC', privilege: 'SELECT', grantable: false }] : [])] })).sort((a, b) => a.name.localeCompare(b.name));
  function semanticRows() {
    const result = Object.fromEntries(tool.DATABASE_SEMANTIC_SECTIONS.map(section => [section.name, []]));
    for (const item of owners()) {
      result.tables.push({ schema_name: 'public', object_name: item.name, relkind: 'r', relpersistence: 'p', relrowsecurity: true, relforcerowsecurity: false, relreplident: 'd' });
      for (const column of columns[item.name] ?? ['singleton', 'id']) if (!(state.missingColumn && item.name === 'users' && column === 'role')) {
        const field = catalogFixture.dependencyTables.find(table => table.name === item.name)?.columns.find(field => field.name === column);
        result.columns.push({ schema_name: 'public', relation_name: item.name, column_name: column, data_type: field?.type ?? 'text', attnotnull: field?.notNull ?? true, attidentity: '', attgenerated: '', collation_name: '', default_expression: defaultFixture[item.name]?.[column] ?? '' });
      }
      result.constraints.push({ schema_name: 'public', relation_name: item.name, constraint_name: item.name + '_pkey', contype: 'p', convalidated: true, definition: 'PRIMARY KEY (id)' });
      for (const grant of item.grants) if (grant.grantee !== baselineOwner) result['table-privileges'].push({ schema_name: 'public', object_name: item.name, grantee: grant.grantee, privilege_type: grant.privilege, is_grantable: false });
    }
    result.constraints.push({ schema_name: 'public', relation_name: 'pub_native_agent_turns', constraint_name: 'owner_task_id_unique', contype: 'u', convalidated: true, definition: 'UNIQUE (owner_id, task_id, id)' });
    for (const item of functions()) {
      result.functions.push({ schema_name: 'public', function_name: item.name, identity_arguments: item.arguments, source: item.body_hash });
      for (const grant of item.grants) if (grant.grantee !== baselineOwner) result['function-privileges'].push({ schema_name: 'public', function_name: item.name, identity_arguments: item.arguments, grantee: grant.grantee, privilege_type: grant.privilege, is_grantable: false });
    }
    return result;
  }
  const ioFiles = new Map(), descriptors = new Map();
  const syntheticRoot = path.join(tool.ROOT, '.not-created-local-migration-fixture');
  const planPath = path.join(syntheticRoot, 'plan.json'), receiptPath = path.join(syntheticRoot, 'backup.json'), archivePath = path.join(syntheticRoot, 'archive.dump');
  const stat = file => ioFiles.has(file) ? { size: ioFiles.get(file).length, ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } : fs.lstatSync(file);
  const io = {
    lstatSync: stat, statSync: stat, readdirSync: file => fs.readdirSync(file), readFileSync: file => ioFiles.has(file) ? ioFiles.get(file) : fs.readFileSync(file),
    openSync(file) { assert.ok(ioFiles.has(file), 'archive reads must stay in memory'); const fd = descriptors.size + 1; descriptors.set(fd, { file, offset: 0 }); return fd; },
    fstatSync: fd => stat(descriptors.get(fd).file),
    readSync(fd, buffer, offset, count) { const handle = descriptors.get(fd), data = ioFiles.get(handle.file), size = Math.min(count, data.length - handle.offset); data.copy(buffer, offset, handle.offset, handle.offset + size); handle.offset += size; return size; },
    closeSync: fd => descriptors.delete(fd),
  };
  const client = {
    async query(text, values = []) {
      state.queries.push({ text, values });
      if (text.includes('current_database()')) return { rows: [{ ...identity, ...(state.changedTarget ? { database_name: 'other_database' } : {}) }] };
      if (text === tool.SQL.principal) return { rows: [{ current_user: baselineOwner, session_user: baselineOwner }] };
      if (text === tool.SQL.ledger) return { rows: structuredClone(state.ledger.filter(item => !state.missingDependencyLedger || item.version !== '20261110070000')) };
      if (text === tool.SQL.functions) return { rows: functions() };
      if (text === tool.SQL.owners) return { rows: owners() };
      if (text === tool.SQL.recovery) return { rows: [{ original_hash: tool.RECOVERY_HASH, patched_hash: patchedHash }] };
      if (text === tool.SQL.safety) return { rows: [{ value: { policy: 'native-agent-unknown-hold.v1', databaseVerified: !state.safetyInvalid, preservesUnknownHolds: true, preservesExpiredProviderHolds: true, policyFingerprint: patchedHash } }] };
      const section = tool.DATABASE_SEMANTIC_SECTIONS.find(item => item.sql === text); if (section) return { rows: semanticRows()[section.name] };
      if (text.startsWith('BEGIN')) { transactionBaseline = { applied: state.applied, ledger: structuredClone(state.ledger) }; return { rows: [] }; }
      if (text.startsWith('SELECT pg_advisory_xact_lock')) { assert.deepEqual(values, [tool.LOCK_ID]); return { rows: [] }; }
      if (text.startsWith('LOCK TABLE')) return { rows: [] };
      if (text === tool.reviewedSql(io)) { state.sqlExecutions++; state.applied = true; return { rows: [] }; }
      if (text.startsWith('INSERT INTO supabase_migrations')) {
        state.ledgerInserts++; assert.equal(values[0], tool.CANDIDATE.version); assert.equal(values[3], tool.CANDIDATE.sha256);
        if (state.failLedger) throw Error('SIMULATED private password must never appear in public receipt');
        state.ledger.push({ version: values[0], name: values[1], hash: values[3], applied_by: values[4], applied_at: '2026-11-10 01:00:00+00' });
        return { rowCount: 1, rows: [{ version: values[0] }] };
      }
      if (text === 'COMMIT') { state.commits++; state.committed = true; transactionBaseline = null; if (state.unknownCommit) throw Error('offline lost acknowledgement'); return { rows: [] }; }
      if (text === 'ROLLBACK') { state.rollbacks++; if (transactionBaseline) { state.applied = transactionBaseline.applied; state.ledger = structuredClone(transactionBaseline.ledger); } transactionBaseline = null; return { rows: [] }; }
      throw Error('UNEXPECTED_QUERY ' + text.slice(0, 100));
    }, async end() {},
  };
  const dependencies = { fs: io, async connect() { state.connects++; return client; } };
  const options = { mode: 'apply', execute: true, actor: 'offline-review', plan: planPath, 'confirm-candidate-sha256': tool.CANDIDATE.sha256,
    'confirm-tool-sha256': manifest.toolSha256, 'confirm-manifest-sha256': manifest.manifestSha256, 'confirm-backup': receiptPath };
  async function prepare() {
    const reviewed = await tool.plan(dependencies), planBytes = Buffer.from(JSON.stringify(reviewed, null, 2) + '\n'); ioFiles.set(planPath, planBytes);
    options['confirm-plan-sha256'] = tool.digest(planBytes); options['confirm-target-fingerprint'] = reviewed.facts.target.fingerprint;
    const archive = Buffer.from('PGDMP in-memory fixture; not a real backup'), listing = Buffer.from('1; 0 0 SCHEMA - public\n');
    const timestamp = new Date(Date.now() - 10000).toISOString();
    const restore = { kind: 'database-isolated-restore-report.v1', archiveSha256: tool.digest(archive), sourceTargetFingerprint: options['confirm-target-fingerprint'], exitCode: 0, targetIsolated: true,
      target: { host: '127.0.0.1', port: 54322, database: 'zimeiti_restore_fixture' }, checks: { schema: true, data: true }, completedAt: timestamp };
    const restoreBytes = Buffer.from(JSON.stringify(restore));
    const receipt = { kind: 'pre-migration-database-backup-receipt.v1', schemaVersion: 1, targetClass: 'local-loopback-only', targetHost: '127.0.0.1', targetPort: 54322, database: 'zimeiti_local', targetFingerprint: options['confirm-target-fingerprint'],
      createdAt: timestamp, completedAt: timestamp, archivePath: 'archive.dump', archiveSha256: tool.digest(archive), archiveBytes: archive.length, format: 'postgres-custom',
      readability: { tool: 'pg_restore --list', exitCode: 0, entryCount: 1, evidencePath: 'toc.txt', evidenceSha256: tool.digest(listing) },
      restore: { status: 'verified', evidencePath: 'restore.json', evidenceSha256: tool.digest(restoreBytes) } };
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    ioFiles.set(receiptPath, receiptBytes); ioFiles.set(archivePath, archive); ioFiles.set(path.join(syntheticRoot, 'toc.txt'), listing); ioFiles.set(path.join(syntheticRoot, 'restore.json'), restoreBytes);
    options['confirm-backup-receipt-file-sha256'] = tool.digest(receiptBytes); options['confirm-backup-archive-sha256'] = tool.digest(archive);
    return { reviewed, receipt, receiptBytes, archive, restore, restoreBytes, planBytes };
  }
  return { state, manifest, io, ioFiles, options, dependencies, prepare, client, paths: { syntheticRoot, planPath, receiptPath, archivePath } };
}
const checks = [];
const check = async (name, work) => { await work(); checks.push(name); };
const reject = (work, expression) => assert.rejects(work, error => expression.test(error.localMigrationCode ?? error.message));
const reconcileOptions = options => Object.fromEntries(Object.entries({ ...options, mode: 'reconcile' }).filter(([key]) => ['mode', 'plan', 'confirm-plan-sha256', 'confirm-manifest-sha256', 'confirm-tool-sha256', 'confirm-target-fingerprint', 'confirm-candidate-sha256'].includes(key)));
let realNetwork = 0;
const oldFetch = globalThis.fetch; globalThis.fetch = async () => { realNetwork++; throw Error('REAL_NETWORK_FORBIDDEN'); };
try {
  assert.equal(process.version, 'v24.19.0');
  await check('fixed localhost tuple and explicit owner connection reject URL, host/port/database or role escape', () => {
    const ownerConnection = { ...tool.TARGET, user: baselineOwner, password: 'memory-only' };
    assert.equal(tool.controlledConnection({ localOnly: true, ownerConnection }).host, '127.0.0.1');
    for (const patch of [{ host: 'localhost' }, { host: 'remote.invalid' }, { port: 5432 }, { database: 'production' }, { user: 'postgres' }, { password: '' }]) assert.throws(() => tool.controlledConnection({ localOnly: true, ownerConnection: { ...ownerConnection, ...patch } }), /FIXED_LOCAL_TARGET_REQUIRED/u);
    assert.throws(() => tool.controlledConnection({ localOnly: false, ownerConnection }), /FIXED_LOCAL_TARGET_REQUIRED/u);
  });
  await check('unknown selectors/adoption/exclusion and implicit apply are not CLI capabilities', () => {
    for (const args of [['adopt'], ['plan', '--only=x'], ['apply', '--only=x'], ['apply', '--exclude=x'], ['apply', '--execute=true'], ['plan', '--execute']]) assert.throws(() => tool.parseArguments(args));
    const f = fixture(); assert.throws(() => tool.validateConfirmations({ ...f.options, execute: false }, {}, Buffer.from('{}'), f.manifest), /EXPLICIT_SINGLE_APPLY_REQUIRED/u);
  });
  await check('reviewed source binds exactly one candidate and original helper/library bytes', () => {
    const f = fixture(); assert.equal(f.manifest.candidate.sha256, tool.CANDIDATE.sha256); assert.equal(f.manifest.executeCount, 1); assert.equal(f.manifest.migrations.length, 219);
    assert.equal(f.manifest.libraries.length, 2); assert.equal(f.manifest.helpers.length, 3); const sql = tool.reviewedSql(); assert.ok(!sql.startsWith('BEGIN;')); assert.ok(!sql.trimEnd().endsWith('COMMIT;'));
    f.ioFiles.set(path.join(tool.ROOT, 'supabase/migrations', tool.CANDIDATE.name), Buffer.from('BEGIN; SELECT 1; COMMIT;'));
    assert.throws(() => tool.reviewedSql(f.io), /CANDIDATE_SHA256_CHANGED/u); assert.throws(() => tool.sourceManifest(f.io), /CANDIDATE_SHA256_CHANGED/u);
  });
  await check('actual plan uses read-only transaction and lists six deferred migrations without ledger writes', async () => {
    const f = fixture(), { reviewed } = await f.prepare(); assert.equal(reviewed.databaseWrites, 0); assert.equal(reviewed.businessReady, false); assert.equal(reviewed.executeCount, 1); assert.equal(reviewed.deferredPendingCount, 6);
    assert.deepEqual(reviewed.deferredPending.map(item => item.version).sort(), [...tool.DEFERRED].sort()); assert.ok(reviewed.deferredPending.every(item => item.excludedFromThisExecution));
    assert.equal(f.state.sqlExecutions + f.state.ledgerInserts + f.state.commits, 0); assert.equal(f.state.queries[0].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(f.state.queries.at(-1).text, 'ROLLBACK'); assert.ok(reviewed.facts.dependencies.every(item => item.owner === baselineOwner && /^[a-f0-9]{64}$/u.test(item.definition_hash)));
  });
  await check('confirmed plan/source/tool/candidate/target hashes are all required before opening write connection', async () => {
    for (const key of ['confirm-plan-sha256', 'confirm-manifest-sha256', 'confirm-tool-sha256', 'confirm-candidate-sha256', 'confirm-target-fingerprint']) {
      const f = fixture(); await f.prepare(); const connections = f.state.connects; f.options[key] = '0'.repeat(64);
      await assert.rejects(() => tool.apply(f.options, f.dependencies)); assert.equal(f.state.connects, connections); assert.equal(f.state.sqlExecutions, 0);
    }
  });
  await check('canonical backup receipt/archive/TOC/isolated-restore checks execute on original validator closure', async () => {
    const f = fixture(); await f.prepare(); const backup = tool.verifyCanonicalBackup(f.options, f.options['confirm-target-fingerprint'], f.io);
    assert.equal(backup.restoreDrillVerified, true); assert.equal(backup.readabilityVerified, true); assert.equal(backup.archiveSha256, f.options['confirm-backup-archive-sha256']);
    f.ioFiles.set(f.paths.archivePath, Buffer.from('PGDMP changed bytes')); await reject(() => tool.apply(f.options, f.dependencies), /BACKUP_ARCHIVE_SHA256/u); assert.equal(f.state.sqlExecutions, 0);
  });
  await check('missing or altered backup receipt/restore evidence fails before DDL or ledger', async () => {
    for (const kind of ['receipt', 'restore', 'toc']) {
      const f = fixture(); await f.prepare(); const file = kind === 'receipt' ? f.paths.receiptPath : path.join(f.paths.syntheticRoot, kind === 'restore' ? 'restore.json' : 'toc.txt'); f.ioFiles.set(file, Buffer.from('changed'));
      await assert.rejects(() => tool.apply(f.options, f.dependencies)); assert.equal(f.state.sqlExecutions + f.state.ledgerInserts, 0);
    }
  });
  await check('live target and prerequisite function/catalog drift cannot consume an approved old plan', async () => {
    for (const key of ['changedTarget', 'changedDependency', 'missingColumn', 'existingNewTable', 'missingDependencyLedger']) {
      const f = fixture(); await f.prepare(); f.state[key] = true; await assert.rejects(() => tool.apply(f.options, f.dependencies)); assert.equal(f.state.sqlExecutions + f.state.ledgerInserts, 0);
    }
  });
  await check('exact old recovery hash/ACL and owned-turn composite constraint are mandatory prerequisites', async () => {
    const f = fixture(), baseline = await tool.capture(f.client), recovery = { original_hash: tool.RECOVERY_HASH, patched_hash: patchedHash };
    const alteredHash = structuredClone(baseline); alteredHash.functions.find(item => item.name === 'recover_llm_credit_reservations_atomic').definition_hash = '0'.repeat(64);
    assert.throws(() => tool.validateBefore(alteredHash, f.manifest, recovery), /DEPENDENCY_FUNCTION_REVIEWED_DEFINITION_CHANGED/u);
    const alteredAcl = structuredClone(baseline); alteredAcl.functions.find(item => item.name === 'recover_llm_credit_reservations_atomic').grants.push({ grantee: 'authenticated', privilege: 'EXECUTE', grantable: false });
    assert.throws(() => tool.validateBefore(alteredAcl, f.manifest, recovery), /DEPENDENCY_FUNCTION_ACL_CONTRACT_INVALID/u);
    const missingComposite = structuredClone(baseline); missingComposite.semanticRows.constraints = missingComposite.semanticRows.constraints.filter(item => item.constraint_name !== 'owner_task_id_unique');
    assert.throws(() => tool.validateBefore(missingComposite, f.manifest, recovery), /OWNED_TURN_COMPOSITE_CONSTRAINT_MISSING/u);
  });
  async function rejectsInitialCatalog(mutate, expected) {
    const f = fixture(), originalQuery = f.client.query.bind(f.client);
    f.client.query = async (text, values) => { const response = await originalQuery(text, values); mutate(text, response.rows); return response; };
    await reject(() => tool.plan(f.dependencies), expected);
    assert.equal(f.state.sqlExecutions + f.state.ledgerInserts + f.state.commits, 0, 'bad initial state must never become an executable plan');
  }
  await check('initial missing finish-call attempt/hold receipt fields cannot be sealed into a reviewed plan', async () => {
    const required = { llm_request_attempts: ['client_request_id', 'lease_token', 'payload_fingerprint', 'response_body', 'response_fingerprint'], llm_credit_reservations: ['lease_token', 'actual_amount', 'receipt'] };
    const columnsSql = tool.DATABASE_SEMANTIC_SECTIONS.find(section => section.name === 'columns').sql;
    for (const [table, fields] of Object.entries(required)) for (const column of fields) await rejectsInitialCatalog((text, rows) => {
      if (text === columnsSql) { const index = rows.findIndex(item => item.relation_name === table && item.column_name === column); assert.ok(index >= 0); rows.splice(index, 1); }
    }, /DEPENDENCY_COLUMN_MISSING_OR_AMBIGUOUS/u);
  });
  await check('initial field types, monetary precision, nullability and table ownership fail closed', async () => {
    const columnsSql = tool.DATABASE_SEMANTIC_SECTIONS.find(section => section.name === 'columns').sql;
    for (const [table, column, type] of [['llm_request_attempts', 'response_body', 'jsonb'], ['llm_request_attempts', 'lease_token', 'integer'], ['llm_credit_reservations', 'actual_amount', 'numeric(10,2)'], ['llm_credit_reservations', 'receipt', 'text']]) await rejectsInitialCatalog((text, rows) => {
      if (text === columnsSql) rows.find(item => item.relation_name === table && item.column_name === column).data_type = type;
    }, /DEPENDENCY_COLUMN_TYPE_OR_NULLABILITY_INVALID/u);
    await rejectsInitialCatalog((text, rows) => { if (text === columnsSql) rows.find(item => item.relation_name === 'llm_request_attempts' && item.column_name === 'client_request_id').attnotnull = false; }, /DEPENDENCY_COLUMN_TYPE_OR_NULLABILITY_INVALID/u);
    for (const table of Object.keys(columns)) await rejectsInitialCatalog((text, rows) => { if (text === tool.SQL.owners) rows.find(item => item.name === table).owner = 'unexpected_owner'; }, /DEPENDENCY_TABLE_OWNER_OR_KIND_INVALID/u);
  });
  await check('initial function argument/result/language contracts reject wrong signatures or overloads', async () => {
    for (const patch of [{ arguments: 'p_user_id uuid' }, { return_type: 'jsonb' }, { language: 'sql' }]) await rejectsInitialCatalog((text, rows) => {
      if (text === tool.SQL.functions) Object.assign(rows.find(item => item.name === 'pub_assert_actor'), patch);
    }, /DEPENDENCY_FUNCTION_SIGNATURE_INVALID/u);
    await rejectsInitialCatalog((text, rows) => { if (text === tool.SQL.functions) rows.push({ ...rows.find(item => item.name === 'pub_assert_actor'), arguments: 'p_user_id uuid' }); }, /DEPENDENCY_FUNCTION_MISSING_OR_OVERLOADED/u);
  });
  await check('all six exact definition hashes are pinned, including DEFAULT p_depth not represented by identity args', async () => {
    for (const name of fnNames) await rejectsInitialCatalog((text, rows) => { if (text === tool.SQL.functions) rows.find(item => item.name === name).definition_hash = tool.digest('changed body or DEFAULT argument: ' + name); }, /DEPENDENCY_FUNCTION_REVIEWED_DEFINITION_CHANGED/u);
  });
  await check('initial definer/invoker, exact safe search_path and complete EXECUTE ACL must match source contracts', async () => {
    for (const [name, patch] of [['pub_assert_actor', { security_definer: false }], ['pub2_assert_json_keys', { security_definer: true }], ['pub_assert_actor', { proconfig: ['search_path=public'] }], ['pub_assert_actor', { proconfig: ['search_path=public, pg_temp', 'row_security=off'] }]]) await rejectsInitialCatalog((text, rows) => {
      if (text === tool.SQL.functions) Object.assign(rows.find(item => item.name === name), patch);
    }, /DEPENDENCY_FUNCTION_SECURITY_CONTRACT_INVALID/u);
    for (const [name, mutateAcl] of [
      ['pub_assert_actor', acl => acl.push({ grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false })],
      ['pub2_assert_json_keys', acl => acl.push({ grantee: 'service_role', privilege: 'EXECUTE', grantable: false })],
      ['mutate_native_agent_atomic', acl => { acl.find(item => item.grantee === 'service_role').grantable = true; }],
      ['pub3_no_credentials', acl => acl.splice(0, acl.length)],
    ]) await rejectsInitialCatalog((text, rows) => { if (text === tool.SQL.functions) mutateAcl(rows.find(item => item.name === name).grants); }, /DEPENDENCY_FUNCTION_ACL_CONTRACT_INVALID/u);
  });
  await check('all omitted native INSERT defaults match the fixed source contract and missing/changed defaults block initial plan', async () => {
    const columnsSql = tool.DATABASE_SEMANTIC_SECTIONS.find(section => section.name === 'columns').sql;
    for (const [table, defaults] of Object.entries(defaultFixture)) for (const [column, expression] of Object.entries(defaults)) {
      assert.equal(tool.digest(expression), catalogFixture.dependencyTables.find(item => item.name === table).columns.find(item => item.name === column).defaultSha256);
      for (const changed of ['', column === 'revision' ? '2' : 'changed_expression()']) await rejectsInitialCatalog((text, rows) => {
        if (text === columnsSql) rows.find(item => item.relation_name === table && item.column_name === column).default_expression = changed;
      }, /NATIVE_REQUIRED_DEFAULT_CHANGED/u);
    }
  });
  await check('existing native tasks/turns/events require RLS and exact owner plus service SELECT ACL before initial plan', async () => {
    for (const table of ['pub_native_agent_tasks', 'pub_native_agent_turns', 'pub_native_agent_events']) {
      await rejectsInitialCatalog((text, rows) => { if (text === tool.SQL.owners) rows.find(item => item.name === table).rls = false; }, /NATIVE_DEPENDENCY_RLS_ACL_CHANGED/u);
      for (const mutateAcl of [
        acl => acl.push({ grantee: 'PUBLIC', privilege: 'SELECT', grantable: false }),
        acl => acl.push({ grantee: 'anon', privilege: 'SELECT', grantable: false }),
        acl => acl.push({ grantee: 'authenticated', privilege: 'SELECT', grantable: false }),
        acl => acl.push({ grantee: 'service_role', privilege: 'INSERT', grantable: false }),
        acl => { acl.find(item => item.grantee === 'service_role').grantable = true; },
        acl => { acl.splice(acl.findIndex(item => item.grantee === baselineOwner && item.privilege === 'INSERT'), 1); },
      ]) await rejectsInitialCatalog((text, rows) => { if (text === tool.SQL.owners) mutateAcl(rows.find(item => item.name === table).grants); }, /NATIVE_DEPENDENCY_RLS_ACL_CHANGED/u);
    }
  });
  await check('single candidate DDL and sole ledger row are enclosed by one canonical advisory-locked transaction', async () => {
    const f = fixture(); await f.prepare(); const result = await tool.apply(f.options, f.dependencies);
    assert.equal(result.commitConfirmed, true); assert.equal(result.businessReady, false); assert.equal(result.executeCount, 1); assert.equal(result.ledgerInsertedCount, 1); assert.equal(result.deferredPendingCount, 6);
    assert.equal(f.state.sqlExecutions, 1); assert.equal(f.state.ledgerInserts, 1); assert.equal(f.state.commits, 1); assert.equal(f.state.ledger.length, 213);
    const queries = f.state.queries.map(item => item.text), begin = queries.indexOf('BEGIN ISOLATION LEVEL SERIALIZABLE'), ddl = queries.indexOf(tool.reviewedSql()), ledger = queries.findIndex(text => text.startsWith('INSERT INTO supabase_migrations'));
    assert.ok(begin < ddl && ddl < ledger && ledger < queries.indexOf('COMMIT')); assert.equal(queries.filter(text => text === 'SELECT pg_advisory_xact_lock($1::bigint)').length, 1);
    assert.deepEqual(f.state.ledger.filter(item => item.version !== tool.CANDIDATE.version), baseLedger); assert.equal(f.state.queries.filter(item => item.text === tool.SQL.safety).length, 2);
  });
  await check('ledger failure rolls back candidate rather than leaving committed-but-unrecorded SQL', async () => {
    const f = fixture(); await f.prepare(); f.state.failLedger = true; const rollbacks = f.state.rollbacks;
    await assert.rejects(() => tool.apply(f.options, f.dependencies), error => error.commitState === 'not-committed'); assert.equal(f.state.commits, 0); assert.equal(f.state.rollbacks, rollbacks + 1); assert.equal(f.state.applied, false); assert.deepEqual(f.state.ledger, baseLedger);
  });
  await check('actual post-DDL ACL and wallet safety failure prevent COMMIT', async () => {
    for (const key of ['postAclUnsafe', 'safetyInvalid']) {
      const f = fixture(); await f.prepare(); f.state[key] = true; await assert.rejects(() => tool.apply(f.options, f.dependencies)); assert.equal(f.state.commits, 0); assert.equal(f.state.applied, false); assert.deepEqual(f.state.ledger, baseLedger);
    }
  });
  await check('lost COMMIT acknowledgement returns unknown and never retries or issues cleanup rollback', async () => {
    const f = fixture(); await f.prepare(); f.state.unknownCommit = true; const rollbacks = f.state.rollbacks;
    await assert.rejects(() => tool.apply(f.options, f.dependencies), error => error.commitState === 'unknown-do-not-retry' && error.automaticRetry === false);
    assert.equal(f.state.sqlExecutions, 1); assert.equal(f.state.ledgerInserts, 1); assert.equal(f.state.commits, 1); assert.equal(f.state.rollbacks, rollbacks);
  });
  await check('plan retains only safe before catalog object hashes and metadata, without function SQL or prosrc', async () => {
    const f = fixture(), { reviewed } = await f.prepare();
    assert.deepEqual(Object.keys(reviewed.beforeSnapshot).sort(), ['target', 'ledger', 'functions', 'owners', 'semantic'].sort());
    const text = JSON.stringify(reviewed.beforeSnapshot); assert.equal(text.includes('CREATE FUNCTION'), false); assert.equal(text.includes('semanticRows'), false); assert.equal(text.includes('prosrc'), false);
    assert.equal(tool.digest(tool.stable(reviewed.beforeSnapshot)), reviewed.beforeSnapshotSha256);
    assert.ok(Object.values(reviewed.beforeSnapshot.semantic.sections).every(section => section.objects.every(item => Object.keys(item).sort().join(',') === 'key,sha256')));
  });
  await check('reconcile rejects execute flags or unapproved plan bytes before any connection', async () => {
    assert.throws(() => tool.parseArguments(['reconcile', '--execute']), /RECONCILE_READ_ONLY_ARGUMENTS_REQUIRED/u);
    assert.throws(() => tool.parseArguments(['reconcile', '--confirm-backup=anything']), /RECONCILE_READ_ONLY_ARGUMENTS_REQUIRED/u);
    const f = fixture(); await f.prepare(); const options = reconcileOptions(f.options), connects = f.state.connects; options['confirm-plan-sha256'] = '0'.repeat(64);
    await reject(() => tool.reconcile(options, f.dependencies), /EXACT_REVIEWED_PLAN_REQUIRED/u); assert.equal(f.state.connects, connects); assert.equal(f.state.sqlExecutions, 0);
  });
  await check('reconcile exact original state classifies not-applied entirely within READ ONLY transaction', async () => {
    const f = fixture(); await f.prepare(); const count = f.state.queries.length, result = await tool.reconcile(reconcileOptions(f.options), f.dependencies);
    assert.equal(result.classification, 'not-applied'); assert.equal(result.migrationApplied, false); assert.equal(result.fullInstalledSemanticVerified, false); assert.equal(result.businessReady, false);
    const queries = f.state.queries.slice(count).map(item => item.text); assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); assert.equal(queries.at(-1), 'ROLLBACK');
    assert.equal(f.state.sqlExecutions + f.state.ledgerInserts + f.state.commits, 0); assert.equal(result.automaticRetry, false);
  });
  await check('lost-COMMIT reconcile checks unique ledger/six pending/security guards without claiming full semantics', async () => {
    const f = fixture(); await f.prepare(); f.state.unknownCommit = true; await assert.rejects(() => tool.apply(f.options, f.dependencies));
    const writes = [f.state.sqlExecutions, f.state.ledgerInserts, f.state.commits], count = f.state.queries.length;
    const result = await tool.reconcile(reconcileOptions(f.options), f.dependencies);
    assert.equal(result.classification, 'installed-ledger-and-guards-verified'); assert.equal(result.candidateLedgerRecorded, true); assert.equal(result.fullInstalledSemanticVerified, false); assert.equal(result.migrationApplied, null); assert.equal(result.businessReady, false);
    assert.equal(result.deferredPendingCount, 6); assert.equal(result.automaticRetry, false); assert.equal(result.cleanup, false); assert.deepEqual([f.state.sqlExecutions, f.state.ledgerInserts, f.state.commits], writes);
    const queries = f.state.queries.slice(count).map(item => item.text); assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); assert.ok(queries.includes(tool.SQL.safety)); assert.equal(queries.at(-1), 'ROLLBACK');
    assert.equal(f.state.applied, true); assert.equal(f.state.ledger.length, 213);
  });
  await check('partial installation, unsafe ACL, wallet policy drift or target mismatch reconcile as indeterminate', async () => {
    for (const kind of ['missing-ledger', 'unsafe-acl', 'unsafe-policy', 'wrong-target']) {
      const f = fixture(); await f.prepare();
      if (kind === 'missing-ledger') f.state.applied = true;
      else { await tool.apply(f.options, f.dependencies); if (kind === 'unsafe-acl') f.state.postAclUnsafe = true; if (kind === 'unsafe-policy') f.state.safetyInvalid = true; if (kind === 'wrong-target') f.state.changedTarget = true; }
      const writes = [f.state.sqlExecutions, f.state.ledgerInserts, f.state.commits], result = await tool.reconcile(reconcileOptions(f.options), f.dependencies);
      assert.equal(result.classification, 'indeterminate'); assert.equal(result.migrationApplied, null); assert.equal(result.automaticRetry, false); assert.equal(result.fullInstalledSemanticVerified, false); assert.deepEqual([f.state.sqlExecutions, f.state.ledgerInserts, f.state.commits], writes);
    }
  });
  await check('reconcile requires internally consistent approved before snapshot and remains read-only after apply window expires', async () => {
    const f = fixture(), { reviewed } = await f.prepare(); const altered = structuredClone(reviewed); altered.beforeSnapshot.ledger[0].hash = 'f'.repeat(64);
    let planBytes = Buffer.from(JSON.stringify(altered)); f.ioFiles.set(f.paths.planPath, planBytes); const options = reconcileOptions(f.options); options['confirm-plan-sha256'] = tool.digest(planBytes);
    await reject(() => tool.reconcile(options, f.dependencies), /REVIEWED_BEFORE_SNAPSHOT_INVALID/u);
    reviewed.createdAt = new Date(Date.now() - 2 * 3600000).toISOString(); planBytes = Buffer.from(JSON.stringify(reviewed)); f.ioFiles.set(f.paths.planPath, planBytes); options['confirm-plan-sha256'] = tool.digest(planBytes);
    assert.equal((await tool.reconcile(options, f.dependencies)).classification, 'not-applied');
    await reject(() => tool.apply({ ...f.options, 'confirm-plan-sha256': options['confirm-plan-sha256'] }, f.dependencies), /PLAN_EXPIRED/u); assert.equal(f.state.sqlExecutions, 0);
  });
  assert.equal(realNetwork, 0);
  console.log(JSON.stringify({ ok: true, checkCount: checks.length, checks, realNetworkCalls: 0, realDatabaseCalls: 0, realDatabaseWrites: 0, realFilesystemWrites: 0,
    candidateFilesOnly: true, actualBackupValidatorReused: true, livePlanExecuted: false, migrationApplied: false, businessReady: false,
    scope: 'Actual candidate functions with in-memory PG/backup FS. Reads canonical SQL/helper bytes and prior sanitized status only. Does not establish live prerequisites or backup validity.' }, null, 2));
} finally { globalThis.fetch = oldFetch; }
