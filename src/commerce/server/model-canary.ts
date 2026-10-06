import crypto, { createHash } from 'node:crypto';
import { billingQuantity, getJobBillingState, quoteCost, quotePrice } from './billing';
import { readAsset } from './assets';
import { createJob, job, runJob, type JobInput } from './jobs';
import { selectedModel, type Kind, type Model } from './models';
import { get, put, transaction } from './store';
import { stableJson } from './configuration-platform';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { invalidateCommerceModelAcceptance } from './model-acceptance';
import { inspectSavedVideoAudioPolicy } from './video-audio-policy';
import { ensureProviderReference } from './media-reference';

type CanaryQuote={
  schema:'commerce-model-canary-quote/v1';id:string;actorId:string;owner:string;marker:string;input:JobInput;inputFingerprint:string;
  modelId:string;modelConfigHash:string;publicPrice:number;costPrice:number;billingUnit:Model['billingUnit'];quantity:number;
  estimatedProviderCost:number;ordinaryUserPrice:number;createdAt:number;expiresAt:number;status:'quoted'|'submitted'|'completed';jobId?:string;
};

function fingerprint(value:unknown){return createHash('sha256').update(stableJson(value)).digest('hex');}
function strings(value:unknown,max=15){if(!Array.isArray(value)||value.length>max)throw Error('canary 素材列表无效');return value.map((item)=>String(item||'')).filter(Boolean);}
function firstString(value:unknown,fallback:string){return Array.isArray(value)&&value.length?String(value[0]):fallback;}
function publicQuote(value:CanaryQuote){return {id:value.id,marker:value.marker,kind:value.input.kind,modelId:value.modelId,inputFingerprint:value.inputFingerprint,billingUnit:value.billingUnit,quantity:value.quantity,estimatedProviderCost:value.estimatedProviderCost,ordinaryUserPrice:value.ordinaryUserPrice,adminWalletCharge:value.ordinaryUserPrice,expiresAt:value.expiresAt,status:value.status,jobId:value.jobId};}

export async function createModelCanaryQuote(actorId:string,owner:string,raw:Record<string,unknown>){
  const kind=String(raw.kind||'') as Kind;if(!['agent','image','video'].includes(kind))throw Error('请选择需要验收的模型类型');
  const model=await selectedModel(kind,String(raw.modelId||''));
  if(model.source!=='main'||model.capabilities.executionSupported===false)throw Error('该模型当前没有接通主站执行桥接');
  if(model.costPrice===null||!Number.isFinite(model.costPrice)||model.costPrice<0)throw Error('模型成本未配置，不能创建付费 canary');
  if(!Number.isFinite(model.publicPrice)||model.publicPrice<model.costPrice||(model.publicPrice===0&&model.capabilities.explicitlyFree!==true))throw Error('模型售价或利润配置不完整，不能创建 canary');
  const ids=strings(raw.referenceAssetIds);
  const referenceAssets=ids.map(id=>readAsset(id,owner));
  if(referenceAssets.some(asset=>!asset))throw Error('canary 素材不存在或不属于管理员工作区');
  if(kind==='video')for(const asset of referenceAssets)await ensureProviderReference(asset!);
  const marker=`COMMERCE-CANARY-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${crypto.randomUUID().slice(0,8)}`;
  const quoteId=crypto.randomUUID();
  const base={requestId:quoteId,kind,modelId:model.id,purpose:'commerce-canary',prompt:`[${marker}] 只执行一次真实生成与持久化验收。生成内容使用中性虚构商品，不声明价格、功效、销量或认证。`} as JobInput;
  let input:JobInput=kind==='agent'?{...base,references:ids.map((id,index)=>({id,slot:`reference-${index+1}`}))}:base;
  if(kind==='image')input={...base,skillId:'default',aspectRatio:String(raw.aspectRatio||firstString(model.capabilities.aspectRatios,'1:1')),resolution:String(raw.resolution||firstString(model.capabilities.resolutionOptions,'1024x1024')),format:'PNG',references:ids.map((id)=>({id,slot:'reference'}))};
  if(kind==='video'){
    const durations=(Array.isArray(model.capabilities.nativeDurations)?model.capabilities.nativeDurations:Array.isArray(model.capabilities.durationOptions)?model.capabilities.durationOptions:[]).map(Number).filter((value)=>Number.isInteger(value)&&value>=1&&value<=60);
    const duration=Number(raw.duration||durations[0]||4);if(durations.length&&!durations.includes(duration))throw Error('canary 时长不在模型原生时长内');
    input={...base,duration,aspectRatio:String(raw.aspectRatio||firstString(model.capabilities.aspectRatios,'9:16')),resolution:String(raw.resolution||firstString(model.capabilities.resolutionOptions,'720p')),generateAudio:raw.generateAudio===true,references:ids.map((id,index)=>({id,slot:`reference-${index+1}`}))};
  }
  const quantity=billingQuantity(input,model),estimatedProviderCost=quoteCost(input,model),ordinaryUserPrice=quotePrice(input,model);
  const now=Date.now();const quote:CanaryQuote={schema:'commerce-model-canary-quote/v1',id:quoteId,actorId,owner,marker,input,inputFingerprint:fingerprint(input),modelId:model.id,modelConfigHash:model.configHash,publicPrice:model.publicPrice,costPrice:model.costPrice,billingUnit:model.billingUnit,quantity,estimatedProviderCost,ordinaryUserPrice,createdAt:now,expiresAt:now+10*60_000,status:'quoted'};
  put('model-canary-quotes',quote.id,owner,quote);return publicQuote(quote);
}

