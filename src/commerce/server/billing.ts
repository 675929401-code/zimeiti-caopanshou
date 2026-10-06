/**
 * 带货 Agent 的主站钱包权威层。
 *
 * 生成任务只保存主站返回的账务回执；A 端不能接触钱包数据库或自行决定价格。
 * 扣款和退款使用任务 ID 派生的稳定幂等键，所有重试都复用同一笔业务操作。
 */
import {createHash} from 'node:crypto';
import {deductCash, refundCash} from '@/lib/billing';
import {recordRevenue} from '@/lib/revenue';
import {claim, db, get, put, remove, transaction} from './store';
import type {Job,JobInput} from './jobs';
import type {Model} from './models';

type MainBinding={mainUserId:string;boundAt?:number;mainRole?:'admin'|'user';exempt?:boolean};
export type CommerceBillingState={
  schema:'commerce-billing/v1';
  jobId:string;
  owner:string;
  fingerprint:string;
  status:'charge_pending'|'exempt'|'zero_price'|'charged'|'refund_pending'|'refunded'|'revenue_pending'|'revenue_recorded'|'reconciliation_required';
  amount:number;
  costAmount:number;
  profitAmount:number;
  costSource:'configured_estimate'|'provider_actual';
  actualCostAmount?:number;
  adminExempt?:boolean;
  mainRole?:'admin'|'student';
  chargeKey:string;
  refundKey:string;
  mainUserId?:string;
  walletOperationId?:string;
  alreadyFulfilled?:boolean;
  balanceAfter?:number;
  chargedAt?:number;
  refundedAt?:number;
  revenueRecordedAt?:number;
  platformLossRecordedAt?:number;
  parentQuoteId?:string;
  parentLineKey?:string;
  revenueTaskId?:string;
  lastError?:string;
  retryCount?:number;
  settlement?:'refund'|'revenue';
  settlementClaimedAt?:number;
  platformLossPendingAt?:number;
  updatedAt:number;
};

export type PublicCommerceBillingState=Pick<CommerceBillingState,'schema'|'jobId'|'status'|'amount'|'alreadyFulfilled'|'balanceAfter'|'chargedAt'|'refundedAt'|'revenueRecordedAt'|'revenueTaskId'|'lastError'|'retryCount'|'updatedAt'>;

export type CommerceAggregateBillingLine={
  key:string;
  kind:'agent'|'image'|'video';
  modelId:string;
  modelConfigHash:string;
  billingUnit:'per_use'|'output_second';
  quantity:number;
  estimatedTotalCost:number;
  payableTotal:number;
};

export type CommerceAggregateBillingQuote={
  id:string;
  owner:string;
  payableTotal:number;
  estimatedTotalCost:number;
  items:CommerceAggregateBillingLine[];
};

export type CommerceAggregateBillingState={
  schema:'commerce-aggregate-billing/v1';
  quoteId:string;
  owner:string;
  fingerprint:string;
  status:'charge_pending'|'exempt'|'zero_price'|'charged'|'refund_pending'|'refunded'|'reconciliation_required';
  amount:number;
  costAmount:number;
  profitAmount:number;
  items:CommerceAggregateBillingLine[];
  chargeKey:string;
  refundKey:string;
  mainUserId?:string;
  walletOperationId?:string;
  alreadyFulfilled?:boolean;
  balanceAfter?:number;
  chargedAt?:number;
  refundedAt?:number;
  adminExempt?:boolean;
  mainRole?:'admin'|'student';
  lastError?:string;
  updatedAt:number;
};

export type CommerceAggregateLineRelease={
  schema:'commerce-aggregate-line-release/v1';
  id:string;
  quoteId:string;
  lineKey:string;
  owner:string;
  amount:number;
  status:'refund_pending'|'refunded';
  refundKey:string;
  mainUserId?:string;
  alreadyFulfilled?:boolean;
  balanceAfter?:number;
  refundedAt?:number;
  lastError?:string;
  updatedAt:number;
};

function bindingFor(owner:string):{mainUserId?:string;mainRole?:'admin'|'student'}{
  const binding=get<MainBinding>('settings','main-bind-'+owner,'system');
  if(binding?.mainUserId)return {
    mainUserId:binding.mainUserId,
    mainRole:binding.mainRole==='admin'||(!binding.mainRole&&binding.exempt===true)?'admin':'student',
  };
  return {};
}

