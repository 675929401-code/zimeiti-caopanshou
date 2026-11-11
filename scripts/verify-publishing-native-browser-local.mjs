import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { chromium } from 'playwright';
import { verifyNativeEdgeUi } from './verify-publishing-native-edge-ui-local.mjs';
import { verifyOwnerNavigation } from './verify-publishing-owner-navigation-local.mjs';

// Run through with-local-admin-session.mjs. Credentials remain in memory;
// only an isolated fixture may write content. No real plugin or paid request.
export async function main() {
  const origin = 'http://127.0.0.1:5000';
  assert.equal(process.env.LOCAL_NAV_ORIGIN, origin);
  const adminToken = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const step = process.env.LOCAL_ADMIN_STEP_UP_TOKEN;
  const adminIdentity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || 'null');
  assert.ok(adminToken && adminIdentity?.user?.id && step);
  assert.notEqual(process.env.PUBLISHING_EXTERNAL_EXECUTION_ENABLED, 'true');
  const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json','utf8')).replace(/^\uFEFF/,''));
  assert.equal(runtime.localOnly,true); assert.equal(runtime.ownerConnection?.host,'127.0.0.1'); assert.equal(Number(runtime.ownerConnection?.port),54322); assert.equal(runtime.ownerConnection?.database,'zimeiti_local');
  const directory = path.resolve('.codex-evidence/publish-center-native-20261110-a6b42cea/browser'); await fs.mkdir(directory,{recursive:true});
  const report = { passed:false, checks:[], screenshots:[], errors:[], blockedWrites:[], externalRequestsBlocked:0, realPosts:0, paidCalls:0, fixtureCleaned:false, scope:{auth:'in-memory fixture JWT and read-only actual admin projection',publishingApi:'real local V1/V2 CRUD',plugin:'zero-network mock; execution gate remains closed'} };
  const check = (name,value,detail) => { report.checks.push({name,passed:!!value,...(detail===undefined?{}:{detail})}); assert.ok(value,name); };
  const db = new pg.Client({...runtime.ownerConnection,application_name:'codex-native-browser-fixture'});
  const userId = randomUUID(), sessionId = `pub-native-${randomUUID()}`, username = `pubnative${userId.replaceAll('-','')}`;
  const user = {id:userId,username,displayName:'原生发布本地验收',display_name:'原生发布本地验收',role:'student',memberStatus:'active',sessionId};
  let browser, inserted=false, token='';
  const request = async(route,bearer,body) => { const response = await fetch(origin+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${bearer}`,...(bearer===adminToken?{'x-admin-step-up':step}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)}); return {status:response.status,data:await response.json()}; };
  const beforeSnapshot = async() => (await db.query(`SELECT
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(u) ORDER BY id)::text,'[]')) FROM public.users u WHERE id<>$1) users,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY version)::text,'[]')) FROM public.pub_config_versions c) config,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY user_id)::text,'[]')) FROM public.member_permission_assignments a WHERE user_id<>$1) permissions,
    (SELECT count(*)::int FROM public.wallet_operations WHERE user_id::text<>$1::text) wallet_ops`,[userId])).rows[0];
  let invariant;
  try {
    await db.connect(); invariant=await beforeSnapshot();
    await db.query('BEGIN'); await db.query("SELECT set_config('app.member_permission_write','on',true)");
    await db.query("INSERT INTO public.users(id,username,email,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status,session_id) VALUES($1,$2,$3,'local-unusable-password-hash','原生发布本地验收','student',0,0,true,'active','active',$4)",[userId,username,`${username}@fixture.invalid`,sessionId]);
    const features=JSON.stringify(['marketplace','toolbox','storyboard_workbench','create','voice','cover','publish_center','youcai','commerce_agent']);
    await db.query("INSERT INTO public.member_permission_assignments(user_id,feature_navigation_keys,agent_navigation_keys,revision,checksum,source,reason) VALUES($1::text,$2::jsonb,'[]',1,public.member_permission_checksum($1::text,$2::jsonb,'[]',1),'custom','isolated native browser fixture') ON CONFLICT(user_id) DO UPDATE SET feature_navigation_keys=EXCLUDED.feature_navigation_keys,agent_navigation_keys='[]',revision=1,checksum=EXCLUDED.checksum",[userId,features]);
    await db.query("INSERT INTO public.user_auth_sessions(user_id,session_id,expires_at) VALUES($1,$2,now()+interval '1 hour') ON CONFLICT(session_id) DO NOTHING",[userId,sessionId]);
    inserted=true; await db.query('COMMIT');
    token=await new SignJWT({userId,username,role:'student',displayName:user.displayName,sessionId}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('30m').sign(new TextEncoder().encode(runtime.jwtSecret));
    report.runtime=(await request('/api/version',token)).data;
    const first=await request('/api/publish-center',token); check('real local member access and legacy schema ready',first.status===200&&first.data.schemaReady&&first.data.access.allowed);
    check('sales and external publishing remain closed',!first.data.config.salesEnabled&&!first.data.config.executionEnabled);
    const native=await request('/api/publish-center/v2?resource=drafts',token); check('V2 schema ready and paginated',native.status===200&&native.data.schemaReady&&native.data.total===0&&native.data.hasMore===false);
    const provider=await request('/api/publish-center/provider',token); check('provider status discloses no credentials and does not grant execution',provider.status===200&&provider.data.provider.routeExecutionEnabled===false&&provider.data.counts===null&&!/apiKey|token|cookie|credentialRef/.test(JSON.stringify(provider.data)));
    check('ordinary member denied native admin metadata',(await request('/api/admin/publishing/native',token)).status===403);
    const legacySeed=await request('/api/publish-center',token,{action:'save-draft',expectedRevision:0,draft:{title:'早期验收草稿',body:'旧稿正文保持原样',topics:['旧稿话题'],platforms:['xhs'],assets:[]}});
    check('legacy draft seed uses the original owner-scoped API',legacySeed.status===200&&legacySeed.data.draft?.revision===1);
    browser=await chromium.launch({channel:'msedge',headless:true});
    const contexts=[];
    async function contextFor(theme,bearer=token,identity=user,admin=false){
      const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',...(admin?{extraHTTPHeaders:{'x-admin-step-up':step}}:{})}); contexts.push(context);
      await context.addCookies([{name:'auth_token',value:bearer,url:origin,httpOnly:true,sameSite:'Lax'}]);
      await context.addInitScript(({token,user,theme})=>{
        localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));sessionStorage.setItem('entered_app','1');sessionStorage.setItem('trial_dialog_dismissed','1');localStorage.setItem('user_theme_preference',theme);localStorage.setItem('user_theme_mode_preference',theme==='soft-white'?'light':'dark');localStorage.setItem('user_theme_preference_expires_at',new Date(Date.now()+3600000).toISOString());
        window.__publishingMockCalls=0;
        window.AIToEarnPlugin={getVersion:async()=>({version:'3.3.11'}),checkPermission:async()=>({granted:true}),login:async platform=>({type:platform,uid:`local-${platform}`,account:'local-fixture',nickname:platform==='xhs'?'验收小红书':'验收视频号',loginCookie:'discarded-test-marker'}),publish:async()=>{window.__publishingMockCalls++;throw Error('Unexpected publish');},wxSphSearchLocation:async()=>[{poiId:'local-poi',poiName:'本地验收公园',poiCity:'测试城市'}],wxSphSearchActivity:async()=>[{eventTopicId:'local-event',eventName:'本地验收活动'}]};
      },{token:bearer,user:identity,theme});
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url()); if(url.origin!==origin){report.externalRequestsBlocked++;return route.abort('blockedbyclient');}
        if(url.pathname==='/api/auth/me') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({user:{...identity,themePreference:theme,themeModePreference:theme==='soft-white'?'light':'dark',themePreferenceExpiresAt:new Date(Date.now()+3600000).toISOString()},auth_projection:true})});
        if(url.pathname==='/api/announcements/inbox') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({announcements:[],cursor:'',read_fixture:true})});
        if(url.pathname==='/api/popup-pushes') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,popups:[],read_fixture:true})});
        if(!['GET','HEAD'].includes(req.method())){
          let action;try{action=req.postDataJSON()?.action;}catch{}
          const allowed=!admin&&((url.pathname==='/api/publish-center'&&action==='save-account')||(url.pathname==='/api/publish-center/v2'&&['save-draft','archive-draft','save-collection','save-group','delete-group','save-account-meta','create-batch','save-schedule','reschedule','cancel-schedule'].includes(action)));
          if(!allowed){report.blockedWrites.push({path:url.pathname,method:req.method(),action});return route.abort('blockedbyclient');}
        }
        return route.continue();
      });
      return context;
    }
    const snap=async(page,name,admin=false)=>{const file=path.join(directory,`${name}.png`);const mask=admin?[page.locator('[data-testid="sidebar-user-menu-trigger"]'),page.getByText(adminIdentity.user.username,{exact:false})]:[];await page.screenshot({path:file,fullPage:true,mask});report.screenshots.push({name,file});};
    const colors=[];
    for(const theme of ['soft-white','lattice','crystal-aurora']){
      const context=await contextFor(theme);const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message.slice(0,250)));
      await page.goto(origin+'/publish-center',{waitUntil:'networkidle'});await page.locator('[data-native-publishing="2"]').waitFor();await page.waitForFunction(()=>!document.body.innerText.includes('正在连接'));
      await page.waitForFunction(theme=>document.documentElement.getAttribute('data-theme')===theme,theme);
      const color=await page.locator('[data-publishing-workbench]').evaluate(el=>({background:getComputedStyle(el).backgroundImage,color:getComputedStyle(el).color,heading:getComputedStyle(el.querySelector('h2')).color,overflow:document.documentElement.scrollWidth>innerWidth}));colors.push(color);
      check(`ivory workspace and readable heading under ${theme}`,!color.overflow&&color.color===color.heading&&!/255, 255, 255/.test(color.heading),color);
      check(`seven operational views under ${theme}`,await page.getByRole('tab').count()===7);
      await page.getByRole('button',{name:'下载发布插件',exact:true}).click();
      for(const [label,href] of [['打开 Chrome 商店','https://chromewebstore.google.com/detail/aitoearn-extension/hnmocdhmnfgcjnedmdgfefcobideaeja'],['下载国内 CRX','https://ai-to-earn.oss-cn-beijing.aliyuncs.com/comment/aitoearn-extension.crx'],['下载 GitHub 版本','https://github.com/yikart/AiToEarn/releases/download/v2.1.0/aitoearn-extension.crx']]) check(`visible official ${label} ${theme}`,await page.getByRole('link',{name:label}).getAttribute('href')===href);
      check(`Authorize Only guidance ${theme}`,await page.getByText(/Authorize Only/).isVisible());await snap(page,`installation-${theme}`);
      if(theme==='soft-white'){
        await page.getByRole('tab',{name:'发布编辑',exact:true}).click();await page.locator('#publishing-title').fill('尚未保存的当前输入');
        await page.getByRole('tab',{name:'内容库',exact:true}).click();
        const legacy=page.getByTestId('legacy-publishing-drafts');await legacy.locator('summary').click();
        const legacyRow=legacy.locator(`[data-legacy-draft-id="${legacySeed.data.draft.id}"]`);await legacyRow.getByRole('button',{name:'复制到新工作台',exact:true}).click();
        await page.getByRole('tab',{name:'发布编辑',exact:true}).click();
        check('legacy copy preserves the currently unsaved editor',await page.locator('#publishing-title').inputValue()==='尚未保存的当前输入');
        const legacyCopied=(await request('/api/publish-center/v2?resource=drafts',token)).data.items.find(item=>item.payload?.title==='早期验收草稿');
        const legacyOriginal=(await request('/api/publish-center',token)).data.drafts.find(item=>item.id===legacySeed.data.draft.id);
        check('legacy copy creates an independent V2 draft without guessing account targets',!!legacyCopied&&legacyCopied.id!==legacyOriginal.id&&legacyCopied.payload.body==='旧稿正文保持原样'&&legacyCopied.payload.targets.length===0);
        check('legacy copy leaves original ID revision and text unchanged',legacyOriginal?.revision===1&&legacyOriginal.title==='早期验收草稿'&&legacyOriginal.body==='旧稿正文保持原样');
        await page.locator('#publishing-title').fill('');
        await page.getByRole('tab',{name:'内容库',exact:true}).click();await page.getByRole('button',{name:'新建内容集合',exact:true}).click();
        let dialog=page.getByRole('dialog');await dialog.getByRole('textbox').nth(0).fill('验收内容集合');await dialog.getByRole('textbox').nth(1).fill('真实本地数据，结束后随验收账号清理');await dialog.getByRole('button',{name:/保存/}).click();await dialog.waitFor({state:'hidden'});
        check('collection dialog persists through real V2 API',(await request('/api/publish-center/v2?resource=collections',token)).data.items.some(item=>item.name==='验收内容集合'));
        await page.getByRole('tab',{name:'发布编辑',exact:true}).click();await page.locator('#publishing-title').fill('原生图文验收');await page.locator('#publishing-body').fill('多图内容与原生声明往返保存');
        const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.getContext('2d').fillRect(0,0,64,64);return canvas.toDataURL('image/png').split(',')[1];});
        await page.locator('input[type="file"][accept="image/jpeg,image/png,image/webp"]').first().setInputFiles([{name:'first.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')},{name:'second.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')}]);
        await page.getByRole('button',{name:'向前移动 second.png',exact:true}).waitFor();await page.getByRole('button',{name:'向前移动 second.png',exact:true}).click();
        await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.waitForTimeout(350);
        const saved=(await request('/api/publish-center/v2?resource=drafts',token)).data.items.find(item=>item.payload?.title==='原生图文验收');check('image order and probed dimensions persist',saved?.payload.media[0].fileName==='second.png'&&saved?.payload.media[0].width===64&&saved?.payload.media.length===2);
        await snap(page,'editor-images');
        await page.getByRole('tab',{name:'账号与分组',exact:true}).click();await page.getByRole('button',{name:'连接平台账号',exact:true}).first().click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'读取当前账号',exact:true}).first().click();await dialog.waitFor({state:'hidden'});
        const accounts=(await request('/api/publish-center',token)).data.accounts;check('plugin account summary saved without credential fields',accounts.length===1&&accounts[0].platform==='xhs'&&!/loginCookie|discarded-test-marker/.test(JSON.stringify(accounts)));
        await page.getByRole('button',{name:'新建分组',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('textbox').fill('验收账号组');await dialog.getByRole('checkbox').first().check();await dialog.getByRole('button',{name:'保存分组',exact:true}).click();await dialog.waitFor({state:'hidden'});
        check('account groups persist with owner account',(await request('/api/publish-center/v2?resource=groups',token)).data.items.some(item=>item.name==='验收账号组'&&item.accountIds[0]===accounts[0].id));await snap(page,'accounts-groups');
        await page.getByRole('tab',{name:'发布编辑',exact:true}).click();await page.getByText('验收小红书',{exact:true}).first().click();await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.waitForTimeout(300);
        // Plan operations below use the real HTTP contract, then the actual calendar UI.
        const current=(await request('/api/publish-center/v2?resource=drafts',token)).data.items.find(item=>item.payload?.title==='原生图文验收');check('selected account target persisted',current?.payload.targets.length===1);
        const future=new Date(Date.now()+2*3600000).toISOString();const plan=await request('/api/publish-center/v2',token,{action:'save-schedule',draftId:current.id,draftVersion:current.revision,targetId:current.payload.targets[0].id,scheduledAt:future});check('local plan saved without quota or plugin calls',plan.status===200&&plan.data.schedule.state==='planned');
        await page.getByRole('button',{name:'刷新工作台',exact:true}).click();await page.waitForTimeout(400);await page.getByRole('tab',{name:'排期日历',exact:true}).click();await page.getByRole('heading',{name:'浏览器执行排期'}).waitFor();await snap(page,'calendar-month');
        await page.getByRole('button',{name:'周视图',exact:true}).click();check('week view has seven day columns',await page.locator('[data-today]').count()===7);await snap(page,'calendar-week');
        const changed=await request('/api/publish-center/v2',token,{action:'reschedule',id:plan.data.schedule.id,expectedRevision:plan.data.schedule.revision,scheduledAt:new Date(Date.now()+3*3600000).toISOString()});check('local plan CAS reschedule',changed.status===200&&changed.data.schedule.revision===2);
        const cancelled=await request('/api/publish-center/v2',token,{action:'cancel-schedule',id:changed.data.schedule.id,expectedRevision:2});check('local plan cancellation persists without dispatch',cancelled.status===200&&cancelled.data.schedule.state==='cancelled');
        await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:'内容库',exact:true}).click();await page.getByRole('button').filter({hasText:'原生图文验收'}).first().click();check('restored local draft explicitly asks to reattach files',await page.getByText(/需要重新关联/).count()>=1);await snap(page,'restored-content');
        for(const [tab,heading,name] of [['发布记录','批次与发布记录','history'],['套餐与额度','套餐与执行额度','plans']]){await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('heading',{name:heading}).waitFor();await snap(page,name);}
        await page.setViewportSize({width:1920,height:1080});await page.getByRole('tab',{name:'发布编辑',exact:true}).click();check('1920 desktop no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await snap(page,'editor-1920');await page.setViewportSize({width:1440,height:900});
        for(const [route,name] of [['/cover','neighbor-cover'],['/youcai','neighbor-youcai'],['/','neighbor-marketplace']]){await page.goto(origin+route,{waitUntil:'networkidle'});const text=await page.locator('body').innerText();check(`adjacent page ${route}`,route==='/youcai'?text.includes('漫剧创作'):text.length>100);await snap(page,name);if(route==='/')check('main navigation still exposes publishing',await page.getByText('发布中心',{exact:true}).count()>0);}
      }
      check(`zero external plugin dispatch ${theme}`,await page.evaluate(()=>window.__publishingMockCalls===0));await context.close();
    }
    check('page palette identical in all host themes',colors.every(color=>color.background===colors[0].background&&color.color===colors[0].color));
    const actualAdmin=await request('/api/admin/publishing/native',adminToken);check('actual admin native metadata uses real data and no provider execution',actualAdmin.status===200&&actualAdmin.data.schemaReady&&actualAdmin.data.provider.routeExecutionEnabled===false);
    const context=await contextFor('soft-white',adminToken,adminIdentity.user,true);const page=await context.newPage();await page.goto(origin+'/admin?tab=publishing',{waitUntil:'networkidle'});await page.getByTestId('publishing-native-readiness').waitFor();check('admin sees official download and V2 readiness',await page.getByTestId('publishing-native-readiness').getByRole('link',{name:'打开官方入口 ↗'}).count()===3);await snap(page,'admin-native-readiness',true);await context.close();
    report.edgeUi=await verifyNativeEdgeUi({browser,origin,token,user,directory:path.join(directory,'edge'),check});
    check('native edge UI fixtures pass without real external writes',report.edgeUi.passed);
    report.ownerNavigation=await verifyOwnerNavigation({origin,token:adminToken,user:adminIdentity.user,directory:path.join(directory,'actual-owner'),check});
    check('actual existing owner navigation and neighbor regression pass',report.ownerNavigation.passed);
    check('no browser JavaScript exceptions',report.errors.length===0,report.errors);report.passed=true;
  } catch(error){report.error=String(error.message).slice(0,600);process.exitCode=1;if(browser)for(const[i,context]of browser.contexts().entries()){const page=context.pages().at(-1);if(page&&!page.isClosed()){await page.screenshot({path:path.join(directory,`failure-${i}.png`),fullPage:true,mask:[page.locator('[data-testid="sidebar-user-menu-trigger"]')]}).catch(()=>{});await fs.writeFile(path.join(directory,`failure-${i}.txt`),(await page.locator('body').innerText().catch(()=>'' )).replaceAll(adminIdentity.user.username,'[redacted]').slice(0,14000));}}}
  finally{
    await browser?.close();
    if(inserted){try{await db.query('ROLLBACK');await db.query('BEGIN');await db.query("SELECT set_config('app.member_permission_write','on',true)");await db.query('DELETE FROM public.pub_accounts WHERE user_id=$1',[userId]);await db.query('DELETE FROM public.pub_drafts WHERE user_id=$1',[userId]);await db.query('DELETE FROM public.users WHERE id=$1 AND username=$2',[userId,username]);await db.query('COMMIT');report.fixtureCleaned=Number((await db.query('SELECT count(*) n FROM public.users WHERE id=$1',[userId])).rows[0].n)===0;}catch(error){await db.query('ROLLBACK').catch(()=>{});report.cleanupError=String(error.message).slice(0,300);report.passed=false;process.exitCode=1;}}
    if(invariant){const after=await beforeSnapshot();report.existingStateInvariant=JSON.stringify(after)===JSON.stringify(invariant);if(!report.existingStateInvariant){report.passed=false;process.exitCode=1;}}
    await db.end();if(!report.fixtureCleaned){report.passed=false;process.exitCode=1;}
    report.reportHash=createHash('sha256').update(JSON.stringify(report.checks)).digest('hex');await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,screenshots:report.screenshots.length,fixtureCleaned:report.fixtureCleaned,existingStateInvariant:report.existingStateInvariant,error:report.error,cleanupError:report.cleanupError}));
  }
}
