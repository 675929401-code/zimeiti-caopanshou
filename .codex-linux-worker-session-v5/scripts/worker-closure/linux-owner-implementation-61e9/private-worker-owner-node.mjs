// Same-process journal owner <-> owned Python child over inherited FD 3.
// The caller must already be the authenticated installed owner; this is not
// a production factory and a caller-created callback object is no authority.
import {spawn} from 'node:child_process';import crypto from 'node:crypto';
const fail=x=>{throw Error(x)};
const TX=/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
export async function startPrivateWorkerJournal({owner,python,entry,transactionId,allowedFiles}){
 if(!TX.test(transactionId||'')||!owner||!['assert_live','assert_bound','assert_terminal','verify_file','checkpoint','mark_unknown'].every(x=>typeof owner[x]==='function')||!Array.isArray(allowedFiles))fail('OWNER_INPUT_INVALID');
 const files=new Map();for(const x of allowedFiles){if(!exact(x,['path','sha256'])||typeof x.path!=='string'||!SHA.test(x.sha256)||files.has(x.path))fail('OWNER_FILES_INVALID');files.set(x.path,x.sha256);}
 if(!files.has(python)||!files.has(entry))fail('OWNER_CLOSURE_MISSING');
 const nonce=crypto.randomBytes(32).toString('hex');let child,channel,control,pending=null,controlSeq=0,controlPhase="new",controlBuffer=Buffer.alloc(0),controlEof=false,finishAck=false,retiring=false,poisoned=false,busy=false,terminating=false,retired=false,sawEof=false,exitOk=false,retireTimer,seq=0,epoch=0,buffer=Buffer.alloc(0);
 const poison=()=>{if(poisoned||retired)return;poisoned=true;clearTimeout(retireTimer);epoch++;if(pending){clearTimeout(pending.timer);pending.reject(Error('WORKER_CONTROL_UNKNOWN'));pending=null;}try{control?.destroy()}catch{}try{channel?.destroy()}catch{}try{child?.kill()}catch{}try{Promise.resolve(owner.mark_unknown()).catch(()=>{})}catch{}};
 const finishRetirement=()=>{if(!terminating||!sawEof||!exitOk||!controlEof||!finishAck||poisoned||retired||retiring)return;retiring=true;const e=epoch;
  const verify=()=>{if(poisoned||retired||!retiring||epoch!==e||!terminating||!sawEof||!exitOk||!controlEof||!finishAck)fail('OWNER_TERMINAL_UNKNOWN');};
  (async()=>{verify();await owner.assert_live();verify();await owner.assert_bound();verify();await owner.assert_terminal();verify();retired=true;retiring=false;clearTimeout(retireTimer);if(pending){clearTimeout(pending.timer);pending.resolve('WATCH_FINISHED');pending=null;}})().catch(poison);
 };
 const bound=()=>{if(poisoned||!child||!channel||child.exitCode!==null||child.signalCode!==null||channel.destroyed)fail('OWNER_CHANNEL_LOST');};
 async function guard(){bound();const e=epoch;await owner.assert_live();bound();if(e!==epoch)fail('OWNER_CHANNEL_LOST');}
 async function handle(v){
  if(!exact(v,['seq','transactionId','nonce','op','body'])||!Number.isSafeInteger(v.seq)||v.seq!==seq+1||v.transactionId!==transactionId||v.nonce!==nonce||!exact(v.body,Object.keys(v.body||{})))fail('OWNER_FRAME_INVALID');
  const e=epoch;await guard();
  if(v.op==='assert_live'||v.op==='assert_bound'){
   if(!exact(v.body,[]))fail('OWNER_FRAME_INVALID');await owner[v.op]();
  }else if(v.op==='verify_file'){
   if(!exact(v.body,['path','sha256'])||files.get(v.body.path)!==v.body.sha256)fail('OWNER_FILE_DENIED');await owner.verify_file(v.body.path,v.body.sha256);
  }else if(v.op==='checkpoint'){
   if(!exact(v.body,['phase','details'])||typeof v.body.phase!=='string'||!v.body.phase.startsWith('worker-')||!v.body.details||typeof v.body.details!=='object'||Array.isArray(v.body.details))fail('OWNER_FRAME_INVALID');await owner.checkpoint(v.body.phase,v.body.details);
  }else if(v.op==='terminal'){
   if(!exact(v.body,[]))fail('OWNER_FRAME_INVALID');await owner.assert_terminal();
  }else if(v.op==='mark_unknown'){
   if(!exact(v.body,[]))fail('OWNER_FRAME_INVALID');await owner.mark_unknown();fail('OWNER_CHILD_UNKNOWN');
  }else fail('OWNER_FRAME_INVALID');
  await guard();if(epoch!==e)fail('OWNER_CHANNEL_LOST');seq=v.seq;
  const result=JSON.stringify({seq,transactionId,nonce,op:v.op,outcome:'OK'})+'\n';
  if(!channel.write(result))fail('OWNER_SHORT_WRITE');bound();
  if(v.op==='terminal'){terminating=true;retireTimer=setTimeout(poison,3000);retireTimer.unref?.();}
 }
 try{
  await owner.assert_live();await owner.assert_bound();
  for(const [path,sha] of files)await owner.verify_file(path,sha);
  await owner.assert_live();
  child=spawn(python,['-I','-S','-B',entry],{stdio:['ignore','ignore','ignore','pipe','pipe'],shell:false,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},cwd:'/'});
  channel=child.stdio[3];control=child.stdio[4];
  child.on('error',poison);child.on('exit',(code,signal)=>{if(terminating&&code===0&&signal===null){exitOk=true;finishRetirement();}else poison();});
  channel.on('error',poison);channel.on('close',()=>{if(!terminating||!sawEof)poison();});channel.on('end',()=>{if(!terminating)poison();else{sawEof=true;finishRetirement();}});
  channel.on('data',data=>{
   if(poisoned)return;if(terminating||busy||!Buffer.isBuffer(data)){poison();return;}
   buffer=Buffer.concat([buffer,data]);if(buffer.length>8192){poison();return;}
   const i=buffer.indexOf(10);if(i<0)return;if(i!==buffer.length-1||i===0){poison();return;}
   let v;try{const line=new TextDecoder('utf8',{fatal:true}).decode(buffer.subarray(0,i));v=JSON.parse(line);if(JSON.stringify(v)!==line)throw Error('invalid');}catch{poison();return;}
   buffer=Buffer.alloc(0);busy=true;handle(v).then(()=>{busy=false;},poison);
  });
  control.on('error',poison);
  control.on('close',()=>{if(!controlEof)poison();});
  control.on('end',()=>{if(controlPhase!=='finishing')poison();else{controlEof=true;finishRetirement();}});
  control.on('data',data=>{
   if(poisoned||!pending||pending.ack||!Buffer.isBuffer(data)){poison();return;}
   controlBuffer=Buffer.concat([controlBuffer,data]);if(controlBuffer.length>8192){poison();return;}
   const i=controlBuffer.indexOf(10);if(i<0)return;if(i===0||i!==controlBuffer.length-1){poison();return;}
   let v;try{const line=new TextDecoder('utf8',{fatal:true}).decode(controlBuffer.subarray(0,i));v=JSON.parse(line);if(JSON.stringify(v)!==line||!exact(v,['seq','transactionId','op','outcome'])||v.seq!==pending.seq||v.transactionId!==transactionId||v.op!==pending.op||v.outcome!==pending.expected)throw Error('bad');}catch{poison();return;}
   controlBuffer=Buffer.alloc(0);pending.ack=true;
   if(pending.op==='finish'){if(!terminating){poison();return;}finishAck=true;finishRetirement();return;}
   const current=pending,e=epoch;guard().then(()=>{if(poisoned||pending!==current||e!==epoch){poison();return;}controlPhase='opened';clearTimeout(current.timer);pending=null;current.resolve(v.outcome);},poison);
  });
  const hello=JSON.stringify({type:'owner-ready',transactionId,nonce})+'\n';if(!channel.write(hello))fail('OWNER_SHORT_WRITE');bound();
 }catch{poison();fail('OWNER_CHANNEL_UNKNOWN');}
 async function request(op){
  if(poisoned||retired||pending||!((op==='open'&&controlPhase==='new')||(op==='check'&&controlPhase==='opened')||(op==='finish'&&controlPhase==='opened'))){poison();fail('WORKER_CONTROL_ORDER');}
  controlPhase=op==='finish'?'finishing':'requesting';
  try{await guard();}catch{poison();fail('WORKER_CONTROL_UNKNOWN');}
  const expected={open:'WATCH_OPEN',check:'WATCH_OK',finish:'WATCH_FINISHED'}[op];const n=++controlSeq;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(poison,10000);timer.unref?.();pending={seq:n,op,expected,resolve,reject,timer,ack:false};
   try{if(!control.write(JSON.stringify({seq:n,transactionId,op})+'\n'))poison();}catch{poison();}
  });
 }
 return Object.freeze({status:()=>poisoned?'unknown':retired?'retired':terminating?'terminating':'active',childPid:()=>child.pid,request,closeUnknown:poison});
}
export function openProductionWorkerJournal(){fail('OWNER_AUTHENTICATED_PARENT_NOT_CONNECTED');}