export function billingQuantity(input:Pick<JobInput,'kind'|'duration'|'rollingPlan'>,model:Pick<Model,'billingUnit'>):number{
  if(input.kind!=='video')return 1;
  if(model.billingUnit==='output_second')return Number(input.duration||0);
  return input.rollingPlan?.segments.length||1;
}

export function quotePrice(input:Pick<JobInput,'kind'|'duration'|'rollingPlan'>,model:Pick<Model,'publicPrice'|'billingUnit'>):number{
  const unit=Number(model.publicPrice||0);
  if(!(unit>0))return 0;
  const quantity=billingQuantity(input,model);
  if(!Number.isFinite(quantity)||quantity<=0)throw Error('模型计费数量无效，已停止报价');
  // The authoritative cash wallet is denominated in CNY cents. Persisting a
  // finer-grained payable amount lets PostgreSQL round at mutation time, so
  // the quote, Commerce receipt and wallet ledger can disagree (for example
  // ¥0.176 becoming ¥0.18). Round the immutable payable before confirmation.
  const raw=unit*quantity;
  return Math.max(0.01,Math.round((raw+Number.EPSILON)*100)/100);
}

export function quoteCost(input:Pick<JobInput,'kind'|'duration'|'rollingPlan'>,model:Pick<Model,'costPrice'|'billingUnit'>):number{
  const unit=model.costPrice;
  if(unit===null||!Number.isFinite(unit)||unit<0)throw Error('模型成本未完成可信配置，已停止派发');
  const quantity=billingQuantity(input,model);
  if(!Number.isFinite(quantity)||quantity<=0)throw Error('模型计费数量无效，已停止派发');
  return Math.round(unit*quantity*10000)/10000;
}

export function jobPrice(job:Job):number{return quotePrice(job.input,job.model);}
export function jobCost(job:Job):number{return quoteCost(job.input,job.model);}
export function providerCost(job:Job,fallback=jobCost(job)):{amount:number;source:CommerceBillingState['costSource']} {
  const records=[job.usage,...(job.usage&&typeof job.usage==='object'?[...(Object.values(job.usage as Record<string,unknown>).filter((value)=>value&&typeof value==='object'))]:[])];
  for(const value of records){if(!value||typeof value!=='object')continue;const row=value as Record<string,unknown>;for(const key of ['costCny','cost_cny','cost_yuan','totalCostCny','total_cost_cny','total_cost_yuan']){const amount=Number(row[key]);if(Number.isFinite(amount)&&amount>=0&&amount<1_000_000)return {amount:Math.round(amount*10000)/10000,source:'provider_actual'};}}
  return {amount:Math.round(fallback*10000)/10000,source:'configured_estimate'};
}

function fingerprint(job:Job,amount:number){
  return createHash('sha256').update(JSON.stringify({
    jobId:job.id,
    owner:job.owner,
    kind:job.input.kind,
    modelId:job.model.id,
    modelConfigHash:job.model.configHash,
    publicPrice:Number(job.model.publicPrice||0),
    costPrice:job.model.costPrice,
    explicitlyFree:job.model.capabilities?.explicitlyFree===true,
    billingUnit:job.model.billingUnit,
    duration:Number(job.input.duration||0),
    amount,
  })).digest('hex');
}

function aggregateFingerprint(quote:CommerceAggregateBillingQuote){
  return createHash('sha256').update(JSON.stringify({
    quoteId:quote.id,
    owner:quote.owner,
    payableTotal:quote.payableTotal,
    estimatedTotalCost:quote.estimatedTotalCost,
    items:[...quote.items].sort((left,right)=>left.key.localeCompare(right.key)).map(item=>({
      key:item.key,kind:item.kind,modelId:item.modelId,modelConfigHash:item.modelConfigHash,
      billingUnit:item.billingUnit,quantity:item.quantity,estimatedTotalCost:item.estimatedTotalCost,
      payableTotal:item.payableTotal,
    })),
  })).digest('hex');
}

