// Long-lived private transport for the separately reviewed ingress helper.
// This is not an entry point and is not a release/ingress authorization check.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const hashPattern=/^[a-f0-9]{64}$/;
const txPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}-[a-f0-9]{12}$/;
const helperPattern=/^\/synthetic-control\/bin\/V[1-9][0-9]*\.[0-9]+-[a-f0-9]{12}\/nginx-window-helper\.py$/;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=s=>{throw Error(s)};

function trustedFile(file,expected,limit){
 if(!path.isAbsolute(file)||path.resolve(file)!==file||!hashPattern.test(expected)||fs.realpathSync(file)!==file)fail('INGRESS_HELPER_IDENTITY_INVALID');
 for(let d=path.dirname(file);;d=path.dirname(d)){
  const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o022))fail('INGRESS_HELPER_PARENT_UNSAFE');
  if(d==='/')break;
 }
 const initial=fs.lstatSync(file);
 if(!initial.isFile()||initial.isSymbolicLink()||initial.uid!==0||initial.gid!==0||(initial.mode&0o022)||initial.nlink!==1||initial.size<1||initial.size>limit)fail('INGRESS_HELPER_FILE_UNSAFE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const opened=fs.fstatSync(fd);if(opened.dev!==initial.dev||opened.ino!==initial.ino||opened.size!==initial.size)fail('INGRESS_HELPER_CHANGED');
  const bytes=fs.readFileSync(fd);if(bytes.length!==opened.size||sha(bytes)!==expected)fail('INGRESS_HELPER_CHANGED');
  const after=fs.fstatSync(fd),named=fs.lstatSync(file);
  if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||named.dev!==opened.dev||named.ino!==opened.ino||named.size!==opened.size)fail('INGRESS_HELPER_CHANGED');
 }finally{fs.closeSync(fd);}
}

function frameCheck(line,tx,seq,op,outcome){
 let value;try{value=JSON.parse(line);}catch{fail('INGRESS_FRAME_INVALID');}
 if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==['candidateSha256','op','outcome','seq','sourceSha256','transactionId'].sort().join(',')||JSON.stringify(value)!==line)fail('INGRESS_FRAME_INVALID');
 if(value.seq!==seq||value.transactionId!==tx||value.op!==op||value.outcome!==outcome)fail('INGRESS_FRAME_IDENTITY_INVALID');
 for(const k of ['sourceSha256','candidateSha256'])if(!Array.isArray(value[k])||value[k].length!==2||!value[k].every(v=>typeof v==='string'&&hashPattern.test(v)))fail('INGRESS_FRAME_DIGEST_INVALID');
 return value;
}

