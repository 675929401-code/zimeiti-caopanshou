import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync('src/components/video-history-panel.tsx','utf8');
const fragment=source.slice(source.indexOf('/** Replacement URLs'),source.indexOf('function deliveryLabel'))+'\nglobalThis.Cover = VideoHistoryCover;';
const js=ts.transpileModule(fragment,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const state=[],effects=[],scheduled=[];let stateIndex=0,effectIndex=0,requests=0,clock=0;
const context={globalThis:{},exports:{},require(){return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};},
 useState(initial){const index=stateIndex++;if(!(index in state))state[index]=initial;return[state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];},
 useEffect(fn,deps){const index=effectIndex++;if(!effects[index]||deps.some((value,i)=>value!==effects[index].deps[i])){effects[index]?.cleanup?.();effects[index]={deps,cleanup:fn()};}},
 safePoster:value=>value||'',ticket:async()=>'/api/video/thumbnail/owned?media_ticket=fresh-'+(++requests),AbortController,
 window:{setTimeout(fn,ms){const timer={fn,at:clock+ms};scheduled.push(timer);return timer;},clearTimeout(timer){const index=scheduled.indexOf(timer);if(index>=0)scheduled.splice(index,1);}}
};vm.runInNewContext(js,context);
let item={taskId:'owned',status:'completed',cardIndex:0};
function render(){stateIndex=0;effectIndex=0;return context.globalThis.Cover({item,token:'synthetic'});}
async function advance(ms=0){clock+=ms;const due=scheduled.filter(timer=>timer.at<=clock);for(const timer of due){const i=scheduled.indexOf(timer);if(i>=0){scheduled.splice(i,1);timer.fn();}}await Promise.resolve();await Promise.resolve();await Promise.resolve();}
function find(tree,type){if(!tree||typeof tree!=='object')return null;if(tree.type===type)return tree;const children=tree.props?.children;for(const node of(Array.isArray(children)?children:[children])){const found=find(node,type);if(found)return found;}return null;}
render();await advance();let tree=render();const first=find(tree,'img');assert.equal(first.props.src,'/api/video/thumbnail/owned?media_ticket=fresh-1');
for(let attempt=1;attempt<=3;attempt++){
 find(tree,'img').props.onError();render();await advance(30000*attempt-1);assert.equal(requests,attempt,'no retry before server cooldown');await advance(1);tree=render();assert.equal(find(tree,'img').props.src,'/api/video/thumbnail/owned?media_ticket=fresh-'+(attempt+1));assert.equal(find(tree,'img').props.style,undefined);
}
find(tree,'img').props.onError();render();await advance(120000);tree=render();assert.equal(find(tree,'img'),null);assert.equal(requests,4);assert.match(find(tree,'span').props.children,/首帧暂不可用/);
for(let i=0;i<10;i++){render();await advance();}assert.equal(requests,4);
for(const effect of effects)effect.cleanup?.();state.length=0;effects.length=0;scheduled.length=0;requests=0;
item={taskId:'next',status:'generating'};render();await advance();assert.equal(requests,0);
item={...item,status:'completed',posterUrl:'/api/video/thumbnail/next?media_ticket=arrived'};render();tree=render();assert.equal(find(tree,'img').props.src,item.posterUrl);assert.equal(requests,0,'new validated poster uses incoming ticket');find(tree,'img').props.onLoad();render();
item={...item,posterUrl:'/api/video/thumbnail/next?media_ticket=poll-refresh'};render();tree=render();assert.equal(find(tree,'img').props.src,'/api/video/thumbnail/next?media_ticket=arrived','loaded cover stays stable during ticket refresh');
for(const effect of effects)effect.cleanup?.();state.length=0;effects.length=0;scheduled.length=0;requests=0;
item={taskId:'polling',status:'completed',posterUrl:'/api/video/thumbnail/polling?media_ticket=initial'};render();tree=render();find(tree,'img').props.onError();render();
await advance(15000);item={...item,posterUrl:'/api/video/thumbnail/polling?media_ticket=poll-15s'};render();assert.equal(requests,0);
await advance(14999);assert.equal(requests,0);await advance(1);item={...item,posterUrl:'/api/video/thumbnail/polling?media_ticket=poll-30s'};render();tree=render();assert.equal(requests,1,'15-second polling must not postpone the 30-second retry');assert.equal(find(tree,'img').props.src,'/api/video/thumbnail/owned?media_ticket=fresh-1');
const labelSource=source.slice(source.indexOf('function deliveryLabel'),source.indexOf('function namedDownloadUrl'))+'\nglobalThis.label = deliveryLabel;';
const labels={globalThis:{}};
vm.runInNewContext(ts.transpileModule(labelSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,labels);
for(const deliveryState of ['saving','failed','saved']){
  const label=labels.globalThis.label({deliveryState,mediaAvailable:false});
  assert.match(label,/不可用/);assert.doesNotMatch(label,/立即播放|及时下载|已保存/,'unavailable media cannot promise playback or download');
}
assert.match(labels.globalThis.label({deliveryState:'saving',mediaAvailable:true}),/立即播放/);
assert.match(labels.globalThis.label({deliveryState:'expired',mediaAvailable:false}),/已到期/);
const report={ok:true,tests:8,checks:['signed poster replaced every 15 seconds cannot reset the scheduled 30-second retry','image failure retries with visible replacement after 30/60/90 second waits','fourth image failure stops automatic requests with explicit fallback','ordinary rerenders never issue infinite thumbnail retries','same component generating to completed receives new signed poster','loaded cover stays stable when history polling re-signs its ticket','unavailable media overrides intermediate cache playback and download claims','expired cache keeps its explicit deadline label'],realNetworkCalls:0,modelCalls:0};
fs.writeFileSync('.codex-evidence/storyboard-history-20261023/cover-recovery-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
