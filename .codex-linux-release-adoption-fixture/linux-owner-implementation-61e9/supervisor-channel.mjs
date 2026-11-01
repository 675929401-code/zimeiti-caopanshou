// Strict, single-session NDJSON adapter for LinuxStageEngine. The production
// launcher below is intentionally closed; the verified descriptor/provider
// factory has not yet been installed. No operation is selected by shell text.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openProductionLinuxOwner} from './linux-stage-engine.mjs';
const HASH=/^[a-f0-9]{64}$/;
const TX=/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=x=>{throw Error(x)};
const initKeys='artifactSha256,manifestSha256,op,ownerSha256,seq,transactionId';
const reqKeys='batchId,op,result,scriptSha256,seq,transactionId,wireSha256';
function validateInit(v){if(!v||Array.isArray(v)||Object.keys(v).sort().join(',')!==initKeys||v.seq!==0||v.op!=='initialize'||!TX.test(v.transactionId)||!['artifactSha256','manifestSha256','ownerSha256'].every(k=>HASH.test(v[k]||'')))fail('WINDOW_INIT_INVALID');}
function validateRequest(v,ctx,seq,op){
 if(!v||Array.isArray(v)||Object.keys(v).sort().join(',')!==reqKeys||v.seq!==seq||v.op!==op||v.transactionId!==ctx.transactionId)fail('WINDOW_REQUEST_INVALID');
 if(!['migration-prepared','migration-intent','migration-outcome'].includes(op)){
  if(v.batchId!==''||v.scriptSha256!==''||v.wireSha256!==''||v.result!=='')fail('WINDOW_REQUEST_INVALID');
 }else{
  if(!UUID.test(v.batchId)||!HASH.test(v.scriptSha256)||!HASH.test(v.wireSha256))fail('WINDOW_REQUEST_INVALID');
  if(op!=='migration-outcome'&&v.result!=='')fail('WINDOW_REQUEST_INVALID');
  if(op==='migration-outcome'&&v.result!=='UNKNOWN'&&![`COMMIT_CONFIRMED_${v.batchId}\n`,`COMMIT_CONFIRMED_${v.batchId}\r\n`].includes(v.result))fail('WINDOW_REQUEST_INVALID');
 }
}

// `verifyAndOpen` is supplied by the authenticated installed-control-plane
// factory, never by input data. It independently checks each initial digest.
export function attachLinuxSupervisor({input,output,verifyAndOpen}){
 if(!input||!output||typeof verifyAndOpen!=='function')fail('WINDOW_CHANNEL_INVALID');
 const order=['prepare','migration-prepared','migration-intent','migration-outcome','preflight','activate','release'];
 let buf='',state='initializing',busy=false,epoch=0,seq=0,ctx=null,engine=null,unknown=false,outputFailed=false;
 function poison(){
  if(unknown)return;unknown=true;state='unknown';epoch++;
  try{engine?.poison();}catch{}
  try{input.pause();}catch{}
 }
 function emit(v){try{if(outputFailed||!output.write(JSON.stringify(v)+'\n'))fail('WINDOW_OUTPUT_UNAVAILABLE');}catch{outputFailed=true;poison();throw Error('WINDOW_OUTPUT_UNKNOWN');}}
 function reply(op,outcome,num){emit({seq:num,transactionId:ctx.transactionId,op,outcome,manifestSha256:ctx.manifestSha256,ownerSha256:ctx.ownerSha256,artifactSha256:ctx.artifactSha256});}
 async function receive(line){
  if(unknown||busy){poison();return;}busy=true;const turn=epoch;
  try{
   let value;try{value=JSON.parse(line);}catch{fail('WINDOW_FRAME_INVALID');}
   if(!value||JSON.stringify(value)!==line)fail('WINDOW_FRAME_INVALID');
   if(state==='initializing'){
    validateInit(value);const opened=await verifyAndOpen(Object.freeze({...value}));
    if(unknown||epoch!==turn||!opened?.engine||!opened?.identity)fail('WINDOW_SESSION_INVALID');
    for(const k of ['transactionId','artifactSha256','manifestSha256','ownerSha256'])if(opened.identity[k]!==value[k])fail('WINDOW_IDENTITY_MISMATCH');
    ctx=Object.freeze({transactionId:value.transactionId,artifactSha256:value.artifactSha256,manifestSha256:value.manifestSha256,ownerSha256:value.ownerSha256});engine=opened.engine;state='ready';reply('ready','READY',0);return;
   }
   const op=order[seq];if(state==='released'||!op)fail('WINDOW_PHASE_INVALID');
   validateRequest(value,ctx,seq+1,op);
   const b={batchId:value.batchId,scriptSha256:value.scriptSha256,wireSha256:value.wireSha256};
   const methods={prepare:()=>engine.prepare(),'migration-prepared':()=>engine.recordPrepared(b),'migration-intent':()=>engine.recordIntent(b),'migration-outcome':()=>engine.recordOutcome(b,value.result),preflight:()=>engine.preflight(),activate:()=>engine.activate(),release:()=>engine.release()};
   const outcome=await methods[op]();if(unknown||epoch!==turn)fail('WINDOW_SESSION_INVALID');
   seq++;reply(op,outcome,seq);if(op==='migration-outcome'&&outcome==='UNKNOWN_RECORDED'){poison();return;}if(op==='release')state='released';
  }catch{poison();}finally{busy=false;}
 }
 input.setEncoding('utf8');input.on('data',chunk=>{
  if(unknown)return;if(busy){poison();return;}buf+=chunk;if(buf.length>8192){poison();return;}
  const end=buf.indexOf('\n');if(end<0)return;
  const line=buf.slice(0,end);buf=buf.slice(end+1);
  // Reject trailing data immediately; only one request may be outstanding.
  if(!line||buf.length||busy){poison();return;}void receive(line);
 });
 input.on('end',()=>{if(state!=='released'||busy||buf)poison();});input.on('error',poison);output.on('error',()=>{outputFailed=true;poison();});
 return Object.freeze({status:()=>state,isUnknown:()=>unknown});
}
export function runProductionSupervisor(){return openProductionLinuxOwner();}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 process.stderr.write('WINDOW_AUTHENTICATED_PROVIDERS_NOT_CONNECTED\n');process.exitCode=93;
}
