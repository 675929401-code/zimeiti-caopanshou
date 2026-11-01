import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium } from 'playwright';

// Render the actual hook with local React sources. Every browser request is
// fulfilled in memory; no application, credentials, database or provider runs.
const require = createRequire(import.meta.url);
const origin = 'http://extraction-status-fixture.invalid';
const hookPath = 'src/hooks/use-extraction-attempt-status.ts';
const historyHookPath = 'src/hooks/use-extraction-history.ts';
const out = path.resolve('.codex-evidence/extraction-incident-20261029-9ea52c8d', `status-browser-${Date.now()}`);
const report = { kind: 'actual-hook-browser-zero-network', startedAt: new Date().toISOString(),
  providerSubmissions: 0, businessWrites: 0, scenarios: [], browserErrors: [], passed: false };

async function bundle() {
  const domEntry = require.resolve('react-dom/client');
  const domRequire = createRequire(domEntry);
  const reactRoot = path.dirname(require.resolve('react'));
  const domRoot = path.dirname(domEntry);
  const schedulerRoot = path.dirname(domRequire.resolve('scheduler'));
  const files = {
    react: path.join(reactRoot, 'cjs/react.production.js'),
    'react-dom': path.join(domRoot, 'cjs/react-dom.production.js'),
    'react-dom/client': path.join(domRoot, 'cjs/react-dom-client.production.js'),
    scheduler: path.join(schedulerRoot, 'cjs/scheduler.production.js'),
  };
  const modules = [];
  for (const [id, file] of Object.entries(files)) modules.push(`${JSON.stringify(id)}:function(module,exports,require){\n${await fs.readFile(file, 'utf8')}\n}`);
  for (const [id, file] of [['hook', hookPath], ['history-hook', historyHookPath]]) {
    const source = await fs.readFile(file, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
    modules.push(`${JSON.stringify(id)}:function(module,exports,require){\n${compiled}\n}`);
  }
  modules.push(`"@/lib/extract-client-attempt":function(module){module.exports={clearBrowserClientAttemptsById:(scope,id)=>window.__cleared.push({scope,id})};}`);
  modules.push(`"@/lib/workbench-user-storage":function(module){module.exports={workbenchUserStorageKey:(key,user)=>key+':'+user};}`);
  return `(()=>{const modules={${modules.join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;if(!modules[id])throw Error('UNMOCKED_MODULE:'+id);const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}
    const React=require('react'),{createRoot}=require('react-dom/client');
    const {useExtractionAttemptStatus}=require('hook'),{useExtractionHistory}=require('history-hook');
    window.__cleared=[];window.__view=null;window.__historyView=null;
    const root=createRoot(document.getElementById('root'));
    function StatusHarness({query}){const value=useExtractionAttemptStatus(query);window.__view={...value,refresh:undefined};window.__refresh=value.refresh;return React.createElement('pre',null,JSON.stringify(window.__view));}
    function HistoryHarness({query}){const value=useExtractionHistory(query.token,query.userId);window.__historyView={...value,refresh:undefined,remove:undefined,loadMore:undefined};return React.createElement('pre',null,JSON.stringify(window.__historyView));}
    window.renderStatus=query=>root.render(React.createElement(StatusHarness,{query}));
    window.renderHistory=query=>root.render(React.createElement(HistoryHarness,{query}));
    window.__visibility='visible';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__visibility});
    window.setVisibility=value=>{window.__visibility=value;document.dispatchEvent(new Event('visibilitychange'));};
    const nativeFetch=window.fetch.bind(window);window.fetch=(input,init={})=>nativeFetch(input,String(input).includes('client-old')?{...init,signal:undefined}:init);
  })();`;
}

const baseQuery = { token: 'synthetic-session-a', userId: 'fixture-user-a', mode: 'text', clientRequestId: 'fixture-client-001' };
function statusBody(clientRequestId, state) { return {
  attemptId: 'a'.repeat(64), clientRequestId, state, netCharged: state === 'succeeded' ? 0.02 : 0,
  billingMessage: 'fixture', checkedAt: new Date().toISOString(),
  ...(state === 'succeeded' ? { response: { success: true, texts: [{ success: true, content: 'synthetic completed copy' }] } } : {}),
}; }

async function until(read, predicate, label) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error(`FIXTURE_WAIT_FAILED:${label}`);
}

