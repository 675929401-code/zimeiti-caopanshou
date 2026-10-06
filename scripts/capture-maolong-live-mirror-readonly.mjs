import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, request as playwrightRequest } from 'playwright';

const ORIGIN = 'https://maolong.da-ai.cc';
const STATIC_HOSTS = new Set(['maolong.da-ai.cc', 'daai-static.da-ai.vip']);
const PROJECT_ROOT = process.cwd();
const SESSION_FILE = 'F:/总项目文件/Skill存储系统/01_网页开发项目/带货Agent/runtime/maolong-auth-session.json';
const DEFAULT_FINAL_ROOT = 'F:/总项目文件/Skill存储系统/01_网页开发项目/应用仓库/08_隔离运行/maolong-live-mirror-20260925';
const FINAL_ROOT = process.env.MAOLONG_CAPTURE_ROOT || DEFAULT_FINAL_ROOT;
const STAGING_ROOT = `${FINAL_ROOT}.staging-${process.pid}-${Date.now()}`;
const BODY_LIMIT = 50 * 1024 * 1024;
const NETWORK_PROXY = process.env.MAOLONG_CAPTURE_PROXY || 'http://127.0.0.1:7897';
const PAGE_TIMEOUT_MS = Number(process.env.MAOLONG_CAPTURE_PAGE_TIMEOUT_MS || 12_000);
const DISCOVERED_PAGE_TIMEOUT_MS = Number(process.env.MAOLONG_CAPTURE_DISCOVERED_TIMEOUT_MS || 10_000);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

const defaultSeedRoutes = [
  '/', '/agent-chat', '/canvas', '/privacy', '/terms',
  '/toolbox', '/toolbox/image-generation', '/toolbox/video-generation', '/toolbox/depth-video-clone',
  '/toolbox/ecommerce-image-set', '/toolbox/video-quality-enhance',
  '/toolbox/video-subtitle-erase', '/toolbox/video-watermark-remove',
  '/toolbox/digital-human', '/toolbox/hot-video-remix',
  '/account', '/account/api-keys', '/account/invoices', '/assets', '/assets/generated',
  '/affiliate', '/affiliate/dashboard', '/affiliate/performance', '/affiliate/referred-users',
  '/affiliate/recharge-orders', '/affiliate/recharge-cards', '/affiliate/direct-partners',
  '/affiliate/commissions', '/affiliate/settlements', '/affiliate/profile',
  '/affiliate/apply', '/affiliate/status', '/register',
  '/admin', '/admin/affiliate', '/admin/affiliate/partners', '/admin/assets', '/admin/audit',
  '/admin/affiliate/configurations', '/admin/affiliate/configurations/new', '/admin/affiliate/commission-ledger',
  '/admin/affiliate/referred-users', '/admin/affiliate/settings', '/admin/affiliate/settlements',
  '/admin/batches', '/admin/character-member-uploads', '/admin/credit-topup-packages',
  '/admin/credits/accounts', '/admin/discover', '/admin/invite-codes', '/admin/invoices',
  '/admin/kyc-asset-groups', '/admin/operation-notices', '/admin/payments',
  '/admin/recharge-cards', '/admin/recharge-packages', '/admin/skill-packages',
  '/admin/task-reports', '/admin/user-growth', '/admin/users', '/admin/video-creator-skills',
];
const requestedSeedRoutes=process.env.MAOLONG_CAPTURE_ROUTES_JSON
  ? JSON.parse(process.env.MAOLONG_CAPTURE_ROUTES_JSON)
  : defaultSeedRoutes;
if(!Array.isArray(requestedSeedRoutes)||!requestedSeedRoutes.length||requestedSeedRoutes.some(route=>typeof route!=='string'||!route.startsWith('/')||route.startsWith('/api/')||route.startsWith('/_next/')))throw Error('MAOLONG_CAPTURE_ROUTES_JSON contains an invalid page route');
const seedRoutes=[...new Set(requestedSeedRoutes)];

