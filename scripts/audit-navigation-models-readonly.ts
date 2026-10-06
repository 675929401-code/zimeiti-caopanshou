import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Local database SELECTs and catalogue GETs only. Never authenticate as a user,
// submit a provider request, or serialize credentials / private protocol config.
async function main() {
  const root = process.cwd();
  const baseUrl = String(process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/$/u, '');
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?$/u.test(baseUrl)) throw new Error('LOCAL_BASE_URL_REQUIRED');
  const runStartedAt = new Date();
  const runDate = runStartedAt.toISOString().slice(0, 10).replaceAll('-', '');
  const runId = runStartedAt.toISOString().replaceAll(/[-:.]/gu, '');
  const output = path.resolve(root, `../运行日志/逐模型功能升级-${runDate}/${runId}`);
  const require = createRequire(path.join(root, 'package.json'));
  const launcher = await import(pathToFileURL(path.join(root, 'scripts/start-local-data-preview.mjs')).href);
  const runtimeFile = JSON.parse(fs.readFileSync(launcher.LOCAL_PREVIEW_RUNTIME_FILE, 'utf8'));
  const runtime = launcher.validateLocalPreviewRuntime(runtimeFile);
  const base = require('dotenv').parse(fs.readFileSync(path.join(root, '.env.local'), 'utf8'));
  Object.assign(process.env, launcher.createLocalPreviewLaunchPlan(runtimeFile, base).env);
  const { toPublicModelId, containsForbiddenPublicModelKey } = await import('../src/lib/public-model-dto');
  const { isPublishedTextModelEligible } = await import('../src/lib/text-model-eligibility');
  const { resolveProviderSecret } = await import('../src/lib/provider-secret');
  const { sharedConfigurationConnection } = await import('../src/storage/database/configuration-source');
  const { getImageModelCapabilities } = await import('../src/lib/image-model-capabilities');
  const { resolveImageResolutionPrice } = await import('../src/lib/image-resolution-pricing');
  const { getVideoResolutionCapabilities, getVideoDurationCapabilities, resolveVideoCharge } = await import('../src/lib/video-model-capabilities');
  const { getVideoInputContract } = await import('../src/lib/video-input-contract');
  const { inspectVideoModelActivationReadiness } = await import('../src/lib/model-activation-gate');
  const { resolveVoiceSqlitePath } = await import('../src/lib/voice-studio/database-path');
  const routes = ['/api/chat-models','/api/video/models?surface=video-page','/api/video/models?surface=storyboard-workbench','/api/video/models?surface=digital-human','/api/cover-models?surface=image-workbench','/api/cover-models?surface=storyboard-workbench','/api/voice/list?limit=500','/api/voice/pricing','/api/voice/status'];
  const http: any[] = [];
  const bodies = new Map<string, any>();
  for (const route of routes) {
    const response = await fetch(baseUrl + route, { signal: AbortSignal.timeout(25000) });
    const body = await response.json();
    bodies.set(route, body);
    http.push({ route, status: response.status, count: body.models?.length ?? body.data?.voices?.length ?? (Array.isArray(body.data) ? body.data.length : undefined), forbiddenModelField: body.models ? containsForbiddenPublicModelKey(body.models) : undefined });
  }
  const db = new (require('pg').Client)({ connectionString: runtime.databaseUrl, query_timeout: 15000 });
  const tables: Record<string, any[]> = {};
  await db.connect();
  try {
    await db.query('SET default_transaction_read_only = on');
    for (const table of ['video_models', 'cover_models', 'llm_models', 'plugins']) {
      tables[table] = (await db.query(`SELECT to_jsonb(m) AS row FROM ${table} m ORDER BY id`)).rows.map((entry: any) => entry.row);
    }
  } finally { await db.end(); }
  const shared = sharedConfigurationConnection();
  if (shared) {
    const url = new URL('/rest/v1/llm_models', shared.url);
    url.searchParams.set('select', '*'); url.searchParams.set('order', 'id');
    const response = await fetch(url, { headers: { apikey: shared.key, Authorization: `Bearer ${shared.key}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('SHARED_MODEL_READ_FAILED');
    tables.llm_models = await response.json();
  }
  const sharedCloudPublishedTextModels = tables.llm_models
    .filter((row) => isPublishedTextModelEligible(row))
    .map((row) => ({
      id: toPublicModelId('chat', row.id),
      name: row.name || row.model_name || '未命名对话模型',
    }));
  const runtimePublishedTextModels = (bodies.get('/api/chat-models')?.models || []).map((row: any) => ({
    id: String(row.id || ''),
    name: String(row.displayName || row.name || '未命名对话模型'),
    publicPrice: typeof row.publicPrice === 'number' ? row.publicPrice : null,
    available: row.capabilities?.available !== false,
    billingUnit: String(row.capabilities?.billingUnit || ''),
    pricingMode: String(row.capabilities?.pricingMode || ''),
    explicitlyFree: row.capabilities?.explicitlyFree === true,
  }));
  const sharedCloudTextIds = new Set(sharedCloudPublishedTextModels.map((row) => row.id));
  const runtimeTextIds = new Set(runtimePublishedTextModels.map((row: any) => row.id));
  const runtimeTextCatalogDrift = {
    aligned: sharedCloudTextIds.size === runtimeTextIds.size
      && [...sharedCloudTextIds].every((id) => runtimeTextIds.has(id)),
    runtimeCount: runtimePublishedTextModels.length,
    sharedCloudCount: sharedCloudPublishedTextModels.length,
    runtimeOnly: runtimePublishedTextModels.filter((row: any) => !sharedCloudTextIds.has(row.id)),
    sharedCloudOnly: sharedCloudPublishedTextModels.filter((row) => !runtimeTextIds.has(row.id)),
  };
  const money = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const models: any[] = [];
  for (const [table, kind] of [['video_models','video'], ['cover_models','cover'], ['llm_models','chat']] as const) {
    for (const row of tables[table]) {
      const id = toPublicModelId(kind, row.id);
      const surfaces = routes.filter(route => bodies.get(route)?.models?.some((model: any) => model.id === id));
      const publicModel = surfaces.length ? bodies.get(surfaces[0]).models.find((model: any) => model.id === id) : null;
      let credentialResolved = false;
      try { credentialResolved = Boolean(resolveProviderSecret(row.api_key)); } catch { /* report only readiness */ }
      let endpointConfigured = false;
      try { endpointConfigured = ['http:', 'https:'].includes(new URL(row.api_endpoint || row.base_url || row.api_url).protocol); } catch { /* missing endpoint */ }
      const item: any = { kind, id: row.id, publicId: id, name: row.name || row.model_name, provider: row.provider || null, protocol: row.protocol_type || row.api_protocol || null, active: row.is_active, hidden: row.is_hidden, access: row.user_access, endpointConfigured, credentialResolved, surfaces, publicPrice: publicModel?.publicPrice ?? null, publicCapabilities: publicModel?.capabilities || null, cost: money(row.cost_price), configuredSale: money(row.selling_price ?? row.cost_per_use), concerns: [], generationVerifiedThisRun: false };
      if (kind === 'video') {
        const caps = getVideoResolutionCapabilities(row);
        item.duration = getVideoDurationCapabilities(row); item.input = getVideoInputContract(row);
        item.activation = inspectVideoModelActivationReadiness(row);
        item.configuredSale = money(row.price_per_use);
        item.prices = (caps.options.length ? caps.options : ['']).map(resolution => resolveVideoCharge(row, resolution, item.duration.defaultDuration));
      } else if (kind === 'cover') {
        const caps = getImageModelCapabilities(row);
        item.prices = caps.resolutionOptions.map(resolution => ({ resolution, cost: money(resolveImageResolutionPrice(row, resolution, 'cost')), sale: money(resolveImageResolutionPrice(row, resolution, 'selling')) }));
        item.input = caps;
      } else {
        item.textPrice = { perUse: money(row.cost_per_use), input: money(row.input_price), output: money(row.output_price) };
      }
      if (surfaces.length && !credentialResolved) item.concerns.push('CREDENTIAL_UNRESOLVED');
      if (surfaces.length && !endpointConfigured) item.concerns.push('ENDPOINT_UNCONFIGURED');
      if (publicModel?.capabilities?.available === false) item.concerns.push('PUBLIC_UNAVAILABLE');
      if (kind !== 'chat' && item.prices.some((price: any) => (price.cost ?? price.costPrice) == null || (price.sale ?? price.publicPrice) == null)) item.concerns.push('PRICE_UNCONFIRMED');
      if (kind !== 'chat' && publicModel && item.configuredSale != null && Math.abs(publicModel.publicPrice - item.configuredSale) > .000001) item.concerns.push('PUBLIC_PRICE_DIFFERS_FROM_BASE');
      if (publicModel && item.input) {
        item.parameterMismatches = Object.entries(item.input).filter(([key, value]) => Object.hasOwn(publicModel.capabilities, key) && JSON.stringify(publicModel.capabilities[key]) !== JSON.stringify(value)).map(([key]) => key);
        if (item.parameterMismatches.length) item.concerns.push('PUBLIC_INPUT_CONTRACT_MISMATCH');
      }
      if (kind !== 'chat' && item.prices.some((p: any) => (p.sale ?? p.publicPrice) < (p.cost ?? p.costPrice))) item.concerns.push('SALE_BELOW_CONFIGURED_COST');
      models.push(item);
    }
  }
  const sqlite = new (require('better-sqlite3'))(resolveVoiceSqlitePath(), { readonly: true, fileMustExist: true });
  let voicePricing: any[];
  try { voicePricing = sqlite.prepare('SELECT id,name,modelId,costPrice,unit,profitMargin,isActive FROM ModelConfig ORDER BY sort,id').all(); } finally { sqlite.close(); }
  const voices = (bodies.get('/api/voice/list?limit=500')?.data?.voices || []).map((voice: any) => ({ id: voice.id, name: voice.name, speakerId: voice.speakerId, engine: voice.engine, generationVerifiedThisRun: false }));
  const plugins = tables.plugins.map(row => ({ id: row.id, name: row.name, role: row.role, type: row.type, active: row.is_active, cost: money(row.cost_price), sale: money(row.price_per_use) }));
  const report = { at: runStartedAt.toISOString(), mode: 'read-only', baseUrl, providerSubmissions: 0, databaseWrites: 0, textConfiguration: shared ? 'shared-cloud' : 'local', runtimeTextCatalogDrift, http, models, voicePricing, voices, voiceStatus: bodies.get('/api/voice/status'), plugins };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'model-audit.json'), JSON.stringify(report, null, 2) + '\n');
  const cell = (v: any) => String(v ?? '未设置').replace(/[|\r\n]/g, ' ');
  const runtimeBillingLabel = (row: (typeof runtimePublishedTextModels)[number]) => row.billingUnit === 'token' || row.pricingMode === 'token_usage'
    ? row.explicitlyFree ? '明确免费' : '按实际 Token 用量'
    : row.publicPrice ?? '未知';
  const modelBillingLabel = (model: (typeof models)[number]) => model.kind === 'chat' && (model.publicCapabilities?.billingUnit === 'token' || model.publicCapabilities?.pricingMode === 'token_usage')
    ? model.publicCapabilities?.explicitlyFree === true ? '明确免费' : '按实际 Token 用量'
    : model.publicPrice;
  const lines = ['# 逐模型核对明细', '', `检查时间：${report.at}。只读配置与目录核对；本轮新增生成请求 0，数据库写入 0。`, '', '## 运行目录与共享云配置差异', '', runtimeTextCatalogDrift.aligned ? '当前运行版对话模型目录与共享云配置一致。' : `当前运行版与共享云配置不一致：运行版 ${runtimeTextCatalogDrift.runtimeCount} 个，共享云配置 ${runtimeTextCatalogDrift.sharedCloudCount} 个。`, '', ...(runtimeTextCatalogDrift.runtimeOnly.length ? ['运行版独有：' + runtimeTextCatalogDrift.runtimeOnly.map((row: any) => `${row.name}（${row.id}，计费 ${runtimeBillingLabel(row)}）`).join('；'), ''] : []), ...(runtimeTextCatalogDrift.sharedCloudOnly.length ? ['共享云配置独有：' + runtimeTextCatalogDrift.sharedCloudOnly.map((row) => `${row.name}（${row.id}）`).join('；'), ''] : []), '| 类型 | 名称 | 配置编号 | 接口协议 | 凭据可解析 | 公开入口数 | 公开计费 | 当前问题 |', '|---|---|---|---|---|---|---|---|', ...models.map(m => `| ${[m.kind,m.name,m.id,m.protocol,m.credentialResolved,m.surfaces.length,modelBillingLabel(m),m.concerns.join('、') || (m.surfaces.length ? '配置核对通过，生成待验' : '未公开配置，未激活')].map(cell).join(' | ')} |`), '', '## 语音模型定价配置', '', '| 模型 | 名称 | 启用 | 成本 | 加价率 | 单位 |', '|---|---|---|---|---|---|', ...voicePricing.map(m => `| ${[m.modelId,m.name,m.isActive,m.costPrice,m.profitMargin,m.unit].map(cell).join(' | ')} |`), '', '## 逐音色目录', '', '| 名称 | 音色编号 | 引擎 | 真实合成验收 |', '|---|---|---|---|', ...voices.map((v: any) => `| ${[v.name,v.speakerId || v.id,v.engine,'待验'].map(cell).join(' | ')} |`), '', '## 插件目录', '', '| 名称 | 角色 | 类型 | 启用 | 成本 | 售价 |', '|---|---|---|---|---|---|', ...plugins.map(p => `| ${[p.name,p.role,p.type,p.active,p.cost,p.sale].map(cell).join(' | ')} |`)];
  fs.writeFileSync(path.join(output, '逐模型核对明细.md'), lines.join('\n') + '\n');
  console.log(JSON.stringify({ output, http, runtimeTextCatalogDrift, counts: { video: models.filter(m => m.kind === 'video').length, image: models.filter(m => m.kind === 'cover').length, text: models.filter(m => m.kind === 'chat').length, voicePricing: voicePricing.length, voices: voices.length, plugins: plugins.length }, concerns: models.filter(m => m.concerns.length).map(m => ({ name: m.name, concerns: m.concerns })), providerSubmissions: 0, databaseWrites: 0 }, null, 2));
}
main().catch((error: unknown) => { console.error('MODEL_AUDIT_FAILED', error instanceof Error ? error.name : 'Error'); if (error instanceof Error) console.error(error.stack?.split('\n').slice(1, 4).join('\n')); process.exitCode = 1; });
