#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const output='.codex-evidence/admin-full-acceptance-20261030-9592a6d0/image-extra-ui';
const origin='http://127.0.0.1:49998';
const require=createRequire(import.meta.url),esbuild=createRequire(require.resolve('tsx/package.json'))('esbuild');
const extraA={resolution_options:['1K','2K'],resolution_prices:{'1K':.08,'2K':.12},submit:{path:'/v1/images',options:{n:1}},poll:{interval:3},future_provider_field:{nested:['a',7,true,null]}};
const extraB={future_provider_field:{profile:'second'},poll:{interval:9}};
const fixture=(id,extra)=>({id,name:id,model_type:'drawing',model_name:'fixture-image-model',provider:'secure_skill',protocol_type:'images_generations_async',api_endpoint:'https://fixture.invalid/v1',api_key_configured:true,cost_price:.05,cost_per_use:.08,sort_order:2,admin_notes:'fixture note',supports_image_input:true,
  api_protocol_config:{...extra,protocol:'images_generations_async',reference_transport:'generations_url_array',admin_notes:'fixture note',canary_verified:true,canaryVerified:true,verification_notice:'prior proof',verificationNotice:'prior proof',__model_activation_gate:{state:'accepted'}}});
const models={a:fixture('Fixture A',extraA),b:fixture('Fixture B',extraB)};
const bundle=await esbuild.build({stdin:{contents:`import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import Dialog from './src/components/unified-model-dialog';const models=${JSON.stringify(models)};window.saves=[];function App(){const [model,setModel]=useState(models.a);const [revision,setRevision]=useState(0);useEffect(()=>{window.fixture={switchTo:key=>setModel(models[key]),reopen:key=>{setModel(models[key]);setRevision(n=>n+1);},reopenNew:()=>{setModel(null);setRevision(n=>n+1);}};},[]);return <Dialog key={revision} model={model} modelType="drawing" onClose={()=>{}} onSave={value=>window.saves.push(value)}/>;}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',tsconfig:'tsconfig.json'});
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const requests=[],errors=[],checks=[];
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.dismiss());
  await page.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());requests.push({method:request.method(),path:url.pathname});
    assert.equal(url.origin,origin,'NO_REAL_NETWORK');assert.equal(request.method(),'GET','NO_BUSINESS_WRITES');
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<html><head><style>body{font:14px sans-serif;background:#f8fafb}button,input,select,textarea{margin:4px;padding:8px} [role=dialog]{position:fixed;inset:12px;overflow:auto;background:white;padding:20px}textarea{width:90%}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'});
    if(url.pathname==='/fixture.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
    return route.abort('blockedbyclient');
  });
  await page.goto(origin);await page.waitForFunction(()=>window.fixture);
  const dialog=page.getByRole('dialog'),summary=dialog.getByText('更多接口参数',{exact:true}),editor=dialog.getByLabel('图片额外接口参数',{exact:true}),save=dialog.getByRole('button',{name:'保存为候选',exact:true});
  assert.equal(await editor.isVisible(),false,'DEFAULT_COLLAPSED');await summary.click();
  assert.deepEqual(JSON.parse(await editor.inputValue()),extraA);checks.push('default-collapsed-and-complete-existing-unknown-fields-with-readiness-filtered');
  const invalids=['{broken','[]','null','{"protocol":"other"}','{"reference_transport":"none"}','{"admin_notes":"injected"}',...['canary_verified','canaryVerified','verification_notice','verificationNotice','__model_activation_gate'].map(key=>JSON.stringify({[key]:true})),'{"nested":{"api_key":"fixture-only"}}'];
  for(const raw of invalids){
    await editor.fill(raw);assert.equal(await save.isDisabled(),true);await dialog.locator('#image-extra-config-error').waitFor({state:'visible'});
    // Invoke the real React handler to prove its guard as well as disabled UI.
    await save.evaluate(element=>{const key=Object.keys(element).find(key=>key.startsWith('__reactProps$'));element[key].onClick();});
    assert.equal(await page.evaluate(()=>window.saves.length),0);assert.equal(await editor.inputValue(),raw);
  }
  checks.push('invalid-json-array-null-owned-eight-fields-and-nested-credential-all-block-button-and-real-handler');
  const malformed='{preserve-this-draft';await editor.fill(malformed);await summary.click();
  await dialog.getByLabel('用户展示名称',{exact:true}).fill('Base field changed');await dialog.locator('select').nth(1).selectOption('images_generations');await summary.click();
  assert.equal(await editor.inputValue(),malformed);assert.equal(await save.isDisabled(),true);await dialog.locator('select').nth(1).selectOption('images_generations_async');checks.push('invalid-raw-draft-survives-collapse-and-basic-field-change');
  const valid={...extraA,unknown_nested:{future:[{flag:true,count:3}],nullable:null}};
  await editor.fill(JSON.stringify(valid));assert.equal(await save.isEnabled(),true);
  await save.click();await save.click();
  const saved=await page.evaluate(()=>window.saves);
  assert.equal(saved.length,2);
  for(const value of saved){assert.deepEqual(value.api_protocol_config,{...valid,protocol:'images_generations_async',reference_transport:'generations_url_array'});assert.equal(value.admin_notes,'fixture note');}
  checks.push('valid-unknown-nested-price-submit-poll-fields-survive-repeated-real-save-with-owned-controls');
  await page.evaluate(()=>window.fixture.switchTo('b'));
  await page.waitForFunction(()=>document.querySelector('[aria-label="用户展示名称"]')?.value==='Fixture B');
  assert.deepEqual(JSON.parse(await editor.inputValue()),extraB);assert.equal(await save.isEnabled(),true);
  await editor.fill('{bad-b');await page.evaluate(()=>window.fixture.reopen('a'));
  await page.waitForFunction(()=>document.querySelector('[aria-label="用户展示名称"]')?.value==='Fixture A');
  assert.equal(await editor.isVisible(),false);await summary.click();assert.deepEqual(JSON.parse(await editor.inputValue()),extraA);assert.equal(await save.isEnabled(),true);
  checks.push('switch-and-reopen-reset-draft-from-complete-correct-model-without-cross-model-leak');
  await page.evaluate(()=>window.fixture.reopenNew());
  await page.waitForFunction(()=>document.querySelector('[aria-label="用户展示名称"]')?.value==='');
  await summary.click();assert.deepEqual(JSON.parse(await editor.inputValue()),{});
  await dialog.getByLabel('用户展示名称',{exact:true}).fill('New fixture model');
  await dialog.getByLabel('模型 ID',{exact:true}).fill('new-fixture-model');
  await dialog.getByLabel('接入站点 API 地址',{exact:true}).fill('https://fixture.invalid/v1');
  await dialog.getByLabel('API 密钥',{exact:true}).fill('fixture-only');
  await dialog.getByLabel('售价',{exact:true}).fill('.08');await dialog.getByLabel('成本价',{exact:true}).fill('.05');
  await editor.fill(JSON.stringify(valid));await save.click();
  const created=await page.evaluate(()=>window.saves.at(-1));
  assert.equal(await page.evaluate(()=>window.saves.length),3);
  assert.deepEqual(created.api_protocol_config,{...valid,protocol:'images_generations',reference_transport:'generations_url_array'});
  checks.push('new-model-complete-extra-configuration-saved-through-real-handler');
  await page.screenshot({path:path.join(output,'drawing-extra-valid.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const source='src/components/unified-model-dialog.tsx';
  const report={passed:true,actualReactComponent:true,sourceSha256:crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'),checks,invalidCases:invalids.length,requests,pageErrors:errors,realNetworkCalls:0,providerCalls:0,databaseWrites:0,scope:'isolated actual component; exact running app visual acceptance remains root-owned'};
  await fs.writeFile(path.join(output,'isolated-browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await browser.close();}
