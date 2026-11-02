#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAllowedPaths, assertInvariantManifests, assertRun, assertVersionMetadata, cancellableCandidate, cancelCandidatesForCommit, inspectSource, verifyOriginal, main, ORIGINAL, ALLOWED_PATHS } from './package-control-plane-compatibility.mjs';
const checks=[];
const check=(name,fn)=>{fn();checks.push(name);};
const reject=(name,fn,pattern)=>check(name,()=>assert.throws(fn,pattern));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const clone=x=>structuredClone(x);
const manifest={compatibility:{contractHashes:{database:'a'.repeat(64)}},files:[
  {sourcePath:'scripts/deploy-artifact-vnext.sh',sha256:'b'.repeat(64)},
  {sourcePath:'scripts/deployment-control-plane.mjs',sha256:'c'.repeat(64)},
  {sourcePath:'scripts/media-worker-transaction-hook-vnext.mjs',sha256:ORIGINAL.hookSha256},
  {sourcePath:'deploy/pm2/ecosystem.vnext.config.cjs',sha256:ORIGINAL.configSha256},
  {sourcePath:'deploy/policies/database-semantic-contract.v1.json',sha256:'d'.repeat(64)},
]};
check('exact explicitly approved control paths accepted',()=>assert.deepEqual(assertAllowedPaths([...ALLOWED_PATHS].reverse()),[...ALLOWED_PATHS].sort()));
for(const forbidden of ['src/app/page.tsx','package.json','pnpm-lock.yaml','supabase/migrations/new.sql','public/other.json','deploy/policies/release-policy.json','scripts/deploy-artifact-vnext.sh/extra','Scripts/deploy-artifact-vnext.sh'])reject(`reject changed ${forbidden}`,()=>assertAllowedPaths([forbidden]),/COMPAT_SOURCE_DIFF_FORBIDDEN/u);
reject('empty source change rejected',()=>assertAllowedPaths([]),/COMPAT_SOURCE_DIFF_FORBIDDEN/u);
reject('duplicate source paths rejected',()=>assertAllowedPaths([ALLOWED_PATHS[0],ALLOWED_PATHS[0]]),/COMPAT_SOURCE_DIFF_FORBIDDEN/u);
check('controller and verifier bytes may change',()=>{const next=clone(manifest);next.files[0].sha256='e'.repeat(64);next.files[1].sha256='f'.repeat(64);assertInvariantManifests(manifest,next);});
reject('database contract drift rejected',()=>{const next=clone(manifest);next.compatibility.contractHashes.database='e'.repeat(64);assertInvariantManifests(manifest,next);},/COMPAT_CONTRACT_DRIFT/u);
for(const index of [2,3,4])reject(`immutable control dependency ${index} rejected`,()=>{const next=clone(manifest);next.files[index].sha256='e'.repeat(64);assertInvariantManifests(manifest,next);},/COMPAT_IMMUTABLE_CONTROL_DRIFT/u);
reject('added dependency rejected',()=>{const next=clone(manifest);next.files.push({sourcePath:'scripts/unsafe.mjs',sha256:'a'.repeat(64)});assertInvariantManifests(manifest,next);},/COMPAT_IMMUTABLE_CONTROL_DRIFT/u);
const run={id:Number(ORIGINAL.candidateRunId),run_attempt:1,head_sha:ORIGINAL.commit,head_branch:'main',repository:{full_name:ORIGINAL.repository},event:'push',conclusion:'success',status:'completed',name:'Release vNext staged candidate'};
check('fixed original main candidate push provenance accepted',()=>assertRun(run,ORIGINAL.candidateRunId,run.name,'push'));
check('fixed original browser workflow_run provenance accepted',()=>assertRun({...run,id:Number(ORIGINAL.browserRunId),event:'workflow_run',name:'Release browser acceptance evidence'},ORIGINAL.browserRunId,'Release browser acceptance evidence','workflow_run'));
check('fixed original finalize dispatch provenance accepted',()=>assertRun({...run,id:Number(ORIGINAL.finalizeRunId),event:'workflow_dispatch'},ORIGINAL.finalizeRunId,run.name,'workflow_dispatch'));
for(const [key,value] of [['id',1],['run_attempt',2],['head_sha','e'.repeat(40)],['head_branch','feature'],['event','workflow_dispatch'],['conclusion','failure'],['status','in_progress'],['name','fake']])reject(`original run ${key} drift rejected`,()=>assertRun({...run,[key]:value},ORIGINAL.candidateRunId,run.name,'push'),/COMPAT_ORIGINAL_RUN_PROVENANCE/u);
reject('fork repository rejected',()=>assertRun({...run,repository:{full_name:'fork/repo'}},ORIGINAL.candidateRunId,run.name,'push'),/COMPAT_ORIGINAL_RUN_PROVENANCE/u);
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:ORIGINAL.repository,GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_SHA:'e'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
for(const [key,value] of [['GITHUB_ACTIONS','false'],['GITHUB_REF','refs/heads/feature'],['GITHUB_EVENT_NAME','pull_request'],['GITHUB_REPOSITORY','fork/repo'],['GITHUB_SHA',ORIGINAL.commit],['GITHUB_RUN_ID','0'],['GITHUB_RUN_ATTEMPT','']])reject(`new package ${key} rejects before Git or writes`,()=>inspectSource(root,{...env,[key]:value}),/COMPAT_MAIN_CI_REQUIRED/u);
const before=JSON.parse(fs.readFileSync(path.join(root,'public/version.json')));
// The baseline fixture is fixed to the immutable business release, independent of local future revisions.
Object.assign(before,{schemaVersion:1,sourceVersion:'R001597-20261102-66d1decb',revision:1597,sourceDigest:'66d1decb24c1a2b6be1a5be0775941c2fec7ca15bb5b11832ee28f2e91afe3e2',version:'R001597-20261102-66d1decb',hash:'R001597-20261102-66d1decb',timestamp:'2026-11-01T21:03:55.487Z'});
const after={...before,revision:1599,sourceDigest:'e'.repeat(64),sourceVersion:'R001599-20261102-eeeeeeee',version:'R001599-20261102-eeeeeeee',hash:'R001599-20261102-eeeeeeee',timestamp:'2026-11-02T02:00:00.000Z'};
check('strict monotonically newer source metadata accepted',()=>assert.deepEqual(assertVersionMetadata(before,after),{before,after}));
for(const [key,value] of [['schemaVersion',2],['revision',1597],['revision',1599.5],['sourceDigest',before.sourceDigest],['sourceDigest','z'.repeat(64)],['sourceVersion','R001598-20261102-eeeeeeee'],['version','wrong'],['hash','wrong'],['timestamp',before.timestamp],['timestamp','invalid'],['extra',true]])reject(`version metadata ${key} drift rejected`,()=>assertVersionMetadata(before,{...after,[key]:value}),/COMPAT_VERSION_METADATA/u);
reject('old business source metadata drift rejected',()=>assertVersionMetadata({...before,revision:1596},after),/COMPAT_VERSION_METADATA/u);
const candidate={...run,id:123,head_sha:env.GITHUB_SHA,path:'.github/workflows/release-vnext.yml',status:'queued',conclusion:null};
check('only exact unpublished automatic candidate eligible',()=>assert.equal(cancellableCandidate(candidate,env.GITHUB_SHA),true));
for(const [key,value] of [['head_sha','f'.repeat(40)],['head_branch','feature'],['event','workflow_dispatch'],['event','pull_request'],['path','.github/workflows/release-browser-acceptance.yml'],['status','completed'],['conclusion','success'],['repository',{full_name:'fork/repo'}]])check(`candidate cancellation excludes ${key} ${String(value)}`,()=>assert.equal(cancellableCandidate({...candidate,[key]:value},env.GITHUB_SHA),false));
{
  const requests=[];
  const api=async(route,method='GET')=>{requests.push([route,method]);if(route.includes('?'))return {total_count:3,workflow_runs:[candidate,{...candidate,id:124,event:'workflow_dispatch'},{...candidate,id:125,head_sha:'f'.repeat(40)}]};if(method==='GET')return candidate;return null;};
  const result=await cancelCandidatesForCommit(env.GITHUB_SHA,api,{rounds:2,pause:async()=>{}});
  assert.deepEqual(result.cancelledRunIds,[123]);assert.deepEqual(requests.filter(x=>x[1]==='POST'),[['actions/runs/123/cancel','POST']]);assert.equal(requests.filter(x=>x[0]==='actions/runs/123').length,1);checks.push('mock cancellation rechecks exact run and deduplicates without touching dispatch or other commits');
}
{
  const writes=[];
  const api=async(route,method='GET')=>{if(method==='POST')writes.push(route);return route.includes('?')?{total_count:1,workflow_runs:[candidate]}:{...candidate,status:'completed',conclusion:'success'};};
  await cancelCandidatesForCommit(env.GITHUB_SHA,api,{rounds:1});assert.deepEqual(writes,[]);checks.push('run completed between listing and detail read is never cancelled');
}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'compatibility-producer-'));
try{
  fs.writeFileSync(path.join(temp,'release-change-validations.json'),'{}');
  reject('original bundle modification fails before package writes',()=>verifyOriginal(temp),/COMPAT_ORIGINAL_BUNDLE_DIGEST/u);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
await assert.rejects(main(['--output','x','--output','y']),/COMPAT_ARGUMENT_INVALID/u);checks.push('duplicate CLI option rejected');
await assert.rejects(main(['--root','x']),/COMPAT_ARGUMENT_INVALID/u);checks.push('missing CLI arguments rejected');
const workflow=fs.readFileSync(path.join(root,'.github/workflows/control-plane-compatibility.yml'),'utf8');
check('workflow binds main original artifact and only control package upload',()=>{assert.match(workflow,/github\.ref == 'refs\/heads\/main'/u);assert.match(workflow,/artifact-ids: '13102719744'/u);assert.match(workflow,/run-id: '41356526504'/u);assert.match(workflow,/persist-credentials: false/u);assert.match(workflow,/actions: read/u);assert.doesNotMatch(workflow,/pnpm|npm install|build-release|package-standalone|ssh|scp|--execute|DATABASE_URL/iu);});
check('push trigger paths exactly equal single exported allowlist',()=>{const paths=[...workflow.matchAll(/^      - '([^']+)'$/gmu)].map(m=>m[1]);assert.deepEqual(paths.sort(),[...ALLOWED_PATHS].sort());});
check('cancellation follows source preflight and precedes Node setup and packaging',()=>{assert.ok(workflow.indexOf('inspectSource(process.cwd())')<workflow.indexOf('await cancelAutomaticCandidate'));assert.ok(workflow.indexOf('await cancelAutomaticCandidate')<workflow.indexOf('actions/setup-node@'));assert.match(workflow,/actions: write/u);assert.match(workflow,/verify-control-plane-compatibility-proof\.mjs --original-bundle/u);});
process.stdout.write(JSON.stringify({status:'passed',checks:checks.length,details:checks})+'\n');
