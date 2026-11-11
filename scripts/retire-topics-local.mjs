import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

// Import through the controlled local environment launcher. This module never
// reads runtime/credential files and has no top-level database execution.
const TABLES = Object.freeze(['topic_analyses', 'topic_catalog_overrides', 'topic_handoffs', 'topic_workspace_items']);
const NAV_NAMES = Object.freeze(['行业选题', '选题工作台', '发布中心']);
const ROUTE_COLUMNS = Object.freeze(['route', 'path', 'href', 'url', 'target_route', 'route_path']);
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const relation = name => `public.${quote(name)}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireCondition(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/u.test(error.code) ? error.code : 'TOPICS_RETIREMENT_FAILED';
}
function parseArguments(args) {
  requireCondition(Array.isArray(args), 'INVALID_ARGUMENTS');
  let apply = false, expectedPlan;
  for (const argument of args) {
    if (argument === '--apply' && !apply) apply = true;
    else if (argument.startsWith('--expected-plan=') && expectedPlan === undefined) expectedPlan = argument.slice('--expected-plan='.length);
    else requireCondition(false, 'INVALID_ARGUMENTS');
  }
  requireCondition(apply ? /^[a-f0-9]{64}$/u.test(expectedPlan || '') : expectedPlan === undefined, 'EXPECTED_PLAN_REQUIRED');
  return { apply, expectedPlan };
}
function connectionOptions() {
  requireCondition(process.env.LOCAL_ACCEPTANCE_PREVIEW === 'true', 'LOCAL_ACCEPTANCE_REQUIRED');
  let url;
  try { url = new URL(process.env.DATABASE_URL || ''); } catch { requireCondition(false, 'INVALID_LOCAL_DATABASE_URL'); }
  requireCondition(['postgres:', 'postgresql:'].includes(url.protocol)
    && url.hostname === '127.0.0.1' && url.port === '54322' && url.pathname === '/zimeiti_local'
    && !url.search && !url.hash, 'LOCAL_DATABASE_BOUNDARY_REQUIRED');
  // Explicit fields prevent connection-string query parameters from overriding
  // the already checked host, database, port or transport.
  return { host: '127.0.0.1', port: 54322, database: 'zimeiti_local',
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: false, connectionTimeoutMillis: 5000, application_name: 'topics-retirement-local' };
}
async function identity(client) {
  const { rows: [row] } = await client.query(`select current_database() as database,
    host(inet_server_addr()) as address, inet_server_port() as port`);
  requireCondition(row?.database === 'zimeiti_local' && row?.address === '127.0.0.1' && row?.port === 54322, 'LOCAL_DATABASE_IDENTITY_MISMATCH');
  return row;
}
async function columns(client, table) {
  return (await client.query(`select column_name, data_type, is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table])).rows;
}
async function relations(client) {
  return (await client.query(`select c.relname as name, c.relkind as kind from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p') order by c.relname`)).rows;
}
async function dependencies(client, names) {
  const foreignKeys = (await client.query(`select con.conname as name,
    sn.nspname as source_schema, s.relname as source_table,
    tn.nspname as target_schema, t.relname as target_table,
    con.confdeltype as delete_action
    from pg_constraint con join pg_class s on s.oid = con.conrelid
    join pg_namespace sn on sn.oid = s.relnamespace
    join pg_class t on t.oid = con.confrelid join pg_namespace tn on tn.oid = t.relnamespace
    where con.contype = 'f' and ((sn.nspname = 'public' and s.relname = any($1::text[]))
      or (tn.nspname = 'public' and t.relname = any($1::text[])))
    order by sn.nspname, s.relname, con.conname`, [names])).rows;
  const triggers = (await client.query(`select n.nspname as schema, c.relname as table_name,
    t.tgname as name, pn.nspname as function_schema, p.proname as function_name
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
    where not t.tgisinternal and n.nspname = 'public' and c.relname = any($1::text[])
    order by c.relname, t.tgname`, [names])).rows;
  const views = (await client.query(`select distinct vn.nspname as schema, v.relname as name,
    rn.nspname as target_schema, r.relname as target_table
    from pg_depend d join pg_rewrite rw on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid
    join pg_class v on v.oid = rw.ev_class join pg_namespace vn on vn.oid = v.relnamespace
    join pg_class r on d.refclassid = 'pg_class'::regclass and d.refobjid = r.oid
    join pg_namespace rn on rn.oid = r.relnamespace
    where rn.nspname = 'public' and r.relname = any($1::text[]) and v.oid <> r.oid
    order by vn.nspname, v.relname, rn.nspname, r.relname`, [names])).rows;
  return { foreignKeys, triggers, views };
}
async function navigation(client, publicTables) {
  if (!publicTables.some(table => table.name === 'nav_items')) return { exists: false, columns: [], routeColumns: [], rows: [], idUnique: false };
  const shape = await columns(client, 'nav_items');
  const present = new Set(shape.map(column => column.column_name));
  const routeColumns = ROUTE_COLUMNS.filter(column => present.has(column));
  if (!present.has('id') || !present.has('name')) return { exists: true, columns: shape, routeColumns, rows: [], idUnique: false };
  const { rows: [unique] } = await client.query(`select exists(select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'id'
    where n.nspname = 'public' and c.relname = 'nav_items' and con.contype in ('p','u')
      and con.conkey = array[a.attnum]::smallint[]) as valid`);
  const selection = ['id', 'name', ...routeColumns].map(quote).join(', ');
  const routeMatch = routeColumns.map(column => `${quote(column)}::text = '/topics'`).join(' or ');
  const rows = (await client.query(`select ${selection} from public.nav_items where
    name::text = any($1::text[])${routeMatch ? ` or (${routeMatch})` : ''} order by id::text`, [NAV_NAMES])).rows;
  return { exists: true, columns: shape, routeColumns, rows, idUnique: unique.valid };
}
async function settingKeys(client, publicTables) {
  const result = [];
  for (const table of publicTables.filter(item => /setting|config/iu.test(item.name))) {
    const shape = await columns(client, table.name);
    for (const column of shape.filter(item => ['key', 'setting_key', 'config_key'].includes(item.column_name))) {
      const keys = (await client.query(`select distinct ${quote(column.column_name)}::text as key
        from ${relation(table.name)} where ${quote(column.column_name)}::text ~* '(topic|publish|publication)' order by key`)).rows;
      if (keys.length) result.push({ table: table.name, keyColumn: column.column_name, keys: keys.map(row => row.key) });
    }
  }
  return result;
}
async function collectPlan(client, scriptSha256) {
  const server = await identity(client);
  const publicTables = await relations(client);
  const matchingTables = publicTables.filter(table => /topic|publish|publication/iu.test(table.name));
  const retainedMatchingTables = matchingTables.filter(table => !TABLES.includes(table.name));
  // Shared model/configuration publication tables are inventory only. The
  // deletion allowlist never expands to them; new topic-owned tables need review.
  const blockers = retainedMatchingTables.filter(table => /^topic_/u.test(table.name)).map(table => `UNREVIEWED_TOPIC_TABLE:${table.name}`);
  const tables = [];
  for (const name of TABLES) {
    const table = publicTables.find(item => item.name === name);
    if (!table) { tables.push({ name, exists: false }); continue; }
    if (table.kind !== 'r') blockers.push(`NONSTANDARD_RELATION:${name}`);
    const shape = await columns(client, name);
    const { rows: [count] } = await client.query(`select count(*)::text as count from ${relation(name)}`);
    const entry = { name, exists: true, columns: shape, count: count.count };
    const fingerprintKey = name === 'topic_catalog_overrides' ? 'topic_id' : 'id';
    if (!shape.some(column => column.column_name === fingerprintKey)) blockers.push(`CONTENT_FINGERPRINT_KEY_MISSING:${name}`);
    else {
      // PostgreSQL returns only fixed-size irreversible row digests. Neither
      // the selected payload nor individual row digests enter output/evidence.
      const { rows: digests } = await client.query(`select md5(row_to_json(t)::text) as row_digest
        from ${relation(name)} t order by ${quote(fingerprintKey)}`);
      requireCondition(String(digests.length) === count.count, 'CONTENT_FINGERPRINT_COUNT_CHANGED');
      const contentHash = createHash('sha256');
      for (const digest of digests) {
        requireCondition(/^[a-f0-9]{32}$/u.test(digest.row_digest), 'CONTENT_FINGERPRINT_INVALID');
        contentHash.update(digest.row_digest).update('\n');
      }
      entry.contentFingerprint = { algorithm: 'sha256-of-ordered-row-md5-v1', orderBy: fingerprintKey, sha256: contentHash.digest('hex') };
    }
    if (name === 'topic_analyses') {
      const present = new Set(shape.map(column => column.column_name));
      if (!present.has('status') || !present.has('error_code')) blockers.push('ANALYSIS_STATE_COLUMNS_MISSING');
      else {
        entry.statusCounts = (await client.query(`select case when status in ('running','succeeded','failed')
          then status else 'unknown' end as status, count(*)::text as count from public.topic_analyses
          group by 1 order by 1`)).rows;
        const { rows: [unknown] } = await client.query(`select count(*)::text as count from public.topic_analyses
          where error_code ~* '(UNKNOWN|RECONCILIATION)'`);
        entry.unknownResultCount = unknown.count;
        if (entry.statusCounts.some(row => ['running', 'unknown'].includes(row.status) && row.count !== '0') || unknown.count !== '0') blockers.push('ANALYSES_RUNNING_OR_UNKNOWN');
      }
    }
    tables.push(entry);
  }
  const nav = await navigation(client, publicTables);
  if (nav.exists && (!nav.idUnique || !nav.columns.some(column => column.column_name === 'name'))) blockers.push('NAV_IDENTITY_COLUMNS_UNCONFIRMED');
  for (const row of nav.rows) {
    if (row.id === null || row.id === undefined) blockers.push('NAV_ID_MISSING');
    const routes = nav.routeColumns.map(column => row[column]).filter(value => value !== null && value !== '');
    // A matching display name must never authorize deleting a cover/other tool
    // row. Unknown routes are evidence for review, not additional scope.
    if (routes.some(value => value !== '/topics')) blockers.push(`NAV_ROUTE_IDENTITY_UNCONFIRMED:${row.id}`);
    if (!NAV_NAMES.includes(row.name) && !routes.includes('/topics')) blockers.push(`NAV_IDENTITY_UNCONFIRMED:${row.id}`);
  }
  const inspected = [...TABLES, ...(nav.rows.length ? ['nav_items'] : [])];
  const dependency = await dependencies(client, inspected);
  for (const fk of dependency.foreignKeys) {
    if (fk.target_schema === 'public' && TABLES.includes(fk.target_table)
      && (fk.source_schema !== 'public' || !TABLES.includes(fk.source_table))) blockers.push(`EXTERNAL_FOREIGN_KEY:${fk.name}`);
    if (nav.rows.length && fk.target_schema === 'public' && fk.target_table === 'nav_items') blockers.push(`NAV_REFERENCED_BY_FOREIGN_KEY:${fk.name}`);
  }
  if (dependency.triggers.length) blockers.push('NONINTERNAL_TRIGGERS_REQUIRE_REVIEW');
  if (dependency.views.length) blockers.push('DEPENDENT_VIEWS_REQUIRE_REVIEW');
  return { schema: 'topics-local-retirement-plan.v1', scriptSha256, server, matchingTables, retainedMatchingTables, tables, navigation: nav,
    dependencies: dependency, retainedSharedSettingKeys: await settingKeys(client, publicTables), blockers: [...new Set(blockers)].sort() };
}
async function writeEvidence(evidence, mode) {
  const directory = path.resolve('.codex-evidence/chunk-recovery-20261109');
  await mkdir(directory, { recursive: true });
  const filename = `topics-retirement-${mode}-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID()}.json`;
  const destination = path.join(directory, filename);
  await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return destination;
}