function safeUrl(raw) {
  const url = new URL(raw);
  const queryHash = url.search ? `--q-${sha256(url.search).slice(0, 12)}` : '';
  const clean = decodeURIComponent(url.pathname)
    .replace(/^\/+/, '')
    .replace(/[<>:"|?*\u0000-\u001f]/gu, '_')
    .replace(/\.{2,}/gu, '_') || 'index';
  return { url, relative: path.join('responses', url.host, `${clean}${queryHash}`) };
}

function redactString(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [REDACTED_TOKEN]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, '[REDACTED_PHONE]')
    .replace(/([?&](?:token|signature|x-tos-[^=]+)=)[^&\s"']+/giu, '$1[REDACTED]');
}

function sanitize(value, key = '') {
  if (/token|password|secret|authorization|cookie/iu.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]),
  );
  return value;
}

async function writeAtomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: 'wx' });
  await fs.rename(temporary, file);
}

async function rotateSession() {
  const previous = JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
  if (typeof previous.refreshToken !== 'string' || !previous.refreshToken) throw Error('授权会话缺少 refreshToken');
  const client = await playwrightRequest.newContext({ baseURL: ORIGIN, proxy: { server: NETWORK_PROXY } });
  const response = await client.post('/api/v1/auth/refresh', {
    data: { refresh_token: previous.refreshToken },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30_000,
  });
  const body = await response.json().catch(() => ({}));
  await client.dispose();
  if (!response.ok() || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw Error(`授权会话刷新失败（HTTP ${response.status()}）`);
  }
  const next = {
    capturedAt: now(),
    origin: ORIGIN,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    source: 'server-refresh-endpoint',
  };
  await writeAtomic(SESSION_FILE, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
  return { ...next, user: body.user || null };
}

if (await fs.stat(FINAL_ROOT).then(() => true, () => false)) throw Error(`目标已存在，拒绝覆盖：${FINAL_ROOT}`);
await fs.mkdir(STAGING_ROOT, { recursive: false });
await writeAtomic(path.join(STAGING_ROOT, 'INCOMPLETE.json'), Buffer.from(`${JSON.stringify({ startedAt: now(), source: ORIGIN }, null, 2)}\n`));

const session = await rotateSession();
const records = [];
const recordKeys = new Set();
const pendingWrites = new Set();
const blockedWrites = [];
const pageResults = [];
const discoveredRoutes = new Set(seedRoutes);

async function captureResponse(response) {
  const request = response.request();
  if (!['GET', 'HEAD'].includes(request.method())) return;
  let parsed;
  try { parsed = safeUrl(response.url()); } catch { return; }
  if (!STATIC_HOSTS.has(parsed.url.host)) return;
  const contentType = (response.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
  const key = `${request.method()} ${parsed.url.href}`;
  if (recordKeys.has(key)) return;
  recordKeys.add(key);
  const item = {
    method: request.method(),
    url: `${parsed.url.origin}${parsed.url.pathname}${parsed.url.search ? `?sha256=${sha256(parsed.url.search)}` : ''}`,
    resourceType: request.resourceType(),
    status: response.status(),
    contentType,
    fetchedAt: now(),
    savedPath: null,
    bytes: 0,
    sha256: null,
    sanitized: false,
    error: null,
  };
  records.push(item);
  try {
    const length = Number(response.headers()['content-length'] || 0);
    if (length > BODY_LIMIT) throw Error(`body exceeds ${BODY_LIMIT} bytes`);
    let bytes = await response.body();
    if (bytes.length > BODY_LIMIT) throw Error(`body exceeds ${BODY_LIMIT} bytes`);
    if (/json/iu.test(contentType)) {
      const json = JSON.parse(bytes.toString('utf8'));
      bytes = Buffer.from(`${JSON.stringify(sanitize(json), null, 2)}\n`);
      item.sanitized = true;
    } else if (/^(?:text\/|application\/(?:javascript|x-javascript)|image\/svg\+xml)/iu.test(contentType)) {
      bytes = Buffer.from(redactString(bytes.toString('utf8')));
    }
    const extension = /json/iu.test(contentType) ? '.json'
      : /html/iu.test(contentType) ? '.html'
        : /css/iu.test(contentType) ? '.css'
          : /javascript/iu.test(contentType) ? '.js' : '';
    const targetExtension = extension && parsed.relative.toLowerCase().endsWith(extension) ? '' : extension;
    const target = path.join(STAGING_ROOT, `${parsed.relative}${targetExtension}`);
    await writeAtomic(target, bytes);
    item.savedPath = path.relative(STAGING_ROOT, target).replaceAll('\\', '/');
    item.bytes = bytes.length;
    item.sha256 = sha256(bytes);
  } catch (error) {
    item.error = String(error?.message || error).slice(0, 300);
  }
}

const browser = await chromium.launch({ headless: true, proxy: { server: NETWORK_PROXY } });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
await context.addInitScript(auth => {
  if (location.origin === 'https://maolong.da-ai.cc') localStorage.setItem('genify_auth_session', JSON.stringify(auth));
}, { user: session.user, accessToken: session.accessToken, refreshToken: session.refreshToken });
await context.route('**/*', async route => {
  const request = route.request();
  const method = request.method().toUpperCase();
  const url = new URL(request.url());
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
  if (url.origin === ORIGIN && url.pathname === '/api/v1/auth/refresh') return route.continue();
  blockedWrites.push({ method, origin: url.origin, path: url.pathname, resourceType: request.resourceType() });
  return route.abort('blockedbyclient');
});
context.on('response', response => {
  const task = captureResponse(response).finally(() => pendingWrites.delete(task));
  pendingWrites.add(task);
});

const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(redactString(message.text()).slice(0, 500)); });
page.on('pageerror', error => pageErrors.push(redactString(error.message).slice(0, 500)));