function validateAggregateQuote(quote:CommerceAggregateBillingQuote){
  if(!/^[a-f0-9-]{36}$/i.test(quote.id)||!quote.owner||!quote.items.length)throw Error('父报价账务快照无效');
  if(new Set(quote.items.map(item=>item.key)).size!==quote.items.length)throw Error('父报价包含重复计费步骤');
  for(const item of quote.items){
    if(!item.key||!['agent','image','video'].includes(item.kind)||!item.modelId||!item.modelConfigHash||!['per_use','output_second'].includes(item.billingUnit))throw Error('父报价计费步骤不完整');
    if(!Number.isFinite(item.quantity)||item.quantity<=0||!Number.isFinite(item.estimatedTotalCost)||item.estimatedTotalCost<0||!Number.isFinite(item.payableTotal)||item.payableTotal<item.estimatedTotalCost)throw Error('父报价计费金额无效');
  }
  const cost=Math.round(quote.items.reduce((sum,item)=>sum+item.estimatedTotalCost,0)*10000)/10000;
  const payable=Math.round(quote.items.reduce((sum,item)=>sum+item.payableTotal,0)*10000)/10000;
  if(cost!==quote.estimatedTotalCost||payable!==quote.payableTotal)throw Error('父报价合计与计费步骤不一致');
}

export function getAggregateBillingState(owner:string,quoteId:string){
  return get<CommerceAggregateBillingState>('aggregate-billing',quoteId,owner);
}

function saveAggregateState(value:CommerceAggregateBillingState){value.updatedAt=Date.now();put('aggregate-billing',value.quoteId,value.owner,value);return value;}

/** Resolve a parent pre-charge intent with the same wallet key. This is safe
 * after a process or disk failure because the wallet RPC returns the original
 * completed operation for an already fulfilled key. */
async function resolvePendingAggregateCharge(pending:CommerceAggregateBillingState,label:string):Promise<CommerceAggregateBillingState>{
  if(pending.status!=='charge_pending'||!pending.mainUserId)throw Error('父报价预扣意图缺少原用户快照，已停止钱包操作');
  const result=await deductCash(pending.mainUserId,pending.amount,label,pending.chargeKey);
  if(!result.success){
    transaction(()=>{const current=getAggregateBillingState(pending.owner,pending.quoteId);if(current?.status==='charge_pending'&&current.fingerprint===pending.fingerprint)remove('aggregate-billing',pending.quoteId,pending.owner);});
    throw Error(`钱包扣费失败（余额不足或账户异常）：${result.error||'请检查主站钱包'}。本次未创建执行任务。`);
  }
  try{
    return transaction(()=>{
      const current=getAggregateBillingState(pending.owner,pending.quoteId);
      if(!current||current.fingerprint!==pending.fingerprint)throw Error('父报价预扣意图已经变化，已停止覆盖');
      if(current.status!=='charge_pending')return current;
      return saveAggregateState({...current,status:'charged',walletOperationId:result.operationId,alreadyFulfilled:result.alreadyFulfilled,balanceAfter:result.balanceAfter,chargedAt:Date.now(),lastError:undefined});
    });
  }catch(error){
    const message=error instanceof Error?error.message:'本地父报价回执保存失败';
    throw Error(`父报价钱包预扣已确认，但本地回执保存失败；必须使用相同报价号恢复，禁止新建报价：${message}`);
  }
}

/** One wallet debit for an already validated multi-step quote. Provider work is
 * still forbidden until each child job is bound to this immutable receipt. */
export async function chargeAggregateQuoteAtConfirm(quote:CommerceAggregateBillingQuote,label:string):Promise<CommerceAggregateBillingState>{
  validateAggregateQuote(quote);
  const expected=aggregateFingerprint(quote),previous=getAggregateBillingState(quote.owner,quote.id);
  if(previous){
    if(previous.fingerprint!==expected||previous.amount!==quote.payableTotal||previous.costAmount!==quote.estimatedTotalCost)throw Error('父报价账务快照与当前报价不一致');
    if(['exempt','zero_price','charged'].includes(previous.status))return previous;
    if(previous.status==='charge_pending'){const resolved=await resolvePendingAggregateCharge(previous,label);if(!['exempt','zero_price','charged'].includes(resolved.status))throw Error(`父报价预扣恢复后状态为 ${resolved.status}，已停止派发`);return resolved;}
    throw Error('父报价账务需要人工对账，已停止重复扣款和派发');
  }
  const binding=bindingFor(quote.owner),now=Date.now();
  const base:CommerceAggregateBillingState={
    schema:'commerce-aggregate-billing/v1',quoteId:quote.id,owner:quote.owner,fingerprint:expected,
    status:'zero_price',amount:quote.payableTotal,costAmount:quote.estimatedTotalCost,
    profitAmount:Math.round((quote.payableTotal-quote.estimatedTotalCost)*10000)/10000,items:structuredClone(quote.items),
    chargeKey:`commerce-aggregate-${quote.id}`,refundKey:`commerce-aggregate-${quote.id}-refund`,updatedAt:now,
  };
  if(!binding.mainUserId)throw Error('带货身份尚未绑定主站账号，已拒绝父报价扣款和任务创建');
  if(quote.payableTotal<=0)return saveAggregateState({...base,mainUserId:binding.mainUserId,mainRole:binding.mainRole});
  const pending=saveAggregateState({...base,status:'charge_pending',mainUserId:binding.mainUserId,mainRole:binding.mainRole});
  return resolvePendingAggregateCharge(pending,label);
}

