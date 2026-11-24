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

export type VideoReferences={images:number;audios:number;videos:number;firstFrame?:boolean;lastFrame?:boolean};

export function supportsProductImage(c:Record<string,unknown>) {
  if(c.supportsImageInput===true||c.supportsReferenceInput===true||c.showFirstFrame===true||c.showLastFrame===true)return true;
  // Older private models can express image support via an explicit limit only.
  return c.supportsImageInput===undefined && c.supportsReferenceInput===undefined && Number(c.maxReferenceImages)>0;
}

export function commerceProductInputIssue(c:Record<string,unknown>,firstFrame:boolean) {
  if(!supportsProductImage(c))return '此渠道缺少带货所需的商品图输入';
  return c.firstFrameInputOnly===true&&!firstFrame?'此渠道仅支持首帧输入':'';
}

export function videoReferenceIssue(c:Record<string,unknown>,r:VideoReferences):string {
  const {images,audios,videos,firstFrame,lastFrame}=r;
  if(images+audios+videos>videoReferenceTotalLimit(c))return '参考素材总数超出该模型能力';
  if(c.firstFrameInputOnly===true&&images&&!firstFrame)return '此渠道只接收首帧，无法按商品参考图提交';
  if(images&&!supportsProductImage(c))return '该渠道不支持商品参考图';
  if(c.requiresImage&&!images)return '此视频模型需要参考图片';
  if(images<capabilityCount(c.minReferenceImages,0)||c.requiresLastFrame&&images<2)return '此模型需要完整的首尾帧或更多参考图片';
  if(images>videoReferenceImageLimit(c))return '参考图数量超出该模型能力';
  if(lastFrame&&!firstFrame)return '指定尾帧时还需要首帧';
  if(firstFrame&&c.showFirstFrame!==true&&c.showLastFrame!==true || lastFrame&&c.showLastFrame!==true)return '此渠道不支持指定的首尾帧';
  if((firstFrame||lastFrame)&&(images!==Number(!!firstFrame)+Number(!!lastFrame)||audios||videos))return '首尾帧需与其他参考素材分开使用';
  if(audios<capabilityCount(c.minReferenceAudios,0))return '此模型需要参考音频';
  if(audios&&(c.supportsAudioInput!==true||audios>capabilityCount(c.maxReferenceAudios,0)))return '模型不支持这些音频参考';
  if(audios&&c.audioRequiresVisualReference===true&&!images&&!videos)return '此模型的参考音频必须与参考图片或视频一起使用';
  // The Commerce submission bridge currently forwards one sourceVideoUrl.
  if(videos&&(c.supportsSourceVideoInput!==true||videos>videoReferenceLimit(c)||c.singleSourceVideoBridge===true&&videos>1))return '模型不支持这些视频参考';
  if(c.requiresSourceVideo&&!videos)return '此模型需要源视频';
  return '';
}

/** Use the same input contract for the picker, quote and job submission. */
export function assertVideoReferenceCapabilities(c:Record<string,unknown>,refs:ReferenceAsset[],roles:readonly {slot?:string}[]=[]) {
  for(const [i,role] of roles.entries()){
    if((role.slot==='first-frame'||role.slot==='last-frame')&&!refs[i]?.type.startsWith('image/'))throw Error('首尾帧需要图片');
  }
  const issue=videoReferenceIssue(c,{
    images:refs.filter(a=>a.type.startsWith('image/')).length,
    audios:refs.filter(a=>a.type.startsWith('audio/')).length,
    videos:refs.filter(a=>a.type.startsWith('video/')).length,
    firstFrame:roles.some(r=>r.slot==='first-frame'),lastFrame:roles.some(r=>r.slot==='last-frame'),
  });
  if(issue)throw Error(issue);
}
