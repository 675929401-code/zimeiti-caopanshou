import type {DepthMentionDocument} from './depth-reference-mentions';
import type {Model} from './models';
import {videoReferenceImageLimit} from './video-reference-capabilities';
import {COMMERCE_VIDEO_MAX_TOTAL_DURATION} from '../shared/video-generation-capabilities';
export const DEPTH_PURPOSE='depth-video-clone.generate';
export const DEPTH_MODEL_CAPABILITY_REQUIREMENTS={supportsSourceVideoInput:true,supportsImageInput:true,supportsGenerateAudioToggle:true} as const;
export type DepthRole='product'|'person'|'background'|'voice';
export type DepthReference={id:string;slot:DepthRole};
export type DepthConfig={modelId:string;duration:number|null;aspectRatio:string;resolution:string;generateAudio:boolean;extraInstruction:string;mentions:DepthMentionDocument};
export const defaultDepthConfig:DepthConfig={modelId:'',duration:null,aspectRatio:'9:16',resolution:'720p',generateAudio:true,extraInstruction:'',mentions:{text:'',mentions:[]}};
export type DepthSource={assetId:string;sha256:string;name:string;type:string;bytes:number;durationSeconds:number;startTimestampSeconds:number;width:number;height:number;fps:number;frameCount:number;hasAudioTrack:boolean};
export type DepthPrepared={id:string;version:string;source:DepthSource;clip:{sha256:string;bytes:number;durationSeconds:number;hasAudioTrack:boolean};range:{mode:'leading';start:0;end:number};facts:{audioUnderstanding:'unknown';sourceBlackSegments:{start:number;end:number}[];clipBlackTail:boolean};createdAt:number};
export type DepthPreparation={id:string;status:'queued'|'running'|'succeeded'|'failed';sourceAssetId:string;sourceSha256:string;targetDuration:number|null;result?:DepthPrepared;error?:string;startedAt:number;workerId?:string;leaseUntil?:number;recoveryAttempts?:number};
export type DepthSession={id:string;owner:string;contextId:string;revision:number;createdAt:number;updatedAt:number;sourceAssetId:string|null;sourceSha256:string|null;sourceSnapshot?:DepthSource;references:DepthReference[];config:DepthConfig;preparation?:DepthPreparation;activeJobId?:string;history:string[];favoriteJobIds:string[];error?:string};
export type DepthSnapshot={sessionId:string;revision:number;source:DepthSource;prepared:DepthPrepared;references:(DepthReference&{sha256:string;name:string;type:string;bytes:number})[];config:DepthConfig;retrySourceJobId?:string};
export function depthDuration(source:number,requested?:number|null){if(!Number.isFinite(source)||source<4||source>COMMERCE_VIDEO_MAX_TOTAL_DURATION+0.4+1e-9)throw Error(`参考视频实际时长必须为4–${COMMERCE_VIDEO_MAX_TOTAL_DURATION}秒（最多0.4秒尾差）`);const limit=Math.min(COMMERCE_VIDEO_MAX_TOTAL_DURATION,Math.max(4,Math.floor(source+1e-6)));if(requested===null||requested===undefined)return limit;if(!Number.isInteger(requested)||requested<4||requested>limit)throw Error('输出时长必须为4到'+limit+'秒的整数，使用原片开头区间');return requested;}
export function depthConfig(value:unknown):DepthConfig{const c=value as DepthConfig;if(!c||typeof c!=='object'||typeof c.modelId!=='string'||c.modelId.length>200||c.duration!==null&&(!Number.isInteger(c.duration)||c.duration<4||c.duration>COMMERCE_VIDEO_MAX_TOTAL_DURATION)||!['21:9','16:9','4:3','1:1','3:4','9:16'].includes(c.aspectRatio)||!['480p','720p','1080p','2k','4k'].includes(String(c.resolution).toLowerCase())||typeof c.generateAudio!=='boolean'||typeof c.extraInstruction!=='string'||c.extraInstruction.length>4000)throw Error('深度复刻参数无效');return {...c,resolution:c.resolution.toLowerCase()};}
export const depthImageIds=(refs:DepthReference[])=>['product','person','background'].flatMap(slot=>refs.filter(r=>r.slot===slot).map(r=>r.id));
export function depthModelDurationOptions(capabilities:Record<string,unknown>,sourceDuration:number):number[]{
 const sourceLimit=Math.min(COMMERCE_VIDEO_MAX_TOTAL_DURATION,Math.max(4,Math.floor(sourceDuration+1e-6))),mode=String(capabilities.durationMode||'');
 if(mode==='range'){
  const min=Math.max(4,Math.ceil(Number(capabilities.minDuration)||4)),max=Math.min(sourceLimit,Math.floor(Number(capabilities.maxDuration)||0)),step=Number(capabilities.durationStep)||1;
  if(max<min||!Number.isFinite(step)||step<=0)return [];
  return Array.from({length:max-min+1},(_,index)=>index+min).filter(value=>Math.abs((value-min)/step-Math.round((value-min)/step))<1e-8);
 }
 const raw=capabilities.nativeDurations||capabilities.durationOptions;
 return Array.isArray(raw)?[...new Set(raw.map(Number).filter(value=>Number.isInteger(value)&&value>=4&&value<=sourceLimit))].sort((a,b)=>a-b):[];
}
/** No capability is inferred from a model's display name. These are real wire gates. */
export function validateDepthModel(model:Model,snapshot:DepthSnapshot){const c=model.capabilities,d=snapshot.prepared.range.end,images=depthImageIds(snapshot.references),hasVoice=snapshot.references.some(r=>r.slot==='voice');
 if(model.kind!=='video'||c.available===false||c.executionSupported===false)throw Error('此模型的深度复刻执行链路尚未接通；编辑和保存仍可用');
 if(c.supportsSourceVideoInput!==true)throw Error('此模型不支持源视频输入，请选择带“源视频复刻”能力的模型');
 if(c.supportsImageInput!==true&&c.supportsReferenceInput!==true)throw Error('此模型不支持人物、商品或环境替换图片');
 if(images.length>videoReferenceImageLimit(c))throw Error(`此模型最多支持 ${videoReferenceImageLimit(c)} 张替换图片`);
 if(hasVoice&&(c.supportsAudioInput!==true||Number(c.maxReferenceAudios||0)<1))throw Error('此模型不支持声音参考');
 if(!depthModelDurationOptions(c,snapshot.source.durationSeconds).includes(d))throw Error('此模型不支持所选原生时长；深度复刻不会把同一源视频重复分段生成');
 if(Array.isArray(c.aspectRatios)&&c.aspectRatios.length&&!c.aspectRatios.includes(snapshot.config.aspectRatio))throw Error('此模型不支持所选画幅');
 if(Array.isArray(c.resolutionOptions)&&c.resolutionOptions.length&&!c.resolutionOptions.some(r=>String(r).toLowerCase()===snapshot.config.resolution))throw Error('此模型不支持所选分辨率');
 if(c.supportsGenerateAudioToggle!==true)throw Error('此模型尚未验证声音开关传输，未提交生成');
}
export const DEPTH_DEFAULT_PROMPT='你执行基于真实参考视频的深度复刻。源视频仅用于动作、镜头、节奏与布局；商品、人物、背景按分角色参考替换。未提供替换参考的部分尽量保持原结构。严格使用给定leading区间和时长，保留商品结构与标志，不编造产品事实。补充说明优先；图片编号按商品、人物、背景排序。原音轨仅是输入，未经转写不能声称已确认台词或音乐。声音参考与生成声音意图单独处理，不能把保留声音、保留口播和保留字幕混为一项。本模板为独立实现，未取得对标私有提示词。';
