import {requireIdentity} from '../../../../commerce/server/auth';
import {modelMatchesIdentifier,models,type Kind} from '../../../../commerce/server/models';
import {filterModelsByVisibility} from '../../../../commerce/server/model-visibility';
import {get} from '../../../../commerce/server/store';
import {commerceConfigurationStatus,currentPublishedCommerceConfiguration,primePublishedCommerceConfiguration} from '../../../../commerce/server/configuration-platform';
import {commerceDepthCloneAcceptanceIssues,commerceModelAcceptanceIndex,commerceModelAcceptanceKey,type CommerceModelAcceptanceEvidence} from '../../../../commerce/server/model-acceptance';
import {json,errorResponse} from '../../../../commerce/server/http';
import {DEPTH_MODEL_CAPABILITY_REQUIREMENTS,DEPTH_PURPOSE} from '../../../../commerce/server/depth-video-clone-schema';
import {classifyDepthCloneModel,depthCloneProfilesForModels} from '../../../../commerce/server/depth-video-clone-model-profiles';
import {classifyCommerceCuratedModel,commerceCuratedProfilesForModels,curatedMainCatalogExecutionReadiness,curatedModelPriority,curatedProfileForIdentifier,usesCuratedMainCatalogDirectExecution} from '../../../../commerce/server/commerce-curated-model-profiles';
import {COMMERCE_VIDEO_MAX_TOTAL_DURATION,resolveCommerceVideoDurationPlan} from '../../../../commerce/shared/video-generation-capabilities';

export const runtime='nodejs';export const dynamic='force-dynamic';
/** 模式×能力前置过滤 + 档位排序（对标model-routes档位体系本地实现）：
 * 查询参数 referenceImages/duration/aspectRatio/resolution →
 * 每模型标注 modeCompatible 与不兼容原因；tier=高端(2)/中端(1)/轻量(0)；
 * defaultCompatibleModelId=兼容集中档位最高者（质量优先），用户可降档。 */
