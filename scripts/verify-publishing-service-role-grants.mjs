#!/usr/bin/env node
/**
 * 发布运行时 service_role 授权就绪校验（只读）。
 *
 * 背景：发布链路大量通过 PostgREST 以 service_role 读写 public 下的表。仓库里
 * 并非每张表都有显式 GRANT；本地验收库靠 local runtime 的
 * ALTER DEFAULT PRIVILEGES 在建表时物化授权，所以本地永远是通的，测不出缺口。
 * 生产没有这层默认值，缺授权只会在部署后以
 * PUBLISH_API_SERVICE_UNAVAILABLE / permission denied 的形式暴露。
 *
 * 本脚本用仓库迁移作为清单来源，逐表核对 service_role 的实际权限，
 * 任何一张不满足即非零退出。只读，不写库、不改结构。
 *
 * 用法：
 *   DATABASE_URL=postgresql://... node scripts/verify-publishing-service-role-grants.mjs
 *   node scripts/verify-publishing-service-role-grants.mjs --json <out.json>
 * 未提供 DATABASE_URL 时回退到本地验收库 runtime.json 的 owner 连接。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(projectRoot, 'supabase', 'migrations');
const LOCAL_RUNTIME = 'F:\\总项目文件\\Skill存储系统\\运行数据\\自媒体操盘手\\local-data-20260902\\config\\runtime.json';
const REQUIRED = ['SELECT'];
const OBSERVED = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

function inventory() {
  const tables = new Map();
  if (!fs.existsSync(MIGRATIONS)) throw new Error('MIGRATIONS_DIRECTORY_MISSING');
  for (const file of fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    const text = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const match of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.("?)([a-z0-9_]+)\1/gi)) {
      const table = match[2];
      if (!/^(?:pub_|pub4_)/.test(table) || tables.has(table)) continue;
      tables.set(table, file);
    }
  }
  return tables;
}

function connectionString() {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return { connectionString: explicit, source: 'DATABASE_URL' };
  const runtime = JSON.parse(fs.readFileSync(LOCAL_RUNTIME, 'utf8').replace(/^\uFEFF/u, ''));
  return { connectionString: runtime.ownerDatabaseUrl, source: 'local-runtime.json' };
}

const args = process.argv.slice(2);
const jsonFlag = args.indexOf('--json');
const output = jsonFlag >= 0 ? args[jsonFlag + 1] : undefined;

const tables = inventory();
const { connectionString: url, source } = connectionString();
const target = (() => { try { const u = new URL(url); return `${u.hostname}:${u.port}${u.pathname}`; } catch { return 'invalid-database-url'; } })();

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, query_timeout: 20000 });
await client.connect();
let rows;
try {
  rows = (await client.query(`
    SELECT c.relname AS table_name,
           pg_get_userbyid(c.relowner) AS owner,
           has_table_privilege('service_role', c.oid, 'SELECT') AS can_select,
           has_table_privilege('service_role', c.oid, 'INSERT') AS can_insert,
           has_table_privilege('service_role', c.oid, 'UPDATE') AS can_update,
           has_table_privilege('service_role', c.oid, 'DELETE') AS can_delete
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
       AND c.relname = ANY($1::text[])
     ORDER BY c.relname`, [[...tables.keys()]])).rows;
} finally { await client.end(); }

const seen = new Map(rows.map((row) => [row.table_name, row]));
const findings = [...tables.entries()].map(([table, file]) => {
  const row = seen.get(table);
  if (!row) return { table, file, state: 'missing-table', missing: REQUIRED, missingWrites: OBSERVED.slice(1), owner: null };
  // Contract: service_role must at least READ every publishing table. That is
  // the exact condition whose absence produced PUBLISH_API_SERVICE_UNAVAILABLE
  // on pub_cash_admissions. Write privileges are reported, not enforced, because
  // several migrations intentionally grant SELECT only (writes go through
  // SECURITY DEFINER functions that run as the definer).
  const missing = REQUIRED.filter((action) => row[`can_${action.toLowerCase()}`] !== true);
  const missingWrites = OBSERVED.slice(1).filter((action) => row[`can_${action.toLowerCase()}`] !== true);
  return { table, file, state: missing.length ? 'insufficient' : 'ok', missing, missingWrites, owner: row.owner };
});
const failing = findings.filter((item) => item.state !== 'ok');
const report = {
  kind: 'publishing-service-role-grant-readiness.v1',
  generatedAt: new Date().toISOString(),
  connectionSource: source,
  target,
  tableCount: tables.size,
  ok: failing.length === 0,
  failingCount: failing.length,
  failing,
};

console.log(JSON.stringify({
  target: report.target,
  connectionSource: source,
  tablesChecked: report.tableCount,
  ok: report.ok,
  failingCount: report.failingCount,
  failing: report.failing.slice(0, 40),
}, null, 2));
if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);
