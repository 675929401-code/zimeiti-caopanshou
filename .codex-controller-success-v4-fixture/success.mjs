// Fixed read-only SUCCESS verification plus fsync, for the same owned
// controller process. This is not an authenticated production factory.
import {ownsPinnedControllerChild} from './fixture-brand.mjs';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const fail=x=>{throw Error(x)};const sha=x=>crypto.createHash('sha256').update(x).digest('hex');const HEX=/^[a-f0-9]{64}$/;
const HISTORY='__FIXTURE_ROOT__/deploy-history.tsv',LOG='__FIXTURE_ROOT__';
function parents(file){for(let d=path.dirname(file);;d=path.dirname(d)){const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('SUCCESS_PARENT_UNSAFE');if(d==='/')break;}}
function same(a,b){return ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);}
function readFixed(file,limit){
 if(!path.isAbsolute(file)||path.resolve(file)!==file||fs.realpathSync(file)!==file)fail('SUCCESS_PATH_INVALID');parents(file);
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)||s.nlink!==1||s.size>limit)fail('SUCCESS_FILE_UNSAFE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd),raw=fs.readFileSync(fd),b=fs.fstatSync(fd),n=fs.lstatSync(file);if(!same(s,a)||!same(a,b)||!same(b,n)||raw.length!==a.size)fail('SUCCESS_FILE_CHANGED');return {raw,stat:a};}finally{fs.closeSync(fd);}
}
function syncFixed(file,expected){
 parents(file);const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);
 try{const a=fs.fstatSync(fd);if(!same(a,expected))fail('SUCCESS_FILE_CHANGED');fs.fsyncSync(fd);const b=fs.fstatSync(fd),n=fs.lstatSync(file);if(!same(a,b)||!same(b,n)||fs.realpathSync(file)!==file)fail('SUCCESS_FILE_CHANGED');}finally{fs.closeSync(fd);}
}
function syncDirectory(file){const before=fs.lstatSync(file);if(!before.isDirectory()||before.isSymbolicLink()||before.uid!==0||(before.mode&0o022))fail('SUCCESS_DIRECTORY_UNSAFE');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd);if(a.dev!==before.dev||a.ino!==before.ino)fail('SUCCESS_DIRECTORY_CHANGED');fs.fsyncSync(fd);const b=fs.fstatSync(fd),n=fs.lstatSync(file);if(a.dev!==b.dev||a.ino!==b.ino||b.dev!==n.dev||b.ino!==n.ino)fail('SUCCESS_DIRECTORY_CHANGED');}finally{fs.closeSync(fd);}}
export function createControllerSuccessObserver({owner,binding,releaseId,commit}){
 if(process.platform!=='linux'||process.geteuid?.()!==0||!owner||typeof owner.assert_live!=='function'||!binding||!/^([A-Za-z0-9][A-Za-z0-9._-]{7,79})-[a-f0-9]{12}$/.test(binding.transactionId||'')||!HEX.test(binding.artifactSha256||'')||!/^([A-Za-z0-9][A-Za-z0-9._-]{7,79})$/.test(releaseId||'')||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(commit||''))fail('SUCCESS_BINDING_INVALID');
 if(binding.transactionId!==releaseId+'-'+binding.artifactSha256.slice(0,12))fail('SUCCESS_BINDING_INVALID');
 const pid=process.pid;let state='new',baseline=null;
 function live(){const value=owner.assert_live();if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});fail('SUCCESS_OWNER_NOT_SYNCHRONOUS');}if(value!==undefined&&value!==true)fail('SUCCESS_OWNER_INVALID');}
 function guard(){if(process.pid!==pid||state==='unknown')fail('SUCCESS_OWNER_LOST');live();}
 function captureBefore(){if(state!=='new')fail('SUCCESS_PHASE_INVALID');state='capturing';try{guard();baseline=readFixed(HISTORY,128*1024*1024);if(baseline.raw.length&&baseline.raw.at(-1)!==10)fail('SUCCESS_HISTORY_PARTIAL_LINE');guard();state='before';}catch{state='unknown';fail('SUCCESS_OUTCOME_UNKNOWN');}}
 function verifyExit(child){
  if(state!=='before')fail('SUCCESS_PHASE_INVALID');state='verifying';
  try{
   // The launcher/channel must supply its own child, after its actual exit0
   // and EOF; this helper alone cannot authenticate a caller-created object.
   if(!ownsPinnedControllerChild(child,binding,releaseId)||child.exitCode!==0||child.signalCode!==null)fail('SUCCESS_CHILD_INVALID');
   live();const after=readFixed(HISTORY,128*1024*1024);
   if(after.stat.dev!==baseline.stat.dev||after.stat.ino!==baseline.stat.ino||after.raw.length<=baseline.raw.length||sha(after.raw.subarray(0,baseline.raw.length))!==sha(baseline.raw))fail('SUCCESS_HISTORY_CHANGED');
   const tail=after.raw.subarray(baseline.raw.length);if(tail.length>4096)fail('SUCCESS_HISTORY_INVALID');
   const line=new TextDecoder('utf8',{fatal:true}).decode(tail),parts=line.endsWith('\n')&&line.indexOf('\n')===line.length-1&&!line.includes('\r')?line.slice(0,-1).split('\t'):[];
   if(parts.length!==9||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(parts[0])||parts[1]!=='SUCCESS'||parts[2]!==releaseId||parts[3]!=='web'||parts[4]!==binding.artifactSha256||parts[5]!==commit||!(parts[6]==='-'||HEX.test(parts[6]))||!parts[7]||parts[7].length>256||/[\x00-\x1f\x7f]/.test(parts[7])||!/^preflight=[a-f0-9]{64}$/.test(parts[8]))fail('SUCCESS_HISTORY_INVALID');
   const receiptPath=path.join(LOG,'production-preflight-web-'+releaseId+'.json'),receipt=readFixed(receiptPath,2*1024*1024);
   if((receipt.stat.mode&0o777)!==0o600||'preflight='+sha(receipt.raw)!==parts[8])fail('SUCCESS_PREFLIGHT_CHANGED');
   live();syncFixed(receiptPath,receipt.stat);syncFixed(HISTORY,after.stat);syncDirectory(LOG);live();
   const check=readFixed(HISTORY,128*1024*1024),receiptCheck=readFixed(receiptPath,2*1024*1024);if(!same(check.stat,after.stat)||!check.raw.equals(after.raw))fail('SUCCESS_HISTORY_CHANGED');if(!same(receiptCheck.stat,receipt.stat)||!receiptCheck.raw.equals(receipt.raw))fail('SUCCESS_PREFLIGHT_CHANGED');
   state='complete';return Object.freeze({transactionId:binding.transactionId,outcome:'CONTROLLER_SUCCESS_DURABLE',evidenceSha256:sha(Buffer.from(JSON.stringify({transactionId:binding.transactionId,historySha256:sha(after.raw),preflightSha256:sha(receipt.raw),artifactSha256:binding.artifactSha256,commit}))),businessWrites:0});
  }catch{state='unknown';fail('SUCCESS_OUTCOME_UNKNOWN');}
 }
 return Object.freeze({captureBefore,verifyExit,status:()=>state});
}
export function openProductionSuccessObserver(){fail('SUCCESS_AUTHENTICATED_OWNER_AND_CONTROLLER_NOT_CONNECTED');}
