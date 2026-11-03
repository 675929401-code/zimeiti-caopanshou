/** Isolated browser contract against the actual shared switcher and selection hook.
 * All HTTP is intercepted; no application build, listener, credentials or provider calls.
 * node scripts/verify-chat-model-switcher-isolated.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");
const fixture = [
  { id: `pm_${"g".repeat(24)}`, displayName: "GPT-5.6-Terra" },
  { id: `pm_${"c".repeat(24)}`, displayName: "Claude Sonnet 4.6" },
  { id: `pm_${"d".repeat(24)}`, displayName: "DeepSeek-V4.1-Flash (官方直连)" },
  { id: `pm_${"r".repeat(24)}`, displayName: "DeepSeek-R1 (官方直连)" },
  { id: `pm_${"v".repeat(24)}`, displayName: "DeepSeek-V3.1 (官方直连)" },
  { id: `pm_${"p".repeat(24)}`, displayName: "DeepSeek-V4-Pro (官方直连)" },
  { id: `pm_${"f".repeat(24)}`, displayName: "DeepSeek-V4-Flash (官方直连)" },
  { id: `pm_${"x".repeat(24)}`, displayName: "DeepSeek-V4.10-Flash" },
  { id: `pm_${"q".repeat(24)}`, displayName: "DeepSeek-V4.1-Pro" },
  { id: `pm_${"h".repeat(24)}`, displayName: "GPT-4.1" },
  { id: `pm_${"i".repeat(24)}`, displayName: "DeepSeek-V4.1" },
];
let catalogFixture=fixture;
const entry = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatModelSwitcher } from "./src/components/chat/chat-model-switcher";
import { useChatModelSelection } from "./src/hooks/use-chat-model-selection";
import { canSelectPublicChatModel } from "./src/lib/chat-model-switching-policy";
function Harness() {
 const [scope, setScope] = useState({accountId:"ordinary-a",conversationId:"conversation-a",targetAgentId:"__free_chat__",source:"llm",sending:false});
 const enabled=canSelectPublicChatModel(scope.targetAgentId,{source:scope.source});
 const selection=useChatModelSelection({...scope,enabled,useFreeChatDefault:scope.targetAgentId==="__free_chat__"});
 window.configure=(next)=>flushSync(()=>setScope(current=>({...current,...next})));
 window.snapshot=()=>({status:selection.status,label:selection.selectedLabel,explicit:selection.explicitModelId,groups:selection.groups.map(g=>g.brand)});
 window.catalogOptions=()=>selection.groups.flatMap(group=>group.models.map(model=>model.id));
 window.savedSelect=selection.select;
 return <div>{enabled ? <ChatModelSwitcher {...selection} selectedModelId={selection.effectiveModelId} onSelect={selection.select} onReload={selection.reload} disabled={scope.sending}/> : <p data-testid="ineligible">智能体固定链路</p>}</div>;
}
createRoot(document.getElementById("root")).render(<Harness/>);
`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "chat-switcher-isolated.tsx", loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, tsconfig: "tsconfig.json" });
const chromeCandidates = [process.env.PUPPETEER_EXECUTABLE_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].filter(Boolean);
let executablePath;
for (const candidate of chromeCandidates) { try { await fs.access(candidate); executablePath = candidate; break; } catch { /* Try the next installed browser. */ } }
const browser = await puppeteer.launch({headless:true,executablePath,args:["--no-sandbox"]});
const page = await browser.newPage();
await page.setViewport({width:1440,height:900});
const requests=[]; const errors=[];
page.on("pageerror",error=>errors.push(error.message));
await page.setRequestInterception(true);
page.on("request",request=>{
 requests.push({url:request.url(),method:request.method()});
 if(request.method()!=="GET") { void request.abort(); return; }
 if(request.url()==="http://chat-switcher.test/") { void request.respond({status:200,contentType:"text/html",body:'<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>'}); return; }
 if(request.url()==="http://chat-switcher.test/fixture.js") { void request.respond({status:200,contentType:"text/javascript",body:bundle.outputFiles[0].text}); return; }
 if(request.url()==="http://chat-switcher.test/api/chat-models") { void request.respond({status:200,contentType:"application/json",body:JSON.stringify({models:catalogFixture})}); return; }
 void request.abort();
});
await page.evaluateOnNewDocument(()=>{
 const originalFetch=window.fetch;
 window.fetch=(...args)=>window.delayCatalog ? new Promise(resolve=>{window.releaseCatalog=()=>resolve(new Response(JSON.stringify(window.delayedCatalog),{status:200,headers:{"Content-Type":"application/json"}}));}) : originalFetch(...args);
 localStorage.setItem("last_used_model",`pm_${"d".repeat(24)}`);
 localStorage.setItem("model_override_conversation-a",`pm_${"d".repeat(24)}`);
});
const ready=()=>page.waitForFunction(()=>window.snapshot?.().status==="ready");
const configure=async(next)=>{await page.evaluate(value=>window.configure(value),next); await ready();};
const snapshot=()=>page.evaluate(()=>window.snapshot());
const choose=async(id)=>{await page.click('[data-testid="chat-model-trigger"]');await page.waitForSelector(`[data-model-id="${id}"]`,{visible:true});await page.click(`[data-model-id="${id}"]`);await page.waitForFunction(expected=>window.snapshot().explicit===expected,{},id);};
const menuIds=async()=>{await page.click('[data-testid="chat-model-trigger"]');await page.waitForSelector('[role="menu"]',{visible:true});const ids=await page.$$eval('[data-model-id]',elements=>elements.map(element=>element.dataset.modelId));await page.keyboard.press("Escape");await page.waitForFunction(()=>document.querySelectorAll('[data-model-id]').length===0);return ids;};
try {
 await page.goto("http://chat-switcher.test/");await ready();
 assert.deepEqual(await snapshot(),{status:"ready",label:"GPT-5.6-Terra",explicit:null,groups:["gpt","claude","deepseek"]});
 await choose(fixture[2].id);
 await page.reload();await ready();assert.equal((await snapshot()).explicit,fixture[2].id,"same scope refresh preserves choice");
 await configure({conversationId:"conversation-b"});assert.equal((await snapshot()).explicit,null,"new conversation ignores global model");
 await configure({conversationId:"conversation-a"});assert.equal((await snapshot()).explicit,fixture[2].id);
 await configure({accountId:"ordinary-b"});assert.equal((await snapshot()).explicit,null,"account isolation");
 await configure({accountId:"ordinary-a",targetAgentId:"agent-llm",source:"llm"});assert.equal((await snapshot()).label,"智能体默认");assert.equal((await snapshot()).explicit,null);
 await page.evaluate(id=>localStorage.setItem('chat_model_selection_v2:'+JSON.stringify(['ordinary-a','conversation-a','agent-llm']),id),fixture[1].id);
 await configure({targetAgentId:"agent-restore-probe"});await configure({targetAgentId:"agent-llm"});
 assert.equal((await snapshot()).explicit,fixture[1].id,"a previously saved Claude choice is retained");
 await configure({targetAgentId:"agent-other"});assert.equal((await snapshot()).explicit,null,"target isolation");
 await configure({targetAgentId:"agent-llm"});assert.equal((await snapshot()).explicit,fixture[1].id);
 await configure({sending:true});assert.equal(await page.$eval('[data-testid="chat-model-trigger"]',el=>el.disabled),true);
 await page.evaluate(()=>window.configure({targetAgentId:"agent-coze",source:"coze",sending:false}));
 assert.equal((await snapshot()).status,"disabled");assert.equal(await page.$('[data-testid="chat-model-trigger"]'),null);
 await page.evaluate(()=>window.configure({targetAgentId:"agent-1786633444187-594spj",source:"llm"}));assert.equal((await snapshot()).status,"disabled","bound director excluded");
 await configure({targetAgentId:"agent-llm",source:"llm"});
 await page.evaluate(()=>{window.oldSelect=window.savedSelect;window.delayCatalog=true;window.delayedCatalog={models:[{id:`pm_${"z".repeat(24)}`,displayName:"GPT-stale"}]};window.configure({accountId:"pending-account"});});
 await page.waitForFunction(()=>typeof window.releaseCatalog==="function");
 await page.evaluate(()=>{window.delayCatalog=false;window.configure({accountId:"final-account"});window.oldSelect({id:`pm_${"c".repeat(24)}`,label:"Claude Sonnet 4.6",brand:"claude"});window.releaseCatalog();});
 await ready();assert.equal((await snapshot()).explicit,null,"stale callback cannot select into another account");
 assert.equal((await snapshot()).label,"智能体默认");assert.deepEqual((await snapshot()).groups,["gpt","claude","deepseek"],"late catalog cannot replace current scope");
 const visibleIds=await menuIds();
 assert.deepEqual(visibleIds,[fixture[0].id,fixture[9].id,fixture[1].id,fixture[2].id],"actual menu preserves GPT/Claude and trims only DeepSeek to exact V4.1 Flash");
 for(const selectable of [fixture[0],fixture[1]]) { await choose(selectable.id);assert.equal((await snapshot()).explicit,selectable.id,"restored GPT and Claude options forward their original public ID"); }
 assert.deepEqual(new Set(await page.evaluate(()=>window.catalogOptions())),new Set(fixture.map(model=>model.id)),"the actual selection hook still owns the entire unfiltered catalog");
 for(const [index,old] of [fixture[0],fixture[1],...fixture.slice(3,7)].entries()){
  const conversationId=`legacy-choice-${index}`;
  await page.evaluate(({id,conversationId})=>localStorage.setItem('chat_model_selection_v2:'+JSON.stringify(['ordinary-a',conversationId,'__free_chat__']),id),{id:old.id,conversationId});
  await configure({accountId:"ordinary-a",conversationId,targetAgentId:"__free_chat__",source:"llm"});
  assert.equal((await snapshot()).explicit,old.id,"existing hidden model must not be cleared or rebound to a default");
  assert.equal(await page.$eval('[data-testid="chat-model-label"]',element=>element.textContent),old.displayName,"the current chip stays truthful for an old persisted model");
  assert.equal((await menuIds()).includes(old.id),!/DeepSeek/u.test(old.displayName),"old DeepSeek options stay hidden while GPT and Claude remain selectable");
 }
 await choose(fixture[2].id);assert.equal((await snapshot()).explicit,fixture[2].id,"a deliberate new 4.1 selection forwards its original public ID");
 catalogFixture=[fixture[3]];
 await page.evaluate(id=>localStorage.setItem('chat_model_selection_v2:'+JSON.stringify(['ordinary-a','legacy-empty-menu','__free_chat__']),id),fixture[3].id);
 await configure({accountId:"ordinary-a",conversationId:"legacy-empty-menu",targetAgentId:"__free_chat__",source:"llm"});
 assert.equal((await snapshot()).explicit,fixture[3].id,"filtering the entire menu must still preserve the current selection");
 assert.equal(await page.$('[data-testid="chat-model-trigger"]'),null);
 const empty=await page.$eval('[data-testid="chat-model-empty"]',element=>({text:element.textContent,title:element.title}));
 assert.ok(empty.text.includes(fixture[3].displayName)&&empty.title.includes(fixture[3].displayName)&&!empty.title.includes('继续使用服务端默认模型'),"empty presentation reports the retained actual model, not a false default fallback");
 catalogFixture=[fixture[0]];
 await configure({conversationId:"unchanged-gpt-default"});
 assert.equal((await snapshot()).explicit,null,"a GPT-only menu must not introduce an override");
 assert.equal((await snapshot()).label,fixture[0].displayName,"the existing GPT default stays truthful when no Flash option is published");
 assert.deepEqual(await menuIds(),[fixture[0].id],"GPT remains selectable when Flash is not published");
 catalogFixture=[fixture[0],fixture[1],fixture[3]];await configure({conversationId:"non-deepseek-without-flash"});
 assert.deepEqual(await menuIds(),[fixture[0].id,fixture[1].id],"GPT and Claude remain selectable when the DeepSeek group has no Flash");
 assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==="GET" && r.url.startsWith("http://chat-switcher.test/")));
 const evidence=path.resolve(process.env.CHAT_MODEL_SWITCHER_EVIDENCE_DIR||".codex-evidence/chat-model-switcher-isolated",`run-${Date.now()}`);await fs.mkdir(evidence,{recursive:true});
 await page.screenshot({path:path.join(evidence,"shared-switcher.png")});
 const report={ok:true,kind:"isolated actual component and hook, not main application visual acceptance",cases:22,addedCases:["GPT and Claude options and order preserved; only DeepSeek is trimmed to exact V4.1 Flash","restored GPT and Claude selections forward original IDs","all six old scoped choices retain truthful labels and IDs; only old DeepSeek is absent from menu","new explicit Flash selection forwards its stable public ID","DeepSeek-only filtered-empty menu preserves actual current choice","GPT/Claude remain selectable when Flash is unpublished"],visibleIds,completeCatalogIds:fixture.map(model=>model.id),requests:requests.length,providerRequests:0,writeRequests:0,consoleErrors:errors,evidence};
 await fs.writeFile(path.join(evidence,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
