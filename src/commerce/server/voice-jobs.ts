import {createHash,randomUUID} from 'node:crypto';

import {deductCash,refundCash} from '@/lib/billing';
import {recordRevenue} from '@/lib/revenue';

import {assertAssetIntegrity,publicAsset,readAsset,readIdempotentAsset,storeAsset} from './assets';
import {
  assertCommerceVoiceInputCurrent,
  assertCommerceVoiceAcceptanceCurrent,
  classifyCommerceVoiceFailure,
  executeCommerceVoice,
  freezeCommerceVoiceInput,
  type CommerceVoiceParameters,
  type FrozenCommerceVoiceInput,
} from './voice-bridge';
import {claim,claimRecordLease,db,get,list,put,recordLeaseIsCurrent,releaseRecordLease,renewRecordLease,transaction} from './store';

const QUOTE_BUCKET='voice-quotes';
const JOB_BUCKET='voice-jobs';
const LEASE_BUCKET='voice-job-leases';
const QUOTE_TTL_MS=10*60_000;
const LEASE_MS=60_000;
const STALE_RUNNING_MS=5*60_000;
const CLIENT_REQUEST_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export type CommerceVoiceQuote={
  schema:'commerce-voice-quote/v1';
  id:string;
  owner:string;
  fingerprint:string;
  input:FrozenCommerceVoiceInput;
  status:'quoted'|'confirmed';
  createdAt:number;
  expiresAt:number;
  jobId?:string;
  clientRequestId?:string;
};
export type CommerceVoiceJobStatus='billing_pending'|'queued'|'running'|'submission_unknown'|'saving'|'succeeded'|'failed'|'cancelled';
export type CommerceVoiceBillingState='charge_pending'|'not_charged'|'charged'|'refund_pending'|'refunded'|'revenue_pending'|'revenue_recorded'|'reconciliation_required';
type VoiceDispatchReceipt={
  state:'intent'|'acknowledged'|'completed'|'known_failed'|'unknown';
  attemptId:string;
  startedAt:number;
  acknowledgedAt?:number;
  completedAt?:number;
  providerTaskId?:string;
};
export type CommerceVoiceJob={
  schema:'commerce-voice-job/v1';
  id:string;
  owner:string;
  quoteId:string;
  quoteFingerprint:string;
  clientRequestId:string;
  input:FrozenCommerceVoiceInput;
  status:CommerceVoiceJobStatus;
  billingState:CommerceVoiceBillingState;
  mainUserId:string;
  mainRole:'admin'|'student';
  chargeKey:string;
  refundKey:string;
  payableTotal:number;
  costAmount:number;
  actualCostAmount?:number;
  walletOperationId?:string;
  balanceAfter?:number;
  chargedAt?:number;
  refundedAt?:number;
  revenueRecordedAt?:number;
  billingError?:string;
  dispatch?:VoiceDispatchReceipt;
  assetId?:string;
  error?:string;
  createdAt:number;
  updatedAt:number;
  events:Array<{at:number;stage:string}>;
  reconciliation?:{
    requestedAt:number;
    resolvedAt?:number;
    resolvedBy?:string;
    outcome?:'success'|'failed';
    evidenceHash?:string;
    providerTaskId?:string;
    sourceAssetId?:string;
  };
};

type MainBinding={mainUserId:string;mainRole?:'admin'|'user';exempt?:boolean};
type BillingDependencies={
  charge:typeof deductCash;
  refund:typeof refundCash;
  revenue:typeof recordRevenue;
};
let testBillingDependencies:BillingDependencies|undefined;

/** Test-only cash/revenue seam. Production always uses the main cash wallet. */
export function setCommerceVoiceBillingForTesting(value?:Partial<BillingDependencies>){
  if(process.env.NODE_ENV!=='test')throw Error('VOICE_TEST_BILLING_FORBIDDEN');
  testBillingDependencies=value?{
    charge:value.charge||deductCash,
    refund:value.refund||refundCash,
    revenue:value.revenue||recordRevenue,
  }:undefined;
}

function billing():BillingDependencies{return testBillingDependencies||{charge:deductCash,refund:refundCash,revenue:recordRevenue};}
function hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function resultAssetKey(jobId:string){return `voice-result:${jobId}`;}
function saveJob(job:CommerceVoiceJob){job.updatedAt=Date.now();put(JOB_BUCKET,job.id,job.owner,job);return job;}
function event(job:CommerceVoiceJob,stage:string){if(job.events.at(-1)?.stage!==stage)job.events.push({at:Date.now(),stage});}
function publicDispatch(value:VoiceDispatchReceipt|undefined){return value?{state:value.state,startedAt:value.startedAt,acknowledgedAt:value.acknowledgedAt,completedAt:value.completedAt}:undefined;}

