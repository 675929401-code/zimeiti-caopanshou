import type {Model} from './models';

export type DepthCloneProfileId='benchmark-seedance-2-5'|'value-minimax-h3-ref2va';
export type DepthCloneProfileRole='benchmark'|'value';

export type DepthCloneDurationExample={
  sourceSeconds:20|30|60|70|80;
  segmentSeconds:number[];
  note:string;
};

export type DepthCloneProfilePublic={
  id:DepthCloneProfileId;
  label:string;
  role:DepthCloneProfileRole;
  status:'ready'|'missing';
  boundModelId:string|null;
  boundModelName:string|null;
  statusMessage:string;
  officialBoundary:{
    supportsSourceVideo:true;
    outputSeconds:{min?:number;max:number};
    referenceImages:{recommendedMin:number;recommendedMax:number;extendedMax:number;technicalMax:number;extendedStabilityNotice:string};
    referenceVideos?:{maxCount:number;maxTotalSeconds:number};
    referenceAudios?:{maxCount:number;maxTotalSeconds:number;cannotBeOnlyReference:boolean};
    maxReferenceFiles?:number;
    requiresTextPrompt?:boolean;
    outputFrameRate?:number;
    outputAudio?:{sampleRateHz:number;channels:number};
    sourceVideoRecommendedMaxSeconds?:number;
    notes:string[];
    sourceUrl:string;
  };
  durationPolicy:{
    singleRequestMaxSeconds:number;
    recommendedSegmentMaxSeconds:number;
    requiresOrchestrationAboveSeconds:number;
    executionConnected:false;
    examples:DepthCloneDurationExample[];
    note:string;
  };
};

type DepthCloneModelLike=Pick<Model,'id'|'displayName'|'kind'|'capabilities'>
  & Partial<Pick<Model,'modelName'>>
  & {generationReady?:boolean};

const SEEDANCE_25_FAMILY=/(?:^|[^a-z0-9])(?:doubao[-_. ]*)?seedance[-_. ]*2[-_. ]*5(?:[^a-z0-9]|$)/iu;
const MINIMAX_H3_REF2VA_FAMILY=/(?:^|[^a-z0-9])(?:minimax[-_. ]*)?h3(?:[-_. ]*base)?[-_. ]*ref2va(?:[^a-z0-9]|$)/iu;

function identityText(model:DepthCloneModelLike):string{
  const capabilities=model.capabilities||{};
  return [
    model.modelName,
    capabilities.family,
    capabilities.modelFamily,
    capabilities.providerModel,
    model.displayName,
  ].filter(value=>typeof value==='string'&&value.trim()).join(' ');
}

function supportsReplacementImages(capabilities:Record<string,unknown>):boolean{
  return capabilities.supportsImageInput===true||capabilities.supportsReferenceInput===true;
}

/**
 * Classifies only the two reviewed deep-clone families. Capabilities are a
 * mandatory second gate, so a familiar display name cannot make an ordinary
 * image-to-video model selectable.
 */
export function classifyDepthCloneModel(model:DepthCloneModelLike):DepthCloneProfileId|null{
  if(model.kind!=='video')return null;
  const capabilities=model.capabilities||{};
  if(capabilities.supportsSourceVideoInput!==true||!supportsReplacementImages(capabilities))return null;
  const identity=identityText(model);
  if(SEEDANCE_25_FAMILY.test(identity)&&Number(capabilities.maxReferenceImages||0)>=1)return 'benchmark-seedance-2-5';
  if(MINIMAX_H3_REF2VA_FAMILY.test(identity)
    &&Number(capabilities.maxReferenceImages||0)>=9
    &&Number(capabilities.maxReferenceVideos||0)>=3
    &&capabilities.supportsAudioInput===true
    &&Number(capabilities.maxReferenceAudios||0)>=3
    &&Number(capabilities.maxReferenceFiles||0)>=12
    &&capabilities.audioRequiresVisualReference===true)return 'value-minimax-h3-ref2va';
  return null;
}

