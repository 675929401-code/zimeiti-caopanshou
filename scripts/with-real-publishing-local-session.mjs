import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Task-scoped QA wrapper: actual password verification, no forged step-up rows.
// Credential JSON is supplied only through redirected stdin from registered DPAPI.
export async function main() {
  const target=process.argv.find(value=>value.startsWith('--target='))?.slice('--target='.length);
  const targets=new Set(['scripts/verify-publishing-v2-concurrency-local.mjs','scripts/verify-publishing-native-browser-local.mjs','.codex-evidence/publish-center-native-20261110-a6b42cea/verify-browser.mjs','.codex-evidence/publish-center-delivery-4b3ab51a/verify-browser.mjs','scripts/configure-native-workspace-models-local.mjs']);
  assert.ok(targets.has(target),'EXACT_PUBLISHING_LOCAL_QA_TARGET_REQUIRED');
  const origin=process.env.LOCAL_NAV_ORIGIN,token=process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin,'http://127.0.0.1:5000');assert.ok(token);
  const identity=JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY||'null');assert.ok(identity?.user?.id);
  let raw='';for await(const chunk of process.stdin)raw+=chunk;
  let credential;try{credential=JSON.parse(raw);}catch{throw new Error('CONTROLLED_CREDENTIAL_INPUT_REQUIRED');}finally{raw='';}
  assert.equal(credential.account,identity.user.username,'CONTROLLED_CREDENTIAL_OWNER_MISMATCH');
  let step='';let revoked=false;let verified=false;
  const report={realPasswordStepUp:false,revoked:false,target,productionWrites:0};
  const configuring=target==='scripts/configure-native-workspace-models-local.mjs';
  const directory=path.resolve(configuring?'.codex-evidence/publish-center-closure-afb7f0d4':target.includes('publish-center-delivery-4b3ab51a')?'.codex-evidence/publish-center-delivery-4b3ab51a':'.codex-evidence/publish-center-native-20261110-a6b42cea');
  try{
    const response=await fetch(origin+'/api/admin/access-control/unlock',{method:'POST',cache:'no-store',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({password:credential.password,mode:'login',durationMinutes:15}),signal:AbortSignal.timeout(20000)});
    credential=null;
    const body=await response.json().catch(()=>({}));
    assert.ok(response.ok&&body.success===true&&body.authMethod==='login_password',`REAL_LOCAL_PASSWORD_VERIFICATION_FAILED_HTTP_${response.status}`);
    step=/zimeiti_admin_step_up=([^;]+)/.exec(response.headers.get('set-cookie')||'')?.[1]||'';assert.ok(step,'REAL_STEP_UP_COOKIE_REQUIRED');
    verified=true;report.realPasswordStepUp=true;process.env.LOCAL_ADMIN_STEP_UP_TOKEN=step;
    const module=await import(pathToFileURL(path.resolve(target)).href);if(typeof module.main==='function')await module.main();
  }finally{
    credential=null;
    if(step){const response=await fetch(origin+'/api/admin/access-control/unlock',{method:'DELETE',headers:{Authorization:`Bearer ${token}`,'x-admin-step-up':step},signal:AbortSignal.timeout(20000)}).catch(()=>null);const body=await response?.json().catch(()=>null);revoked=response?.ok===true&&body?.success===true;}
    delete process.env.LOCAL_ADMIN_STEP_UP_TOKEN;step='';report.revoked=revoked;
    await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,configuring?`configuration-auth-${new Date().toISOString().replace(/[:.]/g,'-')}.json`:target.includes('concurrency')?'concurrency-auth.json':'browser-auth.json'),JSON.stringify(report,null,2)+'\n');
    if(verified&&!revoked)throw new Error('REAL_LOCAL_STEP_UP_REVOCATION_UNCONFIRMED');
  }
}
