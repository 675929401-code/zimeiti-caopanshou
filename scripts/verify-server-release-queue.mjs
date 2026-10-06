import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform!=='linux')throw new Error('Run this release-queue regression on the Linux build host');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-queue-test-'));
const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'server-release-queue.mjs');
const run=(cmd,args,options={})=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',timeout:30000,...options});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
try{
  run('git',['init','--quiet','--initial-branch=main','repo']);
  const repo=path.join(root,'repo');
  fs.writeFileSync(path.join(repo,'package.json'),'{}');
  run('git',['-C',repo,'add','.']);
  run('git',['-C',repo,'-c','user.name=PipelineFixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','isolated fixture']);
  const commit=run('git',['-C',repo,'rev-parse','HEAD']);
  const state=path.join(root,'state');
  const driver=path.join(root,'driver.sh');fs.writeFileSync(driver,'#!/bin/bash\nexit 0\n');
  const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({repository:path.join(repo,'.git'),stateRoot:state,driver}));
  const queue=(action,input)=>run(process.execPath,[script,action,config],{input});
  const line=ref=>`${'0'.repeat(40)} ${commit} ${ref}\n`;
  queue('receive',line('refs/heads/untrusted-feature'));
  assert.equal(JSON.parse(queue('status')).length,0);
  queue('receive',line('refs/heads/codex/pipeline-rehearsal'));
  queue('receive',line('refs/heads/codex/pipeline-rehearsal'));
  queue('run');queue('run');
  let jobs=JSON.parse(queue('status'));assert.equal(jobs.length,1);assert.equal(jobs[0].attempts,1);assert.equal(jobs[0].status,'passed');
  queue('receive',line('refs/heads/main'));queue('run');
  const mainPath=path.join(state,'jobs',`${commit}-deploy.json`);const before=fs.statSync(mainPath).mtimeMs;
  queue('run');assert.equal(fs.statSync(mainPath).mtimeMs,before,'waiting state must not retrigger itself indefinitely');
  jobs=JSON.parse(queue('status'));assert.equal(jobs.find(x=>x.mode==='deploy').status,'waiting-local-acceptance');
  fs.writeFileSync(path.join(state,'.worker.lock'),'fixture');queue('run');
  console.log('PASS exact Git commit, branch filtering, durable receive, duplicate suppression, worker execution, acceptance wait, no waiting loop and worker lock');
}finally{
  const real=fs.realpathSync(root);if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith('release-queue-test-'))throw new Error('Unsafe fixture cleanup');
  fs.rmSync(real,{recursive:true,force:true});
}
