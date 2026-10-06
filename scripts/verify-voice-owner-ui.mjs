import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('tsx'))('esbuild');
const source = path.resolve('src/app/voice-studio/workspace/page.tsx');
const before = path.resolve('.codex-backups/20260903-021356-voice-owner-and-supported-inputs/workspace-page.tsx');
const cases = [];
const browser = await chromium.launch({ headless: true, executablePath: 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/.cache/ms-playwright/chromium-1228/chrome-win64/chrome.exe' });
async function fixture(old) {
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import Page from 'voice-fixture';const root=createRoot(document.getElementById('root'));globalThis.setFixtureAuth=auth=>{globalThis.fixtureAuth=auth;root.render(React.createElement(Page));};globalThis.setFixtureAuth({isAuthenticated:true,user:{id:'owner-a'},token:'fixture-a'});`;
  const stubs = {
    'next/navigation': 'export const useSearchParams=()=>new URLSearchParams();',
    '@/contexts/app-context': 'export const useApp=()=>({state:{auth:globalThis.fixtureAuth}});',
    '@/lib/vs/preview-cache': 'export const loadPreview=()=>{throw Error("PREVIEW_NOT_ALLOWED")};',
    '@/lib/vs/avatar': 'export const getAvatarUrl=()=>null;export const getInitials=()=>"V";export const getGradient=()=>"";',
    '@/components/vs/GlobalTaskBar': 'export const setRunningTask=()=>{};export const clearRunningTask=()=>{};',
    '@/components/vs/ui/Button': 'import React from "react";export default ({children,onClick,disabled,...rest})=>React.createElement("button",{onClick,disabled},children);',
    '@/components/vs/ui/Slider': 'import React from "react";export default ({value,onChange,min,max})=>React.createElement("input",{type:"range",value,min,max,onChange:e=>onChange(Number(e.target.value))});',
    '@/components/vs/ui/Select': 'import React from "react";export default ()=>null;',
    '@/components/vs/AudioPlayer': 'import React from "react";export default ()=>React.createElement("audio");',
    '@/components/vs/VoiceGenerationHistory': 'import React from "react";export default ({token})=>React.createElement("div",{"data-current-history-token":token});',
  };
  const result = await esbuild.build({ stdin: { contents: entry, sourcefile: 'voice-owner-fixture.tsx', loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'isolate-real-page', setup(build) {
    build.onResolve({ filter: /^voice-fixture$/ }, () => ({ path: old ? before : source, namespace: 'page' }));
    build.onLoad({ filter: /.*/, namespace: 'page' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'tsx', resolveDir: path.dirname(source) }));
    build.onResolve({ filter: /^(?:@\/|next\/navigation)/ }, args => args.path in stubs ? ({ path: args.path, namespace: 'stub' }) : ({ path: path.resolve('src', args.path.slice(2) + '.ts') }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'jsx', resolveDir: process.cwd() }));
  } }] });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    globalThis.fixturePosts = []; globalThis.fixtureReleases = [];
    localStorage.setItem('vs_favorites', '["unowned-legacy-favorite"]');
    globalThis.fetch = async (url, init = {}) => {
      const auth = init.headers?.Authorization;
      if (String(url).includes('/api/voice/favorites')) return Response.json({ favorites: auth === 'Bearer fixture-a' ? [{ voice_id: 'owner-a-favorite' }] : [] });
      if (String(url).includes('/api/voice/user-voices')) return Response.json({ voices: [] });
      if (String(url) === '/api/voice/tts' && init.method === 'POST') { globalThis.fixturePosts.push({ body: JSON.parse(init.body), auth }); return new Promise(resolve => globalThis.fixtureReleases.push(() => resolve(Response.json({ success: false, message: 'fixture unknown' }, { status: 503 })))); }
      throw Error('UNEXPECTED_FIXTURE_REQUEST');
    };
  });
  await context.route('**/*', route => { assert.equal(new URL(route.request().url()).origin, 'http://voice-owner-fixture.test'); return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }); });
  const page = await context.newPage(); await page.goto('http://voice-owner-fixture.test/'); await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.getByPlaceholder('输入要合成的文本内容...').waitFor();
  return { page, context };
}
try {
  const old = await fixture(true); await old.page.getByPlaceholder('输入要合成的文本内容...').fill('OWNER_A_DRAFT');
  await old.page.evaluate(() => globalThis.setFixtureAuth({ isAuthenticated: true, user: { id: 'owner-b' }, token: 'fixture-b' }));
  assert.equal(await old.page.getByPlaceholder('输入要合成的文本内容...').inputValue(), 'OWNER_A_DRAFT'); cases.push('Before: actual page keeps owner A draft after identity changes to B'); await old.context.close();
  const { page, context } = await fixture(false);
  await page.getByPlaceholder('输入要合成的文本内容...').fill('OWNER_A_DRAFT'); await page.getByLabel('选择音色搜索', { exact: true }).fill('Vivi 2.0'); await page.getByText('Vivi 2.0', { exact: true }).click();
  await page.getByRole('button', { name: /开始合成/u }).click(); await page.waitForFunction(() => globalThis.fixturePosts.length === 1);
  const pendingA = await page.evaluate(() => localStorage.getItem('production-client-attempt:v1:voice-workspace:single:user:owner-a')); assert.ok(pendingA);
  await page.evaluate(() => globalThis.setFixtureAuth({ isAuthenticated: true, user: { id: 'owner-b' }, token: 'fixture-b' }));
  await page.waitForFunction(() => document.querySelector('[data-current-history-token]')?.getAttribute('data-current-history-token') === 'fixture-b');
  assert.equal(await page.getByPlaceholder('输入要合成的文本内容...').inputValue(), ''); cases.push('Current: owner change remounts the actual workspace and clears prior draft/results/selections');
  const favorites = await page.evaluate(() => ({ a: localStorage.getItem('vs_favorites:user:owner-a'), b: localStorage.getItem('vs_favorites:user:owner-b'), legacy: localStorage.getItem('vs_favorites') }));
  assert.ok(favorites.a.includes('owner-a-favorite')); assert.equal(favorites.b, '[]'); assert.equal(favorites.legacy, '["unowned-legacy-favorite"]'); cases.push('Favorites are stored by owner; legacy unowned bytes are never read or removed');
  await page.evaluate(() => { localStorage.setItem('production-client-attempt:v1:voice-workspace:single:user:owner-b', 'B-SENTINEL'); globalThis.fixtureReleases[0](); });
  assert.equal(await page.evaluate(() => localStorage.getItem('production-client-attempt:v1:voice-workspace:single:user:owner-a')), pendingA);
  assert.equal(await page.evaluate(() => localStorage.getItem('production-client-attempt:v1:voice-workspace:single:user:owner-b')), 'B-SENTINEL'); cases.push('Late owner A unknown result preserves A original key and cannot clear B attempt');
  await page.getByPlaceholder('输入要合成的文本内容...').fill('OWNER_B_DRAFT');
  await page.evaluate(() => globalThis.setFixtureAuth({ isAuthenticated: true, user: { id: 'owner-b' }, token: 'fixture-b-refreshed' }));
  assert.equal(await page.getByPlaceholder('输入要合成的文本内容...').inputValue(), 'OWNER_B_DRAFT'); cases.push('Same-owner token refresh preserves that owner draft');
  await page.getByRole('button', { name: 'seed-audio 1.0', exact: true }).click();
  assert.equal(await page.getByLabel('模型版本', { exact: true }).inputValue(), 'seed-audio-1.0'); assert.equal(await page.getByLabel('选择音色搜索', { exact: true }).count(), 0); assert.equal(await page.locator('input[type="range"]').count(), 0); assert.equal(await page.locator('input[type="checkbox"]').count(), 0);
  assert.deepEqual(await page.locator('select').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))), ['模型版本', '音频格式', '采样率']); cases.push('Audio mode renders only actual model/format/sample-rate plus reference and prompt inputs');
  await page.getByRole('button', { name: 'Doubao-TTS 2.0', exact: true }).click(); assert.equal(await page.getByPlaceholder('输入要合成的文本内容...').inputValue(), 'OWNER_B_DRAFT'); cases.push('Switching audio/TTS modes preserves the current owner TTS draft');
  await page.getByRole('button', { name: /混音合成/u, exact: true }).click();
  const options = await page.getByLabel('混音音色 1', { exact: true }).locator('option').evaluateAll(elements => elements.map(element => element.value).filter(Boolean));
  assert.deepEqual(options, ['zh_female_shuangkuaisisi_moon_bigtts', 'zh_male_wennuanahu_moon_bigtts']); assert.equal(await page.getByLabel('选择音色搜索', { exact: true }).count(), 0); cases.push('Mix options contain only the two documented 1.0 MIX voices; no misleading 2.0 picker');
  await page.evaluate(() => globalThis.setFixtureAuth({ isAuthenticated: false, user: null, token: null })); await page.getByText('请登录后使用智音工坊', { exact: true }).waitFor(); assert.equal(await page.locator('textarea').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('production-client-attempt:v1:voice-workspace:single:user:owner-a')), pendingA); cases.push('Logout unmounts private UI while preserving unresolved owner-scoped attempts');
  assert.equal(await page.evaluate(() => globalThis.fixturePosts.length), 1); await context.close();
  const report = { passed: true, scenarios: cases.length, cases, actualReactPage: true, simulatedTtsRequests: 1, realNetworkCalls: 0, realDatabaseWrites: 0 };
  await fs.writeFile('.codex-evidence/voice-models-real-e2e-20260903/owner-ui-fixture.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }
