// Isolated candidate. The production entry remains closed until the actual same-
// process compiler, DB identity and continuous root window are implemented.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createDispatchDeadline,sendWithinDeadline} from './dispatch-deadline.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const unknown=()=>Object.freeze({outcome:'UNKNOWN',automaticRetry:false,maintenanceMustRemain:true,attemptMarkerMustRemain:true});
const COMMAND='fixture-disabled';
function ingressRequest(where,urlPath){
 const root='/tmp/codex-window-fixture-only',mode=fs.readFileSync(root+'/scenario','utf8').trim(),held=fs.existsSync(root+'/held'),success=fs.existsSync(root+'/success');
 if(!['public','loopback'].includes(where)||!['/','/api/version'].includes(urlPath))throw Error('FIXTURE_INGRESS');
 let status=held?503:200;if(mode==='ingress-before'&&!success)status=200;if(mode==='ingress-held'&&success&&held)status=200;if(mode==='ingress-after'&&!held)status=503;
 const d=JSON.parse(fs.readFileSync(root+'/descriptor.json','utf8'));
 return Promise.resolve({status:urlPath==='/'?status:200,cacheControl:'no-store',body:Buffer.from(JSON.stringify({deployCommitSha:d.commitSha,releaseId:d.releaseId,buildId:d.buildId,sourceVersion:d.sourceVersion}))});
}
async function observeIngress(status,d,checkVersion,assertWindow){
 for(const where of ['public','loopback']){assertWindow();const root=await ingressRequest(where,'/');assertWindow();if(root.status!==status)throw Error('WINDOW_INGRESS_STATUS');
  if(checkVersion){const v=await ingressRequest(where,'/api/version');assertWindow();if(v.status!==200||!/\bno-store\b/i.test(v.cacheControl))throw Error('WINDOW_INGRESS_VERSION');let x;try{x=JSON.parse(v.body.toString('utf8'))}catch{throw Error('WINDOW_INGRESS_VERSION')};for(const [key,value] of [['deployCommitSha',d.commitSha],['releaseId',d.releaseId],['buildId',d.buildId],['sourceVersion',d.sourceVersion]])if(x?.[key]!==value)throw Error('WINDOW_INGRESS_VERSION');}
 }
}
function fixedSpawn(){return spawn(process.execPath,['/tmp/codex-window-fixture-only/db.mjs'],{shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});}
function assertLock(){
 const lock='/tmp/codex-window-fixture-only/web/.deploy.lock',p=fs.lstatSync(lock),d=fs.fstatSync(9);
 if(!p.isFile()||p.isSymbolicLink()||p.nlink!==1||p.uid!==0||p.gid!==0||(p.mode&0o022)!==0||!d.isFile()||d.dev!==p.dev||d.ino!==p.ino||d.uid!==0||d.gid!==0)throw Error('WINDOW_LOCK_INVALID');
 const probe=fs.openSync(lock,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
  const q=fs.fstatSync(probe);if(q.dev!==p.dev||q.ino!==p.ino)throw Error('WINDOW_LOCK_CHANGED');
  const fds=['ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore',probe,9],opts={stdio:fds,shell:false,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}};
  const competing=spawnSync('/usr/bin/flock',['-n','8'],opts);if(competing.error||competing.signal!==null||competing.status!==1)throw Error('WINDOW_LOCK_NOT_HELD');
  const inherited=spawnSync('/usr/bin/flock',['-n','9'],opts);if(inherited.error||inherited.signal!==null||inherited.status!==0)throw Error('WINDOW_LOCK_NOT_OWNED');
 }finally{fs.closeSync(probe)}
}

