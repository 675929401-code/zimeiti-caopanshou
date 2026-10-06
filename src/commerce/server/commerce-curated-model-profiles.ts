import {toPublicModelId,type PublicModelKind} from '../../lib/public-model-dto';
import type {Kind,Model} from './models';

export type CommerceCuratedProfileId=
  |'agent-claude-sonnet-4-6'
  |'agent-gpt-5-6-sol'
  |'image-seedream-5-pro'
  |'image-gpt-image-2'
  |'image-gpt-image-2-5'
  |'image-gpt-image-2-5-flare-fallback'
  |'image-nano-banana-2'
  |'image-gemini-3-pro-flagship';

export type CommerceCuratedProfileStatus='selectable'|'pending'|'missing';

export type CommerceCuratedExecutionReadiness={
  ready:boolean;
  profileId:CommerceCuratedProfileId|null;
  reason:string;
};

export type CommerceCuratedProfilePublic={
  id:CommerceCuratedProfileId;
  kind:'agent'|'image';
  label:string;
  role:'standard'|'flagship'|'value'|'internal-fallback';
  status:CommerceCuratedProfileStatus;
  userVisible:boolean;
  configurationSelectable:boolean;
  boundModelId:string|null;
  boundModelName:string|null;
  statusMessage:string;
};

type IdentitySpec={
  internalModelIds:readonly string[];
  modelNames:readonly string[];
  providers?:readonly string[];
};

type CuratedSpec={
  id:CommerceCuratedProfileId;
  kind:'agent'|'image';
  label:string;
  role:CommerceCuratedProfilePublic['role'];
  userVisible:boolean;
  configurationSelectable:boolean;
  identity:IdentitySpec;
  pendingMessage?:string;
};

/**
 * Curated Commerce choices are anchored to stable database/model identities.
 * Public pm_* ids are derived at runtime and are never persisted here.
 */
const SPECS:readonly CuratedSpec[]=[
  {
    id:'agent-claude-sonnet-4-6',kind:'agent',label:'Claude Sonnet 4.6',role:'standard',userVisible:true,configurationSelectable:true,
    identity:{internalModelIds:['3a998bfc-aab4-4f8f-9128-b27498894a7b'],modelNames:['claude-sonnet-4-6']},
  },
  {
    id:'agent-gpt-5-6-sol',kind:'agent',label:'GPT-5.6-Sol',role:'standard',userVisible:true,configurationSelectable:true,
    identity:{internalModelIds:['9b177ccc-4afc-4d49-96bb-fdd01f09bf89'],modelNames:['gpt-5.6-sol']},
  },
  {
    id:'image-seedream-5-pro',kind:'image',label:'豆包 Seedream 5.0 Pro',role:'flagship',userVisible:true,configurationSelectable:true,
    identity:{internalModelIds:['cover-model-seedream-5-pro'],modelNames:['doubao-seedream-5-0-pro-260628'],providers:['volcengine']},
  },
  {
    id:'image-gpt-image-2',kind:'image',label:'GPT Image 2',role:'standard',userVisible:true,configurationSelectable:true,
    identity:{internalModelIds:['gpt-image-2-chA-1'],modelNames:['gpt-image-2'],providers:['openai_compat','secure_skill']},
  },
  {
    id:'image-gpt-image-2-5',kind:'image',label:'GPT Image 2.5',role:'flagship',userVisible:true,configurationSelectable:true,
    identity:{internalModelIds:['gpt-image-25-sunburst-chA'],modelNames:['gpt-image-2.5-sunburst'],providers:['openai_compat']},
    pendingMessage:'Sunburst 作为确定性首选渠道；主站配置未满足执行条件时仅可保存选择，不宣称优于其他同族渠道。',
  },
  {
    id:'image-gpt-image-2-5-flare-fallback',kind:'image',label:'GPT Image 2.5 · Flare 内部候补',role:'internal-fallback',userVisible:false,configurationSelectable:false,
    identity:{internalModelIds:['gpt-image-25-flare-chA'],modelNames:['gpt-image-2.5-flare'],providers:['openai_compat']},
    pendingMessage:'仅保留为内部候补，不向用户提供第二个同族选项。',
  },
  {
    id:'image-nano-banana-2',kind:'image',label:'Nano Banana 2',role:'value',userVisible:true,configurationSelectable:true,
    identity:{internalModelIds:['gemini-3-1-flash-image-chA'],modelNames:['gemini-3.1-flash-image'],providers:['secure_skill_chat']},
  },
  {
    id:'image-gemini-3-pro-flagship',kind:'image',label:'Gemini 3 Pro Image · 旗舰',role:'flagship',userVisible:true,configurationSelectable:false,
    identity:{internalModelIds:[],modelNames:['gemini-3-pro-image'],providers:['google','gemini','lconai','openai_compat']},
    pendingMessage:'当前未绑定官方 gemini-3-pro-image（Nano Banana Pro）身份，保持待接入且不可选择；旧 gemini-3.0-pro-image 或 nano-banana-pro 命名不能代替。',
  },
] as const;

