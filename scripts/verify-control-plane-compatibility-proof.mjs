#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canonical,digest,verifyControlCompatibilityProof,verifyDeploymentBinding,CONTROL_COMPATIBILITY_SOURCE_PATHS} from './deployment-control-plane.mjs';

const checks=[];
const check=(name,fn)=>{fn();checks.push(name);};
const rejected=(name,fn)=>check(name,()=>assert.throws(fn,/CONTROL_/u));
const bytes=value=>Buffer.from(canonical(value)+'\n');
if(process.argv.length!==4||process.argv[2]!=='--original-bundle')throw Error('EXACT_ORIGINAL_BUNDLE_REQUIRED');
const original=fs.readFileSync(process.argv[3]);
const bundleSha256='590969ce3c633b37cb7db17a73807da2c6ad56115f5fa1016f99531bf32c77be';
assert.equal(digest(original),bundleSha256);
const b=JSON.parse(original),old=b.subject.controlPlane;
const identity={service:'web',archiveSha256:b.subject.candidatePayloads.web.archiveSha256,releaseId:b.subject.candidatePayloads.web.releaseId,commit:b.subject.commit,sourceVersion:b.subject.sourceVersion,buildId:b.subject.builds.web,buildOutputDigest:b.subject.buildOutputDigests.web};
// This descriptor is an association-test fixture. Normal package installation
// and CI source provenance are exercised separately; this cannot deploy it.
const descriptor={...structuredClone(old),subject:{...old.subject,sourceCommit:'f'.repeat(40),candidateRunId:'99999999999',candidateRunAttempt:'1'}};
const proof={kind:'deployment-control-plane-compatibility-proof.v1',schemaVersion:1,repository:'675929401-code/zimeiti-caopanshou',business:{commit:identity.commit,releaseId:identity.releaseId,archiveSha256:identity.archiveSha256,validationBundleSha256:bundleSha256,controlDescriptorSha256:'e7b14238b786d39fc7c009ce40351f1447026b12a7fabd16419f250b2dfc262d',migrationManifestSha256:'6468942caa1c63c5996ae3faae49301b9af73bdfcbd96e767f490edb3e03d9c7',candidateRunId:'41353541526',candidateRunAttempt:'1',browserRunId:'41355998423',browserRunAttempt:'1',finalizeRunId:'41356526504',finalizeRunAttempt:'1'},control:{descriptorSha256:digest(bytes(descriptor)),sourceCommit:descriptor.subject.sourceCommit,runId:descriptor.subject.candidateRunId,runAttempt:'1'},invariants:{contractHashes:{'deploy/policies/database-contract.v1.json':'854b6707ca14c789c8a76509124bcfd1c978c3dc0bef1352c7b9d9f41cd237f3','deploy/policies/database-semantic-contract.v1.json':'528fa60036daa2144dc3bb910331bf095484c252185c999fd812dcbf73b4bc11','deploy/policies/release-policy.json':'76c33de2b5f755ceaa211c76bb777dd4a100bfb5187538b9b6e416165b74c1dd'},hookSha256:'1d309a6c490d5ee800580f091f3d157a750f162a2c467a256a99e826cf6bb5ed',configSha256:'0a182588cdfe748c2cbccb3ddc3f4ea89666dad8eadf4bdf483183eed68fab7b',migrationManifestSha256:'6468942caa1c63c5996ae3faae49301b9af73bdfcbd96e767f490edb3e03d9c7'},sourceDiff:{base:identity.commit,head:descriptor.subject.sourceCommit,paths:[...CONTROL_COMPATIBILITY_SOURCE_PATHS].sort(),versionMetadata:{before:{schemaVersion:1,sourceVersion:'R001597-20261102-66d1decb',revision:1597,sourceDigest:'66d1decb24c1a2b6be1a5be0775941c2fec7ca15bb5b11832ee28f2e91afe3e2',version:'R001597-20261102-66d1decb',hash:'R001597-20261102-66d1decb',timestamp:'2026-11-01T21:03:55.487Z'},after:{schemaVersion:1,sourceVersion:'R001598-20261102-aaaaaaaa',revision:1598,sourceDigest:'a'.repeat(64),version:'R001598-20261102-aaaaaaaa',hash:'R001598-20261102-aaaaaaaa',timestamp:'2026-11-02T01:00:00.000Z'}}}};
const context={bundleBytes:original,bundleSha256,descriptor,identity};
const verify=(p=proof,c=context)=>verifyControlCompatibilityProof(bytes(p),digest(bytes(p)),c);
const binding=p=>verifyDeploymentBinding(original,bundleSha256,descriptor,{...identity,compatibilityProofBytes:bytes(p),compatibilityProofSha256:digest(bytes(p))});
check('original release-ready binding remains valid',()=>assert.equal(verifyDeploymentBinding(original,bundleSha256,old,identity).verified,true));
check('valid exact-business compatibility association accepted',()=>assert.equal(verify().verified,true));
check('binding preserves original release-ready checks',()=>assert.equal(binding(proof).verified,true));
rejected('cross-commit without proof rejected',()=>verifyDeploymentBinding(original,bundleSha256,descriptor,identity));
for(const field of Object.keys(proof.business))rejected(`business ${field} drift rejected`,()=>{const p=structuredClone(proof);p.business[field]+='0';verify(p);});
for(const field of Object.keys(proof.control))rejected(`control ${field} drift rejected`,()=>{const p=structuredClone(proof);p.control[field]+='0';verify(p);});
for(const field of Object.keys(identity))rejected(`runtime ${field} drift rejected`,()=>verify(proof,{...context,identity:{...identity,[field]:identity[field]+'0'}}));
for(const field of Object.keys(proof.invariants.contractHashes))rejected(`contract ${field} drift rejected`,()=>{const p=structuredClone(proof);p.invariants.contractHashes[field]='0'.repeat(64);verify(p);});
for(const field of ['hookSha256','configSha256','migrationManifestSha256'])rejected(`${field} invariant drift rejected`,()=>{const p=structuredClone(proof);p.invariants[field]='0'.repeat(64);verify(p);});
for(const field of [null,'business','control','invariants','sourceDiff'])rejected(`unknown ${field||'root'} field rejected`,()=>{const p=structuredClone(proof);(field?p[field]:p).unexpected=true;verify(p);});
for(const paths of [[],['src/app/page.tsx'],[...proof.sourceDiff.paths,proof.sourceDiff.paths[0]],[...proof.sourceDiff.paths].reverse(),proof.sourceDiff.paths.filter(p=>p!=='scripts/deploy-artifact-vnext.sh')])rejected('invalid source diff rejected',()=>{const p=structuredClone(proof);p.sourceDiff.paths=paths;verify(p);});
rejected('wrong proof digest rejected',()=>verifyControlCompatibilityProof(bytes(proof),'0'.repeat(64),context));
rejected('noncanonical proof rejected',()=>{const raw=Buffer.from(JSON.stringify(proof));verifyControlCompatibilityProof(raw,digest(raw),context);});
rejected('original bundle byte drift rejected',()=>verify(proof,{...context,bundleBytes:Buffer.concat([original,Buffer.from(' ')])}));
for(const pair of [{compatibilityProofBytes:bytes(proof)},{compatibilityProofSha256:digest(bytes(proof))}])rejected('partial proof pair rejected',()=>verifyDeploymentBinding(original,bundleSha256,descriptor,{...identity,...pair}));
for(const field of ['schemaVersion','sourceVersion','revision','sourceDigest','version','hash','timestamp'])rejected(`version ${field} drift rejected`,()=>{const p=structuredClone(proof);p.sourceDiff.versionMetadata.after[field]=field==='revision'?1597:field==='timestamp'?'invalid':null;verify(p);});
rejected('missing declared version change rejected',()=>{const p=structuredClone(proof);p.sourceDiff.paths=p.sourceDiff.paths.filter(n=>n!=='public/version.json');verify(p);});
rejected('missing generated source metadata rejected',()=>{const p=structuredClone(proof);p.sourceDiff.paths=p.sourceDiff.paths.filter(n=>n!=='.release/source-files.v1.json');verify(p);});
rejected('source repository identity change rejected',()=>{const p=structuredClone(proof);p.sourceDiff.paths.push('.release/source-repo.json');p.sourceDiff.paths.sort();verify(p);});
rejected('unknown version metadata rejected',()=>{const p=structuredClone(proof);p.sourceDiff.versionMetadata.after.unexpected=true;verify(p);});
rejected('changed original version record rejected',()=>{const p=structuredClone(proof);p.sourceDiff.versionMetadata.before.revision=1596;verify(p);});
rejected('version day must match Shanghai timestamp',()=>{const p=structuredClone(proof);for(const k of ['sourceVersion','version','hash'])p.sourceDiff.versionMetadata.after[k]='R001598-20261103-aaaaaaaa';verify(p);});
process.stdout.write(JSON.stringify({status:'passed',checks:checks.length,originalBundleSha256:bundleSha256,associationFixtureOnly:true})+'\n');