/** Compensate only when the caller has proved that no workflow was created.
 * A reconciliation-required result remains terminal so retries never debit a
 * second time while the first wallet outcome is uncertain. */
export async function refundAggregateQuoteBeforeDispatch(owner:string,quoteId:string):Promise<CommerceAggregateBillingState|undefined>{
  let state=getAggregateBillingState(owner,quoteId);
  if(!state)return undefined;
  if(state.status==='charge_pending')state=await resolvePendingAggregateCharge(state,'带货Agent 父报价预扣恢复');
  if(state.status==='refunded')return state;
  if(state.status==='reconciliation_required')throw Error('父报价退款结果需要人工对账');
  if(state.status==='exempt'||state.status==='zero_price'){
    const refunded={...state,status:'refunded' as const,refundedAt:Date.now(),updatedAt:Date.now()};
    put('aggregate-billing',quoteId,owner,refunded);return refunded;
  }
  if(state.status!=='charged'||!state.mainUserId)throw Error('父报价缺少可退款的钱包快照');
  const pending={...state,status:'refund_pending' as const,updatedAt:Date.now(),lastError:undefined};
  put('aggregate-billing',quoteId,owner,pending);
  try{
    const result=await refundCash(state.mainUserId,state.amount,'带货Agent 执行记录创建失败退款',state.refundKey);
    if(!result.success)throw Error(result.error||'主站钱包退款失败');
    const refunded={...pending,status:'refunded' as const,alreadyFulfilled:result.alreadyFulfilled,balanceAfter:result.balanceAfter,refundedAt:Date.now(),updatedAt:Date.now()};
    put('aggregate-billing',quoteId,owner,refunded);return refunded;
  }catch(error){
    const failed={...pending,status:'reconciliation_required' as const,lastError:error instanceof Error?error.message:'主站钱包退款失败',updatedAt:Date.now()};
    put('aggregate-billing',quoteId,owner,failed);throw error;
  }
}

/** Allocate one part of a parent debit to a concrete child job. The ordinary
 * job billing state machine then records revenue/refunds without debiting the
 * wallet a second time. */
export function bindJobToAggregateCharge(job:Job,quoteId:string,item:CommerceAggregateBillingLine):CommerceBillingState{
  const parent=getAggregateBillingState(job.owner,quoteId);
  if(!parent||!['exempt','zero_price','charged'].includes(parent.status))throw Error('父报价尚未完成钱包预扣，已停止子任务派发');
  const released=get<CommerceAggregateLineRelease>('aggregate-line-releases',`${quoteId}:${item.key}`,job.owner);
  if(released)throw Error('父报价本行已经进入未启动退款，不能再绑定任务');
  const amount=jobPrice(job),costAmount=jobCost(job),quantity=billingQuantity(job.input,job.model);
  if(item.kind!==job.input.kind||item.modelId!==job.model.id||item.modelConfigHash!==job.model.configHash||item.billingUnit!==job.model.billingUnit||item.quantity!==quantity||item.payableTotal!==amount||item.estimatedTotalCost!==costAmount)throw Error('子任务与父报价计费快照不一致');
  const lineFingerprint=createHash('sha256').update(JSON.stringify(item)).digest('hex');
  const lineClaim=claim(`${job.owner}:aggregate-line:${quoteId}:${item.key}`,lineFingerprint,`job:${job.id}`);
  if(!lineClaim.created&&lineClaim.id!==`job:${job.id}`)throw Error('父报价本行已经由退款或其他任务占用');
  const previous=stateFor(job);
  if(previous){assertSameJob(job,previous,amount);if(previous.parentQuoteId!==quoteId||previous.parentLineKey!==item.key)throw Error('子任务已经绑定其他父报价或计费行');return previous;}
  const state:CommerceBillingState={
    schema:'commerce-billing/v1',jobId:job.id,owner:job.owner,fingerprint:fingerprint(job,amount),
    status:parent.status,amount,costAmount,profitAmount:Math.round((amount-costAmount)*10000)/10000,
    costSource:'configured_estimate',chargeKey:parent.chargeKey,refundKey:`commerce-aggregate-${quoteId}-job-${job.id}-refund`,
    parentQuoteId:quoteId,parentLineKey:item.key,mainUserId:parent.mainUserId,walletOperationId:parent.walletOperationId,
    alreadyFulfilled:parent.alreadyFulfilled,balanceAfter:parent.balanceAfter,chargedAt:parent.chargedAt,
    adminExempt:parent.adminExempt,mainRole:parent.mainRole,updatedAt:Date.now(),
  };
  return saveState(state);
}

