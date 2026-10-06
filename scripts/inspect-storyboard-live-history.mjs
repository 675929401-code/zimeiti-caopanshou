import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function compactText(value, limit = 220) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

async function createReadOnlyContext(browser, origin, token, identity, report) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ authToken, authUser }) => {
    localStorage.setItem('auth_token', authToken);
    localStorage.setItem('auth_user', JSON.stringify(authUser));
    localStorage.setItem('active_view', 'storyboard-workbench');
    sessionStorage.setItem('entered_app', '1');
  }, { authToken: token, authUser: identity.user });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) {
      report.externalRequestsBlocked.push({ method, origin: url.origin, path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (!SAFE_METHODS.has(method)) {
      report.writeRequestsBlocked.push({ method, path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/auth/me') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: identity.user }),
      });
    }
    if (url.pathname === '/api/video/active-tasks') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ activeTasks: [] }),
      });
    }
    return route.continue();
  });
  return context;
}

export async function main() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/+$/u, '');
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
  const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}'));
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, 'LOCAL_LOOPBACK_ORIGIN_REQUIRED');
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
  assert.ok(identity?.user?.id, 'LOCAL_NAV_READONLY_IDENTITY_REQUIRED');

  const output = path.join(process.cwd(), '.codex-evidence', `storyboard-history-dom-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
  await fs.mkdir(output, { recursive: true });
  const report = {
    checkedAt: new Date().toISOString(),
    mode: 'existing-project-history-dom-read-only',
    writeRequestsBlocked: [],
    externalRequestsBlocked: [],
    pageErrors: [],
    consoleErrors: [],
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await createReadOnlyContext(browser, origin, token, identity, report);
    const page = await context.newPage();
    page.on('response', async response => {
      const url = new URL(response.url());
      if (url.origin !== origin || url.pathname !== '/api/storyboard/projects') return;
      try {
        const payload = await response.json();
        const projects = Array.isArray(payload?.projects) ? payload.projects : [];
        report.projectsResponse = {
          status: response.status(),
          count: projects.length,
          firstProjectShape: projects[0] ? Object.fromEntries(Object.entries(projects[0]).map(([key, value]) => [key, Array.isArray(value) ? `array:${value.length}` : value && typeof value === 'object' ? `object:${Object.keys(value).join(',')}` : typeof value])) : null,
          firstProject: projects[0] || null,
          projects: projects.map(project => ({
            id: String(project?.id || ''),
            title: compactText(project?.title, 100),
            taskCount: Array.isArray(project?.tasks) ? project.tasks.length : 0,
            imageStatuses: Array.isArray(project?.tasks) ? project.tasks.map(task => String(task?.imageStatus || '')).filter(Boolean) : [],
            hasImage: Array.isArray(project?.tasks) && project.tasks.some(task => Boolean(task?.imageUrl || task?.imageStorageKey || task?.imageAssetId)),
          })),
        };
      } catch (error) {
        report.projectsResponse = { status: response.status(), parseFailure: compactText(error?.message) };
      }
    });
    page.on('pageerror', error => report.pageErrors.push(compactText(error?.message)));
    page.on('console', message => {
      if (message.type() === 'error') report.consoleErrors.push(compactText(message.text()));
    });
    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.getByTitle('最近任务', { exact: true }).click();
    await page.waitForTimeout(750);
    report.currentUrl = page.url();
    report.dataProjectElements = await page.locator('[data-storyboard-project-id]').evaluateAll(nodes => nodes.map(node => ({
      tag: node.tagName,
      projectId: node.getAttribute('data-storyboard-project-id'),
      text: String(node.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 280),
    })));
    report.articles = await page.locator('article').evaluateAll(nodes => nodes.slice(0, 30).map(node => ({
      projectId: node.getAttribute('data-storyboard-project-id'),
      text: String(node.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 280),
    })));
    report.buttons = await page.locator('button').evaluateAll(nodes => nodes.map(node => ({
      title: node.getAttribute('title'),
      ariaLabel: node.getAttribute('aria-label'),
      text: String(node.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 160),
      disabled: node.hasAttribute('disabled'),
    })).filter(item => item.title || item.ariaLabel || item.text).slice(-80));
    await page.screenshot({ path: path.join(output, 'recent-tasks.png'), fullPage: true });
    await context.close();
    report.passed = report.dataProjectElements.length > 0 || report.articles.some(article => article.text);
  } catch (error) {
    report.passed = false;
    report.failure = compactText(error?.stack || error?.message || error, 2000);
  } finally {
    await browser.close();
    await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({ output, passed: report.passed, projectElements: report.dataProjectElements?.length || 0, articles: report.articles?.length || 0, failure: report.failure || null }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