for (const route of [...discoveredRoutes]) {
  const startedAt = now();
  console.error(JSON.stringify({ progress: 'seed-route', route, startedAt }));
  try {
    const response = await page.goto(`${ORIGIN}${route}`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(1_200);
    const finalUrl = page.url();
    const title = await page.title();
    const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')).filter(Boolean));
    for (const href of links) {
      try {
        const url = new URL(href, ORIGIN);
        if (url.origin === ORIGIN && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/_next/')) discoveredRoutes.add(url.pathname);
      } catch {}
    }
    pageResults.push({ route, startedAt, status: response?.status() ?? null, finalPath: new URL(finalUrl).pathname, title: redactString(title) });
  } catch (error) {
    pageResults.push({ route, startedAt, status: null, finalPath: null, error: String(error?.message || error).slice(0, 500) });
  }
}

for (const route of [...discoveredRoutes].filter(route => !seedRoutes.includes(route)).slice(0, 100)) {
  console.error(JSON.stringify({ progress: 'discovered-route', route, startedAt: now() }));
  try {
    const response = await page.goto(`${ORIGIN}${route}`, { waitUntil: 'domcontentloaded', timeout: DISCOVERED_PAGE_TIMEOUT_MS });
    await page.waitForTimeout(500);
    pageResults.push({ route, startedAt: now(), status: response?.status() ?? null, finalPath: new URL(page.url()).pathname, title: redactString(await page.title()) });
  } catch (error) {
    pageResults.push({ route, startedAt: now(), status: null, finalPath: null, error: String(error?.message || error).slice(0, 500) });
  }
}

await Promise.allSettled([...pendingWrites]);
await browser.close();

// CDP occasionally evicts a successfully loaded script body before
// response.body() runs. Retry only public script/stylesheet GETs directly;
// never retry API/data responses or any business method.
const retryClient=await playwrightRequest.newContext({proxy:{server:NETWORK_PROXY}});
try{
  for(const item of records.filter(value=>value.status===200&&!value.savedPath&&['script','stylesheet'].includes(value.resourceType)&&!value.url.includes('?'))){
    const response=await retryClient.get(item.url,{timeout:30_000});
    if(!response.ok())continue;
    const contentType=(response.headers()['content-type']||'').split(';')[0].trim().toLowerCase();
    if(!/javascript|css/iu.test(contentType))continue;
    let bytes=await response.body();
    if(bytes.length>BODY_LIMIT)continue;
    bytes=Buffer.from(redactString(bytes.toString('utf8')));
    const parsed=safeUrl(item.url);
    const extension=/css/iu.test(contentType)?'.css':'.js';
    const targetExtension=parsed.relative.toLowerCase().endsWith(extension)?'':extension;
    const target=path.join(STAGING_ROOT,`${parsed.relative}${targetExtension}`);
    await writeAtomic(target,bytes);
    item.contentType=contentType;
    item.savedPath=path.relative(STAGING_ROOT,target).replaceAll('\\','/');
    item.bytes=bytes.length;
    item.sha256=sha256(bytes);
    item.sanitized=false;
    item.error=null;
    item.directBodyRetry=true;
  }
  const collectFiles=async directory=>{
    const found=[];
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const child=path.join(directory,entry.name);
      if(entry.isDirectory())found.push(...await collectFiles(child));else found.push(child);
    }
    return found;
  };
  const savedFiles=await collectFiles(STAGING_ROOT);
  const runtimeMappings=new Map();
  for(const file of savedFiles.filter(value=>/^webpack-.*\.js$/iu.test(path.basename(value)))){
    const text=await fs.readFile(file,'utf8');
    for(const match of text.matchAll(/(?:^|[,({])(\d+):"([a-f0-9]{16})"/gu))runtimeMappings.set(match[1],match[2]);
  }
  for(const [chunkId,hash] of runtimeMappings){
    const url=`https://daai-static.da-ai.vip/_next/static/chunks/${chunkId}.${hash}.js`;
    const parsed=safeUrl(url),target=path.join(STAGING_ROOT,parsed.relative);
    if(await fs.stat(target).then(()=>true,()=>false))continue;
    const response=await retryClient.get(url,{timeout:30_000});
    if(!response.ok())throw Error(`webpack lazy chunk ${chunkId} returned HTTP ${response.status()}`);
    const contentType=(response.headers()['content-type']||'').split(';')[0].trim().toLowerCase();
    if(!/javascript/iu.test(contentType))throw Error(`webpack lazy chunk ${chunkId} returned ${contentType||'unknown content type'}`);
    let bytes=await response.body();
    if(!bytes.length||bytes.length>BODY_LIMIT)throw Error(`webpack lazy chunk ${chunkId} has invalid size ${bytes.length}`);
    bytes=Buffer.from(redactString(bytes.toString('utf8')));
    await writeAtomic(target,bytes);
    records.push({method:'GET',url,resourceType:'script',status:response.status(),contentType,fetchedAt:now(),savedPath:path.relative(STAGING_ROOT,target).replaceAll('\\','/'),bytes:bytes.length,sha256:sha256(bytes),sanitized:false,error:null,runtimeClosure:true});
    recordKeys.add(`GET ${url}`);
  }
}finally{await retryClient.dispose();}

records.sort((left, right) => left.url.localeCompare(right.url) || left.resourceType.localeCompare(right.resourceType));
pageResults.sort((left, right) => left.route.localeCompare(right.route));
const saved = records.filter(item => item.savedPath && item.sha256);
const manifest = {
  schemaVersion: 1,
  kind: 'authorized-readonly-live-client-mirror',
  origin: ORIGIN,
  capturedAt: now(),
  access: {
    normalAuthorizedSession: true,
    authenticationRefreshCount: 1,
    businessWriteRequestsAllowed: 0,
    businessWriteRequestsBlocked: blockedWrites.length,
    adminRoutesRequested: pageResults.filter(item => item.route.startsWith('/admin')).length,
    adminRoutesVisible: pageResults.filter(item => item.route.startsWith('/admin') && item.finalPath?.startsWith('/admin')).length,
  },
  scopeBoundary: '浏览器可见客户端、静态资源和正常 GET 响应；不包含不可公开下载的服务端实现源码。',
  pageCount: pageResults.length,
  responseCount: records.length,
  savedFileCount: saved.length,
  savedBytes: saved.reduce((sum, item) => sum + item.bytes, 0),
  blockedWrites,
  consoleErrors: [...new Set(consoleErrors)].slice(0, 200),
  pageErrors: [...new Set(pageErrors)].slice(0, 200),
  pages: pageResults,
  responses: records,
};
await writeAtomic(path.join(STAGING_ROOT, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
const manifestBytes = await fs.readFile(path.join(STAGING_ROOT, 'manifest.json'));
await writeAtomic(path.join(STAGING_ROOT, 'receipt.json'), Buffer.from(`${JSON.stringify({
  capturedAt: manifest.capturedAt,
  manifestSha256: sha256(manifestBytes),
  savedFileCount: manifest.savedFileCount,
  savedBytes: manifest.savedBytes,
  pageCount: manifest.pageCount,
  responseCount: manifest.responseCount,
  businessWriteRequestsAllowed: 0,
  businessWriteRequestsBlocked: blockedWrites.length,
}, null, 2)}\n`));
await fs.rm(path.join(STAGING_ROOT, 'INCOMPLETE.json'));
await fs.rename(STAGING_ROOT, FINAL_ROOT);
console.log(JSON.stringify({ ok: true, output: FINAL_ROOT, manifestSha256: sha256(manifestBytes), ...manifest.access, savedFileCount: manifest.savedFileCount, savedBytes: manifest.savedBytes }, null, 2));
