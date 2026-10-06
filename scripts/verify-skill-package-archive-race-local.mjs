import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';

const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
assert.ok(runtime.localOnly && runtime.ownerConnection.host === '127.0.0.1' && runtime.ownerConnection.port === 54322 && runtime.ownerConnection.database === 'zimeiti_local', 'LOCAL_DATABASE_REQUIRED');
const packageId = 'cf44b5b6-18e9-4a5a-8096-8c510f7be1c2';
const a = new pg.Client(runtime.ownerConnection), b = new pg.Client(runtime.ownerConnection);
const checks = []; let before, after, error = null;
const snapshotSql = `select lifecycle, active_version_id, updated_at::text,
  (select count(*)::int from skill_versions where package_id=$1) versions,
  (select count(*)::int from skill_release_audit where package_id=$1) audits,
  (select count(*)::int from user_skill_installations where package_id=$1) user_installations,
  (select count(*)::int from agent_skill_installations where package_id=$1) agent_installations,
  (select count(*)::int from skill_invocations where package_id=$1) invocations
  from skill_packages where id=$1`;
async function rollback() { await Promise.allSettled([a.query('ROLLBACK'), b.query('ROLLBACK')]); }
try {
  await Promise.all([a.connect(), b.connect()]);
  const target = (await a.query('select current_database() as name,inet_server_port() as port')).rows[0]; assert.equal(target.name, 'zimeiti_local'); assert.equal(target.port, 54322);
  const p = (await a.query("select id,created_by,updated_at::text,active_version_id from skill_packages where id=$1 and slug='local-manju-crud-2d8e3ee5' and lifecycle='published' and visibility='private' and origin='custom' and metadata->>'localAcceptanceFixture'='true'", [packageId])).rows[0];
  assert.ok(p, 'KNOWN_PUBLISHED_FIXTURE_REQUIRED');
  before = (await a.query(snapshotSql, [packageId])).rows[0]; assert.equal(before.user_installations, 0); assert.equal(before.agent_installations, 0); assert.equal(before.invocations, 0);
  const installSql = 'insert into user_skill_installations(user_id,package_id,version_id,enabled,installed_by) values($1,$2,$3,true,$1)';
  const installArgs = [p.created_by, p.id, p.active_version_id];
  const archiveSql = 'select archive_skill_package($1,$2,$3,$4) as result';
  const archiveArgs = [p.id, p.updated_at, p.active_version_id, p.created_by];
  for (const direction of ['install-blocks-archive', 'archive-blocks-install']) {
    await a.query('BEGIN'); await b.query('BEGIN'); await b.query("set local lock_timeout='250ms'");
    try {
      if (direction === 'install-blocks-archive') await a.query(installSql, installArgs);
      else assert.equal((await a.query(archiveSql, archiveArgs)).rows[0].result.lifecycle, 'archived');
      const started = Date.now(); let code = null;
      try { await b.query(direction === 'install-blocks-archive' ? archiveSql : installSql, direction === 'install-blocks-archive' ? archiveArgs : installArgs); }
      catch (cause) { code = cause.code; }
      assert.equal(code, '55P03', 'EXPECTED_PACKAGE_ROW_LOCK_CONTENTION');
      checks.push({ check: direction, passed: true, code, waitedMs: Date.now() - started, lockTimeoutMs: 250 });
    } finally { await rollback(); }
    assert.deepEqual((await a.query(snapshotSql, [packageId])).rows[0], before, 'ROLLBACK_MUST_PRESERVE_ORIGINAL_PACKAGE');
  }
  after = (await a.query(snapshotSql, [packageId])).rows[0]; assert.deepEqual(after, before); assert.equal(after.lifecycle, 'published');
} catch (cause) { error = { type: cause.name, code: /^[A-Z0-9_]+$/u.test(cause.message || '') ? cause.message : 'ARCHIVE_RACE_ASSERTION_FAILED' }; }
finally {
  await rollback(); await Promise.allSettled([a.end(), b.end()]);
  const report = { passed: !error, localOnly: true, packageId, connections: 2, checks, originalPackageStillPublished: after?.lifecycle === 'published', countsUnchanged: before && after ? JSON.stringify(before) === JSON.stringify(after) : false, allMutationsRolledBack: true, error };
  await mkdir('.codex-evidence/skill-package-archive-20260903', { recursive: true });
  await writeFile('.codex-evidence/skill-package-archive-20260903/concurrency-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (error) process.exitCode = 1;
}
