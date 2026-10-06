#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { chromium } from 'playwright';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('tsx'))('esbuild');
const before = process.argv.find((value) => value.startsWith('--before='))?.slice(9);
assert.ok(before, 'Pass --before=<backed-up hook>');
const current = path.resolve('src/hooks/use-persisted-state.ts');
const output = path.resolve('.codex-evidence/persisted-state-hydration-20260902');
fs.mkdirSync(output, { recursive: true });
const harness = `
import React, {useState, useLayoutEffect, useRef} from 'react';
import {usePersistedState} from 'fixture-hook';
export function Harness() {
 const cfg=globalThis.fixtureConfig;
 const [key,setKey]=useState('a');
 const [value,setValue,clear]=usePersistedState(key,0,cfg.validate===false?undefined:(v)=>typeof v==='number');
 const first=useRef(setValue);
 if(globalThis.fixtureRenders) globalThis.fixtureRenders.push({key,value,setterStable:first.current===setValue});
 useLayoutEffect(()=>{if(cfg.earlyUpdate)setValue(v=>Number(v)+2);},[]);
 return <div><output id="value">{JSON.stringify(value)}</output>
 <input id="edit" value={String(value??'')} onChange={e=>setValue(Number(e.target.value))}/>
 <button id="twice" onClick={()=>{setValue(v=>Number(v)+1);setValue(v=>Number(v)+1);}}>twice</button>
 <button id="key" onClick={()=>setKey(k=>k==='a'?'b':'a')}>key</button>
 <button id="clear" onClick={clear}>clear</button></div>;
}`;
const bundleCache = new Map();
function compile(source) { return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText; }
function serverMarkup(file, config) {
  const hookModule = { exports: {} };
  vm.runInNewContext(compile(fs.readFileSync(file, 'utf8')), { module: hookModule, exports: hookModule.exports, require: (id) => { assert.equal(id, 'react'); return React; } });
  const appModule = { exports: {} };
  vm.runInNewContext(compile(harness), { module: appModule, exports: appModule.exports, require: (id) => id === 'react' ? React : hookModule.exports, fixtureConfig: config });
  return renderToString(React.createElement(appModule.exports.Harness));
}
async function clientBundle(file) {
  if (bundleCache.has(file)) return bundleCache.get(file);
  const entry = harness.replace("'fixture-hook'", JSON.stringify(file.replaceAll('\\', '/'))) + `\nimport {hydrateRoot} from 'react-dom/client';
 hydrateRoot(document.getElementById('root'),globalThis.fixtureConfig.strict?<React.StrictMode><Harness/></React.StrictMode>:<Harness/>,{onRecoverableError:e=>globalThis.fixtureErrors.push(e.message)});`;
  const result = await esbuild.build({ stdin: { contents: entry, sourcefile: 'hook-fixture.tsx', resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' });
  const code = result.outputFiles[0].text; bundleCache.set(file, code); return code;
}
const browser = await chromium.launch({ headless: true });
const cases = [];
async function fixture(file, config = {}, entries = { a: '7', b: '11' }) {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  const bundle = await clientBundle(file);
  const markup = serverMarkup(file, config);
  await context.addInitScript(({config,entries})=>{
    globalThis.fixtureConfig=config;globalThis.fixtureRenders=[];globalThis.fixtureErrors=[];globalThis.storageWrites=[];
    for(const [key,value] of Object.entries(entries)) sessionStorage.setItem('app_state_'+key,value);
    const set=Storage.prototype.setItem; const get=Storage.prototype.getItem;
    Storage.prototype.setItem=function(key,value){if(key.startsWith('app_state_')){globalThis.storageWrites.push({key,value});if(config.storageUnavailable)throw new Error('fixture storage denied');}return set.call(this,key,value);};
    Storage.prototype.getItem=function(key){if(config.storageUnavailable&&key.startsWith('app_state_'))throw new Error('fixture storage denied');return get.call(this,key);};
  },{config,entries});
  await page.route('**/*', route=>route.fulfill(new URL(route.request().url()).pathname==='/bundle.js'
    ?{status:200,contentType:'text/javascript',body:bundle}
    :{status:200,contentType:'text/html',body:`<!doctype html><div id="root">${markup}</div><script src="/bundle.js"></script>`}));
  await page.goto('http://hook-fixture.test/', { waitUntil: 'load' });
  const value=async expected=>{await page.waitForFunction(expected=>document.getElementById('value')?.textContent===JSON.stringify(expected),expected);};
  const read=()=>page.evaluate(()=>({renders:globalThis.fixtureRenders,errors:globalThis.fixtureErrors,writes:globalThis.storageWrites,a:sessionStorage.getItem('app_state_a'),b:sessionStorage.getItem('app_state_b')}));
  return {page,context,errors,value,read,markup};
}
async function check(name, run) {await run();cases.push(name);}
try {
 await check('old actual hook produces different server and first client render from a saved draft',async()=>{
  const f=await fixture(path.resolve(before));await f.value(7);const state=await f.read();assert.ok(f.markup.includes('>0</output>'));assert.equal(state.renders[0].value,7);assert.ok(state.errors.length>0);await f.context.close();
 });
 await check('actual React hydration matches SSR first render and restores without writing a default',async()=>{
  const f=await fixture(current);await f.value(7);const state=await f.read();assert.equal(state.renders[0].value,0);assert.equal(state.errors.length,0);assert.equal(f.errors.length,0);assert.equal(state.a,'7');assert.ok(state.writes.every(w=>w.key!=='app_state_a'||w.value==='7'));await f.context.close();
 });
 await check('batched functional updates use the latest restored value',async()=>{
  const f=await fixture(current);await f.value(7);await f.page.locator('#twice').click();await f.value(9);assert.equal((await f.read()).a,'9');await f.context.close();
 });
 await check('key changes restore their own draft and never write the old key value into the new key',async()=>{
  const f=await fixture(current);await f.value(7);await f.page.locator('#key').click();await f.value(11);let state=await f.read();assert.equal(state.a,'7');assert.equal(state.b,'11');assert.ok(state.writes.filter(w=>w.key==='app_state_b').every(w=>w.value==='11'));await f.page.locator('#twice').click();await f.value(13);await f.page.locator('#key').click();await f.value(7);state=await f.read();assert.equal(state.b,'13');assert.ok(state.renders.every(r=>r.setterStable));await f.context.close();
 });
 await check('clear removes the entry and the next edit persists normally',async()=>{
  const f=await fixture(current);await f.value(7);await f.page.locator('#clear').click();await f.value(0);assert.equal((await f.read()).a,null);await f.page.locator('#edit').fill('12');await f.value(12);assert.equal((await f.read()).a,'12');await f.context.close();
 });
 await check('bad JSON safely becomes the default after hydration',async()=>{
  const f=await fixture(current,{}, {a:'{broken'});await f.value(0);await f.page.waitForFunction(()=>sessionStorage.getItem('app_state_a')==='0');assert.equal(f.errors.length,0);await f.context.close();
 });
 await check('validator rejects a stored value with the wrong type',async()=>{
  const f=await fixture(current,{}, {a:'"wrong"'});await f.value(0);await f.page.waitForFunction(()=>sessionStorage.getItem('app_state_a')==='0');assert.equal(f.errors.length,0);await f.context.close();
 });
 await check('without a validator a stored null remains null',async()=>{
  const f=await fixture(current,{validate:false},{a:'null'});await f.value(null);assert.equal((await f.read()).a,'null');await f.context.close();
 });
 await check('missing storage starts with the same default and accepts functional updates',async()=>{
  const f=await fixture(current,{},{});await f.value(0);await f.page.locator('#twice').click();await f.value(2);assert.equal((await f.read()).a,'2');await f.context.close();
 });
 await check('update before passive restoration starts from the saved value and is not overwritten',async()=>{
  const f=await fixture(current,{earlyUpdate:true});await f.value(9);const state=await f.read();assert.equal(state.a,'9');assert.ok(state.writes.every(w=>w.key!=='app_state_a'||w.value==='9'));await f.context.close();
 });
 await check('StrictMode repeated mount effects preserve the saved draft',async()=>{
  const f=await fixture(current,{strict:true});await f.value(7);const state=await f.read();assert.equal(state.errors.length,0);assert.ok(state.writes.every(w=>w.key!=='app_state_a'||w.value==='7'));await f.context.close();
 });
 await check('unavailable storage keeps interactive in-memory state working',async()=>{
  const f=await fixture(current,{storageUnavailable:true});await f.value(0);await f.page.locator('#twice').click();await f.value(2);assert.equal(f.errors.length,0);await f.context.close();
 });
 const result={pass:true,scenarios:cases.length,cases,usesActualReactDOMSSRAndHydrateRoot:true,externalRequests:0,businessDatabaseWrites:0};
 fs.writeFileSync(path.join(output,'hook-fixture.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
