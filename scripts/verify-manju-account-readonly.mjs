import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

const base = 'http://127.0.0.1:5000';
const report = { observedAt: new Date().toISOString(), sessionSource: 'normal-login-token-from-process-environment',
  mode: 'read-only-account-and-two-controls', pages: [], blockedMutations: 0, blockedExternalReads: 0 };
let browser;

function safeError(error) {
  const message = error.message || '';
  let diagnostic = message === 'NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED' ? 'NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED' : 'unclassified';
  for (const [expression, code] of [
    [/Unexpected end of (?:JSON )?input/iu, 'unexpected_end'],
    [/Unexpected token/iu, 'unexpected_token'],
    [/Invalid or unexpected token/iu, 'invalid_token'],
    [/JSON\.parse|not valid JSON/iu, 'json_parse'],
    [/Identifier .+ has already been declared/iu, 'duplicate_identifier'],
    [/Cannot use import statement outside a module/iu, 'module_script'],
    [/ChunkLoadError|Loading chunk/iu, 'chunk_load'],
  ]) if (expression.test(message)) { diagnostic = code; break; }
  const sourcePaths = [...new Set([...(error.stack || '').matchAll(/http:\/\/127\.0\.0\.1:5000(\/[^\s?)]+)(?:\?[^\s)]*)?/gu)].map((match) => match[1]))];
  return { name: error.name || 'Error', diagnostic, sourcePaths };
}

async function main() {
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  if (!token) throw new Error('NORMAL_ADMIN_LOGIN_TOKEN_REQUIRED');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(({ token }) => localStorage.setItem('auth_token', token), { token });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) { report.blockedMutations += 1; return route.abort(); }
    if (/^https?:/u.test(request.url()) && new URL(request.url()).origin !== base) { report.blockedExternalReads += 1; return route.abort(); }
    return route.continue();
  });
  for (const route of ['/youcai/profile', '/youcai/assets']) {
    const page = await context.newPage();
    const item = { route, pageErrors: [], apiResponses: [], failedScripts: [], parsedScripts: 0 };
    const scripts = [];
    page.on('pageerror', (error) => item.pageErrors.push(safeError(error)));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin !== base) return;
      if (url.pathname.startsWith('/api/')) item.apiResponses.push({ path: url.pathname, status: response.status() });
      if (response.request().resourceType() !== 'script' || !url.pathname.startsWith('/_next/static/')) return;
      scripts.push((async () => {
        let contentSha256;
        try {
          const source = await response.text();
          if (source.length > 8_000_000) return;
          contentSha256 = createHash('sha256').update(source).digest('hex');
          new Script(source, { filename: url.pathname });
          item.parsedScripts += 1;
        } catch (error) {
          item.failedScripts.push({ path: url.pathname, status: response.status(), contentType: response.headers()['content-type'],
            ...safeError(error), contentSha256, sourceLine: /:(\d+)$/u.exec((error.stack || '').split('\n')[0])?.[1] });
        }
      })());
    });
    try {
      item.status = (await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 }))?.status() || 0;
      if (route === '/youcai/profile') await page.locator('[data-page="manju-account"]').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      Object.assign(item, await page.evaluate(() => ({
        accountRendered: Boolean(document.querySelector('[data-page="manju-account"]')),
        renderedTextLength: document.body.innerText.length,
        fatalPage: /Application error|Unhandled Runtime Error|页面出现异常|出了点问题/iu.test(document.body.innerText),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      })));
    } catch (error) { item.navigationError = safeError(error); }
    await Promise.all(scripts);
    report.pages.push(item);
    console.log(JSON.stringify(item));
    await page.close();
  }
  report.completed = true;
}

main().catch((error) => { report.completed = false; report.error = safeError(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await mkdir('.codex-evidence/manju-secondary-20260902', { recursive: true });
  await writeFile(`.codex-evidence/manju-secondary-20260902/account-readonly-${Date.now()}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ completed: report.completed, pages: report.pages.length, blockedMutations: report.blockedMutations, blockedExternalReads: report.blockedExternalReads }));
});
