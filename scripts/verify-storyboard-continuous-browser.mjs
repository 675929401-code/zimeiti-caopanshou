import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { computeLocalBuildFingerprint } from './local-build-fingerprint.mjs';

const DIRECTORY = '.codex-evidence/director-refinement-20261023/continuous-followup';
const AGENT_ID = 'agent-1786843330392-emdjv2';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const intakeText = input => Object.entries(input).map(([key, value]) => `${key}: ${value}`).join('\n');
const wire = payload => `<!-- ${payload.phase === 'planned' ? 'storyboard_director_plan' : 'storyboard_director_output'}:v1 ${JSON.stringify(payload)} -->`;
const hash = value => createHash('sha256').update(value).digest('hex');
const omit = (value, key) => { const copy = { ...value }; delete copy[key]; return copy; };
const svg = ratio => {
  const [w, h] = String(ratio || '16:9').split(':').map(Number);
  const width = w > h ? 960 : 540; const height = Math.round(width * h / w);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#d7e2e5"/><g fill="#586e79"><circle cx="${width * .22}" cy="${height * .42}" r="${width * .11}"/><circle cx="${width * .5}" cy="${height * .42}" r="${width * .11}"/><circle cx="${width * .78}" cy="${height * .42}" r="${width * .11}"/></g><text x="50%" y="75%" text-anchor="middle" fill="#20333c" font-size="${width / 26}">ENGINEERING FIXTURE</text><text x="50%" y="82%" text-anchor="middle" fill="#20333c" font-size="${width / 36}">NO AI GENERATED MEDIA</text></svg>`;
};

