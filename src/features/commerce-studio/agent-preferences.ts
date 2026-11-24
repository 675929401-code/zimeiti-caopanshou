export type PreferenceMedia = 'video' | 'image';
// Agent preferences and the direct-generation editor have different model orders.
const preferenceModelGroups:Record<PreferenceMedia,string[][]>={
  video:[
    ['seedance-2.0','seedance2.0','doubao-seedance-2-0-260128'],
    ['seedance-2.0-fast','doubao-seedance-2-0-fast-260128'],
    ['seedance-2.0-mini'],
    ['seedance-2.5','doubao-seedance-2-5-260628'],
    ['seedance-2.5-flash','doubao-seedance-2-5-flash-261115'],
  ],
  image:[['lc image 2.5 fast'],['lc image 2.5 pro'],['seedream 5.5','doubao-seedream-5-5-261028']],
};
export function agentPreferenceModelRank(kind:PreferenceMedia,modelName?:string){
  const rank=preferenceModelGroups[kind].findIndex(group=>group.includes(String(modelName||'').trim().toLowerCase()));
  return rank<0?preferenceModelGroups[kind].length:rank;
}
export type MediaPreferences = {model:string; ratio:string; resolution:string; duration:string; quality:string; format:string};
export type AgentPreferences = Record<PreferenceMedia,MediaPreferences>;
export const defaultMediaPreferences:MediaPreferences={model:'',ratio:'',resolution:'',duration:'',quality:'',format:''};
export const defaultAgentPreferences:AgentPreferences={video:{...defaultMediaPreferences},image:{...defaultMediaPreferences}};
export const preferenceRatios={video:['21:9','16:9','4:3','1:1','3:4','9:16'],image:['16:9','4:3','1:1','3:4','9:16']};
export const preferenceResolutions={video:['480P','720P','1080P'],image:['1K','2K','4K']};
export function validMediaPreference(kind:PreferenceMedia,key:keyof MediaPreferences,value:string){
 if(value==='')return true;
 if(key==='model')return /^[a-zA-Z0-9_.:-]{1,150}$/.test(value);
 if(key==='ratio')return preferenceRatios[kind].includes(value);
 if(key==='resolution')return preferenceResolutions[kind].includes(value);
 if(key==='duration')return kind==='video'&&/^([1-9]|[1-5][0-9]|60)$/.test(value);
 if(key==='quality')return kind==='image'&&['标准','高','超高'].includes(value);
 return key==='format'&&kind==='image'&&['PNG','JPEG'].includes(value);
}
export type PreferenceModel = {id:string; name:string; available:boolean};
export function preferenceBrief(prefs:AgentPreferences,models:Record<PreferenceMedia,PreferenceModel[]>) {
 const lines=[];
 for(const kind of ['image','video'] as const){
  const item=prefs[kind], model=models[kind].find(x=>x.id===item.model&&x.available);
  const parts=[model&&'模型 '+model.name,item.ratio&&'比例 '+item.ratio,item.resolution&&'分辨率 '+item.resolution,item.duration&&'时长 '+item.duration+' 秒',item.quality&&'画质 '+item.quality,item.format&&'格式 '+item.format].filter(Boolean);
  if(parts.length)lines.push((kind==='image'?'图片':'视频')+'偏好：'+parts.join('、'));
 }
 return lines.length?'会员创作偏好（如本轮另有明确要求，以本轮为准）：\n'+lines.join('\n'):'';
}
