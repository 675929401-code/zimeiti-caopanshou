type ReferenceAsset={type:string};

export const DEFAULT_VIDEO_REFERENCE_IMAGE_LIMIT=1;

function capabilityCount(value:unknown,fallback:number){
  if(value===undefined||value===null)return fallback;
  const count=Number(value);if(!Number.isInteger(count)||count<0)throw Error('模型参考素材能力配置无效');return count;
}

export function videoReferenceLimit(capabilities:Record<string,unknown>){
  const configured=capabilities.maxReferenceVideos??1,value=Number(configured);
  return Number.isFinite(value)&&Number.isInteger(value)&&value>=0?value:0;
}

export function videoReferenceImageLimit(capabilities:Record<string,unknown>){
  return capabilityCount(capabilities.maxReferenceImages,DEFAULT_VIDEO_REFERENCE_IMAGE_LIMIT);
}

export function videoReferenceTotalLimit(capabilities:Record<string,unknown>){
  return capabilityCount(capabilities.maxReferenceFiles,15);
}

/** Rolling generation adds one tail-frame image to the next segment request. */
export function assertRollingTailFrameCapacity(capabilities:Record<string,unknown>,refs:ReferenceAsset[]){
  const imageCount=refs.filter(asset=>asset.type.startsWith('image/')).length;
  if(imageCount+1>videoReferenceImageLimit(capabilities))throw Error('该视频模型无法同时容纳原始商品参考和滚动尾帧，请更换兼容模型');
  if(refs.length+1>videoReferenceTotalLimit(capabilities))throw Error('该视频模型的参考文件总数无法再容纳滚动尾帧，请减少原始参考素材');
}

/** Shared fail-closed validation used before quote creation and again before a job is saved. */
export function assertVideoReferenceCapabilities(capabilities:Record<string,unknown>,refs:ReferenceAsset[]){
  if(refs.length>videoReferenceTotalLimit(capabilities))throw Error('参考素材总数超出该模型能力');
  const images=refs.filter(asset=>asset.type.startsWith('image/'));
  const audios=refs.filter(asset=>asset.type.startsWith('audio/'));
  const videos=refs.filter(asset=>asset.type.startsWith('video/'));
  if(capabilities.requiresImage&&!images.length)throw Error('此视频模型需要参考图片');
  if(images.length<capabilityCount(capabilities.minReferenceImages,0)||capabilities.requiresLastFrame&&images.length<2)throw Error('此模型需要完整的首尾帧或更多参考图片');
  if(images.length>videoReferenceImageLimit(capabilities))throw Error('参考图数量超出该模型能力');
  if(audios.length&&(capabilities.supportsAudioInput!==true||audios.length>capabilityCount(capabilities.maxReferenceAudios,0)))throw Error('模型不支持这些音频参考');
  if(audios.length&&capabilities.audioRequiresVisualReference===true&&!images.length&&!videos.length)throw Error('此模型的参考音频必须与参考图片或视频一起使用');
  if(videos.length&&(capabilities.supportsSourceVideoInput!==true||videos.length>videoReferenceLimit(capabilities)))throw Error('模型不支持这些视频参考');
  if(capabilities.requiresSourceVideo&&!videos.length)throw Error('此模型需要源视频');
}
