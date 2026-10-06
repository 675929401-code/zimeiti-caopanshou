import {after} from 'next/server';

import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {errorResponse,json} from '../../../../commerce/server/http';
import {authorizeCurrentCommerceIdentity} from '../../../../commerce/server/main-account-access';
import {
  createVoiceReplacement,
  listVoiceReplacements,
  publicVoiceReplaceJob,
  readVoiceReplacement,
  runVoiceReplacementJob,
} from '../../../../commerce/server/voice-replace';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;

function schedule(id:string,owner:string){
  after(()=>runVoiceReplacementJob(id,owner));
}

export async function GET(request:Request){
  try{
    const identity=requireIdentity(request);await authorizeCurrentCommerceIdentity(identity);
    const owner=identity.id,id=new URL(request.url).searchParams.get('id');
    if(id){
      const value=readVoiceReplacement(id,owner);
      if(!value)throw Error('应用配音任务不存在');
      return json({job:publicVoiceReplaceJob(value)});
    }
    return json({jobs:listVoiceReplacements(owner)});
  }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const identity=requireIdentity(request);await authorizeCurrentCommerceIdentity(identity);const owner=identity.id;
    if(Number(request.headers.get('content-length')||0)>16_000)throw Error('应用配音参数过大');
    const body=await request.json();
    if(body.action!=='create')throw Error('应用配音操作无效');
    const result=await createVoiceReplacement(owner,{
      videoAssetId:String(body.videoAssetId||''),
      audioAssetId:String(body.audioAssetId||''),
      mode:body.mode==='mix'?'mix':'replace',
      requestId:String(body.requestId||''),
    });
    if(result.job.status==='queued'||result.job.status==='running')schedule(result.job.id,owner);
    return json(result,result.created?202:200);
  }catch(error){return errorResponse(error);}
}
