import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:5000';
const evidence = '.codex-evidence/manju-secondary-20260902';
const groups = [
  ['home', '/youcai'], ['creation-directory', '/youcai/tools'], ['asset-history', '/youcai/assets'],
  ['skill-store', '/youcai/skills'], ['creative-agent', '/youcai/tools/text/text-chat'],
  ['film-projects', '/youcai/tools/film-studio'], ['general-script', '/youcai/tools/text/general-script'],
  ['drama-script', '/youcai/tools/text/drama-script'], ['upload-script', '/youcai/tools/text/upload-script'],
  ['canvas-examples', '/youcai/tools/canvas'], ['canvas-editor', '/youcai/free-canvas'],
  ['inspiration', '/youcai/inspiration'], ['tv', '/youcai/youcai-tv'],
  ['help', '/youcai/articles'], ['account', '/youcai/profile'],
  ['recharge', '/youcai/recharge'], ['referral', '/youcai/referral'],
  ['image-workbench', '/youcai/tools/image/image-chat'], ['video-workbench', '/youcai/video'],
  ['storyboard', '/youcai/storyboard-workbench'], ['voice-workbench', '/youcai/voice-studio/workspace'],
  ['local-video-editor', '/youcai/tools/video/video-edit'], ['admin', '/admin?tab=manju-workbench'],
];
const report = { observedAt: new Date().toISOString(), mode: 'read-only-local-browser', pages: [], blockedMutations: 0, blockedExternalReads: 0, blockedHealthProbes: 0 };
let browser;

async function main() {
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
  report.sessionSource = 'normal-login-token-from-process-environment';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(({ token }) => {
    localStorage.setItem('auth_token', token);
  }, { token });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) { report.blockedMutations += 1; return route.abort(); }
    if (/^https?:$/u.test(url.protocol) && url.origin !== base) { report.blockedExternalReads += 1; return route.abort(); }
    if (url.pathname === '/api/health' && !url.searchParams.has('logs') && !url.searchParams.has('liveness')) {
      report.blockedHealthProbes += 1; return route.abort();
    }
    return route.continue();
  });
  for (const [group, route] of groups) {
    // A fresh page prevents the previous route's delayed client navigation
    // from aborting this route during a long development compilation.
    const page = await context.newPage();
    const errors = [];
    const failures = [];
    const onError = (error) => errors.push(error.name || 'Error');
    const onResponse = (response) => {
      const url = new URL(response.url());
      if (url.origin === base && url.pathname.startsWith('/api/') && response.status() >= 400) failures.push({ path: url.pathname, status: response.status() });
    };
    page.on('pageerror', onError);
    page.on('response', onResponse);
    const started = Date.now();
    const item = { group, route };
    try {
      const response = await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      item.status = response?.status() || 0;
      await page.waitForLoadState('load', { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(500);
      Object.assign(item, await page.evaluate((origin) => {
        const text = document.body?.innerText || '';
        return {
          renderedTextLength: text.length, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
          fatalPage: /Application error|Unhandled Runtime Error|This page could not be found|ReferenceError:/iu.test(text),
          migrationNotice: /MIGRATION_NOT_READY|迁移尚未|等待数据库迁移/u.test(text),
          formControls: document.querySelectorAll('input,textarea,select').length,
          buttons: document.querySelectorAll('button').length,
          localBrokenImages: Array.from(document.images).filter((img) => {
            const url = new URL(img.currentSrc || img.src || origin, origin);
            return url.origin === origin && img.complete && img.naturalWidth === 0;
          }).length,
          navigationPaths: [...new Set(Array.from(document.querySelectorAll('a[href]')).map((a) => new URL(a.href, origin)).filter((url) => url.origin === origin && url.pathname.startsWith('/youcai')).map((url) => url.pathname))],
        };
      }, base));
    } catch (error) {
      item.errorType = error.name || 'Error';
      item.networkErrorCode = /net::(ERR_[A-Z_]+)/u.exec(error.message || '')?.[1] || null;
    }
    item.elapsedMs = Date.now() - started;
    item.pageErrorTypes = errors;
    item.failedApi = failures;
    report.pages.push(item);
    page.off('pageerror', onError);
    page.off('response', onResponse);
    await page.close();
    await mkdir(evidence, { recursive: true });
    await writeFile(`${evidence}/navigation-readonly.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ group, status: item.status, fatalPage: item.fatalPage, errors: errors.length, failedApi: failures, elapsedMs: item.elapsedMs }));
  }
  report.completed = true;
}

main().catch((error) => { report.completed = false; report.errorType = error.name || 'Error'; process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/navigation-readonly.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ completed: report.completed, pages: report.pages.length, blockedMutations: report.blockedMutations, blockedExternalReads: report.blockedExternalReads, blockedHealthProbes: report.blockedHealthProbes }));
});