export function publicVoiceQuote(quote:CommerceVoiceQuote){
  return {
    schema:quote.schema,id:quote.id,status:quote.status,voiceId:quote.input.voiceId,voiceName:quote.input.voiceName,
    modelId:quote.input.modelId,providerModelId:quote.input.providerModelId,providerResourceId:quote.input.providerResourceId,
    configHash:quote.input.configHash,textHash:quote.input.textHash,textLength:quote.input.textLength,parameters:quote.input.parameters,
    payableTotal:quote.input.payableTotal,currency:'CNY' as const,createdAt:quote.createdAt,expiresAt:quote.expiresAt,jobId:quote.jobId,
  };
}
export function publicVoiceJob(job:CommerceVoiceJob){
  const asset=job.assetId?readIdempotentAsset(job.owner,resultAssetKey(job.id)):undefined;
  return {
    schema:job.schema,id:job.id,quoteId:job.quoteId,status:job.status,voiceId:job.input.voiceId,voiceName:job.input.voiceName,
    modelId:job.input.modelId,providerModelId:job.input.providerModelId,textHash:job.input.textHash,textLength:job.input.textLength,
    parameters:job.input.parameters,payableTotal:job.payableTotal,currency:'CNY' as const,
    billing:{state:job.billingState,amount:job.payableTotal,balanceAfter:job.balanceAfter,chargedAt:job.chargedAt,refundedAt:job.refundedAt,revenueRecordedAt:job.revenueRecordedAt,error:job.billingError},
    dispatch:publicDispatch(job.dispatch),asset:asset?publicAsset(asset):undefined,error:job.error,createdAt:job.createdAt,updatedAt:job.updatedAt,events:job.events.map(value=>({...value})),
    reconciliation:job.reconciliation?{requestedAt:job.reconciliation.requestedAt,resolvedAt:job.reconciliation.resolvedAt,outcome:job.reconciliation.outcome}:undefined,
  };
}

export const voiceJob=(owner:string,id:string)=>get<CommerceVoiceJob>(JOB_BUCKET,id,owner);
export const voiceJobs=(owner:string)=>list<CommerceVoiceJob>(JOB_BUCKET,owner);
export const voiceQuote=(owner:string,id:string)=>get<CommerceVoiceQuote>(QUOTE_BUCKET,id,owner);

export async function quoteVoice(owner:string,value:{voiceId:string;text:string;parameters?:Partial<CommerceVoiceParameters>}){
  if(!owner)throw Error('UNAUTHORIZED');
  const input=await freezeCommerceVoiceInput(value),now=Date.now(),id=randomUUID();
  const fingerprint=hash({owner,input:{...input,text:undefined}});
  const quote:CommerceVoiceQuote={schema:'commerce-voice-quote/v1',id,owner,fingerprint,input,status:'quoted',createdAt:now,expiresAt:now+QUOTE_TTL_MS};
  put(QUOTE_BUCKET,id,owner,quote);
  return quote;
}

function bindingFor(owner:string,expectedMainUserId:string){
  const value=get<MainBinding>('settings',`main-bind-${owner}`,'system');
  if(!value?.mainUserId)throw Error('带货身份尚未绑定主站账号，已拒绝语音扣费和任务创建');
  if(!expectedMainUserId||value.mainUserId!==expectedMainUserId)throw Error('带货登录对应的主站钱包已经变化，请退出后重新进入带货 Agent');
  if(value.exempt===true)throw Error('带货身份仍使用旧免扣标记，必须完成现金钱包迁移后再生成语音');
  return {mainUserId:value.mainUserId,mainRole:value.mainRole==='admin'?'admin' as const:'student' as const};
}

