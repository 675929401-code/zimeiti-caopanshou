import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createToken } from '@/lib/auth';
import { getSupabaseClient } from '@/storage/database/supabase-client';

type VerificationSession = {
 token: string;
 user: { id: string; username: string; displayName: string; role: 'admin'; credits?: number; cashBalance?: number };
};

async function createVerificationSession(base: string): Promise<VerificationSession> {
 try {
  const response = await fetch(base + '/api/auth/dev-session', { headers: { 'x-local-workbench': 'ai-creation-studio-local' } });
  const session = await response.json() as VerificationSession;
  if (response.ok && session.token && session.user) return session;
 } catch {
  // Production-mode local previews intentionally keep dev-session disabled.
 }
 const db = getSupabaseClient();
 const { data, error } = await db.from('users')
  .select('id,username,display_name,credits,cash_balance')
  .eq('role', 'admin').eq('is_active', true).limit(1).maybeSingle();
 assert.ok(data && !error, error?.message || '本地验收管理员账号不可用');
 const user: VerificationSession['user'] = {
  id: String(data.id), username: String(data.username), displayName: String(data.display_name || '本地验收'),
  role: 'admin', credits: Number(data.credits || 0), cashBalance: Number(data.cash_balance || 0),
 };
 const token = await createToken({ userId: user.id, username: user.username, role: user.role,
  displayName: user.displayName, sessionId: `verify-voice-library-${randomUUID()}` });
 return { token, user };
}

async function main() {
 const base=process.env.VERIFY_BASE_URL || 'http://127.0.0.1:5000';
 assert.equal(new URL(base).hostname,'127.0.0.1');
 const out=path.resolve(process.env.VERIFY_OUTPUT_DIR || '.codex-evidence/voice-recovery'); await mkdir(out,{recursive:true});
 const session=await createVerificationSession(base);
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try {
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}}); await ctx.addInitScript(({token,user})=>{localStorage.setItem('auth_token',token);localStorage.setItem('auth_user',JSON.stringify(user));},{token:session.token,user:session.user});
 const p=await ctx.newPage(); p.setDefaultTimeout(15000); const errors:string[]=[]; p.on('pageerror',e=>errors.push(e.message));
 let fail=true; let delay=false; const requests:string[]=[];
 await p.route('**/api/voice/list?*',async route=>{requests.push(route.request().url()); if(fail){await route.fulfill({status:503,json:{success:false,error:'Controlled catalog failure'}});return;} if(delay)await new Promise(resolve=>setTimeout(resolve,1200)); await route.continue();});
 await p.goto(base+'/voice-studio/voices'); await p.getByRole('button',{name:'重新加载音色',exact:true}).waitFor(); await p.getByRole('button',{name:'重新加载推荐',exact:true}).waitFor();
 assert.equal(await p.getByText('没有找到匹配音色',{exact:true}).count(),0);
 assert.equal(await p.getByRole('heading',{name:'上周热门音色 · 0个',exact:true}).count(),0);
 const search=p.getByPlaceholder('搜索音色名称或 speaker_id...'); await search.fill('思思');
 await p.waitForResponse(r=>r.url().includes('keyword=')&&r.status()===503);
 await p.getByRole('button',{name:'重新加载音色',exact:true}).waitFor();
 fail=false;delay=true; await p.getByRole('button',{name:'重新加载音色',exact:true}).click();
 await p.getByRole('status',{name:'音色列表加载中'}).waitFor({state:'visible'});
 assert.equal(await search.inputValue(),'思思');
 await p.getByRole('button',{name:'重新加载推荐',exact:true}).waitFor({state:'hidden'});
 await p.getByRole('status',{name:'音色列表加载中'}).waitFor({state:'hidden'});
 await p.getByRole('heading',{name:/上周热门音色 · [1-9]/}).waitFor();
 assert.equal(await search.inputValue(),'思思');
 const catalogCards=p.locator('[data-voice-id="zh_female_shuangkuaisisi_uranus_bigtts"]'); await catalogCards.last().waitFor();
 assert.equal(await p.getByRole('button',{name:'重新加载音色',exact:true}).count(),0);
 const atlas=await p.evaluate(async()=>{const image=new Image(); image.src='/avatars/voice-studio/portraits.webp';await image.decode();return {width:image.naturalWidth,height:image.naturalHeight};}); assert.ok(atlas.width>100&&atlas.height>100);
 await p.screenshot({path:path.join(out,'voice-recovery-desktop.png'),fullPage:true});
 await p.setViewportSize({width:390,height:844});await p.mouse.move(200,400);await p.mouse.wheel(0,900);await p.waitForTimeout(400);
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
 await writeFile(path.join(out,'voice-recovery.json'),JSON.stringify({passed:true,controlledFailure:true,mainAndRecommendedRecovered:true,searchRetained:true,noFalseEmpty:true,loadingVisible:true,atlas,mobileNoOverflow:true,requests:requests.map(u=>new URL(u).search)},null,2));
 console.log('PASS voice list/recommendations retry, retained search, loading, atlas decode and mobile layout');
 } finally {await browser.close();}
}
main().catch(e=>{console.error(e instanceof Error?e.stack:String(e));process.exitCode=1;});
