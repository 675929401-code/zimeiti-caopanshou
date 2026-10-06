import {after} from 'next/server';
import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {errorResponse,json} from '../../../../commerce/server/http';
import {
  confirmHotVideoRemix,
  listHotVideoRemixes,
  publicHotVideoRemixJob,
  quoteHotVideoRemix,
  readHotVideoRemix,
  recoverStaleHotVideoRemix,
  runHotVideoRemix,
} from '../../../../commerce/server/hot-video-remix';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;

function schedule(id:string,owner:string){
  after(async()=>{
    recoverStaleHotVideoRemix(id,owner);
    await runHotVideoRemix(id,owner);
  });
}

export async function GET(request:Request){
  try{
    const owner=requireIdentity(request).id,id=new URL(request.url).searchParams.get('id');
    if(id){
      const value=readHotVideoRemix(id,owner);
      if(!value)throw Error('爆款视频二创任务不存在');
      if(value.status==='queued'||value.status==='running')schedule(value.id,owner);
      return json({job:publicHotVideoRemixJob(value)});
    }
    const jobs=listHotVideoRemixes(owner);
    for(const job of jobs.filter(value=>value.status==='queued'||value.status==='running').slice(0,2))schedule(job.id,owner);
    return json({jobs});
  }catch(error){return errorResponse(error);}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const owner=requireIdentity(request).id;
    if(Number(request.headers.get('content-length')||0)>32_000)throw Error('爆款视频二创参数过大');
    const body=await request.json();
    if(body.action==='quote')return json({quote:await quoteHotVideoRemix(owner,body)});
    if(body.action==='confirm'){
      const result=confirmHotVideoRemix(owner,String(body.quoteId||''));
      schedule(result.job.id,owner);
      return json(result,result.created?202:200);
    }
    throw Error('爆款视频二创操作无效');
  }catch(error){return errorResponse(error);}
}
