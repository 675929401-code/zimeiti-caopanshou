// Synthetic hosted-runner fixture. No production process, database or network.
import fs from 'node:fs';import assert from 'node:assert/strict';import crypto from 'node:crypto';import readline from 'node:readline';
import {createJournalForLinux} from './journal-storage-prototype.mjs';import {hashValue} from './hook-adoption-prototype.mjs';
assert.equal(process.platform,'linux');assert.equal(process.geteuid(),0);
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),fs.readlinkSync('/proc/1/ns/net'));
assert.equal(Number(fs.statfsSync('/data').type),0x01021994,'DATA_MUST_BE_PRIVATE_TMPFS');
const [descriptorPath,digest]=process.argv.slice(2);assert.equal(descriptorPath,'/data/direct-deploy/fixture-descriptor.json');assert.match(digest,/^[a-f0-9]{64}$/);
const bytes=fs.readFileSync(descriptorPath);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),digest);const d=JSON.parse(bytes);
assert.deepEqual(Object.keys(d).sort(),['configSha','hookSha','transactionId','transactionRoot']);
assert.equal(d.transactionId,'fixture-release-0001-aaaaaaaaaaaa');assert.equal(d.transactionRoot,'/data/direct-deploy/transactions/fixture-release-0001-aaaaaaaaaaaa');
for(const h of [d.configSha,d.hookSha])assert.match(h,/^[a-f0-9]{64}$/);
const binding={transactionId:d.transactionId,bootId:'synthetic-boot',releaseId:'synthetic-release',artifactSha256:'a'.repeat(64),hookSha256:d.hookSha,configSha256:d.configSha,migrationSqlSha256:'d'.repeat(64),dbIdentity:'synthetic-db'};
const phases=['prepare','activated','precommit','persisted'];let seq=0,unknown=false,journal,current;
for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
 if(unknown)break;
 try{
  assert.ok(line.length<=4096);const r=JSON.parse(line);assert.deepEqual(Object.keys(r).sort(),['phase','seq','transactionId']);assert.equal(r.transactionId,d.transactionId);assert.equal(r.seq,seq+1);assert.equal(r.phase,phases[seq]);
  if(seq===0){current={status:'preparing',slotJournal:{phase:'initial',pendingId:null,deletedIds:[]},adoptedWindow:{snapshotDigest:'a'.repeat(64)}};journal=createJournalForLinux({root:d.transactionRoot,binding,initialState:current});}
  const next={...current,status:r.phase};journal.checkpoint(hashValue(current),next);current=next;seq++;
  process.stdout.write(JSON.stringify({ok:true,seq,phase:r.phase,transactionId:d.transactionId,revision:journal.inspect().revision})+'\n');
 }catch{unknown=true;process.stdout.write('{"ok":false,"state":"UNKNOWN"}\n');}
}