export async function confirmModelCanaryQuote(actorId:string,owner:string,quoteId:string,inputFingerprint:string){
  const quote=get<CanaryQuote>('model-canary-quotes',quoteId,owner);if(!quote||quote.actorId!==actorId)throw Error('canary 报价不存在或不属于当前管理员');
  if(quote.inputFingerprint!==inputFingerprint)throw Error('canary 输入指纹不一致');if(quote.expiresAt<Date.now())throw Error('canary 报价已过期，请重新报价');
  if(quote.jobId){const existing=job(quote.jobId,owner);if(!existing)throw Error('原 canary 任务正在创建，请按原任务核对');if(existing.configurationSnapshot?.quoteId!==quote.id||existing.configurationSnapshot.inputFingerprint!==quote.inputFingerprint||existing.configurationSnapshot.clientRequestId!==quote.id)throw Error('原 canary 任务缺少完整报价快照');return {quote:publicQuote(quote),job:existing};}
  const model=await selectedModel(quote.input.kind,quote.modelId);
  if(model.configHash!==quote.modelConfigHash||model.publicPrice!==quote.publicPrice||model.costPrice!==quote.costPrice||model.billingUnit!==quote.billingUnit)throw Error('模型配置或价格已经变化，请重新创建 canary 报价');
  const created=await createJob(owner,quote.input,undefined,{adminCanaryModelId:quote.modelId,quoteBinding:{quoteId:quote.id,inputFingerprint:quote.inputFingerprint,clientRequestId:quote.id}});
  transaction(()=>{const current=get<CanaryQuote>('model-canary-quotes',quote.id,owner);if(!current)throw Error('canary 报价状态丢失');current.status='submitted';current.jobId=created.id;put('model-canary-quotes',current.id,owner,current);});
  void runJob(created.id,owner).catch(()=>{});return {quote:publicQuote({...quote,status:'submitted',jobId:created.id}),job:created};
}