function aggregateLineAllocation(owner:string,quoteId:string,lineKey:string){
  const row=db().prepare("SELECT value FROM records WHERE bucket='billing' AND owner=? AND json_extract(value,'$.parentQuoteId')=? AND json_extract(value,'$.parentLineKey')=? LIMIT 1").get(owner,quoteId,lineKey);
  return row?JSON.parse(String(row.value)) as CommerceBillingState:undefined;
}

async function releaseAggregateLine(owner:string,quoteId:string,lineKey:string):Promise<CommerceAggregateLineRelease|undefined>{
  const claimed=transaction(()=>{
    const parent=getAggregateBillingState(owner,quoteId);
    if(!parent)throw Error('父报价账务不存在');
    if(!['charged','zero_price','exempt'].includes(parent.status))throw Error(`父报价状态为 ${parent.status}，不能释放未启动计费行`);
    const item=parent.items?.find(candidate=>candidate.key===lineKey);
    if(!item)throw Error('父报价不包含待释放计费行');
    if(aggregateLineAllocation(owner,quoteId,lineKey))return undefined;
    const lineFingerprint=createHash('sha256').update(JSON.stringify(item)).digest('hex');
    const lineClaim=claim(`${owner}:aggregate-line:${quoteId}:${lineKey}`,lineFingerprint,`release:${quoteId}:${lineKey}`);
    if(!lineClaim.created&&!lineClaim.id.startsWith('release:'))return undefined;
    const id=`${quoteId}:${lineKey}`,existing=get<CommerceAggregateLineRelease>('aggregate-line-releases',id,owner);
    if(existing)return existing;
    const now=Date.now(),base:CommerceAggregateLineRelease={schema:'commerce-aggregate-line-release/v1',id,quoteId,lineKey,owner,amount:item.payableTotal,status:'refund_pending',refundKey:`commerce-aggregate-${quoteId}-unstarted-${createHash('sha256').update(lineKey).digest('hex').slice(0,24)}`,mainUserId:parent.mainUserId,updatedAt:now};
    const value=parent.status==='charged'?base:{...base,status:'refunded' as const,refundedAt:now};
    put('aggregate-line-releases',id,owner,value);
    return value;
  });
  if(!claimed||claimed.status==='refunded')return claimed;
  if(!claimed.mainUserId)throw Error('未启动计费行缺少原扣款用户快照');
  try{
    const result=await refundCash(claimed.mainUserId,claimed.amount,'带货Agent 未启动步骤退款',claimed.refundKey);
    if(!result.success)throw Error(result.error||'主站钱包退款失败');
    return transaction(()=>{
      const current=get<CommerceAggregateLineRelease>('aggregate-line-releases',claimed.id,owner);
      if(!current)return undefined;
      if(current.status==='refunded')return current;
      const refunded={...current,status:'refunded' as const,alreadyFulfilled:result.alreadyFulfilled,balanceAfter:result.balanceAfter,refundedAt:Date.now(),lastError:undefined,updatedAt:Date.now()};
      put('aggregate-line-releases',current.id,owner,refunded);
      return refunded;
    });
  }catch(error){
    transaction(()=>{const current=get<CommerceAggregateLineRelease>('aggregate-line-releases',claimed.id,owner);if(current?.status==='refund_pending')put('aggregate-line-releases',current.id,owner,{...current,lastError:error instanceof Error?error.message:'主站钱包退款失败',updatedAt:Date.now()});});
    throw error;
  }
}

export async function releaseAggregateUnallocatedLines(owner:string,quoteId:string,lineKeys:string[]){
  const releases:CommerceAggregateLineRelease[]=[];
  for(const lineKey of [...new Set(lineKeys)].sort()){
    const release=await releaseAggregateLine(owner,quoteId,lineKey);
    if(release)releases.push(release);
  }
  return releases;
}

