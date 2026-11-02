#!/usr/bin/env node
// One release recovery only. This producer never rewrites the original payload or validation bundle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { canonical, digest, packageBundle, verifyPackage, verifyDeploymentBinding, verifyControlCompatibilityProof, CONTROL_COMPATIBILITY_SOURCE_PATHS } from './deployment-control-plane.mjs';

export const ORIGINAL = Object.freeze({
  repository:'675929401-code/zimeiti-caopanshou',commit:'ede4b913378c5e61a4586f00c8ea592e18feb39f',releaseId:'candidate-ede4b913378c-r60',
  archiveSha256:'ec2d3ee308ffa8ab44c4d1475695b5cd90070869bc0077f83f9a3ddcd38e21c5',
  validationBundleSha256:'590969ce3c633b37cb7db17a73807da2c6ad56115f5fa1016f99531bf32c77be',
  controlDescriptorSha256:'e7b14238b786d39fc7c009ce40351f1447026b12a7fabd16419f250b2dfc262d',
  migrationManifestSha256:'6468942caa1c63c5996ae3faae49301b9af73bdfcbd96e767f490edb3e03d9c7',
  candidateRunId:'41353541526',candidateRunAttempt:'1',browserRunId:'41355998423',browserRunAttempt:'1',finalizeRunId:'41356526504',finalizeRunAttempt:'1',
  hookSha256:'1d309a6c490d5ee800580f091f3d157a750f162a2c467a256a99e826cf6bb5ed',configSha256:'0a182588cdfe748c2cbccb3ddc3f4ea89666dad8eadf4bdf483183eed68fab7b',
});
export const ALLOWED_PATHS = CONTROL_COMPATIBILITY_SOURCE_PATHS;
const fail=code=>{throw Error(code);};
const encode=value=>Buffer.from(canonical(value)+'\n');
const git=(root,args)=>execFileSync('git',['--no-optional-locks','--no-replace-objects',...args],{cwd:root,timeout:10000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});
function read(file,max=16*1024*1024){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max)fail('COMPAT_INPUT_METADATA');return fs.readFileSync(file);}
export function assertAllowedPaths(paths){if(!paths.length||new Set(paths).size!==paths.length||paths.some(p=>!ALLOWED_PATHS.includes(p)))fail('COMPAT_SOURCE_DIFF_FORBIDDEN');return [...paths].sort();}
export function assertVersionMetadata(before,after){
  const expected={schemaVersion:1,sourceVersion:'R001597-20261102-66d1decb',revision:1597,sourceDigest:'66d1decb24c1a2b6be1a5be0775941c2fec7ca15bb5b11832ee28f2e91afe3e2',version:'R001597-20261102-66d1decb',hash:'R001597-20261102-66d1decb',timestamp:'2026-11-01T21:03:55.487Z'};
  if(canonical(before)!==canonical(expected)||!after||canonical(Object.keys(after).sort())!==canonical(Object.keys(expected).sort())||after.schemaVersion!==1||!Number.isSafeInteger(after.revision)||after.revision<=before.revision||!/^[a-f0-9]{64}$/u.test(after.sourceDigest||'')||after.sourceDigest===before.sourceDigest||typeof after.sourceVersion!=='string'||!new RegExp(`^R${String(after.revision).padStart(6,'0')}-[0-9]{8}-${after.sourceDigest.slice(0,8)}$`,'u').test(after.sourceVersion)||after.version!==after.sourceVersion||after.hash!==after.sourceVersion||typeof after.timestamp!=='string'||!Number.isFinite(Date.parse(after.timestamp))||new Date(after.timestamp).toISOString()!==after.timestamp||Date.parse(after.timestamp)<=Date.parse(before.timestamp))fail('COMPAT_VERSION_METADATA');
  return {before,after};
}
export function inspectSource(root,env=process.env){
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==ORIGINAL.repository||env.GITHUB_REF!=='refs/heads/main'||!['workflow_dispatch','push'].includes(env.GITHUB_EVENT_NAME)||!/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA||'')||env.GITHUB_SHA===ORIGINAL.commit||!/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID||'')||!/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT||''))fail('COMPAT_MAIN_CI_REQUIRED');
  if(git(root,['rev-parse','HEAD']).toString().trim()!==env.GITHUB_SHA)fail('COMPAT_HEAD_MISMATCH');
  if(git(root,['status','--porcelain=v1','--untracked-files=all']).length)fail('COMPAT_CLEAN_SOURCE_REQUIRED');
  git(root,['merge-base','--is-ancestor',ORIGINAL.commit,env.GITHUB_SHA]);
  const paths=assertAllowedPaths(git(root,['diff','--no-renames','--name-only','-z',ORIGINAL.commit,env.GITHUB_SHA]).toString().split('\0').filter(Boolean));
  if(!['public/version.json','scripts/deploy-artifact-vnext.sh','scripts/deployment-control-plane.mjs'].every(p=>paths.includes(p)))fail('COMPAT_REQUIRED_SOURCE_PATHS');
  const versionMetadata=assertVersionMetadata(JSON.parse(git(root,['show',`${ORIGINAL.commit}:public/version.json`])),JSON.parse(git(root,['show',`${env.GITHUB_SHA}:public/version.json`])));
  return {base:ORIGINAL.commit,head:env.GITHUB_SHA,paths,versionMetadata};
}
export function verifyOriginal(directory){
  const bundleBytes=read(path.join(directory,'release-change-validations.json'));
  if(digest(bundleBytes)!==ORIGINAL.validationBundleSha256)fail('COMPAT_ORIGINAL_BUNDLE_DIGEST');
  const descriptorBytes=read(path.join(directory,'control-plane/control-plane.descriptor.json'));
  if(digest(descriptorBytes)!==ORIGINAL.controlDescriptorSha256)fail('COMPAT_ORIGINAL_DESCRIPTOR_DIGEST');
  const descriptor=JSON.parse(descriptorBytes),bundle=JSON.parse(bundleBytes);
  const s=descriptor.subject;
  if(s.sourceCommit!==ORIGINAL.commit||s.repository!==ORIGINAL.repository||s.candidateRunId!==ORIGINAL.candidateRunId||s.candidateRunAttempt!==ORIGINAL.candidateRunAttempt)fail('COMPAT_ORIGINAL_SUBJECT');
  const verified=verifyPackage(path.join(directory,'control-plane'),descriptor);
  verifyDeploymentBinding(bundleBytes,ORIGINAL.validationBundleSha256,descriptor,{service:'web',archiveSha256:ORIGINAL.archiveSha256,releaseId:ORIGINAL.releaseId,commit:ORIGINAL.commit,sourceVersion:bundle.subject.sourceVersion,buildId:bundle.subject.builds.web,buildOutputDigest:bundle.subject.buildOutputDigests.web});
  return {bundleBytes,descriptor,verified};
}
export function assertInvariantManifests(oldManifest,newManifest){
  if(canonical(oldManifest.compatibility)!==canonical(newManifest.compatibility))fail('COMPAT_CONTRACT_DRIFT');
  const mutable=['scripts/deploy-artifact-vnext.sh','scripts/deployment-control-plane.mjs'];
  const old=oldManifest.files.filter(f=>!mutable.includes(f.sourcePath)),next=newManifest.files.filter(f=>!mutable.includes(f.sourcePath));
  if(canonical(old)!==canonical(next))fail('COMPAT_IMMUTABLE_CONTROL_DRIFT');
  const get=p=>newManifest.files.find(f=>f.sourcePath===p)?.sha256;
  if(get('scripts/media-worker-transaction-hook-vnext.mjs')!==ORIGINAL.hookSha256||get('deploy/pm2/ecosystem.vnext.config.cjs')!==ORIGINAL.configSha256)fail('COMPAT_HOOK_CONFIG_DRIFT');
}
async function hashFile(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('COMPAT_ARCHIVE_METADATA');const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
export function assertRun(run,id,name,event){if(String(run?.id)!==id||String(run?.run_attempt)!=='1'||run?.head_sha!==ORIGINAL.commit||run?.head_branch!=='main'||run?.repository?.full_name!==ORIGINAL.repository||run?.event!==event||run?.conclusion!=='success'||run?.status!=='completed'||run?.name!==name)fail('COMPAT_ORIGINAL_RUN_PROVENANCE');}
export function cancellableCandidate(run,sha){return Number.isSafeInteger(run?.id)&&run.id>0&&run?.head_sha===sha&&run?.head_branch==='main'&&run?.event==='push'&&run?.path==='.github/workflows/release-vnext.yml'&&run?.repository?.full_name===ORIGINAL.repository&&['queued','in_progress'].includes(run?.status)&&run?.conclusion===null;}
export async function cancelAutomaticCandidate(root,env=process.env){
  inspectSource(root,env);
  if(!env.GH_TOKEN)fail('COMPAT_ACTIONS_TOKEN_REQUIRED');
  const deadline=Date.now()+60000;
  const api=async(route,method='GET')=>{const remaining=deadline-Date.now();if(remaining<=0)fail('COMPAT_ACTIONS_POLL_DEADLINE');const response=await fetch(`https://api.github.com/repos/${ORIGINAL.repository}/${route}`,{method,headers:{Authorization:`Bearer ${env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(Math.min(10000,remaining))});if(!response.ok)fail('COMPAT_ACTIONS_API_FAILED');return method==='GET'?response.json():null;};
  return cancelCandidatesForCommit(env.GITHUB_SHA,api,{deadline});
}
export async function cancelCandidatesForCommit(sha,api,{pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),rounds=12,deadline=Date.now()+60000}={}){
  const cancelled=new Set();
  for(let i=0;i<rounds&&Date.now()<deadline;i++){
    const listing=await api(`actions/workflows/release-vnext.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`);
    if(!Array.isArray(listing?.workflow_runs)||!Number.isSafeInteger(listing?.total_count)||listing.total_count>100)fail('COMPAT_ACTIONS_LIST_INVALID');
    for(const run of listing.workflow_runs){
      if(!cancellableCandidate(run,sha)||cancelled.has(run.id))continue;
      const current=await api(`actions/runs/${run.id}`);
      if(current?.id!==run.id)fail('COMPAT_ACTIONS_RUN_ID_MISMATCH');
      if(cancellableCandidate(current,sha)){await api(`actions/runs/${run.id}/cancel`,'POST');cancelled.add(run.id);}
    }
    if(i+1<rounds&&Date.now()<deadline)await pause(Math.min(5000,deadline-Date.now()));
  }
  return {cancelledRunIds:[...cancelled]};
}
export async function produce({root,originalDirectory,runDirectory,output},env=process.env){
  const sourceDiff=inspectSource(root,env);
  assertRun(JSON.parse(read(path.join(runDirectory,'candidate.json'))),ORIGINAL.candidateRunId,'Release vNext staged candidate','push');
  assertRun(JSON.parse(read(path.join(runDirectory,'browser.json'))),ORIGINAL.browserRunId,'Release browser acceptance evidence','workflow_run');
  assertRun(JSON.parse(read(path.join(runDirectory,'finalize.json'))),ORIGINAL.finalizeRunId,'Release vNext staged candidate','workflow_dispatch');
  const original=verifyOriginal(originalDirectory);
  if(await hashFile(path.join(originalDirectory,`web-${ORIGINAL.releaseId}.tar.gz`))!==ORIGINAL.archiveSha256)fail('COMPAT_ORIGINAL_ARCHIVE_DIGEST');
  const oldSemantic=original.verified.entries.find(e=>e.sourcePath==='deploy/policies/database-semantic-contract.v1.json');
  if(JSON.parse(Buffer.from(oldSemantic.base64,'base64')).migrationManifestSha256!==ORIGINAL.migrationManifestSha256)fail('COMPAT_MIGRATION_MANIFEST');
  const subject={mode:'formal',sourceCommit:env.GITHUB_SHA,repository:ORIGINAL.repository,candidateRunId:env.GITHUB_RUN_ID,candidateRunAttempt:env.GITHUB_RUN_ATTEMPT};
  const out=path.resolve(output);
  if(fs.existsSync(out)||out===path.resolve(root)||out.startsWith(path.resolve(root)+path.sep))fail('COMPAT_OUTPUT_INVALID');
  // New package is generated only through the canonical control-plane producer.
  fs.mkdirSync(out,{mode:0o700});
  const descriptor=packageBundle(root,path.join(out,'control-plane'),subject,env);
  const next=verifyPackage(path.join(out,'control-plane'),descriptor);
  assertInvariantManifests(original.verified.manifest,next.manifest);
  const proof={kind:'deployment-control-plane-compatibility-proof.v1',schemaVersion:1,repository:ORIGINAL.repository,business:Object.fromEntries(Object.entries(ORIGINAL).filter(([k])=>!['repository','hookSha256','configSha256'].includes(k))),control:{descriptorSha256:digest(read(path.join(out,'control-plane/control-plane.descriptor.json'))),sourceCommit:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT},invariants:{contractHashes:next.manifest.compatibility.contractHashes,hookSha256:ORIGINAL.hookSha256,configSha256:ORIGINAL.configSha256,migrationManifestSha256:ORIGINAL.migrationManifestSha256},sourceDiff};
  // Re-read original bytes after generation. They remain outside this output.
  if(digest(read(path.join(originalDirectory,'release-change-validations.json')))!==ORIGINAL.validationBundleSha256)fail('COMPAT_ORIGINAL_CHANGED');
  const proofBytes=encode(proof),b=JSON.parse(original.bundleBytes);
  verifyControlCompatibilityProof(proofBytes,digest(proofBytes),{bundleBytes:original.bundleBytes,bundleSha256:ORIGINAL.validationBundleSha256,descriptor,identity:{service:'web',archiveSha256:ORIGINAL.archiveSha256,releaseId:ORIGINAL.releaseId,commit:ORIGINAL.commit,sourceVersion:b.subject.sourceVersion,buildId:b.subject.builds.web,buildOutputDigest:b.subject.buildOutputDigests.web}});
  fs.writeFileSync(path.join(out,'compatibility-proof.json'),proofBytes,{flag:'wx'});fs.writeFileSync(path.join(out,'compatibility-proof.json.sha256'),digest(proofBytes)+'  compatibility-proof.json\n',{flag:'wx'});
  return {descriptor,proofSha256:digest(proofBytes),output:out};
}
export async function main(argv=process.argv.slice(2),env=process.env){const a=new Map();for(let i=0;i<argv.length;i+=2){if(!['--root','--original-artifact-dir','--run-dir','--output'].includes(argv[i])||a.has(argv[i])||!argv[i+1]||argv[i+1].startsWith('--'))fail('COMPAT_ARGUMENT_INVALID');a.set(argv[i],argv[i+1]);}if(a.size!==4)fail('COMPAT_ARGUMENT_INVALID');return produce({root:path.resolve(a.get('--root')),originalDirectory:path.resolve(a.get('--original-artifact-dir')),runDirectory:path.resolve(a.get('--run-dir')),output:path.resolve(a.get('--output'))},env);}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){main().then(r=>process.stdout.write(canonical(r)+'\n')).catch(e=>{process.stderr.write(JSON.stringify({status:'blocked',error:/^(COMPAT|CONTROL)_[A-Z0-9_]+$/u.test(e.message)?e.message:'COMPAT_OPERATION_FAILED'})+'\n');process.exitCode=2;});}