async function resolvePendingCharge(job:CommerceVoiceJob){
  if(job.billingState!=='charge_pending')return job;
  let result:Awaited<ReturnType<typeof deductCash>>;
  try{
    result=await billing().charge(job.mainUserId,job.payableTotal,`带货Agent 语音合成 · ${job.input.voiceName}`,job.chargeKey);
  }catch(error){
    transaction(()=>{const current=voiceJob(job.owner,job.id);if(current?.billingState==='charge_pending')saveJob({...current,billingError:error instanceof Error?error.message:'现金钱包扣费结果未知'});});
    throw Error('语音现金扣费结果尚未确认；请使用同一报价重试，系统不会重复扣款。');
  }
  if(!result.success){
    transaction(()=>{const current=voiceJob(job.owner,job.id);if(current?.billingState==='charge_pending')saveJob({...current,billingError:result.error||'现金钱包扣费失败'});});
    throw Error(`钱包扣费失败（余额不足或账户异常）：${result.error||'请检查主站钱包'}。本次未提交语音供应商。`);
  }
  return transaction(()=>{
    const current=voiceJob(job.owner,job.id);
    if(!current)throw Error('语音任务不存在');
    if(current.billingState!=='charge_pending')return current;
    event(current,'billing-committed');
    return saveJob({...current,status:'queued',billingState:'charged',walletOperationId:result.operationId,balanceAfter:result.balanceAfter,chargedAt:Date.now(),billingError:undefined});
  });
}

export async function confirmVoice(owner:string,quoteId:string,clientRequestId:string,expectedMainUserId:string){
  if(!CLIENT_REQUEST_ID.test(String(clientRequestId||'')))throw Error('语音确认缺少有效的 clientRequestId');
  const initial=voiceQuote(owner,String(quoteId||''));
  if(!initial)throw Error('语音报价不存在或不属于当前账号');
  if(initial.expiresAt<=Date.now())throw Error('语音报价已过期，请重新报价');
  await assertCommerceVoiceInputCurrent(initial.input);
  assertCommerceVoiceAcceptanceCurrent(initial.input);
  const value=transaction(()=>{
    const binding=bindingFor(owner,expectedMainUserId);
    const quote=voiceQuote(owner,initial.id);
    if(!quote||quote.fingerprint!==initial.fingerprint)throw Error('语音报价快照已经变化');
    if(quote.expiresAt<=Date.now())throw Error('语音报价已过期，请重新报价');
    if(quote.jobId){
      if(quote.clientRequestId!==clientRequestId)throw Error('语音报价已经由另一确认请求占用；请沿用原 clientRequestId 查询或重试');
      const existing=voiceJob(owner,quote.jobId);if(!existing)throw Error('语音报价已确认但任务记录缺失');return existing;
    }
    const proposed=randomUUID();
    const request=claim(`voice-confirm:${owner}:${clientRequestId}`,quote.fingerprint,proposed);
    if(!request.created){const existing=voiceJob(owner,request.id);if(!existing)throw Error('语音确认请求已占用但任务记录缺失');return existing;}
    const now=Date.now(),job:CommerceVoiceJob={
      schema:'commerce-voice-job/v1',id:proposed,owner,quoteId:quote.id,quoteFingerprint:quote.fingerprint,clientRequestId,input:structuredClone(quote.input),
      status:'billing_pending',billingState:'charge_pending',mainUserId:binding.mainUserId,mainRole:binding.mainRole,
      chargeKey:`commerce-voice-${proposed}-charge`,refundKey:`commerce-voice-${proposed}-refund`,payableTotal:quote.input.payableTotal,costAmount:quote.input.costAmount,
      createdAt:now,updatedAt:now,events:[{at:now,stage:'confirmed'},{at:now,stage:'charge-pending'}],
    };
    put(JOB_BUCKET,job.id,owner,job);put(QUOTE_BUCKET,quote.id,owner,{...quote,status:'confirmed',jobId:job.id,clientRequestId});return job;
  });
  if(value.mainUserId!==expectedMainUserId)throw Error('语音任务绑定的主站钱包与当前登录不一致');
  if(value.billingState==='charge_pending')return resolvePendingCharge(value);
  return value;
}

/** Explicit user action for retrying the same idempotent wallet charge. */
export async function retryVoiceCharge(owner:string,id:string,expectedMainUserId:string){
  const binding=bindingFor(owner,expectedMainUserId);
  const job=voiceJob(owner,id);
  if(!job)throw Error('语音任务不存在');
  if(job.mainUserId!==binding.mainUserId)throw Error('语音任务绑定的主站钱包与当前登录不一致');
  if(job.status!=='billing_pending'||job.billingState!=='charge_pending')throw Error('当前语音任务不需要重试扣费');
  await assertCommerceVoiceInputCurrent(job.input);
  assertCommerceVoiceAcceptanceCurrent(job.input);
  return resolvePendingCharge(job);
}