export async function registerModelCanaryEvidence(actorId:string,owner:string,jobId:string){
  const value=job(jobId,owner);if(!value||value.input.purpose!=='commerce-canary')throw Error('只允许登记受控 canary 任务');
  if(value.status!=='succeeded'||!value.dispatchedAt)throw Error('canary 尚未成功终结，不能登记生产可用证据');
  if(value.input.kind==='agent'&&!value.text?.trim())throw Error('对话 canary 没有可验证文本结果');
  if(value.input.kind!=='agent'&&(!value.assetIds.length||value.assetIds.some((id)=>!readAsset(id,owner))))throw Error('媒体 canary 缺少当前管理员拥有的持久化资产');
  const billing=getJobBillingState(value);if(!billing||billing.status!=='revenue_recorded'||billing.adminExempt===true)throw Error('canary 的钱包扣费、供应商成本与收益账务尚未按统一计费规则终结');
  const current=await selectedModel(value.input.kind,value.model.id);if(current.configHash!==value.model.configHash)throw Error('canary 完成后模型配置已变化，证据已失效');
  const references=(value.input.references||[]).map(reference=>readAsset(reference.id,owner)).filter((asset):asset is NonNullable<typeof asset>=>Boolean(asset));
  const count=(prefix:string)=>references.filter(asset=>asset.type.startsWith(prefix)).length;
  const outputValidation:Record<string,unknown>=value.input.kind==='agent'
    ?{nonEmptyText:Boolean(value.text?.trim()),characters:value.text?.trim().length||0}
    :value.input.kind==='image'
      ?{persistedAssets:value.assetIds.length,mimeTypes:value.assetIds.map(id=>readAsset(id,owner)?.type||'missing')}
      :await inspectSavedVideoAudioPolicy(owner,value.assetIds[0]);
  if(value.input.kind==='image'&&value.assetIds.some(id=>!readAsset(id,owner)?.type.startsWith('image/')))throw Error('图片 canary 的持久化结果类型不正确');
  if(value.input.kind==='video'&&value.input.generateAudio===false&&outputValidation.hasAudio===true)throw Error('视频 canary 违反无声输出合同，不能登记生产可用证据');
  const row={model_kind:value.input.kind,model_id:value.model.id,model_config_hash:value.model.configHash,status:'passed',canary_job_id:value.id,quote_id:value.configurationSnapshot?.quoteId||value.input.requestId,evidence_asset_ids:value.assetIds,evidence_summary:{marker:value.input.prompt.match(/COMMERCE-CANARY-[0-9]+-[a-f0-9]+/)?.[0]||'',terminalStatus:value.status,dispatchedAt:value.dispatchedAt,completedAt:value.updatedAt,billingStatus:billing.status,costSource:billing.costSource,inputCoverage:{referenceImages:count('image/'),referenceVideos:count('video/'),referenceAudios:count('audio/'),duration:value.input.duration||null,aspectRatio:value.input.aspectRatio||null,resolution:value.input.resolution||null,generateAudio:value.input.generateAudio===true},outputValidation},provider_cost:billing.actualCostAmount??billing.costAmount,verified_by:actorId,verified_at:new Date().toISOString()};
  const db=getSupabaseAdminClient();const existing=await db.from('commerce_model_acceptance_evidence').select('*').eq('canary_job_id',value.id).order('verified_at',{ascending:false}).order('created_at',{ascending:false}).limit(1).maybeSingle();if(existing.error)throw Error(`核对模型 canary 证据失败：${existing.error.message}`);
  if(existing.data?.status==='invalidated')throw Error('失效后的模型必须用新的 canary 任务重新验收');
  const saved=existing.data?.status==='passed'?{data:existing.data,error:null}:await db.from('commerce_model_acceptance_evidence').insert(row).select('*').single();if(saved.error)throw Error(`保存模型 canary 证据失败：${saved.error.message}`);invalidateCommerceModelAcceptance();
  const quote=get<CanaryQuote>('model-canary-quotes',value.input.requestId,owner);if(quote){quote.status='completed';put('model-canary-quotes',quote.id,owner,quote);}
  return saved.data;
}

export async function invalidateModelCanaryEvidence(actorId:string,owner:string,jobId:string,reason:string){
  const value=job(jobId,owner);if(!value||value.input.purpose!=='commerce-canary')throw Error('只允许失效当前管理员拥有的受控 canary 证据');
  const note=reason.trim();if(note.length<10||note.length>500)throw Error('请提供 10 到 500 字的证据失效原因');
  const db=getSupabaseAdminClient();const current=await db.from('commerce_model_acceptance_evidence').select('*').eq('model_kind',value.input.kind).eq('model_id',value.model.id).eq('model_config_hash',value.model.configHash).order('verified_at',{ascending:false}).order('created_at',{ascending:false}).limit(1).maybeSingle();if(current.error)throw Error(`核对模型 canary 证据失败：${current.error.message}`);
  if(!current.data)throw Error('当前模型配置没有可失效的 canary 证据');
  if(current.data.status==='invalidated')return current.data;
  const invalidated={model_kind:current.data.model_kind,model_id:current.data.model_id,model_config_hash:current.data.model_config_hash,status:'invalidated',canary_job_id:current.data.canary_job_id,quote_id:current.data.quote_id,evidence_asset_ids:current.data.evidence_asset_ids,evidence_summary:{...(current.data.evidence_summary&&typeof current.data.evidence_summary==='object'&&!Array.isArray(current.data.evidence_summary)?current.data.evidence_summary:{}),invalidated:{reason:note,at:new Date().toISOString(),by:actorId}},provider_cost:current.data.provider_cost,verified_by:actorId,verified_at:new Date().toISOString()};
  const saved=await db.from('commerce_model_acceptance_evidence').insert(invalidated).select('*').single();if(saved.error)throw Error(`失效模型 canary 证据失败：${saved.error.message}`);invalidateCommerceModelAcceptance();return saved.data;
}
