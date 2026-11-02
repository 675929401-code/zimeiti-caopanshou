#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertAllowedPaths, assertManagedSourceMetadata, verifyManagedSourceMetadata, assertInvariantManifests, assertRun, assertVersionMetadata, cancellableCandidate, cancelCandidatesForCommit, inspectSource, verifyOriginal, main, ORIGINAL, ALLOWED_PATHS } from './package-control-plane-compatibility.mjs';
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
for(const forbidden of ['src/app/page.tsx','package.json','pnpm-lock.yaml','supabase/migrations/new.sql','public/other.json','deploy/policies/release-policy.json','.release/source-repo.json','.release/source-files.v1.json.tmp','scripts/deploy-artifact-vnext.sh/extra','Scripts/deploy-artifact-vnext.sh'])reject(`reject changed ${forbidden}`,()=>assertAllowedPaths([forbidden]),/COMPAT_SOURCE_DIFF_FORBIDDEN/u);
const metadataBaseline={schemaVersion:1,projectId:'zimeiti-caopanshou',kind:'clean-source-snapshot',canonicalTextEol:'lf',policySha256:'1'.repeat(64),assetManifestSha256:'2'.repeat(64),assetDigest:'3'.repeat(64),assetVersion:'sha256-'+'3'.repeat(64),files:[]};
// Exercise the canonical owner's actual generation functions, without running
// refresh-metadata against this shared workspace or triggering the full audit.
const owner=fs.readFileSync(path.join(root,'scripts/release-workflow.mjs'),'utf8');
const producerFunction=owner.match(/function sourceManifest\(source\) \{[\s\S]*?\n\}/u)?.[0],writerFunction=owner.match(/function writeJsonAtomic\(filePath, value\) \{[\s\S]*?\n\}/u)?.[0];
assert.ok(producerFunction&&writerFunction);
function canonicalMetadata(rows){
  let written;const context={policy:{projectId:metadataBaseline.projectId},policySha256:metadataBaseline.policySha256,validateAssetManifest:()=>({failures:[],manifestSha256:metadataBaseline.assetManifestSha256,manifest:{digest:metadataBaseline.assetDigest,assetVersion:metadataBaseline.assetVersion}}),fs:{mkdirSync(){},writeFileSync(_file,bytes){written=Buffer.from(bytes);},existsSync(){return false;},renameSync(){}},path,crypto:{randomUUID:()=> 'fixture'},process:{pid:1}};
  vm.runInNewContext(producerFunction+'\n'+writerFunction+'\nthis.emit=(source)=>writeJsonAtomic("fixture",sourceManifest(source));',context);
  context.emit({fingerprint:metadataFingerprint(rows),bytes:rows.reduce((sum,row)=>sum+row.bytes,0),files:rows});return written;
}
function metadataFingerprint(rows){return metadataDigest(Buffer.from(rows.map(row=>`${row.sha256}  ${row.path}\n`).join('')));}
function metadataDigest(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
const sourceRows=[{path:'scripts/deploy-artifact-vnext.sh',bytes:3,sha256:metadataDigest(Buffer.from('new'))}];
check('canonical refresh-metadata owner output accepted against actual row contract',()=>{const result=assertManagedSourceMetadata(canonicalMetadata(sourceRows),metadataBaseline,sourceRows);assert.equal(result.sourceFingerprint,metadataFingerprint(sourceRows));assert.equal(result.totalBytes,3);});
for(const [key,value] of [['schemaVersion',2],['projectId','other'],['kind','manual'],['canonicalTextEol','crlf'],['sourceFingerprint','0'.repeat(64)],['fileCount',99],['totalBytes',99],['policySha256','0'.repeat(64)],['assetDigest','0'.repeat(64)]])reject(`source metadata ${key} drift rejected`,()=>{const document=JSON.parse(canonicalMetadata(sourceRows));document[key]=value;assertManagedSourceMetadata(Buffer.from(JSON.stringify(document,null,2)+'\n'),metadataBaseline,sourceRows);},/COMPAT_SOURCE_METADATA_CANONICAL/u);
reject('source manifest manually reformatted bytes rejected',()=>assertManagedSourceMetadata(Buffer.from(JSON.stringify(JSON.parse(canonicalMetadata(sourceRows)))+'\n'),metadataBaseline,sourceRows),/COMPAT_SOURCE_METADATA_CANONICAL/u);
reject('source manifest stale file hash rejected',()=>{const document=JSON.parse(canonicalMetadata(sourceRows));document.files[0].sha256='0'.repeat(64);assertManagedSourceMetadata(Buffer.from(JSON.stringify(document,null,2)+'\n'),metadataBaseline,sourceRows);},/COMPAT_SOURCE_METADATA_CANONICAL/u);
{
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'compat-metadata-git-'));
  const git=args=>execFileSync('git',['--no-optional-locks',...args],{cwd:fixture,windowsHide:true,stdio:['ignore','pipe','pipe']}).toString().trim();
  const commit=()=>{git(['add','--','scripts','.release']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture only']);return git(['rev-parse','HEAD']);};
  try{
    git(['init','-q']);fs.mkdirSync(path.join(fixture,'scripts'));fs.mkdirSync(path.join(fixture,'.release'));
    fs.writeFileSync(path.join(fixture,'scripts/deploy-artifact-vnext.sh'),'old');fs.writeFileSync(path.join(fixture,'.release/source-files.v1.json'),canonicalMetadata([{path:sourceRows[0].path,bytes:3,sha256:metadataDigest(Buffer.from('old'))}]));const base=commit();
    fs.writeFileSync(path.join(fixture,'scripts/deploy-artifact-vnext.sh'),'new');fs.writeFileSync(path.join(fixture,'scripts/package-control-plane-compatibility.mjs'),'added');const rows=[...sourceRows,{path:'scripts/package-control-plane-compatibility.mjs',bytes:5,sha256:metadataDigest(Buffer.from('added'))}];fs.writeFileSync(path.join(fixture,'.release/source-files.v1.json'),canonicalMetadata(rows));const head=commit();const changed=['.release/source-files.v1.json',...rows.map(row=>row.path)];
    check('actual Git HEAD batch hashes match canonical refreshed metadata',()=>assert.equal(verifyManagedSourceMetadata(fixture,base,head,changed).fileCount,2));
    fs.writeFileSync(path.join(fixture,'.release/source-files.v1.json'),canonicalMetadata(sourceRows));const stale=commit();
    reject('Git HEAD new helper cannot be omitted from refreshed inventory',()=>verifyManagedSourceMetadata(fixture,base,stale,changed),/COMPAT_SOURCE_METADATA_CANONICAL/u);
  }finally{assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(fixture,{recursive:true,force:true});}
}
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
