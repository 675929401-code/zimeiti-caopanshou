import assert from 'node:assert/strict';

export async function main(argv = process.argv.slice(2)) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
  assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(origin));
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.ok(token, 'Normal local administrator session is required');
  const value = argv.find((entry) => entry.startsWith('--models='))?.slice('--models='.length) || '';
  const models = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.ok(models.length > 0 && models.length <= 20);
  const results = [];
  for (const modelId of models) {
    assert.match(modelId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u);
    const response = await fetch(`${origin}/api/admin/video-models/validation?modelId=${encodeURIComponent(modelId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    results.push({
      modelId,
      http: response.status,
      success: body?.success === true,
      code: String(body?.code || ''),
      error: String(body?.error || '').slice(0, 200),
      localDatabaseOnly: body?.localDatabaseOnly === true,
      credentialReady: body?.readiness?.credentialReady === true,
      endpointConfigured: body?.readiness?.endpointConfigured === true,
      minimumInput: body?.minimumInput || null,
    });
  }
  console.log(JSON.stringify({ providerRequests: 0, databaseWrites: 0, results }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ failed: true, error: String(error?.message || error).slice(0, 300) }));
    process.exitCode = 1;
  });
}
