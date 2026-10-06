#!/usr/bin/env node
// Prepared acceptance runner. Default is plan-only. --execute requires an explicit
// local runtime configuration; no ambient production database configuration is read.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { parse as parseEnv } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const appOrigin = String(argument('origin') || process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
const sampleUrl = 'https://v.douyin.com/h1wY2hTAbmM/';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)])) : value;
const fingerprint = value => sha(JSON.stringify(canonical(value)));
const knownSecrets = new Set();
let evidence;
let evidencePath;

function cleanMessage(value) {
  let text = String(value || '').slice(0, 1500);
  for (const secret of knownSecrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(?:Bearer\s+)[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|api[_-]?token|clientSecretKey|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 350);
}
function stop(code) { const error = new Error(code); error.code = code; throw error; }
async function save() { await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); }

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs || 20_000) });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  const lower = address.toLowerCase();
  return isIP(address) === 6 && lower !== '::' && lower !== '::1' && !lower.startsWith('::ffff:')
    && !lower.startsWith('fc') && !lower.startsWith('fd') && !/^fe[89ab]/.test(lower)
    && !lower.startsWith('ff') && !lower.startsWith('2001:db8:');
}

async function headMedia(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return { attempted: false, reason: 'INVALID_MEDIA_URL' }; }
  const originalHash = sha(rawUrl);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') {
      return { attempted: false, urlHash: originalHash, reason: 'NON_PUBLIC_HTTPS_MEDIA_URL' };
    }
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
      return { attempted: false, urlHash: originalHash, reason: 'NON_PUBLIC_MEDIA_ADDRESS' };
    }
    const address = addresses.find(entry => entry.family === 4) || addresses[0];
    // Pin the validated address while retaining the original TLS hostname.
    const result = await new Promise((resolve, reject) => {
      const request = https.request(url, {
        method: 'HEAD', agent: false, timeout: 15_000,
        headers: { Referer: 'https://www.douyin.com/', 'User-Agent': 'LocalExtractionAcceptance/1.0' },
        lookup(_hostname, options, callback) {
          if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
        },
      }, response => {
        response.resume();
        resolve({ status: response.statusCode || 0, headers: response.headers });
      });
      request.on('timeout', () => request.destroy(new Error('MEDIA_HEAD_TIMEOUT')));
      request.on('error', reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      url = new URL(result.headers.location, url); continue;
    }
    return {
      attempted: true, urlHash: originalHash, host: url.hostname, status: result.status,
      contentType: result.headers['content-type'] || null,
      contentLength: result.headers['content-length'] || null,
      downloadableByHead: result.status >= 200 && result.status < 300,
    };
  }
  return { attempted: true, urlHash: originalHash, reason: 'MEDIA_REDIRECT_LIMIT' };
}