export function aggregateBillingConservation(owner:string,quoteId:string){
  const parent=getAggregateBillingState(owner,quoteId);
  if(!parent)throw Error('父报价账务不存在');
  const allocations=db().prepare("SELECT value FROM records WHERE bucket='billing' AND owner=? AND json_extract(value,'$.parentQuoteId')=?").all(owner,quoteId).map(row=>JSON.parse(String(row.value)) as CommerceBillingState);
  const releases=db().prepare("SELECT value FROM records WHERE bucket='aggregate-line-releases' AND owner=? AND json_extract(value,'$.quoteId')=?").all(owner,quoteId).map(row=>JSON.parse(String(row.value)) as CommerceAggregateLineRelease);
  const allocatedAmount=Math.round(allocations.reduce((sum,row)=>sum+row.amount,0)*10000)/10000;
  const releasedAmount=Math.round(releases.filter(row=>row.status==='refunded').reduce((sum,row)=>sum+row.amount,0)*10000)/10000;
  return {debitedAmount:parent.amount,allocatedAmount,releasedAmount,unsettledAmount:Math.round((parent.amount-allocatedAmount-releasedAmount)*10000)/10000,allocations,releases};
}

function stateFor(job:Job){return get<CommerceBillingState>('billing',job.id,job.owner);}
function saveState(value:CommerceBillingState){value.updatedAt=Date.now();put('billing',value.jobId,value.owner,value);return value;}
function assertSameJob(job:Job,state:CommerceBillingState,amount:number){if(state.fingerprint!==fingerprint(job,amount))throw Error('账务快照与任务内容不一致，已拒绝重复操作');}
function kindLabel(kind:string){return kind==='agent'?'对话':kind==='image'?'图片生成':'视频生成';}

export function publicBillingState(value:CommerceBillingState):PublicCommerceBillingState{
  return {
    schema:value.schema,
    jobId:value.jobId,
    status:value.status,
    amount:value.amount,
    alreadyFulfilled:value.alreadyFulfilled,
    balanceAfter:value.balanceAfter,
    chargedAt:value.chargedAt,
    refundedAt:value.refundedAt,
    revenueRecordedAt:value.revenueRecordedAt,
    revenueTaskId:value.revenueTaskId,
    lastError:value.lastError,
    retryCount:value.retryCount,
    updatedAt:value.updatedAt,
  };
}

export function getJobBillingState(job:Job){return stateFor(job);}

/**
 * Resolve a durable pre-charge intent through the wallet's stable idempotency
 * key. Replaying this helper after the wallet committed but before the local
 * receipt was saved returns the original wallet operation instead of charging
 * the member again.
 */
async function resolvePendingJobCharge(job:Job,pending:CommerceBillingState):Promise<CommerceBillingState>{
  if(pending.status!=='charge_pending'||!pending.mainUserId)throw Error('任务预扣意图缺少原用户快照，已停止钱包操作');
  const result=await deductCash(pending.mainUserId,pending.amount,`带货Agent ${kindLabel(job.input.kind)} · ${job.model.displayName}`,pending.chargeKey);
  if(!result.success){
    transaction(()=>{const current=stateFor(job);if(current?.status==='charge_pending'&&current.fingerprint===pending.fingerprint)remove('billing',job.id,job.owner);});
    throw Error(`钱包扣费失败（余额不足或账户异常）：${result.error||'请检查主站钱包'}。本次未提交生成。`);
  }
  try{
    return transaction(()=>{
      const current=stateFor(job);
      if(!current||current.fingerprint!==pending.fingerprint)throw Error('任务预扣意图已经变化，已停止覆盖');
      if(current.status!=='charge_pending')return current;
      return saveState({...current,status:'charged',walletOperationId:result.operationId,alreadyFulfilled:result.alreadyFulfilled,balanceAfter:result.balanceAfter,chargedAt:Date.now(),lastError:undefined});
    });
  }catch(error){
    const message=error instanceof Error?error.message:'本地账务回执保存失败';
    throw Error(`钱包预扣已确认，但本地回执保存失败；必须使用相同任务号恢复，禁止新建请求：${message}`);
  }
}