const PROFILE_SPECS:ReadonlyArray<Omit<DepthCloneProfilePublic,'status'|'boundModelId'|'boundModelName'|'statusMessage'>>=[
  {
    id:'benchmark-seedance-2-5',
    label:'Seedance 2.5 · 对标复刻',
    role:'benchmark',
    officialBoundary:{
      supportsSourceVideo:true,
      outputSeconds:{max:30},
      referenceImages:{
        recommendedMin:1,
        recommendedMax:5,
        extendedMax:8,
        technicalMax:30,
        extendedStabilityNotice:'6–8 张参考图可用，但一致性和指令遵循稳定性可能下降。',
      },
      sourceVideoRecommendedMaxSeconds:20,
      notes:['单次输出最长 30 秒。','视频编辑建议源片不超过 20 秒。','1–5 张参考图是推荐区间，6–8 张属于可用但稳定性下降区间。'],
      sourceUrl:'https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh',
    },
    durationPolicy:{
      singleRequestMaxSeconds:30,
      recommendedSegmentMaxSeconds:20,
      requiresOrchestrationAboveSeconds:20,
      executionConnected:false,
      examples:[
        {sourceSeconds:20,segmentSeconds:[20],note:'20 秒可按一个推荐编辑段处理。'},
        {sourceSeconds:30,segmentSeconds:[15,15],note:'30 秒按镜头边界拆为 2 段，降低单段编辑漂移。'},
        {sourceSeconds:60,segmentSeconds:[20,20,20],note:'按镜头与音频边界拆为 3 段，每段不超过 20 秒。'},
        {sourceSeconds:70,segmentSeconds:[20,20,15,15],note:'按镜头与音频边界拆为 4 段，避免产生过短尾段。'},
        {sourceSeconds:80,segmentSeconds:[20,20,20,20],note:'按镜头与音频边界拆为 4 个推荐编辑段。'},
      ],
      note:'这里只给出分段编排建议；分段提交、失败重试与合并链路尚需单独接通和验收。',
    },
  },
  {
    id:'value-minimax-h3-ref2va',
    label:'MiniMax H3 Ref2VA · 性价比',
    role:'value',
    officialBoundary:{
      supportsSourceVideo:true,
      outputSeconds:{min:4,max:15},
      referenceImages:{
        recommendedMin:1,
        recommendedMax:9,
        extendedMax:9,
        technicalMax:9,
        extendedStabilityNotice:'最多 9 张参考图；不能把普通 H3 多图生视频当作 Ref2VA 源视频复刻。',
      },
      referenceVideos:{maxCount:3,maxTotalSeconds:15},
      referenceAudios:{maxCount:3,maxTotalSeconds:15,cannotBeOnlyReference:true},
      maxReferenceFiles:12,
      requiresTextPrompt:true,
      outputFrameRate:24,
      outputAudio:{sampleRateHz:32000,channels:2},
      sourceVideoRecommendedMaxSeconds:15,
      notes:['单次输出 4–15 秒，支持 768P 与 2K。','最多 9 张参考图、3 个参考视频和 3 个参考音频，全部参考文件合计最多 12 个。','参考视频总时长不超过 15 秒，参考音频总时长不超过 15 秒；音频不能作为唯一参考，文字提示词不能为空。','首尾帧模式与多模态参考模式互斥。'],
      sourceUrl:'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
    },
    durationPolicy:{
      singleRequestMaxSeconds:15,
      recommendedSegmentMaxSeconds:15,
      requiresOrchestrationAboveSeconds:15,
      executionConnected:false,
      examples:[
        {sourceSeconds:20,segmentSeconds:[10,10],note:'按镜头边界均衡拆为 2 段。'},
        {sourceSeconds:30,segmentSeconds:[15,15],note:'拆为 2 个原生 15 秒段。'},
        {sourceSeconds:60,segmentSeconds:[15,15,15,15],note:'拆为 4 个原生 15 秒段。'},
        {sourceSeconds:70,segmentSeconds:[14,14,14,14,14],note:'均衡拆为 5 段，所有分段均处于 15 秒上限内。'},
        {sourceSeconds:80,segmentSeconds:[14,14,13,13,13,13],note:'均衡拆为 6 段，覆盖 80 秒且每段处于 4–15 秒。'},
      ],
      note:'这里只给出分段编排建议；当前普通 H3 渠道没有源视频输入能力，不能据此宣称深度复刻可执行。',
    },
  },
] as const;

function isGenerationReady(model:DepthCloneModelLike):boolean{
  // A catalog capability row alone is not paid-generation evidence. The
  // caller must supply the route's explicit acceptance-backed readiness bit.
  return model.generationReady===true;
}

export function depthCloneProfilesForModels(models:ReadonlyArray<DepthCloneModelLike>):DepthCloneProfilePublic[]{
  return PROFILE_SPECS.map(spec=>{
    const matches=models.filter(model=>classifyDepthCloneModel(model)===spec.id);
    const bound=matches.find(isGenerationReady)||matches[0]||null;
    const ready=Boolean(bound&&isGenerationReady(bound));
    const missingMessage=bound
      ?`已识别 ${bound.displayName}，但尚未通过当前深度复刻生成准入。`
      :spec.id==='benchmark-seedance-2-5'
        ?'尚未找到已接通并通过生成准入的 Seedance 2.5 源视频编辑模型。'
        :'尚未找到已接通并通过生成准入的 MiniMax H3 Ref2VA；普通 H3 多图模型不具备源视频复刻能力。';
    return {
      ...spec,
      status:ready?'ready':'missing',
      boundModelId:bound?.id||null,
      boundModelName:bound?.displayName||null,
      statusMessage:ready?`已精确绑定 ${bound?.displayName||bound?.id}。`:missingMessage,
    };
  });
}
