// Read-only local configuration and source catalog inventory; no supplier calls.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import pg from 'pg';
import { readLocalPreviewLaunchPlan, LOCAL_PREVIEW_RUNTIME_FILE } from './start-local-data-preview.mjs';

const require = createRequire(import.meta.url);
const plan = await readLocalPreviewLaunchPlan();
const runtime = JSON.parse(readFileSync(LOCAL_PREVIEW_RUNTIME_FILE, 'utf8'));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.ownerConnection.host, '127.0.0.1');
assert.equal(runtime.ownerConnection.port, 54322);
assert.equal(runtime.ownerConnection.database, 'zimeiti_local');
const cache = new Map();
function actual(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const exports = {};
  cache.set(relative, exports);
  const filename = path.resolve(relative);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const allowed = new Set(['src/lib/provider-secret.ts', 'src/lib/server-secret.ts']);
  vm.runInNewContext(source, {
    exports, Buffer, process: { ...process, env: plan.env },
    require: id => {
      if (id === '@/storage/database/supabase-client') return { getSupabaseClient() { throw new Error('REMOTE_DATABASE_FORBIDDEN'); } };
      if (id.startsWith('@/')) {
        const target = `src/${id.slice(2)}.ts`;
        assert.ok(allowed.has(target), 'UNEXPECTED_SOURCE_IMPORT');
        return actual(target);
      }
      assert.ok(id.startsWith('node:'), 'UNEXPECTED_PACKAGE_IMPORT');
      return require(id);
    },
  }, { filename });
  return exports;
}
const present = value => typeof value === 'string' && value.trim().length >= 8;
function managementPresence(value) {
  let accessKey = false, secretKey = false;
  function visit(object, depth) {
    if (!object || typeof object !== 'object' || depth > 4) return;
    for (const [key, entry] of Object.entries(object)) {
      const normalized = key.replace(/[^a-z]/giu, '').toLowerCase();
      if (['ak', 'accesskey', 'accesskeyid'].includes(normalized) && present(entry)) accessKey = true;
      if (['sk', 'secretkey', 'secretaccesskey', 'accesskeysecret'].includes(normalized) && present(entry)) secretKey = true;
      if (entry && typeof entry === 'object') visit(entry, depth + 1);
    }
  }
  visit(value, 0);
  return { accessKeyPresent: accessKey, secretKeyPresent: secretKey, pairPresent: accessKey && secretKey };
}
function readVoiceFileSummary(filename) {
  if (!existsSync(filename)) return { exists: false, volcanoRows: 0, management: managementPresence(null) };
  const content = JSON.parse(readFileSync(filename, 'utf8'));
  const rows = (Array.isArray(content) ? content : Object.values(content || {})).filter(row => row && typeof row === 'object'
    && /volcano|volcengine|bytedance|doubao/iu.test(String(row.engine || row.provider || row.id || '')));
  return { exists: true, volcanoRows: rows.length, apiKeyPresent: rows.some(row => present(row.apiKey || row.api_key || row.token)), management: managementPresence(rows) };
}

const db = new pg.Client({ ...runtime.ownerConnection, connectionTimeoutMillis: 10000 });
const report = { at: new Date().toISOString(), localDatabaseVerified: true, readOnly: true, supplierCalls: 0, generationRequests: 0 };
try {
  await db.connect();
  await db.query('BEGIN READ ONLY');
  const { rows } = await db.query('SELECT id,name,role,subtype,is_active,sort_order,config FROM public.plugins WHERE is_active=true ORDER BY sort_order,created_at');
  const provider = actual('src/lib/server/voice-provider-config.ts');
  const voiceRows = rows.filter(row => Boolean(provider.getVolcanoVoiceCredentialReference(row)));
  const config = await provider.loadVolcanoVoiceProviderConfig({ listActivePlugins: async () => rows, environment: plan.env });
  report.currentProvider = { configured: Boolean(config?.apiKey), source: config?.source || 'none', bindingId: config?.bindingId || null, authentication: 'speech X-Api-Key' };
  report.activeVoiceBindings = voiceRows.map(row => ({ id: row.id, management: managementPresence(row.config) }));
  report.managementEnvironment = managementPresence(Object.fromEntries(Object.entries(plan.env)
    .filter(([name]) => /^(VOLCENGINE|VOLC|VOLCANO|BYTEPLUS)_(ACCESS_KEY|ACCESS_KEY_ID|SECRET_KEY|SECRET_ACCESS_KEY|ACCESS_KEY_SECRET|AK|SK)$/u.test(name))
    .map(([name, value]) => [name.replace(/^(VOLCENGINE|VOLC|VOLCANO|BYTEPLUS)_/u, ''), value])));
  report.speechEnvironment = { apiKeyPresent: present(plan.env.VOLCENGINE_API_KEY_1), tokenPresent: present(plan.env.VOLC_TOKEN) };
  const dataDirectory = path.resolve(plan.cwd, plan.env.APP_DATA_DIR || 'data');
  report.engineFile = readVoiceFileSummary(path.join(dataDirectory, 'engine-configs.json'));
  report.serviceCardsFile = readVoiceFileSummary(path.join(dataDirectory, 'service-cards.json'));
  const voices = actual('src/lib/vs/voices-data.ts').OFFICIAL_VOICES;
  report.workspaceCatalog = { count: voices.length, explicitOnePointZero: voices.filter(voice => voice.resourceId === 'seed-tts-1.0').length,
    effectiveTwoPointZero: voices.filter(voice => (voice.resourceId || 'seed-tts-2.0') === 'seed-tts-2.0').length };
  await db.query('ROLLBACK');
  const directory = '.codex-evidence/voice-mix-catalog-20260903';
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'local-config-inventory.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // Database/parser errors can contain credential or row contents.
  console.error(JSON.stringify({ failed: true, code: /^[A-Z0-9_]{3,80}$/u.test(String(error?.message)) ? error.message : 'VOICE_CONFIG_READONLY_INSPECTION_FAILED' }));
  process.exitCode = 1;
} finally { await db.end().catch(() => {}); }