/** 派发前预扣；未绑定的普通身份直接失败，绝不以免费模式继续派发。 */
export async function chargeJobAtDispatch(job:Job):Promise<CommerceBillingState>{
  const configuredPrice=Number(job.model.publicPrice);
  if(!Number.isFinite(configuredPrice)||configuredPrice<0||(configuredPrice===0&&job.model.capabilities?.explicitlyFree!==true))throw Error('模型售价未完成可信配置：0 元模型必须由管理员显式标记 explicitlyFree=true，已停止派发');
  const amount=jobPrice(job);
  const costAmount=jobCost(job);
  const previous=stateFor(job);
  if(previous){
    assertSameJob(job,previous,amount);
    if(['exempt','zero_price','charged'].includes(previous.status))return previous;
    if(previous.status==='charge_pending'){const resolved=await resolvePendingJobCharge(job,previous);if(!['exempt','zero_price','charged'].includes(resolved.status))throw Error(`任务预扣恢复后状态为 ${resolved.status}，已停止派发`);return resolved;}
    throw Error(`任务账务状态为 ${previous.status}，已拒绝再次派发；请先完成对账`);
  }
  const binding=bindingFor(job.owner);
  const base:CommerceBillingState={
    schema:'commerce-billing/v1',jobId:job.id,owner:job.owner,fingerprint:fingerprint(job,amount),
    status:'zero_price',amount,costAmount,profitAmount:Math.round((amount-costAmount)*10000)/10000,costSource:'configured_estimate',chargeKey:`commerce-job-${job.id}`,refundKey:`commerce-job-${job.id}-refund`,updatedAt:Date.now(),
  };
  if(!binding.mainUserId)throw Error('带货身份尚未绑定主站账号，已拒绝派发和扣费');
  if(amount<=0)return saveState({...base,mainUserId:binding.mainUserId,mainRole:binding.mainRole});
  const pending=saveState({...base,status:'charge_pending',mainUserId:binding.mainUserId,mainRole:binding.mainRole});
  return resolvePendingJobCharge(job,pending);
}

/** 仅确认失败的任务可调用；unknown 与 save_failed 都不得自动退款。 */
export async function refundFailedJob(job:Job):Promise<CommerceBillingState|undefined>{
  if(job.status!=='failed')throw Error('只有明确失败的任务可以退款；unknown 与 save_failed 必须保留原扣款并继续核对原请求');
  let state=stateFor(job);
  if(!state)return undefined;
  assertSameJob(job,state,jobPrice(job));
  if(state.status==='charge_pending')state=await resolvePendingJobCharge(job,state);
  if(['exempt','zero_price','refunded'].includes(state.status))return state;
  const pending=transaction(()=>{
    const current=stateFor(job);
    if(!current)return undefined;
    assertSameJob(job,current,jobPrice(job));
    if(['exempt','zero_price','refunded'].includes(current.status))return current;
    if(current.status==='revenue_recorded'||current.status==='revenue_pending'||current.settlement==='revenue')throw Error('任务已经选择收入终态，不能再退款');
    if(current.status==='reconciliation_required'&&current.settlement!=='refund')throw Error('任务账务缺少可恢复的退款意图，需要人工对账');
    if(current.status==='refund_pending'&&current.settlement==='refund')return current;
    if(current.status!=='charged'&&!current.parentQuoteId)throw Error(`任务账务状态为 ${current.status}，不能进入退款终态`);
    if(!current.mainUserId)throw Error('原扣款用户快照缺失，已停止自动退款');
    return saveState({...current,status:'refund_pending',settlement:'refund',settlementClaimedAt:Date.now(),lastError:undefined,retryCount:Number(current.retryCount||0)+1});
  });
  if(!pending)return undefined;
  if(['exempt','zero_price','refunded'].includes(pending.status))return pending;
  try{
    const result=await refundCash(pending.mainUserId!,pending.amount,'带货Agent 任务失败退款',pending.refundKey);
    if(!result.success)throw Error(result.error||'主站钱包退款失败');
    return transaction(()=>{
      const current=stateFor(job);
      if(!current)return undefined;
      if(current.status==='refunded')return current;
      if(current.status!=='refund_pending'||current.settlement!=='refund')throw Error('退款完成时本地结算权已经变化，已停止覆盖');
      return saveState({...current,status:'refunded',alreadyFulfilled:result.alreadyFulfilled,balanceAfter:result.balanceAfter,refundedAt:Date.now(),lastError:undefined});
    });
  }catch(error){
    const message=error instanceof Error?error.message:'主站钱包退款失败';
    transaction(()=>{const current=stateFor(job);if(current?.status==='refund_pending'&&current.settlement==='refund')saveState({...current,lastError:message});});
    throw error;
  }
}

