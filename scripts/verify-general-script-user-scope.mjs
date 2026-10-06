import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';

// Actual React components and storage modules. Auth, navigation and all HTTP are isolated fixtures.
// No real login credentials are accepted; no request reaches the application or an upstream.
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('tsx'))('esbuild');
const baseline = process.argv.includes('--baseline');
const evidence = '.codex-evidence/general-script-user-scope-20260903';
await mkdir(evidence, { recursive: true });
const authStub = `import React,{createContext,useContext,useState,useEffect} from 'react';const C=createContext(null);export const useApp=()=>useContext(C);export function FixtureProvider({children}){const [actor,setActor]=useState('A');useEffect(()=>{window.fixtureActor=setActor},[]);return <C.Provider value={{state:{auth:{user:actor?{id:actor}:null,token:actor?'fixture-'+actor:null,isAuthenticated:!!actor}}}}>{children}</C.Provider>}`;
const routeStub = `export const useAppScopedRouter=()=>({push:href=>window.fixtureNavigations.push(href)});export const useRouter=useAppScopedRouter;const params=new URLSearchParams();export const useSearchParams=()=>params;`;
const linkStub = `import React from 'react';export const AppScopedLink=({children,...props})=><a {...props}>{children}</a>;`;
const headerStub = `import React from 'react';export const SubPageHeader=({title,subtitle})=><header><h1>{title}</h1><p>{subtitle}</p></header>;`;
const source = `import React from 'react';import {createRoot} from 'react-dom/client';import {FixtureProvider} from '@/contexts/app-context';import {GeneralScriptOfficial} from './src/features/general-script-official/general-script-official';import {YoucaiGeneralScript} from './src/features/youcai-general-script/youcai-general-script';import {GeneralScriptWorkbench} from './src/features/general-script/general-script-workbench';import * as storage from './src/features/general-script/storage';import * as submission from './src/features/general-script/submission-storage';import {DEFAULT_GENERAL_SCRIPT_DRAFT as defaults} from './src/features/general-script/types';window.fixtureStorage={...storage,...submission,defaults};window.fixtureNavigations=[];const mode=new URLSearchParams(location.search).get('mode');createRoot(document.getElementById('root')).render(<FixtureProvider>{mode==='youcai'?<YoucaiGeneralScript/>:mode==='legacy'?<GeneralScriptWorkbench/>:<GeneralScriptOfficial variant={mode==='formal'?'formal':'general'}/>}</FixtureProvider>);`;
const bundle = await esbuild.build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'general-script-scope-fixture.tsx', loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent', plugins: [{ name: 'fixture-boundaries', setup(build) {
  const stubs = new Map([['@/contexts/app-context',authStub],['@/hooks/use-app-scoped-router',routeStub],['next/navigation',routeStub],['@/components/app-scoped-link',linkStub],['@/components/sub-page-header',headerStub]]);
  build.onResolve({ filter: /^(?:@\/contexts\/app-context|@\/hooks\/use-app-scoped-router|next\/navigation|@\/components\/app-scoped-link|@\/components\/sub-page-header)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs.get(args.path), loader: 'tsx', resolveDir: process.cwd() }));
  build.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
  if (baseline) build.onLoad({ filter: /general-script-official\.tsx$/ }, async args => ({ contents: await readFile('任务快照/general-script-user-scope-20260903-013852/src__features__general-script-official__general-script-official.tsx','utf8'), loader:'tsx', resolveDir:path.dirname(args.path) }));
} }] });
const configs = baseline ? [{ mode:'official',key:'general_script_official_draft_v1',selector:'#general-script-requirements',generate:'生成剧本' }] : [
  { mode:'official',key:'general_script_official_draft_v1',selector:'#general-script-requirements',generate:'生成剧本' },
  { mode:'formal',key:'formal_script_official_draft_v1',selector:'#formal-script-requirements',generate:'生成正剧剧本' },
  { mode:'youcai',key:'youcai_general_script_draft_v1',selector:'#youcai-general-script-requirements',generate:'生成剧本' },
  { mode:'legacy',key:'general_script_draft_v1',selector:'#script-brief',generate:'生成完整项目' },
];
const key = (base,owner) => `${base}:user:${owner}`;
const browser = await chromium.launch({headless:true});
const report = { baseline, actualComponents:true, actualStorageModules:true, authenticationAndNetworkMocked:true, upstreamRequests:0, businessWrites:0, cases:[] };
try {
  for (const config of configs) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests=[], pageErrors=[];
    const row={ mode:config.mode,checks:[],pageErrors };
    report.cases.push(row);
    page.on('pageerror', error => pageErrors.push(error.name));
    const makeDraft = owner => ({schemaVersion:1,creationMode:'original',requirements:`ACCOUNT_${owner}_PRIVATE_DRAFT`,brief:`ACCOUNT_${owner}_PRIVATE_DRAFT`,sourceMaterial:`ACCOUNT_${owner}_SOURCE`,characterArc:`ACCOUNT_${owner}_CHARACTER_ARC`,relationshipConflict:`ACCOUNT_${owner}_RELATIONSHIP_CONFLICT`,episodesToGenerate:1});
    const legacy = JSON.stringify(makeDraft('LEGACY'));
    await context.addInitScript(({ base, a, b, legacy }) => { if (!localStorage.getItem('fixture-initialized')) { localStorage.setItem(base,legacy);localStorage.setItem(`${base}:user:A`,JSON.stringify(a));localStorage.setItem(`${base}:user:B`,JSON.stringify(b));localStorage.setItem('fixture-initialized','true'); } },{base:config.key,a:makeDraft('A'),b:makeDraft('B'),legacy});
    await context.route('**/*', async route => {
      const request=route.request(),url=new URL(request.url());
      if(request.method()==='POST'){
        assert.equal(url.origin,'https://general-script-fixture.test');assert.equal(url.pathname,'/api/short-drama/script');
        requests.push({key:request.headers()['idempotency-key'],body:request.postDataJSON(),token:request.headers().authorization});
        return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'FIXTURE_UPSTREAM_OUTCOME_UNKNOWN',code:'OUTCOME_UNKNOWN'})});
      }
      if(url.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
      if(url.pathname==='/api/short-drama/health')return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,storageMode:'native',nativeSchemaReady:true,migrationStatus:'ready',paidModelCallsEnabled:true})});
      if(url.pathname.startsWith('/api/'))throw new Error(`UNEXPECTED_FIXTURE_API_${url.pathname}`);
      return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script src="/bundle.js"></script>'});
    });
    const next = () => page.getByRole('button',{name:'下一步：输入内容',exact:true}).click();
    const allValues = () => page.locator('input,textarea').evaluateAll(elements=>elements.map(element=>element.value));
    const waitValue = expected => page.waitForFunction(({selector,expected})=>document.querySelector(selector)?.value===expected,{selector:config.selector,expected});
    const waitSaved = (owner,expected) => page.waitForFunction(({base,owner,expected,mode})=>{const d=JSON.parse(localStorage.getItem(`${base}:user:${owner}`)||'null');return (mode==='legacy'?d?.brief:d?.requirements)===expected;},{base:config.key,owner,expected,mode:config.mode});
    const submitUnknown = async () => {await page.getByRole('button',{name:config.generate,exact:true}).click();await page.getByRole('alert').filter({hasText:'FIXTURE_UPSTREAM_OUTCOME_UNKNOWN'}).waitFor();};
    await page.goto(`https://general-script-fixture.test/?mode=${config.mode}`,{waitUntil:'load'});
    await page.waitForFunction(()=>typeof window.fixtureActor==='function');
    await next();
    if(baseline){
      await waitValue('ACCOUNT_LEGACY_PRIVATE_DRAFT');
      await page.locator(config.selector).fill('ACCOUNT_A_EDITED');
      await page.waitForFunction(base=>JSON.parse(localStorage.getItem(base)).requirements==='ACCOUNT_A_EDITED',config.key);
      await page.evaluate(()=>window.fixtureActor('B'));
      await waitValue('ACCOUNT_A_EDITED');
      row.checks.push('before repair: ownerless draft loaded and A editing remains visible after switch to B');
      row.crossAccountDraftLeakReproduced=true;
      await context.close();continue;
    }
    await waitValue('ACCOUNT_A_PRIVATE_DRAFT');
    assert.ok(!(await allValues()).some(v=>v.includes('LEGACY')));
    await page.locator(config.selector).fill('ACCOUNT_A_EDITED');await waitSaved('A','ACCOUNT_A_EDITED');
    row.checks.push('A reads and writes only own draft; ownerless draft not claimed');
    await submitUnknown();assert.equal(requests.length,1);
    const originalKey=requests[0].key;assert.ok(originalKey);
    await page.evaluate(()=>window.fixtureActor('B'));await next();await waitValue('ACCOUNT_B_PRIVATE_DRAFT');
    assert.ok(!(await allValues()).some(v=>v.includes('ACCOUNT_A')||v.includes('LEGACY')));
    await page.locator(config.selector).fill('ACCOUNT_B_EDITED');await waitSaved('B','ACCOUNT_B_EDITED');
    row.checks.push('switch to B removes A draft and submission UI; B edits stay separate');
    await page.evaluate(()=>window.fixtureActor(null));await page.getByRole('status').filter({hasText:'请先登录'}).waitFor();assert.equal(await page.locator('textarea').count(),0);
    await page.evaluate(()=>window.fixtureActor('A'));await next();await waitValue('ACCOUNT_A_EDITED');assert.equal(requests.length,1);
    row.checks.push('logout clears editor; return to A restores own draft without automatic POST');
    await submitUnknown();assert.equal(requests.length,2);assert.equal(requests[1].key,originalKey);assert.deepEqual(requests[1].body,requests[0].body);assert.equal(requests[1].token,'Bearer fixture-A');
    row.checks.push('manual retry after identity remount keeps original unknown request ID and body');
    await page.reload({waitUntil:'load'});await page.waitForFunction(()=>typeof window.fixtureActor==='function');await next();await waitValue('ACCOUNT_A_EDITED');assert.equal(requests.length,2);
    await submitUnknown();assert.equal(requests[2].key,originalKey);assert.equal(requests.length,3);
    row.checks.push('reload keeps original unknown request and requires explicit submit');
    if(config.mode!=='legacy')await page.getByRole('button',{name:'返回修改需求',exact:true}).click();
    await page.locator(config.selector).fill('ACCOUNT_A_DIFFERENT_REQUEST');await submitUnknown();assert.equal(requests.length,4);assert.notEqual(requests[3].key,originalKey);
    const persisted=await page.evaluate(({base,originalKey,legacy,mode})=>{const a=JSON.parse(localStorage.getItem(`${base}:user:A`)),b=JSON.parse(localStorage.getItem(`${base}:user:B`));return {legacy:localStorage.getItem(base)===legacy,oldRequest:!!localStorage.getItem(`${base}:pending-request:user:A:${encodeURIComponent(originalKey)}`),a:mode==='legacy'?a.brief:a.requirements,b:mode==='legacy'?b.brief:b.requirements,navigations:window.fixtureNavigations.length};},{base:config.key,originalKey,legacy,mode:config.mode});
    assert.equal(persisted.legacy,true);assert.equal(persisted.oldRequest,true);assert.equal(persisted.a,'ACCOUNT_A_DIFFERENT_REQUEST');assert.equal(persisted.b,'ACCOUNT_B_EDITED');assert.equal(persisted.navigations,0);
    row.checks.push('explicit different input gets a new ID while prior unknown record and legacy bytes remain');
    if(config.mode!=='legacy')await page.getByRole('button',{name:'返回修改需求',exact:true}).click();
    await page.locator(config.selector).fill('QUOTA_FAILURE_MUST_NOT_SUBMIT');
    await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes(':pending-request:'))throw new DOMException('Fixture quota','QuotaExceededError');return original.call(this,k,v);};});
    await page.getByRole('button',{name:config.generate,exact:true}).click();await page.getByRole('alert').filter({hasText:'本次尚未提交生成'}).waitFor();assert.equal(requests.length,4);
    row.checks.push('request-key storage failure blocks POST before any generation');
    assert.deepEqual(pageErrors,[]);row.mockPosts=requests.length;row.originalUnknownRequestPreserved=true;
    await context.close();
  }
  report.passed=true;
} catch(error) {
  report.passed=false;report.failure={name:error.name,message:error.message};throw error;
} finally {
  await writeFile(path.join(evidence,baseline?'component-baseline.json':'component-fixture.json'),JSON.stringify(report,null,2));
  await browser.close();console.log(JSON.stringify(report));
}
