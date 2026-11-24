import {requireIdentity,sameOrigin} from '@/commerce/server/auth';
import {publicAsset,readAsset,mutateAssets} from '@/commerce/server/assets';
import {json,errorResponse} from '@/commerce/server/http';
import {characterImageSlots} from '@/commerce/shared/character-profile';

function optionalId(value:unknown):string|null{
  if(value==null)return null;
  if(typeof value!=='string'||!/^[a-f0-9-]{36}$/i.test(value))throw Error('素材标识无效');
  return value;
}

export async function GET(request:Request){
  try{
    const {id:owner}=requireIdentity(request),id=optionalId(new URL(request.url).searchParams.get('id'));
    const asset=id?readAsset(id,owner):undefined;
    if(!asset||asset.collection!=='roles')return json({error:'角色不存在'},404);
    const saved=asset.characterProfile;
    const usable=(id:string|null)=>id&&readAsset(id,owner)?id:null;
    return json({profile:saved?{...saved,images:saved.images.map(usable),audioId:usable(saved.audioId),videoId:usable(saved.videoId)}:null});
  }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const {id:owner}=requireIdentity(request), body=await request.json();
    if(body?.consent!==true)throw Error('请确认拥有提交素材的使用权或已获得授权');
    if(!Array.isArray(body.images)||body.images.length!==characterImageSlots.length)throw Error('角色参考图槽位无效');
    const images:(string|null)[]=body.images.map(optionalId), front=images[0];
    if(!front)throw Error('请先选择人物正脸图');
    const audioId=optionalId(body.audioId),videoId=optionalId(body.videoId);
    const verify=()=>{
      for(const [id,kind] of [...images.map(id=>[id,'image/'] as const),[audioId,'audio/'] as const,[videoId,'video/'] as const]){
        if(id&&!readAsset(id,owner)?.type.startsWith(kind))throw Error('引用素材不存在或类型不匹配');
      }
    };
    const [asset]=await mutateAssets(owner,[front],([primary])=>{
      const old=primary.characterProfile;
      if(old&&(JSON.stringify(old.images)!==JSON.stringify(images)||old.audioId!==audioId||old.videoId!==videoId))throw Error('这张正脸图已有另一份角色档案，请选择另一张图');
      return [{...primary,collection:'roles',characterProfile:{images,audioId,videoId,consentAt:old?.consentAt||Date.now()}}];
    },undefined,verify);
    return json({asset:publicAsset(asset)});
  }catch(error){return errorResponse(error);}
}
