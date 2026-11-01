// Fixed Linux controller launcher using descriptor-derived paths and an
// explicitly owned process. Production authorization and parent guard are
// separate and remain closed. No business data is emitted by this module.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
import {isVerifiedWorkerFileProvider} from './fixture-brand.mjs';
const fail=x=>{throw Error(x)};const HASH=/^[a-f0-9]{64}$/;
function parents(file){for(let d=path.dirname(file);;d=path.dirname(d)){const s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('LAUNCH_PARENT_UNSAFE');if(d==='/')break;}}
function stable(a,b){return ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);}
function openTrusted(file,max){
 if(!path.isAbsolute(file)||path.resolve(file)!==file||fs.realpathSync(file)!==file)fail('LAUNCH_PATH_INVALID');parents(file);
 const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.uid!==0||(before.mode&0o022)||before.nlink!==1||before.size<1||before.size>max)fail('LAUNCH_FILE_UNSAFE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const opened=fs.fstatSync(fd);if(!stable(before,opened)){fs.closeSync(fd);fail('LAUNCH_FILE_CHANGED');}return {fd,before};
}
function recheck(file,opened){const f=fs.fstatSync(opened.fd),n=fs.lstatSync(file);if(!stable(opened.before,f)||!stable(f,n)||fs.realpathSync(file)!==file)fail('LAUNCH_FILE_CHANGED');parents(file);}
async function hashArtifact(file,expected){
 if(!HASH.test(expected))fail('LAUNCH_ARTIFACT_IDENTITY');const opened=openTrusted(file,4*1024*1024*1024),hash=crypto.createHash('sha256');let stream,timer;
 try{stream=fs.createReadStream(null,{fd:opened.fd,autoClose:false,highWaterMark:1024*1024});timer=setTimeout(()=>stream.destroy(Error('timeout')),90000);
  for await(const chunk of stream)hash.update(chunk);if(hash.digest('hex')!==expected)fail('LAUNCH_ARTIFACT_CHANGED');recheck(file,opened);
 }finally{clearTimeout(timer);try{stream?.destroy()}catch{}fs.closeSync(opened.fd);}
}
export function createPinnedControllerLauncher({fileProvider,binding,artifactPath,owner}){
 if(!isVerifiedWorkerFileProvider(fileProvider)||!owner||!['assert_live','mark_unknown'].every(k=>typeof owner[k]==='function'))fail('LAUNCH_OWNER_INVALID');
 const meta=fileProvider.launchIdentity,ctx=fileProvider.context,pid=process.pid;
 if(!meta||binding?.transactionId!==ctx.transactionId||binding?.artifactSha256!==ctx.artifactSha256||!/^\/root\//.test(artifactPath||'')||!(/\.(tar\.gz|tgz|tar\.zst)$/.test(artifactPath)))fail('LAUNCH_BINDING_INVALID');
 let used=false,child=null,invalid=false;
 const poison=()=>{if(invalid)return;invalid=true;try{if(child&&child.exitCode===null&&child.signalCode===null)child.kill()}catch{}try{Promise.resolve(owner.mark_unknown()).catch(()=>{})}catch{}};
 async function guard(){if(invalid||process.pid!==pid)fail('LAUNCH_OWNER_LOST');await owner.assert_live();await fileProvider.assertBound(binding);if(invalid||process.pid!==pid)fail('LAUNCH_OWNER_LOST');}
 async function launchOwnedController(){
  if(used||process.platform!=='linux'||process.geteuid?.()!==0)fail('LAUNCH_UNAVAILABLE');used=true;let bash;
  try{
   await guard();const script=await fileProvider.resolveControlFile(binding,'scripts/session-controller-vnext.sh'),hook=await fileProvider.resolveControlFile(binding,'transaction-hook.mjs'),ecosystem=await fileProvider.resolveControlFile(binding,'ecosystem.config.cjs');
   await guard();await hashArtifact(artifactPath,ctx.artifactSha256);await guard();
   bash=openTrusted('/usr/bin/bash',128*1024*1024);recheck('/usr/bin/bash',bash);
   const env={PATH:'/usr/bin:/bin',LC_ALL:'C',HOME:'/root',PM2_HOME:'/root/fixture-unused-pm2',DEPLOY_EXECUTION_APPROVED:meta.releaseId,
    CONTROL_PLANE_TRUSTED_VERIFIER:meta.verifierPath,CONTROL_PLANE_TRUSTED_VERIFIER_SHA256:meta.verifierSha256,CONTROL_PLANE_INSTALLATION_RECEIPT:meta.receiptPath,CONTROL_PLANE_INSTALLATION_RECEIPT_SHA256:meta.receiptSha256,
    CONTROL_PLANE_EXPECTED_DESCRIPTOR:meta.descriptorPath,CONTROL_PLANE_EXPECTED_DESCRIPTOR_SHA256:meta.descriptorSha256,RELEASE_VALIDATION_BUNDLE:meta.bundlePath,RELEASE_VALIDATION_BUNDLE_SHA256:meta.bundleSha256,
    DIRECT_HOOK_PATH:hook.path,DIRECT_HOOK_SHA256:hook.sha256,DIRECT_HOOK_PM2_CONFIG_PATH:ecosystem.path,DIRECT_HOOK_PM2_CONFIG_SHA256:ecosystem.sha256,DIRECT_TRANSACTION_ROOT:meta.transactionRoot};
   child=spawn('/proc/self/fd/5',[script.path,'--execute','--release-mode','WEB','--service','web','--artifact',artifactPath,'--sha256',ctx.artifactSha256,'--release-id',meta.releaseId,'--root','/root/fixture-unused-web'],{shell:false,stdio:['ignore','pipe','pipe','pipe','pipe',bash.fd],env,cwd:'/'});
   let outputBytes=0;for(const stream of [child.stdout,child.stderr]){stream.on('error',poison);stream.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>64*1024*1024)poison();});}
   child.on('error',poison);recheck('/usr/bin/bash',bash);await guard();if(invalid||child.exitCode!==null||child.signalCode!==null)fail('LAUNCH_CHILD_LOST');
   return child;
  }catch{poison();fail('LAUNCH_OUTCOME_UNKNOWN');}finally{if(bash){try{fs.closeSync(bash.fd);}catch{poison();fail('LAUNCH_OUTCOME_UNKNOWN');}}}
 }
 return Object.freeze({launchOwnedController,status:()=>invalid?'unknown':used?'used':'new',connectionAuthorized:false});
}
export function openProductionControllerLauncher(){fail('LAUNCH_AUTHENTICATED_ORIGIN_AND_PARENT_NOT_CONNECTED');}
