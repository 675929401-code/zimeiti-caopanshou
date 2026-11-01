// Synthetic child only; never uses a PM2 daemon, provider, or business process.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {once} from 'node:events';import {observeLinuxProcess} from './linux-proc-observer.mjs';
assert.equal(process.platform,'linux');assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),fs.readlinkSync('/proc/1/ns/net'));
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'zi-proc-fixture-')),exe=fs.realpathSync(process.execPath),bootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const c=spawn(exe,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000)'],{cwd,stdio:['ignore','pipe','pipe']});
try{
 await once(c.stdout,'data');const a=observeLinuxProcess({pid:c.pid,expectedExecutable:exe,expectedCwd:cwd,expectedBootId:bootId});const b=observeLinuxProcess({pid:c.pid,expectedExecutable:exe,expectedCwd:cwd,expectedBootId:bootId});
 assert.equal(a.pid,c.pid);assert.equal(a.startTicks,b.startTicks);assert.equal(a.pidNamespace,b.pidNamespace);assert.throws(()=>observeLinuxProcess({pid:c.pid,expectedExecutable:exe,expectedCwd:'/',expectedBootId:bootId}),/PROCESS_CWD_MISMATCH/);
 assert.throws(()=>observeLinuxProcess({pid:c.pid,expectedExecutable:exe,expectedCwd:cwd,expectedBootId:'00000000-0000-0000-0000-000000000000'}),/BOOT_ID_MISMATCH/);
 c.kill('SIGKILL');await once(c,'exit');assert.throws(()=>observeLinuxProcess({pid:c.pid,expectedExecutable:exe,expectedCwd:cwd,expectedBootId:bootId}));
 console.log(JSON.stringify({ok:true,syntheticChildOnly:true,executableCwdBootStartTicksAndNamespace:true,wrongIdentityRejected:true,exitedPidRejected:true,pm2BusAuthenticated:false,productionCalls:0}));
}finally{if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');fs.rmSync(cwd,{recursive:true,force:true});}