export function cancelVoicePendingCharge(owner:string,id:string,expectedMainUserId:string){
  const binding=bindingFor(owner,expectedMainUserId);
  return transaction(()=>{
    const job=voiceJob(owner,id);
    if(!job)throw Error('语音任务不存在');
    if(job.mainUserId!==binding.mainUserId)throw Error('语音任务绑定的主站钱包与当前登录不一致');
    if(job.status!=='billing_pending'||job.billingState!=='charge_pending'||job.walletOperationId)throw Error('仅未扣款的待支付语音任务可以取消');
    job.status='cancelled';job.billingState='not_charged';job.billingError=undefined;job.error='VOICE_CANCELLED_BEFORE_CHARGE';event(job,'cancelled-before-charge');return saveJob(job);
  });
}

async function settleRefund(job:CommerceVoiceJob){
  let pending=transaction(()=>{
    const current=voiceJob(job.owner,job.id);if(!current)throw Error('语音任务不存在');
    if(current.billingState==='refunded')return current;
    if(current.billingState==='reconciliation_required'&&current.status!=='failed')throw Error('语音退款需要人工对账');
    if(!['charged','refund_pending','reconciliation_required'].includes(current.billingState))return current;
    current.billingState='refund_pending';current.billingError=undefined;event(current,'refund-pending');return saveJob(current);
  });
  if(pending.billingState!=='refund_pending')return pending;
  try{
    const result=await billing().refund(pending.mainUserId,pending.payableTotal,'带货Agent 语音明确失败退款',pending.refundKey);
    if(!result.success)throw Error(result.error||'主站钱包退款失败');
    pending=transaction(()=>{const current=voiceJob(job.owner,job.id);if(!current)throw Error('语音任务不存在');if(current.billingState==='refunded')return current;if(current.billingState!=='refund_pending')throw Error('语音退款终态冲突');current.billingState='refunded';current.balanceAfter=result.balanceAfter;current.refundedAt=Date.now();event(current,'refunded');return saveJob(current);});
    return pending;
  }catch(error){
    return transaction(()=>{const current=voiceJob(job.owner,job.id);if(!current)throw Error('语音任务不存在');if(current.billingState==='refund_pending'){current.billingState='reconciliation_required';current.billingError=error instanceof Error?error.message:'主站钱包退款失败';event(current,'refund-reconciliation-required');saveJob(current);}return current;});
  }
}

async function settleRevenue(job:CommerceVoiceJob){
  let pending=transaction(()=>{
    const current=voiceJob(job.owner,job.id);if(!current)throw Error('语音任务不存在');
    if(current.billingState==='revenue_recorded')return current;
    if(current.status!=='succeeded'||!['charged','revenue_pending'].includes(current.billingState))return current;
    current.billingState='revenue_pending';current.billingError=undefined;event(current,'revenue-pending');return saveJob(current);
  });
  if(pending.billingState!=='revenue_pending')return pending;
  try{
    await billing().revenue({
      userId:pending.mainUserId,userRole:pending.mainRole,modelId:`voice:${pending.input.modelId}`,taskId:`commerce-voice-${pending.id}`,
      costPrice:pending.actualCostAmount??pending.costAmount,sellingPrice:pending.payableTotal,recordType:'voice',cashCharged:pending.payableTotal,billingExempt:false,
    });
    pending=transaction(()=>{const current=voiceJob(job.owner,job.id);if(!current)throw Error('语音任务不存在');if(current.billingState==='revenue_recorded')return current;if(current.billingState!=='revenue_pending')throw Error('语音收入终态冲突');current.billingState='revenue_recorded';current.revenueRecordedAt=Date.now();event(current,'revenue-recorded');return saveJob(current);});
    return pending;
  }catch(error){
    return transaction(()=>{const current=voiceJob(job.owner,job.id);if(!current)throw Error('语音任务不存在');if(current.billingState==='revenue_pending'){current.billingError=error instanceof Error?error.message:'收益记录写入失败';saveJob(current);}return current;});
  }
}