const PUBLIC_KIND:Record<'agent'|'image',PublicModelKind>={agent:'llm',image:'cover'};
const normalized=(value:unknown)=>String(value||'').trim().toLowerCase();

function specForIdentifier(kind:Kind,identifier:string):CuratedSpec|undefined{
  if(kind!=='agent'&&kind!=='image')return undefined;
  const id=String(identifier||'').trim();
  if(!id)return undefined;
  return SPECS.find(spec=>spec.kind===kind&&spec.identity.internalModelIds.some(internalId=>{
    if(id===internalId)return true;
    try{return id===toPublicModelId(PUBLIC_KIND[kind],internalId);}catch{return false;}
  }));
}

function exactIdentityMatch(spec:CuratedSpec,model:Pick<Model,'id'|'kind'|'modelName'|'internalModelId'|'provider'>):boolean{
  if(model.kind!==spec.kind)return false;
  const identifierSpec=specForIdentifier(model.kind,model.internalModelId||model.id);
  const modelName=normalized(model.modelName);
  const provider=normalized(model.provider);
  const modelNameMatches=!modelName||spec.identity.modelNames.map(normalized).includes(modelName);
  const providerMatches=!provider||!spec.identity.providers?.length||spec.identity.providers.map(normalized).includes(provider);
  if(identifierSpec?.id===spec.id)return modelNameMatches&&providerMatches;
  // A future flagship row may not have a predeclared database id. It remains
  // pending and can be recognized only by the exact official model/provider tuple.
  return !spec.identity.internalModelIds.length&&Boolean(modelName)&&spec.identity.modelNames.map(normalized).includes(modelName)&&providerMatches;
}

export function curatedProfileForIdentifier(kind:Kind,identifier:string):CuratedSpec|undefined{
  return specForIdentifier(kind,identifier);
}

export function classifyCommerceCuratedModel(model:Pick<Model,'id'|'kind'|'modelName'|'internalModelId'|'provider'>):CommerceCuratedProfileId|null{
  return SPECS.find(spec=>exactIdentityMatch(spec,model))?.id||null;
}

export function isCuratedConfigurationSelectable(kind:Kind,identifier:string):boolean{
  return specForIdentifier(kind,identifier)?.configurationSelectable===true;
}

/**
 * Agent/image models already governed by the main-site catalogue do not need
 * a second Commerce-specific acceptance run. The internal gateway must still prove that the
 * exact curated identity is active, executable and backed by a complete
 * provider configuration.  Public catalogue fallbacks deliberately cannot
 * satisfy these checks.
 */
