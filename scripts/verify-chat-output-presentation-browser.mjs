import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const targets = [
  { key: 'meme-storyboard', id: 'agent-1793171231055-r9qzu6' },
  { key: 'movie', id: 'agent-1786633444187-594spj' },
  { key: 'high-energy', id: 'agent-1786843330392-emdjv2' },
  { key: 'copywriter', id: 'agent-1781753171961-mlipi7' },
];
const viewport = { width: 1440, height: 900 };
const shortText = '短提示词：主体清晰，动作自然。https://fixture.invalid/short-literal.png';
const shortVideoText = '短视频提示词：摄影机轻推，角色抬头。';
const longText = Array.from({ length: 72 }, (_, index) => `第${String(index + 1).padStart(2, '0')}行：固定人物、空间和动作关系，保留完整提示词。`).join('\n') + '\n末尾完整保留 https://fixture.invalid/text-tail.png';
const singleLineText = '同一个逻辑长行，主体动作与环境保持连续。'.repeat(200) + 'TEXT_SINGLE_END https://fixture.invalid/single-tail.png';
const javascript = 'const literal = "### code heading **literal** <tag>&";\n\n\nconst ending = "JS_COPY_END https://fixture.invalid/code-tail.png";';
const quotedText = 'https://example.invalid/keep.png';
const listText = 'https://example.invalid/list-keep.png';
const mediumDocument = Array.from({ length: 55 }, (_, i) => `记录${i + 1}：常规项目文档包含背景、目标、执行步骤与验收记录，逐项核对完整信息。`).join('\n');
const largeDocument = Array.from({ length: 160 }, (_, i) => `记录${i + 1}：${'常规项目长篇资料包含完整背景与验收记录。'.repeat(4)}`).join('\n');
const payloadText = [
  '### 选择创作模式', '', '**A模式｜同题再创作**', '', '普通正文保持正常字重，原有步骤和选择保持不变。', '',
  '### 生图 Prompt', '', '```text', shortText, '```', '', '### 图生视频 Prompt', '', '```text', longText, '```', '', '### 生图 Prompt', '', '```text', singleLineText, '```', '',
  '### 程序示例', '',
  '```js', javascript, '```', '', '安全字符：<script>window.__outputUnsafe = true</script>。', '',
  '> ```text', `> ${quotedText}`, '> ```', '', '- 内容', '', '    ```text', `    ${listText}`, '    ```', '',
  '### 普通项目文档', '', '```text', mediumDocument, '```', '', '### 长篇项目资料', '', '```text', largeDocument, '```', '',
  '### 图生视频 Prompt', '', '```text', shortVideoText, '```', '', '普通正文结束，继续按原选择步骤操作。',
].join('\n');
const expectedBlocks = [shortText, longText, singleLineText, javascript, quotedText, listText, mediumDocument, largeDocument, shortVideoText];
const expectedTiers = ['sm', 'sm', 'sm', 'sm', 'sm', 'sm', 'md', 'lg', 'sm'];
const tierCeilings = { sm: 240, md: 400, lg: 560 };
const expectedLabels = ['生图提示词', '视频提示词', '生图提示词', 'JS', '文档', '文档', '文档', '文档', '视频提示词'];
const inputText = '### 用户输入 **保持字面**';
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function main(args = []) {
  assert.ok(args.every(value => value === '--plan' || /^--origin=http:\/\/127\.0\.0\.1:5000\/?$/u.test(value) || value.startsWith('--output-dir=')), 'UNSUPPORTED_BROWSER_ARGUMENT');
  const outputs = args.filter(value => value.startsWith('--output-dir='));
  assert.ok(outputs.length <= 1, 'ONE_OUTPUT_DIRECTORY_REQUIRED');
  const evidenceRoot = path.resolve('.codex-evidence');
  const outputDirectory = path.resolve(outputs[0]?.slice('--output-dir='.length) || `.codex-evidence/chat-output-layout-20261030/browser-${randomUUID()}`);
  assert.ok(outputDirectory.startsWith(evidenceRoot + path.sep), 'OUTPUT_MUST_STAY_INSIDE_IGNORED_EVIDENCE');
  if (args.includes('--plan')) {
    console.log(JSON.stringify({ mode: 'plan', executed: false, viewport, targets,
      checks: ['target-agents', 'prompt-short-long-single-line', 'three-natural-height-tiers', 'stream-final-same-height', 'locator-dots-below-circle', 'scroll-to-bottom', 'actual-copy-click-full-content', 'assistant-Markdown-user-literal', 'real-code-symbols', 'two-adjacent-pages'],
      providerCalls: 0, businessWrites: 0, outputDirectory }, null, 2));
    return;
  }
  const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
  assert.equal(origin, 'http://127.0.0.1:5000', 'CURRENT_LOCAL_PREVIEW_REQUIRED');
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.ok(token, 'LOCAL_ADMIN_WRAPPER_REQUIRED');
  let identity;
  try { identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || '{}'); }
  catch { throw Error('LOCAL_READONLY_IDENTITY_INVALID'); }
  assert.ok(identity?.user?.id && identity.user.role === 'admin', 'LOCAL_READONLY_ADMIN_IDENTITY_REQUIRED');
  await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
  await fs.mkdir(outputDirectory); // Refuse overwriting any prior acceptance evidence.
  const report = { kind: 'current-three-agent-chat-ui-with-controlled-output-fixture', startedAt: new Date().toISOString(), viewport,
    evidenceBoundary: 'Real current local application and directory; synthetic in-memory auth/me and output stream. Clipboard writes are captured in memory from actual copy clicks. No provider call or real billing acceptance is inferred.',
    providerCalls: 0, businessWrites: 0, actualMutationRequestsAllowed: 0,
    blockedExternalRequests: 0, interceptedMutations: 0, authSnapshotResponses: 0, browserErrors: 0,
    targets: [], adjacentPages: [], passed: false };
  const browser = await chromium.launch({ headless: true });
  try {
    async function fixtureContext(target) {
      const counters = { forbiddenLlmNetworkPosts: 0 };
      const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
      await context.addInitScript(({ sessionToken, profile, agentId }) => {
        localStorage.setItem('auth_token', sessionToken);
        localStorage.setItem('auth_user', JSON.stringify(profile));
        sessionStorage.setItem('entered_app', '1');
        const nativeFetch = window.fetch.bind(window), encoder = new TextEncoder();
        let controller;
        window.__outputClipboard = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__outputClipboard.push(String(value)); } } });
        const fixture = { submissions: 0, closed: false,
          enqueue(value) {
            if (!controller || fixture.closed) throw Error('FIXTURE_STREAM_NOT_OPEN');
            controller.enqueue(encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`));
          },
          close() { if (controller && !fixture.closed) { fixture.closed = true; controller.close(); } },
        };
        window.__outputPresentationFixture = fixture;
        window.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
          const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
          if (url.origin !== location.origin || url.pathname !== '/api/llm' || method !== 'POST') return nativeFetch(input, init);
          if (!agentId) throw Error('ADJACENT_PAGE_MUST_NOT_GENERATE');
          fixture.submissions++;
          if (fixture.submissions !== 1) throw Error('FIXTURE_MUST_NOT_RESUBMIT');
          const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
          if (JSON.parse(body).agentId !== agentId) throw Error('EXACT_TARGET_AGENT_REQUIRED');
          const stream = new ReadableStream({ start(value) { controller = value; } });
          fixture.enqueue({ type: 'stream_delivery', stream_delivery: 'live' });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
        };
      }, { sessionToken: token, profile: identity.user, agentId: target?.id });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.origin !== origin) { report.blockedExternalRequests++; return route.abort('blockedbyclient'); }
        if (url.pathname === '/api/auth/me' && method === 'GET') {
          report.authSnapshotResponses++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, user: identity.user }) });
        }
        if (url.pathname === '/api/llm' && method === 'POST') { counters.forbiddenLlmNetworkPosts++; return route.abort('blockedbyclient'); }
        if (!['GET', 'HEAD'].includes(method)) {
          report.interceptedMutations++;
          if (url.pathname.startsWith('/api/conversations')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"fixtureOnly":true}' });
          if (['/api/operation-events', '/api/announcements/events', '/api/diagnostic-logs'].includes(url.pathname)) return route.fulfill({ status: 202, contentType: 'application/json', body: '{"accepted":true,"fixtureOnly":true}' });
          return route.abort('blockedbyclient');
        }
        if (/^\/api\/(llm|chat|generate|payment)(\/|$)/u.test(url.pathname)) return route.abort('blockedbyclient');
        return route.continue({ headers: { ...request.headers(), authorization: `Bearer ${token}` } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.on('pageerror', () => { report.browserErrors++; });
      return { page, context, counters };
    }
    async function openTarget(page, target) {
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const card = page.locator(`[data-agent-card-id="${target.id}"]`);
      await card.waitFor({ state: 'attached' });
      await card.scrollIntoViewIfNeeded();
      const opener = card.getByRole('button', { name: /^打开智能体：/u });
      const agentName = (await opener.getAttribute('aria-label')).replace(/^打开智能体：/u, '');
      await opener.click();
      const skip = page.getByRole('button', { name: '跳过', exact: true });
      await page.getByTestId('chat-agent-name').filter({ hasText: agentName }).or(skip).first().waitFor({ state: 'visible' });
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await page.getByTestId('chat-agent-name').filter({ hasText: agentName }).waitFor({ state: 'visible' });
      return { input: page.getByRole('textbox', { name: `向 ${agentName} 发送消息`, exact: true }), agentName };
    }
    async function metrics(page, phase, root = '[data-message-role="assistant"]') {
      return page.locator(root + ' .render-layer-' + phase).last().evaluate(layer => {
        const blocks = [...layer.querySelectorAll('.code-block-wrapper')].map(wrapper => {
          const pre = wrapper.querySelector('.code-block-pre'), code = pre?.querySelector('code'), style = pre && getComputedStyle(pre);
          if (!pre || !code || !style) throw Error('CODE_VIEWPORT_REQUIRED');
          pre.scrollTop = pre.scrollHeight;
          const label = wrapper.querySelector('.code-block-lang');
          const header = wrapper.querySelector('.code-block-header');
          return { label: label?.textContent, labelColor: label ? getComputedStyle(label).color : null,
            headerColor: header ? getComputedStyle(header).backgroundColor : null,
            labelVisible: !!label && label.getBoundingClientRect().width > 0 && getComputedStyle(label).visibility === 'visible',
            plaintext: wrapper.classList.contains('code-block-plaintext'), tier: ['sm', 'md', 'lg'].find(tier => wrapper.classList.contains(`code-block-h-${tier}`)), height: pre.getBoundingClientRect().height,
            clientHeight: pre.clientHeight, scrollHeight: pre.scrollHeight, scrollTop: pre.scrollTop,
            prePadding: style.padding, codeOverflowX: getComputedStyle(code).overflowX,
            horizontalOverflow: pre.scrollWidth - pre.clientWidth, overflowY: style.overflowY, scrollbarWidth: style.scrollbarWidth,
            text: code.textContent, parsedMarkers: code.querySelectorAll('strong,h1,h2,h3,script').length };
        });
        const strong = [...layer.querySelectorAll('strong')].find(element => element.textContent === 'A模式｜同题再创作');
        const plain = [...layer.querySelectorAll('p')].find(element => element.textContent?.startsWith('普通正文保持正常字重'));
        return { blocks, headingVisible: !![...layer.querySelectorAll('h3')].find(element => element.textContent === '选择创作模式'),
          strongWeight: strong ? getComputedStyle(strong).fontWeight : null, plainWeight: plain ? getComputedStyle(plain).fontWeight : null,
          executableHtml: layer.querySelectorAll('script').length, unsafeExecuted: window.__outputUnsafe === true };
      });
    }
    function assertMetrics(value, phase) {
      assert.equal(value.blocks.length, expectedBlocks.length, `${phase}:ALL_BLOCKS_REQUIRED`);
      assert.equal(value.headingVisible, true, `${phase}:ASSISTANT_MARKDOWN_HEADING_REQUIRED`);
      assert.ok(Number(value.strongWeight) >= 700 && Number(value.strongWeight) > Number(value.plainWeight), `${phase}:EXPLICIT_EMPHASIS_MUST_DIFFER_FROM_BODY`);
      assert.equal(value.executableHtml, 0); assert.equal(value.unsafeExecuted, false);
      value.blocks.forEach((block, index) => {
        assert.equal(block.text.replace(/\n$/u, ''), expectedBlocks[index], `${phase}:FENCE_CONTENT_INTACT`);
        assert.equal(block.parsedMarkers, 0);
        assert.equal(block.label, expectedLabels[index], `${phase}:SEMANTIC_BLOCK_LABEL_${index}`);
        assert.equal(block.labelVisible, true, `${phase}:LABEL_VISIBLE_${index}`);
        if (phase === 'official-final') {
          const luminance = raw => {
            const values = raw.match(/[\d.]+/gu).slice(0, 3).map(Number).map(value => raw.startsWith('color(srgb') ? value : value / 255);
            const linear = values.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
          };
          const foreground = luminance(block.labelColor), background = luminance(block.headerColor);
          const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
          assert.ok(contrast >= 4.5, `${phase}:READABLE_LABEL_CONTRAST_${index}`);
          block.labelContrast = contrast;
        }
        assert.equal(block.tier, expectedTiers[index], `${phase}:EXPECTED_HEIGHT_TIER_${index}`);
        assert.ok(block.height <= tierCeilings[block.tier] + 1, `${phase}:VIEWPORT_CEILING_${index}`);
        assert.equal(block.prePadding, '0px', `${phase}:SCROLLBAR_OWNER_PADDING_${index}`);
        assert.equal(block.codeOverflowX, 'visible', `${phase}:NO_INNER_CODE_SCROLLBAR_${index}`);
        if (index !== 3) {
          assert.equal(block.plaintext, true);
          assert.equal(block.overflowY, 'auto'); assert.notEqual(block.scrollbarWidth, 'none');
          assert.ok(block.horizontalOverflow <= 1);
          if ([0, 1, 2, 6, 7, 8].includes(index)) {
            assert.equal(block.height, tierCeilings[block.tier], `${phase}:LONG_BLOCK_USES_TIER_CEILING`);
            if (![0, 8].includes(index)) {
              assert.ok(block.scrollHeight > block.clientHeight);
              assert.ok(Math.abs(block.scrollHeight - block.clientHeight - block.scrollTop) <= 1, `${phase}:SCROLL_REACHES_END`);
            }
          } else assert.ok(block.height < 140, `${phase}:SHORT_BLOCK_SHRINKS`);
        } else {
          assert.equal(block.plaintext, false); assert.ok(block.height < 140, `${phase}:REAL_SHORT_CODE_REMAINS_COMPACT`);
        }
      });
      assert.equal(value.blocks[0].height, value.blocks[1].height, `${phase}:SHORT_IMAGE_AND_LONG_VIDEO_SAME_TIER_HEIGHT`);
      assert.equal(value.blocks[0].height, value.blocks[8].height, `${phase}:SHORT_IMAGE_AND_SHORT_VIDEO_SAME_TIER_HEIGHT`);
    }
    const compactMetrics = value => ({ ...value, blocks: value.blocks.map(({ text, ...block }) => ({ ...block, chars: text.length, sha256: sha256(text) })) });
    async function expandLongPrompt(page, root = '[data-message-role="assistant"]') {
      const wrappers = page.locator(root + ' .code-block-wrapper');
      assert.equal(await wrappers.first().locator('.code-block-expand-button').isVisible(), false, 'SHORT_CONTENT_HAS_NO_EXPAND_ACTION');
      const wrapper = wrappers.nth(1);
      const button = wrapper.locator('.code-block-expand-button');
      await button.scrollIntoViewIfNeeded();
      await button.click();
      assert.equal(await button.getAttribute('aria-expanded'), 'true');
      const height = await wrapper.locator('.code-block-pre').evaluate(element => element.getBoundingClientRect().height);
      assert.ok(height > 240, 'EXPAND_REVEALS_FULL_PROMPT');
      assert.equal((await wrapper.locator('code').textContent()).replace(/\n$/u, ''), longText);
      return { expandedHeight: height, originalTextUnchanged: true };
    }
    async function verifyLatestLocator(page) {
      const button = page.getByTestId('chat-scroll-to-latest');
      await button.waitFor({ state: 'visible' });
      const states = [];
      for (const state of ['idle', 'hover', 'focus']) {
        if (state === 'hover') await button.hover();
        if (state === 'focus') { await page.mouse.move(0, 0); await button.focus(); }
        // Let the existing button movement transition settle before measuring.
        await page.waitForTimeout(220);
        const value = await button.evaluate(element => {
          const circle = element.getBoundingClientRect();
          const dots = element.querySelector('.chat-latest-dots').getBoundingClientRect();
          const composer = document.querySelector('.chat-composer-rainbow').getBoundingClientRect();
          return { centerDelta: Math.abs(circle.x + circle.width / 2 - dots.x - dots.width / 2),
            gap: dots.top - circle.bottom, composerGap: composer.top - dots.bottom,
            count: element.querySelectorAll('.chat-latest-dot').length,
            opacity: getComputedStyle(element.querySelector('.chat-latest-dots')).opacity };
        });
        assert.ok(value.centerDelta <= 1, `${state}:DOTS_CENTERED_UNDER_CIRCLE`);
        assert.ok(value.gap >= 4 && value.composerGap >= 2, `${state}:DOTS_CLEAR_CIRCLE_AND_COMPOSER`);
        assert.equal(value.count, 3); assert.equal(value.opacity, '1');
        states.push({ state, ...value });
      }
      await page.screenshot({ path: path.join(outputDirectory, 'locator-dots-below-circle.png') });
      await button.click();
      await button.waitFor({ state: 'hidden' });
      return { states, clickReturnedToLatest: true };
    }
    for (const target of targets) {
      const { page, context, counters } = await fixtureContext(target);
      const outcome = { ...target, passed: false, screenshots: [] };
      report.targets.push(outcome);
      try {
        const { input, agentName } = await openTarget(page, target);
        outcome.agentName = agentName;
        await input.fill(inputText);
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.waitForFunction(() => window.__outputPresentationFixture.submissions === 1);
        if (target.key === 'meme-storyboard') {
          const split = payloadText.indexOf(longText) + Math.floor(longText.length / 2);
          const partial = payloadText.slice(0, split);
          await page.evaluate(value => window.__outputPresentationFixture.enqueue({ choices: [{ delta: { content: value }, finish_reason: null }] }), partial);
          const openBlock = page.locator('[data-message-role="assistant"] .code-block-wrapper').nth(1);
          const expand = openBlock.locator('.code-block-expand-button');
          await expand.waitFor({ state: 'visible' });
          assert.ok((await openBlock.getAttribute('class')).includes('code-block-h-sm'), 'OPEN_PROMPT_USES_TIER_ONE');
          await expand.click();
          assert.equal(await expand.getAttribute('aria-expanded'), 'true');
          await page.evaluate(value => window.__outputPresentationFixture.enqueue({ choices: [{ delta: { content: value }, finish_reason: null }] }), payloadText.slice(split));
          await page.waitForFunction(() => document.querySelector('.render-layer-streaming')?.textContent?.includes('普通正文结束，继续按原选择步骤操作。'));
          assert.equal(await expand.getAttribute('aria-expanded'), 'true', 'EXPANDED_CODE_GROWTH_AND_FENCE_CLOSE_PRESERVE_READING_STATE');
          assert.equal((await openBlock.locator('code').textContent()).replace(/\n$/u, ''), longText);
          await expand.click();
          outcome.openCodeLifecycle = { tierOne: true, growthWhileExpanded: true, closePreservedExpansion: true, fullTextMatched: true };
        } else {
          await page.evaluate(value => window.__outputPresentationFixture.enqueue({ choices: [{ delta: { content: value }, finish_reason: null }] }), payloadText);
        }
        await page.waitForFunction(() => [...document.querySelectorAll('[data-message-role="assistant"] .render-layer-streaming')].some(element => element.textContent?.includes('普通正文结束，继续按原选择步骤操作。')));
        const streaming = await metrics(page, 'streaming'); assertMetrics(streaming, 'streaming');
        const user = page.locator('[data-message-role="user"]').last();
        assert.ok((await user.innerText()).includes(inputText));
        assert.equal(await user.locator('h3,strong').count(), 0, 'USER_INPUT_MUST_REMAIN_LITERAL');
        const firstBlock = page.locator('[data-message-role="assistant"] .code-block-wrapper').nth(0);
        await firstBlock.scrollIntoViewIfNeeded();
        const streamShot = `${target.key}-streaming.png`;
        await page.screenshot({ path: path.join(outputDirectory, streamShot) }); outcome.screenshots.push(streamShot);
        outcome.latestLocator = await verifyLatestLocator(page);
        outcome.expansion = await expandLongPrompt(page);
        const scrollBefore = await page.locator('.chat-canvas.chat-scroll').evaluate(element => element.scrollTop);
        await page.evaluate(() => window.__outputPresentationFixture.enqueue({ choices: [{ delta: { content: '\n\n浏览器验收新增增量正文。' }, finish_reason: null }] }));
        await page.waitForFunction(() => document.querySelector('.render-layer-streaming')?.textContent?.includes('浏览器验收新增增量正文。'));
        const scrollAfter = await page.locator('.chat-canvas.chat-scroll').evaluate(element => element.scrollTop);
        assert.ok(Math.abs(scrollAfter - scrollBefore) <= 2, 'READING_POSITION_REMAINS_DURING_NEW_OUTPUT');
        assert.equal(await page.locator('[data-message-role="assistant"] .code-block-wrapper').nth(1).locator('.code-block-expand-button').getAttribute('aria-expanded'), 'true', 'EXPANSION_SURVIVES_STREAM_MORPH');
        outcome.readingPosition = { scrollBefore, scrollAfter, preserved: true };
        await page.evaluate(() => { window.__outputPresentationFixture.enqueue({ billing_complete: true }); window.__outputPresentationFixture.enqueue('[DONE]'); window.__outputPresentationFixture.close(); });
        await page.getByTestId('chat-output-status').filter({ hasText: /^已完成$/u }).last().waitFor({ state: 'visible' });
        const expandedPrompt = page.locator('[data-message-role="assistant"] .render-layer-final .code-block-wrapper').nth(1);
        assert.equal(await expandedPrompt.locator('.code-block-expand-button').getAttribute('aria-expanded'), 'true', 'EXPANSION_SURVIVES_FINAL_MORPH');
        await expandedPrompt.locator('.code-block-expand-button').click();
        assert.equal(await expandedPrompt.locator('.code-block-expand-button').getAttribute('aria-expanded'), 'false');
        const final = await metrics(page, 'final'); assertMetrics(final, 'final');
        final.blocks.forEach((block, index) => { if (block.plaintext) assert.equal(block.height, streaming.blocks[index].height, 'STREAM_FINAL_HEIGHT_MUST_MATCH'); });
        const copies = [];
        for (let index = 0; index < expectedBlocks.length; index++) {
          const wrapper = page.locator('[data-message-role="assistant"] .render-layer-final .code-block-wrapper').nth(index);
          await wrapper.scrollIntoViewIfNeeded(); await wrapper.hover();
          const before = await page.evaluate(() => window.__outputClipboard.length);
          await wrapper.locator('.copy-code-button').click();
          await page.waitForFunction(count => window.__outputClipboard.length > count, before);
          await wrapper.locator('.copy-code-button.copied').waitFor({ state: 'visible' });
          const copied = await page.evaluate(() => window.__outputClipboard.at(-1));
          assert.equal(copied.replace(/\n$/u, ''), expectedBlocks[index], 'ACTUAL_COPY_MUST_INCLUDE_FULL_BLOCK');
          copies.push({ index, fullContentMatched: true, chars: copied.length, sha256: sha256(copied) });
        }
        const finalShot = `${target.key}-final.png`;
        await page.locator('[data-message-role="assistant"] .render-layer-final .code-block-wrapper').first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(350);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: path.join(outputDirectory, finalShot) }); outcome.screenshots.push(finalShot);
        assert.equal(counters.forbiddenLlmNetworkPosts, 0);
        assert.equal(await page.evaluate(() => window.__outputPresentationFixture.submissions), 1);
        Object.assign(outcome, { streaming: compactMetrics(streaming), final: compactMetrics(final), copies, userLiteral: true, ...counters, passed: true });
      } catch (error) {
        const screenshot = `${target.key}-failure.png`;
        await page.screenshot({ path: path.join(outputDirectory, screenshot) }).catch(() => {});
        outcome.screenshots.push(screenshot); throw error;
      } finally { await context.close(); }
    }
    {
      const { page, context, counters } = await fixtureContext({ id: '__manga_workbench__' });
      try {
        await page.goto(origin + '/tools/text/text-chat', { waitUntil: 'domcontentloaded' });
        await page.getByRole('textbox', { name: '创作需求', exact: true }).fill(inputText);
        await page.getByRole('button', { name: '发送创作需求', exact: true }).click();
        await page.waitForFunction(() => window.__outputPresentationFixture.submissions === 1);
        await page.evaluate(value => window.__outputPresentationFixture.enqueue({ choices: [{ delta: { content: value }, finish_reason: null }] }), payloadText);
        const root = '[data-testid="official-agent-real-chat"] article[data-role="assistant"]';
        await page.locator(root + ' .code-block-wrapper').nth(expectedBlocks.length - 1).waitFor({ state: 'attached' });
        await page.evaluate(() => { window.__outputPresentationFixture.enqueue({ billing_complete: true }); window.__outputPresentationFixture.enqueue('[DONE]'); window.__outputPresentationFixture.close(); });
        await page.locator(root + '[data-message-status="complete"] .render-layer-final').last().waitFor({ state: 'attached' });
        const value = await metrics(page, 'final', root);
        report.officialChat = { path: '/tools/text/text-chat', final: compactMetrics(value), passed: false };
        assertMetrics(value, 'official-final');
        await page.locator(root + ' .code-block-wrapper').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(outputDirectory, 'official-chat-final.png') });
        assert.equal(counters.forbiddenLlmNetworkPosts, 0);
        report.officialChat = { path: '/tools/text/text-chat', final: compactMetrics(value), passed: true };
      } finally { await context.close(); }
    }
    const { page, context, counters } = await fixtureContext();
    try {
      for (const [routePath, screenshot] of [['/', 'adjacent-home.png'], ['/cover', 'adjacent-cover.png']]) {
        const response = await page.goto(origin + routePath, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        assert.equal(response?.status(), 200);
        if (routePath === '/') await page.locator(`[data-agent-card-id="${targets[0].id}"]`).waitFor({ state: 'attached' });
        else await page.getByRole('textbox', { name: '输入文案', exact: true }).waitFor({ state: 'visible' });
        const value = await page.evaluate(() => ({ textLength: document.body.innerText.length,
          horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth), applicationError: document.body.innerText.includes('Application error') }));
        assert.ok(value.textLength > 100 && !value.applicationError);
        await page.screenshot({ path: path.join(outputDirectory, screenshot) });
        report.adjacentPages.push({ path: routePath, ...value, screenshot, passed: true });
      }
      assert.equal(counters.forbiddenLlmNetworkPosts, 0);
    } finally { await context.close(); }
    assert.equal(report.browserErrors, 0, 'APPLICATION_PAGE_ERRORS'); report.passed = true;
  } catch (error) {
    report.failure = error instanceof assert.AssertionError ? 'BROWSER_ASSERTION_FAILED' : /^[A-Z][A-Z0-9_]+$/u.test(String(error?.message)) ? error.message : 'BROWSER_ACCEPTANCE_INCOMPLETE';
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await browser.close();
    console.log(JSON.stringify({ passed: report.passed, targets: report.targets.length, adjacentPages: report.adjacentPages.length,
      providerCalls: 0, businessWrites: 0, report: path.join(outputDirectory, 'report.json') }, null, 2));
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { console.error('CHAT_OUTPUT_PRESENTATION_BROWSER_FAILED'); process.exitCode = 1; });
}
