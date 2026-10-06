import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const base = 'http://127.0.0.1:5000';
const directory = '.codex-evidence/manju-production-e2e-20260902';
const queue = `${directory}/commands`;
const results = `${directory}/results`;
const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
const runtime = JSON.parse(await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8'));
if (!runtime.localOnly || runtime.ownerConnection.host !== '127.0.0.1' || runtime.ownerConnection.port !== 54322 || runtime.ownerConnection.database !== 'zimeiti_local') throw new Error('LOCAL_DATABASE_REQUIRED');
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
const identity = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
const me = await identity.json();
if (!identity.ok || me.user?.role !== 'admin') throw new Error('NORMAL_ADMIN_LOGIN_REQUIRED');
const privateStrings = [token, me.user?.username, me.user?.phone, me.user?.email, me.user?.display_name, me.user?.displayName].filter(x => typeof x === 'string' && x.length >= 3);
function redactString(value) {
  let text = value;
  for (const secret of privateStrings) text = text.replaceAll(secret, '[private]');
  return text.replace(/https?:\/\/[^\s"<>]+/gu, value => { try { const u = new URL(value); u.search = ''; u.hash = ''; return u.toString(); } catch { return '[url]'; } })
    .replace(/([?&](?:media_ticket|access_token|token|signature|sign|key)=)[^&\s"<>]*/giu, '$1[private]');
}
function sanitize(value, key = '') {
  if (/authorization|cookie|password|secret|api.?key|ticket|^token$/iu.test(key)) return '[private]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return value;
}
async function persistManifest() { await writeFile(`${directory}/manifest.json`, `${JSON.stringify(sanitize(manifest), null, 2)}\n`); }
async function journal(item) { await appendFile(`${directory}/network.jsonl`, `${JSON.stringify(sanitize({ observedAt: new Date().toISOString(), ...item }))}\n`); }
await mkdir(queue, { recursive: true }); await mkdir(results, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: base, viewport: { width: 1500, height: 1100 }, acceptDownloads: true, serviceWorkers: 'block' });
await context.addInitScript(({ token, user }) => {
  localStorage.setItem('auth_token', token);
  localStorage.setItem('auth_user', JSON.stringify(user));
}, { token, user: me.user });
const page = await context.newPage();
let activeCommand = null;
let stopped = false;
const seenKeys = new Set(manifest.providerRequests.map(item => item.requestKey));
page.on('dialog', async dialog => { await journal({ type: 'dialog', kind: dialog.type(), accepted: true }); await dialog.accept(); });
page.on('pageerror', error => { void journal({ type: 'pageerror', name: error.name, message: error.message }); });
page.on('response', response => {
  if (!response.url().startsWith(base + '/api/short-drama/')) return;
  void (async () => {
    const path = new URL(response.url()).pathname;
    const data = await response.json().catch(() => null);
    if (path === '/api/short-drama/projects/import-script' && response.ok() && data?.project?.id) {
      manifest.projectId = data.project.id; await persistManifest();
    }
    const request = response.request();
    let requestKey;
    try { requestKey = request.postDataJSON()?.clientRequestId || request.headers()['idempotency-key']; } catch { /* GET has no submission identity. */ }
    await journal({ type: 'response', commandId: activeCommand, requestKey, path, status: response.status(), data });
  })().catch(() => {});
});
await context.route('**/*', async route => {
  const request = route.request();
  if (['GET', 'HEAD'].includes(request.method())) return route.continue();
  const target = new URL(request.url());
  if (target.origin !== base || !target.pathname.startsWith('/api/short-drama/')) {
    await journal({ type: 'blocked-mutation', path: target.pathname }); return route.abort();
  }
  let body; try { body = request.postDataJSON(); } catch { await journal({ type: 'blocked-non-json' }); return route.abort(); }
  const projectMatch = /^\/api\/short-drama\/projects\/([^/]+)(?:\/|$)/u.exec(target.pathname);
  if (projectMatch && projectMatch[1] !== 'import-script' && projectMatch[1] !== manifest.projectId) {
    await journal({ type: 'blocked-other-project', path: target.pathname }); return route.abort();
  }
  const paid = target.pathname === '/api/short-drama/script' || target.pathname === '/api/short-drama/drama-script'
    || target.pathname.endsWith('/upload-script/standardize') || ['generate_image', 'generate_video'].includes(body?.action);
  const requestKey = body?.clientRequestId || request.headers()['idempotency-key'];
  if (paid) {
    if (!activeCommand || typeof requestKey !== 'string' || seenKeys.has(requestKey)) {
      await journal({ type: 'blocked-duplicate-or-untracked-paid', path: target.pathname, requestKey }); return route.abort();
    }
    const kind = body?.action || 'script';
    if (manifest.providerRequests.filter(item => item.kind === kind).length >= 2) {
      await journal({ type: 'blocked-paid-budget', kind }); return route.abort();
    }
    seenKeys.add(requestKey);
    manifest.providerRequests.push({ requestKey, kind, bodyHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), requestedAt: new Date().toISOString(), commandId: activeCommand });
    await persistManifest();
  }
  await journal({ type: 'request-before-dispatch', commandId: activeCommand, method: request.method(), path: target.pathname, requestKey, body });
  return route.continue();
});
function locator(command) {
  let found;
  if (command.by === 'role') found = page.getByRole(command.role || 'button', { name: command.selector, exact: command.exact ?? true });
  else if (command.by === 'label') found = page.getByLabel(command.selector, { exact: command.exact ?? true });
  else if (command.by === 'placeholder') found = page.getByPlaceholder(command.selector, { exact: command.exact ?? true });
  else if (command.by === 'testId') found = page.getByTestId(command.selector);
  else found = page.locator(command.selector);
  return command.nth === undefined ? found : found.nth(command.nth);
}
async function inspect() {
  const url = new URL(page.url());
  return sanitize(await page.evaluate(({ path, includeText }) => ({ path,
    title: document.title,
    bodyText: includeText ? document.body.innerText.slice(0, 18000) : undefined,
    controls: [...document.querySelectorAll('input,textarea,select,button')].filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height).map((e, index) => ({
      index, tag: e.tagName, type: e.type, id: e.id, name: e.name, testId: e.getAttribute('data-testid'),
      text: e.tagName === 'BUTTON' ? e.innerText.slice(0, 150) : undefined, placeholder: e.getAttribute('placeholder'), ariaLabel: e.getAttribute('aria-label'), disabled: e.disabled,
      options: e.tagName === 'SELECT' ? [...e.options].map(o => ({value:o.value,text:o.text,disabled:o.disabled})) : undefined,
    })),
  }), { path: url.pathname, includeText: url.pathname !== '/youcai/tools/film-studio' }));
}
async function execute(command) {
  switch (command.action) {
    case 'goto': {
      const target = new URL(command.path, base);
      if (target.origin !== base || !target.pathname.startsWith('/youcai/')) throw new Error('LOCAL_MANJU_NAVIGATION_ONLY');
      await page.goto(target.toString(), {waitUntil:'load',timeout:60_000}); await page.waitForTimeout(1200); return inspect();
    }
    case 'inspect': return inspect();
    case 'fill': await locator(command).fill(command.value, {timeout:15_000}); return {filled:true};
    case 'click': await locator(command).click({timeout:15_000}); await page.waitForTimeout(800); return inspect();
    case 'select': await locator(command).selectOption(command.value, {timeout:15_000}); return {selected:true};
    case 'wait': await page.waitForTimeout(Math.min(5000, Math.max(0, command.ms || 1000))); return inspect();
    case 'apiGet': {
      const target = new URL(command.path, base);
      if (target.origin !== base || (!target.pathname.startsWith(`/api/short-drama/projects/${manifest.projectId}`) && !['/api/short-drama/health','/api/user/assets'].includes(target.pathname))) throw new Error('OWN_PROJECT_READ_ONLY');
      const response = await context.request.get(target.toString(), {headers:{authorization:`Bearer ${token}`},timeout:30_000});
      return {status:response.status(),data:sanitize(await response.json())};
    }
    case 'recoverScript': {
      if(manifest.projectId)throw new Error('PROJECT_ALREADY_IMPORTED');
      const requestKey='general-script-f38d98ce-c79d-425f-8043-e186e39e8ec3';
      const events=(await readFile(`${directory}/network.jsonl`,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      const source=events.find(item=>item.type==='request-before-dispatch'&&item.path==='/api/short-drama/script'&&item.requestKey===requestKey);
      const recorded=manifest.providerRequests.find(item=>item.requestKey===requestKey);
      if(!source||!recorded||createHash('sha256').update(JSON.stringify(source.body)).digest('hex')!==recorded.bodyHash)throw new Error('ORIGINAL_REQUEST_REQUIRED');
      const db=new pg.Client(runtime.ownerConnection);await db.connect();
      try {
        const before=await db.query('select state,http_status,attempt_no,provider_call_started_at from public.llm_request_attempts where client_request_id=$1',[requestKey]);
        if(before.rows.length!==1||before.rows[0].state!=='succeeded'||before.rows[0].http_status!==200||before.rows[0].attempt_no!==1)throw new Error('KNOWN_COMPLETED_ATTEMPT_ONLY');
        await journal({type:'known-completed-script-recovery',requestKey,attemptNo:1});
        const response=await context.request.post(`${base}/api/short-drama/script`,{headers:{authorization:`Bearer ${token}`,'idempotency-key':requestKey},data:source.body,timeout:30_000});
        const payload=await response.json();
        if(!response.ok()||payload.ok!==true||payload.executionMode!=='real')throw new Error(`RECOVERY_REJECTED_${payload.code||response.status()}`);
        const after=await db.query('select state,http_status,attempt_no,provider_call_started_at from public.llm_request_attempts where client_request_id=$1',[requestKey]);
        if(JSON.stringify(before.rows)!==JSON.stringify(after.rows))throw new Error('RECOVERY_ATTEMPT_CHANGED');
        const imported=await context.request.post(`${base}/api/short-drama/projects/import-script`,{headers:{authorization:`Bearer ${token}`},data:{title:payload.result.summary.title,clientRequestId:requestKey,result:payload.result},timeout:30_000});
        const data=await imported.json();if(!imported.ok()||!data.project?.id)throw new Error(`IMPORT_REJECTED_${data.code||imported.status()}`);
        manifest.projectId=data.project.id;await persistManifest();
        await journal({type:'known-completed-script-recovery-result',requestKey,projectId:manifest.projectId,upstreamAttemptUnchanged:true});
        return {projectId:manifest.projectId,upstreamAttemptUnchanged:true,script:payload.result,imported:sanitize(data)};
      } finally {await db.end();}
    }
    case 'screenshot': {
      const target = command.selector ? page.locator(command.selector) : page.locator('main').first();
      const name = `${command.id}.png`; await target.screenshot({path:`${directory}/${name}`}); return {file:name};
    }
    case 'media': return page.locator('video').evaluateAll(items => items.map(video => ({readyState:video.readyState,duration:video.duration,videoWidth:video.videoWidth,videoHeight:video.videoHeight,errorCode:video.error?.code||null})));
    case 'stop': stopped = true; return {stopped:true};
    default: throw new Error('UNKNOWN_CONTROL_ACTION');
  }
}
await writeFile(`${directory}/runner-ready.json`, JSON.stringify({ready:true,normalAdmin:true,pid:process.pid,marker:manifest.marker}));
console.log(JSON.stringify({ready:true,normalAdmin:true,pid:process.pid,marker:manifest.marker}));
try {
  while (!stopped) {
    for (const file of (await readdir(queue)).filter(name => /^\d{3}-[a-z0-9-]+\.json$/u.test(name)).sort()) {
      const id = file.slice(0,-5);
      if (existsSync(`${results}/${id}.started.json`)) continue;
      let command; try { command = JSON.parse(await readFile(`${queue}/${file}`, 'utf8')); } catch { continue; }
      command.id = id; activeCommand = id;
      await writeFile(`${results}/${id}.started.json`, JSON.stringify({startedAt:new Date().toISOString(),action:command.action}));
      try { await writeFile(`${results}/${id}.json`, JSON.stringify({ok:true,result:await execute(command)},null,2)); }
      catch(error) { await writeFile(`${results}/${id}.json`, JSON.stringify({ok:false,errorType:error.name,message:redactString(error.message)},null,2)); }
      activeCommand = null;
      if(stopped) break;
    }
    if(!stopped) await new Promise(resolve=>setTimeout(resolve,250));
  }
} finally { await browser.close(); }