export function curatedMainCatalogExecutionReadiness(model:Pick<Model,'id'|'kind'|'source'|'modelName'|'internalModelId'|'provider'|'configHash'|'capabilities'>):CommerceCuratedExecutionReadiness{
  const profileId=classifyCommerceCuratedModel(model);
  const spec=profileId?SPECS.find(item=>item.id===profileId):undefined;
  if(!profileId||!spec?.configurationSelectable)return {ready:false,profileId,reason:'所选模型不在带货 Agent 可执行白名单'};
  if(model.source!=='main')return {ready:false,profileId,reason:'仅允许主站模型目录中的已配置模型'};
  if(model.capabilities.available===false)return {ready:false,profileId,reason:String(model.capabilities.availabilityMessage||'主站模型当前未开放')};
  if(model.capabilities.executionSupported===false)return {ready:false,profileId,reason:'主站执行桥接尚未接通'};
  if(model.capabilities.credentialsConfigured!==true)return {ready:false,profileId,reason:'主站模型凭据尚未配置'};
  if(model.capabilities.endpointConfigured!==true)return {ready:false,profileId,reason:'主站模型接口地址尚未配置'};
  if(model.capabilities.protocolConfigured!==true)return {ready:false,profileId,reason:'主站模型协议尚未配置'};
  if(!/^[a-f0-9]{64}$/i.test(String(model.configHash||'')))return {ready:false,profileId,reason:'主站模型配置哈希缺失'};
  return {ready:true,profileId,reason:'主站模型配置已启用，可直接执行'};
}

export function assertCuratedMainCatalogExecutionReady(model:Pick<Model,'id'|'kind'|'source'|'modelName'|'internalModelId'|'provider'|'configHash'|'capabilities'>):CommerceCuratedProfileId{
  const readiness=curatedMainCatalogExecutionReadiness(model);
  if(!readiness.ready||!readiness.profileId)throw Error(readiness.reason);
  return readiness.profileId;
}

export function usesCuratedMainCatalogDirectExecution(kind:Kind):kind is 'agent'|'image'{
  return kind==='agent'||kind==='image';
}

export function sameCuratedModelProfile(kind:Kind,left:string,right:string):boolean{
  const a=specForIdentifier(kind,left),b=specForIdentifier(kind,right);
  return Boolean(a&&b&&a.id===b.id);
}

export function curatedModelPriority(profileId:CommerceCuratedProfileId|null,referenceImages=0):number{
  if(profileId==='agent-claude-sonnet-4-6')return 200;
  if(profileId==='agent-gpt-5-6-sol')return 190;
  if(referenceImages>0){
    if(profileId==='image-gpt-image-2-5')return 180;
    if(profileId==='image-gpt-image-2')return 170;
    if(profileId==='image-nano-banana-2')return 160;
    return 0;
  }
  if(profileId==='image-seedream-5-pro')return 180;
  if(profileId==='image-gpt-image-2-5')return 170;
  if(profileId==='image-gpt-image-2')return 160;
  if(profileId==='image-nano-banana-2')return 150;
  return 0;
}

export function commerceCuratedProfilesForModels(kind:'agent'|'image',models:ReadonlyArray<Pick<Model,'id'|'displayName'|'kind'|'modelName'|'internalModelId'|'provider'>&{generationReady?:boolean}>):CommerceCuratedProfilePublic[]{
  return SPECS.filter(spec=>spec.kind===kind).map(spec=>{
    const bound=models.find(model=>exactIdentityMatch(spec,model))||null;
    const fixedPending=!spec.configurationSelectable;
    const status:CommerceCuratedProfileStatus=fixedPending?'pending':bound?'selectable':'missing';
    const statusMessage=fixedPending
      ?spec.pendingMessage||'该候选尚未完成正式绑定，暂不提供选择。'
      :!bound
        ?`当前目录未找到与 ${spec.label} 稳定身份一致的模型。`
        :bound.generationReady
          ?`已绑定 ${bound.displayName}，主站配置已启用，可直接执行。`
          :spec.pendingMessage||`已绑定 ${bound.displayName}，可用于配置；主站凭据、接口、协议或执行桥接尚未满足，暂不可执行。`;
    return {id:spec.id,kind:spec.kind,label:spec.label,role:spec.role,status,userVisible:spec.userVisible,configurationSelectable:spec.configurationSelectable&&Boolean(bound),boundModelId:bound?.id||null,boundModelName:bound?.displayName||null,statusMessage};
  });
}

export function publicCuratedSpecs(){
  return SPECS.map(({identity:_,pendingMessage:__,...spec})=>({...spec}));
}
