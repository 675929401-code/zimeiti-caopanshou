import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

// Actual React components; all requests are intercepted. This is not runtime or provider evidence.
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const output = path.resolve('.codex-evidence/admin-full-acceptance-20261030-9592a6d0/models/isolated-browser');
const bundle = await esbuild.build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Models from './src/components/unified-models-tab'; createRoot(document.getElementById('root')).render(<Models token="fixture-only" canManageModels />);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', tsconfig: 'tsconfig.json', plugins: [{ name: 'unused-validation-dialogs', setup(build) { build.onResolve({ filter: /admin-(video|image)-validation-dialog$/ }, () => ({ path: 'unused', namespace: 'stub' })); build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function Unused(){return null}', loader: 'js' })); } }] });
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const calls = []; const errors = []; const alerts = [];
const mutationKeys = [];
let saves = 0; let mode = 'staged';
const releaseId = '5ea47cca-874a-4c29-80f6-4e569c10cc05';
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.dismiss(); });
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url()); calls.push(`${request.method()} ${url.pathname}`);
    assert.equal(url.origin, 'http://127.0.0.1:49999', 'EXTERNAL_REQUEST');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><head><style>body{font:14px sans-serif;margin:24px;background:#f7faf8}button,input,select{margin:5px;padding:8px}input{min-width:200px}section{margin:16px 0} [role=dialog]{position:fixed;inset:12px;background:white;overflow:auto;padding:24px}button:disabled{opacity:.45}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles[0].text });
    let status = 200; let body = {};
    if (url.pathname === '/api/admin/models' && request.method() === 'GET') body = { models: [] };
    else if (url.pathname === '/api/video/channel-health') body = { channels: [] };
    else if (url.pathname === '/api/admin/credential-health') { status = 503; body = { error: '隔离夹具不读取凭据' }; }
    else if (url.pathname === '/api/admin/model-pool-releases') body = { current: { release_version: 104 }, releases: saves && mode === 'staged' ? [{ id: releaseId, release_version: 105, status: 'draft', snapshot_sha256: 'a'.repeat(64) }] : [], runtimeEnforcement: { ready: false, code: 'FIXTURE', blockers: ['隔离夹具禁止发布'] } };
    else if (url.pathname === '/api/admin/video-models/quick-add') { assert.deepEqual(Object.keys(request.postDataJSON()), ['text']); status = 422; body = { requiresDetails: true, code: 'DETAIL_CONFIGURATION_REQUIRED', parsed: { base: 'https://fixture.invalid', model: 'fixture-video', price: 1.2 } }; }
    else if (url.pathname === '/api/admin/models' && request.method() === 'POST') {
      const mutationKey = request.headers()['idempotency-key'];
      assert.match(String(mutationKey || ''), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu, 'REAL_BROWSER_IDEMPOTENCY_KEY_REQUIRED');
      mutationKeys.push(mutationKey);
      saves++; await new Promise(resolve => setTimeout(resolve, 150)); status = mode === 'staged' ? 202 : 200; body = mode === 'staged' ? { success: true, staged: true, published: false, result: { release: { id: releaseId, release_version: 105 } } } : {};
    }
    else throw new Error(`UNMOCKED_REQUEST ${request.method()} ${url.pathname}`);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // Loopback is a trustworthy browser context, as is the actual local app.
  // Every request is fulfilled above; no server or product crypto polyfill is used.
  await page.goto('http://127.0.0.1:49999/');
  await page.getByPlaceholder(/渠道地址 \+ 模型名/).fill('https://fixture.invalid/v1 fixture-video 售价1.2');
  await page.getByRole('button', { name: '解析并补充配置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增模型' });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel('模型 ID', { exact: true }).inputValue(), 'fixture-video');
  assert.equal(await dialog.getByLabel('成本价', { exact: true }).inputValue(), '');
  assert.equal(await dialog.getByLabel('渠道标识', { exact: true }).inputValue(), '');
  await dialog.getByLabel('API 密钥', { exact: true }).fill('fixture-only-no-secret');
  await dialog.getByRole('button', { name: '保存为候选', exact: true }).click();
  assert.equal(saves, 0); assert.match(alerts.at(-1), /未知成本/);
  await dialog.getByLabel('成本价', { exact: true }).fill('0');
  await dialog.getByLabel('渠道标识', { exact: true }).fill('fixture');
  await dialog.getByText('高级：接口协议与预设', { exact: true }).click();
  await dialog.getByLabel('视频模型接口协议').selectOption('openai_compatible');
  await dialog.getByRole('button', { name: '保存为候选', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByTestId('model-candidate-save-result').filter({ hasText: releaseId }).waitFor();
  assert.equal(saves, 1);
  const candidate = page.locator(`[data-release-id="${releaseId}"]`); await candidate.waitFor();
  assert.equal(await candidate.getByRole('button', { name: '按预览发布', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'actual-components-candidate.png'), fullPage: true });
  mode = 'unknown';
  await page.getByRole('button', { name: '添加视频模型', exact: true }).click();
  await dialog.getByLabel('用户展示名称', { exact: true }).fill('Fixture unknown');
  await dialog.getByLabel('模型 ID', { exact: true }).fill('fixture-video');
  await dialog.getByLabel('接入站点 API 地址', { exact: true }).fill('https://fixture.invalid/v1');
  await dialog.getByLabel('API 密钥', { exact: true }).fill('fixture-only');
  await dialog.getByLabel('成本价', { exact: true }).fill('0');
  await dialog.getByLabel('售价', { exact: true }).fill('1');
  await dialog.getByLabel('渠道标识', { exact: true }).fill('fixture');
  await dialog.getByText('高级：接口协议与预设', { exact: true }).click();
  await dialog.getByLabel('视频模型接口协议').selectOption('openai_compatible');
  await dialog.getByRole('button', { name: '保存为候选', exact: true }).click();
  await dialog.getByRole('button', { name: '请先核对保存结果', exact: true }).waitFor();
  assert.equal(await dialog.isVisible(), true); assert.equal(saves, 2); assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(mutationKeys.length, 2); assert.notEqual(mutationKeys[0], mutationKeys[1], 'DISTINCT_LOGICAL_FORMS_REQUIRE_DISTINCT_OPERATION_IDS');
  await page.screenshot({ path: path.join(output, 'actual-components-unknown.png'), fullPage: true });
  const report = { passed: true, actualReactComponents: true, assertions: ['quick-parser-422-opens-details-with-unknown-cost', 'explicit-cost-provider-protocol-required', 'double-click-single-candidate', 'candidate-focus-and-publish-gate', 'unknown-result-retains-form', 'real-browser-idempotency-key-and-distinct-logical-operation-ids'], pageErrors: errors, interceptedRequests: calls, providerCalls: 0, databaseWrites: 0, realNetworkCalls: 0, scope: 'isolated component interaction; not current app runtime or production visual acceptance' };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
