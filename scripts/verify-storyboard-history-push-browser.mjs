import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

// Real saved replies are read once; all browser mutations and projects stay in RAM.
export async function main() {
  const origin = process.env.LOCAL_NAV_ORIGIN;
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const user = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}').user;
  assert.equal(origin, 'http://127.0.0.1:5000'); assert.ok(token && user?.id);
  const output = '.codex-evidence/director-refinement-20261023/continuous-followup/history-browser';
  await fs.mkdir(output, {recursive: true});
  const report = {scope: 'actual saved historical replies, real Edge UI, RAM-only project persistence', checks: [], pages: [], errors: [], mockedProjectSaves: 0, blockedGenerationRequests: 0, serverBusinessWrites: 0};
  const read = async route => {const response = await fetch(`${origin}${route}`, {headers: {Authorization: `Bearer ${token}`}}); assert.ok(response.ok); return response.json();};
  const pins = JSON.parse(await fs.readFile('.next/local-source-fingerprint.v1.json', 'utf8'));
  assert.equal(pins.fingerprint, computeLocalBuildFingerprint(process.cwd()).fingerprint);
  const version = await read('/api/version'); assert.equal(version.buildId, pins.buildId);
  report.runtime = {buildId: version.buildId, sourceVersion: version.sourceVersion};
  const history = await read('/api/conversations/history');
  const rows = history.conversations.filter(row => row.agent_id === 'agent-1786843330392-emdjv2').slice(0, 3);
  assert.equal(rows.length, 3);
  const screenshotId = 'local_1792518690825_60t6u7';
  const screenshot = history.conversations.find(row => row.id === screenshotId);
  assert.ok(screenshot, 'EXACT_SCREENSHOT_CONVERSATION_REQUIRED');
  const screenshotRow = {...screenshot, expectedMessageId: '3dd47709-be66-418b-8cc9-d9494785356b', expectedCards: 13};
  const existing = rows.findIndex(row => row.id === screenshotId);
  if (existing >= 0) rows[existing] = screenshotRow; else rows.push(screenshotRow);
  const scenarios = new Map();
  for (const row of rows) {
    const conversation = (await read(`/api/conversations/history?id=${encodeURIComponent(row.id)}`)).conversation;
    if (row.expectedMessageId) {
      const index = conversation.messages.findIndex(message => message.id === row.expectedMessageId);
      assert.ok(index >= 0, 'EXACT_SCREENSHOT_MESSAGE_REQUIRED');
      conversation.messages = conversation.messages.slice(0, index + 1);
    }
    scenarios.set(row.id, conversation);
  }
  const projects = new Map();
  let browser; let activePage;
  const waitFor = async predicate => {const deadline = Date.now() + 30000; while (!predicate()) {assert.ok(Date.now() < deadline, 'RAM_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 50));}};
  try {
    browser = await chromium.launch({headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, serviceWorkers: 'block'});
    await context.addInitScript(({token, user, origin, first}) => {
      if (location.origin !== origin) return;
      localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user));
      if (!localStorage.getItem('engineering_history_initialized')) {
        localStorage.setItem('active_view', 'chat'); localStorage.setItem('active_conversation_id', first); localStorage.setItem('engineering_history_initialized', '1');
      }
      sessionStorage.setItem('entered_app', '1');
    }, {token, user, origin, first: rows[0].id});
    await context.addCookies([{name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax'}]);
    await context.route('**/api/**', async route => {
      const request = route.request(); const url = new URL(request.url()); const method = request.method();
      const respond = (body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
      if (url.pathname === '/api/auth/me') return respond({user: {...user, credits: 0, reservedCredits: 0, is_active: true, status: 'active', memberStatus: 'inactive', allowedCategories: [], themePreferenceStatus: 'missing'}});
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (/^\/api\/(?:llm|chat|image\/generate|video\/generate)/u.test(url.pathname)) {report.blockedGenerationRequests++; return respond({error: 'Engineering generation blocked'}, 403);}
        if (url.pathname === '/api/storyboard/projects' && method === 'POST') {
          const body = request.postDataJSON(); const document = structuredClone(body.document); assert.ok(document?.id);
          const previous = projects.get(document.id);
          if (Number(body.expectedRevision || 0) !== (previous?.revision || 0)) return respond({error: 'Revision conflict'}, 409);
          const project = {id: document.id, title: document.title, revision: (previous?.revision || 0) + 1, cardCount: document.cards.length, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), document};
          projects.set(document.id, project); report.mockedProjectSaves++;
          const {document: ignored, ...summary} = project; void ignored; return respond({project: summary});
        }
        return respond({ok: true});
      }
      if (url.pathname === '/api/conversations/history') {
        const id = url.searchParams.get('id');
        return id ? respond({conversation: scenarios.get(id)}) : respond({conversations: [...scenarios.values()].map(conversation => ({...conversation, messages: []}))});
      }
      if (url.pathname === '/api/storyboard/projects') {
        const id = url.searchParams.get('id');
        if (id) return projects.has(id) ? respond({project: projects.get(id)}) : respond({code: 'PROJECT_NOT_FOUND', error: 'Not found'}, 404);
        return respond({projects: [...projects.values()].map(({document, ...summary}) => {void document; return summary;}), nextOffset: null});
      }
      return route.continue();
    });
    context.on('page', page => page.on('pageerror', error => report.errors.push(error.message.slice(0, 400).replaceAll(token, '[REDACTED]'))));
    const page = await context.newPage(); activePage = page;
    const capture = async (target, name) => {
      await target.evaluate(() => document.fonts.ready);
      const width = await target.evaluate(() => ({viewport: innerWidth, document: document.documentElement.scrollWidth}));
      assert.ok(width.document <= width.viewport + 2, `${name}: overflow`); report.pages.push({name, route: new URL(target.url()).pathname, ...width});
      await target.screenshot({path: `${output}/${name}.png`, fullPage: false});
    };
    for (const [index, row] of rows.entries()) {
      if (index) await page.evaluate(id => {localStorage.setItem('active_view', 'chat'); localStorage.setItem('active_conversation_id', id);}, row.id);
      await page.goto(origin, {waitUntil: 'domcontentloaded'});
      const button = page.getByRole('button', {name: '作为历史草稿推送', exact: true}).last();
      await button.waitFor({state: 'visible', timeout: 30000}); assert.equal(await button.isEnabled(), true);
      await button.scrollIntoViewIfNeeded(); await capture(page, `history-${index + 1}-enabled`);
      const popupPromise = page.waitForEvent('popup'); await button.click(); const workbench = await popupPromise; activePage = workbench;
      await workbench.waitForURL(url => url.pathname === '/storyboard-workbench' && Boolean(url.searchParams.get('projectId')), {timeout: 30000});
      const id = new URL(workbench.url()).searchParams.get('projectId'); await waitFor(() => projects.has(id));
      const document = projects.get(id).document;
      const original = scenarios.get(row.id).messages.filter(message => message.role === 'assistant').at(-1).content.split(/<!--\s*storyboard_director_output:v1/u)[0];
      const blocks = [...original.matchAll(/(^|\n)(`{3,})(?:text|txt|prompt)?[ \t]*\n([\s\S]*?)\n\2(?=\n|$)/giu)].map(match => match[3].trim());
      assert.equal(document.cards.length, blocks.length / 2); assert.ok(document.draftImportNotice);
      if (row.expectedMessageId) {
        const serialized = JSON.stringify(document, null, 2);
        assert.equal(serialized.includes(token), false);
        await fs.writeFile(`${output}/imported-screenshot-draft-document.json`, serialized);
      }
      if (row.expectedCards) {
        assert.equal(blocks.length, row.expectedCards * 2); assert.equal(document.cards.length, row.expectedCards);
        assert.ok(document.draftImportNotice.includes('未记录视觉资产模式'));
      }
      for (const [cardIndex, card] of document.cards.entries()) {
        assert.equal(card.imagePrompt, blocks[cardIndex * 2]); assert.equal(card.videoPrompt, blocks[cardIndex * 2 + 1]); assert.equal(card.directorExecution, undefined);
      }
      assert.equal(await workbench.getByTestId('storyboard-continuous-production').count(), 0);
      await workbench.getByText(/历史提示词草稿/u).first().waitFor({state: 'visible'}); await capture(workbench, `history-${index + 1}-imported`);
      await workbench.reload({waitUntil: 'domcontentloaded'});
      await workbench.getByRole('textbox', {name: '分段1生图提示词', exact: true}).waitFor({state: 'visible', timeout: 30000});
      assert.equal(await workbench.getByRole('textbox', {name: '分段1生图提示词', exact: true}).inputValue(), blocks[0]);
      report.checks.push({conversationId: row.id, messageId: row.expectedMessageId, cards: document.cards.length, originalPromptsPreserved: true, refreshRestored: true});
      await workbench.close(); activePage = page;
    }
    for (const route of ['/storyboard-workbench/history', '/video']) {
      await page.goto(`${origin}${route}`, {waitUntil: 'domcontentloaded'}); await page.waitForTimeout(1000); await capture(page, route.includes('history') ? 'adjacent-history' : 'adjacent-video');
    }
    assert.equal(report.blockedGenerationRequests, 0); assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) {report.passed = false; report.error = String(error.message || error).replaceAll(token, '[REDACTED]'); if (activePage) await activePage.screenshot({path: `${output}/failure.png`}).catch(() => {}); throw error;}
  finally {report.finishedAt = new Date().toISOString(); await fs.writeFile(`${output}/result.json`, JSON.stringify(report, null, 2)); await browser?.close(); console.log(JSON.stringify(report, null, 2));}
}
