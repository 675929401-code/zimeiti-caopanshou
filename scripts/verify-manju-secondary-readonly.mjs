import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const root = 'F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本';
const runtimeFile = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const base = 'http://127.0.0.1:5000';
const evidence = path.join(root, '.codex-evidence/manju-secondary-20260902');
const outputName = 'readonly-inventory-after.json';
const report = { observedAt: new Date().toISOString(), mode: 'read-only-local', pages: [], api: [], tables: [], functions: [], migrationFiles: [], databaseWrites: 0, providerCalls: 0 };

async function collectFiles(directory, predicate) {
  const found = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) found.push(...await collectFiles(file, predicate));
    else if (predicate(file)) found.push(file);
  }
  return found;
}

function safeApiSummary(route, response, body) {
  const summary = { route, status: response.status, ok: response.ok && body.ok !== false };
  for (const name of ['code', 'state', 'storage_mode', 'storageMode', 'mode', 'migrationStatus', 'compatibilityStatus']) {
    if (typeof body[name] === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(body[name])) summary[name] = body[name];
  }
  for (const name of ['count', 'total', 'catalog_count', 'activeCount', 'package_count']) {
    if (typeof body[name] === 'number') summary[name] = body[name];
  }
  for (const name of ['drafts', 'history', 'releases', 'assets', 'packages', 'skills', 'projects', 'items', 'files', 'prompts']) {
    if (Array.isArray(body[name])) summary[`${name}Count`] = body[name].length;
  }
  if (body.active !== undefined) summary.activePresent = Boolean(body.active);
  if (body.package_store?.state) summary.packageStoreState = body.package_store.state;
  if (body.nativeSchemaReady !== undefined) summary.nativeSchemaReady = body.nativeSchemaReady === true;
  if (body.paidModelCallsEnabled !== undefined) summary.paidModelCallsEnabled = body.paidModelCallsEnabled === true;
  return summary;
}

async function main() {
  assert.equal(path.resolve(process.cwd()).toLowerCase(), path.resolve(root).toLowerCase());
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
  const files = await collectFiles(path.join(root, 'src/app/youcai'), (file) => file.endsWith('page.tsx'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const route = `/${path.relative(path.join(root, 'src/app'), path.dirname(file)).replaceAll('\\', '/')}`;
    report.pages.push({ route, dynamic: route.includes('['),
      imports: [...source.matchAll(/(?:from|import)\s*['"](@\/[^'"]+)['"]/gu)].map((match) => match[1]),
      redirects: [...source.matchAll(/redirect\(\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]),
    });
  }
  report.pages.sort((left, right) => left.route.localeCompare(right.route));
  report.migrationFiles = (await readdir(path.join(root, 'supabase/migrations'))).filter((name) => /manju|skill|short_drama/u.test(name));

  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  assert.equal(runtime.localOnly, true);
  assert.equal(runtime.databaseName, 'zimeiti_local');
  assert.equal(runtime.databasePort, 54322);
  assert.equal(runtime.ownerConnection?.host, '127.0.0.1');
  assert.equal(runtime.ownerConnection?.port, 54322);
  assert.equal(runtime.ownerConnection?.database, 'zimeiti_local');
  const client = new Client({ host: '127.0.0.1', port: 54322, database: 'zimeiti_local',
    user: runtime.ownerConnection.user, password: runtime.ownerConnection.password,
    connectionTimeoutMillis: 5000, application_name: 'manju-secondary-readonly',
  });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const tableRows = (await client.query(`SELECT c.relname AS name, c.relrowsecurity AS rls,
      has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
      has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select,
      has_table_privilege('service_role', c.oid, 'SELECT') AS service_select
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
        AND c.relname ~ '(manju|skill|short_drama|drama_project|canvas)'
      ORDER BY c.relname`)).rows;
    for (const row of tableRows) {
      assert.match(row.name, /^[a-z0-9_]+$/u);
      row.count = Number((await client.query(`SELECT count(*)::text AS count FROM public."${row.name}"`)).rows[0].count);
      row.columns = (await client.query(`SELECT column_name AS name, data_type AS type FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [row.name])).rows;
      report.tables.push(row);
    }
    report.functions = (await client.query(`SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname ~ '(manju|skill|short_drama)'
      ORDER BY p.proname`)).rows;
    await client.query('ROLLBACK');
  } finally { await client.end(); }

  report.sessionSource = 'normal-login-token-from-process-environment';
  const routes = [
    '/api/youcai/runtime-config', '/api/youcai/skills?limit=100', '/api/youcai/chat-models',
    '/api/admin/manju-workbench/status', '/api/admin/manju-workbench/prompts',
    '/api/admin/manju-workbench/assets', '/api/admin/manju-workbench/skills',
    '/api/admin/skill-packages?limit=80',
    ...['prompt', 'skill', 'content', 'media', 'feature_flags'].map((domain) => `/api/admin/manju-config?environment=production&domain=${domain}`),
    '/api/short-drama/health', '/api/drama/projects',
    '/api/media-history?limit=1&offset=0', '/api/storage/files?limit=1&offset=0',
  ];
  for (let index = 0; index < routes.length; index += 3) {
    report.api.push(...await Promise.all(routes.slice(index, index + 3).map(async (route) => {
      try {
        const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45_000) });
        const body = await response.json();
        return safeApiSummary(route, response, body);
      } catch (error) { return { route, failed: true, errorType: error?.name || 'UnknownError' }; }
    })));
  }
}

main().then(() => { report.completed = true; }).catch((error) => {
  report.completed = false;
  report.errorType = error?.name || 'UnknownError';
  report.errorCode = /^[A-Z0-9_]{1,30}$/u.test(error?.code || '') ? error.code : null;
  if (error?.message === 'NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED') report.errorCode = error.message;
  process.exitCode = 1;
}).finally(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, outputName), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ completed: report.completed, pages: report.pages.length,
    tableCounts: report.tables.map(({ name, count }) => ({ name, count })),
    functions: report.functions.map(({ name }) => name), api: report.api,
    errorType: report.errorType, errorCode: report.errorCode, databaseWrites: 0, providerCalls: 0 }, null, 2));
});
