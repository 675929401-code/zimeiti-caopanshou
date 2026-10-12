#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { plan,verifySource,packageBundle,verifyPackage,verifyCandidatePackage,verifyDeploymentBinding,verifyBytes,installVerified,verifyInstalled,canonical,digest,MANIFEST,ARCHIVE,POLICY_PATH,main } from './deployment-control-plane.mjs';

const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'control-plane-tests-'));
const checks=[];
const check=(name,fn)=>{fn();checks.push(name);};
const reject=(name,fn,pattern=/CONTROL_/u)=>check(name,()=>assert.throws(fn,pattern));
const write=(f,b)=>fs.writeFileSync(f,b,{mode:0o600});
const bytes=x=>Buffer.from(canonical(x)+'\n');
const rehearsal={mode:'rehearsal',sourceCommit:null,repository:null,candidateRunId:null,candidateRunAttempt:null};
const subject={mode:'formal',sourceCommit:'a'.repeat(40),repository:'fixture/repository',candidateRunId:'123',candidateRunAttempt:'1'};
const source=path.join(temp,'source');fs.mkdirSync(source);
const p=JSON.parse(fs.readFileSync(path.join(root,POLICY_PATH)));
for(const [s]of p.files){const to=path.join(source,s);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(root,s),to);}
const tree=directory=>{const out=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);out.push([path.relative(directory,f),fs.lstatSync(f).mode,e.isFile()?digest(fs.readFileSync(f)):null]);if(e.isDirectory())walk(f);}}walk(directory);return canonical(out);};
try {
  check('plan dirty/untracked source without commit, secret, DB or writes',()=>{const before=tree(source);const x=plan(source);assert.equal(x.deployable,false);assert.equal(x.core.files.length,14);assert.equal(tree(source),before);});
  check('plan filesystem mutation sentinels reject any attempted write',()=>{const methods=['writeFileSync','appendFileSync','mkdirSync','mkdtempSync','unlinkSync','rmSync','renameSync','linkSync','symlinkSync','chmodSync','chownSync','truncateSync','createWriteStream'];const saved=new Map(methods.map(n=>[n,fs[n]]));for(const n of methods)fs[n]=()=>{throw Error('PLAN_WRITE_SENTINEL:'+n);};try{assert.equal(plan(source).deployable,false);}finally{for(const[n,fn]of saved)fs[n]=fn;}});
  const out=path.join(temp,'package');let d;
  check('actual producer rehearsal -> verifier complete closure',()=>{d=packageBundle(source,out,rehearsal);assert.equal(verifyPackage(out,d).manifest.files.length,14);});
  check('reproducible content/archive across output directories',()=>{const other=packageBundle(source,path.join(temp,'package2'),rehearsal);assert.deepEqual(other,d);});
  reject('formal producer cannot infer CI trust from supplied labels',()=>packageBundle(source,path.join(temp,'invalid-formal'),subject,{}),/CONTROL_CI_IDENTITY_REQUIRED/u);
  // No real repository/index writes: the formal CI producer is exercised using
  // a private committed fixture and an explicitly mocked CI identity.
  const emptyGitConfig=path.join(temp,'empty-git-config');write(emptyGitConfig,'');
  const fixtureGit=(args,input)=>{const r=spawnSync('git',['-c',`core.hooksPath=${path.join(temp,'disabled-hooks')}`,'-c','commit.gpgsign=false','-c','user.name=fixture','-c','user.email=fixture@invalid',...args],{cwd:source,input,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:emptyGitConfig,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  fixtureGit(['init','--quiet']);fixtureGit(['add','.']);fixtureGit(['commit','--quiet','--no-gpg-sign','-m','isolated fixture']);
  const formal={...subject,sourceCommit:fixtureGit(['rev-parse','HEAD'])},ci={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:subject.repository,GITHUB_SHA:formal.sourceCommit,GITHUB_RUN_ID:subject.candidateRunId,GITHUB_RUN_ATTEMPT:subject.candidateRunAttempt};
  check('clean committed fixture formal producer positive',()=>{const o=path.join(temp,'formal-clean'),descriptor=packageBundle(source,o,formal,ci);assert.equal(verifyPackage(o,descriptor).manifest.subject.sourceCommit,formal.sourceCommit);});
  check('dirty committed fixture rejected even with matching mocked CI environment',()=>{const input=path.join(source,'scripts/normalize-legacy-runtime-vnext.mjs'),original=fs.readFileSync(input);write(input,Buffer.concat([original,Buffer.from('\n// isolated dirty fixture\n')]));try{assert.throws(()=>packageBundle(source,path.join(temp,'dirty-formal'),formal,ci),/CONTROL_FORMAL_SOURCE_DRIFT/u);assert.equal(fs.existsSync(path.join(temp,'dirty-formal')),false);}finally{write(input,original);}});
  // A real isolated merge object differs from the head checked out by PR CI.
  const initialHead=formal.sourceCommit;
  fixtureGit(['commit','--quiet','--no-gpg-sign','--allow-empty','-m','isolated PR head']);
  const prHead=fixtureGit(['rev-parse','HEAD']);
  const merge=fixtureGit(['commit-tree',fixtureGit(['rev-parse','HEAD^{tree}']),'-p',initialHead,'-p',prHead,'-m','isolated PR merge']);
  const prSubject={...formal,sourceCommit:prHead};
  const repo={full_name:subject.repository,fork:false};
  const prEvent={number:7,repository:{...repo},pull_request:{number:7,head:{sha:prHead,repo:{...repo}},base:{sha:initialHead,repo:{...repo}},merge_commit_sha:merge}};
  const eventFile=path.join(temp,'github-pr-event.json');
  const prCi={...ci,GITHUB_SHA:merge,GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/7/merge',GITHUB_EVENT_PATH:eventFile};
  function prCommand(command,label,event=prEvent,env=prCi,expected=prSubject) {
    write(eventFile,JSON.stringify(event));
    const output=path.join(temp,'pr-'+label);
    const run=spawnSync(process.execPath,[path.join(source,'scripts/deployment-control-plane.mjs'),command,'--root',source,...(command==='package'?['--output',output]:[]),'--subject',JSON.stringify(expected)],{
      cwd:source,encoding:'utf8',windowsHide:true,timeout:20000,
      env:{...process.env,...env,GIT_CONFIG_GLOBAL:emptyGitConfig,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'},
    });
    if(run.status!==0) {
      assert.equal(run.status,2,run.stderr||run.error?.message);
      const blocked=JSON.parse(run.stderr);const error=new Error(blocked.error);error.diagnostics=blocked.sourceDiagnostics;error.cliOutput=run.stdout+run.stderr;throw error;
    }
    const descriptor=JSON.parse(run.stdout);
    if(command==='verify-source'){assert.equal(descriptor.verified,true);assert.equal(fs.existsSync(output),false);return descriptor;}
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'control-plane.descriptor.json'),'utf8')),descriptor);
    return descriptor;
  }
  const prPackage=(...args)=>prCommand('package',...args);
  const prVerify=(...args)=>prCommand('verify-source',...args);
  check('actual same-repository PR head differs from merge producer positive',()=>{assert.notEqual(prHead,merge);const descriptor=prPackage('valid');assert.equal(descriptor.subject.sourceCommit,prHead);assert.equal(verifyPackage(path.join(temp,'pr-valid'),descriptor).manifest.subject.sourceCommit,prHead);assert.equal(prCi.GITHUB_SHA,merge);});
  for(const [label,field,classification]of [['null',null,'null'],['missing',undefined,'missing'],['stale',initialHead,'different'],['invalid','not-a-sha','invalid']])check('actual PR '+label+' merge field accepts proven ordered parents',()=>{
    const event=structuredClone(prEvent);if(field===undefined)delete event.pull_request.merge_commit_sha;else event.pull_request.merge_commit_sha=field;
    const before=tree(source);const verified=prVerify('verify-'+label,event);assert.equal(verified.diagnostics.mergeCommitField,classification);assert.equal(verified.diagnostics.mergeParentCountTwo,true);assert.equal(tree(source),before);
    assert.equal(prPackage('field-'+label,event).subject.sourceCommit,prHead);
  });
  check('verify-source has no filesystem writes under mutation sentinels',()=>{
    write(eventFile,JSON.stringify(prEvent));const before=tree(source),methods=['writeFileSync','appendFileSync','mkdirSync','mkdtempSync','unlinkSync','rmSync','renameSync','linkSync','symlinkSync','chmodSync','chownSync','truncateSync','createWriteStream'];
    const saved=new Map(methods.map(name=>[name,fs[name]]));for(const name of methods)fs[name]=()=>{throw Error('VERIFY_SOURCE_WRITE_SENTINEL:'+name);};
    try{assert.equal(verifySource(source,prSubject,prCi).verified,true);}finally{for(const[name,fn]of saved)fs[name]=fn;}assert.equal(tree(source),before);
  });
  for(const [label,mutate]of [
    ['wrong-event-repository',e=>e.repository.full_name='other/repository'],
    ['fork-event',e=>e.repository.fork=true],
    ['wrong-head-repository',e=>e.pull_request.head.repo.full_name='other/repository'],
    ['fork-head',e=>e.pull_request.head.repo.fork=true],
    ['wrong-base-repository',e=>e.pull_request.base.repo.full_name='other/repository'],
    ['fork-base',e=>e.pull_request.base.repo.fork=true],
    ['wrong-head',e=>e.pull_request.head.sha='b'.repeat(40)],
    ['wrong-base',e=>e.pull_request.base.sha=prHead],
    ['invalid-base',e=>e.pull_request.base.sha='not-a-sha'],
    ['invalid-head',e=>e.pull_request.head.sha='not-a-sha'],
    ['mismatched-number',e=>e.pull_request.number=8],
    ['invalid-number',e=>e.number='7'],
  ]) reject('actual PR '+label+' before package output',()=>{const event=structuredClone(prEvent);mutate(event);try{prPackage(label,event);}finally{assert.equal(fs.existsSync(path.join(temp,'pr-'+label)),false);}},/CONTROL_PR_IDENTITY_MISMATCH/u);
  for(const [label,env]of [['wrong-ref',{...prCi,GITHUB_REF:'refs/pull/8/merge'}],['head-ref-not-merge',{...prCi,GITHUB_REF:'refs/heads/main'}],['missing-event',{...prCi,GITHUB_EVENT_PATH:''}],['invalid-original-sha',{...prCi,GITHUB_SHA:'not-a-sha'}],['spoofed-original-GITHUB_SHA',{...prCi,GITHUB_SHA:prHead}],['wrong-run',{...prCi,GITHUB_RUN_ID:'999'}],['wrong-attempt',{...prCi,GITHUB_RUN_ATTEMPT:'2'}],['wrong-environment-repository',{...prCi,GITHUB_REPOSITORY:'other/repository'}],['not-github-actions',{...prCi,GITHUB_ACTIONS:'false'}]]) reject('actual PR '+label,()=>prPackage(label,prEvent,env));
  const headTree=fixtureGit(['rev-parse','HEAD^{tree}']),third=fixtureGit(['commit-tree',headTree,'-p',initialHead,'-m','isolated third parent']);
  const alternate=fixtureGit(['commit-tree',headTree,'-p',initialHead,'-p',third,'-m','isolated wrong head']);
  const reversed=fixtureGit(['commit-tree',headTree,'-p',prHead,'-p',initialHead,'-m','isolated reversed parents']);
  const multi=fixtureGit(['commit-tree',headTree,'-p',initialHead,'-p',prHead,'-p',third,'-m','isolated three parents']);
  const blob=fixtureGit(['hash-object','-w','--stdin'],'isolated blob object\n');
  for(const [label,object]of [['wrong-head-parent',alternate],['reversed-parents',reversed],['multiple-parents',multi],['tree-object',headTree],['blob-object',blob],['missing-object','0'.repeat(40)]])reject('actual CLI PR '+label+' rejected by verifier and package',()=>{
    const event=structuredClone(prEvent);event.pull_request.merge_commit_sha=object;const env={...prCi,GITHUB_SHA:object};
    assert.throws(()=>prVerify('verify-'+label,event,env),/CONTROL_PR_IDENTITY_MISMATCH/u);
    try{prPackage(label,event,env);}finally{assert.equal(fs.existsSync(path.join(temp,'pr-'+label)),false);}
  },/CONTROL_PR_IDENTITY_MISMATCH/u);
  const missingBase='f'.repeat(40),missingParentMerge=fixtureGit(['hash-object','-t','commit','-w','--stdin'],`tree ${headTree}\nparent ${missingBase}\nparent ${prHead}\nauthor fixture <fixture@invalid> 1 +0000\ncommitter fixture <fixture@invalid> 1 +0000\n\nisolated missing parent object\n`);
  const missingParentEvent=structuredClone(prEvent);missingParentEvent.pull_request.base.sha=missingBase;
  reject('actual PR referenced base object missing rejected',()=>prVerify('missing-parent-object',missingParentEvent,{...prCi,GITHUB_SHA:missingParentMerge}),/CONTROL_PR_IDENTITY_MISMATCH/u);
  const driftEvent=structuredClone(prEvent);driftEvent.pull_request.base.sha=prHead;driftEvent.pull_request.head.sha=initialHead;
  reject('actual PR checkout drift rejected',()=>prPackage('checkout-drift',driftEvent,{...prCi,GITHUB_SHA:reversed},{...prSubject,sourceCommit:initialHead}),/CONTROL_EXECUTED_HEAD_DRIFT/u);
  check('actual CLI diagnostics expose only safe booleans and merge-field enum',()=>{
    const canary='CONTROL_DIAGNOSTIC_SECRET_CANARY_7261',event=structuredClone(prEvent);event.secret=canary;event.repository.full_name=canary;event.pull_request.merge_commit_sha=canary;
    for(const command of ['verify-source','package']){
      let error;try{prCommand(command,'secret-'+command,event,{...prCi,GH_TOKEN:canary});}catch(blocked){error=blocked;}
      assert.match(error.message,/CONTROL_PR_IDENTITY_MISMATCH/u);assert.ok(!error.cliOutput.includes(canary));
      assert.equal(error.diagnostics.mergeCommitField,'invalid');for(const [key,value]of Object.entries(error.diagnostics))if(key!=='mergeCommitField')assert.equal(typeof value,'boolean');
    }
  });
  check('actual source CLI malformed subject rejects without echoing JSON input',()=>{
    const canary='MALFORMED_SUBJECT_CANARY_8419';
    for(const command of ['verify-source','package']){
      const output=path.join(temp,'malformed-'+command),run=spawnSync(process.execPath,[path.join(source,'scripts/deployment-control-plane.mjs'),command,'--root',source,...(command==='package'?['--output',output]:[]),'--subject',`{"secret":"${canary}`],{cwd:source,encoding:'utf8',windowsHide:true,env:{...process.env,...prCi}});
      assert.equal(run.status,2);assert.equal(JSON.parse(run.stderr).error,'CONTROL_SUBJECT_JSON_INVALID');assert.ok(!(run.stdout+run.stderr).includes(canary));assert.equal(fs.existsSync(output),false);
    }
  });
  check('actual PR dirty committed closure rejected',()=>{const input=path.join(source,'scripts/normalize-legacy-runtime-vnext.mjs'),original=fs.readFileSync(input);write(input,Buffer.concat([original,Buffer.from('\n// dirty PR closure\n')]));try{assert.throws(()=>prPackage('dirty'),/CONTROL_FORMAL_SOURCE_DRIFT/u);assert.equal(fs.existsSync(path.join(temp,'pr-dirty')),false);}finally{write(input,original);}});
  for(const eventName of ['push','workflow_dispatch']) {
    reject('non-PR '+eventName+' still requires original SHA equal head',()=>prPackage('strict-'+eventName,prEvent,{...prCi,GITHUB_EVENT_NAME:eventName,GITHUB_REF:'refs/heads/main'}),/CONTROL_CI_IDENTITY_REQUIRED/u);
    check('non-PR '+eventName+' matching SHA unchanged positive',()=>{const d=prPackage('positive-'+eventName,prEvent,{...prCi,GITHUB_EVENT_NAME:eventName,GITHUB_SHA:prHead,GITHUB_REF:'refs/heads/main'});assert.equal(d.subject.sourceCommit,prHead);});
  }
  reject('package cannot write into source',()=>packageBundle(source,path.join(source,'output'),rehearsal));
  reject('same output cannot overwrite',()=>packageBundle(source,out,rehearsal));
  const ma=fs.readFileSync(path.join(out,MANIFEST)),ar=fs.readFileSync(path.join(out,ARCHIVE));
  const manifest=JSON.parse(ma),archive=JSON.parse(ar);
  function attack(mutator){let m=structuredClone(manifest),a=structuredClone(archive);mutator(m,a);const {subject:_,contentDigest:__,...core}=m;m.contentDigest=digest(bytes(core));const mb=bytes(m);a.manifestBase64=mb.toString('base64');const ab=bytes(a);return ()=>verifyBytes(ab,mb,{...d,manifestSha256:digest(mb),archiveSha256:digest(ab),contentDigest:m.contentDigest,subject:m.subject});}
  reject('externally expected manifest hash rejects entrypointnew manifestold',()=>verifyBytes(ar,Buffer.concat([ma,Buffer.from(' ')]),d));
  reject('externally expected archive rejects altered bytes',()=>verifyBytes(Buffer.concat([ar,Buffer.from(' ')]),ma,d));
  reject('wrong expected repo/run/head/attempt rejected',()=>verifyBytes(ar,ma,{...d,subject}));
  reject('unknown manifest fields',attack(m=>m.extra=true));
  reject('wrong project',attack(m=>m.projectId='other'));
  reject('wrong layout',attack(m=>m.layoutVersion=2));
  reject('unsupported schema',attack(m=>m.schemaVersion=2));
  reject('wrong executable entrypoint',attack(m=>m.entrypoint='transaction-hook.mjs'));
  reject('missing contract',attack((m,a)=>{const i=m.files.findIndex(e=>e.path.endsWith('database-contract.v1.json'));m.files.splice(i,1);a.entries.splice(i,1);}));
  reject('extra file',attack((m,a)=>{m.files.push({...m.files[0],path:'z-extra'});a.entries.push({...a.entries[0],path:'z-extra'});}));
  reject('duplicate path',attack((m,a)=>{m.files[1]=m.files[0];a.entries[1]=a.entries[0];}));
  reject('case collision',attack((m,a)=>{m.files[1]={...m.files[0],path:m.files[0].path.toUpperCase()};a.entries[1]={...a.entries[0],path:m.files[1].path};}));
  for(const value of ['../escape','/absolute','a/../escape','a\\evil','a//evil','é'])reject('unsafe path '+value,attack((m,a)=>{m.files[0].path=value;a.entries[0].path=value;}));
  reject('symlink entry field',attack((m,a)=>a.entries[0].link='escape'));
  reject('hardlink/device type field',attack((m,a)=>a.entries[0].type='hardlink'));
  reject('unsafe mode',attack((m,a)=>{m.files[0].mode='0777';a.entries[0].mode='0777';}));
  reject('normalizer old bytes against current manifest',attack((m,a)=>{const i=a.entries.findIndex(e=>e.path==='normalize-legacy-runtime-vnext.mjs');a.entries[i].base64=Buffer.from('old normalizer').toString('base64');}));
  reject('noncanonical base64',attack((m,a)=>a.entries[0].base64+='\n'));
  reject('decoded length wrong',attack((m,a)=>{m.files[0].bytes++;a.entries[0].bytes++;}));
  reject('entry count hard limit',attack((m,a)=>{m.files=Array(33).fill(m.files[0]);a.entries=Array(33).fill(a.entries[0]);}));
  reject('single entry size hard limit',attack((m,a)=>{m.files[0].bytes=2097153;a.entries[0].bytes=2097153;}));
  reject('decoded aggregate byte limit',attack((m,a)=>{for(let i=0;i<9;i++){const b=Buffer.alloc(1000000,97);m.files[i].bytes=b.length;m.files[i].sha256=digest(b);a.entries[i]={...m.files[i],base64:b.toString('base64')};}}),/CONTROL_TOTAL_SIZE_LIMIT/u);
  reject('archive size hard limit',()=>verifyBytes(Buffer.alloc(12582913),ma,{...d,archiveSha256:digest(Buffer.alloc(12582913))}));
  reject('duplicate JSON keys/noncanonical bytes',()=>{const ab=Buffer.from(ar.toString().replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'));return verifyBytes(ab,ma,{...d,archiveSha256:digest(ab)});});
  reject('unknown CLI option fails closed',()=>main(['plan','--root',source,'--secret','anything']));
  check('actual source hardlink rejected',()=>{const input=path.join(source,p.files[0][0]),link=path.join(temp,'source-hardlink');fs.linkSync(input,link);try{assert.throws(()=>plan(source),/CONTROL_FILE_METADATA_INVALID/u);}finally{fs.unlinkSync(link);}});
  check('unlisted local import fails closure before package writes',()=>{const input=path.join(source,'scripts/deployment-control-plane.mjs'),original=fs.readFileSync(input);write(input,Buffer.concat([original,Buffer.from("\nimport './not-in-closure.mjs';\n")]));try{assert.throws(()=>plan(source),/CONTROL_DEPENDENCY_NOT_IN_CLOSURE/u);}finally{write(input,original);}});
  check('normalizer supply never executes payload code',()=>{const input=path.join(source,'scripts/normalize-legacy-runtime-vnext.mjs'),original=fs.readFileSync(input),canary=path.join(temp,'NORMALIZER_EXECUTED');write(input,Buffer.concat([original,Buffer.from(`\nfs.writeFileSync(${JSON.stringify(canary)},'executed');\n`)]));try{const o=path.join(temp,'poison-normalizer');const descriptor=packageBundle(source,o,rehearsal);verifyPackage(o,descriptor);assert.equal(fs.existsSync(canary),false);}finally{write(input,original);}});
  // Formal identities here are synthetic fixture data, never a CI provenance claim.
  const fm={...manifest,subject},mb=bytes(fm),fa={...archive,manifestBase64:mb.toString('base64')},ab=bytes(fa),fd={...d,subject,manifestSha256:digest(mb),archiveSha256:digest(ab)};
  const verified=verifyBytes(ab,mb,fd),parent=path.join(temp,'installed'),receipts=path.join(temp,'receipts');fs.mkdirSync(parent);fs.mkdirSync(receipts);
  const rp=path.join(receipts,'installation.json'),verifier=digest(fs.readFileSync(path.join(root,'scripts/deployment-control-plane.mjs')));
  reject('rehearsal never installable',()=>installVerified(verifyPackage(out,d),parent,rp,verifier,{requireRoot:false}));
  check('install plan zero writes/locks with verified subject',()=>{const before=tree(temp);assert.equal(installVerified(verified,parent,rp,verifier,{requireRoot:false}).status,'plan-no-writes');assert.equal(tree(temp),before);});
  let installed;
  check('actual installer fixture seals complete bytes without invoking hook/normalizer',()=>{installed=installVerified(verified,parent,rp,verifier,{execute:true,requireRoot:false});assert.equal(installed.status,'installed');verifyInstalled(installed.directory,JSON.parse(fs.readFileSync(rp)),fd,{requireRoot:false});});
  check('same identity exact bytes idempotent',()=>assert.equal(installVerified(verified,parent,rp,verifier,{execute:true,requireRoot:false}).status,'already-installed'));
  const nf=path.join(installed.directory,'normalize-legacy-runtime-vnext.mjs');fs.chmodSync(nf,0o600);const previous=fs.readFileSync(nf);write(nf,'old normalizer');
  reject('same ID mismatch refuses overwrite',()=>installVerified(verified,parent,rp,verifier,{execute:true,requireRoot:false}));assert.equal(fs.readFileSync(nf,'utf8'),'old normalizer');write(nf,previous);fs.chmodSync(nf,0o555);
  fs.chmodSync(installed.directory,0o700);
  const extra=path.join(installed.directory,'extra');write(extra,'x');reject('installed extra file',()=>verifyInstalled(installed.directory,JSON.parse(fs.readFileSync(rp)),fd,{requireRoot:false}),/CONTROL_INSTALLED_INVENTORY/u);fs.unlinkSync(extra);
  const r=JSON.parse(fs.readFileSync(rp));
  fs.mkdirSync(path.join(installed.directory,'unexpected'));reject('installed empty extra directory',()=>verifyInstalled(installed.directory,r,fd,{requireRoot:false}));fs.rmdirSync(path.join(installed.directory,'unexpected'));
  const parent2=path.join(temp,'interrupted');fs.mkdirSync(parent2);const rp2=path.join(receipts,'interrupted.json');
  check('rename complete receipt ACK loss truthful and read-only recoverable',()=>{let err;try{installVerified(verified,parent2,rp2,verifier,{execute:true,requireRoot:false,afterRename:()=>{throw new Error('SIMULATED_ACK_LOSS');}});}catch(e){err=e;}assert.equal(err.controlInstallState,'installed-unrecorded');assert.equal(fs.existsSync(rp2),false);assert.equal(installVerified(verified,parent2,rp2,verifier,{requireRoot:false}).status,'installed-unrecorded');assert.equal(installVerified(verified,parent2,rp2,verifier,{execute:true,requireRoot:false}).status,'installed');});
  reject('verifier digest missing before any write',()=>installVerified(verified,parent,rp,'invalid',{execute:true,requireRoot:false}));
  check('interrupted stage retained without activation or receipt',()=>{const px=path.join(temp,'stage-interruption');fs.mkdirSync(px);const rx=path.join(receipts,'stage-interruption.json');const original=fs.writeFileSync;let error;fs.writeFileSync=function(file,...args){if(String(file).includes('.control-stage-'))throw new Error('SIMULATED_STAGE_INTERRUPTION');return original.call(fs,file,...args);};try{installVerified(verified,px,rx,verifier,{execute:true,requireRoot:false});}catch(e){error=e;}finally{fs.writeFileSync=original;}assert.equal(error.controlInstallState,'staging-retained');assert.equal(fs.existsSync(rx),false);assert.equal(fs.existsSync(path.join(px,`V1.0-${fd.manifestSha256.slice(0,12)}`)),false);assert.ok(fs.existsSync(error.operationStage));});
  check('changed already-verified object rejected before any install write',()=>{const v=structuredClone(verified);v.entries[0].path='../escape';const before=tree(parent);assert.throws(()=>installVerified(v,parent,rp,verifier,{execute:true,requireRoot:false}),/CONTROL_/u);assert.equal(tree(parent),before);});
  check('same content different candidate attempt coexist and each replay idempotent',()=>{const otherManifest={...fm,subject:{...subject,candidateRunAttempt:'2'}},otherMb=bytes(otherManifest),otherAb=bytes({...fa,manifestBase64:otherMb.toString('base64')}),otherD={...fd,subject:otherManifest.subject,manifestSha256:digest(otherMb),archiveSha256:digest(otherAb)};assert.equal(otherD.contentDigest,fd.contentDigest);const v=verifyBytes(otherAb,otherMb,otherD),rr=path.join(receipts,'attempt2.json'),second=installVerified(v,parent,rr,verifier,{execute:true,requireRoot:false});assert.notEqual(second.directory,installed.directory);assert.equal(installVerified(v,parent,rr,verifier,{execute:true,requireRoot:false}).status,'already-installed');assert.equal(installVerified(verified,parent,rp,verifier,{execute:true,requireRoot:false}).status,'already-installed');});
  // Original shell bootstrap gate executed in an isolated harness; Unix ownership
  // checks are fixture stubs on Windows, while external hash gate is the real shell.
  const deploy=fs.readFileSync(path.join(root,'scripts/deploy-artifact-vnext.sh'),'utf8');
  const gate=deploy.slice(deploy.indexOf('# Bootstrap authority'),deploy.indexOf('ASSET_POLICY_TRANSITION_VERIFIER="$CONTROL_PLANE_ROOT'));
  const gits=process.platform==='win32'?(spawnSync('where.exe',['git'],{encoding:'utf8'}).stdout||'').trim().split(/\r?\n/u).filter(Boolean):[];
  const bash=process.platform==='win32'?[
    ...gits.flatMap(git=>[path.resolve(path.dirname(git),'../bin/bash.exe'),path.resolve(path.dirname(git),'../usr/bin/bash.exe')]),
    ...(process.env.PATH||'').split(path.delimiter).flatMap(p=>[path.join(p,'bash.exe'),path.resolve(p,'../bin/bash.exe'),path.resolve(p,'../usr/bin/bash.exe')]),
  ].find(p=>fs.existsSync(p)):'bash';
  assert.ok(process.platform!=='win32'||fs.existsSync(bash),'Git Bash required for actual early gate test');
  const unix=f=>process.platform==='win32'?f.replace(/\\/gu,'/').replace(/^([A-Za-z]):/u,(_,d)=>'/'+d.toLowerCase()):f;
  const sentinel=path.join(temp,'payload-executed');const evil=path.join(temp,'untrusted.mjs');write(evil,`require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed')`);
  const harness=path.join(temp,'early-gate.sh');
  write(harness,`#!/usr/bin/env bash\nset -euo pipefail\ndie(){ echo "BLOCKED:$*" >&2; exit 2; }\nrequire_trusted_root_executable(){ [[ -f "$1" && ! -L "$1" ]] || die badfile; }\nstat(){ case "$2" in '%u:%g') echo 0:0;; '%u:%g:%h') echo 0:0:1;; '%a') echo 755;; *) command stat "$@";; esac; }\nSERVICE=web\nCONTROL_PLANE_ROOT='${unix(installed.directory)}'\nDEPLOY_NODE_BIN='${unix(process.execPath)}'\n${gate}\nprintf 'SECRET_READ_SENTINEL\\n'\n`);
  check('actual controller bootstrap wrong verifier digest before payload/secret',()=>{const x=spawnSync(bash,[unix(harness)],{encoding:'utf8',env:{...process.env,CONTROL_PLANE_TRUSTED_VERIFIER:unix(evil),CONTROL_PLANE_TRUSTED_VERIFIER_SHA256:'0'.repeat(64),CONTROL_PLANE_INSTALLATION_RECEIPT:unix(rp),CONTROL_PLANE_INSTALLATION_RECEIPT_SHA256:digest(fs.readFileSync(rp)),CONTROL_PLANE_EXPECTED_DESCRIPTOR:unix(path.join(out,'control-plane.descriptor.json')),CONTROL_PLANE_EXPECTED_DESCRIPTOR_SHA256:digest(fs.readFileSync(path.join(out,'control-plane.descriptor.json')))}});assert.notEqual(x.status,0);assert.match(x.stderr,/bootstrap verifier digest mismatch/u);assert.ok(!x.stdout.includes('SECRET_READ'));assert.equal(fs.existsSync(sentinel),false);});
  // External verifier shim is explicitly fixture-owned. It uses the real
  // installed-tree core, substituting only unsupported Windows root metadata.
  const trusted=path.join(temp,'trusted-fixture-verifier.mjs'),dp=path.join(receipts,'expected-descriptor.json');write(dp,bytes(fd));
  write(trusted,`import fs from 'node:fs';import {verifyInstalled,digest} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/deployment-control-plane.mjs')).href)};const a=new Map();for(let i=3;i<process.argv.length;i+=2)a.set(process.argv[i],process.argv[i+1]);const r=fs.readFileSync(a.get('--receipt'));if(digest(r)!==a.get('--receipt-sha256'))throw Error('RECEIPT_DIGEST');verifyInstalled(a.get('--installed-root'),JSON.parse(r),JSON.parse(fs.readFileSync(a.get('--expected-descriptor'))),{requireRoot:false});`);
  const shellEnv={...process.env,CONTROL_PLANE_TRUSTED_VERIFIER:unix(trusted),CONTROL_PLANE_TRUSTED_VERIFIER_SHA256:digest(fs.readFileSync(trusted)),CONTROL_PLANE_INSTALLATION_RECEIPT:unix(rp),CONTROL_PLANE_INSTALLATION_RECEIPT_SHA256:digest(fs.readFileSync(rp)),CONTROL_PLANE_EXPECTED_DESCRIPTOR:unix(dp),CONTROL_PLANE_EXPECTED_DESCRIPTOR_SHA256:digest(fs.readFileSync(dp)),DIRECT_HOOK_PATH:unix(path.join(installed.directory,'transaction-hook.mjs')),DIRECT_HOOK_PM2_CONFIG_PATH:unix(path.join(installed.directory,'ecosystem.config.cjs'))};
  check('actual controller complete fixture gate reaches secret sentinel only after full bytes',()=>{const x=spawnSync(bash,[unix(harness)],{encoding:'utf8',env:shellEnv});assert.equal(x.status,0,x.stderr);assert.ok(x.stdout.includes('SECRET_READ_SENTINEL'));});
  check('actual controller changed dependency rejected before secret',()=>{fs.chmodSync(nf,0o600);write(nf,'old normalizer');try{const x=spawnSync(bash,[unix(harness)],{encoding:'utf8',env:shellEnv});assert.notEqual(x.status,0);assert.ok(!x.stdout.includes('SECRET_READ'));assert.match(x.stderr,/CONTROL_INSTALLED_BYTES_MISMATCH/u);}finally{write(nf,previous);fs.chmodSync(nf,0o555);}});
  check('actual controller cross-bundle hook rejected before secret',()=>{const x=spawnSync(bash,[unix(harness)],{encoding:'utf8',env:{...shellEnv,DIRECT_HOOK_PATH:'/data/direct-deploy/bin/V1.0-000000000000/transaction-hook.mjs'}});assert.notEqual(x.status,0);assert.ok(!x.stdout.includes('SECRET_READ'));assert.match(x.stderr,/must belong to this verified control-plane bundle/u);});
  // Actual runner pre-signing statements, actual package verifier, key-access spy.
  const runner=fs.readFileSync(path.join(root,'scripts/run-release-browser-acceptance.mjs'),'utf8');
  const pre=runner.slice(runner.indexOf('  const bundle = readJson(path.join(candidateRoot'),runner.indexOf('  const workRoot = requireFreshDirectory'));
  const keyStatement=runner.match(/  const privateKeyPem = process\.env\[secretName\];/u)[0];
  const candidateDir=path.join(temp,'candidate');fs.mkdirSync(path.join(candidateDir,'candidate-packages'),{recursive:true});fs.cpSync(out,path.join(candidateDir,'candidate-packages','control-plane'),{recursive:true});write(path.join(candidateDir,'candidate-packages','control-plane',MANIFEST),mb);write(path.join(candidateDir,'candidate-packages','control-plane',ARCHIVE),ab);
  const api={id:123,run_attempt:1,head_sha:subject.sourceCommit,repository:{full_name:subject.repository}};
  function signingProbe(descriptor,run){let keyReads=0;const env={GITHUB_REPOSITORY:subject.repository};Object.defineProperty(env,'PRIVATE',{get(){keyReads++;return 'RAM_ONLY_TEST_KEY';}});const context={path,candidateRoot:candidateDir,candidateRun:run,process:{env},secretName:'PRIVATE',readJson:()=>({subject:{controlPlane:descriptor}}),verifyCandidatePackage};try{vm.runInNewContext(pre+keyStatement,context);return {keyReads};}catch(error){return {keyReads,error};}}
  check('actual candidate archive verified before key read',()=>assert.deepEqual(signingProbe(fd,api),{keyReads:1}));
  for(const [field,value]of [['id',124],['run_attempt',2],['head_sha','b'.repeat(40)],['repository',{full_name:'other/repo'}]])check('candidate API '+field+' mismatch before private key',()=>{const x=signingProbe(fd,{...api,[field]:value});assert.equal(x.keyReads,0);assert.match(x.error.message,/CONTROL_CANDIDATE_API_IDENTITY_MISMATCH/u);});
  check('candidate descriptor replacement before private key',()=>{const x=signingProbe({...fd,archiveSha256:'0'.repeat(64)},api);assert.equal(x.keyReads,0);assert.match(x.error.message,/CONTROL_EXTERNAL_DIGEST_MISMATCH/u);});
  check('missing descriptor before private key',()=>{const x=signingProbe(undefined,api);assert.equal(x.keyReads,0);assert.ok(x.error);});
  check('hook and config private sealed modes meet actual old metadata predicate',()=>{const hooks=manifest.files.filter(f=>['transaction-hook.mjs','ecosystem.config.cjs'].includes(f.path));assert.equal(hooks.length,2);for(const f of hooks){const mode=parseInt(f.mode,8);assert.equal(mode&0o077,0);assert.equal(mode&0o222,0);}assert.ok(deploy.includes('(s.mode&0o077)'));assert.ok(deploy.includes('(c.mode&0o077)'));});
  const binding={service:'web',archiveSha256:'d'.repeat(64),releaseId:'fixture-release-123',commit:subject.sourceCommit,sourceVersion:'RTEST',buildId:'fixture-build',buildOutputDigest:'c'.repeat(64)};
  const required=['credential-scan','source-integrity','diff-check','build','build-identity','desktop-precise-route-visual-1440x900','desktop-two-adjacent-pages-visual','console-and-request-errors'];
  const ready={schemaVersion:'zimeiti-release-change-validation-bundle.v1',bundleId:'',scope:{receiptId:'scope-'+ 'a'.repeat(24),receiptSha256:'a'.repeat(64),classification:'FULL',input:{kind:'git-range',base:'b'.repeat(40),head:binding.commit,rangeMode:'direct',trustedBase:true},browserAcceptance:{preciseRoute:'/image-workbench',requiredRoutes:['/cover','/image-workbench','/video'],routeRuleIds:['fixture'],explicitRoutesRequired:false,explicitRoutesProvided:false,unresolvedPaths:[]},requiredValidations:required},subject:{commit:binding.commit,sourceVersion:binding.sourceVersion,services:['web'],builds:{web:binding.buildId,voice:null},buildOutputDigests:{web:binding.buildOutputDigest,voice:null},candidatePayloads:{web:{releaseId:binding.releaseId,archiveSha256:binding.archiveSha256,artifactDigest:'e'.repeat(64),fileCount:3,totalBytes:1000},voice:null},controlPlane:fd},target:'release-ready',status:'release-ready',attestations:required.map((validationId,i)=>({validationId,status:'passed',executor:i<5?'ci':'external-browser',evidenceRef:'evidence/'+i+'.json',evidenceSha256:'a'.repeat(64),signatureRef:i<5?null:'evidence/'+i+'.sig.json',signatureSha256:i<5?null:'b'.repeat(64)})),summary:{requiredCount:8,passedCount:8,pendingCount:0,failedCount:0}};
  const readyBytes=b=>{const {bundleId,...core}=b;b.bundleId='validation-'+digest(Buffer.from(canonical(core))).slice(0,24);return bytes(b);};
  const rb=readyBytes(ready);check('actual release-ready JSON pairs exact business archive and installed descriptor',()=>assert.equal(verifyDeploymentBinding(rb,digest(rb),fd,binding).verified,true));
  reject('old valid control bundle with new business artifact rejected',()=>verifyDeploymentBinding(rb,digest(rb),fd,{...binding,archiveSha256:'e'.repeat(64)}));
  reject('release binding wrong requested service',()=>verifyDeploymentBinding(rb,digest(rb),fd,{...binding,service:'voice'}));
  reject('untrusted release-ready JSON SHA rejected',()=>verifyDeploymentBinding(rb,'0'.repeat(64),fd,binding));
  for(const [name,mutate]of [
    ['unknown root field',b=>b.command='x'],['unknown subject field',b=>b.subject.extra='x'],['unknown scope field',b=>b.scope.extra='x'],['unknown artifact field',b=>b.subject.candidatePayloads.web.extra='x'],['pending status',b=>b.status='pending-required'],['wrong target',b=>b.target='source-candidate'],['wrong descriptor attempt',b=>b.subject.controlPlane.subject.candidateRunAttempt='2'],['missing control descriptor',b=>delete b.subject.controlPlane],['wrong archive',b=>b.subject.candidatePayloads.web.archiveSha256='0'.repeat(64)],['wrong releaseId',b=>b.subject.candidatePayloads.web.releaseId='other-release'],['wrong commit',b=>b.subject.commit='b'.repeat(40)],['wrong build',b=>b.subject.builds.web='other'],['wrong output digest',b=>b.subject.buildOutputDigests.web='b'.repeat(64)],['failed attestation',b=>b.attestations[0].status='failed'],['summary drift',b=>b.summary.failedCount=1],['untrusted base',b=>b.scope.input.trustedBase=false],
  ])reject('release binding '+name,()=>{const b=structuredClone(ready);mutate(b);const bb=readyBytes(b);return verifyDeploymentBinding(bb,digest(bb),fd,binding);});
  const bindingPrefix=deploy.slice(deploy.indexOf('# The external release-ready JSON'),deploy.indexOf('ASSET_DIGEST=""',deploy.indexOf('# The external release-ready JSON')));
  const bindingFile=path.join(receipts,'release-ready.json'),bindingHarness=path.join(temp,'release-binding-gate.sh');write(bindingFile,rb);
  const bindingVerifier=path.join(temp,'binding-verifier.mjs');write(bindingVerifier,`import fs from 'node:fs';import {verifyDeploymentBinding} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/deployment-control-plane.mjs')).href)};const a=new Map();for(let i=3;i<process.argv.length;i+=2)a.set(process.argv[i],process.argv[i+1]);verifyDeploymentBinding(fs.readFileSync(a.get('--release-validation-bundle')),a.get('--release-validation-sha256'),JSON.parse(fs.readFileSync(a.get('--expected-descriptor'))),{service:a.get('--service'),archiveSha256:a.get('--artifact-sha256'),releaseId:a.get('--release-id'),commit:a.get('--commit'),sourceVersion:a.get('--source-version'),buildId:a.get('--build-id'),buildOutputDigest:a.get('--build-output-digest')});`);
  write(bindingHarness,`#!/usr/bin/env bash\nset -euo pipefail\ndie(){ echo "BLOCKED:$*" >&2; exit 2; }\nrequire_trusted_controller_file(){ [[ -f "$1" && ! -L "$1" ]] || die badfile; }\nCONTROL_PLANE_ROOT='${unix(installed.directory)}'\nDEPLOY_NODE_BIN='${unix(process.execPath)}'\nSERVICE=web\nRELEASE_ID='${binding.releaseId}'\nCOMMIT_SHA='${binding.commit}'\nSOURCE_VERSION='${binding.sourceVersion}'\nBUILD_ID='${binding.buildId}'\nBUILD_OUTPUT_DIGEST='${binding.buildOutputDigest}'\n${bindingPrefix}\nprintf 'SECRET_READ_SENTINEL\\n'\n`);
  const bindEnv={...process.env,CONTROL_PLANE_TRUSTED_VERIFIER:unix(bindingVerifier),CONTROL_PLANE_TRUSTED_VERIFIER_SHA256:digest(fs.readFileSync(bindingVerifier)),CONTROL_PLANE_EXPECTED_DESCRIPTOR:unix(dp),CONTROL_PLANE_EXPECTED_DESCRIPTOR_SHA256:digest(fs.readFileSync(dp)),RELEASE_VALIDATION_BUNDLE:unix(bindingFile),RELEASE_VALIDATION_BUNDLE_SHA256:digest(rb),ACTUAL_SHA256:binding.archiveSha256};
  check('actual controller release binding before secret positive',()=>{const x=spawnSync(bash,[unix(bindingHarness)],{encoding:'utf8',env:bindEnv});assert.equal(x.status,0,x.stderr);assert.ok(x.stdout.includes('SECRET_READ_SENTINEL'));});
  for(const [name,changes]of [['archive mismatch',{ACTUAL_SHA256:'a'.repeat(64)}],['untrusted external SHA',{RELEASE_VALIDATION_BUNDLE_SHA256:'0'.repeat(64)}]])check('actual controller '+name+' before secret',()=>{const x=spawnSync(bash,[unix(bindingHarness)],{encoding:'utf8',env:{...bindEnv,...changes}});assert.notEqual(x.status,0);assert.ok(!x.stdout.includes('SECRET_READ'));});
  check('actual controller unknown finalized fields before secret',()=>{const b=structuredClone(ready);b.extra=true;const bad=readyBytes(b);write(bindingFile,bad);try{const x=spawnSync(bash,[unix(bindingHarness)],{encoding:'utf8',env:{...bindEnv,RELEASE_VALIDATION_BUNDLE_SHA256:digest(bad)}});assert.notEqual(x.status,0);assert.ok(!x.stdout.includes('SECRET_READ'));assert.match(x.stderr,/CONTROL_RELEASE_BUNDLE_FIELDS/u);}finally{write(bindingFile,rb);}});
  for(const [name,mutate]of [['pending status',b=>b.status='pending-required'],['same commit different attempt',b=>b.subject.controlPlane.subject.candidateRunAttempt='2']])check('actual controller '+name+' before secret',()=>{const b=structuredClone(ready);mutate(b);const bad=readyBytes(b);write(bindingFile,bad);try{const x=spawnSync(bash,[unix(bindingHarness)],{encoding:'utf8',env:{...bindEnv,RELEASE_VALIDATION_BUNDLE_SHA256:digest(bad)}});assert.notEqual(x.status,0);assert.ok(!x.stdout.includes('SECRET_READ'));}finally{write(bindingFile,rb);}});
  const compatibility=deploy.slice(deploy.indexOf('validate_asset_forward_compatibility() {'),deploy.indexOf('\ncapture_data_snapshot() {'));
  const location=compatibility.slice(compatibility.indexOf('    [[ "$receipt_real" =~'),compatibility.indexOf('    actual_receipt_sha='));
  const locationHarness=path.join(temp,'asset-receipt-location.sh');write(locationHarness,`#!/usr/bin/env bash\nset -euo pipefail\ndie(){ exit 2; }\nCONTROL_PLANE_ROOT=/data/direct-deploy/bin/V1.0-123456789abc\nreceipt_real="$1"\n${location}\n`);
  check('asset transition receipt valid external location accepted',()=>assert.equal(spawnSync(bash,[unix(locationHarness),'/data/direct-deploy/incoming/run-123/control/receipts/policy.json']).status,0));
  for(const bad of ['/data/direct-deploy/bin/V1.0-123456789abc/receipts/policy.json','/tmp/policy.json','/data/direct-deploy/incoming/run-123/control/receipts/../escape.json'])check('asset transition invalid location '+bad,()=>assert.notEqual(spawnSync(bash,[unix(locationHarness),bad]).status,0));
  check('CI one producer and exact candidate bytes promoted with signed descriptor',()=>{const ci=fs.readFileSync(path.join(root,'.github/workflows/release-vnext.yml'),'utf8');assert.equal((ci.match(/deployment-control-plane\.mjs package /gu)||[]).length,1);assert.ok(ci.includes('candidate-packages/control-plane'));const end=ci.slice(ci.indexOf('Validate candidate and browser-evidence'));assert.ok(end.includes('cp -R "$RUNNER_TEMP/candidate/candidate-packages/control-plane"'));assert.ok(!end.includes('deployment-control-plane.mjs package'));const browser=fs.readFileSync(path.join(root,'scripts/run-release-browser-acceptance.mjs'),'utf8');assert.ok(browser.includes('controlPlane: bundle.subject.controlPlane'));});
  check('actual workflow subject uses verified head while original GitHub SHA remains merge',()=>{
    const workflow=fs.readFileSync(path.join(root,'.github/workflows/release-vnext.yml'),'utf8');
    const packageLine=workflow.split('\n').find(line=>line.includes('deployment-control-plane.mjs package '));
    const expression=packageLine.match(/node -e '([^']+)'/u)?.[1];assert.ok(expression);
    const run=spawnSync(process.execPath,['-e',expression],{encoding:'utf8',env:{GITHUB_SHA:merge,RELEASE_HEAD_SHA:prHead,GITHUB_REPOSITORY:subject.repository,GITHUB_RUN_ID:subject.candidateRunId,GITHUB_RUN_ATTEMPT:subject.candidateRunAttempt}});
    assert.equal(run.status,0);assert.deepEqual(JSON.parse(run.stdout),prSubject);
    const upload=workflow.slice(workflow.indexOf('- name: Upload exact output and pending-required bundle'),workflow.indexOf('- name: Validate candidate and browser-evidence'));
    assert.ok(upload.includes('name: release-candidate-${{ steps.resolve.outputs.subject_sha }}'));
    assert.ok(!upload.includes('name: release-candidate-${{ github.sha }}'));
    assert.ok(!/^\s*(?:export\s+)?GITHUB_SHA=/mu.test(workflow));
  });
  // Execute the active workflow literal in Bash. Only Git's network fetch is a
  // fixture stub; Node invokes the real verify-source CLI on the private repo.
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/release-vnext.yml'),'utf8');
  const sourceGateBlock=workflow.slice(workflow.indexOf('      - name: Verify the exact formal candidate source before installing'),workflow.indexOf('      - name: Classify, diff-check, and scan the exact candidate range'));
  const sourceGateScript=sourceGateBlock.split('        run: |')[1].trimEnd().split(/\r?\n/u).slice(1).map(line=>line.slice(10)).join('\n');
  assert.ok(sourceGateScript.startsWith('set -euo pipefail\n'));
  const sourceGateHarness=path.join(temp,'workflow-source-gate.sh');
  write(sourceGateHarness,`#!/usr/bin/env bash\ngit(){
    if [[ "$#" -eq 3 && "$1" == remote && "$2" == get-url && "$3" == origin ]]; then printf '%s\\n' "$FIXTURE_ORIGIN"; return 0; fi
    [[ "$#" -eq 10 && "$1" == -c && "$2" == credential.helper= && "$3" == -c && "$4" == 'credential.helper=!gh auth git-credential' && "$5" == fetch && "$6" == --no-tags && "$7" == --no-recurse-submodules && "$8" == --no-write-fetch-head && "$9" == origin && "\${10}" == "$FIXTURE_EXPECTED_SHA" ]] || { echo 'UNEXPECTED_GIT_FETCH' >&2; return 2; }
    [[ -n "$GH_TOKEN" ]] || { echo 'FETCH_TOKEN_MISSING' >&2; return 2; }
    printf 'EXACT_FETCH_SENTINEL\\n'; return "$FIXTURE_FETCH_STATUS"
  }
  node(){ if [[ "$1" == scripts/deployment-control-plane.mjs && "$2" == verify-source ]]; then printf 'VERIFY_SOURCE_REACHED_SENTINEL\\n'; fi; '${unix(process.execPath)}' "$@"; }
  ${sourceGateScript}
  printf 'INSTALL_REACHED_SENTINEL\\n'
  printf 'BUILD_REACHED_SENTINEL\\n'
  `);
  const sourceGateEnv={...process.env,...prCi,GITHUB_WORKSPACE:source,RELEASE_HEAD_SHA:prHead,GH_TOKEN:'RAM_ONLY_FIXTURE_TOKEN',FIXTURE_ORIGIN:`https://github.com/${subject.repository}.git`,FIXTURE_EXPECTED_SHA:merge,FIXTURE_FETCH_STATUS:'0'};
  const runSourceGate=(event=prEvent,changes={})=>{write(eventFile,JSON.stringify(event));const before=tree(source);const result=spawnSync(bash,[unix(sourceGateHarness)],{cwd:source,encoding:'utf8',windowsHide:true,timeout:20000,env:{...sourceGateEnv,...changes,GIT_CONFIG_GLOBAL:emptyGitConfig,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});assert.equal(tree(source),before,'source gate must not write source, index or credential config');return result;};
  for(const suffix of ['.git',''])check('actual workflow trusted origin '+(suffix||'without suffix')+' fetches only exact SHA before real CLI/install/build',()=>{const x=runSourceGate(prEvent,{FIXTURE_ORIGIN:`https://github.com/${subject.repository}${suffix}`});assert.equal(x.status,0,x.stderr);assert.ok(x.stdout.includes('EXACT_FETCH_SENTINEL'));assert.ok(x.stdout.includes('VERIFY_SOURCE_REACHED_SENTINEL'));assert.ok(x.stdout.includes('INSTALL_REACHED_SENTINEL'));assert.ok(x.stdout.includes('BUILD_REACHED_SENTINEL'));assert.equal(prCi.GITHUB_SHA,merge);});
  for(const [label,changes]of [['wrong-origin',{FIXTURE_ORIGIN:'https://github.com/other/repo.git'}],['invalid-sha',{GITHUB_SHA:'refs/pull/7/merge'}],['failed-fetch',{FIXTURE_FETCH_STATUS:'2'}],['wrong-ref',{GITHUB_REF:'refs/pull/8/merge'}],['wrong-head',{RELEASE_HEAD_SHA:initialHead}]])check('actual workflow '+label+' stops before dependency install and build',()=>{
    const x=runSourceGate(prEvent,changes);assert.notEqual(x.status,0,label);assert.ok(!x.stdout.includes('INSTALL_REACHED_SENTINEL'),label);assert.ok(!x.stdout.includes('BUILD_REACHED_SENTINEL'),label);
    if(['wrong-origin','invalid-sha'].includes(label))assert.ok(!x.stdout.includes('EXACT_FETCH_SENTINEL'),label);
    if(['wrong-origin','invalid-sha','failed-fetch'].includes(label))assert.ok(!x.stdout.includes('VERIFY_SOURCE_REACHED_SENTINEL'),label);
    if(label==='failed-fetch')assert.match(x.stderr,/CONTROL_PR_FETCH_FAILED/u);
  });
  for(const eventName of ['push','workflow_dispatch'])check('actual workflow '+eventName+' verifies original head without any fetch',()=>{const x=runSourceGate(prEvent,{GITHUB_EVENT_NAME:eventName,GITHUB_SHA:prHead,GITHUB_REF:'refs/heads/main'});assert.equal(x.status,0,x.stderr);assert.ok(!x.stdout.includes('EXACT_FETCH_SENTINEL'));assert.ok(x.stdout.includes('VERIFY_SOURCE_REACHED_SENTINEL'));assert.ok(x.stdout.includes('BUILD_REACHED_SENTINEL'));});
  check('actual workflow dirty closure stops before dependency install and build',()=>{
    const input=path.join(source,'scripts/normalize-legacy-runtime-vnext.mjs'),original=fs.readFileSync(input);write(input,Buffer.concat([original,Buffer.from('\n// workflow dirty fixture\n')]));
    try{const x=runSourceGate();assert.notEqual(x.status,0);assert.match(x.stderr,/CONTROL_FORMAL_SOURCE_DRIFT/u);assert.ok(!x.stdout.includes('INSTALL_REACHED_SENTINEL'));assert.ok(!x.stdout.includes('BUILD_REACHED_SENTINEL'));}finally{write(input,original);}
  });
  console.log(JSON.stringify({ok:true,checks:checks.length,cases:checks,scope:'actual local producer/verifier/fixture installer and isolated real shell bootstrap; no CI/server trust or install claim',modelCalls:0,networkCalls:0,serverInstalls:0}));
}finally{
  // Only operation-owned mkdtemp fixture tree, never a caller-computed path.
  function writable(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())writable(f);else if(!e.isSymbolicLink())fs.chmodSync(f,0o600);}fs.chmodSync(d,0o700);}writable(temp);fs.rmSync(temp,{recursive:true,force:true});
}