async function finishFromExistingAsset(job:CommerceVoiceJob){
  const asset=readIdempotentAsset(job.owner,resultAssetKey(job.id));if(!asset)return;
  if(asset.jobId!==job.id||!asset.type.startsWith('audio/'))throw Error('语音幂等资产身份不匹配');
  await assertAssetIntegrity(asset);
  return transaction(()=>{
    const current=voiceJob(job.owner,job.id);if(!current)throw Error('语音任务不存在');
    if(current.status==='succeeded')return current;
    current.status='succeeded';current.assetId=asset.id;current.error=undefined;
    if(current.billingState==='reconciliation_required')current.billingState='charged';
    current.dispatch={...(current.dispatch||{state:'acknowledged' as const,attemptId:`recovered:${job.id}`,startedAt:Date.now()}),state:'completed',completedAt:Date.now()};
    event(current,'asset-recovered');event(current,'succeeded');return saveJob(current);
  });
}

async function failKnown(job:CommerceVoiceJob,code:string){
  const failed=transaction(()=>{
    const current=voiceJob(job.owner,job.id);if(!current)throw Error('语音任务不存在');
    current.status='failed';current.error=code;
    if(current.dispatch)current.dispatch={...current.dispatch,state:'known_failed',completedAt:Date.now()};
    event(current,'provider-known-failure');return saveJob(current);
  });
  return settleRefund(failed);
}

export async function runVoiceJob(id:string,owner:string){
  const lease=claimRecordLease(LEASE_BUCKET,id,owner,`${process.pid}:${randomUUID()}`,Date.now(),LEASE_MS);
  if(!lease)return voiceJob(owner,id);
  let currentLease=true;
  const heartbeat=setInterval(()=>{try{currentLease=renewRecordLease(lease,Date.now(),LEASE_MS);}catch{currentLease=false;}},Math.floor(LEASE_MS/3));heartbeat.unref?.();
  const guard=()=>currentLease&&recordLeaseIsCurrent(lease);
  try{
    let job=voiceJob(owner,id);if(!job)return;
    // A failed or ambiguous charge may only be retried by another explicit
    // confirm request with the original quote + clientRequestId. Workers and
    // read endpoints must never debit a wallet after a later top-up.
    if(job.billingState==='charge_pending')return job;
    if(job.status==='succeeded')return settleRevenue(job);
    if(job.status==='failed'&&['charged','refund_pending','reconciliation_required'].includes(job.billingState))return settleRefund(job);
    if(job.status==='submission_unknown')return job;
    const recovered=await finishFromExistingAsset(job);if(recovered)return settleRevenue(recovered);
    if(job.status==='running'||job.status==='saving'){
      if(job.dispatch){
        job=transaction(()=>{const current=voiceJob(owner,id)!;current.status='submission_unknown';current.error='VOICE_PROVIDER_RESULT_UNCONFIRMED';current.dispatch={...current.dispatch!,state:'unknown'};event(current,'submission-unknown');return saveJob(current);});
        return job;
      }
      job=transaction(()=>{const current=voiceJob(owner,id)!;current.status='queued';event(current,'recovered-before-dispatch');return saveJob(current);});
    }
    if(job.status!=='queued'||job.billingState!=='charged')return job;
    try{await assertCommerceVoiceInputCurrent(job.input);}catch(error){return failKnown(job,classifyCommerceVoiceFailure(error).code);}
    job=transaction(()=>{const current=voiceJob(owner,id);if(!current||current.status!=='queued')return current!;current.status='running';event(current,'running');return saveJob(current);});
    if(!job||job.status!=='running')return job;
    const attemptId=randomUUID();
    job=transaction(()=>{const current=voiceJob(owner,id)!;if(current.status!=='running'||current.dispatch)throw Error('语音派发状态发生变化');current.dispatch={state:'intent',attemptId,startedAt:Date.now()};event(current,'provider-dispatch-intent');return saveJob(current);});
    try{
      const result=await executeCommerceVoice(job.input,attemptId);
      if(!guard())throw Error('VOICE_EXECUTION_LEASE_LOST');
      job=transaction(()=>{const current=voiceJob(owner,id)!;if(current.status!=='running'||current.dispatch?.attemptId!==attemptId)throw Error('语音派发回执已经变化');current.status='saving';current.dispatch={...current.dispatch,state:'acknowledged',providerTaskId:result.providerTaskId,acknowledgedAt:Date.now()};event(current,'provider-acknowledged');return saveJob(current);});
      const extension=result.type==='audio/wav'?'wav':result.type==='audio/ogg'?'ogg':'mp3';
      const asset=await storeAsset(owner,result.bytes,result.type,`${job.input.voiceName}-${job.input.textHash.slice(0,8)}.${extension}`,'generated',job.id,undefined,resultAssetKey(job.id),guard);
      if(!guard())throw Error('VOICE_EXECUTION_LEASE_LOST');
      job=transaction(()=>{const current=voiceJob(owner,id)!;if(current.status!=='saving'||current.dispatch?.attemptId!==attemptId)throw Error('语音保存终态已经变化');current.status='succeeded';current.assetId=asset.id;current.actualCostAmount=Number.isFinite(result.actualCostAmount)?result.actualCostAmount:undefined;current.dispatch={...current.dispatch,state:'completed',completedAt:Date.now()};event(current,'asset-saved');event(current,'succeeded');return saveJob(current);});
      return settleRevenue(job);
    }catch(error){
      const existing=await finishFromExistingAsset(job);if(existing)return settleRevenue(existing);
      const disposition=classifyCommerceVoiceFailure(error);
      if(disposition.known)return failKnown(job,disposition.code);
      return transaction(()=>{const current=voiceJob(owner,id)!;current.status='submission_unknown';current.error=disposition.code;if(current.dispatch)current.dispatch={...current.dispatch,state:'unknown'};event(current,'submission-unknown');return saveJob(current);});
    }
  }finally{clearInterval(heartbeat);if(currentLease)releaseRecordLease(lease);}
}

