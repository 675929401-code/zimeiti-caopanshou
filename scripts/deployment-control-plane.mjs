#!/usr/bin/env node
// Standalone bootstrap verifier: built-in dependencies only; never import payload code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const POLICY_PATH = 'deploy/policies/deployment-control-plane.v1.json';
export const MANIFEST = 'control-plane.manifest.json';
export const ARCHIVE = 'deployment-control-plane.bundle.json';
const LIMITS = Object.freeze({entries:32,fileBytes:2097152,totalBytes:8388608,archiveBytes:12582912});
const HEX = /^[a-f0-9]{64}$/u;
const fail = code => { throw new Error(code); };
export const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const encode = value => Buffer.from(canonical(value)+'\n');
function keys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) fail(label);
}
function parse(bytes, limit = LIMITS.archiveBytes) {
  if (bytes.length > limit) fail('CONTROL_SIZE_LIMIT');
  let value; try { value=JSON.parse(bytes.toString('utf8')); } catch { fail('CONTROL_JSON_INVALID'); }
  if (!encode(value).equals(bytes)) fail('CONTROL_NONCANONICAL_JSON');
  return value;
}
function relative(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.\/-]+$/u.test(value) || value.startsWith('/') || value.split('/').some(x=>!x||x==='.'||x==='..')) fail('CONTROL_PATH_INVALID');
  return value;
}
function regular(file, max = LIMITS.fileBytes) {
  const s=fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) fail('CONTROL_FILE_METADATA_INVALID');
  return s;
}
function safeFile(root, name) {
  relative(name); const base=path.resolve(root); let cursor=base;
  if (fs.lstatSync(base).isSymbolicLink() || fs.realpathSync(base)!==base) fail('CONTROL_ROOT_NOT_CANONICAL');
  for (const part of name.split('/')) { cursor=path.join(cursor,part); if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail('CONTROL_LINK_FORBIDDEN'); }
  return cursor;
}
function read(file, max=LIMITS.fileBytes) {
  regular(file,max);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try {const before=fs.fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size>max)fail('CONTROL_FILE_METADATA_INVALID');const b=fs.readFileSync(fd);const after=fs.fstatSync(fd),named=fs.lstatSync(file);if(b.length>max||after.size!==before.size||after.mtimeMs!==before.mtimeMs||named.isSymbolicLink()||named.ino!==after.ino||named.dev!==after.dev)fail('CONTROL_FILE_CHANGED_DURING_READ');return b;}finally{fs.closeSync(fd);}
}
function subjectCheck(s) {
  keys(s,['mode','sourceCommit','repository','candidateRunId','candidateRunAttempt'],'CONTROL_SUBJECT_FIELDS');
  if (!['formal','rehearsal'].includes(s.mode)) fail('CONTROL_SUBJECT_MODE');
  if (s.mode==='formal') {
    if (!/^[a-f0-9]{40}$/u.test(s.sourceCommit)|| !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(s.repository) || !/^[1-9][0-9]*$/u.test(s.candidateRunId) || !/^[1-9][0-9]*$/u.test(s.candidateRunAttempt)) fail('CONTROL_FORMAL_SUBJECT_INVALID');
  } else if (s.sourceCommit!==null || s.repository!==null || s.candidateRunId!==null || s.candidateRunAttempt!==null) fail('CONTROL_REHEARSAL_NOT_DEPLOYABLE');
}
function policyCheck(p) {
  keys(p,['schemaVersion','projectId','layoutVersion','entrypoint','limits','files','externalInputs','hookPhases'],'CONTROL_POLICY_FIELDS');
  if(p.schemaVersion!==1 || p.projectId!=='zimeiti-caopanshou'||p.layoutVersion!==1||p.entrypoint!=='scripts/deploy-artifact-vnext.sh'||canonical(p.limits)!==canonical(LIMITS)) fail('CONTROL_POLICY_INCOMPATIBLE');
  keys(p.externalInputs,['node','storageGuard','readinessFixtureHelper','runtime'],'CONTROL_EXTERNAL_FIELDS');
  for(const input of [p.externalInputs.storageGuard,p.externalInputs.readinessFixtureHelper]){keys(input,['path','sha256'],'CONTROL_EXTERNAL_FIELDS');if(typeof input.path!=='string'||!input.path.startsWith('/')||!HEX.test(input.sha256))fail('CONTROL_EXTERNAL_IDENTITY_INVALID');}
  if(p.externalInputs.node!=='v24.19.0:137'||!Array.isArray(p.externalInputs.runtime)||!p.externalInputs.runtime.every(x=>typeof x==='string'))fail('CONTROL_EXTERNAL_IDENTITY_INVALID');
  if(!Array.isArray(p.files)||p.files.length<1||p.files.length>LIMITS.entries) fail('CONTROL_INVENTORY_LIMIT');
  const src=new Set(),dest=new Set();
  for(const item of p.files){if(!Array.isArray(item)||item.length!==3)fail('CONTROL_MAPPING_INVALID');relative(item[0]);relative(item[1]);const mode=item[1]==='transaction-hook.mjs'?'0500':item[1]==='ecosystem.config.cjs'?'0400':/\.(mjs|sh)$/u.test(item[1])?'0555':'0444';if(item[2]!==mode)fail('CONTROL_MAPPING_MODE_INVALID');for(const [set,x] of [[src,item[0]],[dest,item[1]]]){const k=x.normalize('NFC').toLowerCase();if(set.has(k))fail('CONTROL_PATH_COLLISION');set.add(k);}}
}
function qualifyClosure(policy,sources) {
  const controller=sources.get('scripts/deploy-artifact-vnext.sh');
  const hook=sources.get('scripts/media-worker-transaction-hook-vnext.mjs');
  if(!controller||!hook)fail('CONTROL_ENTRYPOINT_OR_HOOK_MISSING');
  for(const [prefix,input] of [['STORAGE_GUARD',policy.externalInputs.storageGuard],['CANDIDATE_FIXTURE_HELPER',policy.externalInputs.readinessFixtureHelper]]){
    if(!controller.includes(`${prefix}_PATH="${input.path}"`)||!controller.includes(`${prefix}_SHA256="${input.sha256}"`))fail('CONTROL_EXTERNAL_SOURCE_DRIFT');
  }
  const phases=hook.match(/new Set\((\["prepare"[^\]]+\])\)\.has\(phase\)/u);
  if(!phases||canonical(JSON.parse(phases[1]))!==canonical(policy.hookPhases)||!hook.includes('DIRECT_HOOK_PM2_CONFIG_PATH'))fail('CONTROL_HOOK_PHASE_CONTRACT_DRIFT');
  for(const [source,text] of sources)for(const m of text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](\.[^'"]+)['"]/gu)){const dep=path.posix.normalize(path.posix.join(path.posix.dirname(source),m[1]));if(!sources.has(dep))fail('CONTROL_DEPENDENCY_NOT_IN_CLOSURE');}
}
export function plan(root) {
  root=path.resolve(root); const policy=JSON.parse(read(safeFile(root,POLICY_PATH)).toString());policyCheck(policy);
  const files=policy.files.map(([sourcePath,p,mode])=>{const bytes=read(safeFile(root,sourcePath));return {sourcePath,path:p,mode,bytes:bytes.length,sha256:digest(bytes)};}).sort((a,b)=>a.path.localeCompare(b.path,'en'));
  if(files.reduce((n,f)=>n+f.bytes,0)>LIMITS.totalBytes)fail('CONTROL_TOTAL_SIZE_LIMIT');
  // Reject new local module dependencies omitted from the explicit closure.
  const sources=new Set(files.map(f=>f.sourcePath));
  qualifyClosure(policy,new Map(files.map(f=>[f.sourcePath,read(safeFile(root,f.sourcePath)).toString()])));
  let dirtyInputs='UNKNOWN_GIT_NOT_AVAILABLE';
  try{dirtyInputs=execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','status','--porcelain=v1','--untracked-files=all','--',...sources],{cwd:root,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore'],windowsHide:true}).trim().split('\n').filter(Boolean);}catch{}
  const compatibility={businessArtifactSchema:2,projectId:policy.projectId,node:policy.externalInputs.node,hookPhases:policy.hookPhases,externalInputs:policy.externalInputs,contractHashes:Object.fromEntries(files.filter(f=>['deploy/policies/database-contract.v1.json','deploy/policies/database-semantic-contract.v1.json','deploy/policies/release-policy.json'].includes(f.sourcePath)).map(f=>[f.sourcePath,f.sha256]))};
  const core={kind:'deployment-control-plane-bundle.v1',schemaVersion:1,projectId:policy.projectId,layoutVersion:1,entrypoint:policy.entrypoint,compatibility,files};
  return {core,contentDigest:digest(encode(core)),dirtyInputs,deployable:false};
}
export function verifySource(root,s,env=process.env,sourcePlan=null) {
  subjectCheck(s); if(s.mode!=='formal')fail('CONTROL_FORMAL_SUBJECT_REQUIRED');
  const sha=/^[a-f0-9]{40}$/u;
  const diagnostics={actionsMatch:env.GITHUB_ACTIONS==='true',repositoryMatch:env.GITHUB_REPOSITORY===s.repository,runMatch:env.GITHUB_RUN_ID===s.candidateRunId,attemptMatch:env.GITHUB_RUN_ATTEMPT===s.candidateRunAttempt,
    eventRepositoryMatch:false,headRepositoryMatch:false,baseRepositoryMatch:false,numberValid:false,numberMatch:false,refMatch:false,headShaMatch:false,baseShaValid:false,originalShaValid:false,
    mergeCommitField:'missing',mergeObjectIsCommit:false,baseObjectIsCommit:false,headObjectIsCommit:false,mergeParentCountTwo:false,firstParentMatchesBase:false,secondParentMatchesHead:false,executedHeadMatch:false,closureHashesMatch:false};
  // Git replacement refs cannot substitute the object whose SHA GitHub supplied.
  const git=args=>execFileSync('git',['--no-optional-locks','--no-replace-objects','-c','core.fsmonitor=false','-c','core.untrackedCache=false',...args],{cwd:root,timeout:5000,maxBuffer:LIMITS.fileBytes+4096,windowsHide:true,stdio:['ignore','pipe','pipe']});
  try {
  if(!diagnostics.actionsMatch||!diagnostics.repositoryMatch||!diagnostics.runMatch||!diagnostics.attemptMatch)fail('CONTROL_CI_IDENTITY_REQUIRED');
  if(env.GITHUB_EVENT_NAME==='pull_request') {
    // GitHub identifies this run by its merge commit, while checkout executes
    // the reviewed head. Both identities must come from the original event.
    let event;
    try {
      if(typeof env.GITHUB_EVENT_PATH!=='string'||!path.isAbsolute(env.GITHUB_EVENT_PATH))fail('CONTROL_PR_EVENT_REQUIRED');
      event=JSON.parse(read(env.GITHUB_EVENT_PATH).toString('utf8'));
    } catch { fail('CONTROL_PR_EVENT_INVALID'); }
    const pr=event?.pull_request;
    const sameRepo=repo=>repo?.full_name===s.repository && repo.fork===false;
    Object.assign(diagnostics,{eventRepositoryMatch:sameRepo(event?.repository),headRepositoryMatch:sameRepo(pr?.head?.repo),baseRepositoryMatch:sameRepo(pr?.base?.repo),
      numberValid:Number.isSafeInteger(event?.number)&&event.number>0,numberMatch:pr?.number===event?.number,refMatch:env.GITHUB_REF===`refs/pull/${event?.number}/merge`,
      headShaMatch:pr?.head?.sha===s.sourceCommit,baseShaValid:sha.test(pr?.base?.sha||''),originalShaValid:sha.test(env.GITHUB_SHA||'')});
    // This event field may be null or stale. Report only its safe classification;
    // trust comes from the exact original GITHUB_SHA commit and its ordered parents.
    diagnostics.mergeCommitField=!pr||!Object.hasOwn(pr,'merge_commit_sha')?'missing':pr.merge_commit_sha===null?'null':!sha.test(pr.merge_commit_sha||'')?'invalid':pr.merge_commit_sha===env.GITHUB_SHA?'match':'different';
    if(!diagnostics.eventRepositoryMatch||!diagnostics.headRepositoryMatch||!diagnostics.baseRepositoryMatch
      ||!diagnostics.numberValid||!diagnostics.numberMatch||!diagnostics.refMatch||!diagnostics.headShaMatch||!diagnostics.baseShaValid||!diagnostics.originalShaValid)fail('CONTROL_PR_IDENTITY_MISMATCH');
    try {diagnostics.mergeObjectIsCommit=git(['cat-file','-t',env.GITHUB_SHA]).toString().trim()==='commit';}catch{}
    if(!diagnostics.mergeObjectIsCommit)fail('CONTROL_PR_IDENTITY_MISMATCH');
    const header=git(['cat-file','-p',env.GITHUB_SHA]).toString('utf8').split('\n\n',1)[0];
    const parents=header.split('\n').filter(line=>line.startsWith('parent ')).map(line=>line.slice(7));
    diagnostics.mergeParentCountTwo=parents.length===2&&parents.every(parent=>sha.test(parent));
    diagnostics.firstParentMatchesBase=parents[0]===pr.base.sha;
    diagnostics.secondParentMatchesHead=parents[1]===s.sourceCommit;
    if(!diagnostics.mergeParentCountTwo||!diagnostics.firstParentMatchesBase||!diagnostics.secondParentMatchesHead)fail('CONTROL_PR_IDENTITY_MISMATCH');
    try {diagnostics.baseObjectIsCommit=git(['cat-file','-t',pr.base.sha]).toString().trim()==='commit';diagnostics.headObjectIsCommit=git(['cat-file','-t',s.sourceCommit]).toString().trim()==='commit';}catch{}
    if(!diagnostics.baseObjectIsCommit||!diagnostics.headObjectIsCommit)fail('CONTROL_PR_IDENTITY_MISMATCH');
  } else if(env.GITHUB_SHA!==s.sourceCommit)fail('CONTROL_CI_IDENTITY_REQUIRED');
  diagnostics.executedHeadMatch=git(['rev-parse','HEAD']).toString().trim()===s.sourceCommit;
  if(!diagnostics.executedHeadMatch)fail('CONTROL_EXECUTED_HEAD_DRIFT');
  const result=sourcePlan||plan(root);
  for(const f of result.core.files){const committed=git(['show',`${s.sourceCommit}:${f.sourcePath}`]);if(digest(committed)!==f.sha256)fail('CONTROL_FORMAL_SOURCE_DRIFT');}
  diagnostics.closureHashesMatch=true;
  return {verified:true,contentDigest:result.contentDigest,diagnostics};
  } catch(error) {
    // Git errors can contain event paths or environment-derived values. Never
    // serialize their message, stdout or stderr into formal-source diagnostics.
    const blocked=new Error(/^CONTROL_[A-Z0-9_]+$/u.test(error.message)?error.message:'CONTROL_FORMAL_SOURCE_INVALID');
    blocked.controlSourceDiagnostics=diagnostics;throw blocked;
  }
}
export function packageBundle(root,output,subject,env=process.env) {
  subjectCheck(subject);const result=plan(root);if(subject.mode==='formal')verifySource(root,subject,env,result);
  const out=path.resolve(output),base=path.resolve(root);if(out===base||out.startsWith(base+path.sep))fail('CONTROL_OUTPUT_MUST_BE_EXTERNAL');
  if(fs.existsSync(out))fail('CONTROL_OUTPUT_EXISTS');
  const manifest={...result.core,contentDigest:result.contentDigest,subject};
  const manifestBytes=encode(manifest);
  const entries=result.core.files.map(f=>({...f,base64:read(safeFile(root,f.sourcePath)).toString('base64')}));
  for(const e of entries)if(digest(Buffer.from(e.base64,'base64'))!==e.sha256)fail('CONTROL_SOURCE_CHANGED_DURING_PACKAGE');
  const archiveBytes=encode({kind:'deployment-control-plane-archive.v1',schemaVersion:1,manifestBase64:manifestBytes.toString('base64'),entries});
  if(archiveBytes.length>LIMITS.archiveBytes)fail('CONTROL_ARCHIVE_SIZE_LIMIT');
  const descriptor={kind:'deployment-control-plane-descriptor.v1',archiveFile:ARCHIVE,manifestFile:MANIFEST,archiveSha256:digest(archiveBytes),manifestSha256:digest(manifestBytes),contentDigest:result.contentDigest,subject};
  verifyBytes(archiveBytes,manifestBytes,descriptor);
  fs.mkdirSync(out,{recursive:false,mode:0o700});
  for(const [name,bytes] of [[ARCHIVE,archiveBytes],[MANIFEST,manifestBytes],['control-plane.descriptor.json',encode(descriptor)]])fs.writeFileSync(path.join(out,name),bytes,{flag:'wx',mode:0o600});
  return descriptor;
}
export function assertDescriptor(d,expectedSubject=null) {
  keys(d,['kind','archiveFile','manifestFile','archiveSha256','manifestSha256','contentDigest','subject'],'CONTROL_DESCRIPTOR_FIELDS');
  if(d.kind!=='deployment-control-plane-descriptor.v1'||d.archiveFile!==ARCHIVE||d.manifestFile!==MANIFEST||![d.archiveSha256,d.manifestSha256,d.contentDigest].every(x=>HEX.test(x)))fail('CONTROL_DESCRIPTOR_INVALID');
  subjectCheck(d.subject);if(expectedSubject&&canonical(d.subject)!==canonical(expectedSubject))fail('CONTROL_EXPECTED_SUBJECT_MISMATCH');
}
function base64(value) {if(typeof value!=='string'||value.length>Math.ceil(LIMITS.fileBytes/3)*4)fail('CONTROL_BASE64_INVALID');const b=Buffer.from(value,'base64');if(b.length>LIMITS.fileBytes||b.toString('base64')!==value)fail('CONTROL_BASE64_INVALID');return b;}
export function verifyBytes(archiveBytes,manifestBytes,expected) {
  assertDescriptor(expected);
  if(digest(archiveBytes)!==expected.archiveSha256||digest(manifestBytes)!==expected.manifestSha256)fail('CONTROL_EXTERNAL_DIGEST_MISMATCH');
  const m=parse(manifestBytes,LIMITS.fileBytes),a=parse(archiveBytes);
  keys(m,['kind','schemaVersion','projectId','layoutVersion','entrypoint','compatibility','files','contentDigest','subject'],'CONTROL_MANIFEST_FIELDS');
  keys(a,['kind','schemaVersion','manifestBase64','entries'],'CONTROL_ARCHIVE_FIELDS');
  if(a.kind!=='deployment-control-plane-archive.v1'||a.schemaVersion!==1||!base64(a.manifestBase64).equals(manifestBytes))fail('CONTROL_ARCHIVE_MANIFEST_MISMATCH');
  if(m.kind!=='deployment-control-plane-bundle.v1'||m.schemaVersion!==1||m.projectId!=='zimeiti-caopanshou'||m.layoutVersion!==1||m.entrypoint!=='scripts/deploy-artifact-vnext.sh')fail('CONTROL_MANIFEST_INCOMPATIBLE');
  subjectCheck(m.subject);if(canonical(m.subject)!==canonical(expected.subject))fail('CONTROL_EXPECTED_SUBJECT_MISMATCH');
  const {contentDigest,subject,...core}=m;
  if(digest(encode(core))!==contentDigest||contentDigest!==expected.contentDigest)fail('CONTROL_CONTENT_DIGEST_MISMATCH');
  if(!Array.isArray(m.files)||!Array.isArray(a.entries)||m.files.length>LIMITS.entries||m.files.length!==a.entries.length)fail('CONTROL_INVENTORY_LIMIT');
  let total=0;const names=new Set();
  for(let i=0;i<m.files.length;i++){
    const f=m.files[i],e=a.entries[i];keys(f,['sourcePath','path','bytes','sha256','mode'],'CONTROL_FILE_FIELDS');keys(e,['sourcePath','path','bytes','sha256','mode','base64'],'CONTROL_ENTRY_FIELDS');
    relative(f.path);relative(f.sourcePath);const name=f.path.toLowerCase();if(names.has(name))fail('CONTROL_PATH_COLLISION');names.add(name);
    if(i&&m.files[i-1].path.localeCompare(f.path,'en')>=0)fail('CONTROL_FILES_NOT_SORTED');
    if(!['0400','0444','0500','0555'].includes(f.mode)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>LIMITS.fileBytes||!HEX.test(f.sha256))fail('CONTROL_ENTRY_METADATA_INVALID');
    const {base64:encoded,...header}=e,b=base64(encoded);if(canonical(header)!==canonical(f)||b.length!==f.bytes||digest(b)!==f.sha256)fail('CONTROL_ENTRY_BYTES_MISMATCH');total+=b.length;
  }
  if(total>LIMITS.totalBytes)fail('CONTROL_TOTAL_SIZE_LIMIT');
  const pe=a.entries.find(e=>e.path===POLICY_PATH);if(!pe)fail('CONTROL_POLICY_MISSING');const p=JSON.parse(base64(pe.base64));policyCheck(p);
  qualifyClosure(p,new Map(a.entries.map(e=>[e.sourcePath,base64(e.base64).toString()])));
  if(canonical(p.files.map(([sourcePath,p,mode])=>({sourcePath,path:p,mode})).sort((a,b)=>a.path.localeCompare(b.path,'en')))!==canonical(m.files.map(({sourcePath,path,mode})=>({sourcePath,path,mode}))))fail('CONTROL_MAPPING_MISMATCH');
  keys(m.compatibility,['businessArtifactSchema','projectId','node','hookPhases','externalInputs','contractHashes'],'CONTROL_COMPATIBILITY_FIELDS');
  if(m.compatibility.businessArtifactSchema!==2||m.compatibility.projectId!==m.projectId||m.compatibility.node!=='v24.19.0:137'||canonical(m.compatibility.externalInputs)!==canonical(p.externalInputs)||canonical(m.compatibility.hookPhases)!==canonical(p.hookPhases))fail('CONTROL_COMPATIBILITY_INVALID');
  const hashes=Object.fromEntries(m.files.filter(f=>['deploy/policies/database-contract.v1.json','deploy/policies/database-semantic-contract.v1.json','deploy/policies/release-policy.json'].includes(f.sourcePath)).map(f=>[f.sourcePath,f.sha256]));if(Object.keys(hashes).length!==3||canonical(hashes)!==canonical(m.compatibility.contractHashes))fail('CONTROL_CONTRACT_HASH_MISMATCH');
  return {manifest:m,entries:a.entries,descriptor:expected};
}
export function verifyPackage(directory,expected) {return verifyBytes(read(safeFile(directory,ARCHIVE),LIMITS.archiveBytes),read(safeFile(directory,MANIFEST)),expected);}
export function verifyCandidatePackage(directory,descriptor,run,repository) {
  assertDescriptor(descriptor);
  const s=descriptor.subject;
  if(s.mode!=='formal'||s.repository!==repository||run?.repository?.full_name!==repository||String(run?.id)!==s.candidateRunId||String(run?.run_attempt)!==s.candidateRunAttempt||run?.head_sha!==s.sourceCommit)fail('CONTROL_CANDIDATE_API_IDENTITY_MISMATCH');
  return verifyPackage(directory,descriptor);
}
export const CONTROL_COMPATIBILITY_SOURCE_PATHS = Object.freeze([
  '.github/workflows/control-plane-compatibility.yml',
  '.release/source-files.v1.json',
  'public/version.json',
  'scripts/deploy-artifact-vnext.sh', 'scripts/deployment-control-plane.mjs',
  'scripts/package-control-plane-compatibility.mjs',
  'scripts/verify-control-plane-compatibility-proof.mjs',
  'scripts/verify-package-control-plane-compatibility.mjs',
  'scripts/verify-prestop-adopt-readiness-compat.mjs',
]);
// This is a single, explicitly identified recovery. The original application,
// database contract and release-ready evidence remain immutable.
export function verifyControlCompatibilityProof(bytes,expectedSha256,{bundleBytes,bundleSha256,descriptor,identity}) {
  if(!Buffer.isBuffer(bytes)||!HEX.test(expectedSha256||'')||digest(bytes)!==expectedSha256)fail('CONTROL_COMPATIBILITY_PROOF_DIGEST');
  const p=parse(bytes,LIMITS.fileBytes);
  keys(p,['kind','schemaVersion','repository','business','control','invariants','sourceDiff'],'CONTROL_COMPATIBILITY_PROOF_FIELDS');
  if(p.kind!=='deployment-control-plane-compatibility-proof.v1'||p.schemaVersion!==1||p.repository!=='675929401-code/zimeiti-caopanshou')fail('CONTROL_COMPATIBILITY_PROOF_IDENTITY');
  const business={commit:'ede4b913378c5e61a4586f00c8ea592e18feb39f',releaseId:'candidate-ede4b913378c-r60',archiveSha256:'ec2d3ee308ffa8ab44c4d1475695b5cd90070869bc0077f83f9a3ddcd38e21c5',validationBundleSha256:'590969ce3c633b37cb7db17a73807da2c6ad56115f5fa1016f99531bf32c77be',controlDescriptorSha256:'e7b14238b786d39fc7c009ce40351f1447026b12a7fabd16419f250b2dfc262d',migrationManifestSha256:'6468942caa1c63c5996ae3faae49301b9af73bdfcbd96e767f490edb3e03d9c7',candidateRunId:'41353541526',candidateRunAttempt:'1',browserRunId:'41355998423',browserRunAttempt:'1',finalizeRunId:'41356526504',finalizeRunAttempt:'1'};
  keys(p.business,Object.keys(business),'CONTROL_COMPATIBILITY_BUSINESS_FIELDS');
  if(canonical(p.business)!==canonical(business)||bundleSha256!==business.validationBundleSha256||!Buffer.isBuffer(bundleBytes)||digest(bundleBytes)!==bundleSha256)fail('CONTROL_COMPATIBILITY_BUSINESS_MISMATCH');
  assertDescriptor(descriptor);
  keys(p.control,['descriptorSha256','sourceCommit','runId','runAttempt'],'CONTROL_COMPATIBILITY_CONTROL_FIELDS');
  const expectedControl={descriptorSha256:digest(encode(descriptor)),sourceCommit:descriptor.subject.sourceCommit,runId:descriptor.subject.candidateRunId,runAttempt:descriptor.subject.candidateRunAttempt};
  if(descriptor.subject.mode!=='formal'||descriptor.subject.repository!==p.repository||descriptor.subject.sourceCommit===business.commit||canonical(p.control)!==canonical(expectedControl))fail('CONTROL_COMPATIBILITY_CONTROL_MISMATCH');
  keys(p.sourceDiff,['base','head','paths','versionMetadata'],'CONTROL_COMPATIBILITY_SOURCE_FIELDS');
  if(p.sourceDiff.base!==business.commit||p.sourceDiff.head!==p.control.sourceCommit||!Array.isArray(p.sourceDiff.paths)||!p.sourceDiff.paths.length||new Set(p.sourceDiff.paths).size!==p.sourceDiff.paths.length||p.sourceDiff.paths.some(n=>!CONTROL_COMPATIBILITY_SOURCE_PATHS.includes(n))||canonical(p.sourceDiff.paths)!==canonical([...p.sourceDiff.paths].sort())||!['.release/source-files.v1.json','public/version.json','scripts/deploy-artifact-vnext.sh','scripts/deployment-control-plane.mjs'].every(n=>p.sourceDiff.paths.includes(n)))fail('CONTROL_COMPATIBILITY_SOURCE_DIFF');
  keys(p.sourceDiff.versionMetadata,['before','after'],'CONTROL_COMPATIBILITY_VERSION_FIELDS');
  const before={schemaVersion:1,sourceVersion:'R001597-20261102-66d1decb',revision:1597,sourceDigest:'66d1decb24c1a2b6be1a5be0775941c2fec7ca15bb5b11832ee28f2e91afe3e2',version:'R001597-20261102-66d1decb',hash:'R001597-20261102-66d1decb',timestamp:'2026-11-01T21:03:55.487Z'};
  const after=p.sourceDiff.versionMetadata.after;
  keys(p.sourceDiff.versionMetadata.before,Object.keys(before),'CONTROL_COMPATIBILITY_VERSION_FIELDS');
  keys(after,Object.keys(before),'CONTROL_COMPATIBILITY_VERSION_FIELDS');
  if(canonical(p.sourceDiff.versionMetadata.before)!==canonical(before)||after.schemaVersion!==1||!Number.isSafeInteger(after.revision)||after.revision<=before.revision||!HEX.test(after.sourceDigest||'')||after.sourceDigest===before.sourceDigest||typeof after.sourceVersion!=='string'||!new RegExp(`^R${String(after.revision).padStart(6,'0')}-[0-9]{8}-${after.sourceDigest.slice(0,8)}$`,'u').test(after.sourceVersion)||after.version!==after.sourceVersion||after.hash!==after.sourceVersion||typeof after.timestamp!=='string'||!Number.isFinite(Date.parse(after.timestamp))||new Date(after.timestamp).toISOString()!==after.timestamp||Date.parse(after.timestamp)<=Date.parse(before.timestamp))fail('CONTROL_COMPATIBILITY_VERSION_MISMATCH');
  const versionDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(after.timestamp)).replaceAll('-','');
  if(after.sourceVersion!==`R${String(after.revision).padStart(6,'0')}-${versionDay}-${after.sourceDigest.slice(0,8)}`)fail('CONTROL_COMPATIBILITY_VERSION_MISMATCH');
  keys(p.invariants,['contractHashes','hookSha256','configSha256','migrationManifestSha256'],'CONTROL_COMPATIBILITY_INVARIANT_FIELDS');
  const hashes={'deploy/policies/database-contract.v1.json':'854b6707ca14c789c8a76509124bcfd1c978c3dc0bef1352c7b9d9f41cd237f3','deploy/policies/database-semantic-contract.v1.json':'528fa60036daa2144dc3bb910331bf095484c252185c999fd812dcbf73b4bc11','deploy/policies/release-policy.json':'76c33de2b5f755ceaa211c76bb777dd4a100bfb5187538b9b6e416165b74c1dd'};
  keys(p.invariants.contractHashes,Object.keys(hashes),'CONTROL_COMPATIBILITY_CONTRACT_FIELDS');
  if(canonical(p.invariants.contractHashes)!==canonical(hashes)||p.invariants.hookSha256!=='1d309a6c490d5ee800580f091f3d157a750f162a2c467a256a99e826cf6bb5ed'||p.invariants.configSha256!=='0a182588cdfe748c2cbccb3ddc3f4ea89666dad8eadf4bdf483183eed68fab7b'||p.invariants.migrationManifestSha256!==business.migrationManifestSha256)fail('CONTROL_COMPATIBILITY_INVARIANT_MISMATCH');
  let b;try{b=JSON.parse(bundleBytes.toString());}catch{fail('CONTROL_COMPATIBILITY_BUNDLE_INVALID');}
  if(digest(encode(b.subject?.controlPlane))!==business.controlDescriptorSha256||b.subject?.controlPlane?.subject?.candidateRunId!==business.candidateRunId||b.subject?.controlPlane?.subject?.candidateRunAttempt!==business.candidateRunAttempt)fail('CONTROL_COMPATIBILITY_ORIGINAL_DESCRIPTOR');
  // Re-run every original release-ready gate against its original descriptor.
  // Only the separate control/application association is changed by this proof.
  verifyDeploymentBinding(bundleBytes,bundleSha256,b.subject.controlPlane,identity);
  if(identity?.service!=='web'||identity.commit!==business.commit||identity.releaseId!==business.releaseId||identity.archiveSha256!==business.archiveSha256)fail('CONTROL_COMPATIBILITY_RUNTIME_IDENTITY');
  return {verified:true,proof:p};
}
export function verifyDeploymentBinding(bundleBytes,expectedBundleSha256,descriptor,{service,archiveSha256,releaseId,commit,sourceVersion,buildId,buildOutputDigest,compatibilityProofBytes=null,compatibilityProofSha256=null}) {
  if(!HEX.test(expectedBundleSha256)||digest(bundleBytes)!==expectedBundleSha256)fail('CONTROL_RELEASE_BUNDLE_DIGEST_MISMATCH');
  if(bundleBytes.length>LIMITS.fileBytes)fail('CONTROL_RELEASE_BUNDLE_SIZE_LIMIT');
  let b;try{b=JSON.parse(bundleBytes.toString());}catch{fail('CONTROL_RELEASE_BUNDLE_JSON_INVALID');}
  keys(b,['schemaVersion','bundleId','scope','subject','target','status','attestations','summary'],'CONTROL_RELEASE_BUNDLE_FIELDS');
  keys(b.subject,['commit','sourceVersion','services','builds','buildOutputDigests','candidatePayloads','controlPlane'],'CONTROL_RELEASE_SUBJECT_FIELDS');
  keys(b.scope,['receiptId','receiptSha256','classification','input','browserAcceptance','requiredValidations'],'CONTROL_RELEASE_SCOPE_FIELDS');
  keys(b.scope.input,['kind','base','head','rangeMode','trustedBase'],'CONTROL_RELEASE_INPUT_FIELDS');
  keys(b.scope.browserAcceptance,['preciseRoute','requiredRoutes','routeRuleIds','explicitRoutesRequired','explicitRoutesProvided','unresolvedPaths'],'CONTROL_RELEASE_BROWSER_FIELDS');
  keys(b.summary,['requiredCount','passedCount','pendingCount','failedCount'],'CONTROL_RELEASE_SUMMARY_FIELDS');
  for(const name of ['builds','buildOutputDigests','candidatePayloads'])keys(b.subject[name],['web','voice'],'CONTROL_RELEASE_SERVICE_FIELDS');
  if(b.schemaVersion!=='zimeiti-release-change-validation-bundle.v1'||b.target!=='release-ready'||b.status!=='release-ready'||b.scope.input.trustedBase!==true||b.scope.input.head!==b.subject.commit)fail('CONTROL_RELEASE_READY_REQUIRED');
  const {bundleId,...core}=b;if(bundleId!==`validation-${digest(Buffer.from(canonical(core))).slice(0,24)}`)fail('CONTROL_RELEASE_BUNDLE_ID_MISMATCH');
  assertDescriptor(descriptor);assertDescriptor(b.subject.controlPlane);
  if((compatibilityProofBytes===null)!==(compatibilityProofSha256===null))fail('CONTROL_COMPATIBILITY_PROOF_PAIR_REQUIRED');
  if(compatibilityProofBytes!==null){verifyControlCompatibilityProof(compatibilityProofBytes,compatibilityProofSha256,{bundleBytes,bundleSha256:expectedBundleSha256,descriptor,identity:{service,archiveSha256,releaseId,commit,sourceVersion,buildId,buildOutputDigest}});}
  else if(canonical(b.subject.controlPlane)!==canonical(descriptor)||descriptor.subject.mode!=='formal'||b.subject.commit!==descriptor.subject.sourceCommit)fail('CONTROL_RELEASE_CONTROL_PLANE_MISMATCH');
  if(!Array.isArray(b.subject.services)||!b.subject.services.includes('web')||!b.subject.services.includes(service)||!['web','voice'].includes(service)||new Set(b.subject.services).size!==b.subject.services.length||b.subject.services.some(s=>!['web','voice'].includes(s)))fail('CONTROL_RELEASE_SERVICE_MISMATCH');
  for(const s of ['web','voice'])if(b.subject.candidatePayloads[s]!==null){const payload=b.subject.candidatePayloads[s];keys(payload,['releaseId','artifactDigest','archiveSha256','fileCount','totalBytes'],'CONTROL_RELEASE_PAYLOAD_FIELDS');if(!HEX.test(payload.archiveSha256)||!HEX.test(payload.artifactDigest)||!Number.isSafeInteger(payload.fileCount)||payload.fileCount<1||!Number.isSafeInteger(payload.totalBytes)||payload.totalBytes<1)fail('CONTROL_RELEASE_PAYLOAD_INVALID');}
  const payload=b.subject.candidatePayloads[service];if(!payload||payload.archiveSha256!==archiveSha256||payload.releaseId!==releaseId||!HEX.test(archiveSha256))fail('CONTROL_RELEASE_ARTIFACT_MISMATCH');
  for(const s of ['web','voice']){if(b.subject.services.includes(s)){if(typeof b.subject.builds[s]!=='string'||!b.subject.builds[s]||!HEX.test(b.subject.buildOutputDigests[s])||!b.subject.candidatePayloads[s])fail('CONTROL_RELEASE_BUILD_IDENTITY_MISMATCH');}else if(b.subject.builds[s]!==null||b.subject.buildOutputDigests[s]!==null||b.subject.candidatePayloads[s]!==null)fail('CONTROL_RELEASE_UNREQUESTED_SERVICE');}
  if(b.subject.commit!==commit||b.subject.sourceVersion!==sourceVersion||b.subject.builds[service]!==buildId||b.subject.buildOutputDigests[service]!==buildOutputDigest)fail('CONTROL_RELEASE_BUILD_IDENTITY_MISMATCH');
  if(!Array.isArray(b.attestations)||!Array.isArray(b.scope.requiredValidations)||b.attestations.length===0)fail('CONTROL_RELEASE_ATTESTATIONS_REQUIRED');
  for(const att of b.attestations){keys(att,['validationId','status','executor','evidenceRef','evidenceSha256','signatureRef','signatureSha256'],'CONTROL_RELEASE_ATTESTATION_FIELDS');if(att.status!=='passed'||!['ci','external-browser','external-verifier'].includes(att.executor)||typeof att.evidenceRef!=='string'||!HEX.test(att.evidenceSha256))fail('CONTROL_RELEASE_ATTESTATIONS_REQUIRED');relative(att.evidenceRef);if(att.executor==='external-browser'){if(typeof att.signatureRef!=='string'||!HEX.test(att.signatureSha256))fail('CONTROL_RELEASE_SIGNATURE_REQUIRED');relative(att.signatureRef);}else if(att.signatureRef!==null||att.signatureSha256!==null)fail('CONTROL_RELEASE_SIGNATURE_UNEXPECTED');}
  const ids=b.attestations.map(a=>a.validationId).sort();if(new Set(ids).size!==ids.length||canonical(ids)!==canonical([...b.scope.requiredValidations].sort())||b.summary.requiredCount!==ids.length||b.summary.passedCount!==ids.length||b.summary.pendingCount!==0||b.summary.failedCount!==0)fail('CONTROL_RELEASE_SUMMARY_MISMATCH');
  return {verified:true,commit:b.subject.commit,service,releaseId,archiveSha256,controlPlane:descriptor};
}
function inventory(root,files,requireRoot) {
  const dirs=new Set(['']);for(const f of files){let d=path.posix.dirname(f);while(d!=='.'){dirs.add(d);d=path.posix.dirname(d);}}
  const found=[];function walk(dir,prefix=''){const ds=fs.lstatSync(dir);if(requireRoot&&(ds.uid!==0||ds.gid!==0||(ds.mode&0o222)))fail('CONTROL_DIRECTORY_UNSEALED');for(const e of fs.readdirSync(dir,{withFileTypes:true})){const n=prefix+e.name,f=path.join(dir,e.name),s=fs.lstatSync(f);if(s.isSymbolicLink())fail('CONTROL_LINK_FORBIDDEN');if(s.isDirectory()){if(!dirs.has(n))fail('CONTROL_EXTRA_DIRECTORY');walk(f,n+'/');}else{regular(f);found.push(n);}}}walk(root);return found.sort();
}
export function verifyInstalled(root,receipt,expected,{requireRoot=true}={}) {
  keys(receipt,['kind','directory','verifierSha256','descriptor','inventory'],'CONTROL_RECEIPT_FIELDS');
  if(receipt.kind!=='deployment-control-plane-installation.v1'||path.resolve(root)!==receipt.directory||canonical(receipt.descriptor)!==canonical(expected))fail('CONTROL_RECEIPT_BINDING');
  const m=parse(read(safeFile(root,MANIFEST)));if(digest(encode(m))!==expected.manifestSha256||canonical(m.subject)!==canonical(expected.subject))fail('CONTROL_INSTALLED_MANIFEST_MISMATCH');
  if(canonical(receipt.inventory)!==canonical(m.files)||canonical(inventory(root,m.files.map(f=>f.path),requireRoot))!==canonical([...m.files.map(f=>f.path),MANIFEST].sort()))fail('CONTROL_INSTALLED_INVENTORY_MISMATCH');
  for(const f of [...m.files,{path:MANIFEST,mode:'0444',sha256:expected.manifestSha256}]){const file=safeFile(root,f.path),s=regular(file);if(digest(read(file))!==f.sha256)fail('CONTROL_INSTALLED_BYTES_MISMATCH');if(requireRoot&&(s.uid!==0||s.gid!==0||(s.mode&0o777)!==parseInt(f.mode,8)))fail('CONTROL_INSTALLED_METADATA_MISMATCH');}
  const {subject,contentDigest,...core}=m;if(digest(encode(core))!==expected.contentDigest||contentDigest!==expected.contentDigest)fail('CONTROL_INSTALLED_CONTENT_MISMATCH');
  return {verified:true,directory:path.resolve(root),descriptor:expected};
}
function trustedParent(parent,requireRoot) {
  let cursor=path.resolve(parent);while(true){const s=fs.lstatSync(cursor);if(!s.isDirectory()||s.isSymbolicLink()||(requireRoot&&(s.uid!==0||s.gid!==0||(s.mode&0o022))))fail('CONTROL_PARENT_UNTRUSTED');const next=path.dirname(cursor);if(next===cursor)break;cursor=next;}
}
export function installVerified(verified,parent,receiptPath,verifierSha256,{execute=false,requireRoot=true,afterRename=null}={}) {
  if(!HEX.test(verifierSha256))fail('CONTROL_VERIFIER_DIGEST_REQUIRED');
  // Retain only immutable, verified bytes at this boundary, even for imported callers.
  const mb=encode(verified.manifest);
  verified=verifyBytes(encode({kind:'deployment-control-plane-archive.v1',schemaVersion:1,manifestBase64:mb.toString('base64'),entries:verified.entries}),mb,verified.descriptor);
  if(verified.descriptor.subject.mode!=='formal')fail('CONTROL_REHEARSAL_INSTALL_FORBIDDEN');
  if(requireRoot&&(process.platform!=='linux'||process.geteuid?.()!==0))fail('CONTROL_LINUX_ROOT_REQUIRED');
  if(requireRoot&&`${process.version}:${process.versions.modules}`!=='v24.19.0:137')fail('CONTROL_NODE_ABI_MISMATCH');
  parent=path.resolve(parent);receiptPath=path.resolve(receiptPath);trustedParent(parent,requireRoot);trustedParent(path.dirname(receiptPath),requireRoot);
  // Subject is part of the immutable identity: reruns can supply identical
  // content with a distinct candidate attempt without colliding with old trust.
  const destination=path.join(parent,`V1.0-${verified.descriptor.manifestSha256.slice(0,12)}`);
  if(receiptPath===destination||receiptPath.startsWith(destination+path.sep)||fs.existsSync(receiptPath)&&fs.lstatSync(receiptPath).isSymbolicLink())fail('CONTROL_RECEIPT_PATH_INVALID');
  const receipt={kind:'deployment-control-plane-installation.v1',directory:destination,verifierSha256,descriptor:verified.descriptor,inventory:verified.manifest.files};
  if(fs.existsSync(destination)){verifyInstalled(destination,receipt,verified.descriptor,{requireRoot});if(fs.existsSync(receiptPath)){if(!read(receiptPath).equals(encode(receipt)))fail('CONTROL_RECEIPT_COLLISION');return {status:'already-installed',...receipt};}if(!execute)return {status:'installed-unrecorded',...receipt};}
  if(!execute)return {status:'plan-no-writes',...receipt};
  if(fs.existsSync(receiptPath)&&!read(receiptPath).equals(encode(receipt)))fail('CONTROL_RECEIPT_COLLISION');
  if(!fs.existsSync(destination)){
    const stage=fs.mkdtempSync(path.join(parent,'.control-stage-'));fs.chmodSync(stage,0o700);
    try{
      for(const e of verified.entries){const dest=path.join(stage,...e.path.split('/'));fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,base64(e.base64),{flag:'wx',mode:parseInt(e.mode,8)});fs.chmodSync(dest,parseInt(e.mode,8));}
      fs.writeFileSync(path.join(stage,MANIFEST),encode(verified.manifest),{flag:'wx',mode:0o444});
      function seal(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.isDirectory())seal(path.join(d,e.name));}fs.chmodSync(d,0o555);}seal(stage);
      verifyInstalled(stage,{...receipt,directory:stage},verified.descriptor,{requireRoot});
      // Same-parent exclusive reservation prevents two legitimate installers replacing a directory.
      const lock=destination+'.install-lock';const fd=fs.openSync(lock,'wx',0o600);
      try{if(fs.existsSync(destination))fail('CONTROL_INSTALL_COLLISION');fs.renameSync(stage,destination);}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
      if(afterRename)afterRename();
    }catch(error){error.controlInstallState=fs.existsSync(destination)?'installed-unrecorded':'staging-retained';error.operationStage=stage;throw error;}
  }
  verifyInstalled(destination,receipt,verified.descriptor,{requireRoot});
  try {
    if(!fs.existsSync(receiptPath)){const temp=receiptPath+'.'+crypto.randomBytes(12).toString('hex')+'.tmp';fs.writeFileSync(temp,encode(receipt),{flag:'wx',mode:0o444});try{fs.linkSync(temp,receiptPath);}finally{fs.unlinkSync(temp);}}
    if(!read(receiptPath).equals(encode(receipt)))fail('CONTROL_RECEIPT_COLLISION');
  } catch(error) {error.controlInstallState='installed-unrecorded';throw error;}
  return {status:'installed',...receipt};
}
function args(argv){const a=new Map();for(let i=0;i<argv.length;i++){const t=argv[i];if(!t.startsWith('--')||a.has(t))fail('CONTROL_ARGUMENT_INVALID');a.set(t,argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:'1');}return a;}
export function main(argv=process.argv.slice(2)) {
  const [command,...rest]=argv,a=args(rest),root=path.resolve(a.get('--root')||process.cwd());
  const allowed={plan:['--root'],'verify-source':['--root','--subject'],package:['--root','--output','--subject'],verify:['--package','--expected-descriptor'],install:['--package','--expected-descriptor','--parent','--receipt','--verifier-sha256','--plan','--execute'],'verify-installed':['--installed-root','--expected-descriptor','--receipt','--receipt-sha256','--verifier-sha256'],'verify-deployment-binding':['--expected-descriptor','--release-validation-bundle','--release-validation-sha256','--service','--artifact-sha256','--release-id','--commit','--source-version','--build-id','--build-output-digest','--compatibility-proof','--compatibility-proof-sha256']};
  if(!allowed[command]||[...a.keys()].some(k=>!allowed[command].includes(k)))fail('CONTROL_ARGUMENT_INVALID');
  if(command==='plan')return plan(root);
  const sourceSubject=()=>{try{return JSON.parse(a.get('--subject'));}catch{fail('CONTROL_SUBJECT_JSON_INVALID');}};
  if(command==='verify-source')return verifySource(root,sourceSubject(),process.env);
  if(command==='package')return packageBundle(root,a.get('--output'),sourceSubject(),process.env);
  const expected=JSON.parse(read(path.resolve(a.get('--expected-descriptor'))));assertDescriptor(expected);
  if(command==='verify-deployment-binding'){
    if(a.has('--compatibility-proof')!==a.has('--compatibility-proof-sha256'))fail('CONTROL_COMPATIBILITY_PROOF_PAIR_REQUIRED');
    let compatibilityProofBytes=null,compatibilityProofSha256=null;
    if(a.has('--compatibility-proof')){
      if(process.platform!=='linux'||process.geteuid?.()!==0)fail('CONTROL_COMPATIBILITY_ROOT_REQUIRED');
      const proofPath=path.resolve(a.get('--compatibility-proof'));trustedParent(path.dirname(proofPath),true);const s=regular(proofPath);
      if(s.uid!==0||s.gid!==0||(s.mode&0o022))fail('CONTROL_COMPATIBILITY_PROOF_UNTRUSTED');
      compatibilityProofBytes=read(proofPath);compatibilityProofSha256=a.get('--compatibility-proof-sha256');
    }
    return verifyDeploymentBinding(read(path.resolve(a.get('--release-validation-bundle'))),a.get('--release-validation-sha256'),expected,{service:a.get('--service'),archiveSha256:a.get('--artifact-sha256'),releaseId:a.get('--release-id'),commit:a.get('--commit'),sourceVersion:a.get('--source-version'),buildId:a.get('--build-id'),buildOutputDigest:a.get('--build-output-digest'),compatibilityProofBytes,compatibilityProofSha256});
  }
  if(command==='verify')return {verified:true,...verifyPackage(path.resolve(a.get('--package')),expected).descriptor};
  const self=fs.realpathSync(process.argv[1]);if(!HEX.test(a.get('--verifier-sha256')||'')||digest(read(self))!==a.get('--verifier-sha256'))fail('CONTROL_VERIFIER_DIGEST_MISMATCH');
  if(command==='verify-installed'){
    const rp=path.resolve(a.get('--receipt'));if(!HEX.test(a.get('--receipt-sha256')||'')||digest(read(rp))!==a.get('--receipt-sha256'))fail('CONTROL_RECEIPT_DIGEST_MISMATCH');const receipt=parse(read(rp));if(receipt.verifierSha256!==a.get('--verifier-sha256'))fail('CONTROL_VERIFIER_RECEIPT_MISMATCH');return verifyInstalled(a.get('--installed-root'),receipt,expected);
  }
  if(command==='install'){
    if(a.has('--execute')===a.has('--plan'))fail('CONTROL_INSTALL_MODE_REQUIRED');
    return installVerified(verifyPackage(a.get('--package'),expected),a.get('--parent'),a.get('--receipt'),a.get('--verifier-sha256'),{execute:a.has('--execute')});
  }
  fail('CONTROL_COMMAND_UNKNOWN');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{process.stdout.write(canonical(main())+'\n');}catch(error){process.stderr.write(canonical({error:error.message,status:error.controlInstallState||'blocked',operationStage:error.operationStage||null,...(error.controlSourceDiagnostics?{sourceDiagnostics:error.controlSourceDiagnostics}:{})})+'\n');process.exitCode=2;}}
