import type {VideoGenerateParams,VideoModelConfig} from '../../lib/video-adapter';
import {gaoruiSeedanceNativeBody,isGaoruiSeedanceNativeModel} from '../../lib/gaorui-seedance-native-contract';

type Media = {images:string[];audios:string[];videos:string[]};

/** Commerce keeps source, replacement reference and first/last frame roles distinct on the native wire. */
export function commerceVideoParameters(config:VideoModelConfig,base:VideoGenerateParams,media:Media,frames:boolean):VideoGenerateParams {
  const {images,audios,videos}=media;
  if(config.protocol_type==='toapis_video'){
    return {...base,imageUrl:frames?images[0]:undefined,lastFrameUrl:frames?images[1]:undefined,
      imageUrls:frames?images.slice(2):images,sourceVideoUrl:videos[0],audioUrls:audios};
  }
  if(config.protocol_type==='gaorui_video'&&isGaoruiSeedanceNativeModel(config.model_name)){
    const plain=config.model_name==='seedance-2.0'||config.model_name==='seedance-2.5';
    const framed=plain||frames;
    const params:VideoGenerateParams={...base,commerceReferenceSubmission:true,sourceVideoUrl:videos[0],audioUrls:audios,
      ...(framed?{imageUrl:images[0],lastFrameUrl:images[1],imageUrls:images.slice(2)}:{imageUrls:images})};
    try{gaoruiSeedanceNativeBody(config,params);}catch{
      throw new Error('VIDEO_MEDIA_CONTRACT_REJECTED_BEFORE_DISPATCH');
    }
    return params;
  }
  return {...base,imageUrl:images[0],imageUrls:images,lastFrameUrl:frames?images[1]:undefined,sourceVideoUrl:videos[0],audioUrl:audios[0],audioUrls:audios};
}
