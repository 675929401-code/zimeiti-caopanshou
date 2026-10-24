import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

const AGENT_ID = 'agent-1786843330392-emdjv2';
const CONTRACT = 'storyboard_performance.v1';
const DIRECTORY = '.codex-evidence/director-refinement-20261023/energy-followup';
const wire = value => `<!-- ${value.phase === 'assets' ? 'storyboard_director_assets' : 'storyboard_director_output'}:v1 ${JSON.stringify(value)} -->`;
const intakeText = input => Object.entries(input).map(([key, value]) => `${key}: ${value}`).join('\n');

// The launcher supplies credentials only in RAM. Every browser mutation is intercepted.
export async function main(args = []) {
  assert.equal(args.includes('--text-canary') || process.argv.includes('--text-canary'), false, 'Text canaries are outside this replay');
  const origin = process.env.LOCAL_NAV_ORIGIN;
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const user = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}').user;
  assert.equal(origin, 'http://127.0.0.1:5000'); assert.ok(token && user?.id);
  const output = `${DIRECTORY}/browser`;
  await fs.mkdir(output, { recursive: true });
  const report = { scope: 'real Edge UI with authored conversation/project fixtures; no live generation or business writes',
    startedAt: new Date().toISOString(), checks: [], pages: [], mockedWrites: {}, projectSaves: 0, conversationWrites: 0,
    blockedGenerationRequests: 0, serverBusinessWrites: 0, errors: [], artisticQuality: 'not_evaluated' };
  let browser;
  let activePage;
  try {
    const pins = JSON.parse(await fs.readFile('.next/local-source-fingerprint.v1.json', 'utf8'));
    assert.equal(pins.fingerprint, computeLocalBuildFingerprint(process.cwd()).fingerprint, 'SOURCE_CHANGED_BEFORE_BROWSER');
    const versionResponse = await fetch(`${origin}/api/version`); assert.ok(versionResponse.ok);
    const version = await versionResponse.json(); assert.equal(version.buildId, pins.buildId);
    report.runtime = { buildId: version.buildId, sourceVersion: version.sourceVersion, sourceFingerprint: pins.fingerprint };

    // Read the real public DTO; never mock missing quality-contract configuration.
    const catalogResponse = await fetch(`${origin}/api/bots?shape=agents`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    assert.ok(catalogResponse.ok, 'PUBLIC_CATALOG_READ_FAILED');
    const catalog = await catalogResponse.json();
    const agent = (catalog.agents || catalog.bots || []).find(item => item.id === AGENT_ID);
    assert.ok(agent, 'OFFICIAL_HIGH_ENERGY_AGENT_MISSING');
    const style = agent.output_style;
    assert.equal(style?.performance_contract, CONTRACT, 'REAL_PUBLIC_PERFORMANCE_CONTRACT_NOT_DELIVERED');
    assert.equal(style.production_contract_version, 'storyboard_director_contract.v2');
    const activatedAt = Date.parse(style.performance_contract_activated_at); assert.ok(Number.isFinite(activatedAt));
    assert.deepEqual(Object.keys(style).sort(), ['production_contract_version', 'production_contract_activated_at', 'performance_contract', 'performance_contract_activated_at'].sort());
    report.publicContract = { source: 'real /api/bots?shape=agents', ...style };
    report.checks.push('real public official-agent DTO delivers only the four quality-contract scalars');

    const ordinary = JSON.parse(await fs.readFile(`${DIRECTORY}/prompt-ordinary-example.json`, 'utf8'));
    const assets = JSON.parse(await fs.readFile(`${DIRECTORY}/prompt-assets-only-example.json`, 'utf8'));
    assert.ok(ordinary.segments[0].performance_plan, 'PERFORMANCE_FIXTURE_REQUIRED');
    const missing = structuredClone(ordinary);
    for (const segment of missing.segments) delete segment.performance_plan;
    const currentTime = Math.max(Date.now(), activatedAt + 60_000);
    const scenarios = new Map();
    function conversation(id, title, payload, timestamp) {
      const messages = [
        { id: `${id}-user`, role: 'user', content: intakeText(payload.input), agent_id: AGENT_ID, created_at: new Date(timestamp).toISOString() },
        { id: `${id}-assistant`, role: 'assistant', content: wire(payload), agent_id: AGENT_ID, created_at: new Date(timestamp + 1000).toISOString() },
      ];
      scenarios.set(id, { id, title, agent_id: AGENT_ID, created_at: new Date(timestamp).toISOString(), updated_at: new Date(timestamp + 1000).toISOString(), last_message: title, messages });
    }
    conversation('engineering-energy-current', '工程回放｜高能动作表情', ordinary, currentTime);
    conversation('engineering-energy-missing', '工程回放｜新回复缺动作计划', missing, currentTime + 2000);
    conversation('engineering-energy-historic', '工程回放｜旧时间回复兼容', missing, activatedAt - 60_000);
    conversation('engineering-energy-assets', '工程回放｜三视图资产阶段', assets, currentTime + 4000);
    const projects = new Map();

    browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(({ token, user, origin }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user));
      if (!localStorage.getItem('engineering_energy_initialized')) {
        localStorage.setItem('active_view', 'chat'); localStorage.setItem('active_conversation_id', 'engineering-energy-current');
        localStorage.setItem('engineering_energy_initialized', '1');
      }
      sessionStorage.setItem('entered_app', '1');
    }, { token, user, origin });
    await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/api/**', async route => {
      const request = route.request(); const url = new URL(request.url()); const method = request.method();
      const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/auth/me') return respond({ user: { ...user, credits: 0, reservedCredits: 0, is_active: true, status: 'active', memberStatus: 'inactive', allowedCategories: [], themePreference: null, themeModePreference: null, themePreferenceStatus: 'missing' } });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        report.mockedWrites[url.pathname] = (report.mockedWrites[url.pathname] || 0) + 1;
        if (url.pathname === '/api/chat' || /^\/api\/llm(?:\/|$)/u.test(url.pathname) || /^\/api\/(?:image|video)\/(?:generate|submit|create)/u.test(url.pathname)) {
          report.blockedGenerationRequests++;
          return respond({ error: 'Engineering replay blocks generation', code: 'ENGINEERING_GENERATION_BLOCKED' }, 403);
        }
        if (url.pathname === '/api/storyboard/projects' && method === 'POST') {
          const body = request.postDataJSON(); const document = structuredClone(body.document); assert.ok(document?.id);
          const previous = projects.get(document.id);
          if (Number(body.expectedRevision || 0) !== (previous?.revision || 0)) return respond({ error: 'Engineering revision mismatch' }, 409);
          const project = { id: document.id, title: document.title, revision: (previous?.revision || 0) + 1, cardCount: document.cards.length,
            createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), document };
          projects.set(document.id, project); report.projectSaves++;
          const { document: _document, ...summary } = project; return respond({ project: summary });
        }
        if (url.pathname === '/api/conversations/history') { report.conversationWrites++; return respond({ ok: true }); }
        return respond({ ok: true });
      }
      if (url.pathname === '/api/conversations/history') {
        const id = url.searchParams.get('id');
        if (id) return scenarios.has(id) ? respond({ conversation: scenarios.get(id) }) : respond({ error: 'Engineering conversation not found' }, 404);
        return respond({ conversations: [...scenarios.values()].map(({ messages: _messages, ...summary }) => summary) });
      }
      if (url.pathname === '/api/storyboard/projects') {
        const id = url.searchParams.get('id');
        if (id) return projects.has(id) ? respond({ project: projects.get(id) }) : respond({ error: 'Engineering project not found', code: 'PROJECT_NOT_FOUND' }, 404);
        return respond({ projects: [...projects.values()].map(({ document: _document, ...summary }) => summary), nextOffset: null });
      }
      if (url.pathname === '/api/storyboard/visual-assets') return respond({ assets: [], nextOffset: null });
      return route.continue();
    });
    const register = page => page.on('pageerror', error => report.errors.push(error.message.slice(0, 400).replaceAll(token, '[REDACTED]')));
    context.on('page', register);
    const page = await context.newPage(); activePage = page;
    const waitRam = async predicate => {
      const deadline = Date.now() + 30_000;
      while (!predicate()) { assert.ok(Date.now() < deadline, 'RAM_PROJECT_SAVE_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 50)); }
    };
    const capture = async (target, name, ready) => {
      await ready.waitFor({ state: 'visible', timeout: 30_000 });
      await ready.scrollIntoViewIfNeeded();
      await target.evaluate(() => document.fonts.ready);
      const layout = await target.evaluate(() => ({ viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
      assert.ok(layout.documentWidth <= layout.viewportWidth + 2 && layout.bodyWidth <= layout.viewportWidth + 2, `${name}: horizontal page overflow`);
      report.pages.push({ name, route: new URL(target.url()).pathname, ...layout });
      await target.screenshot({ path: `${output}/${name}.png`, fullPage: false });
    };
    const openConversation = async id => {
      if (page.url() !== 'about:blank') await page.evaluate(id => { localStorage.setItem('active_view', 'chat'); localStorage.setItem('active_conversation_id', id); }, id);
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const assistant = page.locator('article[data-message-role="assistant"]').first();
      await assistant.waitFor({ state: 'visible', timeout: 30_000 }); return assistant;
    };
    const push = async source => {
      const button = source.getByRole('button', { name: '推送至分镜工作台', exact: true });
      await button.waitFor({ state: 'visible', timeout: 30_000 }); assert.equal(await button.isEnabled(), true);
      const popupPromise = page.waitForEvent('popup', { timeout: 30_000 }); await button.click();
      const popup = await popupPromise; activePage = popup;
      await popup.waitForURL(url => url.pathname === '/storyboard-workbench' && url.searchParams.get('entry') === 'agent', { timeout: 30_000 });
      return popup;
    };

    const assistant = await openConversation('engineering-energy-current');
    const performance = ordinary.segments[0].performance_plan;
    await assistant.getByText('演绎重点', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.ok((await assistant.innerText()).includes(performance.semantic_event));
    assert.ok((await assistant.innerText()).includes(performance.end_state));
    assert.equal(await assistant.getByText('主峰', { exact: true }).count(), 1); assert.equal(await assistant.getByText('段末', { exact: true }).count(), 1);
    await assistant.getByText('演绎重点', { exact: true }).scrollIntoViewIfNeeded();
    await capture(page, 'chat-performance-summary', assistant.getByText('演绎重点', { exact: true }));
    report.checks.push('real chat renderer shows semantic event, Chinese peak mode and end state from the machine performance plan');
    const workbench = await push(page);
    await workbench.getByRole('textbox', { name: '分段1生图提示词', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    await waitRam(() => [...projects.values()].some(project => project.document.cards.some(card => card.directorExecution?.performancePlan)));
    const saved = [...projects.values()].find(project => project.document.cards.some(card => card.directorExecution?.performancePlan));
    await workbench.waitForURL(url => url.searchParams.get('projectId') === saved.id, { timeout: 30_000 });
    assert.deepEqual(saved.document.cards[0].directorExecution.performancePlan, performance);
    assert.equal(await workbench.getByRole('textbox', { name: '分段1生图提示词', exact: true }).inputValue(), ordinary.segments[0].storyboard_image_prompt);
    assert.equal(await workbench.getByRole('textbox', { name: '分段1视频提示词', exact: true }).inputValue(), ordinary.segments[0].image_to_video_prompt);
    await capture(workbench, 'pushed-workbench', workbench.getByRole('button', { name: '添加分镜', exact: true }));
    await workbench.goto(`${origin}/storyboard-workbench?projectId=${encodeURIComponent(saved.id)}`, { waitUntil: 'domcontentloaded' });
    await workbench.getByRole('textbox', { name: '分段1生图提示词', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await workbench.getByRole('textbox', { name: '分段1生图提示词', exact: true }).inputValue(), ordinary.segments[0].storyboard_image_prompt);
    assert.equal(await workbench.getByRole('textbox', { name: '分段1视频提示词', exact: true }).inputValue(), ordinary.segments[0].image_to_video_prompt);
    assert.deepEqual(projects.get(saved.id).document.cards[0].directorExecution.performancePlan, performance);
    await capture(workbench, 'restored-workbench', workbench.getByRole('button', { name: '添加分镜', exact: true }));
    report.checks.push('actual one-click popup handoff saves the exact plan and both prompts to RAM projects and restores the same workbench values');
    await workbench.close(); activePage = page;

    const beforeMissing = report.projectSaves;
    const blocked = await openConversation('engineering-energy-missing');
    await blocked.getByText(/动作与表情结构尚未就绪/u).first().waitFor({ state: 'visible', timeout: 30_000 });
    const missingPush = page.getByRole('button', { name: '推送至分镜工作台', exact: true });
    for (let index = 0; index < await missingPush.count(); index++) assert.equal(await missingPush.nth(index).isEnabled(), false);
    assert.equal(report.projectSaves, beforeMissing);
    await capture(page, 'new-message-missing-plan-blocked', blocked);
    report.checks.push('new timestamp plus real active performance flag blocks a legacy package without creating a project');

    const historic = await openConversation('engineering-energy-historic');
    await historic.locator('pre').first().waitFor({ state: 'visible', timeout: 30_000 });
    const historicPush = page.getByRole('button', { name: '推送至分镜工作台', exact: true });
    await historicPush.waitFor({ state: 'visible', timeout: 30_000 }); assert.equal(await historicPush.isEnabled(), true);
    await capture(page, 'historic-message-compatible', historic);
    report.checks.push('the same old v2 package remains readable and eligible under its original pre-activation timestamp');

    const assetMessage = await openConversation('engineering-energy-assets');
    await assetMessage.getByText(/三视图/u).first().waitFor({ state: 'visible', timeout: 30_000 });
    const assetPage = await push(page);
    await assetPage.getByTestId('director-assets-first-stage').waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await assetPage.locator('.sbw-shot-card').count(), 0);
    await waitRam(() => [...projects.values()].some(project => project.document.directorIntake?.phase === 'assets'));
    const assetProject = [...projects.values()].find(project => project.document.directorIntake?.phase === 'assets');
    await assetPage.waitForURL(url => url.searchParams.get('projectId') === assetProject.id, { timeout: 30_000 });
    assert.equal(assetProject.document.visualAssetWorkspace.drafts.length, assets.visual_asset_plan.assets.length);
    assert.equal(assetProject.document.cards.some(card => card.imagePrompt || card.videoPrompt || card.directorExecution?.performancePlan), false);
    assert.equal(assetProject.document.visualAssetPlan.assets.some(asset => asset.source), false);
    await capture(assetPage, 'assets-only-handoff', assetPage.getByTestId('director-assets-first-stage'));
    report.checks.push('reference assets without performance can be pushed as neutral role drafts, with no storyboard prompts or adopted-image claims');
    await assetPage.close(); activePage = page;

    await page.evaluate(() => localStorage.setItem('active_view', 'marketplace'));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await capture(page, 'adjacent-home', page.locator('[aria-label^="打开智能体："][aria-label*="高能版"]').first());
    await page.goto(`${origin}/video`, { waitUntil: 'domcontentloaded' });
    await capture(page, 'adjacent-video', page.getByRole('heading', { name: 'AI 视频创作台', exact: true }));
    assert.equal(report.blockedGenerationRequests, 0); assert.equal(report.serverBusinessWrites, 0); assert.deepEqual(report.errors, []);
    assert.equal(pins.fingerprint, computeLocalBuildFingerprint(process.cwd()).fingerprint, 'SOURCE_CHANGED_DURING_BROWSER');
    report.passed = true;
  } catch (error) {
    report.failure = { name: error instanceof Error ? error.name : 'Error', message: String(error instanceof Error ? error.message : error).slice(0, 1500).replaceAll(token, '[REDACTED]') };
    await activePage?.screenshot({ path: `${output}/failure.png`, fullPage: false }).catch(() => undefined);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString(); await fs.writeFile(`${output}/result.json`, JSON.stringify(report, null, 2) + '\n');
    await browser?.close();
  }
  console.log(JSON.stringify(report, null, 2));
}
