import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalReleaseAccepted} from './local-revision.mjs';

const [repoInput,outputInput]=process.argv.slice(2);
if(!repoInput||!outputInput)throw new Error('Expected <managed-release-repository> <new-authorization.json>');
const root=process.cwd();
const accepted=assertLocalReleaseAccepted(root);
const repo=path.resolve(repoInput);
const git=args=>{const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error('GIT_VERIFICATION_FAILED');return r.stdout;};
if(git(['status','--porcelain']).trim())throw new Error('RELEASE_REPOSITORY_NOT_CLEAN');
const commit=git(['rev-parse','HEAD']).trim();
const manifest=git(['show',`${commit}:.release/source-files.v1.json`]);
const source=JSON.parse(fs.readFileSync(path.join(root,'.release/source-files.v1.json'),'utf8'));
if(JSON.parse(manifest).sourceFingerprint!==source.sourceFingerprint)throw new Error('RELEASE_SOURCE_MISMATCH');
if(JSON.parse(git(['show',`${commit}:public/version.json`])).sourceVersion!==accepted.sourceVersion)throw new Error('RELEASE_VERSION_MISMATCH');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const authorization={schemaVersion:1,scope:'web',commit,sourceVersion:accepted.sourceVersion,sourceManifestSha256:hash(manifest),
  localAcceptanceSha256:hash(fs.readFileSync(path.join(root,'.codex-evidence/local-release-acceptance.v1.json'))),
  createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+24*60*60*1000).toISOString()};
fs.writeFileSync(path.resolve(outputInput),JSON.stringify(authorization,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({created:true,commit,sourceVersion:accepted.sourceVersion}));
