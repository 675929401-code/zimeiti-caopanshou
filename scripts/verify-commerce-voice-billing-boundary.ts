import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function main(){
  const api=await fs.readFile(new URL('../src/app/api/commerce/voice-synthesis/route.ts',import.meta.url),'utf8');
  const bridge=await fs.readFile(new URL('../src/commerce/server/voice-bridge.ts',import.meta.url),'utf8');
  const jobs=await fs.readFile(new URL('../src/commerce/server/voice-jobs.ts',import.meta.url),'utf8');
  const gateway=await fs.readFile(new URL('../src/app/api/commerce-model-gateway/route.ts',import.meta.url),'utf8');
  const helper=await import('../src/commerce/server/voice-synthesis');
  const checks:string[]=[];const check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push(name);};

  check('cash voice API enforces same origin',/sameOrigin\(request\)/u.test(api));
  check('cash voice API requires Commerce identity',/requireIdentity\(request\)/u.test(api));
  check('cash voice API revalidates current main account',/authorizeCurrentCommerceIdentity\(user\)/u.test(api));
  check('quote and confirm are separate actions',/body\.action===['"]quote['"]/u.test(api)&&/body\.action===['"]confirm['"]/u.test(api));
  check('failed charge needs explicit retry or cancellation',/body\.action===['"]retry-charge['"]/u.test(api)&&/body\.action===['"]cancel-pending-charge['"]/u.test(api));
  check('unknown provider result exposes asset check and reconciliation only',/body\.action===['"]retry-save['"]/u.test(api)&&/body\.action===['"]request-reconciliation['"]/u.test(api)&&!api.includes('refund-unknown'));
  check('read endpoint never schedules billing pending charge',!api.includes("['billing_pending','queued','running','saving']"));
  check('voice bridge gates paid execution on published acceptance evidence',bridge.includes('VOICE_ACCEPTANCE_EVIDENCE_INCOMPLETE')&&bridge.includes('assertCommerceVoiceAcceptanceCurrent(input)'));
  check('voice bridge rejects sale price below cost',bridge.includes('payableTotal<costAmount'));
  check('voice jobs use main cash wallet and revenue ledger',jobs.includes('deductCash')&&jobs.includes('refundCash')&&jobs.includes('recordRevenue'));
  check('voice jobs never mutate the point-credit lifecycle',!jobs.includes('credit_charge')&&!jobs.includes('beginVoiceGenerationAtomic')&&!jobs.includes('refundVoiceGenerationAtomic'));
  check('automatic recovery excludes pending charge',/job\.status===['"]queued['"]&&job\.billingState===['"]charged['"]/u.test(jobs)&&!jobs.includes("job.status==='queued'||job.billingState==='charge_pending'"));
  check('ambiguous submissions never auto-resend',/if\(job\.status===['"]submission_unknown['"]\)return job/u.test(jobs));
  check('manual reconciliation requires evidence hash and administrator identity',jobs.includes('commerce-voice-reconciliation-evidence/v1')&&jobs.includes('resolvedBy'));

  const start=gateway.indexOf("if (input.purpose === 'voice-synthesis')");
  const end=gateway.indexOf("if (typeof input.prompt",start);
  check('legacy model gateway voice branch remains closed',start>=0&&end>start&&gateway.slice(start,end).includes('VOICE_MODEL_CATALOG_NOT_READY'));
  const branch=gateway.slice(start,end);
  check('legacy gateway cannot call provider or database',!branch.includes('fetch(')&&!branch.includes('getSupabaseClient')&&!branch.includes('resolveProviderSecret')&&!branch.includes('synthesizeSpeech'));
  assert.throws(()=>helper.buildVoiceSynthesisPayload({voice:'fixture',display_name:'fixture',description:'fixture',gender:'female',language_hint:'zh',model:'fixture'},'fixture'),/VOICE_MODEL_CATALOG_NOT_READY/);checks.push('legacy payload helper remains fail closed');
  assert.equal(helper.validateSynthesisText(' 合成测试 '),'合成测试');checks.push('text normalization remains deterministic');
  assert.throws(()=>helper.validateSynthesisText(''),/请填写/);checks.push('empty text is rejected');

  console.log(JSON.stringify({passed:checks.length,networkCalls:0,paidCalls:0,walletWrites:0,providerCalls:0,productionWrites:0,deployment:0,checks}));
}

void main().catch(error=>{console.error(error);process.exitCode=1;});
