// Isolated journal prototype. Native writer is Linux root only and this module
// has no CLI. It is not wired to production or to the closed observation gate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {hashValue} from './hook-adoption-vnext.mjs';
const F=fs.constants,NOFOLLOW=F.O_NOFOLLOW||0,MAX=1024*1024;
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const encode=o=>Buffer.from(JSON.stringify(o)+'\n');
const clone=o=>JSON.parse(JSON.stringify(o));
const freezeDeep=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(freezeDeep);Object.freeze(o);}return o;};
const fail=m=>{throw Error(m)};
function bindingCheck(b){
 assert.deepEqual(Object.keys(b).sort(),['artifactSha256','bootId','configSha256','dbIdentity','hookSha256','migrationSqlSha256','releaseId','transactionId'].sort());
 for(const k of ['artifactSha256','configSha256','hookSha256','migrationSqlSha256']) assert.match(b[k],/^[a-f0-9]{64}$/);
 for(const k of ['transactionId','bootId','releaseId','dbIdentity']) assert.match(b[k],/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
}
function metadata(p,kind,strict){
 const s=fs.lstatSync(p);assert.ok(!s.isSymbolicLink());
 assert.ok(kind==='dir'?s.isDirectory():s.isFile());
 if(kind==='file')assert.equal(s.nlink,1);
 if(strict){assert.equal(s.uid,0);assert.equal(s.gid,0);assert.equal(s.mode&0o777,kind==='dir'?0o700:0o600);}
 return s;
}
function parentChain(root,strict,privateLeaf=true){
 assert.equal(path.resolve(root),root);let dir=root;
 while(true){const s=fs.lstatSync(dir);assert.ok(s.isDirectory()&&!s.isSymbolicLink());if(strict){assert.equal(s.uid,0);assert.equal(s.gid,0);assert.equal(s.mode&0o022,0);}const next=path.dirname(dir);if(next===dir)break;dir=next;}
 if(privateLeaf)metadata(root,'dir',strict);
}
function readPrivate(p,strict){
 const before=metadata(p,'file',strict), fd=fs.openSync(p,F.O_RDONLY|NOFOLLOW);
 try{const st=fs.fstatSync(fd);assert.ok(st.isFile());assert.equal(st.dev,before.dev);assert.equal(st.ino,before.ino);assert.ok(st.size>0&&st.size<=MAX);return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function parseObject(buf){let o;try{o=JSON.parse(buf.toString('utf8'));}catch{fail('JOURNAL_JSON_INVALID')}assert.ok(o&&typeof o==='object'&&!Array.isArray(o));return o;}
function validateRecord(record,binding,claimSha){
 assert.deepEqual(Object.keys(record).sort(),['binding','claimSha256','previousValueSha256','revision','schema','value','valueSha256'].sort());
 assert.equal(record.schema,'zimeiti-window-journal.v1');assert.deepEqual(record.binding,binding);assert.equal(record.claimSha256,claimSha);
 assert.ok(Number.isSafeInteger(record.revision)&&record.revision>=0);assert.match(record.previousValueSha256,/^(?:[a-f0-9]{64}|-)$/);
 assert.equal(record.valueSha256,hashValue(record.value));
}
function createCore({root,binding,initialState,strict,hit=()=>{},syncDir}){
 bindingCheck(binding);root=path.resolve(root);assert.equal(path.basename(root),binding.transactionId);
 const parent=path.dirname(root);parentChain(parent,strict,false);
 assert.ok(initialState&&initialState.status==='preparing'&&initialState.slotJournal?.phase==='initial');
 let poisoned=false,revision=0,currentHash=hashValue(initialState),claimSha,hookClaimAttempted=false;
 const lockOwnerPid=process.pid,nonce=crypto.randomBytes(32),nonceHash=digest(nonce),b=clone(binding);
 const at=(label)=>hit(label);
 function uncertain(cause){poisoned=true;const e=Error('JOURNAL_WRITE_OUTCOME_UNKNOWN');e.recoveryRequired=true;e.cause=cause;return e;}
 function checkOwner(){assert.equal(poisoned,false,'JOURNAL_WRITER_POISONED');assert.equal(process.pid,lockOwnerPid,'JOURNAL_OWNER_CHANGED');parentChain(root,strict);const claim=readPrivate(path.join(root,'claim.json'),strict);assert.equal(digest(claim),claimSha);assert.equal(parseObject(claim).nonceHash,nonceHash);}
 function writeTemp(name,bytes){
  assert.ok(bytes.length>0&&bytes.length<=MAX);const p=path.join(root,`${name}.${crypto.randomUUID()}.tmp`);let fd;
  at(`${name}:before-create`);fd=fs.openSync(p,F.O_CREAT|F.O_EXCL|F.O_WRONLY|NOFOLLOW,0o600);
  try{if(strict)fs.fchmodSync(fd,0o600);at(`${name}:after-create`);fs.writeFileSync(fd,bytes);at(`${name}:after-write`);fs.fsyncSync(fd);at(`${name}:after-fsync`);}finally{fs.closeSync(fd);}
  metadata(p,'file',strict);return p;
 }
 function syncRoot(){at('dir:before-fsync');syncDir(root);at('dir:after-fsync');}
 try {
  at('root:before-mkdir');fs.mkdirSync(root,{mode:0o700});if(strict)fs.chmodSync(root,0o700);metadata(root,'dir',strict);
  // Parent fsync makes the one-shot transaction claim durable.
  at('parent:before-fsync');syncDir(parent);at('parent:after-fsync');
  const claimBytes=encode({schema:'zimeiti-window-claim.v1',binding:b,ownerPid:lockOwnerPid,nonceHash});claimSha=digest(claimBytes);
  const t=writeTemp('claim',claimBytes);at('claim:before-link');fs.linkSync(t,path.join(root,'claim.json'));at('claim:after-link');fs.unlinkSync(t);syncRoot();
  const initial={schema:'zimeiti-window-journal.v1',binding:b,claimSha256:claimSha,revision:0,previousValueSha256:'-',valueSha256:currentHash,value:clone(initialState)};
  const i=writeTemp('initial',encode(initial));at('initial:before-link');fs.linkSync(i,path.join(root,'journal.json'));at('initial:after-link');fs.unlinkSync(i);syncRoot();
  const record=parseObject(readPrivate(path.join(root,'journal.json'),strict));validateRecord(record,b,claimSha);assert.equal(record.valueSha256,currentHash);
 } catch(e){throw uncertain(e);}
 function inspect(){
  parentChain(root,strict);const claim=readPrivate(path.join(root,'claim.json'),strict);assert.equal(digest(claim),claimSha);
  const record=parseObject(readPrivate(path.join(root,'journal.json'),strict));validateRecord(record,b,claimSha);return clone(record);
 }
 function checkpoint(expectedValueHash,nextValue){
  checkOwner();assert.match(expectedValueHash,/^[a-f0-9]{64}$/);const before=inspect();
  assert.equal(before.revision,revision,'JOURNAL_REVISION_CHANGED');assert.equal(before.valueSha256,currentHash,'JOURNAL_MEMORY_DRIFT');assert.equal(before.valueSha256,expectedValueHash,'JOURNAL_CAS_MISMATCH');
  const newHash=hashValue(nextValue),next={schema:'zimeiti-window-journal.v1',binding:b,claimSha256:claimSha,revision:revision+1,previousValueSha256:currentHash,valueSha256:newHash,value:clone(nextValue)};
  try{
   const t=writeTemp('checkpoint',encode(next));checkOwner();const unchanged=inspect();assert.equal(unchanged.revision,revision);assert.equal(unchanged.valueSha256,currentHash);
   at('checkpoint:before-rename');fs.renameSync(t,path.join(root,'journal.json'));at('checkpoint:after-rename');syncRoot();
   const reread=inspect();assert.deepEqual(reread,next);revision++;currentHash=newHash;
  }catch(e){throw uncertain(e);}
  return {revision,valueSha256:newHash};
 }
 function claimPreStoppedHook(expectedValueHash,expectedSnapshotHash){
  checkOwner();assert.match(expectedValueHash,/^[a-f0-9]{64}$/);assert.match(expectedSnapshotHash,/^[a-f0-9]{64}$/);
  if(hookClaimAttempted)fail('HOOK_ADOPTION_REPLAY_FORBIDDEN');
  const before=inspect(),owner=before.value?.owner;
  if(before.valueSha256!==expectedValueHash||owner?.phase!=='preflight-ok'||owner.stateUncertain===true||owner.migrationOutcome!=='COMMITTED'||
     !/^[a-f0-9]{64}$/.test(owner.workerEvidenceSha256||'')||!/^[a-f0-9]{64}$/.test(owner.commitEvidenceSha256||'')||
     !/^[a-f0-9]{64}$/.test(owner.rawReceiptSha256||'')||!/^[a-f0-9]{64}$/.test(owner.preflightEvidenceSha256||'')||owner.workerSnapshotSha256!==expectedSnapshotHash||
     hashValue(owner.workerSnapshot)!==expectedSnapshotHash)fail('HOOK_ADOPTION_EVIDENCE_INVALID');
  // Intent is durable before any stopped-slot cleanup or activation. A lost
  // write acknowledgement poisons this one-shot owner; no replay is possible.
  hookClaimAttempted=true;const next=clone(before.value);
  next.owner={...next.owner,phase:'hook-adoption-intent',hookSnapshotSha256:expectedSnapshotHash};
  checkpoint(expectedValueHash,next);
  const after=inspect();if(after.valueSha256!==hashValue(next))fail('HOOK_ADOPTION_READBACK_FAILED');
  return Object.freeze({transactionId:b.transactionId,journalValueSha256:after.valueSha256,
    workerSnapshotSha256:expectedSnapshotHash,workerSnapshot:freezeDeep(clone(owner.workerSnapshot))});
 }
 return {checkpoint,readBack:()=>inspect().value,inspect,claimPreStoppedHook};
}
function nativeSyncDir(dir){const fd=fs.openSync(dir,F.O_RDONLY|F.O_DIRECTORY|NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function createJournalForLinux({root,binding,initialState}){if(process.platform!=='linux'||process.geteuid?.()!==0)fail('LINUX_ROOT_REQUIRED');return createCore({root,binding,initialState,strict:true,syncDir:nativeSyncDir});}
// Explicit simulation API is unavailable on Linux, so it cannot disable native
// checks on the target platform. It does not claim Windows directory durability.
export function createJournalForWindowsTest(args){if(process.platform!=='win32')fail('WINDOWS_TEST_ONLY');return createCore({...args,strict:false,syncDir:()=>{}});}
export function inspectJournalReadOnly({root,binding}){
 bindingCheck(binding);root=path.resolve(root);assert.equal(path.basename(root),binding.transactionId);const strict=process.platform==='linux';parentChain(root,strict);
 const claim=readPrivate(path.join(root,'claim.json'),strict), c=parseObject(claim);assert.equal(c.schema,'zimeiti-window-claim.v1');assert.deepEqual(c.binding,binding);
 const record=parseObject(readPrivate(path.join(root,'journal.json'),strict));validateRecord(record,binding,digest(claim));return {revision:record.revision,valueSha256:record.valueSha256,value:record.value};
}

