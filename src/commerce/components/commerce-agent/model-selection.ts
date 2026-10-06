type Choice={id:string;capabilities:Record<string,unknown>;generationReady?:boolean;selectionCompatible?:boolean;modeCompatible?:boolean;modeIncompatibleReasons?:string[]};
export function availableModelId(items:Choice[],current?:string,preferred?:string){
 const available=items.filter(item=>item.capabilities.available!==false&&item.selectionCompatible!==false&&item.modeCompatible!==false);
 const ready=available.filter(item=>item.generationReady!==false);
 return ready.find(item=>item.id===current)?.id||ready.find(item=>item.id===preferred)?.id||ready[0]?.id
  ||available.find(item=>item.id===current)?.id||available.find(item=>item.id===preferred)?.id||available[0]?.id||'';
}

export type VideoModelCatalogContext={
 referenceImages:number;
 sourceVideos:number;
 referenceAudios:number;
 duration:number;
 aspectRatio:string;
 resolution:string;
 requireAudioToggle:boolean;
};

/**
 * Keep the model selector bound to the exact video input the user is editing.
 * The API uses these fields to return per-model compatibility reasons; omitting
 * them turns the selector into a static catalogue and defers errors to submit.
 */
export function videoModelCatalogUrl(context:VideoModelCatalogContext){
 const params=new URLSearchParams({
  kind:'video',
  operationId:'video.generate',
  referenceImages:String(Math.max(0,Math.trunc(context.referenceImages))),
  sourceVideos:String(Math.max(0,Math.trunc(context.sourceVideos))),
  referenceAudios:String(Math.max(0,Math.trunc(context.referenceAudios))),
  duration:String(context.duration),
  aspectRatio:context.aspectRatio,
  resolution:context.resolution,
  generateAudioToggle:context.requireAudioToggle?'1':'0',
 });
 return `/api/commerce/models?${params.toString()}`;
}