// The controlled launcher supplies credentials only in RAM. Every mutation and
// every non-loopback browser request is intercepted before reaching a server.
export async function main(args = []) {
  assert.equal(args.includes('--text-canary') || process.argv.includes('--text-canary'), false);
  const origin = process.env.LOCAL_NAV_ORIGIN;
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const user = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}').user;
  assert.equal(origin, 'http://127.0.0.1:5000'); assert.ok(token && user?.id);
  const output = `${DIRECTORY}/browser`;
  await fs.mkdir(output, { recursive: true });
  const report = { scope: 'real Edge chat and workbench callbacks with RAM-only engineering fixtures', startedAt: new Date().toISOString(),
    checks: [], pages: [], mockedWrites: {}, generationEvents: [], projectSaves: 0, proofReads: 0,
    blockedExternalRequests: [], blockedUnknownWrites: [], serverBusinessWrites: 0, liveGenerationRequests: 0, errors: [],
    limitations: ['Synthetic media and completed mock responses do not establish model output quality or real billing.'] };
  let browser; let activePage; let videoBytes;
  const projects = new Map(); const records = new Map(); const ownedImages = new Map(); const attempts = new Map(); const scenarios = new Map();
  let rejectNextBoard = false;
  try {
    const pins = JSON.parse(await fs.readFile('.next/local-source-fingerprint.v1.json', 'utf8'));
    assert.equal(pins.fingerprint, computeLocalBuildFingerprint(process.cwd()).fingerprint, 'BUILD_SOURCE_MISMATCH');
    const versionResponse = await fetch(`${origin}/api/version`); assert.ok(versionResponse.ok);
    const version = await versionResponse.json(); assert.equal(version.buildId, pins.buildId);
    report.runtime = { buildId: version.buildId, sourceVersion: version.sourceVersion, sourceFingerprint: pins.fingerprint };
    const catalogResponse = await fetch(`${origin}/api/bots?shape=agents`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    assert.ok(catalogResponse.ok);
    const catalog = await catalogResponse.json(); const agent = (catalog.agents || catalog.bots || []).find(item => item.id === AGENT_ID);
    assert.equal(agent?.output_style?.performance_contract, 'storyboard_performance.v1', 'REAL_AGENT_CONTRACT_REQUIRED');
    const activatedAt = Date.parse(agent.output_style.performance_contract_activated_at); assert.ok(Number.isFinite(activatedAt));
    report.publicContract = { source: 'real local /api/bots?shape=agents', ...agent.output_style };
    const planned = JSON.parse(await fs.readFile(`${DIRECTORY}/prompt-complete-plan-example.json`, 'utf8'));
    const ordinary = JSON.parse(await fs.readFile('.codex-evidence/director-refinement-20261023/energy-followup/prompt-ordinary-example.json', 'utf8'));
    assert.equal(planned.phase, 'planned'); assert.ok(planned.segments.every(segment => segment.performance_plan));
    const timestamp = Math.max(Date.now(), activatedAt + 60_000);
    for (const [index, payload] of [planned, ordinary].entries()) {
      const id = index ? 'engineering-continuous-ordinary' : 'engineering-continuous-planned';
      const title = index ? '工程回放｜普通模式失败不重派' : '工程回放｜完整计划与连续制作';
      scenarios.set(id, { id, title, agent_id: AGENT_ID, created_at: new Date(timestamp + index * 2000).toISOString(), updated_at: new Date(timestamp + index * 2000 + 1000).toISOString(), last_message: title,
        messages: [{ id: `${id}-user`, role: 'user', content: intakeText(payload.input), agent_id: AGENT_ID, created_at: new Date(timestamp + index * 2000).toISOString() },
          { id: `${id}-assistant`, role: 'assistant', content: wire(payload), agent_id: AGENT_ID, created_at: new Date(timestamp + index * 2000 + 1000).toISOString() }] });
    }
    browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(({ origin, token, user }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user));
      if (!localStorage.getItem('engineering_continuous_initialized')) {
        localStorage.setItem('active_view', 'chat'); localStorage.setItem('active_conversation_id', 'engineering-continuous-planned');
        localStorage.setItem('engineering_continuous_initialized', '1');
      }
      sessionStorage.setItem('entered_app', '1');
    }, { origin, token, user });
    await context.addCookies([{ name: 'auth_token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url()); const method = request.method();
      const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.origin !== origin) {
        report.blockedExternalRequests.push({ method, origin: url.origin, path: url.pathname });
        return route.abort('blockedbyclient');
      }
      if (!SAFE_METHODS.has(method)) {
        report.mockedWrites[url.pathname] = (report.mockedWrites[url.pathname] || 0) + 1;
        if (url.pathname === '/api/storyboard/projects' && method === 'POST') {
          const body = request.postDataJSON(); const document = structuredClone(body.document); assert.ok(document?.id);
          const previous = projects.get(document.id);
          if (Number(body.expectedRevision || 0) !== (previous?.revision || 0)) return respond({ code: 'REVISION_CONFLICT', error: 'Engineering revision mismatch' }, 409);
          const project = { id: document.id, title: document.title, revision: (previous?.revision || 0) + 1, cardCount: document.cards.length,
            createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), document };
          projects.set(project.id, project); report.projectSaves++;
          return respond({ project: omit(project, 'document') });
        }
        if (url.pathname === '/api/conversations/history' || url.pathname === '/api/product-usage/events' || url.pathname === '/api/operation-events' || url.pathname === '/api/diagnostic-logs') return respond({ ok: true });
        if (url.pathname === '/api/image/generate' && method === 'POST') {
          const body = request.postDataJSON();
          const project = [...projects.values()].find(item => String(body.clientNodeId).startsWith(`${item.id}-`)); assert.ok(project, 'GENERATION_REQUIRES_SAVED_PROJECT');
          const asset = project.document.visualAssetPlan?.assets.find(item => body.clientNodeId === `${project.id}-${item.id}`);
          const kind = asset ? 'reference' : 'image'; const recordId = hash(body.clientIdempotencyKey || body.clientTraceId);
          const event = { sequence: report.generationEvents.length + 1, kind, projectId: project.id, assetId: asset?.id,
            cardOrder: asset ? undefined : Number(String(body.clientNodeId).split('-shot-').at(-1)), requestKey: body.clientIdempotencyKey, resumeDeliveryOnly: body.resumeDeliveryOnly === true };
          report.generationEvents.push(event);
          if (!asset && rejectNextBoard) {
            rejectNextBoard = false; const rejected = { state: 'rejected', canResubmit: true, upstreamCalled: false, billed: false, taskSubmitted: false, error: '工程回放：本次分镜请求明确未受理' };
            attempts.set(body.clientIdempotencyKey, rejected); return respond(rejected, 503);
          }
          const record = { recordId, projectId: project.id, ratio: body.aspectRatio, prompt: body.prompt,
            ...(asset ? { candidate: { assetId: `generated_${recordId}`, historyRecordId: recordId, projectId: project.id, planId: asset.id, role: asset.role, name: asset.name, prompt: body.prompt, saved: false } } : {}) };
          records.set(recordId, record);
          const imageUrl = `${origin}/api/media-history/content?recordId=${recordId}`;
          attempts.set(body.clientIdempotencyKey, { state: 'completed', deliveryMode: 'provider_url', recordId, delivered: true });
          if (asset) return respond({ images: [{ url: imageUrl, recordId }], recordId });
          const assetId = `11111111-1111-4111-8111-${String(ownedImages.size + 1).padStart(12, '0')}`;
          const storageKey = `engineering/${assetId}.png`; const owned = { ...record, assetId, storageKey, url: imageUrl };
          ownedImages.set(assetId, owned);
          const [rw, rh] = body.aspectRatio.split(':').map(Number); const width = rw > rh ? 960 : 540; const height = Math.round(width * rh / rw);
          return respond({ images: [{ url: imageUrl, recordId, assetId, storageKey, deliveryMode: 'provider_url', width, height }], recordId, cashCharged: 0 });
        }
        if (url.pathname === '/api/video/generate' && method === 'POST') {
          const body = request.postDataJSON(); const project = projects.get(body.batch_id); assert.ok(project);
          assert.ok(project.document.cards.every(card => card.imageStatus === 'done' && card.imageValidatedAt), 'VIDEO_DISPATCHED_BEFORE_VALID_IMAGES');
          report.generationEvents.push({ sequence: report.generationEvents.length + 1, kind: 'video', projectId: project.id, cardOrder: body.card_index, requestKey: body.client_request_id });
          const taskId = `engineering_video_${report.generationEvents.length}`;
          return respond({ task_id: taskId, status: 'completed', video_url: `${origin}/api/engineering-fixtures/video.webm`, billing_state: 'settled', price: 0 });
        }
        report.blockedUnknownWrites.push({ method, path: url.pathname });
        return respond({ error: 'Engineering replay blocks all other mutations', code: 'ENGINEERING_MUTATION_BLOCKED' }, 403);
      }
      if (url.pathname === '/api/auth/me') return respond({ user: { ...user, credits: 0, reservedCredits: 0, is_active: true, status: 'active', memberStatus: 'inactive', allowedCategories: [], themePreference: null, themeModePreference: null, themePreferenceStatus: 'missing' } });
      if (url.pathname === '/api/credits') return respond({ cashBalance: 1_000_000, reservedCashBalance: 0 });
      if (url.pathname === '/api/conversations/history') {
        const id = url.searchParams.get('id'); return id ? respond({ conversation: scenarios.get(id) }) : respond({ conversations: [...scenarios.values()].map(item => omit(item, 'messages')) });
      }
      if (url.pathname === '/api/storyboard/projects') {
        const id = url.searchParams.get('id'); return id ? projects.has(id) ? respond({ project: projects.get(id) }) : respond({ code: 'PROJECT_NOT_FOUND', error: 'Engineering project not found' }, 404)
          : respond({ projects: [...projects.values()].map(item => omit(item, 'document')), nextOffset: null });
      }
      if (url.pathname === '/api/storyboard/visual-assets') {
        const recordId = url.searchParams.get('recordId'); return recordId ? respond({ reference: { recordId, previewUrl: `${origin}/api/media-history/content?recordId=${recordId}` } }) : respond({ assets: [], nextOffset: null });
      }
      if (url.pathname === '/api/storyboard/director-assets/original') {
        report.proofReads++;
        const project = projects.get(url.searchParams.get('projectId'));
        const candidate = project?.document.visualAssetWorkspace?.candidates.find(item => item.planId === url.searchParams.get('assetId'));
        const original = candidate && records.get(candidate.historyRecordId);
        return original?.candidate ? respond({ candidate: { ...original.candidate, previewUrl: `${origin}/api/media-history/content?recordId=${original.recordId}` } }) : respond({ error: 'Engineering original receipt unavailable' }, 404);
      }
      if (url.pathname === '/api/media-history/content') {
        const record = records.get(url.searchParams.get('recordId')); return record ? route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(record.ratio) }) : respond({ error: 'Fixture image missing' }, 404);
      }
      if (url.pathname === '/api/storyboard/image') {
        const owned = ownedImages.get(url.searchParams.get('assetId')) || [...ownedImages.values()].find(item => item.storageKey === url.searchParams.get('storageKey'));
        return owned ? respond({ url: owned.url, assetId: owned.assetId, storageKey: owned.storageKey }) : respond({ error: 'Fixture owned image missing' }, 404);
      }
      if (url.pathname === '/api/image/status') return respond(attempts.get(url.searchParams.get('clientIdempotencyKey')) || { state: 'rejected', canResubmit: true, billed: false });
      if (url.pathname === '/api/video/access-ticket') return respond({ url: `${origin}/api/engineering-fixtures/video.webm` });
      if (url.pathname === '/api/engineering-fixtures/video.webm') return route.fulfill({ status: 200, contentType: 'video/webm', body: videoBytes || Buffer.alloc(0) });
      return route.continue();
    });
    const register = page => page.on('pageerror', error => report.errors.push(error.message.slice(0, 400).replaceAll(token, '[REDACTED]')));
    context.on('page', register);
    const page = await context.newPage(); activePage = page;
    const waitRam = async (predicate, message = 'RAM_STATE_TIMEOUT') => {
      const until = Date.now() + 40_000;
      while (!predicate()) { assert.ok(Date.now() < until, message); await new Promise(resolve => setTimeout(resolve, 50)); }
    };
    const capture = async (target, name, ready) => {
      await ready.waitFor({ state: 'visible', timeout: 30_000 }); await ready.scrollIntoViewIfNeeded();
      await target.evaluate(() => document.fonts.ready);
      const layout = await target.evaluate(() => ({ viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
      assert.ok(layout.documentWidth <= layout.viewportWidth + 2 && layout.bodyWidth <= layout.viewportWidth + 2, `${name}: overflow`);
      report.pages.push({ name, route: new URL(target.url()).pathname, ...layout }); await target.screenshot({ path: `${output}/${name}.png`, fullPage: false });
    };
    const openChat = async id => {
      if (page.url() !== 'about:blank') await page.evaluate(id => { localStorage.setItem('active_view', 'chat'); localStorage.setItem('active_conversation_id', id); }, id);
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const assistant = page.locator('article[data-message-role="assistant"]').first(); await assistant.waitFor({ state: 'visible', timeout: 30_000 }); return assistant;
    };
    const push = async () => {
      const button = page.getByRole('button', { name: '推送至分镜工作台', exact: true }); await button.waitFor({ state: 'visible', timeout: 30_000 }); assert.equal(await button.isEnabled(), true);
      const popupPromise = page.waitForEvent('popup', { timeout: 30_000 }); await button.click(); const popup = await popupPromise; activePage = popup;
      await popup.waitForURL(url => url.pathname === '/storyboard-workbench', { timeout: 30_000 });
      await popup.getByTestId('storyboard-continuous-production').waitFor({ state: 'visible', timeout: 30_000 });
      await waitRam(() => projects.size > 0);
      await popup.waitForURL(url => Boolean(url.searchParams.get('projectId')), { timeout: 30_000 }); return popup;
    };
    const production = target => target.getByTestId('storyboard-continuous-production');
    const selectModels = async target => {
      const imageButtons = target.locator('.sbw-image-model-list button[data-model-selectable="true"]');
      await imageButtons.first().waitFor({ state: 'visible', timeout: 30_000 });
      const imageIds = await imageButtons.evaluateAll(elements => elements.filter(element => Number(element.dataset.referenceLimit) >= 2).map(element => element.dataset.modelId));
      assert.ok(imageIds.length, 'REAL_IMAGE_MODEL_SUPPORTING_TWO_REFERENCES_REQUIRED');
      await target.locator(`.sbw-image-model-list button[data-model-id="${imageIds[0]}"]`).click();
      const videoButtons = target.locator('.sbw-video-model-list button[data-model-selectable="true"]'); await videoButtons.first().waitFor({ state: 'visible', timeout: 30_000 });
      await videoButtons.first().click();
      const duration = target.getByRole('combobox', { name: '视频时长', exact: true });
      if (await duration.isEnabled()) await duration.selectOption('10'); else assert.equal(await duration.inputValue(), '10');
      const allowance = target.getByRole('textbox', { name: '每条视频本次最多自动扣款金额', exact: true });
      if (await allowance.count()) await allowance.fill('100');
      await target.locator('.sbw-image-model-list button.is-active').waitFor({ state: 'visible', timeout: 30_000 });
      await target.locator('.sbw-video-model-list button.is-active').waitFor({ state: 'visible', timeout: 30_000 });
    };
    const budget = async (target, accept) => {
      const button = production(target).getByRole('button', { name: /^(?:开始连续制作|继续连续制作)$/u });
      const dialogPromise = target.waitForEvent('dialog', { timeout: 15_000 }); const click = button.click(); const dialog = await dialogPromise;
      assert.equal(dialog.type(), 'confirm'); assert.ok(dialog.message().includes('连续制作当前项目'));
      if (accept) await dialog.accept(); else await dialog.dismiss(); await click;
    };
    const current = id => projects.get(id).document;
    const events = id => report.generationEvents.filter(event => event.projectId === id);
    const saveDocumentFixture = async (name, document) => {
      const json = JSON.stringify(document, null, 2) + '\n';
      assert.ok(!json.includes(token), 'CREDENTIAL_MUST_NOT_ENTER_DOCUMENT_FIXTURE');
      assert.ok(!/[?&](?:token|signature|secret|authorization|x-cos-security-token)=/iu.test(json), 'SIGNED_URL_MUST_NOT_ENTER_DOCUMENT_FIXTURE');
      await fs.writeFile(`${output}/${name}.json`, json);
    };

    const assistant = await openChat('engineering-continuous-planned');
    await assistant.getByText('演绎重点', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.ok((await assistant.innerText()).includes('完整文字计划'));
    await capture(page, 'chat-complete-plan', assistant.getByText('演绎重点', { exact: true }));
    // Draw a tiny labelled WebM in browser RAM; this is transport test media,
    // not a model request, user recording or production asset.
    videoBytes = Buffer.from(await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d7e2e5'; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = '#20333c'; ctx.font = '18px sans-serif'; ctx.fillText('ENGINEERING FIXTURE', 34, 90);
      const stream = canvas.captureStream(5); const chunks = []; const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      recorder.ondataavailable = event => chunks.push(event.data); const stopped = new Promise(resolve => recorder.onstop = resolve);
      recorder.start(); ctx.fillText('RAM MOCK', 104, 124); await new Promise(resolve => setTimeout(resolve, 400)); recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
      return [...new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())];
    })); assert.ok(videoBytes.length > 100);
    const workbench = await push(); const projectId = new URL(workbench.url()).searchParams.get('projectId');
    assert.equal(current(projectId).directorIntake.phase, 'planned'); assert.equal(current(projectId).cards.length, planned.segments.length);
    assert.equal(current(projectId).visualAssetWorkspace.drafts.length, planned.visual_asset_plan.assets.length);
    assert.ok(current(projectId).visualAssetPlan.assets.every(asset => !asset.source));
    for (const [index, segment] of planned.segments.entries()) {
      assert.equal(current(projectId).cards[index].imagePrompt, segment.storyboard_image_prompt);
      assert.equal(current(projectId).cards[index].videoPrompt, segment.image_to_video_prompt);
      assert.deepEqual(current(projectId).cards[index].directorExecution.performancePlan, segment.performance_plan);
    }
    assert.equal(report.generationEvents.length, 0);
    await saveDocumentFixture('imported-planned-document', current(projectId));
    await selectModels(workbench);
    await capture(workbench, 'imported-complete-plan', production(workbench));
    await budget(workbench, false); assert.equal(events(projectId).length, 0);
    report.checks.push('real planned chat pushes full prompts and role drafts through autoImport; dismissing total budget dispatches zero generation POSTs');
    await budget(workbench, true);
    await workbench.locator('[data-testid="storyboard-continuous-production"][data-production-status="waiting"]').waitFor({ state: 'visible', timeout: 40_000 });
    await waitRam(() => current(projectId).visualAssetWorkspace.candidates.length === 2);
    assert.deepEqual(events(projectId).map(event => event.kind), ['reference', 'reference']);
    assert.equal(current(projectId).directorIntake.confirmedAssets?.length || 0, 0);
    const slot = role => workbench.locator(`.svad-reference-slot[data-role="${role}"]`);
    await slot('character').getByRole('button', { name: '使用这张', exact: true }).click();
    await waitRam(() => current(projectId).directorIntake.confirmedAssets?.length === 1);
    assert.deepEqual(events(projectId).map(event => event.kind), ['reference', 'reference']);
    await capture(workbench, 'one-role-confirmed-no-boards', production(workbench));
    await production(workbench).getByRole('button', { name: '暂停连续制作', exact: true }).click();
    await workbench.locator('[data-production-status="paused"]').waitFor({ state: 'visible' });
    await workbench.reload({ waitUntil: 'domcontentloaded' });
    await production(workbench).waitFor({ state: 'visible', timeout: 30_000 });
    await slot('pet').getByRole('button', { name: '使用这张', exact: true }).click();
    await waitRam(() => current(projectId).directorIntake.confirmedAssets?.length === 2);
    assert.deepEqual(events(projectId).map(event => event.kind), ['reference', 'reference']);
    await capture(workbench, 'paused-reloaded-confirmed-requires-budget', production(workbench));
    report.checks.push('two generated role candidates require separate explicit Apply; one confirmation never dispatches boards, and pause/reload discards spending authorization');
    await budget(workbench, true);
    await workbench.locator('[data-production-status="done"]').waitFor({ state: 'visible', timeout: 60_000 });
    await waitRam(() => current(projectId).cards.every(card => card.imageStatus === 'done' && card.videoStatus === 'done'));
    assert.deepEqual(events(projectId).map(event => event.kind), ['reference', 'reference', ...planned.segments.map(() => 'image'), ...planned.segments.map(() => 'video')]);
    assert.ok(report.proofReads >= 2); assert.equal(new Set(events(projectId).map(event => event.requestKey)).size, events(projectId).length);
    await saveDocumentFixture('completed-planned-document', current(projectId));
    const readMediaDom = () => workbench.evaluate(() => ({
      rail: document.querySelector('.sbw-rail-summary small')?.textContent,
      cards: [...document.querySelectorAll('[data-sbw-card-id]')].map(card => ({
        id: card.getAttribute('data-sbw-card-id'), status: card.getAttribute('data-card-state'),
        statusLabel: card.querySelector('.sbw-status-pair')?.textContent,
        mode: card.querySelector('[data-media-mode]')?.getAttribute('data-media-mode'),
        images: [...card.querySelectorAll('.sbw-shared-media-frame img')].map(img => ({ complete: img.complete, width: img.naturalWidth, height: img.naturalHeight })),
        videos: [...card.querySelectorAll('.sbw-shared-media-frame video')].map(video => ({ readyState: video.readyState, width: video.videoWidth, height: video.videoHeight, error: video.error?.code || null })),
      })),
    }));
    report.mediaDom = { initial: await readMediaDom() };
    try {
      await workbench.waitForFunction(count => {
        const rail = document.querySelector('.sbw-rail-summary small')?.textContent?.replace(/\s+/gu, ' ').trim();
        const cards = [...document.querySelectorAll('[data-sbw-card-id]')];
        return rail === `图片 ${count}/${count} · 视频 ${count}/${count}` && cards.length === count && cards.every(card =>
          card.getAttribute('data-card-state') === 'done' && [...card.querySelectorAll('video')].some(video => video.readyState >= 1 && video.videoWidth > 0 && !video.error));
      }, planned.segments.length, { timeout: 10_000 });
    } finally {
      report.mediaDom.afterWait = await readMediaDom();
      report.mediaDom.savedCards = current(projectId).cards.map(card => ({ id: card.id, imageStatus: card.imageStatus, imageValidatedAt: card.imageValidatedAt,
        imageRetryBlocked: card.imageRetryBlocked, imageRecoveryReady: card.imageRecoveryReady, imageBillingState: card.imageBillingState, imageUrl: card.imageUrl, videoStatus: card.videoStatus, videoUrl: card.videoUrl }));
    }
    const generationBeforeMediaView = events(projectId).length;
    for (const card of await workbench.locator('[data-sbw-card-id]').all()) await card.getByRole('button', { name: '查看图片', exact: true }).click();
    await workbench.waitForFunction(count => {
      const images = [...document.querySelectorAll('[data-sbw-card-id] .sbw-shared-media-frame img')];
      return images.length === count && images.every(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
    }, planned.segments.length, { timeout: 10_000 });
    report.mediaDom.imageView = await readMediaDom();
    for (const card of await workbench.locator('[data-sbw-card-id]').all()) await card.getByRole('button', { name: '查看视频', exact: true }).click();
    await workbench.waitForFunction(count => {
      const videos = [...document.querySelectorAll('[data-sbw-card-id] .sbw-shared-media-frame video')];
      return videos.length === count && videos.every(video => video.readyState >= 1 && video.videoWidth > 0 && !video.error);
    }, planned.segments.length, { timeout: 10_000 });
    assert.equal(events(projectId).length, generationBeforeMediaView, 'VIEWING_COMPLETED_MEDIA_MUST_NOT_GENERATE');
    report.checks.push('done UI shows actual image/video completion counts and completed cards; video metadata and switched image pixels load without generation');
    await capture(workbench, 'continuous-images-then-videos-done', production(workbench));
    const completedEvents = events(projectId).length;
    await workbench.reload({ waitUntil: 'domcontentloaded' }); await production(workbench).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(events(projectId).length, completedEvents);
    assert.deepEqual(current(projectId).cards[0].directorExecution.performancePlan, planned.segments[0].performance_plan);
    report.checks.push('fresh remaining-budget approval calls actual image then video callbacks in order with immutable-original readback; completed media and performance survive reload without redispatch');
    await workbench.close(); activePage = page;

    await openChat('engineering-continuous-ordinary'); const ordinaryPage = await push();
    const ordinaryId = new URL(ordinaryPage.url()).searchParams.get('projectId');
    assert.equal(current(ordinaryId).directorIntake, undefined); await selectModels(ordinaryPage);
    rejectNextBoard = true; await budget(ordinaryPage, true);
    await ordinaryPage.locator('[data-production-status="stopped"]').waitFor({ state: 'visible', timeout: 40_000 });
    assert.deepEqual(events(ordinaryId).map(event => event.kind), ['image']);
    await waitRam(() => current(ordinaryId).cards[0].imageStatus === 'failed');
    const failedEvents = events(ordinaryId).length;
    await ordinaryPage.reload({ waitUntil: 'domcontentloaded' }); await production(ordinaryPage).waitFor({ state: 'visible', timeout: 30_000 });
    await production(ordinaryPage).getByRole('button', { name: /^(?:开始连续制作|继续连续制作)$/u }).click();
    await production(ordinaryPage).getByRole('status').filter({ hasText: /原生成请求仍在运行或结果待核验|某段生成失败或已取消/u }).waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await production(ordinaryPage).getAttribute('data-production-status'), 'stopped');
    assert.equal(events(ordinaryId).length, failedEvents);
    await capture(ordinaryPage, 'ordinary-rejected-stop-no-replay', production(ordinaryPage));
    report.checks.push('ordinary mode skips role generation; a rejected response without key-release proof stops before video and refresh/continue cannot silently replay it');
    await ordinaryPage.close(); activePage = page;
    await page.evaluate(() => localStorage.setItem('active_view', 'marketplace')); await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await capture(page, 'adjacent-home', page.locator('[aria-label^="打开智能体："][aria-label*="高能版"]').first());
    await page.goto(`${origin}/video`, { waitUntil: 'domcontentloaded' });
    await capture(page, 'adjacent-video', page.getByRole('heading', { name: 'AI 视频创作台', exact: true }));
    assert.deepEqual(report.blockedUnknownWrites, []); assert.deepEqual(report.errors, []);
    assert.equal(report.serverBusinessWrites, 0); assert.equal(report.liveGenerationRequests, 0);
    assert.equal(pins.fingerprint, computeLocalBuildFingerprint(process.cwd()).fingerprint, 'SOURCE_CHANGED_DURING_BROWSER'); report.passed = true;
  } catch (error) {
    report.failure = { name: error instanceof Error ? error.name : 'Error', message: String(error instanceof Error ? error.message : error).slice(0, 1600).replaceAll(token, '[REDACTED]') };
    await activePage?.screenshot({ path: `${output}/failure.png`, fullPage: false }).catch(() => undefined); throw error;
  } finally {
    report.finishedAt = new Date().toISOString(); await fs.writeFile(`${output}/result.json`, JSON.stringify(report, null, 2) + '\n'); await browser?.close();
  }
  console.log(JSON.stringify(report, null, 2));
}