export async function recoverVoiceJobs(owner:string,limit=4,now=Date.now()){
  const candidates=voiceJobs(owner).filter(job=>
    (job.status==='queued'&&job.billingState==='charged')||
    (['running','saving'].includes(job.status)&&job.billingState==='charged'&&job.updatedAt<=now-STALE_RUNNING_MS)||
    (job.status==='succeeded'&&['charged','revenue_pending'].includes(job.billingState))||
    (job.status==='failed'&&['charged','refund_pending','reconciliation_required'].includes(job.billingState))
  ).slice(0,Math.max(1,Math.min(16,Math.trunc(limit)||4)));
  const recovered:CommerceVoiceJob[]=[];
  for(const candidate of candidates){const value=await runVoiceJob(candidate.id,owner);if(value)recovered.push(value);}
  return recovered;
}

/**
 * Explicitly inspect the deterministic result key after an ambiguous provider
 * response. This never invokes the provider and never creates another asset.
 */
export async function retryVoiceAssetRecovery(owner:string,id:string){
  const job=voiceJob(owner,id);
  if(!job)throw Error('语音任务不存在');
  if(job.status!=='submission_unknown')throw Error('仅结果未知的语音任务可以检查已有资产');
  const recovered=await finishFromExistingAsset(job);
  return recovered?settleRevenue(recovered):job;
}

/**
 * Record an operator-visible reconciliation request. Ambiguous submissions
 * are not automatically resent or refunded because the provider may already
 * have completed and charged for the request.
 */
export function requestVoiceReconciliation(owner:string,id:string){
  return transaction(()=>{
    const current=voiceJob(owner,id);
    if(!current)throw Error('语音任务不存在');
    if(current.status!=='submission_unknown')throw Error('仅结果未知的语音任务需要人工对账');
    if(current.billingState==='reconciliation_required')return current;
    if(current.billingState!=='charged')throw Error('当前语音任务账务状态不允许发起对账');
    current.billingState='reconciliation_required';
    current.billingError='VOICE_PROVIDER_RECONCILIATION_REQUIRED';
    current.reconciliation={requestedAt:current.reconciliation?.requestedAt||Date.now()};
    event(current,'reconciliation-requested');
    return saveJob(current);
  });
}

export function voiceReconciliationJobs(){
  return (db().prepare("SELECT value FROM records WHERE bucket=? AND json_extract(value,'$.status')='submission_unknown' AND json_extract(value,'$.billingState')='reconciliation_required' ORDER BY updated ASC LIMIT 500").all(JOB_BUCKET) as {value:string}[]).map(row=>JSON.parse(String(row.value)) as CommerceVoiceJob);
}

