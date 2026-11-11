import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {spawn,execFileSync}from'node:child_process';
import {projectRoot,nativeRoot,nativeBasePath,nativePort,nativeIdentityPath,nativeStatePath,nativeSourceFingerprint,nativeEnvironment,assertNativePortFree}from'./native-publishing-local-utils.mjs';
const mode=process.argv[2];assert.ok(['--start','--check','--stop'].includes(mode),'EXPLICIT_NATIVE_LOCAL_ACTION_REQUIRED');
assert.equal(process.platform,'win32');assert.equal(process.version,'v24.19.0');
const server=path.join(nativeRoot,'.next/standalone/server.js');
const read=async file=>JSON.parse(await fsp.readFile(file,'utf8'));
const state=await read(nativeStatePath).catch(()=>null);
function ownedProcess(record){
  if(!record||!Number.isSafeInteger(record.pid)||record.pid<1||record.server!==server||record.executable!==process.execPath)return false;
  const quote=value=>String(value).replaceAll("'","''");
  const command=`$ErrorActionPreference='Stop';Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\CimCmdlets\\CimCmdlets.psd1');$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}';if($p -and $p.ExecutablePath -eq '${quote(process.execPath)}' -and $p.CommandLine.Replace('/','\\').ToLowerInvariant().Contains('${quote(server.toLowerCase())}')){exit 0}else{exit 5}`;
  try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:'ignore',timeout:10000});return true;}catch{return false;}
}
if(mode==='--stop'){
  if(!state){console.log(JSON.stringify({nativeStopped:true,reason:'no_registered_process'}));process.exit(0);}
  assert.ok(ownedProcess(state),'NATIVE_PROCESS_OWNER_MISMATCH');process.kill(state.pid);await fsp.unlink(nativeStatePath);console.log(JSON.stringify({nativeStopped:true,pid:state.pid}));process.exit(0);
}
const identity=await read(nativeIdentityPath),disk=(await fsp.readFile(path.join(nativeRoot,'.next/BUILD_ID'),'utf8')).trim(),source=await nativeSourceFingerprint();
assert.equal(disk,identity.buildId,'NATIVE_BUILD_ID_MISMATCH');assert.equal(source.digest,identity.sourceDigest,'NATIVE_SOURCE_STALE');
if(mode==='--start'){
  if(state&&ownedProcess(state))throw new Error('NATIVE_ALREADY_RUNNING_USE_CHECK');
  await assertNativePortFree();
  await fsp.mkdir(path.dirname(nativeStatePath),{recursive:true});const logs=path.join(projectRoot,'.logs/native-publishing');await fsp.mkdir(logs,{recursive:true});
  const out=fs.openSync(path.join(logs,'server-out.log'),'a'),err=fs.openSync(path.join(logs,'server-error.log'),'a');
  const child=spawn(process.execPath,[server],{cwd:path.dirname(server),env:nativeEnvironment(),windowsHide:true,detached:true,stdio:['ignore',out,err]});
  child.unref();fs.closeSync(out);fs.closeSync(err);
  await fsp.writeFile(nativeStatePath,JSON.stringify({pid:child.pid,server,executable:process.execPath,buildId:identity.buildId,sourceDigest:source.digest,port:nativePort,startedAt:new Date().toISOString()},null,2)+'\n');
  console.log(JSON.stringify({nativeStarted:true,pid:child.pid,port:nativePort,buildId:identity.buildId,sourceDigest:source.digest,ready:false}));process.exit(0);
}
assert.ok(ownedProcess(state),'NATIVE_PROCESS_NOT_VERIFIED');
const origin=process.argv.includes('--through-main')?'http://127.0.0.1:5000':`http://127.0.0.1:${nativePort}`;
const response=await fetch(`${origin}${nativeBasePath}/native-build-identity.json`,{cache:'no-store',signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);
const served=await response.json();assert.equal(served.buildId,disk);assert.equal(served.sourceDigest,source.digest);
console.log(JSON.stringify({runningNativeLatest:true,checkedAt:new Date().toISOString(),origin,basePath:nativeBasePath,pid:state.pid,nativeBuildId:disk,nativeSourceDigest:source.digest,nativeSourceFiles:source.files,mainRunningLatestMustBeCheckedSeparately:true}));
