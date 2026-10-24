import { resolveProviderSecret } from '../src/lib/provider-secret';

async function main() {
  const ids = ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-5-260628'];
  const key = resolveProviderSecret('secret://secure-skill-seedance-official-token');
  const response = await fetch('https://token.secure-skill.com/v1/models', {
    method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  const models = Array.isArray(body.data) ? body.data.map((x: Record<string, unknown>) => String(x.id || x.name || '')) : [];
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: response.status,
    authenticated: response.ok, modelCount: models.length,
    targets: ids.map(id => ({ id, listed: models.includes(id) })), paidGenerationCalls: 0 }, null, 2));
  if (!response.ok || !ids.every(id => models.includes(id))) process.exitCode = 1;
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'AUTH_PROBE_FAILED'); process.exitCode = 1; });
