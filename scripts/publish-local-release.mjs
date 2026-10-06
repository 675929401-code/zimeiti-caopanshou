import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertLocalReleaseAccepted} from './local-revision.mjs';
import {recordOperation} from './project-operations.mjs';

// All remote writes are downstream of current local acceptance. No --force or bypass flag.
const root=process.cwd();
const accepted=assertLocalReleaseAccepted(root);
const [repoInput,keyInput]=process.argv.slice(2);
if(!repoInput||!keyInput)throw new Error('Expected <managed-release-repository> <SSH-key-file>');
const repo=path.resolve(repoInput),key=path.resolve(keyInput);
if(!fs.statSync(key).isFile()||/["\r\n]/.test(key))throw new Error('INVALID_SSH_KEY_REFERENCE');
const target='root@134.175.87.247';
const ssh=process.platform==='win32'?'C:/Windows/System32/OpenSSH/ssh.exe':'ssh';
const scp=process.platform==='win32'?'C:/Windows/System32/OpenSSH/scp.exe':'scp';
const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_SSH_COMMAND:`"${ssh}" -i "${key.replaceAll('\\','/')}" -o BatchMode=yes -o ConnectTimeout=15`};
function run(command,args,cwd=repo){const r=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:180000,windowsHide:true});if(r.status!==0)throw new Error(`RELEASE_STEP_FAILED: ${path.basename(command)} (see protected command execution context)`);return r.stdout.trim();}
const commit=run('git',['rev-parse','HEAD']);
if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('INVALID_COMMIT');
if(run('git',['remote','get-url','origin'])!==`${target}:/data/git/zimeiti-caopanshou-source-vnext-clean-20260905.git`
  ||run('git',['remote','get-url','backup'])!=='https://gitee.com/zhujunguo/zimeiti-caopanshou-source-vnext-backup.git')throw new Error('UNEXPECTED_RELEASE_REMOTE');
const directory=path.join(root,'.codex-evidence/release-authorizations');fs.mkdirSync(directory,{recursive:true});
const authFile=path.join(directory,`${commit}-${Date.now()}.json`);
try{
  run(process.execPath,[path.join(root,'scripts/create-release-authorization.mjs'),repo,authFile],root);
  recordOperation(root,{stage:'git-publish',status:'running',sourceVersion:accepted.sourceVersion,gitCommit:commit,summary:'本地验收有效，先同步备份仓再触发主仓发布',nextAction:'核对两个远端精确 SHA 并跟踪服务器队列'});
  run('git',['push','backup',`${commit}:refs/heads/main`]);
  if(run('git',['ls-remote','backup','refs/heads/main']).split(/\s+/)[0]!==commit)throw new Error('BACKUP_COMMIT_MISMATCH');
  const temporary=`/data/release-automation/authorizations/.${commit}-${process.pid}.tmp`;
  run(scp,['-i',key,'-o','BatchMode=yes',authFile,`${target}:${temporary}`]);
  run(ssh,['-i',key,'-o','BatchMode=yes',target,`chmod 600 ${temporary} && mv -f ${temporary} /data/release-automation/authorizations/${commit}.json`]);
  assertLocalReleaseAccepted(root);
  run('git',['push','origin',`${commit}:refs/heads/main`]);
  if(run('git',['ls-remote','origin','refs/heads/main']).split(/\s+/)[0]!==commit)throw new Error('ORIGIN_COMMIT_MISMATCH');
  // A retry of an already accepted Git commit may not fire post-receive again.
  run(ssh,['-i',key,'-o','BatchMode=yes',target,'systemctl start --no-block zimeiti-release-queue.service']);
  recordOperation(root,{stage:'git-publish',status:'passed',sourceVersion:accepted.sourceVersion,gitCommit:commit,summary:'主仓与备份仓精确提交一致，服务器发布队列已唤起；正式上线仍以队列和域名验证为准',nextAction:'查看服务器部署终态，验证正式域名版本和网页核心功能'});
  console.log(JSON.stringify({sourceVersion:accepted.sourceVersion,commit,git:'both-remotes-verified',server:'queue-requested-not-yet-verified'}));
}catch(error){
  recordOperation(root,{stage:'git-publish',status:'failed',sourceVersion:accepted.sourceVersion,gitCommit:commit,summary:error.message,nextAction:'核对远端 SHA、验收凭据和队列阶段后恢复，不重复覆盖正式站点'});
  throw error;
}
