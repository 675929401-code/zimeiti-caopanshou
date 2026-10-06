#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
commit="${1:-}"; mode="${2:-}"
[[ "$commit" =~ ^[a-f0-9]{40}$ && "$mode" =~ ^(rehearsal|deploy)$ ]] || exit 2
export PATH=/data/toolchains/node-v24.19.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
repository=/data/git/zimeiti-caopanshou-source-vnext-clean-20260905.git
base=/data/release-automation
[[ "$(git --git-dir="$repository" rev-parse "$commit^{commit}")" == "$commit" ]] || exit 2
if [[ "$mode" == rehearsal ]]; then
  git --git-dir="$repository" show "$commit:package.json" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const p=JSON.parse(s);if(!p.scripts?.build)process.exit(1);console.log("REHEARSAL_COMMIT_READABLE");});'
  curl --fail --silent --max-time 15 https://zyuani8.com/api/version >/dev/null
  echo 'REHEARSAL_PASS: receive, durable queue, worker and fixed commit; production unchanged'
  exit 0
fi
[[ -f "$base/authorizations/$commit.json" ]] || { echo 'LOCAL_ACCEPTANCE_REQUIRED'; exit 2; }
work="$base/builds/$commit"
mkdir -p "$base/builds" "$base/artifacts"
if [[ ! -d "$work" ]]; then git clone --no-hardlinks "$repository" "$work"; fi
[[ "$(git -C "$work" rev-parse --show-toplevel)" == "$work" ]] || exit 2
[[ -z "$(git -C "$work" status --porcelain)" ]] || { echo 'BUILD_WORKTREE_NOT_CLEAN'; exit 2; }
git -C "$work" checkout --detach "$commit"
cd "$work"
[[ "$(node --version)" == v24.19.0 && "$(pnpm --version)" == 9.0.0 ]] || { echo 'TOOLCHAIN_MISMATCH'; exit 2; }
export PNPM_CLI_PATH="$(readlink -f "$(command -v pnpm)")"
[[ -f "$PNPM_CLI_PATH" && "$PNPM_CLI_PATH" == */pnpm.cjs ]] || { echo 'PNPM_CLI_IDENTITY_MISMATCH'; exit 2; }
# Environment remains a protected runtime reference, outside the Git history.
if [[ ! -e .env.local ]]; then ln -s /data/web/shared/env/.env.local .env.local; fi
[[ "$(readlink -f .env.local)" == /data/web/shared/env/.env.local ]] || { echo 'ENVIRONMENT_REFERENCE_MISMATCH'; exit 2; }
# Restore exactly the pinned asset bytes; never hard-link files to a mutable build.
node --input-type=module <<'NODE'
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const manifest=JSON.parse(fs.readFileSync('deploy/manifests/public-assets.v1.json','utf8'));
if(!/^sha256-[a-f0-9]{64}$/.test(manifest.assetVersion))throw new Error('Invalid asset version');
const root=path.resolve('/data/web/shared/assets/releases',manifest.assetVersion);
if(!fs.existsSync(path.join(root,'.release/public-assets.ready.v1.json')))throw new Error('Pinned asset release is not ready');
const tracked=new Set(execFileSync('git',['ls-files','--cached','-z','--','public'],{encoding:'utf8'}).split('\0'));
const verifiedExternal=[];
for(const file of manifest.files){
 if(!file.path.startsWith('public/')||file.path.split('/').includes('..')||path.isAbsolute(file.path))throw new Error('Unsafe asset path');
 const source=path.join(root,file.path),destination=path.resolve(file.path);
 const hash=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
 if(hash!==file.sha256)throw new Error('Pinned asset checksum mismatch');
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 if(fs.existsSync(destination)){
   if(crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')!==hash)throw new Error('Existing asset mismatch');
 }else fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
 if(!tracked.has(file.path))verifiedExternal.push('/'+[...file.path].map(c=>'*?[]!#'.includes(c)||c.charCodeAt(0)===92?String.fromCharCode(92)+c:c).join(''));
}
// Only exact, checksum-verified external asset paths are excluded in this clone.
// Tracked changes and any unexpected files still fail the clean build gate.
const exclude=execFileSync('git',['rev-parse','--git-path','info/exclude'],{encoding:'utf8'}).trim();
if(verifiedExternal.length)fs.appendFileSync(exclude,'\n# Pinned external release assets\n'+verifiedExternal.join('\n')+'\n');
console.log('PINNED_ASSETS_READY');
NODE
# Dependencies are restored from a persistent store, never copied into Git.
pnpm install --frozen-lockfile --prefer-offline
node scripts/release-workflow.mjs audit
node node_modules/typescript/bin/tsc --noEmit --incremental false
node scripts/verify-release-secret-exposure.mjs
node scripts/build-release-vnext.mjs --service web
release_id="web-auto-${commit:0:12}"
archive="$base/artifacts/$release_id.tar.gz"
if [[ ! -f "$archive" ]]; then
  node scripts/package-standalone-artifact.mjs --service web --output "$base/artifacts/$release_id" --release-id "$release_id" --commit "$commit" --archive --archive-path "$archive"
fi
sha="$(sha256sum "$archive" | cut -d' ' -f1)"
args=(--release-mode WEB --service web --artifact "$archive" --sha256 "$sha" --release-id "$release_id" --root /data/web)
# The existing deployer enforces assets, persistent data, candidate readiness,
# exact identities and rollback; this coordinator cannot bypass any of its gates.
bash scripts/deploy-artifact-vnext.sh --plan "${args[@]}"
DEPLOY_EXECUTION_APPROVED="$release_id" bash scripts/deploy-artifact-vnext.sh --execute "${args[@]}"
node scripts/start-release-media-workers.mjs /data/web
curl --fail --silent --max-time 20 https://zyuani8.com/api/version | node -e '
let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const v=JSON.parse(s);if(v.deployCommitSha!==process.argv[1])process.exit(1);console.log("PUBLIC_VERSION_MATCH");});' "$commit"
echo 'DEPLOYMENT_COMPLETE'
