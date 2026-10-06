import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { readLocalPreviewLaunchPlan, LOCAL_PREVIEW_RUNTIME_FILE, validateLocalPreviewRuntime } from './start-local-data-preview.mjs';
import { resolveProviderSecret } from '../src/lib/provider-secret.ts';
import { getImageModelCapabilities } from '../src/lib/image-model-capabilities.ts';
import { isRetiredCoverModel } from '../src/lib/retired-cover-models.ts';
import { toPublicModelId } from '../src/lib/public-model-dto.ts';

// Read-only local inventory. Raw rows and resolved credentials never leave this process.
const runtime = JSON.parse(await fs.readFile(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8'));
validateLocalPreviewRuntime(runtime);
const plan = await readLocalPreviewLaunchPlan(5002);
Object.assign(process.env, plan.env);
const connection = runtime.ownerConnection;
if (connection.host !== '127.0.0.1' || connection.port !== 54322 || connection.database !== 'zimeiti_local') throw new Error('LOCAL_TARGET_REQUIRED');
const client = new pg.Client(connection);
const report = { inspectedAt: new Date().toISOString(), localOnly: true, database: 'zimeiti_local', generationPosts: 0, databaseWrites: 0, models: [] };
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '10s'");
  const { rows } = await client.query('SELECT id,name,model_name,provider,api_endpoint,api_key,cost_price,selling_price,is_active,is_hidden,supports_image_input FROM public.cover_models ORDER BY created_at,id');
  const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='cover_models' ORDER BY ordinal_position");
  report.coverModelColumns = columns.rows.map(row => row.column_name);
  const candidateTables = ['image_model_validation', 'image_model_validations', 'image_channel_health', 'cover_model_validation', 'cover_model_validations', 'cover_model_health', 'image_generation_requests'];
  const tables = await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name = ANY($2::text[])', ['public', candidateTables]);
  report.knownImageGovernanceTablesPresent = tables.rows.map(row => row.table_name);
  report.models = rows.map(row => {
    let credentialReady = false, endpointHost = '';
    try { credentialReady = Boolean(resolveProviderSecret(row.api_key).trim()); } catch { /* Readiness only. */ }
    try { endpointHost = new URL(String(row.api_endpoint)).host; } catch { /* No private URL returned. */ }
    const retiredByCurrentSource = isRetiredCoverModel(row);
    return {
      id: row.id, publicModelId: toPublicModelId('cover', row.id), name: row.name, modelName: row.model_name, provider: row.provider,
      endpointConfigured: Boolean(endpointHost), endpointHost, credentialReady,
      sellingPrice: row.selling_price == null ? null : Number(row.selling_price), costPrice: row.cost_price == null ? null : Number(row.cost_price),
      active: row.is_active, hidden: row.is_hidden, retiredByCurrentSource,
      pendingNewModel: row.id.startsWith('pending-cover-model-'),
      currentAdminInternalIdAdmission: row.is_active === true && !retiredByCurrentSource,
      capabilities: getImageModelCapabilities(row),
    };
  });
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw new Error(`READONLY_INVENTORY_FAILED:${/^[A-Z0-9_]{1,60}$/u.test(String(error?.code)) ? error.code : 'REDACTED'}`);
} finally { await client.end(); }
const response = await fetch('http://127.0.0.1:5000/api/cover-models?surface=image-workbench', { signal: AbortSignal.timeout(10_000) });
const catalog = response.ok ? await response.json() : null;
report.publicCatalog = { origin: 'http://127.0.0.1:5000', status: response.status, ids: Array.isArray(catalog?.models) ? catalog.models.map(model => model.id) : [] };
for (const model of report.models) model.presentInCurrentPublicCatalog = report.publicCatalog.ids.includes(model.publicModelId);
report.sourceHashes = {};
for (const file of ['src/app/api/image/generate/route.ts', 'src/app/api/cover-models/route.ts', 'src/lib/retired-cover-models.ts', 'src/lib/model-activation-gate.ts']) report.sourceHashes[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
const out = '.codex-evidence/image-model-governance-20260903/inventory-readonly.json';
await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ modelCount: report.models.length, publicCount: report.publicCatalog.ids.length, publicStatus: response.status, hiddenCount: report.models.filter(model => model.hidden).length, activeCount: report.models.filter(model => model.active).length, credentialPresentCount: report.models.filter(model => model.credentialReady).length, generationPosts: 0, databaseWrites: 0, report: out }));
