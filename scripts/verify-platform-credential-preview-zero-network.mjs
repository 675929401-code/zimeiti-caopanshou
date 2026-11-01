import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const file = 'src/components/admin/PlatformConfigurationReleasePanel.tsx';
const output = '.codex-evidence/admin-full-acceptance-20261030-9592a6d0/model-credential-preview';
await fs.mkdir(output, { recursive: true });
const source = await fs.readFile(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(); function walk(node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node); ts.forEachChild(node, walk); } walk(ast);
const sandbox = vm.createContext({});
for (const name of ['diffSummary', 'credentialChangeRows']) {
  assert.ok(functions.get(name)); vm.runInContext(ts.transpileModule(functions.get(name).getText(ast) + `\nglobalThis.${name}=${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
}
const ids = { current: '63185754-d452-4bb7-9c15-77aa14ba132a', candidate: '5ea47cca-874a-4c29-80f6-4e569c10cc05', legacy: '61fb9a42-d741-4bf3-ab69-c58ff64ac101', history: '62fb9a42-d741-4bf3-ab69-c58ff64ac102', emptyHistory: '68fb9a42-d741-4bf3-ab69-c58ff64ac108', workspace: '63fb9a42-d741-4bf3-ab69-c58ff64ac103', workspaceCurrent: '64fb9a42-d741-4bf3-ab69-c58ff64ac104' };
const pendingRevision = '75fb9a42-d741-4bf3-ab69-c58ff64ac105'; const expectedRevision = '76fb9a42-d741-4bf3-ab69-c58ff64ac106';
const metadata = [
  { modelKey: 'video_models:fixture-video', credentialRef: 'secret://fixture-private-reference', pendingRevision, expectedExists: true, expectedRevision, state: 'pending' },
  { modelKey: 'llm_models:fixture-text', credentialRef: 'env://FIXTURE_PRIVATE_REFERENCE', pendingRevision: '77fb9a42-d741-4bf3-ab69-c58ff64ac107', expectedExists: false, expectedRevision: null, state: 'pending' },
];
const modelSnapshot = { models: [{ id: 'fixture-video', name: '演示视频模型', configuration: { legacyTable: 'video_models', legacyId: 'fixture-video' } }, { id: 'llm:fixture-text', name: '演示对话模型', configuration: { legacyTable: 'llm_models', legacyId: 'fixture-text' } }] };
const current = { id: ids.current, is_current: true, status: 'published', release_version: 104, snapshot: modelSnapshot };
const candidate = { id: ids.candidate, is_current: false, status: 'validated', release_version: 105, snapshot: modelSnapshot, snapshot_sha256: '1'.repeat(64), change_note: '仅更新凭据的演示候选' };
const legacy = { ...candidate, id: ids.legacy, release_version: 106, change_note: '无凭据变更的普通候选' };
const history = { ...candidate, id: ids.history, release_version: 103, status: 'superseded', snapshot: { models: [{ ...modelSnapshot.models[0], name: '历史视频模型' }] }, change_note: '历史已应用记录' };
const emptyHistory = { ...history, id: ids.emptyHistory, release_version: 102, change_note: '历史无凭据变更记录' };
const basePreview = release => ({ kind: 'model-pool', current: { releaseId: ids.current, releaseVersion: 104, snapshotSha256: '1'.repeat(64) }, candidate: { releaseId: release.id, releaseVersion: release.release_version, snapshotSha256: '2'.repeat(64) }, diff: { models: { added: [], removed: [], changed: [] } }, previewSha256: '3'.repeat(64) });
const credentialPreview = { ...basePreview(candidate), credentialChanges: metadata };
const checks = [];
assert.match(sandbox.diffSummary(credentialPreview), /凭据新增\/替换 2 项/u);
assert.equal(sandbox.diffSummary(basePreview(legacy)), '新增 0 · 移除 0 · 修改 0');
let rows = sandbox.credentialChangeRows(credentialPreview, candidate, current);
assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ name: '演示视频模型', operation: '替换凭据', state: '发布前尚未生效' }, { name: '演示对话模型', operation: '新增凭据', state: '发布前尚未生效' }]);
const safeProjection = JSON.stringify(rows);
for (const hidden of ['secret://', 'env://', pendingRevision, expectedRevision, 'video_models:', 'llm_models:', 'credentialRef', 'pendingRevision', 'expectedRevision']) assert.equal(safeProjection.includes(hidden), false);
rows = sandbox.credentialChangeRows({ ...credentialPreview, credentialChanges: [{ ...metadata[0], state: 'applied' }] }, history, current);
assert.equal(rows[0].name, '历史视频模型'); assert.match(rows[0].state, /已随历史版本生效/u); assert.doesNotMatch(rows[0].state, /尚未生效/u);
rows = sandbox.credentialChangeRows({ ...credentialPreview, credentialChanges: [{ ...metadata[0], modelKey: 'unmapped-private-model-key' }] }, candidate, current);
assert.equal(rows[0].name, '未命名模型'); assert.equal(JSON.stringify(rows).includes('unmapped-private-model-key'), false);
checks.push('actual-summary-includes-credential-only-count-and-legacy-summary-unchanged', 'actual-name-mapping-new-replace-pending-and-historical-applied-projection', 'only-display-safe-fields-returned-no-key-ref-revision-or-unmapped-identity');

const workspace = { id: ids.workspace, is_current: false, status: 'validated', release_version: 8, snapshot_sha256: '4'.repeat(64), change_note: '相邻工作台候选' };
const workspacePreview = { kind: 'workspace-models', current: { releaseId: ids.workspaceCurrent, releaseVersion: 7, snapshotSha256: '5'.repeat(64) }, candidate: { releaseId: ids.workspace, releaseVersion: 8, snapshotSha256: '4'.repeat(64) }, diff: { surfaces: [{ surface: 'image-workbench', changed: true, assignments: { added: ['fixture-video'], removed: [] } }] }, previewSha256: '6'.repeat(64) };
assert.equal(sandbox.diffSummary(workspacePreview), '变更页面 1 · 新增分配 1 · 移除分配 0');
assert.equal(sandbox.credentialChangeRows({ ...workspacePreview, credentialChanges: metadata }, workspace, null).length, 0);
checks.push('workspace-summary-and-scope-remain-unchanged-even-if-extra-metadata-present');

const require = createRequire(import.meta.url); const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const bundle = await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './${file}';createRoot(document.getElementById('root')).render(<><Panel token="fixture-only" kind="model-pool" focusReleaseId="${ids.candidate}"/><Panel token="fixture-only" kind="workspace-models" focusReleaseId="${ids.workspace}"/></>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', tsconfig: 'tsconfig.json' });
const browser = await chromium.launch({ headless: true });
const intercepted = []; const pageErrors = []; let writes = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    assert.equal(url.origin, 'http://credential-preview-fixture.invalid', 'REAL_NETWORK_FORBIDDEN');
    intercepted.push(`${request.method()} ${url.pathname}${url.search}`);
    if (request.method() !== 'GET') { writes++; throw new Error('ANY_WRITE_FORBIDDEN'); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><head><style>body{margin:24px;font:14px sans-serif;color:#172033;background:#f5f7fa}section{margin-bottom:24px;border:1px solid #d0d5dd;padding:16px;border-radius:12px;background:white}article{margin:12px 0;padding:12px;border:1px solid #d0d5dd}button{margin:4px;padding:6px 10px}button:disabled{opacity:.4}p{line-height:1.6}[aria-label="凭据变更摘要"]{border:1px solid #b2ccff;background:#eff4ff;padding:10px;margin-top:8px}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles[0].text });
    const previewId = url.searchParams.get('previewReleaseId'); const credentialReleaseId = url.searchParams.get('credentialReleaseId'); let data;
    if (url.pathname === '/api/admin/model-pool-releases') {
      if ([ids.history, ids.emptyHistory].includes(previewId)) throw new Error('HISTORICAL_PREVIEW_IS_NOT_AUTHORIZED');
      data = credentialReleaseId ? { ok: true, releaseId: credentialReleaseId, credentialChanges: credentialReleaseId === ids.history ? [{ modelKey: metadata[0].modelKey, expectedExists: true, state: 'applied' }] : [] }
        : previewId ? { preview: previewId === ids.candidate ? credentialPreview : basePreview(legacy) }
          : { current, releases: [candidate, legacy, history, emptyHistory, current], runtimeEnforcement: { ready: true, blockers: [], code: 'FIXTURE' } };
    } else if (url.pathname === '/api/admin/workspace-model-releases') data = previewId ? { preview: workspacePreview } : { current: { id: ids.workspaceCurrent, release_version: 7, is_current: true, status: 'published' }, releases: [workspace], runtimeEnforcement: { ready: true, blockers: [], code: 'FIXTURE' } };
    else throw new Error('UNMOCKED_DEPENDENCY');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto('http://credential-preview-fixture.invalid/');
  const models = page.getByTestId('platform-release-panel-model-pool'); const workspaces = page.getByTestId('platform-release-panel-workspace-models');
  const candidateCard = models.locator(`[data-release-id="${ids.candidate}"]`); await candidateCard.waitFor();
  assert.equal(await candidateCard.getByRole('button', { name: '按预览发布', exact: true }).isDisabled(), true);
  await candidateCard.getByRole('button', { name: '查看差异', exact: true }).click();
  const credentialArea = models.getByTestId('release-credential-changes'); await credentialArea.waitFor();
  assert.match(await credentialArea.innerText(), /演示视频模型 · 替换凭据 · 发布前尚未生效/u);
  assert.match(await credentialArea.innerText(), /演示对话模型 · 新增凭据 · 发布前尚未生效/u);
  assert.equal(await candidateCard.getByRole('button', { name: '按预览发布', exact: true }).isDisabled(), false);
  for (const hidden of ['secret://fixture-private-reference', 'env://FIXTURE_PRIVATE_REFERENCE', pendingRevision, expectedRevision, 'video_models:fixture-video', 'llm_models:fixture-text']) assert.equal((await page.locator('body').innerText()).includes(hidden), false);
  await page.screenshot({ path: path.join(output, 'pending-credentials-neighbor-workspace.png'), fullPage: true });
  const workspaceCard = workspaces.locator(`[data-release-id="${ids.workspace}"]`); await workspaceCard.getByRole('button', { name: '查看差异', exact: true }).click();
  await workspaceCard.getByText(/变更页面 1 · 新增分配 1 · 移除分配 0/u).waitFor();
  assert.equal(await workspaces.getByTestId('release-credential-changes').count(), 0);
  assert.equal(await models.getByTestId('release-credential-changes').count(), 1);
  checks.push('isolated-real-react-two-panels-pending-visibility-safe-fields-and-publish-gate-preserved', 'neighbor-workspace-preview-independent-and-no-credential-summary');
  await models.locator(`[data-release-id="${ids.legacy}"]`).getByRole('button', { name: '查看差异', exact: true }).click();
  await models.locator(`[data-release-id="${ids.legacy}"]`).getByText(/新增 0 · 移除 0 · 修改 0/u).waitFor();
  assert.equal(await models.getByTestId('release-credential-changes').count(), 0);
  await models.getByText('历史发布与回滚（2）', { exact: true }).click();
  const historicalCard = models.locator(`[data-history-release-id="${ids.history}"]`);
  assert.equal(await historicalCard.getByRole('button', { name: '查看差异', exact: true }).count(), 0);
  await historicalCard.getByRole('button', { name: '查看凭据状态', exact: true }).click();
  await historicalCard.getByTestId('release-credential-changes').waitFor();
  assert.match(await historicalCard.innerText(), /历史视频模型 · 替换凭据 · 已随历史版本生效/u);
  assert.doesNotMatch(await historicalCard.innerText(), /发布前尚未生效/u);
  assert.equal(await historicalCard.getByRole('button', { name: '按预览发布', exact: true }).count(), 0);
  assert.equal(await historicalCard.getByRole('button', { name: '建立回滚候选', exact: true }).count(), 1);
  const emptyHistoricalCard = models.locator(`[data-history-release-id="${ids.emptyHistory}"]`);
  await emptyHistoricalCard.getByRole('button', { name: '查看凭据状态', exact: true }).click();
  await emptyHistoricalCard.getByTestId('release-credential-empty').waitFor();
  assert.equal(await emptyHistoricalCard.getByTestId('release-credential-changes').count(), 0);
  assert.equal(await workspaces.getByRole('button', { name: '查看凭据状态', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'applied-history-and-workspace-preview.png'), fullPage: true });
  checks.push('legacy-no-metadata-preview-unchanged', 'applied-history-uses-dedicated-safe-state-read-not-preview-or-publish', 'history-with-no-credential-records-explicit-and-workspace-has-no-credential-action');
  assert.equal(writes, 0); assert.deepEqual(pageErrors, []);
} finally { await browser.close(); }
const report = { passed: true, actualProductionFunctionsAndReactComponent: true, checks, intercepted, pageErrors, realNetworkCalls: 0, databaseWrites: 0, providerCalls: 0, sourceSha256: (await import('node:crypto')).createHash('sha256').update(source).digest('hex'), limitation: 'isolated component fixture; not current 5000 visual/runtime acceptance' };
await fs.writeFile(path.join(output, 'zero-network.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