/** 成功交付后记收入；不改变钱包扣款结果。 */
export async function recordJobRevenue(job:Job):Promise<CommerceBillingState|undefined>{
  let state=stateFor(job);
  if(!state)return undefined;
  assertSameJob(job,state,jobPrice(job));
  if(state.status==='charge_pending')state=await resolvePendingJobCharge(job,state);
  if(state.status==='revenue_recorded')return state;
  const revenueTaskId=`commerce-job-${job.id}`;
  const actual=providerCost(job,state.costAmount);const profitAmount=Math.round((state.amount-actual.amount)*10000)/10000;
  const pending=transaction(()=>{
    const current=stateFor(job);
    if(!current)return undefined;
    assertSameJob(job,current,jobPrice(job));
    if(current.status==='revenue_recorded')return current;
    if(current.status==='refunded'||current.status==='refund_pending'||current.settlement==='refund')throw Error('任务已经选择退款终态，不能再记收入');
    if(current.status==='reconciliation_required'&&current.settlement!=='revenue')throw Error('任务账务缺少可恢复的收入意图，需要人工对账');
    if(current.status==='revenue_pending'&&current.settlement==='revenue')return current;
    if(!['charged','exempt','zero_price'].includes(current.status))throw Error(`任务账务状态为 ${current.status}，不能进入收入终态`);
    if(!current.mainUserId)throw Error('原任务用户快照缺失，已停止收入入账');
    return saveState({...current,status:'revenue_pending',settlement:'revenue',settlementClaimedAt:Date.now(),revenueTaskId,costAmount:actual.amount,actualCostAmount:actual.source==='provider_actual'?actual.amount:undefined,costSource:actual.source,profitAmount,lastError:undefined,retryCount:Number(current.retryCount||0)+1});
  });
  if(!pending)return undefined;
  if(pending.status==='revenue_recorded')return pending;
  try{
    await recordRevenue({
      userId:pending.mainUserId!,
      userRole:pending.mainRole||(pending.adminExempt?'admin':'student'),
      modelId:job.model.id,
      taskId:revenueTaskId,
      costPrice:pending.costAmount,
      sellingPrice:pending.amount,
      recordType:job.input.kind==='agent'?'chat':job.input.kind==='image'?'image':'video',
      cashCharged:pending.adminExempt?0:pending.amount,
      billingExempt:pending.adminExempt===true,
    });
    return transaction(()=>{
      const current=stateFor(job);
      if(!current)return undefined;
      if(current.status==='revenue_recorded')return current;
      if(current.status!=='revenue_pending'||current.settlement!=='revenue')throw Error('收入完成时本地结算权已经变化，已停止覆盖');
      return saveState({...current,status:'revenue_recorded',revenueRecordedAt:Date.now(),lastError:undefined});
    });
  }catch(error){
    const message=error instanceof Error?error.message:'收益记录写入失败';
    transaction(()=>{const current=stateFor(job);if(current?.status==='revenue_pending'&&current.settlement==='revenue')saveState({...current,lastError:message});});
    throw error;
  }
}

/** 用户退款与供应商已产生成本分开记录。该记录表现为 0 收入、正成本。 */
export async function recordFailedProviderCost(job:Job,actualCostAmount:number):Promise<CommerceBillingState|undefined>{
  const amount=Math.round(actualCostAmount*10000)/10000;
  const pending=transaction(()=>{
    const current=stateFor(job);
    if(!current||amount<=0)return current;
    assertSameJob(job,current,jobPrice(job));
    if(current.platformLossRecordedAt)return current;
    if(!current.mainUserId)throw Error('平台成本记录缺少原任务用户快照');
    if(current.platformLossPendingAt)return current;
    return saveState({...current,platformLossPendingAt:Date.now()});
  });
  if(!pending||pending.platformLossRecordedAt||amount<=0)return pending;
  await recordRevenue({
    userId:pending.mainUserId!,userRole:pending.mainRole||(pending.adminExempt?'admin':'student'),modelId:job.model.id,
    taskId:`commerce-job-${job.id}-platform-loss`,costPrice:amount,sellingPrice:0,
    recordType:job.input.kind==='agent'?'chat':job.input.kind==='image'?'image':'video',cashCharged:0,
    billingExempt:pending.adminExempt===true,
  });
  return transaction(()=>{
    const current=stateFor(job);
    if(!current)return undefined;
    if(current.platformLossRecordedAt)return current;
    return saveState({...current,actualCostAmount:amount,platformLossRecordedAt:Date.now(),platformLossPendingAt:undefined});
  });
}
