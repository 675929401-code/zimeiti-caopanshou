import assert from 'node:assert/strict';

const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const releaseId = String(process.argv.find((value) => value.startsWith('--release-id='))?.slice(13) || '').trim();

assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002', 'http://127.0.0.1:5010'].includes(origin), 'LOCAL_ONLY_ORIGIN_REQUIRED');
assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
assert.match(releaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu, 'VALID_RELEASE_ID_REQUIRED');

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

const publish = await fetch(`${origin}/api/admin/commerce/releases`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ action: 'publish-migration-baseline', releaseId }),
  signal: AbortSignal.timeout(30_000),
});
const publishBody = await publish.json();
assert.ok(publish.ok && publishBody?.ok, `PUBLISH_FAILED_${publish.status}_${publishBody?.error || 'UNKNOWN'}`);

const readback = await fetch(`${origin}/api/admin/commerce/releases`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(15_000),
});
const readbackBody = await readback.json();
assert.ok(readback.ok && readbackBody?.ok, `READBACK_FAILED_${readback.status}`);
assert.equal(readbackBody.current?.id, releaseId, 'CURRENT_RELEASE_MISMATCH');
assert.equal(readbackBody.current?.is_current, true, 'CURRENT_FLAG_MISSING');
assert.equal(readbackBody.current?.status, 'published', 'CURRENT_RELEASE_NOT_PUBLISHED');
assert.equal(readbackBody.current?.validation_result?.migrationBaseline, true, 'MIGRATION_BASELINE_FLAG_MISSING');
assert.equal(readbackBody.current?.validation_result?.productionCanaryComplete, false, 'PAID_CANARY_MUST_REMAIN_CLOSED');

console.log(JSON.stringify({
  ok: true,
  releaseId,
  version: readbackBody.current.release_version,
  manifestSha256: readbackBody.current.manifest_sha256,
  migrationBaseline: true,
  productionCanaryComplete: false,
}));
