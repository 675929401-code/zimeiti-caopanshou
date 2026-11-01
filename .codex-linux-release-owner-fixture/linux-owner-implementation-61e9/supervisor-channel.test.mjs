import {PassThrough} from 'node:stream';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {attachLinuxSupervisor,runProductionSupervisor} from './supervisor-channel.mjs';
const ctx={seq:0,op:'initialize',transactionId:'transaction-test-0123456789ab',artifactSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),ownerSha256:'c'.repeat(64)};
const b={batchId:'c5d939ed-099b-42d0-b6e3-26a15b59eb70',scriptSha256:'d'.repeat(64),wireSha256:'e'.repeat(64)};
const identity=()=>({transactionId:ctx.transactionId,artifactSha256:ctx.artifactSha256,manifestSha256:ctx.manifestSha256,ownerSha256:ctx.ownerSha256});
const step=(seq,op,meta={},result='')=>({seq,transactionId:ctx.transactionId,op,batchId:meta.batchId||'',scriptSha256:meta.scriptSha256||'',wireSha256:meta.wireSha256||'',result});
function fixture({verify,overrides={}}={}){
 const input=new PassThrough(),output=new PassThrough();let buffer='',lines=[],waiters=[],poisoned=0;
 output.setEncoding('utf8');output.on('data',s=>{buffer+=s;while(buffer.includes('\n')){const i=buffer.indexOf('\n');lines.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);waiters.splice(0).forEach(f=>f());}});
 const engine={prepare:async()=> 'HELD',recordPrepared:async()=> 'PREPARED',recordIntent:async()=> 'INTENT_RECORDED',recordOutcome:async(_b,r)=>r==='UNKNOWN'?'UNKNOWN_RECORDED':'COMMITTED_RECORDED',preflight:async()=> 'PREFLIGHT_OK',activate:async()=> 'ACTIVE_PERSISTED',release:async()=> 'RELEASED',poison:()=>{poisoned++},...overrides};
 const channel=attachLinuxSupervisor({input,output,verifyAndOpen:verify||(async()=>({identity:identity(),engine}))});
 async function line(n){for(let i=0;i<100&&lines.length<n;i++)await new Promise(r=>{const timer=setTimeout(r,10);waiters.push(()=>{clearTimeout(timer);r();});});assert.ok(lines.length>=n,'reply timeout');return lines[n-1];}
 return {input,output,channel,engine,send:v=>input.write(JSON.stringify(v)+'\n'),line,getPoisoned:()=>poisoned};
}
test('complete ordered protocol with independently checked identity',async()=>{
 const f=fixture();f.send(ctx);assert.equal((await f.line(1)).outcome,'READY');
 for(const [n,op,meta,result,outcome] of [[1,'prepare',{},'','HELD'],[2,'migration-prepared',b,'','PREPARED'],[3,'migration-intent',b,'','INTENT_RECORDED'],[4,'migration-outcome',b,`COMMIT_CONFIRMED_${b.batchId}\n`,'COMMITTED_RECORDED'],[5,'preflight',{},'','PREFLIGHT_OK'],[6,'activate',{},'','ACTIVE_PERSISTED'],[7,'release',{},'','RELEASED']]){f.send(step(n,op,meta,result));assert.equal((await f.line(n+1)).outcome,outcome);}
 f.input.end();assert.equal(f.channel.status(),'released');assert.equal(f.getPoisoned(),0);
});
test('caller COMMITTED label is not a raw receipt',async()=>{
 const f=fixture();f.send(ctx);await f.line(1);f.send(step(1,'prepare'));await f.line(2);f.send(step(2,'migration-prepared',b));await f.line(3);f.send(step(3,'migration-intent',b));await f.line(4);f.send(step(4,'migration-outcome',b,'COMMITTED'));await new Promise(r=>setTimeout(r,10));assert.equal(f.channel.isUnknown(),true);assert.equal(f.getPoisoned(),1);
});
test('uncertain migration closes session after UNKNOWN acknowledgement',async()=>{
 const f=fixture();f.send(ctx);await f.line(1);f.send(step(1,'prepare'));await f.line(2);f.send(step(2,'migration-prepared',b));await f.line(3);f.send(step(3,'migration-intent',b));await f.line(4);f.send(step(4,'migration-outcome',b,'UNKNOWN'));assert.equal((await f.line(5)).outcome,'UNKNOWN_RECORDED');assert.equal(f.channel.isUnknown(),true);
});
test('initial supplied identity cannot bypass verifier',async()=>{
 const f=fixture({verify:async()=>({identity:{...identity(),ownerSha256:'f'.repeat(64)},engine:{}})});f.send(ctx);await new Promise(r=>setTimeout(r,10));assert.equal(f.channel.isUnknown(),true);
});
test('new bytes while provider runs poison session and no success response',async()=>{
 let resume;const f=fixture({overrides:{prepare:()=>new Promise(r=>{resume=r;})}});f.send(ctx);await f.line(1);f.send(step(1,'prepare'));await new Promise(r=>setTimeout(r,0));f.input.write('X');resume('HELD');await new Promise(r=>setTimeout(r,10));assert.equal(f.channel.isUnknown(),true);assert.equal(f.getPoisoned(),1);
});
test('production launcher remains closed',()=>assert.throws(runProductionSupervisor,/WINDOW_AUTHENTICATED_PROVIDERS_NOT_CONNECTED/));
