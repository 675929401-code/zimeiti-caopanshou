import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, readdir, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import pg from 'pg';

const base = process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000';
if (!['http://127.0.0.1:5000', 'http://127.0.0.1:5002'].includes(base)) throw new Error('LOCAL_PREVIEW_ORIGIN_REQUIRED');
const round = process.argv.find(value => value.startsWith('--round='))?.slice(8) || 'initial';
if (!['initial', 'title-afterfix', 'deterministic-text'].includes(round)) throw new Error('UNKNOWN_COVER_ROUND');
const directory = round === 'deterministic-text' ? '.codex-evidence/cover-deterministic-text-e2e-20260902' : round === 'title-afterfix' ? '.codex-evidence/cover-title-afterfix-e2e-20260902' : '.codex-evidence/cover-production-e2e-20260902';
const queue = `${directory}/commands`, results = `${directory}/results`;
const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
if (!runtime.localOnly || runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') throw new Error('LOCAL_DATABASE_REQUIRED');
await mkdir(queue, { recursive: true }); await mkdir(results, { recursive: true });
const manifest = existsSync(`${directory}/manifest.json`) ? JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8')) : {
  marker: round === 'deterministic-text' ? 'cover-e2e-layout-20260902-742c0da1' : round === 'title-afterfix' ? 'cover-e2e-titlefix-20260902-9c7fa12d' : 'cover-e2e-20260902-e2560a1c', expectedModelId: 'pm_7ZoWNH7zuZkVso7_OHgGzYfl', providerRequests: [], downloads: [],
};
const identity = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
manifest.previewOrigin = base;
const me = await identity.json();
if (!identity.ok || me.user?.role !== 'admin') throw new Error('NORMAL_ADMIN_LOGIN_REQUIRED');
const restoreCompleted = process.argv.includes('--restore-completed');
if (restoreCompleted && !['title-afterfix', 'deterministic-text'].includes(round)) throw new Error('COMPLETED_RECOVERY_ROUND_REQUIRED');
async function verifyKnownCompleted(key) {
  const db = new pg.Client(runtime.ownerConnection); await db.connect();
  try {
    const result = await db.query(`select record_id,state,delivery_state,delivery_asset_id,created_at,response
      from public.image_generation_requests where client_idempotency_key=$1 and client_trace_id=$1 and user_id=$2`, [key, me.user.id]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row.state !== 'completed' || row.delivery_state !== 'delivered' || !row.delivery_asset_id || !row.response) throw new Error('OWN_COMPLETED_DELIVERED_ONLY');
    return { recordId: row.record_id, state: row.state, deliveryState: row.delivery_state, assetId: row.delivery_asset_id,
      createdAt: row.created_at, responseHash: createHash('sha256').update(JSON.stringify(row.response)).digest('hex') };
  } finally { await db.end(); }
}
let restored = null;
if (restoreCompleted) {
  const originalStateFile = round === 'deterministic-text' ? '015-checkpoint-pending-local-state.json' : '013-original-titlefix-state.json';
  restored = JSON.parse(await readFile(`${results}/${originalStateFile}`, 'utf8')).result;
  const pending = restored?.state?.pending;
  const original = manifest.providerRequests[0];
  if (!pending || manifest.providerRequests.length !== 1 || pending.clientIdempotencyKey !== original.key || pending.clientTraceId !== original.key
    || createHash('sha256').update(JSON.stringify({ ...pending.payload, clientIdempotencyKey: pending.clientIdempotencyKey, clientTraceId: pending.clientTraceId })).digest('hex') !== original.bodyHash) throw new Error('ORIGINAL_PENDING_PAYLOAD_REQUIRED');
  await verifyKnownCompleted(original.key);
}
const privateStrings = [token, me.user?.username, me.user?.phone, me.user?.email, me.user?.display_name, me.user?.displayName].filter(x => typeof x === 'string' && x.length >= 3);
function redact(value) {
  for (const secret of privateStrings) value = value.replaceAll(secret, '[private]');
  return value.replace(/https?:\/\/[^\s"<>]+/gu, text => { try { const u = new URL(text); u.search = ''; u.hash = ''; return u.toString(); } catch { return '[url]'; } })
    .replace(/([?&](?:media_ticket|access_token|token|signature|sign|key)=)[^&\s"<>]*/giu, '$1[private]');
}
function sanitize(value, key = '') {
  if (/authorization|cookie|password|secret|api.?key|ticket|^token$/iu.test(key)) return '[private]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return value;
}
async function saveManifest() { await writeFile(`${directory}/manifest.json`, `${JSON.stringify(sanitize(manifest), null, 2)}\n`); }
async function journal(item) { await appendFile(`${directory}/network.jsonl`, `${JSON.stringify(sanitize({ observedAt: new Date().toISOString(), ...item }))}\n`); }
await saveManifest();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: base, viewport: { width: 1500, height: 1100 }, acceptDownloads: true, serviceWorkers: 'block' });
await context.addInitScript(({ token, user, restored }) => {
  localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user));
  if (restored && !localStorage.getItem(`cover-generation:v1:${user.id}`)) {
    localStorage.setItem(`cover-generation:v1:${user.id}`, JSON.stringify(restored.state));
    localStorage.setItem('ai-cover-director-draft-v4', JSON.stringify(restored.draft));
  }
}, { token, user: me.user, restored });
const page = await context.newPage();
let activeCommand = null, stopped = false;
page.on('dialog', async dialog => { await journal({ type: 'dialog', kind: dialog.type(), accepted: true }); await dialog.accept(); });
page.on('pageerror', error => { void journal({ type: 'pageerror', name: error.name, message: error.message }); });
page.on('requestfailed', request => {
  const target = new URL(request.url());
  if (target.origin === base) void journal({ type: 'requestfailed', path: target.pathname, method: request.method(), error: request.failure()?.errorText });
});
page.on('download', download => {
  void (async () => {
    const name = `cover-download-${manifest.downloads.length + 1}.bin`;
    await download.saveAs(`${directory}/${name}`);
    const size = (await stat(`${directory}/${name}`)).size;
    if (size > 50 * 1024 * 1024) throw new Error('DOWNLOAD_SIZE_LIMIT');
    const bytes = await readFile(`${directory}/${name}`), metadata = await sharp(bytes).metadata();
    const proof = { file: name, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'), width: metadata.width, height: metadata.height, format: metadata.format };
    manifest.downloads.push(proof); await saveManifest(); await journal({ type: 'download-completed', ...proof });
  })().catch(error => journal({ type: 'download-error', message: error.message }));
});
context.on('page', popup => { if (popup !== page) void journal({ type: 'popup-opened', url: popup.url() }); });
page.on('response', response => {
  if (!response.url().startsWith(`${base}/api/`)) return;
  void (async () => {
    const path = new URL(response.url()).pathname;
    const allowedData = ['/api/image/generate', '/api/image/status', '/api/image-workbench/persist', '/api/cover/render', '/api/cover-models', '/api/cash/balance'].includes(path);
    const data = allowedData ? await response.json().catch(() => null) : undefined;
    await journal({ type: 'response', commandId: activeCommand, path, status: response.status(), data });
  })().catch(() => {});
});
await context.route('**/*', async route => {
  const request = route.request();
  if (['GET', 'HEAD'].includes(request.method())) return route.continue();
  const target = new URL(request.url());
  if (target.origin !== base || !['/api/image/generate', '/api/image-workbench/persist', ...(round === 'deterministic-text' ? ['/api/cover/render'] : [])].includes(target.pathname)) {
    await journal({ type: 'blocked-mutation', path: target.pathname }); return route.abort();
  }
  let body; try { body = request.postDataJSON(); } catch { await journal({ type: 'blocked-non-json' }); return route.abort(); }
  const key = body?.clientIdempotencyKey || body?.clientTraceId;
  if (target.pathname === '/api/image/generate') {
    if (!activeCommand || typeof key !== 'string' || body?.modelId !== manifest.expectedModelId
      || !body.prompt?.includes(manifest.marker) || body.referenceImageUrls?.length || body.resolution !== '2K') {
      await journal({ type: 'blocked-generation-outside-canary', key, modelId: body.modelId }); return route.abort();
    }
    if (manifest.providerRequests.length) {
      const original = manifest.providerRequests[0];
      if (!restoreCompleted || manifest.recoveries?.length || original.key !== key || createHash('sha256').update(JSON.stringify(body)).digest('hex') !== original.bodyHash) {
        await journal({ type: 'blocked-replay-without-completed-proof', key }); return route.abort();
      }
      try {
        const before = await verifyKnownCompleted(key);
        manifest.recoveries = [{ key, before, requestedAt: new Date().toISOString(), commandId: activeCommand }];
        await journal({ type: 'completed-original-recovery-authorized', key, ...before });
      } catch {
        await journal({ type: 'blocked-recovery-not-completed', key }); return route.abort();
      }
    } else {
      manifest.providerRequests.push({ key, modelId: body.modelId, bodyHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), requestedAt: new Date().toISOString(), commandId: activeCommand });
    }
    await saveManifest();
  } else if (target.pathname === '/api/cover/render') {
    try {
      if (manifest.providerRequests.length !== 1 || (manifest.compositions?.length || 0) >= 2) throw new Error('ONE_INITIAL_ONE_EDIT_ONLY');
      const owned = await verifyKnownCompleted(manifest.providerRequests[0].key);
      if (body.sourceAssetId !== owned.assetId || !['小芽种薄荷', '小芽和薄荷'].includes(body.plan?.title)
        || !['每天一点绿意', '今天也有绿意'].includes(body.plan?.subtitle)) throw new Error('EXACT_OWNED_PLAN_REQUIRED');
      manifest.compositions ||= [];
      manifest.compositions.push({ sourceAssetId: owned.assetId, plan: body.plan, requestedAt: new Date().toISOString(), commandId: activeCommand });
      await saveManifest();
    } catch { await journal({ type: 'blocked-foreign-or-extra-render' }); return route.abort(); }
  } else if (!manifest.providerRequests.some(item => item.key === key)) {
    await journal({ type: 'blocked-foreign-persist', key }); return route.abort();
  }
  await journal({ type: 'request-before-dispatch', commandId: activeCommand, path: target.pathname, body });
  return route.continue();
});
function locator(command) {
  let found;
  if (command.by === 'role') found = page.getByRole(command.role || 'button', { name: command.selector, exact: command.exact ?? true });
  else if (command.by === 'label') found = page.getByLabel(command.selector, { exact: command.exact ?? true });
  else if (command.by === 'placeholder') found = page.getByPlaceholder(command.selector, { exact: command.exact ?? true });
  else found = page.locator(command.selector);
  return command.nth === undefined ? found : found.nth(command.nth);
}
async function inspect() {
  return sanitize(await page.evaluate(() => ({
    path: location.pathname, title: document.title, text: document.body.innerText.slice(0, 18000),
    controls: Array.from(document.querySelectorAll('input,textarea,select,button,a[href]')).map((el, index) => ({ index, tag: el.tagName, type: el.getAttribute('type'), id: el.id, text: el.innerText?.trim().slice(0, 130), placeholder: el.getAttribute('placeholder'), ariaLabel: el.getAttribute('aria-label'), disabled: el.disabled,
      value: ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? el.value : undefined,
      href: el.tagName === 'A' ? el.getAttribute('href') : undefined,
      options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => ({ value: o.value, text: o.text, disabled: o.disabled })) : undefined,
    })),
    performance: { navigation: performance.getEntriesByType('navigation').map(n => ({ domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd, transferSize: n.transferSize })), imageRequests: performance.getEntriesByType('resource').filter(r => r.initiatorType === 'img').length, scripts: performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script').length },
    images: Array.from(document.images).map(i => ({ alt: i.alt, loading: i.loading, complete: i.complete, width: i.naturalWidth, height: i.naturalHeight })),
    overflow: document.documentElement.scrollWidth > innerWidth,
  })));
}
async function execute(command) {
  switch (command.action) {
    case 'goto': {
      const target = new URL(command.path, base);
      if (target.origin !== base || !['/cover', '/youcai/cover', '/youcai', '/tools', '/youcai/articles'].includes(target.pathname)) throw new Error('LOCAL_ALLOWED_NAVIGATION_ONLY');
      await page.goto(target.toString(), { waitUntil: 'load', timeout: 60_000 }); await page.waitForTimeout(1500); return inspect();
    }
    case 'inspect': return inspect();
    case 'fill': await locator(command).fill(command.value, { timeout: 15_000 }); return { filled: true };
    case 'click': await locator(command).click({ timeout: 15_000 }); await page.waitForTimeout(800); return inspect();
    case 'select': await locator(command).selectOption(command.value, { timeout: 15_000 }); return { selected: true };
    case 'wait': await page.waitForTimeout(Math.min(5000, Math.max(0, command.ms || 1000))); return inspect();
    case 'localState': return sanitize(await page.evaluate(userId => {
      const state = JSON.parse(localStorage.getItem(`cover-generation:v1:${userId}`) || 'null');
      const draft = JSON.parse(localStorage.getItem('ai-cover-director-draft-v4') || 'null');
      return { state, draft };
    }, me.user.id));
    case 'screenshot': { const file = `${command.id}.png`; await page.locator(command.selector || '.cover-rebuild-shell').screenshot({ path: `${directory}/${file}` }); return { file }; }
    case 'stop': stopped = true; return { stopped: true };
    default: throw new Error('UNKNOWN_CONTROL_ACTION');
  }
}
await writeFile(`${directory}/runner-ready.json`, JSON.stringify({ ready: true, normalAdmin: true, pid: process.pid, marker: manifest.marker, previewOrigin: base }));
console.log(JSON.stringify({ ready: true, normalAdmin: true, pid: process.pid, marker: manifest.marker, previewOrigin: base }));
try {
  while (!stopped) {
    for (const file of (await readdir(queue)).filter(name => /^\d{3}-[a-z0-9-]+\.json$/u.test(name)).sort()) {
      const id = file.slice(0, -5);
      if (existsSync(`${results}/${id}.started.json`)) continue;
      let command; try { command = JSON.parse(await readFile(`${queue}/${file}`, 'utf8')); } catch { continue; }
      command.id = id; activeCommand = id;
      await writeFile(`${results}/${id}.started.json`, JSON.stringify({ startedAt: new Date().toISOString(), action: command.action }));
      try { await writeFile(`${results}/${id}.json`, JSON.stringify({ ok: true, result: await execute(command) }, null, 2)); }
      catch (error) { await writeFile(`${results}/${id}.json`, JSON.stringify({ ok: false, errorType: error.name, message: redact(error.message) }, null, 2)); }
      activeCommand = null; if (stopped) break;
    }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 250));
  }
} finally { await browser.close(); }
