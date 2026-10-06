export type FrameMode='seconds'|'shot-starts'|'shot-boundaries'|'first'|'last';
export const FRAME_MODES:FrameMode[]=['seconds','shot-starts','shot-boundaries','first','last'];
export const MAX_FRAME_RESULTS=100;
export type FrameInput={requestId:string;assetId:string;mode:FrameMode;contextKey:string;remainingSlots:number};
export type ExtractedFrame={assetId:string;sourceAssetId:string;index:number;time:number;sourceTime:number;sourcePts:string;timeBase:{numerator:number;denominator:number};decodeIndex:number;role:'sample'|'first'|'last'|'shot-start'|'shot-end';shotIndex?:number;requestedTime?:number};
export type FrameExtractionJob={id:string;input:FrameInput;sourceAssetId:string;sourceSha256:string;status:'queued'|'running'|'succeeded'|'failed'|'interrupted';phase:'queued'|'analyzing'|'extracting'|'saving'|'complete';createdAt:number;updatedAt:number;frames:ExtractedFrame[];plannedCount?:number;duration?:number;sourceStartTime?:number;detector:'actual-frame-pts'|'ffmpeg-scene-threshold-0.3';error?:string;errorCode?:string;requiredSlots?:number;availableSlots?:number};
export function frameInput(value:unknown):FrameInput{
 if(!value||typeof value!=='object')throw Error('抽帧参数无效');const data=value as FrameInput;
 if(typeof data.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(data.requestId))throw Error('请提供有效抽帧请求号');
 if(typeof data.assetId!=='string'||!data.assetId||data.assetId.length>80||!FRAME_MODES.includes(data.mode)||typeof data.contextKey!=='string'||!data.contextKey||data.contextKey.length>200)throw Error('抽帧素材、方式或画布上下文无效');
 if(!Number.isSafeInteger(data.remainingSlots)||data.remainingSlots<0||data.remainingSlots>MAX_FRAME_RESULTS)throw Error('画布剩余位置须为0至100的整数');
 return {requestId:data.requestId,assetId:data.assetId,mode:data.mode,contextKey:data.contextKey,remainingSlots:data.remainingSlots};
}
