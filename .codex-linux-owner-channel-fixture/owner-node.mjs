// Same-process journal owner <-> owned Python child over inherited FD 3.
// The caller must already be the authenticated installed owner; this is not
// a production factory and a caller-created callback object is no authority.
import {spawn} from 'node:child_process';import crypto from 'node:crypto';
const fail=x=>{throw Error(x)};
const TX=/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
export async function startPrivateWorkerJournal({owner,python,entry,transactionId,allowedFiles}){
 if(!TX.test(transactionId||'')||!owner||!['assert_live','assert_bound','verify_file','checkpoint','mark_unknown'].every(x=>typeof owner[x]==='function')||!Array.isArray(allowedFiles))fail('OWNER_INPUT_INVALID');
 const files=new Map();for(const x of allowedFiles){if(!exact(x,['path','sha256'])||typeof x.path!=='string'||!SHA.test(x.sha256)||files.has(x.path))fail('OWNER_FILES_INVALID');files.set(x.path,x.sha256);}
 if(!files.has(python)||!files.has(entry))fail('OWNER_CLOSURE_MISSING');
 const nonce=crypto.randomBytes(32).toString('hex');let child,channel,poisoned=false,busy=false,seq=0,epoch=0,buffer=Buffer.alloc(0);
 const poison=()=>{if(poisoned)return;poisoned=true;epoch++;try{channel?.destroy()}catch{}try{child?.kill()}catch{}try{Promise.resolve(owner.mark_unknown()).catch(()=>{})}catch{}};
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
  }else if(v.op==='mark_unknown'){
   if(!exact(v.body,[]))fail('OWNER_FRAME_INVALID');await owner.mark_unknown();fail('OWNER_CHILD_UNKNOWN');
  }else fail('OWNER_FRAME_INVALID');
  await guard();if(epoch!==e)fail('OWNER_CHANNEL_LOST');seq=v.seq;
  const result=JSON.stringify({seq,transactionId,nonce,op:v.op,outcome:'OK'})+'\n';
  if(!channel.write(result))fail('OWNER_SHORT_WRITE');bound();
 }
 try{
  await owner.assert_live();await owner.assert_bound();
  for(const [path,sha] of files)await owner.verify_file(path,sha);
  await owner.assert_live();
  child=spawn(python,['-I','-S','-B',entry],{stdio:['ignore','ignore','ignore','pipe'],shell:false,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},cwd:'/'});
  channel=child.stdio[3];
  child.on('error',poison);child.on('exit',poison);channel.on('error',poison);channel.on('close',poison);channel.on('end',poison);
  channel.on('data',data=>{
   if(poisoned)return;if(busy||!Buffer.isBuffer(data)){poison();return;}
   buffer=Buffer.concat([buffer,data]);if(buffer.length>8192){poison();return;}
   const i=buffer.indexOf(10);if(i<0)return;if(i!==buffer.length-1||i===0){poison();return;}
   let v;try{const line=new TextDecoder('utf8',{fatal:true}).decode(buffer.subarray(0,i));v=JSON.parse(line);if(JSON.stringify(v)!==line)throw Error('invalid');}catch{poison();return;}
   buffer=Buffer.alloc(0);busy=true;handle(v).then(()=>{busy=false;},poison);
  });
  const hello=JSON.stringify({type:'owner-ready',transactionId,nonce})+'\n';if(!channel.write(hello))fail('OWNER_SHORT_WRITE');bound();
 }catch{poison();fail('OWNER_CHANNEL_UNKNOWN');}
 return Object.freeze({status:()=>poisoned?'unknown':'active',childPid:()=>child.pid,closeUnknown:poison});
}
export function openProductionWorkerJournal(){fail('OWNER_AUTHENTICATED_PARENT_NOT_CONNECTED');}