function trustedDirectory(dir){
 const root='/tmp/codex-window-fixture-only/control/transactions';
 if(path.dirname(dir)!==root||!/^[-A-Za-z0-9._]{8,159}$/.test(path.basename(dir)))throw Error('WINDOW_DIRECTORY_INVALID');
 for(const d of [dir,root,'/tmp/codex-window-fixture-only/control']){const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(d)!==d||s.uid!==0||s.gid!==0||(s.mode&0o022)!==0)throw Error('WINDOW_DIRECTORY_UNSAFE');}
}
function fsyncDir(dir){const d=fs.openSync(dir,fs.constants.O_RDONLY);try{fs.fsyncSync(d)}finally{fs.closeSync(d)}}
function writeExclusive(file,body){
 let fd;try{fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,body);fs.fsyncSync(fd);
 }finally{if(fd!==undefined)fs.closeSync(fd)}
 fsyncDir(path.dirname(file));
}
function fileHash(file,mode) {
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const a=fs.fstatSync(fd),p=fs.lstatSync(file);
  if(!a.isFile()||a.uid!==0||a.gid!==0||a.nlink!==1||(mode==='private'?(a.mode&0o777)!==0o600:(a.mode&0o077)!==0)
    ||!p.isFile()||p.isSymbolicLink()||p.dev!==a.dev||p.ino!==a.ino||a.size>4*1024*1024)throw Error('WINDOW_FILE_UNSAFE');
  const bytes=fs.readFileSync(fd),b=fs.fstatSync(fd),q=fs.lstatSync(file);
  for(const k of ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'])if(a[k]!==b[k]||a[k]!==q[k])throw Error('WINDOW_FILE_CHANGED');
  return sha(bytes);
 }finally{fs.closeSync(fd)}
}
function requireMissing(file){try{fs.lstatSync(file);throw Error('WINDOW_MARKER_ALREADY_EXISTS')}catch(e){if(e.code!=='ENOENT')throw e}}
function verifyPlan(plan){
 if(!plan||!Buffer.isBuffer(plan.scriptBytes)||!Buffer.isBuffer(plan.wire)||!uuid(plan.batchId)
 || !hash(plan.scriptSha256)||!hash(plan.wireSha256)||sha(plan.scriptBytes)!==plan.scriptSha256
 ||sha(plan.wire)!==plan.wireSha256||!plan.wire.equals(Buffer.from(plan.scriptBytes.toString('base64')+'\n','ascii'))
 ||!hash(plan.artifactSha256)||!hash(plan.stateSha256)||!hash(plan.configSha256)
 ||typeof plan.transactionRoot!=='string'||typeof plan.configPath!=='string'
 ||path.basename(plan.transactionRoot)!==plan.transactionId||!plan.transactionId.endsWith(`-${plan.artifactSha256.slice(0,12)}`))throw Error('BOUND_PLAN_INVALID');
}
function assertPrepared(plan){
 assertLock();trustedDirectory(plan.transactionRoot);
 if(fileHash(path.join(plan.transactionRoot,'media-worker-state.json'),'private')!==plan.stateSha256||fileHash(plan.configPath,'config')!==plan.configSha256)throw Error('WINDOW_BINDING_CHANGED');
}
// Private until real plan compiler and the operator's continuous hold capability
// are wired into the same process. A plan object passed by a caller is not proof.
async function boundAttempt(plan,spawnChild){
 try{
  verifyPlan(plan);assertPrepared(plan);
  const attempt=path.join(plan.transactionRoot,'migration-attempt.json'), success=path.join(plan.transactionRoot,'migration-confirmed.json');
  // The fixed success record cannot pre-exist before this invocation.
  requireMissing(success);
  const deadline=createDispatchDeadline({batchId:plan.batchId,wireSha256:plan.wireSha256,latestSendAt:plan.latestSendAt,receiptBy:plan.receiptBy});
  writeExclusive(attempt,Buffer.from(JSON.stringify({schemaVersion:1,transactionId:plan.transactionId,batchId:plan.batchId,scriptSha256:plan.scriptSha256,wireSha256:plan.wireSha256})+'\n'));
  assertPrepared(plan);requireMissing(success);
  const result=await sendWithinDeadline({deadline,wire:plan.wire,batchId:plan.batchId,spawnFixed:spawnChild});
  if(result.outcome!=='COMMITTED'||result.reason!=='EXACT_RECEIPT'||!hash(result.receiptSha256))return unknown();
  assertPrepared(plan);
  const marker={schemaVersion:1,transactionId:plan.transactionId,artifactSha256:plan.artifactSha256,batchId:plan.batchId,
    scriptSha256:plan.scriptSha256,wireSha256:plan.wireSha256,commitReceiptSha256:result.receiptSha256,stateSha256:plan.stateSha256,configSha256:plan.configSha256};
  writeExclusive(success,Buffer.from(JSON.stringify(marker)+'\n'));
  assertPrepared(plan);
  return Object.freeze({outcome:'COMMITTED',automaticRetry:false,maintenanceMustRemain:true,attemptMarkerMustRemain:true});
 }catch{return unknown()}
}
// Called only by the same trusted root window process which owns FD 9 and
// maintenance. A marker by itself is never sufficient to resume a prior run.
function confirmedMarkerMatches(plan){
 assertPrepared(plan);const file=path.join(plan.transactionRoot,'migration-confirmed.json');
 const first=fileHash(file,'private'),bytes=fs.readFileSync(file);if(sha(bytes)!==first)throw Error('WINDOW_CONFIRMATION_CHANGED');const m=JSON.parse(bytes.toString('utf8'));
 if(!bytes.equals(Buffer.from(JSON.stringify(m)+'\n'))||Object.keys(m).sort().join(',')!=='artifactSha256,batchId,commitReceiptSha256,configSha256,schemaVersion,scriptSha256,stateSha256,transactionId,wireSha256'||m.schemaVersion!==1||m.transactionId!==plan.transactionId||m.artifactSha256!==plan.artifactSha256||m.batchId!==plan.batchId||m.scriptSha256!==plan.scriptSha256||m.wireSha256!==plan.wireSha256||m.stateSha256!==plan.stateSha256||m.configSha256!==plan.configSha256)throw Error('WINDOW_CONFIRMATION_INVALID');
 const r='COMMIT_CONFIRMED_'+plan.batchId;if(![sha(Buffer.from(r+'\n')),sha(Buffer.from(r+'\r\n'))].includes(m.commitReceiptSha256))throw Error('WINDOW_RECEIPT_INVALID');
 if(fileHash(file,'private')!==first)throw Error('WINDOW_CONFIRMATION_CHANGED');assertPrepared(plan);
}
function readStableState(plan){
 assertLock();trustedDirectory(plan.transactionRoot);const f=path.join(plan.transactionRoot,'media-worker-state.json');
 const digest=fileHash(f,'private'),raw=fs.readFileSync(f);if(sha(raw)!==digest||fileHash(f,'private')!==digest)throw Error('WINDOW_STATE_DRIFT');
 const value=JSON.parse(raw.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('WINDOW_STATE_INVALID');return {value,digest};
}
function persistedMatches(plan,prepared){
 const current=readStableState(plan),value=current.value,previous=prepared.value;
 if(value.schemaVersion!==previous.schemaVersion||value.workerName!==previous.workerName||value.preparedAt!==previous.preparedAt||value.configPath!==previous.configPath||value.configSha256!==previous.configSha256||JSON.stringify(value.previous)!==JSON.stringify(previous.previous)||value.status!=='persisted'||!Number.isFinite(Date.parse(value.persistedAt||'')))throw Error('WINDOW_PERSISTED_STATE_INVALID');
 const next=value.next;if(!next||next.releaseId!==plan.releaseId||next.commitSha!==plan.commitSha||next.buildId!==plan.buildId||next.sourceVersion!==plan.sourceVersion||next.buildOutputDigest!==plan.buildOutputDigest||next.assetDigest!==plan.assetDigest||next.assetManifestSha256!==plan.assetManifestSha256||next.cwd!==`/tmp/codex-window-fixture-only/web/releases/${plan.releaseId}/web`||fs.realpathSync('/tmp/codex-window-fixture-only/web/current-web')!==next.cwd||fileHash(plan.configPath,'config')!==plan.configSha256)throw Error('WINDOW_PERSISTED_IDENTITY_INVALID');
 assertLock();return true;
}
async function runBatchThenController(plan,spawnDb,startController){
 const result=await boundAttempt(plan,spawnDb);
 // A full marker can remain after UNKNOWN: this exact in-memory result is required.
 if(result.outcome!=='COMMITTED')return unknown();
 try{confirmedMarkerMatches(plan);assertPrepared(plan);const prepared=readStableState(plan);
  if(prepared.digest!==plan.stateSha256||prepared.value.status!=='prepared'||typeof plan.releaseId!=='string'||typeof plan.commitSha!=='string'||typeof plan.buildId!=='string'||typeof plan.sourceVersion!=='string'||!hash(plan.buildOutputDigest)||!hash(plan.assetDigest)||!hash(plan.assetManifestSha256))throw Error('WINDOW_PREPARED_INVALID');
  const outcome=await startController();if(outcome!=='CONTROLLER_SUCCESS_AND_EXIT_ZERO')return unknown();
  persistedMatches(plan,prepared);return Object.freeze({outcome:'CONTROLLER_PROCESS_RESULT_RECEIVED',automaticRetry:false,maintenanceMustRemain:true,attemptMarkerMustRemain:true});
 }catch{return unknown();}
}

// Only the privately authenticated window can supply the held transaction.
// The fixed authenticated sender creates the dynamic batch after READY; the
// header hashes bind transport bytes, not independent review or authorization.
async function receiveOneWire(input,deadlineMs,assertOpen){
 let timer,header=Buffer.alloc(0),wire=null,used=0,parsed=false,accepted;
 const decode = new TextDecoder('utf-8',{fatal:true});
 const expired = new Promise((_,reject)=>{timer=setTimeout(()=>{input.destroy();reject(Error('WIRE_TIMEOUT'));},deadlineMs)});
 async function read(){
  for await(const raw of input){
   assertOpen();if(!Buffer.isBuffer(raw))throw Error('WIRE_BYTES_REQUIRED');
   let offset=0;
   if(!parsed){
    const index=raw.indexOf(10);
    const n=index<0?raw.length:index;
    if(header.length+n>512)throw Error('WIRE_HEADER_TOO_LONG');
    header=Buffer.concat([header,raw.subarray(0,n)]);
    if(index<0)continue;
    const text=decode.decode(header);let h;
    try{h=JSON.parse(text)}catch{throw Error('WIRE_HEADER_INVALID')}
    const keys=['batchId','scriptSha256','wireSha256','wireLength'];
    if(!h||Array.isArray(h)||Object.keys(h).length!==keys.length||keys.some((v,i)=>Object.keys(h)[i]!==v)
       ||JSON.stringify(h)!==text||!uuid(h.batchId)||!hash(h.scriptSha256)||!hash(h.wireSha256)
       ||!Number.isSafeInteger(h.wireLength)||h.wireLength<5||h.wireLength>24*1024*1024
)throw Error('WIRE_HEADER_INVALID');
    accepted=h;wire=Buffer.alloc(h.wireLength);parsed=true;offset=index+1;
   }
   const amount=raw.length-offset;
   if(amount>wire.length-used)throw Error('WIRE_OVERFLOW');
   raw.copy(wire,used,offset);used+=amount;
  }
  assertOpen();if(!parsed||used!==wire.length)throw Error('WIRE_TRUNCATED');
  if(sha(wire)!==accepted.wireSha256||wire[wire.length-1]!==10)throw Error('WIRE_HASH_INVALID');
  const encoded=wire.subarray(0,-1).toString('ascii'),scriptBytes=Buffer.from(encoded,'base64');
  if(!wire.equals(Buffer.from(scriptBytes.toString('base64')+'\n','ascii'))||sha(scriptBytes)!==accepted.scriptSha256)throw Error('SCRIPT_HASH_INVALID');
  return {wire,scriptBytes,batchId:accepted.batchId,scriptSha256:accepted.scriptSha256,wireSha256:accepted.wireSha256};
 }
 try{return await Promise.race([read(),expired])}finally{clearTimeout(timer)}
}
async function pipeWrite(output,line,assertOpen){
 assertOpen();await new Promise((resolve,reject)=>output.write(line,(err)=>err?reject(err):resolve()));assertOpen();
}
// Internal-only protocol stage. The trusted window identity is never parsed
// from stdin. Production still requires an authenticated fixed sender and the
// reviewed transaction guards inside the compiled SQL.
async function serveWindowOnce({trusted,input,output,spawnDb,startController,assertWindow=()=>{},readTimeoutMs=30000}){
 let lost=false;const markLost=()=>{lost=true};
 output.on('error',markLost);output.on('close',markLost);
 const assertOpen=()=>{if(lost||output.destroyed||!output.writable)throw Error('WINDOW_PIPE_LOST');assertWindow()};
 try{
  if(!trusted||!hash(trusted.artifactSha256)||typeof trusted.transactionId!=='string'
     ||!Number.isSafeInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>120000)throw Error('TRUSTED_PLAN_INVALID');
  assertPrepared(trusted);
  await pipeWrite(output,JSON.stringify({phase:'READY_FOR_WIRE',transactionId:trusted.transactionId,artifactSha256:trusted.artifactSha256})+'\n',assertOpen);
  const received=await receiveOneWire(input,readTimeoutMs,assertOpen);
  assertOpen();assertPrepared(trusted);
  const plan={...trusted,...received};
  const status=phase=>JSON.stringify({phase,transactionId:trusted.transactionId,artifactSha256:trusted.artifactSha256})+'\n';
  await pipeWrite(output,status('WIRE_ACCEPTED'),assertOpen);
  assertPrepared(trusted);assertOpen();
  const result=await runBatchThenController(plan,()=>{assertOpen();return spawnDb()},async()=>{
   await pipeWrite(output,status('DB_COMMITTED'),assertOpen);
   assertPrepared(trusted);assertOpen();return await startController();
  });
  assertOpen();return result;
 }catch{return unknown()}
 finally{output.off('error',markLost);output.off('close',markLost)}
}
// The descriptor is produced/reviewed for this one release by the trusted root
// operator. It contains paths and hashes only; credentials are never written.
function checkRootFile(file,expected,limit=1024*1024*1024){
 if(typeof file!=='string'||!path.posix.isAbsolute(file)||path.posix.normalize(file)!==file||!hash(expected)||fs.realpathSync(file)!==file)throw Error('WINDOW_FILE_IDENTITY');
 for(let dir=path.dirname(file);;dir=path.dirname(dir)){const x=fs.lstatSync(dir);if(!x.isDirectory()||x.isSymbolicLink()||x.uid!==0||x.gid!==0||(x.mode&0o022))throw Error('WINDOW_PARENT_UNSAFE');if(dir==='/')break;}
 const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.uid!==0||before.gid!==0||before.nlink!==1||(before.mode&0o022)||before.size<1||before.size>limit)throw Error('WINDOW_FILE_UNSAFE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),h=crypto.createHash('sha256'),buf=Buffer.alloc(1024*1024);try{
  const opened=fs.fstatSync(fd),same=(a,b)=>['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);if(!same(before,opened))throw Error('WINDOW_FILE_CHANGED');
  for(;;){const n=fs.readSync(fd,buf,0,buf.length,null);if(!n)break;h.update(buf.subarray(0,n));}
  if(!same(opened,fs.fstatSync(fd))||!same(opened,fs.lstatSync(file))||h.digest('hex')!==expected)throw Error('WINDOW_FILE_CHANGED');
 }finally{fs.closeSync(fd)}
}
function readDescriptor(file,expected){if(file!=='/tmp/codex-window-fixture-only/descriptor.json'||expected!=='a'.repeat(64))throw Error('FIXTURE_DESCRIPTOR_INVALID');return JSON.parse(fs.readFileSync(file,'utf8'));}
function childWithLock(command,args,env){
 const fds=['pipe','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore',9];
 const child=spawn(command,args,{shell:false,stdio:fds,env,cwd:'/'});child.stderr.on('data',()=>{});child.on('error',()=>{child.windowFailed=true});child.stdin.on('error',()=>{child.windowFailed=true});child.stdout.on('error',()=>{child.windowFailed=true});
 child.windowFailed=false;child.windowClosed=false;child.windowClose=new Promise(resolve=>child.once('close',(code,signal)=>{child.windowClosed=true;resolve({code,signal})}));return child;
}
function assertChildAlive(child){if(!child||child.windowFailed||child.exitCode!==null||child.signalCode!==null||child.windowClosed)throw Error('WINDOW_CHILD_EXITED')}
function lineReader(child){
 const lines=[],waiters=[];let ended=false,failed=false,buffer='';child.stdout.setEncoding('utf8');
 const rejectAll=()=>{failed=true;while(waiters.length)waiters.shift().reject(Error('WINDOW_CHILD_UNKNOWN'));};
 child.stdout.on('data',chunk=>{if(failed)return;buffer+=chunk;if(buffer.length>16384){rejectAll();return;}let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line){rejectAll();return;}const waiter=waiters.shift();if(waiter)waiter.resolve(line);else lines.push(line);if(lines.length>2){rejectAll();return;}}});
 child.stdout.on('error',rejectAll);child.on('error',rejectAll);child.stdout.on('end',()=>{ended=true;if(buffer)rejectAll();else while(waiters.length)waiters.shift().reject(Error('WINDOW_CHILD_EOF'));});
 const valid=(final)=>{if(failed||child.windowFailed)throw Error('WINDOW_CHILD_UNKNOWN');if(final){if(child.signalCode!==null||(child.exitCode!==null&&child.exitCode!==0))throw Error('WINDOW_CHILD_EXITED')}else assertChildAlive(child)};
 return {async next(ms=30000,final=false){valid(final);if(lines.length){const line=lines.shift();valid(final);return line}if(ended||(!final&&(child.exitCode!==null||child.signalCode!==null)))throw Error('WINDOW_CHILD_EOF');const line=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{const i=waiters.indexOf(item);if(i>=0)waiters.splice(i,1);reject(Error('WINDOW_CHILD_TIMEOUT'));},ms);const item={resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}};waiters.push(item);});valid(final);return line;},clean(){return !failed&&!buffer&&!lines.length&&ended;},assertLive(){valid(false);if(ended||lines.length||buffer)throw Error('WINDOW_CHILD_UNEXPECTED_OUTPUT')}};
}
async function exitZero(child,timeout=30000){
 let timer;try{const result=await Promise.race([child.windowClose,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('WINDOW_CHILD_TIMEOUT')),timeout)})]);return !child.windowFailed&&result.code===0&&result.signal===null}finally{clearTimeout(timer)}
}
async function stopOwned(child){
 if(!child)return;try{child.stdin.destroy()}catch{};
 if(!child.windowClosed){try{child.kill('SIGTERM')}catch{};await Promise.race([child.windowClose,new Promise(r=>setTimeout(r,1500))]);}
 if(!child.windowClosed){try{child.kill('SIGKILL')}catch{};await Promise.race([child.windowClose,new Promise(r=>setTimeout(r,1500))]);}
}
function parseLine(line){let value;try{value=JSON.parse(line)}catch{throw Error('WINDOW_FRAME_INVALID')}if(!value||Array.isArray(value)||JSON.stringify(value)!==line)throw Error('WINDOW_FRAME_INVALID');return value;}
async function sendLine(child,value){if(child.exitCode!==null||child.signalCode!==null||!child.stdin.writable)throw Error('WINDOW_CHILD_CLOSED');await new Promise((resolve,reject)=>child.stdin.write(JSON.stringify(value)+'\n',e=>e?reject(e):resolve()));assertLock();}
async function openMaintenance(d){
 const env={PATH:'/usr/bin:/bin',LC_ALL:'C'},child=childWithLock(d.pythonPath,['-I','-S','-B',d.maintenancePath,'--session',d.transactionId,'--artifact',d.artifactSha256,'--commit',d.commitSha,'--asset',d.assetDigest],env),reader=lineReader(child);
 try{const ready=parseLine(await reader.next());if(ready.seq!==0||ready.transactionId!==d.transactionId||ready.op!=='ready'||ready.outcome!=='READY'||!Array.isArray(ready.sourceSha256)||!Array.isArray(ready.candidateSha256)||ready.sourceSha256.length!==2||ready.candidateSha256.length!==2||![...ready.sourceSha256,...ready.candidateSha256].every(hash))throw Error('WINDOW_HOLD_READY_INVALID');
 async function step(seq,op,outcome){await sendLine(child,{seq,transactionId:d.transactionId,op});const r=parseLine(await reader.next(30000,op==='restore'));if(r.seq!==seq||r.transactionId!==d.transactionId||r.op!==op||r.outcome!==outcome||JSON.stringify(r.sourceSha256)!==JSON.stringify(ready.sourceSha256)||JSON.stringify(r.candidateSha256)!==JSON.stringify(ready.candidateSha256))throw Error('WINDOW_HOLD_REPLY_INVALID');}
 await step(1,'install','HELD_FILES_ONLY');await step(2,'verify','HELD_FILES_ONLY');
 return {child,reader,async restore(){await step(3,'restore','RESTORED_FILES_ONLY');child.stdin.end();if(!await exitZero(child,10000)||!reader.clean())throw Error('WINDOW_HOLD_CLOSE_UNKNOWN');}};
 }catch(e){await stopOwned(child);throw e}
}
async function openPrestop(d){
 const env={PATH:'/usr/bin:/bin',LC_ALL:'C'},child=childWithLock(d.pythonPath,['-I','-S','-B',d.workerFactoryPath],env),reader=lineReader(child);
 try{const r=parseLine(await reader.next(120000));
 if(r.outcome!=='PRESTOP_READY'||r.transactionId!==d.transactionId||!hash(r.stateSha256)||r.configSha256!==d.configSha256||!hash(r.evidenceSha256)||r.releaseReady!==true||r.maintenanceMustRemain!==true||r.automaticRetry!==false)throw Error('WINDOW_PRESTOP_INVALID');
 return {child,reader,receipt:r,async handoff(){await sendLine(child,{op:'handoff'});child.stdin.end();const h=parseLine(await reader.next(30000,true));if(h.outcome!=='HANDOFF_READY'||h.transactionId!==d.transactionId)throw Error('WINDOW_HANDOFF_INVALID');if(!await exitZero(child,10000)||!reader.clean())throw Error('WINDOW_PRESTOP_CLOSE_UNKNOWN');}};
 }catch(e){await stopOwned(child);throw e}
}
function controllerEnvironment(d){
 return {PATH:'/tmp/codex-window-fixture-only/control/toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C',HOME:'/tmp/codex-window-fixture-only',PM2_HOME:'/tmp/codex-window-fixture-only/pm2',DEPLOY_EXECUTION_APPROVED:d.releaseId,CONTROL_PLANE_TRUSTED_VERIFIER:d.verifierPath,CONTROL_PLANE_TRUSTED_VERIFIER_SHA256:d.verifierSha256,CONTROL_PLANE_INSTALLATION_RECEIPT:d.receiptPath,CONTROL_PLANE_INSTALLATION_RECEIPT_SHA256:d.receiptSha256,CONTROL_PLANE_EXPECTED_DESCRIPTOR:d.controlDescriptorPath,CONTROL_PLANE_EXPECTED_DESCRIPTOR_SHA256:d.controlDescriptorSha256,RELEASE_VALIDATION_BUNDLE:d.bundlePath,RELEASE_VALIDATION_BUNDLE_SHA256:d.bundleSha256,DIRECT_HOOK_PATH:d.hookPath,DIRECT_HOOK_SHA256:d.hookSha256,DIRECT_HOOK_PM2_CONFIG_PATH:d.configPath,DIRECT_HOOK_PM2_CONFIG_SHA256:d.configSha256,DIRECT_TRANSACTION_ROOT:'/tmp/codex-window-fixture-only/control/transactions/'+d.transactionId};
}
async function runFixedPlan(d){
 assertLock();checkRootFile(d.controllerPath,d.controllerSha256);checkRootFile(d.artifactPath,d.artifactSha256,2*1024*1024*1024);
 const child=childWithLock('/bin/bash',[d.controllerPath,'--plan','--release-mode','WEB','--service','web','--artifact',d.artifactPath,'--sha256',d.artifactSha256,'--release-id',d.releaseId,'--root','/tmp/codex-window-fixture-only/web'],controllerEnvironment(d));child.stdout.on('data',()=>{});child.stdin.end();
 try{if(!await exitZero(child,300000))throw Error('WINDOW_PLAN_UNKNOWN');assertLock();checkRootFile(d.controllerPath,d.controllerSha256);checkRootFile(d.artifactPath,d.artifactSha256,2*1024*1024*1024)}catch(e){await stopOwned(child);throw e}
}
async function fixedController(d,prestop,assertWindow,onSpawn){
 await prestop.handoff();assertWindow();checkRootFile(d.controllerPath,d.controllerSha256);checkRootFile(d.artifactPath,d.artifactSha256,2*1024*1024*1024);

 assertWindow();const child=childWithLock('/bin/bash',[d.controllerPath,'--execute','--prestop-adopt','--release-mode','WEB','--service','web','--artifact',d.artifactPath,'--sha256',d.artifactSha256,'--release-id',d.releaseId,'--root','/tmp/codex-window-fixture-only/web'],controllerEnvironment(d));onSpawn(child);child.stdout.on('data',()=>{});child.stdin.end();try{if(!await exitZero(child,900000))throw Error('WINDOW_CONTROLLER_UNKNOWN');assertLock();return 'CONTROLLER_SUCCESS_AND_EXIT_ZERO';}catch(e){await stopOwned(child);throw e}
}
async function runRootWindow(descriptorPath,descriptorSha){
 if(process.platform!=='linux'||process.geteuid?.()!==0)throw Error('WINDOW_ROOT_REQUIRED');assertLock();const d=readDescriptor(descriptorPath,descriptorSha);let maintenance,prestop,dbChild,controllerChild,windowLost=false,outputLost=false,preRetiring=false,maintenanceRetiring=false;
 const outputFailed=()=>{outputLost=true};process.stdout.on('error',outputFailed);process.stdout.on('close',outputFailed);
 const lost=()=>{windowLost=true;for(const child of [dbChild,controllerChild])if(child&&child.exitCode===null&&child.signalCode===null)try{child.kill('SIGTERM')}catch{}};
 const assertWindow=()=>{assertLock();if(outputLost||process.stdout.destroyed||!process.stdout.writable)throw Error('WINDOW_OUTPUT_LOST');if(windowLost)throw Error('WINDOW_CHILD_LOST');if(maintenance&&!maintenanceRetiring)maintenance.reader.assertLive();if(prestop&&!preRetiring)prestop.reader.assertLive()};
 try{
  await runFixedPlan(d);assertWindow();maintenance=await openMaintenance(d);maintenance.child.on('exit',()=>{if(!maintenanceRetiring)lost()});assertWindow();await observeIngress(503,d,false,assertWindow);assertWindow();
  prestop=await openPrestop(d);prestop.child.on('exit',()=>{if(!preRetiring)lost()});assertWindow();
  const t=Date.now(),trusted={transactionId:d.transactionId,transactionRoot:'/tmp/codex-window-fixture-only/control/transactions/'+d.transactionId,artifactSha256:d.artifactSha256,stateSha256:prestop.receipt.stateSha256,configPath:d.configPath,configSha256:d.configSha256,releaseId:d.releaseId,commitSha:d.commitSha,buildId:d.buildId,sourceVersion:d.sourceVersion,buildOutputDigest:d.buildOutputDigest,assetDigest:d.assetDigest,assetManifestSha256:d.assetManifestSha256,latestSendAt:t+120000,receiptBy:t+900000};
  const result=await serveWindowOnce({trusted,input:process.stdin,output:process.stdout,assertWindow,spawnDb:()=>{assertWindow();dbChild=fixedSpawn();return dbChild},startController:async()=>{assertWindow();preRetiring=true;return await fixedController(d,prestop,assertWindow,c=>{controllerChild=c})},readTimeoutMs:120000});
  if(result.outcome!=='CONTROLLER_PROCESS_RESULT_RECEIVED')throw Error('WINDOW_OUTCOME_UNKNOWN');assertWindow();await observeIngress(503,d,true,assertWindow);assertWindow();maintenanceRetiring=true;await maintenance.restore();assertLock();if(windowLost)throw Error('WINDOW_CHILD_LOST');await observeIngress(200,d,true,()=>{assertLock();if(windowLost||outputLost||process.stdout.destroyed||!process.stdout.writable)throw Error('WINDOW_CHILD_LOST')});
  await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify({phase:'WINDOW_RELEASED',transactionId:d.transactionId,artifactSha256:d.artifactSha256})+'\n',e=>e?reject(e):resolve()));return 'WINDOW_RELEASED';
 }catch{await Promise.all([stopOwned(prestop?.child),stopOwned(maintenance?.child)]);throw Error('WINDOW_OUTCOME_UNKNOWN_NO_RETRY');}finally{process.stdout.off('error',outputFailed);process.stdout.off('close',outputFailed)}
}
export async function executeReviewedProduction(...args){
 if(args.length!==2||typeof args[0]!=='string'||!hash(args[1]))throw Error('WINDOW_ARGUMENT_INVALID');
 return await runRootWindow(args[0],args[1]);
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 if(process.argv.length!==5||process.argv[2]!=='--descriptor')process.exitCode=2;
 else executeReviewedProduction(process.argv[3],process.argv[4]).catch(()=>{process.stderr.write('WINDOW_OUTCOME_UNKNOWN_NO_RETRY\n');process.exitCode=1;});
}

export const runtimeBoundary=Object.freeze({productionEntryAvailable:true,requiresRootAndFd9:true,automaticRetry:false,holdReleaseRequiresSuccess:true});
