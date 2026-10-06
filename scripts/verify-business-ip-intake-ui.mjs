import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
let token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
if (!token) {
  const response = await fetch(`${origin}/api/auth/dev-session`, {
    headers: { 'x-local-workbench': 'ai-creation-studio-local' },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.ok, true, `LOCAL_ADMIN_SESSION_FETCH_FAILED:${response.status}`);
  const session = await response.json();
  token = String(session.token || '').trim();
}
assert.ok(token, 'LOCAL_ADMIN_SESSION_REQUIRED');
const outputArgument = process.argv.find(argument => argument.startsWith('--output='));
const out = path.resolve(outputArgument?.slice('--output='.length) || '.codex-evidence/business-ip-intake-2.3.0');
await fs.mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const report = {checkedAt:new Date().toISOString(),origin,pageErrors:[],consoleErrors:[],serverErrors:[],paidRequests:[],profileWrites:[],checks:{}};
let createdProfileId = '';
let boundConversationId = '';

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(value => {
    localStorage.setItem('auth_token', value);
    if (!localStorage.getItem('active_view')) localStorage.setItem('active_view', 'marketplace');
    sessionStorage.setItem('entered_app', '1');
  }, token);
  await context.addCookies([{ name:'auth_token', value:token, url:origin, httpOnly:true, sameSite:'Lax' }]);
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('request', request => {
    if (/\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u.test(request.url())) report.paidRequests.push(request.url());
    if (request.url().includes('/api/business-ip/profiles') && request.method() !== 'GET') {
      let body = null;
      try { body = request.postDataJSON(); } catch { body = request.postData(); }
      report.profileWrites.push({ method:request.method(), body });
    }
  });
  page.on('response', response => {
    if (response.status() >= 500) report.serverErrors.push({status:response.status(),url:response.url()});
  });

  const response = await page.goto(origin, { waitUntil:'domcontentloaded', timeout:60_000 });
  assert.equal(response?.status(), 200);
  await page.locator('.marketplace-category-bar').waitFor({ state:'visible', timeout:30_000 });
  const close = page.getByRole('button', { name:'关闭', exact:true });
  if (await close.count() && await close.last().isVisible()) await close.last().click();
  await page.locator('.marketplace-category-bar').getByRole('button', { name:'全部助手', exact:true }).click();
  const expectedCategories = ['全部助手','我的收藏','商业IP','影像编导','文案创作','运营增长','内部工具'];
  const categoryLabels = await page.locator('.marketplace-category-bar .category-tab').allTextContents();
  assert.deepEqual(categoryLabels.map(value => value.trim().replace(/^[^\p{L}\p{N}]+/u,'').replace(/^我的收藏\s*\d+$/u,'我的收藏')), expectedCategories, '分类导航顺序错误');
  const expectedOrder = ['商业IP定位','账号主页包装','对标账号拆解','内容选题策划','短视频文案成稿','咨询回复与跟进','运营数据复盘'];
  assert.equal(expectedOrder.some(name => name.endsWith('师')), false, '七张卡应采用任务型名称');
  await page.getByLabel('打开智能体：商业IP定位').waitFor({ state:'visible', timeout:30_000 });
  const allOrder = await page.locator('[aria-label^="打开智能体："]').evaluateAll(nodes => nodes.slice(0, 7).map(node => node.getAttribute('aria-label')?.replace('打开智能体：','')));
  assert.deepEqual(allOrder, expectedOrder, '全部视图应先展示七张商业IP卡');
  await page.locator('.marketplace-category-bar').getByRole('button', { name:'商业IP', exact:true }).click();
  const categoryOrder = await page.locator('[aria-label^="打开智能体："]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')?.replace('打开智能体：','')));
  assert.deepEqual(categoryOrder, expectedOrder, '商业定位IP分类内顺序错误');

  await page.getByLabel('打开智能体：商业IP定位').click();
  const positioning = page.getByTestId('business-ip-intake');
  await positioning.waitFor({ state:'visible' });
  await assert.doesNotReject(() => positioning.getByText('商业IP定位 · 帮你找到方向', { exact:true }).waitFor());
  for (const label of ['从零找个人方向','有几个方向，拿不准','有职业或技能','有实体店或本地生意','已有账号或线上业务','找到能长期做的方向','为副业或变现做准备','给现有职业或生意引流','还没想好']) {
    assert.equal(await positioning.getByRole('button', { name:label, exact:true }).count(), 1, label);
  }
  const template = positioning.getByLabel('照着模板说说你自己');
  const templateValue = await template.inputValue();
  for (const line of ['我做过哪些工作或生活角色','别人常夸我或找我帮忙什么','哪些事情我愿意反复讲','我愿不愿出镜、每周能花多少时间','我坚决不想做或不能做什么']) assert.ok(templateValue.includes(line), line);
  await positioning.getByRole('button', { name:'有实体店或本地生意', exact:true }).click();
  const merchantTemplateValue = await template.inputValue();
  for (const line of ['我做的是什么生意、在哪个城市','顾客下单前最常问什么、担心什么','我能拍到哪些真实产品、现场或服务过程','服务范围、接单能力和不能承诺什么']) assert.ok(merchantTemplateValue.includes(line), line);
  assert.equal(merchantTemplateValue.includes('我做过哪些工作或生活角色'), false);
  const positioningText = await positioning.innerText();
  for (const oldLabel of ['业务与交付','目前能提供的产品或服务','服务范围与接单能力','现有账号和咨询入口']) assert.equal(positioningText.includes(oldLabel), false, oldLabel);
  await positioning.getByRole('button', { name:'从零找个人方向', exact:true }).click();
  await positioning.getByRole('button', { name:'为副业或变现做准备', exact:true }).click();
  await template.fill('我做过哪些工作或生活角色：幼师八年\n别人常夸我或找我帮忙什么：亲子沟通\n我愿不愿出镜、每周能花多少时间：不让孩子出镜，每周6小时');
  assert.equal(await positioning.getByRole('button', { name:'开始定位', exact:true }).isEnabled(), true);
  assert.equal(await positioning.getByRole('button', { name:'我说不清，先问我', exact:true }).count(), 1);
  await page.screenshot({ path:path.join(out,'positioning-intake.png'), fullPage:false });
  await page.keyboard.press('Escape');

  const roleChecks = [
    { name:'账号主页包装', title:'账号主页包装 · 把定位变成主页', action:'生成整套包装', result:'3套有差异的包装方案' },
    { name:'对标账号拆解', title:'对标账号拆解 · 看懂价值，学会变成自己的方法', action:'标准20条', result:'72小时行动清单' },
    { name:'内容选题策划', title:'内容选题策划 · 只决定拍什么、先拍什么', action:'从头规划', result:'不写完整文案' },
    { name:'短视频文案成稿', title:'短视频文案成稿 · 把选题写成完整文案', action:'写一条新稿', result:'可直接拍摄的完整短视频文案' },
    { name:'咨询回复与跟进', title:'咨询回复与跟进 · 先建业务资料包，再粘贴顾客原话', action:'回复顾客', result:'《产品/服务卡》' },
    { name:'运营数据复盘', title:'运营数据复盘 · 看清哪里有效、下一轮改什么', action:'复盘现有数据', result:'一个7—14天主实验' },
  ];
  for (const check of roleChecks) {
    await page.getByLabel(`打开智能体：${check.name}`).click();
    const dialog = page.getByTestId('business-ip-intake');
    await dialog.waitFor({ state:'visible' });
    await assert.doesNotReject(() => dialog.getByText(check.title, { exact:true }).waitFor());
    assert.equal(await dialog.getByRole('button', { name:check.action, exact:true }).count(), 1, `${check.name}:${check.action}`);
    assert.equal((await dialog.innerText()).includes(check.result), true, `${check.name}:${check.result}`);
    const text = await dialog.innerText();
    for (const oldLabel of ['业务与交付','目前能提供的产品或服务','服务范围与接单能力','已确定的收费与服务边界']) assert.equal(text.includes(oldLabel), false, `${check.name}:${oldLabel}`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state:'hidden' });
  }

  const acceptanceName = `验收业务-${Date.now()}`;
  const acceptanceData = '商业IP定位：服务抖音发视频没有流量、带货亏本的创作者。\n产品：30天自媒体陪跑；价格1999元；不承诺流量和收益。\n案例：只展示已获授权且可核验的匿名案例。';
  await page.getByLabel('打开智能体：咨询回复与跟进').click();
  const consultation = page.getByTestId('business-ip-intake');
  await consultation.waitFor({ state:'visible' });
  const consultationText = await consultation.innerText();
  for (const expected of ['整理/更新资料包','回复顾客','平台会整理资料，并补充该细分行业需要核对的专业术语','不会替你编自家参数、价格、资质或政策']) {
    assert.ok(consultationText.includes(expected), `咨询回复双模式说明缺失：${expected}`);
  }
  await consultation.getByRole('button', { name:'回复顾客', exact:true }).click();
  await consultation.getByLabel('这项业务叫什么').fill(acceptanceName);
  await consultation.getByLabel('已整理资料包或前面环节成果').fill(acceptanceData);
  await consultation.getByLabel('本环节主要资料').fill('顾客问：会员费多少？有没有案例？学习周期多久？');
  const createResponsePromise = page.waitForResponse(response => response.url().includes('/api/business-ip/profiles') && response.request().method() === 'POST', { timeout:30_000 });
  const bindResponsePromise = page.waitForResponse(response => response.url().includes('/api/business-ip/profiles') && response.request().method() === 'PUT' && String(response.request().postData() || '').includes('conversation_id'), { timeout:30_000 });
  await consultation.getByRole('button', { name:'进入小助理', exact:true }).evaluate(button => {
    button.click();
    button.click();
  });
  const createResponse = await createResponsePromise;
  assert.equal(createResponse.status(), 201, '首次业务资料包保存失败');
  const createPayload = await createResponse.json();
  createdProfileId = String(createPayload?.profile?.id || '');
  assert.ok(createdProfileId, '首次保存没有返回业务资料包编号');
  const bindResponse = await bindResponsePromise;
  assert.equal(bindResponse.ok(), true, '新顾客对话绑定业务资料包失败');
  const bindBody = bindResponse.request().postDataJSON();
  boundConversationId = String(bindBody?.conversation_id || '');
  assert.equal(bindBody?.id, createdProfileId, '新对话绑定了错误的业务资料包');
  assert.match(boundConversationId, /^[a-zA-Z0-9_-]{8,128}$/u, '新顾客对话编号格式错误');
  const postIndex = report.profileWrites.findIndex(item => item.method === 'POST');
  const bindIndex = report.profileWrites.findIndex(item => item.method === 'PUT' && item.body?.conversation_id === boundConversationId);
  assert.ok(postIndex >= 0 && bindIndex > postIndex, '必须先保存业务资料包，再绑定到新顾客对话');
  await page.waitForTimeout(100);
  assert.equal(report.profileWrites.filter(item => item.method === 'POST' && item.body?.name === acceptanceName).length, 1, '连续点击不得重复创建业务资料包');
  assert.equal(report.profileWrites.filter(item => item.method === 'PUT' && item.body?.id === createdProfileId && item.body?.conversation_id === boundConversationId).length, 1, '连续点击不得重复绑定或创建顾客对话');
  await consultation.waitFor({ state:'hidden', timeout:30_000 });
  const supplementButton = page.getByRole('button', { name:'补充资料', exact:true });
  await supplementButton.waitFor({ state:'visible', timeout:30_000 });
  await supplementButton.click();
  const supplementDialog = page.getByTestId('business-ip-intake');
  await supplementDialog.waitFor({ state:'visible' });
  const profileSelect = supplementDialog.getByLabel('给当前顾客对话绑定哪项业务');
  await page.waitForFunction(expectedProfileId => {
    const select = document.querySelector('[aria-label="给当前顾客对话绑定哪项业务"]');
    return select instanceof HTMLSelectElement && !select.disabled && select.value === expectedProfileId;
  }, createdProfileId, { timeout:30_000 });
  assert.equal(await profileSelect.inputValue(), createdProfileId, '当前顾客对话没有读回已绑定的业务资料包');
  assert.ok((await profileSelect.locator('option:checked').innerText()).includes('当前已绑定'), '绑定状态没有显示给会员');
  assert.equal(await supplementDialog.getByLabel('已整理资料包或前面环节成果').inputValue(), acceptanceData, '业务资料包内容未原样读回');
  await page.screenshot({ path:path.join(out,'consultation-profile-bound.png'), fullPage:false });
  await page.keyboard.press('Escape');
  await supplementDialog.waitFor({ state:'hidden' });

  await page.reload({ waitUntil:'domcontentloaded', timeout:60_000 });
  const persisted = await page.evaluate(async conversationId => {
    const response = await fetch(`/api/business-ip/profiles?conversation_id=${encodeURIComponent(conversationId)}`, { cache:'no-store' });
    return { status:response.status, body:await response.json() };
  }, boundConversationId);
  assert.equal(persisted.status, 200, '刷新后业务资料包读取失败');
  assert.equal(persisted.body?.bound_profile_id, createdProfileId, '刷新后顾客对话绑定关系丢失');
  assert.equal(persisted.body?.profiles?.find(profile => profile.id === createdProfileId)?.business_data, acceptanceData, '刷新后业务资料包内容不一致');

  const confirmedAssistantPack = [
    'BUSINESS-ASSISTANT-DATA v1',
    '业务名称：抖音自媒体陪跑',
    '当前状态：草稿',
    '已确认事实：服务抖音发视频没流量、带货亏本的创作者',
    '价格：1999元',
    '交付周期：30天',
    '不能承诺：流量与收益',
    '来源：会员提供，待会员确认保存',
  ].join('\n');
  const markedAssistantPack = `已按现有资料整理，请核对。\n<!-- BUSINESS_ASSISTANT_DATA_BEGIN -->\n${confirmedAssistantPack}\n<!-- BUSINESS_ASSISTANT_DATA_END -->`;
  let mockedConversationDetailReads = 0;
  await page.route('**/api/conversations/history**', async route => {
    const request = route.request();
    if (request.method() !== 'GET') return route.continue();
    const url = new URL(request.url());
    const requestedId = url.searchParams.get('id');
    const now = new Date().toISOString();
    if (requestedId === boundConversationId) {
      mockedConversationDetailReads += 1;
      return route.fulfill({
        status:200,
        contentType:'application/json',
        body:JSON.stringify({
          conversation:{
            id:boundConversationId,
            user_id:'desktop-acceptance-user',
            agent_id:'agent-1787160183236-5fi3w8',
            title:'咨询回复验收',
            source:'llm',
            created_at:now,
            updated_at:now,
            messages:[{id:'assistant-pack-1',role:'assistant',content:markedAssistantPack,reasoning_content:'',agent_id:'agent-1787160183236-5fi3w8',created_at:now}],
          },
        }),
      });
    }
    if (!requestedId && url.pathname.endsWith('/api/conversations/history')) {
      const upstream = await route.fetch();
      const payload = await upstream.json().catch(() => ({}));
      const conversations = Array.isArray(payload.conversations) ? payload.conversations.filter(item => item?.id !== boundConversationId) : [];
      conversations.unshift({id:boundConversationId,user_id:'desktop-acceptance-user',agent_id:'agent-1787160183236-5fi3w8',title:'咨询回复验收',source:'llm',last_message:'已整理业务资料包',created_at:now,updated_at:now});
      return route.fulfill({response:upstream,json:{...payload,conversations}});
    }
    return route.continue();
  });

  await page.reload({ waitUntil:'domcontentloaded', timeout:60_000 });
  await page.getByRole('button', { name:'补充资料', exact:true }).waitFor({ state:'visible', timeout:30_000 });
  for (let attempt = 0; attempt < 100 && mockedConversationDetailReads === 0; attempt += 1) await page.waitForTimeout(100);
  assert.ok(mockedConversationDetailReads > 0, '刷新后未加载当前顾客对话的助手整理结果');
  await page.getByRole('button', { name:'补充资料', exact:true }).click();
  const confirmDialog = page.getByTestId('business-ip-intake');
  await confirmDialog.waitFor({ state:'visible' });
  await page.waitForFunction(expected => {
    const field = document.querySelector('[aria-label="已整理资料包或前面环节成果"]');
    return field instanceof HTMLTextAreaElement && field.value === expected;
  }, confirmedAssistantPack, { timeout:30_000 });
  assert.equal(await confirmDialog.getByLabel('给当前顾客对话绑定哪项业务').inputValue(), createdProfileId, '待确认整理结果必须沿用当前对话已绑定业务');
  assert.equal(await confirmDialog.getByLabel('已整理资料包或前面环节成果').inputValue(), confirmedAssistantPack, '最新助手标准资料包没有预填供会员确认');
  await assert.doesNotReject(() => confirmDialog.getByText('发现小助理刚整理好的标准业务资料包，已放进编辑框。请先核对，再点击更新；确认前不会覆盖你已保存的版本。', { exact:true }).waitFor());
  const confirmSaveResponsePromise = page.waitForResponse(response => {
    if (!response.url().includes('/api/business-ip/profiles') || response.request().method() !== 'PUT') return false;
    try { return response.request().postDataJSON()?.business_data === confirmedAssistantPack; } catch { return false; }
  }, { timeout:30_000 });
  const confirmBindResponsePromise = page.waitForResponse(response => {
    if (!response.url().includes('/api/business-ip/profiles') || response.request().method() !== 'PUT') return false;
    try { return response.request().postDataJSON()?.conversation_id === boundConversationId && response.request().postDataJSON()?.activate === true; } catch { return false; }
  }, { timeout:30_000 });
  await confirmDialog.getByRole('button', { name:'更新业务资料', exact:true }).click();
  const confirmSaveResponse = await confirmSaveResponsePromise;
  const confirmBindResponse = await confirmBindResponsePromise;
  assert.equal(confirmSaveResponse.ok(), true, '会员确认后的标准资料包版本化保存失败');
  assert.equal(confirmBindResponse.ok(), true, '会员确认后的最新资料版本未重新绑定当前顾客对话');
  const confirmedReadback = await page.evaluate(async ({conversationId,profileId}) => {
    const response = await fetch(`/api/business-ip/profiles?conversation_id=${encodeURIComponent(conversationId)}`, { cache:'no-store' });
    const body = await response.json();
    return {status:response.status,profile:body?.profiles?.find(item => item.id === profileId),boundProfileId:body?.bound_profile_id};
  }, {conversationId:boundConversationId,profileId:createdProfileId});
  assert.equal(confirmedReadback.status, 200, '会员确认后资料包读回失败');
  assert.equal(confirmedReadback.boundProfileId, createdProfileId, '会员确认后当前顾客对话绑定丢失');
  assert.equal(confirmedReadback.profile?.business_data, confirmedAssistantPack, '未经或已经确认的资料包状态混淆');
  assert.ok(Number(confirmedReadback.profile?.version || 0) >= 2, '会员确认必须形成新版本');
  await page.keyboard.press('Escape');
  await confirmDialog.waitFor({ state:'hidden' });

  report.checks = {categoryNavigationOrder:true,allViewPinnedOrder:true,categoryOrder:true,positioningPlainLanguage:true,positioningChoices:true,routeAwareTemplate:true,positioningTemplate:true,legacyBusinessQuestionnaireRemoved:true,roleSpecificIntakes:6,sevenStepLoop:true,consultationModes:2,platformIndustryKnowledgeBoundary:true,firstProfileSaved:true,singleSubmitLock:true,profileBoundBeforeChat:true,boundProfileVisibleInConversation:true,refreshReadback:true,assistantPackDetectedAfterReload:true,assistantPackRequiresMemberConfirmation:true,confirmedPackVersionedAndRebound:true};
  assert.deepEqual(report.paidRequests, []);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.serverErrors, []);
  report.version = await page.evaluate(async () => fetch('/api/version').then(value => value.json()));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (createdProfileId) {
    const cleanup = await fetch(`${origin}/api/business-ip/profiles?id=${encodeURIComponent(createdProfileId)}`, { method:'DELETE', headers:{ Authorization:`Bearer ${token}` } }).catch(() => null);
    report.cleanup = { profileId:createdProfileId, deleted:Boolean(cleanup?.ok), status:cleanup?.status || 0 };
  }
  await fs.writeFile(path.join(out,'report.json'), JSON.stringify(report,null,2));
  await browser.close();
  console.log(JSON.stringify(report));
}
