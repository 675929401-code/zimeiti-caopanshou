// Read-only Linux process identity probe. This module has no CLI or mutation
// capabilities and is not connected to a production provider or deployment.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
function canonical(p){assert.equal(typeof p,'string');assert.ok(path.isAbsolute(p));const resolved=fs.realpathSync(p);assert.equal(path.resolve(p),resolved,'PROCESS_EXPECTED_PATH_NOT_CANONICAL');return resolved;}
function boot(){const id=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);return id;}
function snapshot(pid){
 const base=`/proc/${pid}`,raw=fs.readFileSync(`${base}/stat`,'utf8'),end=raw.lastIndexOf(') ');assert.ok(end>0,'PROC_STAT_INVALID');assert.equal(Number(raw.slice(0,raw.indexOf(' '))),pid);
 const fields=raw.slice(end+2).trim().split(/\s+/);assert.ok(fields.length>=20);assert.match(fields[0],/^[A-Z]$/);assert.notEqual(fields[0],'Z','PROC_ZOMBIE');assert.notEqual(fields[0],'X','PROC_DEAD');
 assert.match(fields[19],/^[0-9]+$/);const startTicks=Number(fields[19]);assert.ok(Number.isSafeInteger(startTicks)&&startTicks>0);
 const ns=fs.readlinkSync(`${base}/ns/pid`);assert.match(ns,/^pid:\[[0-9]+\]$/);
 return {pid,startTicks,pidNamespace:ns};
}
function identity(s){return {dev:String(s.dev),ino:String(s.ino)};}
export function observeLinuxProcess({pid,expectedExecutable,expectedCwd,expectedBootId}){
 assert.equal(process.platform,'linux','LINUX_ONLY');assert.ok(Number.isSafeInteger(pid)&&pid>0);const exe=canonical(expectedExecutable),cwd=canonical(expectedCwd);
 assert.equal(boot(),expectedBootId,'BOOT_ID_MISMATCH');const first=snapshot(pid),base=`/proc/${pid}`;
 const observedExe=fs.realpathSync(`${base}/exe`),observedCwd=fs.realpathSync(`${base}/cwd`);assert.equal(observedExe,exe,'PROCESS_EXECUTABLE_MISMATCH');assert.equal(observedCwd,cwd,'PROCESS_CWD_MISMATCH');
 const exeStat=fs.statSync(`${base}/exe`),cwdStat=fs.statSync(`${base}/cwd`);assert.ok(exeStat.isFile());assert.ok(cwdStat.isDirectory());
 assert.deepEqual(identity(exeStat),identity(fs.statSync(exe)),'PROCESS_EXECUTABLE_IDENTITY_DRIFT');assert.deepEqual(identity(cwdStat),identity(fs.statSync(cwd)),'PROCESS_CWD_IDENTITY_DRIFT');
 const second=snapshot(pid);assert.deepEqual(second,first,'PROCESS_IDENTITY_DRIFT');assert.equal(boot(),expectedBootId,'BOOT_ID_DRIFT');
 return Object.freeze({...first,bootId:expectedBootId,executable:exe,cwd,executableIdentity:identity(exeStat),cwdIdentity:identity(cwdStat)});
}