async function probeDeliveredMedia(rawUrl) {
  const resolved = new URL(rawUrl, appOrigin);
  if (resolved.origin !== appOrigin) return headMedia(resolved.toString());
  const response = await fetch(resolved, {
    headers: { Range: 'bytes=0-1023' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentRange = response.headers.get('content-range') || '';
  const contentType = response.headers.get('content-type') || '';
  return {
    attempted: true,
    delivery: 'same-origin-temporary',
    path: resolved.pathname,
    status: response.status,
    contentType,
    contentRange,
    bytesRead: buffer.byteLength,
    downloadableByHead: response.status === 206
      && /^bytes 0-1023\/\d+$/u.test(contentRange)
      && contentType.startsWith('video/')
      && buffer.byteLength === 1024,
  };
}

async function main() {
  const clientRequestId = argument('request-id');
  if (!process.argv.includes('--execute')) {
    console.log(JSON.stringify({
      execution: 'not-requested', providerSubmissions: 0,
      command: 'node scripts/verify-extract-local-single-submit.mjs --execute --confirm-local-runtime --runtime-config=<restricted-runtime.json> --request-id=<fresh-stable-id>',
      requiredConfig: ['supabaseUrl (loopback; COZE_SUPABASE_URL also accepted)', 'serviceRoleKey (COZE_SUPABASE_SERVICE_ROLE_KEY also accepted)'],
      runtimeConfirmation: `--confirm-local-runtime, or EXTRACT_E2E_LOCAL_RUNTIME_CONFIRMED=true in the explicit config/environment; confirms ${appOrigin} uses the same local database`,
      unusedRuntimeFields: ['ownerConnection', 'anonKey'],
      authentication: 'EXTRACT_E2E_TOKEN, or EXTRACT_E2E_USERNAME + EXTRACT_E2E_PASSWORD in the explicit config/environment; normal login only, no token generation or persistence',
      appOrigin, sampleUrl, rule: 'One POST only; an existing dispatch marker blocks rerun even after timeout. Read-only reconciliation is allowed.',
    }, null, 2));
    return;
  }
  if (!clientRequestId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(clientRequestId)) stop('VALID_FIXED_REQUEST_ID_REQUIRED');
  const parsedAppOrigin = new URL(appOrigin);
  if (parsedAppOrigin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedAppOrigin.hostname)) {
    stop('LOCAL_APP_ORIGIN_REQUIRED');
  }
  const configPath = argument('runtime-config');
  if (!configPath) stop('EXPLICIT_LOCAL_RUNTIME_CONFIG_REQUIRED');
  const raw = await fs.readFile(path.resolve(configPath), 'utf8');
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  let config;
  try { config = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(trimmed) : parseEnv(raw); }
  catch { stop('LOCAL_RUNTIME_CONFIG_INVALID'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) stop('LOCAL_RUNTIME_CONFIG_MUST_BE_OBJECT');
  const value = key => typeof config[key] === 'string' ? config[key].trim() : '';
  // Read ownerConnection/anonKey only into the redaction set. They are never used
  // to connect, mutate a database, authenticate the app, or enter evidence.
  for (const key of ['ownerConnection', 'anonKey', 'serviceRoleKey', 'COZE_SUPABASE_SERVICE_ROLE_KEY']) if (value(key)) knownSecrets.add(value(key));
  function aliasValue(primary, legacy) {
    const preferred = value(primary); const compatible = value(legacy);
    if (preferred && compatible && preferred !== compatible) stop('LOCAL_RUNTIME_CONFIG_ALIAS_CONFLICT');
    return preferred || compatible;
  }
  const confirmed = process.argv.includes('--confirm-local-runtime')
    || value('EXTRACT_E2E_LOCAL_RUNTIME_CONFIRMED') === 'true'
    || process.env.EXTRACT_E2E_LOCAL_RUNTIME_CONFIRMED === 'true';
  if (!confirmed) stop('LOCAL_APP_DATABASE_ACTIVATION_MUST_BE_CONFIRMED');
  let database;
  try { database = new URL(aliasValue('supabaseUrl', 'COZE_SUPABASE_URL')); }
  catch (error) { if (error.code === 'LOCAL_RUNTIME_CONFIG_ALIAS_CONFLICT') throw error; stop('LOCAL_DATABASE_URL_INVALID'); }
  if (!['http:', 'https:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
    || database.username || database.password || database.search || database.hash) stop('REMOTE_DATABASE_EXECUTION_FORBIDDEN');
  const databaseKey = aliasValue('serviceRoleKey', 'COZE_SUPABASE_SERVICE_ROLE_KEY');
  if (!databaseKey) stop('LOCAL_DATABASE_READ_CREDENTIAL_REQUIRED');
  knownSecrets.add(databaseKey);
  const headers = { apikey: databaseKey, Authorization: `Bearer ${databaseKey}`, 'Accept-Profile': 'public' };
  async function databaseRows(table, select, filters = {}) {
    const url = new URL(`rest/v1/${table}`, database.href.endsWith('/') ? database : `${database.href}/`);
    url.searchParams.set('select', select);
    for (const [key, entry] of Object.entries(filters)) url.searchParams.set(key, String(entry));
    const { response, body } = await jsonRequest(url, { headers });
    if (!response.ok || !Array.isArray(body)) {
      const code = body && typeof body.code === 'string' ? body.code : 'UNAVAILABLE';
      stop(`LOCAL_DATABASE_READ_${table}_${response.status}_${code}`);
    }
    return body;
  }

  const outputDir = path.join(root, '.codex-evidence/extract-local-e2e-20260902', sha(clientRequestId).slice(0, 24));
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  evidencePath = path.join(outputDir, 'result.json');
  const markerPath = path.join(outputDir, 'submission-dispatched.json');
  try { await fs.access(markerPath); stop('THIS_REQUEST_WAS_ALREADY_DISPATCHED_DO_NOT_RESUBMIT'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  evidence = {
    preparedAt: new Date().toISOString(), clientRequestId, sampleUrl, appOrigin,
    databaseScope: 'local-loopback', state: 'preflight', extractionPostAttempts: 0,
    retries: 0, credentialPersistence: false, privateMediaUrlsPersisted: false,
    supplierCostVerified: false, supplierRequestCount: 'not-observable-from-client',
  };
  await save();

  let token = value('EXTRACT_E2E_TOKEN') || process.env.EXTRACT_E2E_TOKEN?.trim();
  if (!token) {
    const username = value('EXTRACT_E2E_USERNAME') || process.env.EXTRACT_E2E_USERNAME?.trim();
    const password = value('EXTRACT_E2E_PASSWORD') || process.env.EXTRACT_E2E_PASSWORD;
    if (!username || !password) stop('NORMAL_LOCAL_LOGIN_CREDENTIALS_REQUIRED');
    knownSecrets.add(username); knownSecrets.add(password);
    const login = await jsonRequest(`${appOrigin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    evidence.loginStatus = login.response.status;
    token = login.body?.token;
    if (!login.response.ok || typeof token !== 'string' || !token) stop('NORMAL_LOCAL_LOGIN_FAILED');
    evidence.authMode = 'normal-login';
  } else evidence.authMode = 'provided-normal-session';
  knownSecrets.add(token);
  const me = await jsonRequest(`${appOrigin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  const user = me.body?.user;
  if (!me.response.ok || !user?.id || user.role !== 'admin' || user.is_active !== true) stop('ACTIVE_LOCAL_ADMIN_REQUIRED');
  const localUsers = await databaseRows('users', 'id,cash_balance,credits', { id: `eq.${user.id}`, limit: 1 });
  if (localUsers.length !== 1) stop('APP_SESSION_NOT_PRESENT_IN_LOCAL_DATABASE');
  evidence.auth = { verifiedAdmin: true, userMatchedLocalDatabase: true };
  evidence.balanceBefore = { cash: Number(localUsers[0].cash_balance), credits: Number(localUsers[0].credits) };

  const plugins = await databaseRows('plugins', 'id,type,role,price_per_use,cost_price,config', { role: 'eq.extract_video', is_active: 'eq.true', limit: 2 });
  if (plugins.length !== 1) stop('EXACTLY_ONE_ACTIVE_VIDEO_EXTRACTION_PLUGIN_REQUIRED');
  const plugin = plugins[0];
  const pluginConfig = plugin.config;
  if (!pluginConfig || typeof pluginConfig !== 'object' || Array.isArray(pluginConfig)) stop('PLUGIN_CONFIG_MUST_BE_JSON_OBJECT');
  for (const key of ['api_key', 'api_token', 'client_id', 'client_secret_key']) if (typeof pluginConfig[key] === 'string') knownSecrets.add(pluginConfig[key]);
  let providerEndpoint;
  try { providerEndpoint = new URL(String(pluginConfig.api_base_url || '')); } catch { stop('PPT6_PROVIDER_URL_INVALID'); }
  if (plugin.type !== 'third_party' || String(pluginConfig.provider || '').toLowerCase() !== 'ppt6'
    || pluginConfig.response_format !== 'ppt6' || providerEndpoint.protocol !== 'https:'
    || !['number', 'string'].includes(typeof plugin.price_per_use) || String(plugin.price_per_use).trim() === ''
    || Number(plugin.price_per_use) !== 0 || !pluginConfig.api_base_url || !pluginConfig.client_id || !pluginConfig.client_secret_key) {
    stop('CONFIGURED_ZERO_PRICE_PPT6_VIDEO_PLUGIN_REQUIRED');
  }
  evidence.plugin = { id: plugin.id, role: plugin.role, provider: 'ppt6', pricePerUse: 0, credentialFieldsPresent: true };
  const attemptId = sha(`${user.id}\u0000${clientRequestId}`);
  const payload = { links: [sampleUrl], extraction_mode: 'video' };
  evidence.attemptId = attemptId;
  evidence.payloadFingerprint = sha(JSON.stringify({ kind: 'single', payload: canonical(payload) }));
  const prior = await databaseRows('extraction_attempts', 'record_id,state', { record_id: `eq.${attemptId}`, limit: 1 });
  if (prior.length) stop('EXISTING_DATABASE_ATTEMPT_REQUIRES_READ_ONLY_RECONCILIATION');
  const walletKey = `extract:${clientRequestId}:ppt6-video`;
  const walletFilter = { user_id: `eq.${user.id}`, idempotency_key: `eq.${walletKey}`, limit: 10 };
  const ledgerBefore = await databaseRows('wallet_ledger_entries', 'operation_id,delta,balance_before,balance_after', walletFilter);
  if (ledgerBefore.length) stop('EXISTING_WALLET_OPERATION_REQUIRES_RECONCILIATION');
  const revenueFilter = { user_id: `eq.${user.id}`, task_id: `eq.${walletKey}`, record_type: 'eq.extract', limit: 10 };
  const revenueBefore = await databaseRows('revenue_records', 'task_id', revenueFilter);
  if (revenueBefore.length) stop('EXISTING_REVENUE_RECORD_REQUIRES_RECONCILIATION');
  evidence.ledgerBeforeCount = 0;
  evidence.revenueBeforeCount = 0;
  await save();

  // Persist dispatch intent BEFORE the only extraction POST. A crash here is
  // conservatively reconciled; rerunning this program cannot replay the provider.
  await fs.writeFile(markerPath, JSON.stringify({ clientRequestId, attemptId, dispatchedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  evidence.extractionPostAttempts = 1; evidence.state = 'dispatched';
  await save();
  let responseBody = null;
  try {
    const submitted = await jsonRequest(`${appOrigin}/api/extract`, {
      method: 'POST', timeoutMs: 240_000,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': clientRequestId },
      body: JSON.stringify({ ...payload, client_request_id: clientRequestId }),
    });
    responseBody = submitted.body;
    evidence.api = {
      httpStatus: submitted.response.status, success: submitted.body?.success === true,
      errorCode: submitted.body?.error_code || submitted.body?.code || null,
      error: cleanMessage(submitted.body?.error || ''),
      attemptHeaderMatches: submitted.response.headers.get('X-Extraction-Attempt-Id') === attemptId,
      replayed: submitted.response.headers.get('X-Extraction-Replayed'),
      charged: typeof submitted.body?.charged === 'boolean' ? submitted.body.charged : null,
      price: typeof submitted.body?.price === 'number' ? submitted.body.price : null,
      mode: typeof submitted.body?.mode === 'string' ? submitted.body.mode : null,
      bodyHash: submitted.body ? fingerprint(submitted.body) : null,
    };
  } catch (error) {
    evidence.api = { outcome: 'unknown', errorType: error.name || 'Error', error: cleanMessage(error.message) };
  }
  await save();

  const attempts = await databaseRows('extraction_attempts', 'record_id,state,http_status,response,provider_task_id,provider_evidence,billing_evidence,error_code,error_message', { record_id: `eq.${attemptId}`, limit: 1 });
  const terminal = attempts[0];
  evidence.persisted = terminal ? {
    state: terminal.state, httpStatus: terminal.http_status, providerTaskIdPresent: Boolean(terminal.provider_task_id),
    responseHash: terminal.response ? fingerprint(terminal.response) : null,
    responseMatchesApi: Boolean(terminal.response && responseBody && fingerprint(terminal.response) === fingerprint(responseBody)),
    errorCode: terminal.error_code || null, error: cleanMessage(terminal.error_message),
  } : { state: 'missing' };
  const ledgerAfter = await databaseRows('wallet_ledger_entries', 'operation_id,delta,balance_before,balance_after', walletFilter);
  evidence.wallet = { requestLedgerCount: ledgerAfter.length, requestDelta: ledgerAfter.reduce((sum, row) => sum + Number(row.delta), 0), expectedCharge: 0 };
  const revenueAfter = await databaseRows(
    'revenue_records',
    'model_id,task_id,cost_price,selling_price,profit,billing_exempt,record_type,cash_charged,credits_charged',
    revenueFilter,
  );
  const revenue = revenueAfter[0];
  evidence.revenue = revenue ? {
    count: revenueAfter.length,
    modelId: revenue.model_id,
    taskIdMatches: revenue.task_id === walletKey,
    costPrice: Number(revenue.cost_price),
    sellingPrice: Number(revenue.selling_price),
    profit: Number(revenue.profit),
    billingExempt: Boolean(revenue.billing_exempt),
    recordType: revenue.record_type,
    cashCharged: Number(revenue.cash_charged || 0),
    creditsCharged: Number(revenue.credits_charged || 0),
  } : { count: 0 };
  const usersAfter = await databaseRows('users', 'cash_balance,credits', { id: `eq.${user.id}`, limit: 1 });
  evidence.balanceAfter = usersAfter[0] ? { cash: Number(usersAfter[0].cash_balance), credits: Number(usersAfter[0].credits) } : null;
  const media = responseBody?.videos?.find(item => item?.success !== false
    && typeof (item.temporary_url || item.download_url || item.url) === 'string');
  if (media) {
    try { evidence.mediaHead = await probeDeliveredMedia(media.temporary_url || media.download_url || media.url); }
    catch (error) { evidence.mediaHead = { attempted: true, errorType: error.name || 'Error', error: cleanMessage(error.message) }; }
  } else evidence.mediaHead = { attempted: false, reason: 'NO_SUCCESSFUL_VIDEO_URL' };
  evidence.state = evidence.api?.httpStatus === 200 && evidence.api.success && evidence.api.attemptHeaderMatches
    && evidence.api.charged === false && evidence.api.price === 0
    && evidence.persisted.state === 'succeeded' && evidence.persisted.responseMatchesApi
    && evidence.mediaHead.downloadableByHead === true && ledgerAfter.length === 0
    && revenueAfter.length === 1 && revenue?.model_id === 'extract_video'
    && revenue?.task_id === walletKey && revenue?.record_type === 'extract'
    && Number(revenue?.cost_price) === 0 && Number(revenue?.selling_price) === 0
    && Number(revenue?.profit) === 0 && Number(revenue?.cash_charged || 0) === 0
    && Number(revenue?.credits_charged || 0) === 0
    ? 'passed' : ['running', 'failed_unknown', 'missing'].includes(evidence.persisted.state) ? 'unknown' : 'not-passed';
  evidence.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ state: evidence.state, extractionPostAttempts: 1, retries: 0, evidencePath }, null, 2));
  if (evidence.state !== 'passed') process.exitCode = 2;
}

main().catch(async error => {
  if (evidence && evidencePath) {
    evidence.state = evidence.extractionPostAttempts ? 'unknown' : 'blocked-before-extraction';
    evidence.failure = { code: error.code || 'ACCEPTANCE_ERROR', message: cleanMessage(error.message) };
    await save().catch(() => {});
  }
  console.error(JSON.stringify({ state: evidence?.state || 'blocked', code: error.code || 'ACCEPTANCE_ERROR', evidencePath: evidencePath || null }));
  process.exitCode = 2;
});