async function fixture(browser, compiled, responder) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const requests = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'Real network forbidden');
    if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>' });
    assert.equal(request.method(), 'GET', 'Only original-request status/history reads allowed');
    assert.ok(['/api/extract/status', '/api/extract/history'].includes(url.pathname), 'Unknown network request blocked');
    const entry = { path: url.pathname, client: url.searchParams.get('client_request_id'), attempt: url.searchParams.get('attempt_id') };
    requests.push(entry);
    const result = await responder({ entry, count: requests.length, requests, request });
    await route.fulfill({ status: result.status || 200, contentType: 'application/json', body: JSON.stringify(result.body) }).catch(() => {});
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-29T00:00:00.000Z') });
  await page.goto(origin);
  await page.addScriptTag({ content: compiled });
  const view = () => page.evaluate(() => window.__view);
  const historyView = () => page.evaluate(() => window.__historyView);
  const render = async query => { await page.evaluate(value => window.renderStatus(value), query); };
  const advance = async (duration = 30_010) => {
    // Let routed responses settle between clock increments; jumping across the
    // entire fetch deadline would create synthetic transport timeouts.
    for (let elapsed = 0; elapsed < duration; elapsed += 1_000) {
      await page.clock.runFor(Math.min(1_000, duration - elapsed));
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  };
  return { context, page, requests, view, historyView, render, advance };
}

