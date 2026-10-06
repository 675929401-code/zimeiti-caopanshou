import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = String(process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/u, '');
assert.match(base, /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u, 'LOCAL_BASE_URL_REQUIRED');
const evidence = '.codex-evidence/video-storyboard-submission-20260902';
const report = {
  observedAt: new Date().toISOString(),
  mode: 'anonymous-read-only',
  session: { authenticated: false, source: 'anonymous-login-wall' },
  catalogs: [],
  pages: [],
  blockedMutations: 0,
  blockedHealthProbes: 0,
  blockedExternalRequests: 0,
  browserErrorCount: 0,
};
let browser;
try {
  for (const route of ['/api/video/models?surface=video-page', '/api/video/models?surface=storyboard-workbench', '/api/cover-models?surface=storyboard-workbench']) {
    const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(30_000) });
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload) ? payload : payload.models || payload.data || [];
    assert.equal(response.status, 200, `公开模型目录不可用：${route}`);
    assert.ok(Array.isArray(models) && models.length > 0, `公开模型目录为空：${route}`);
    report.catalogs.push({ route, status: response.status, count: models.length, models: models.map((model) => {
      const cap = model.capabilities || {};
      return {
        id: model.id,
        name: model.displayName || model.display_name || model.name,
        price: model.publicPrice ?? null,
        available: cap.available ?? null,
        supportsPrompt: cap.supportsPrompt ?? null,
        imageInput: cap.supportsImageInput ?? cap.supportsReferenceInput ?? null,
        minImages: cap.minReferenceImages ?? null,
        maxImages: cap.maxReferenceImages ?? null,
        minAudios: cap.minReferenceAudios ?? null,
        maxAudios: cap.maxReferenceAudios ?? null,
        mode: cap.workflowInputMode ?? cap.referenceInputMode ?? null,
        requiresSourceVideo: cap.requiresSourceVideo ?? null,
        durations: cap.nativeDurations || [],
        defaultDuration: cap.defaultDuration ?? null,
        resolutions: cap.resolutionOptions || [],
        defaultResolution: cap.defaultResolution ?? null,
        ratios: cap.aspectRatios || [],
      };
    }) });
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base && /^https?:$/u.test(url.protocol)) {
      report.blockedExternalRequests++;
      return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.blockedMutations++;
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/health' && !url.searchParams.has('logs') && !url.searchParams.has('liveness')) {
      report.blockedHealthProbes++;
      return route.abort('blockedbyclient');
    }
    if (/^\/api\/video\/(?:status|stream|h3-lifecycle)$/u.test(url.pathname)) {
      report.blockedMutations++;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  for (const route of ['/video', '/storyboard-workbench']) {
    const page = await context.newPage();
    page.on('pageerror', () => { report.browserErrorCount++; });
    const response = await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForURL(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.getByText('登录平台', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 });
    const item = {
      route,
      status: response?.status() || null,
      redirectedToLoginEntry: page.url() === `${base}/`,
      loginEntryVisible: true,
    };
    item.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
    report.pages.push(item);
    assert.equal(item.status, 200);
    assert.equal(item.redirectedToLoginEntry, true);
    assert.equal(item.loginEntryVisible, true);
    assert.equal(item.horizontalOverflow, false);
    await page.close();
  }
  assert.equal(report.browserErrorCount, 0);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failureName = error instanceof Error ? error.name : 'UnknownError';
  report.failureMessage = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/runtime-readonly.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ...report,
    catalogs: report.catalogs.map(({ models, ...catalog }) => ({
      ...catalog,
      availableCount: models.filter((model) => model.available !== false).length,
    })),
  }, null, 2));
}
