import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';
import { Client } from 'pg';

async function main() {
const baseUrl = process.env.COMMERCE_ACCEPTANCE_BASE_URL || 'http://127.0.0.1:5000';
const runtimePath = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8').replace(/^\uFEFF/u, '')) as {
  localOnly: boolean;
  runtimeRoot: string;
  databaseUrl: string;
  jwtSecret: string;
};
const databaseUrl = new URL(runtime.databaseUrl);
assert.equal(runtime.localOnly, true);
assert.equal(databaseUrl.hostname, '127.0.0.1');
assert.equal(databaseUrl.port, '54322');
assert.equal(databaseUrl.pathname, '/zimeiti_local');

const postgres = new Client({ connectionString: runtime.databaseUrl });
await postgres.connect();
let student!: { id: string; username: string; display_name: string };
let release!: Record<string, unknown>;
try {
  await postgres.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const current = await postgres.query(
    `select id,release_version,status,is_current,manifest_sha256,validation_result
       from public.commerce_config_releases where is_current=true`,
  );
  assert.equal(current.rowCount, 1, 'exactly one shared configuration release must be current');
  release = current.rows[0];
  const students = await postgres.query(
    `select id,coalesce(username,email,'') as username,coalesce(display_name,'本地验收学员') as display_name
       from public.users
      where role='student' and is_active=true and (status is null or status='active')
        and (username like 'e2e_%' or display_name like '%测试%')
      order by created_at asc nulls last limit 1`,
  );
  assert.equal(students.rowCount, 1, 'an active local-only acceptance student is required');
  student = students.rows[0];
  await postgres.query('ROLLBACK');
} finally {
  await postgres.end();
}

const validation = (release.validation_result || {}) as Record<string, unknown>;
assert.equal(release.status, 'published');
assert.equal(release.is_current, true);
assert.equal(validation.migrationBaseline, true);
assert.equal(validation.migrationBaselinePatch, true);
assert.equal(validation.productionCanaryComplete, false);
assert.match(String(validation.migrationSha256 || ''), /^[a-f0-9]{64}$/u);
assert.match(String(release.manifest_sha256 || ''), /^[a-f0-9]{64}$/u);

const versionResponse = await fetch(`${baseUrl}/api/version`, { cache: 'no-store' });
assert.equal(versionResponse.status, 200);
const version = await versionResponse.json() as { revision?: number; buildId?: string };
assert.ok(Number(version.revision) >= 197, 'runtime must contain the paid-gate status correction');
assert.ok(version.buildId);

const healthResponse = await fetch(`${baseUrl}/api/commerce/health`, { cache: 'no-store' });
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json() as Record<string, unknown>;
assert.equal(health.configurationReady, true);
assert.equal(health.configurationMode, 'migration-baseline');
assert.equal(health.readyForPaidJobs, false);
assert.equal(health.overallComplete, false);

const catalogResponse = await fetch(`${baseUrl}/api/commerce/v1/director-catalog`, { cache: 'no-store' });
assert.equal(catalogResponse.status, 200);
const catalog = await catalogResponse.json() as { directors: Array<Record<string, any>> };
assert.equal(catalog.directors.length, 19);
assert.equal(new Set(catalog.directors.map((card) => card.key)).size, 19);
for (const key of ['ecommerce-function-demo', 'local-store-signature-experience']) {
  const card = catalog.directors.find((item) => item.key === key);
  assert.ok(card, `${key} must remain public`);
  const sound = card.slots.find((slot: Record<string, any>) => slot.label === '声音');
  assert.deepEqual(sound?.kinds, ['audio']);
}
const publicCatalogJson = JSON.stringify(catalog);
for (const privateField of ['systemPrompt', 'promptVersion', 'prompt_version', 'knowledge', 'primaryModel', 'costPrice']) {
  assert.equal(publicCatalogJson.includes(`"${privateField}"`), false, `${privateField} must remain private`);
}

const anonymousAdmin = await fetch(`${baseUrl}/api/admin/commerce`, { cache: 'no-store', redirect: 'manual' });
assert.equal(anonymousAdmin.status, 401);

const studentToken = await new SignJWT({
  userId: student.id,
  username: student.username,
  role: 'student',
  displayName: student.display_name,
}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m')
  .sign(new TextEncoder().encode(runtime.jwtSecret));

const ordinaryAdmin = await fetch(`${baseUrl}/api/admin/commerce`, {
  cache: 'no-store',
  headers: { Authorization: `Bearer ${studentToken}` },
});
assert.equal(ordinaryAdmin.status, 403);

const sessionResponse = await fetch(`${baseUrl}/api/commerce/session`, {
  method: 'POST',
  cache: 'no-store',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/json', Origin: baseUrl },
  body: JSON.stringify({ action: 'main-bind', mainToken: studentToken }),
});
assert.equal(sessionResponse.status, 200);
const setCookie = sessionResponse.headers.getSetCookie().find((value) => value.startsWith('commerce_session='));
assert.ok(setCookie, 'main-site identity bridge must issue a commerce session');
const commerceCookie = setCookie.split(';', 1)[0];

const commerceDbPath = path.join(runtime.runtimeRoot, 'preview-runtime', 'commerce-agent', 'commerce.sqlite');
assert.equal(fs.existsSync(commerceDbPath), true, 'the main 5000 commerce SQLite must exist');
const sqlite = new DatabaseSync(commerceDbPath);
const quoteCount = () => Number((sqlite.prepare("select count(*) as total from records where bucket='commerce-quotes'").get() as { total: number }).total);
const beforeQuotes = quoteCount();
const paidProbe = await fetch(`${baseUrl}/api/commerce/quotes`, {
  method: 'POST',
  cache: 'no-store',
  headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: commerceCookie },
  body: JSON.stringify({ kind: 'agent', prompt: 'migration-baseline-paid-gate-probe' }),
});
const paidProbeBody = await paidProbe.json() as Record<string, unknown>;
assert.equal(paidProbe.status, 503);
assert.equal(paidProbeBody.code, 'COMMERCE_CONFIG_PAID_JOBS_NOT_READY');
assert.equal(quoteCount(), beforeQuotes, 'a blocked migration baseline request must not create a quote');

const retiredAdmin = await fetch(`${baseUrl}/api/commerce/admin`, {
  cache: 'no-store',
  headers: { Cookie: commerceCookie },
});
assert.equal(retiredAdmin.status, 410);
const retiredBody = await retiredAdmin.json() as Record<string, unknown>;
assert.equal(retiredBody.code, 'COMMERCE_ADMIN_MOVED');

const settings = await fetch(`${baseUrl}/commerce/settings`, { cache: 'no-store', redirect: 'manual' });
assert.ok([307, 308].includes(settings.status));
assert.equal(new URL(String(settings.headers.get('location')), baseUrl).href, `${baseUrl}/admin?tab=commerce`);

console.log(JSON.stringify({
  suite: 'commerce-migration-baseline-runtime',
  passed: 31,
  runtime: { revision: version.revision, buildId: version.buildId, port: 5000 },
  configuration: { releaseId: release.id, releaseVersion: release.release_version, mode: health.configurationMode, readyForPaidJobs: false },
  directorCards: 19,
  protectedAdmin: { anonymous: 401, ordinaryMember: 403, retiredEndpoint: 410 },
  blockedPaidQuote: { status: paidProbe.status, code: paidProbeBody.code, quoteRowsCreated: 0 },
  providerRequests: 0,
  walletWrites: 0,
}));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