// Owns exactly one child and permits one ordered request at a time. A pipe
// failure invalidates the whole session and no retry or second child is created.
function validateOptions(transactionId,{timeoutMs,onUnknown,expectedDigests}){
 if(!txPattern.test(transactionId)||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000||typeof onUnknown!=='function')fail('INGRESS_CHANNEL_ARGUMENT_INVALID');
 if(!expectedDigests||Object.keys(expectedDigests).sort().join(',')!=='candidateSha256,sourceSha256')fail('INGRESS_EXPECTED_DIGESTS_INVALID');
 for(const k of ['sourceSha256','candidateSha256'])if(!Array.isArray(expectedDigests[k])||expectedDigests[k].length!==2||!expectedDigests[k].every(v=>typeof v==='string'&&hashPattern.test(v)))fail('INGRESS_EXPECTED_DIGESTS_INVALID');
}
function channel(child,transactionId,{timeoutMs,onUnknown,expectedDigests}){
 validateOptions(transactionId,{timeoutMs,onUnknown,expectedDigests});
 if(!child?.stdin||!child?.stdout||!child?.stderr||typeof child.on!=='function')fail('INGRESS_CHANNEL_ARGUMENT_INVALID');
 const reference={sourceSha256:[...expectedDigests.sourceSha256],candidateSha256:[...expectedDigests.candidateSha256]};
 let buffer='',pending=null,state='opening',seq=0,poisoned=false,closeWait=null;
 const expected=[['install','HELD_FILES_ONLY'],['verify','HELD_FILES_ONLY'],['restore','RESTORED_FILES_ONLY']];
 const poison=()=>{
  if(poisoned)return;poisoned=true;state='unknown';
  if(pending){const p=pending;pending=null;clearTimeout(p.timer);p.reject(Error('INGRESS_SESSION_UNKNOWN'));}
  if(closeWait){const p=closeWait;closeWait=null;clearTimeout(p.timer);p.reject(Error('INGRESS_SESSION_UNKNOWN'));}
  try{const result=onUnknown();if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});}catch{}
 };
 child.stderr.on('data',()=>{}); // Never emit helper stderr or raw response.
 child.on('error',poison);child.stdin.on('error',poison);child.stdout.on('error',poison);child.stderr.on('error',poison);
 const stdoutEnded=()=>{if((state!=='closing'&&state!=='closed')||pending||buffer)poison();};
 child.stdout.on('end',stdoutEnded);child.stdout.on('close',stdoutEnded);
 child.on('close',(code,signal)=>{
  if(state==='closing'&&closeWait&&code===0&&signal===null&&!buffer){const p=closeWait;closeWait=null;clearTimeout(p.timer);state='closed';p.resolve();return;}
  if(closeWait){const p=closeWait;closeWait=null;clearTimeout(p.timer);p.reject(Error('INGRESS_SESSION_UNKNOWN'));}
  if(state!=='closed')poison();
 });
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',chunk=>{
  if(poisoned)return;buffer+=chunk;if(buffer.length>8192){poison();return;}
  let pos;
  while((pos=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);
   if(!pending||!line||line.length>4096){poison();return;}
   const p=pending;pending=null;clearTimeout(p.timer);
   try{
    const parsed=frameCheck(line,transactionId,p.seq,p.op,p.outcome);
    if(JSON.stringify(parsed.sourceSha256)!==JSON.stringify(reference.sourceSha256)||JSON.stringify(parsed.candidateSha256)!==JSON.stringify(reference.candidateSha256))fail('INGRESS_FRAME_DIGEST_DRIFT');
    if(buffer.length)fail('INGRESS_UNSOLICITED_TRAILING_DATA');
    state=p.next;seq=p.seq;p.resolve(Object.freeze({op:p.op,outcome:p.outcome,transactionId,sourceSha256:[...parsed.sourceSha256],candidateSha256:[...parsed.candidateSha256]}));
   }catch{p.reject(Error('INGRESS_SESSION_UNKNOWN'));poison();return;}
  }
 });
 function waitFor(frame,send){
  if(pending){poison();fail('INGRESS_SESSION_CONCURRENT');}
  if(buffer.length){poison();fail('INGRESS_UNSOLICITED_TRAILING_DATA');}
  if(poisoned||!child.stdin.writable)fail('INGRESS_SESSION_NOT_AVAILABLE');
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(poison,timeoutMs);pending={...frame,resolve,reject,timer};
   if(send){try{child.stdin.write(JSON.stringify({seq:frame.seq,transactionId,op:frame.op})+'\n',error=>{if(error)poison();});}catch{poison();}}
  });
 }
 const ready=waitFor({seq:0,op:'ready',outcome:'READY',next:'active'},false);
 async function step(op){
  if(state!=='active'||!expected[seq]||expected[seq][0]!==op)fail('INGRESS_PHASE_INVALID');
  const [name,outcome]=expected[seq];
  return waitFor({seq:seq+1,op:name,outcome,next:op==='restore'?'restored':'active'},true);
 }
 async function close(){
  if(state!=='restored'||poisoned||pending)fail('INGRESS_CLOSE_UNSAFE');
  state='closing';
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{if(!closeWait)return;closeWait=null;poison();reject(Error('INGRESS_SESSION_UNKNOWN'));},timeoutMs);
   closeWait={resolve,reject,timer};
   try{child.stdin.end(error=>{if(error){clearTimeout(timer);closeWait=null;poison();reject(Error('INGRESS_SESSION_UNKNOWN'));}});}catch{clearTimeout(timer);closeWait=null;poison();reject(Error('INGRESS_SESSION_UNKNOWN'));}
  });
 }
 return Object.freeze({ready,step,close,status:()=>state});
}

export function openPinnedIngressChannel({helperPath,helperSha256,pythonPath,pythonSha256,transactionId,expectedDigests,timeoutMs=30000,onUnknown}){
 if(process.platform!=='linux'||process.geteuid?.()!==0)fail('INGRESS_LINUX_ROOT_REQUIRED');
 if(!helperPattern.test(helperPath)||!txPattern.test(transactionId))fail('INGRESS_HELPER_IDENTITY_INVALID');
 validateOptions(transactionId,{timeoutMs,onUnknown,expectedDigests});
 // Inputs must already be bound to the verified control-plane descriptor by
 // the caller. This file check does not replace descriptor verification.
 trustedFile(helperPath,helperSha256,4*1024*1024);trustedFile(pythonPath,pythonSha256,128*1024*1024);
 const child=spawn(pythonPath,['-I','-S','-B',helperPath,'--session',transactionId],{shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
 return channel(child,transactionId,{timeoutMs,onUnknown,expectedDigests});
}

// Test API cannot run on the Linux host and cannot weaken the Linux entry.
export function channelForWindowsTest(child,transactionId,options){
 if(process.platform!=='win32')fail('INGRESS_WINDOWS_TEST_ONLY');
 return channel(child,transactionId,options);
}