export async function main() {
  await fs.mkdir(out, { recursive: true });
  const compiled = await bundle();
  const browserTemp = path.join(out, 'browser-temp');
  await fs.mkdir(browserTemp, { recursive: true });
  const originalTemp = process.env.TEMP, originalTmp = process.env.TMP;
  let browser;
  try {
    process.env.TEMP = browserTemp; process.env.TMP = browserTemp;
    browser = await chromium.launch({ headless: true, env: { ...process.env, TEMP: browserTemp, TMP: browserTemp },
      executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
  } finally {
    if (originalTemp === undefined) delete process.env.TEMP; else process.env.TEMP = originalTemp;
    if (originalTmp === undefined) delete process.env.TMP; else process.env.TMP = originalTmp;
  }
  try {
    {
      const f = await fixture(browser, compiled, ({ count, entry }) => ({ status: count <= 7 ? 503 : 200,
        body: count <= 7 ? { error: 'synthetic temporary read failure' } : statusBody(entry.client, count === 8 ? 'running' : 'succeeded') }));
      await f.render(baseQuery);
      await until(f.view, value => value?.trackingState === 'retrying', 'transient read failure');
      for (let i = 0; i < 12 && (await f.view())?.trackingState !== 'terminal'; i++) await f.advance();
      const final = await until(f.view, value => value?.trackingState === 'terminal', 'recover after more than six failures');
      assert.equal(final.data.state, 'succeeded'); assert.ok(f.requests.length >= 9);
      assert.deepEqual(await f.page.evaluate(() => window.__cleared), [{ scope: 'extract:fixture-user-a:text', id: baseQuery.clientRequestId }]);
      report.scenarios.push({ name: 'seven-transient-read-failures-recover', requests: f.requests.length, passed: true });
      await f.context.close();
    }
    {
      const f = await fixture(browser, compiled, ({ count, entry }) => ({ body: statusBody(entry.client, count === 1 ? 'failed_unknown' : 'succeeded') }));
      await f.render(baseQuery);
      await until(f.view, value => value?.trackingState === 'reconciliation', 'unknown result tracking');
      assert.deepEqual(await f.page.evaluate(() => window.__cleared), []);
      await f.advance();
      await until(f.view, value => value?.trackingState === 'terminal' && value.data?.state === 'succeeded', 'administrator resolution restores result');
      report.scenarios.push({ name: 'failed-unknown-continues-reading-until-resolved', requests: f.requests.length, passed: true });
      await f.context.close();
    }
    {
      const f = await fixture(browser, compiled, ({ count, entry }) => ({ body: statusBody(entry.client, count === 1 ? 'running' : 'succeeded') }));
      await f.render(baseQuery);
      await until(f.view, value => value?.trackingState === 'tracking', 'visible running state');
      await f.page.evaluate(() => window.setVisibility('hidden'));
      await until(f.view, value => value?.trackingState === 'paused', 'hidden page pauses');
      const readsBeforeHidden = f.requests.length;
      await f.advance(60_010);
      assert.equal(f.requests.length, readsBeforeHidden, 'Hidden page must not continue status polling');
      await f.page.evaluate(() => window.setVisibility('visible'));
      await until(f.view, value => value?.trackingState === 'terminal', 'visible page resumes');
      report.scenarios.push({ name: 'hidden-pauses-visible-resumes-original-request', requests: f.requests.length, passed: true });
      await f.context.close();
    }
    {
      let releaseOld;
      const oldResponse = new Promise(resolve => { releaseOld = resolve; });
      const f = await fixture(browser, compiled, async ({ entry }) => entry.client === 'client-old'
        ? oldResponse : { body: statusBody(entry.client, 'succeeded') });
      await f.render({ ...baseQuery, clientRequestId: 'client-old' });
      await until(async () => f.requests.length, value => value === 1, 'old account request in flight');
      const next = { ...baseQuery, userId: 'fixture-user-b', token: 'synthetic-session-b', clientRequestId: 'client-new' };
      await f.render(next);
      await until(f.view, value => value?.data?.clientRequestId === 'client-new' && value.trackingState === 'terminal', 'new account result');
      releaseOld({ body: statusBody('client-old', 'succeeded') });
      await f.advance(1_000);
      assert.equal((await f.view()).data.clientRequestId, 'client-new', 'Late old account response cannot replace current data');
      assert.deepEqual(await f.page.evaluate(() => window.__cleared), [{ scope: 'extract:fixture-user-b:text', id: 'client-new' }]);
      report.scenarios.push({ name: 'account-and-request-switch-rejects-late-old-response', requests: f.requests.length, passed: true });
      await f.context.close();
    }
    {
      const f = await fixture(browser, compiled, () => ({ status: 401, body: { error: 'synthetic session expired' } }));
      await f.render(baseQuery);
      const final = await until(f.view, value => value?.trackingState === 'unavailable', '401 unavailable state');
      assert.ok(final.error); const reads = f.requests.length;
      await f.advance(60_010); assert.equal(f.requests.length, reads, 'Invalid authentication must stop polling');
      assert.deepEqual(await f.page.evaluate(() => window.__cleared), []);
      report.scenarios.push({ name: '401-stops-with-explicit-unavailable-state', requests: reads, passed: true });
      await f.context.close();
    }
    {
      const f = await fixture(browser, compiled, ({ count, entry }) => ({ body: statusBody(entry.client, count <= 65 ? 'running' : 'succeeded') }));
      await f.render(baseQuery);
      await until(f.view, value => value?.trackingState === 'tracking', 'long original request');
      for (let i = 0; i < 70 && (await f.view())?.trackingState !== 'terminal'; i++) await f.advance(15_010);
      const final = await until(f.view, value => value?.trackingState === 'terminal', 'status polling beyond sixty reads');
      assert.equal(final.data.state, 'succeeded'); assert.ok(f.requests.length >= 66);
      const reads = f.requests.length; await f.advance(60_010); assert.equal(f.requests.length, reads, 'Terminal state stops polling');
      assert.deepEqual(await f.page.evaluate(() => window.__cleared), [{ scope: 'extract:fixture-user-a:text', id: baseQuery.clientRequestId }]);
      report.scenarios.push({ name: 'more-than-sixty-running-reads-recover-and-clear-once', requests: reads, passed: true });
      await f.context.close();
    }
    {
      const f = await fixture(browser, compiled, ({ count }) => count === 1
        ? { status: 503, body: { error: 'synthetic history temporarily unreadable' } }
        : { body: { records: [{ id: 'b'.repeat(64), pending: false, status: 'success' }], next: null, retryReady: true } });
      await f.page.evaluate(query => window.renderHistory(query), baseQuery);
      await until(f.historyView, value => !!value?.error, 'history first read failed');
      await f.advance(15_010);
      await until(f.historyView, value => value?.ready && value.history.length === 1, 'history recovers initial read');
      report.scenarios.push({ name: 'history-initial-read-error-retries', requests: f.requests.length, passed: true });
      await f.context.close();
    }
    {
      const f = await fixture(browser, compiled, ({ count }) => ({ body: { records: count === 1 ? [] : [{ id: 'c'.repeat(64), pending: false, status: 'success' }], next: null, retryReady: true } }));
      await f.page.evaluate(query => window.renderHistory(query), baseQuery);
      await until(f.historyView, value => value?.ready, 'empty history ready');
      await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await until(f.historyView, value => value?.history?.length === 1, 'empty history refreshes on focus');
      report.scenarios.push({ name: 'history-without-active-record-refreshes-on-focus', requests: f.requests.length, passed: true });
      await f.context.close();
    }
    assert.deepEqual(report.browserErrors, []);
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify({ ...report, evidence: path.relative(process.cwd(), path.join(out, 'report.json')) }, null, 2));
  }
}

if (process.argv[1]?.endsWith('verify-extraction-status-recovery-browser.mjs')) await main();