const TIER_PATTERNS:Record<string,Array<{re:RegExp;tier:number;label:string}>>={
  video:[
    {re:/seedance.?2\.5|doubao-seedance-2-5/i,tier:2,label:'高端'},
    {re:/seedance.?2\.0(?!.*(fast|mini))|doubao-seedance-2-0-260128(?!-fast)/i,tier:2,label:'高端'},
    {re:/omni_flash|omni(?!_video_edit)/i,tier:2,label:'高端'},
    {re:/veo_?3/i,tier:2,label:'高端'},
    {re:/seedance.*(fast)|2-0-fast/i,tier:1,label:'中端'},
    {re:/video-2\.0-pro|wan3\.0-video-prime/i,tier:2,label:'高端'},
    {re:/wan3\.0-video(?!-prime)|video-2\.0-fast|lightx2v/i,tier:1,label:'中端'},
    {re:/mini|480p/i,tier:0,label:'轻量'},
    {re:/grok|h3/i,tier:1,label:'中端'},
  ],
  image:[
    {re:/gpt-image-2\.5-sunburst/i,tier:2,label:'高端'},
    {re:/gpt-image-2\.5-flare/i,tier:2,label:'高端'},
    {re:/nano-banana-pro|seedream-5|gpt-image-2/i,tier:2,label:'高端'},
    {re:/gemini-3/i,tier:1,label:'中端'},
    {re:/glm-image|qwen-image/i,tier:0,label:'轻量'},
  ],
  agent:[],
};
function tierOf(kind:string,name:string,ModelId:string):number{
  const list=TIER_PATTERNS[kind]||[];
  for(const p of list)if(p.re.test(name)||p.re.test(ModelId))return p.tier;
  return 1;
}
export async function GET(request:Request){try{requireIdentity(request);
  const q=new URL(request.url).searchParams;
  const kind=q.get('kind') as Kind|null;
  if(!kind||!['agent','image','video'].includes(kind))return json({models:[],error:'kind无效'},400);
  // The model directory is a read-only discovery surface. A missing published
  // Commerce release must stop paid generation, but must not make every
  // configured main-site model disappear from the selector.
  await primePublishedCommerceConfiguration({required:false});
  const published=currentPublishedCommerceConfiguration();
  const configurationStatus=commerceConfigurationStatus();
  const values=await models(kind);
  let acceptance=new Map<string,CommerceModelAcceptanceEvidence>();
  let acceptanceAvailable=!published;
  if(published&&kind==='video'){
    try{acceptance=await commerceModelAcceptanceIndex();acceptanceAvailable=true;}
    catch{acceptanceAvailable=false;}
  }
  const visible=filterModelsByVisibility(kind,values);
  const operationId=q.get('operationId')||null;
  const policy=operationId?published?.routes.find(route=>route.operationId===operationId&&route.modelKind===kind):undefined;
  const depthClone=operationId===DEPTH_PURPOSE;
  const needRefs=Number(q.get('referenceImages'))||(depthClone?1:null);
  const needSourceVideos=Number(q.get('sourceVideos'))||(depthClone?1:0);
  const needReferenceAudios=Number(q.get('referenceAudios'))||0;
  const needAudioToggle=q.get('generateAudioToggle')==='1'||depthClone;
  const duration=Number(q.get('duration'))||null;
  const aspectRatio=q.get('aspectRatio')||null;
  const resolution=(q.get('resolution')||'').toLowerCase()||null;
  const annotated=visible.map(m=>{
    const c=m.capabilities||{};
    const reasons:string[]=[];
    const selectionReasons:string[]=[];
    const depthCloneProfileId=depthClone?classifyDepthCloneModel(m):null;
    const curatedProfileId=kind==='agent'||kind==='image'?classifyCommerceCuratedModel(m):null;
    const curatedExecution=usesCuratedMainCatalogDirectExecution(kind)?curatedMainCatalogExecutionReadiness(m):null;
    if(depthClone&&!depthCloneProfileId){
      const reason='未精确绑定到深度复刻方案（仅支持 Seedance 2.5 或具备源视频能力的 MiniMax H3 Ref2VA）';
      reasons.push(reason);selectionReasons.push(reason);
    }
    if((kind==='agent'||kind==='image')&&!curatedProfileId){const reason='不在带货 Agent 已审核模型白名单';reasons.push(reason);selectionReasons.push(reason);}
    if(curatedProfileId&&!curatedProfileForIdentifier(kind,m.internalModelId||m.id)?.configurationSelectable){const reason='该模型仅为待比测或待接入画像，暂不提供用户选择';reasons.push(reason);selectionReasons.push(reason);}
    // Execution readiness is separate from input compatibility. Keep a model
    // selectable for configuration when its source/reference capabilities fit,
    // while generationReady below continues to fail closed until the bridge is live.
    const durations=c.nativeDurations||c.durationOptions;
    let durationPlan:ReturnType<typeof resolveCommerceVideoDurationPlan>|null=null,durationIssue='';
    if(duration!==null)try{durationPlan=resolveCommerceVideoDurationPlan(c,duration,{minimum:depthClone?4:1,maximum:COMMERCE_VIDEO_MAX_TOTAL_DURATION,allowRolling:!depthClone});}catch(error){durationIssue=error instanceof Error?error.message:'不支持该时长';}
    const needsRolling=durationPlan?.native===false;
    if(needRefs!==null){
      if(c.supportsImageInput!==true&&c.supportsReferenceInput!==true){const reason='不支持人物、商品或环境替换图片';reasons.push(reason);selectionReasons.push(reason);}
      const max=Number(c.maxReferenceImages ?? 1);
      if(needRefs+(needsRolling?1:0)>max){const reason=needsRolling?`滚动生成需为尾帧预留1个位置，当前最多支持${max}张参考图`:`最多支持${max}张参考图`;reasons.push(reason);selectionReasons.push(reason);}
    }
    if(needSourceVideos>0&&c.supportsSourceVideoInput!==true){const reason='不支持源视频复刻';reasons.push(reason);selectionReasons.push(reason);}
    if(needReferenceAudios>0&&(c.supportsAudioInput!==true||needReferenceAudios>Number(c.maxReferenceAudios||0))){const reason='不支持当前声音参考';reasons.push(reason);selectionReasons.push(reason);}
    if(needAudioToggle&&c.supportsGenerateAudioToggle!==true)reasons.push('声音开关传输尚未验证');
    if(duration!==null&&durationIssue){const reason=durationIssue;reasons.push(reason);selectionReasons.push(reason);}
    if(aspectRatio&&Array.isArray(c.aspectRatios)&&c.aspectRatios.length&&!c.aspectRatios.includes(aspectRatio)){const reason=`不支持画幅${aspectRatio}`;reasons.push(reason);selectionReasons.push(reason);}
    if(resolution&&Array.isArray(c.resolutionOptions)&&c.resolutionOptions.length&&!c.resolutionOptions.some((r:string)=>String(r).toLowerCase()===resolution)){const reason=`不支持${resolution}`;reasons.push(reason);selectionReasons.push(reason);}
    const name=String(m.displayName||'')+' '+String(m.modelName||'')+' '+String(m.id||'');
    const tier=kind==='video'?tierOf('video',name,m.id):kind==='image'?tierOf('image',name,m.id):1;
    const tierLabel=kind==='video'?(tier===2?(/2\.5/.test(name)?'旗舰·NEW':'正式投放首选'):tier===0?'轻量':'中端')
      :kind==='image'?(tier===2?'高级版 VIP（更快更稳）':tier===0?'轻量':'高级版'):'标准';
    const acceptanceEvidence=acceptance.get(commerceModelAcceptanceKey(m.kind,m.id,m.configHash));
    const verified=curatedExecution?false:!configurationStatus.enabled||!!published&&Boolean(acceptanceEvidence);
    const depthAcceptanceIssues=depthClone&&published?commerceDepthCloneAcceptanceIssues(acceptanceEvidence):[];
    const generationReady=curatedExecution?curatedExecution.ready:c.available!==false&&c.executionSupported!==false&&(!configurationStatus.enabled||!!published&&published.paidJobsReady&&acceptanceAvailable&&verified&&depthAcceptanceIssues.length===0);
    const readinessMessage=curatedExecution?curatedExecution.reason:c.available===false?'渠道当前不可用'
      :c.executionSupported===false?'主站执行桥接尚未接通'
      :configurationStatus.enabled&&!published?'带货配置尚未发布，当前模型仅供选择和配置'
      :!published?'可生成'
      :!published.paidJobsReady?'当前发布版本尚未开放付费生成'
      :!acceptanceAvailable?'生成验收状态暂时无法读取'
      :!verified?'当前配置生成验收中'
      :depthAcceptanceIssues.length?'源视频、替换图与参考声音链路尚未全部通过':'可生成';
    const configurationSelectable=kind==='video'||Boolean(curatedProfileId&&curatedProfileForIdentifier(kind,m.internalModelId||m.id)?.configurationSelectable);
    const {costPrice:_,billingUnit:__,configHash:___,verifiedAt:____,endpoint:_____,protocol:______,modelName:_______,internalModelId:________,provider:_________,enabled:__________,secret:___________,...safe}=m;
    return {...safe,verified,generationReady,readinessMessage,executionReadinessSource:curatedExecution?.ready?'main-catalog-active-configuration':verified?'commerce-acceptance':'not-ready',depthCloneProfileId,curatedProfileId,curatedPriority:curatedModelPriority(curatedProfileId,Number(needRefs)||0),selectionAvailable:configurationSelectable&&selectionReasons.length===0,configurationSelectable,selectionCompatible:selectionReasons.length===0,selectionIncompatibleReasons:selectionReasons,modeCompatible:reasons.length===0,modeIncompatibleReasons:reasons,tier,tierLabel};
  });
  const configuredDefaultIdentifier=policy?.primaryModelId||published?.defaultModels[kind]||(get<Record<string,string>>('settings','defaults','system')||{})[kind];
  const publishedVideoIds=new Set<string>((policy?[policy.primaryModelId,...policy.fallbackModelIds]:published?[published.defaultModels.video,...published.routes.filter(route=>route.modelKind==='video'&&route.userSelectable).flatMap(route=>[route.primaryModelId,...route.fallbackModelIds])]:[]).filter((id):id is string=>typeof id==='string'&&Boolean(id)));
  const curatedCandidates=kind==='agent'||kind==='image'?annotated.filter(model=>model.curatedProfileId&&curatedProfileForIdentifier(kind,model.id)?.userVisible!==false):[];
  const governed=kind==='video'
    ?(published?annotated.filter(model=>[...publishedVideoIds].some(id=>modelMatchesIdentifier(model,id))):annotated)
    :curatedCandidates;
  const configuredDefault=governed.find(model=>configuredDefaultIdentifier&&modelMatchesIdentifier(model,configuredDefaultIdentifier))?.id||null;
  const compatible=governed.filter(m=>m.modeCompatible&&(!depthClone||m.selectionCompatible));
  const readyCompatible=compatible.filter(model=>model.generationReady);
  const ranked=[...(readyCompatible.length?readyCompatible:compatible)].sort((a,b)=>b.curatedPriority-a.curatedPriority||b.tier-a.tier||a.displayName.localeCompare(b.displayName,'zh-CN'));
  return json({ models:governed, compatibleCount:compatible.length, userSelectable:usesCuratedMainCatalogDirectExecution(kind)?policy?.userSelectable!==false:published?policy?.userSelectable===true:kind==='video',
    generationReadyCount:governed.filter(model=>model.generationReady).length,
    defaultModelId:configuredDefault,
    defaultCompatibleModelId:ranked[0]?.id||null,
    depthCloneProfiles:depthClone?depthCloneProfilesForModels(governed):undefined,
    curatedProfiles:kind==='agent'||kind==='image'?commerceCuratedProfilesForModels(kind,annotated):undefined,
    operationRequirements:depthClone?DEPTH_MODEL_CAPABILITY_REQUIREMENTS:(policy?.capabilityRequirements||{}),
    configurationReady:usesCuratedMainCatalogDirectExecution(kind)||!configurationStatus.enabled||Boolean(published),configurationMessage:!usesCuratedMainCatalogDirectExecution(kind)&&configurationStatus.enabled&&!published?'带货配置尚未发布，当前模型仅供选择和配置':null,
    source:'main-model-catalog' });
}catch(e){if(e instanceof Error&&e.message==='UNAUTHORIZED')return errorResponse(e);return json({ models: [], error: '模型服务暂时无法连接，请稍后重试。' }, 503);}}
