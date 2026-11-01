// Non-production, loopback-free Linux fixture. Runs only as root under /root;
// creates only a unique temporary directory and touches no running services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createJournalForLinux,createJournalForWindowsTest,inspectJournalReadOnly} from './journal-storage-prototype.mjs';
import {hashValue} from './hook-adoption-prototype.mjs';
const initial={status:'preparing',slotJournal:{phase:'initial',pendingId:null,deletedIds:[]},adoptedWindow:{snapshotDigest:'a'.repeat(64)}};
const next={...initial,slotJournal:{phase:'delete-intent',pendingId:18,deletedIds:[]}};
const binding=id=>({transactionId:id,bootId:'synthetic-boot',releaseId:'synthetic-release',artifactSha256:'a'.repeat(64),hookSha256:'b'.repeat(64),configSha256:'c'.repeat(64),migrationSqlSha256:'d'.repeat(64),dbIdentity:'synthetic-db'});
assert.equal(process.platform,'linux');assert.equal(process.geteuid(),0);
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),fs.readlinkSync('/proc/1/ns/net'),'NETWORK_NAMESPACE_NOT_ISOLATED');assert.throws(()=>createJournalForWindowsTest({}),/WINDOWS_TEST_ONLY/);
if(process.argv[2]==='child'){
 const root=process.argv[3],b=binding(path.basename(root));const r=inspectJournalReadOnly({root,binding:b});
 assert.equal(r.revision,1);assert.throws(()=>createJournalForLinux({root,binding:b,initialState:initial}),/JOURNAL_WRITE_OUTCOME_UNKNOWN/);
 console.log(JSON.stringify({ok:true,inspectOnly:true,noTakeover:true}));process.exit(0);
}
const parent=fs.mkdtempSync('/root/zimeiti-journal-fixture-');fs.chmodSync(parent,0o700);
assert.equal(fs.realpathSync(parent),parent);assert.match(parent,/^\/root\/zimeiti-journal-fixture-[A-Za-z0-9]+$/);
try{
 const root=path.join(parent,'transaction-001'),b=binding(path.basename(root));
 const j=createJournalForLinux({root,binding:b,initialState:initial});
 for(const [p,mode] of [[parent,0o700],[root,0o700],[path.join(root,'claim.json'),0o600],[path.join(root,'journal.json'),0o600]]){
  const s=fs.lstatSync(p);assert.equal(s.uid,0);assert.equal(s.gid,0);assert.equal(s.mode&0o777,mode);assert.equal(s.isSymbolicLink(),false);
 }
 assert.throws(()=>j.checkpoint('f'.repeat(64),next),/JOURNAL_CAS_MISMATCH/);
 j.checkpoint(hashValue(initial),next);assert.deepEqual(j.readBack(),next);assert.equal(j.inspect().revision,1);
 const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'child',root],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/"noTakeover":true/);
 fs.chmodSync(root,0o755);assert.throws(()=>inspectJournalReadOnly({root,binding:b}));fs.chmodSync(root,0o700);
 fs.chmodSync(path.join(root,'journal.json'),0o644);assert.throws(()=>inspectJournalReadOnly({root,binding:b}));fs.chmodSync(path.join(root,'journal.json'),0o600);
 const link=path.join(root,'extra-hardlink');fs.linkSync(path.join(root,'claim.json'),link);assert.throws(()=>inspectJournalReadOnly({root,binding:b}));fs.unlinkSync(link);
 for(const mode of ['rename-after','directory-fsync-before','directory-fsync-after']){
  const rr=path.join(parent,`transaction-${mode}`),bb=binding(path.basename(rr)),jj=createJournalForLinux({root:rr,binding:bb,initialState:initial});
  const rename=fs.renameSync,fsync=fs.fsyncSync;let fired=false;
  try{
   fs.renameSync=function(...a){const r=rename.apply(fs,a);if(mode==='rename-after'&&!fired){fired=true;throw Error('injected-after-rename')}return r;};
   fs.fsyncSync=function(fd){const isDir=fs.fstatSync(fd).isDirectory();if(isDir&&!fired&&mode==='directory-fsync-before'){fired=true;throw Error('injected-before-dir-fsync')}const r=fsync.call(fs,fd);if(isDir&&!fired&&mode==='directory-fsync-after'){fired=true;throw Error('injected-after-dir-fsync')}return r;};
   assert.throws(()=>jj.checkpoint(hashValue(initial),next),e=>e.message==='JOURNAL_WRITE_OUTCOME_UNKNOWN'&&e.recoveryRequired);
   assert.equal(fired,true);assert.throws(()=>jj.checkpoint(hashValue(initial),next),/JOURNAL_WRITER_POISONED/);
  }finally{fs.renameSync=rename;fs.fsyncSync=fsync;}
  const observed=inspectJournalReadOnly({root:rr,binding:bb});assert.ok([0,1].includes(observed.revision));
  assert.throws(()=>createJournalForLinux({root:rr,binding:bb,initialState:initial}),/JOURNAL_WRITE_OUTCOME_UNKNOWN/);
 }
 const initRoot=path.join(parent,'transaction-init-file-fsync'),initBinding=binding(path.basename(initRoot)),fsync=fs.fsyncSync;
 try{let fired=false;fs.fsyncSync=function(fd){if(!fired&&fs.fstatSync(fd).isFile()){fired=true;throw Error('injected-file-fsync')}return fsync.call(fs,fd)};
  assert.throws(()=>createJournalForLinux({root:initRoot,binding:initBinding,initialState:initial}),e=>e.message==='JOURNAL_WRITE_OUTCOME_UNKNOWN'&&e.recoveryRequired);assert.equal(fired,true);
 }finally{fs.fsyncSync=fsync;}
 assert.throws(()=>createJournalForLinux({root:initRoot,binding:initBinding,initialState:initial}),/JOURNAL_WRITE_OUTCOME_UNKNOWN/);
 console.log(JSON.stringify({ok:true,linuxRoot:true,isolatedNetworkNamespace:true,nativeFileAndDirectoryFsync:true,realPermissions:true,cas:true,hardlinkRejected:true,restartReadOnly:true,faultCases:4,productionCalls:0,networkCalls:0}));
}finally{
 // parent is exclusively created above and its resolved absolute identity was checked.
 fs.rmSync(parent,{recursive:true,force:true});
}