export async function main(args = []) {
  let client, transaction = false, commitAttempted = false, commitConfirmed = false, planHash;
  const receipt = { schema: 'topics-local-retirement-receipt.v1', startedAt: new Date().toISOString() };
  try {
    const options = parseArguments(args);
    receipt.mode = options.apply ? 'apply' : 'plan';
    const config = connectionOptions();
    const scriptSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
    client = new pg.Client(config);
    client.on('error', () => {});
    await client.connect();
    await client.query("set lock_timeout = '5s'");
    await client.query("set statement_timeout = '30s'");
    await client.query('set row_security = off');
    await identity(client);
    // Discover lock targets before BEGIN, so the SERIALIZABLE snapshot is not
    // established until after the target locks have actually been acquired.
    const lockTargets = options.apply
      ? (await relations(client)).filter(table => TABLES.includes(table.name) || table.name === 'nav_items') : [];
    await client.query(options.apply ? 'begin isolation level serializable' : 'begin isolation level repeatable read read only');
    transaction = true;
    if (options.apply) {
      // Freeze all destructive targets before recomputing counts and identity.
      if (lockTargets.length) await client.query(`lock table ${lockTargets.map(table => relation(table.name)).join(', ')} in access exclusive mode`);
    }
    const plan = await collectPlan(client, scriptSha256);
    planHash = hash(plan);
    Object.assign(receipt, { planHash, plan, expectedPlanHash: options.expectedPlan });
    if (!options.apply) {
      await client.query('rollback'); transaction = false;
      receipt.status = plan.blockers.length ? 'PLAN_BLOCKED' : 'PLAN_READY';
    } else {
      requireCondition(planHash === options.expectedPlan, 'PLAN_DRIFT_DETECTED');
      requireCondition(plan.blockers.length === 0, 'PLAN_HAS_BLOCKERS');
      requireCondition(plan.tables.filter(table => table.exists).every(table => lockTargets.some(target => target.name === table.name)), 'LOCK_TARGET_DRIFT_DETECTED');
      if (plan.navigation.exists) requireCondition(lockTargets.some(target => target.name === 'nav_items'), 'LOCK_TARGET_DRIFT_DETECTED');
      await writeEvidence({ ...receipt, status: 'APPLY_VALIDATED_BEFORE_WRITE' }, 'apply-validated');
      // Restrict is deliberate: an undiscovered dependency aborts the entire
      // transaction rather than deleting any shared object.
      await client.query(`drop table if exists ${TABLES.map(relation).join(', ')} restrict`);
      const deleted = [];
      for (const row of plan.navigation.rows) {
        const fields = ['id', 'name', ...plan.navigation.routeColumns];
        const predicate = fields.map((field, index) => `${quote(field)} is not distinct from $${index + 1}`).join(' and ');
        const result = await client.query(`delete from public.nav_items where ${predicate} returning ${fields.map(quote).join(', ')}`, fields.map(field => row[field]));
        requireCondition(result.rowCount === 1, 'NAV_DELETE_IDENTITY_CHANGED');
        deleted.push(...result.rows);
      }
      const afterTables = (await client.query(`select name, to_regclass('public.' || name)::text as relation
        from unnest($1::text[]) as name order by name`, [TABLES])).rows;
      requireCondition(afterTables.every(row => row.relation === null), 'TABLE_REMOVAL_READBACK_FAILED');
      const afterNav = await navigation(client, await relations(client));
      requireCondition(afterNav.rows.length === 0, 'NAV_REMOVAL_READBACK_FAILED');
      receipt.after = { tables: afterTables, navigation: afterNav, deletedNavigationRows: deleted };
      commitAttempted = true;
      await client.query('commit'); transaction = false; commitConfirmed = true;
      receipt.status = 'APPLIED';
      // Re-read from the committed database, not only the transaction snapshot.
      receipt.committedIdentity = await identity(client);
      receipt.committedTables = (await client.query(`select name, to_regclass('public.' || name)::text as relation
        from unnest($1::text[]) as name order by name`, [TABLES])).rows;
      receipt.committedNavigation = await navigation(client, await relations(client));
      requireCondition(receipt.committedTables.every(row => row.relation === null) && receipt.committedNavigation.rows.length === 0, 'COMMITTED_READBACK_FAILED');
    }
    receipt.completedAt = new Date().toISOString();
    Object.assign(receipt, { committed: commitConfirmed, commitAttempted });
    const evidencePath = await writeEvidence(receipt, receipt.mode);
    console.log(JSON.stringify({ status: receipt.status, planHash, blockers: plan.blockers, committed: commitConfirmed, evidencePath }, null, 2));
    return receipt;
  } catch (error) {
    const code = safeCode(error);
    const commitUnknown = commitAttempted && !commitConfirmed;
    let rollback = commitUnknown ? 'NOT_ATTEMPTED_COMMIT_UNKNOWN' : 'NOT_STARTED';
    if (transaction && client && !commitAttempted) {
      try { await client.query('rollback'); rollback = 'ROLLED_BACK'; }
      catch { rollback = 'ROLLBACK_UNCONFIRMED'; }
    }
    const committed = commitUnknown ? null : commitConfirmed;
    Object.assign(receipt, { status: commitUnknown ? 'COMMIT_OUTCOME_UNKNOWN' : commitConfirmed ? 'COMMITTED_VERIFICATION_FAILED' : 'FAILED',
      code, committed, commitAttempted, automaticWriteReplayAllowed: false, rollback, completedAt: new Date().toISOString() });
    let evidencePath;
    try { evidencePath = await writeEvidence(receipt, receipt.mode || 'rejected'); } catch { /* Never print raw filesystem/connection errors. */ }
    console.error(JSON.stringify({ status: receipt.status, code, committed, rollback, planHash, evidencePath }));
    // The controlled caller may print thrown errors: replace the original
    // object (including PostgreSQL detail/connection information) completely.
    throw Object.assign(new Error(code), { code });
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