export async function resolveVoiceReconciliation(input:{owner:string;id:string;resolvedBy:string;outcome:'success'|'failed';evidence:unknown;providerTaskId:string;resultAssetId?:string;actualCostAmount?:number}){
  if(!input.resolvedBy?.trim())throw Error('管理员身份无效');
  if(!['success','failed'].includes(input.outcome))throw Error('人工对账终态无效');
  if(!/^[A-Za-z0-9._:-]{3,200}$/u.test(String(input.providerTaskId||'')))throw Error('请提供可核对的供应商任务号');
  const evidenceJson=JSON.stringify(input.evidence);
  if(!evidenceJson||evidenceJson==='null'||Buffer.byteLength(evidenceJson)>16*1024)throw Error('请提供不超过 16 KB 的上游对账证据摘要');
  const evidenceHash=hash({schema:'commerce-voice-reconciliation-evidence/v1',evidence:input.evidence});
  const actualCostAmount=input.actualCostAmount===undefined?undefined:Number(input.actualCostAmount);
  if(actualCostAmount!==undefined&&(!Number.isFinite(actualCostAmount)||actualCostAmount<0))throw Error('实际供应商成本无效');
  const lease=claimRecordLease(LEASE_BUCKET,input.id,input.owner,`reconcile:${process.pid}:${randomUUID()}`,Date.now(),LEASE_MS);
  if(!lease)throw Error('语音任务正在由其他执行器处理，请稍后重试');
  const guard=()=>recordLeaseIsCurrent(lease);
  try{
    const initial=voiceJob(input.owner,input.id);
    if(!initial)throw Error('语音任务不存在');
    if(initial.status!=='submission_unknown'||initial.billingState!=='reconciliation_required'||!initial.reconciliation?.requestedAt)throw Error('语音任务尚未进入管理员对账状态');
    if(initial.dispatch?.providerTaskId&&initial.dispatch.providerTaskId!==input.providerTaskId)throw Error('供应商任务号与已冻结回执不一致');
    if(input.outcome==='success'){
      const source=readAsset(String(input.resultAssetId||''),input.owner);
      if(!source||!source.type.startsWith('audio/'))throw Error('成功对账必须绑定当前工作区中的音频资产');
      const bytes=await assertAssetIntegrity(source);
      if(!guard())throw Error('语音对账租约已经失效');
      const extension=source.type==='audio/wav'?'wav':source.type==='audio/ogg'?'ogg':'mp3';
      const asset=await storeAsset(input.owner,bytes,source.type,`对账语音-${initial.id.slice(0,8)}.${extension}`,'generated',initial.id,undefined,resultAssetKey(initial.id),guard);
      const succeeded=transaction(()=>{
        if(!guard())throw Error('语音对账租约已经失效');
        const current=voiceJob(input.owner,input.id);if(!current)throw Error('语音任务不存在');
        if(current.status!=='submission_unknown'||current.billingState!=='reconciliation_required')throw Error('语音任务对账状态已经变化');
        current.status='succeeded';current.billingState='charged';current.billingError=undefined;current.error=undefined;current.assetId=asset.id;current.actualCostAmount=actualCostAmount;
        current.dispatch={...(current.dispatch||{state:'unknown' as const,attemptId:`reconciled:${current.id}`,startedAt:Date.now()}),state:'completed',providerTaskId:input.providerTaskId,completedAt:Date.now()};
        current.reconciliation={...current.reconciliation!,resolvedAt:Date.now(),resolvedBy:input.resolvedBy,outcome:'success',evidenceHash,providerTaskId:input.providerTaskId,sourceAssetId:source.id};event(current,'reconciliation-succeeded');return saveJob(current);
      });
      return settleRevenue(succeeded);
    }
    const failed=transaction(()=>{
      if(!guard())throw Error('语音对账租约已经失效');
      const current=voiceJob(input.owner,input.id);if(!current)throw Error('语音任务不存在');
      if(current.status!=='submission_unknown'||current.billingState!=='reconciliation_required')throw Error('语音任务对账状态已经变化');
      current.status='failed';current.error='VOICE_PROVIDER_CONFIRMED_FAILED';current.actualCostAmount=actualCostAmount;
      current.dispatch={...(current.dispatch||{state:'unknown' as const,attemptId:`reconciled:${current.id}`,startedAt:Date.now()}),state:'known_failed',providerTaskId:input.providerTaskId,completedAt:Date.now()};
      current.reconciliation={...current.reconciliation!,resolvedAt:Date.now(),resolvedBy:input.resolvedBy,outcome:'failed',evidenceHash,providerTaskId:input.providerTaskId};event(current,'reconciliation-failed');return saveJob(current);
    });
    return settleRefund(failed);
  }finally{if(guard())releaseRecordLease(lease);}
}
