import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {json,errorResponse} from '../../../../commerce/server/http';
import {applyDirector,directorPage,openDirector,quoteDirectorTurn,readDirector} from '../../../../commerce/server/director-conversation';
import {DirectorConflict} from '../../../../commerce/server/director-turn-claim';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=300;
function failure(error:unknown){return error instanceof DirectorConflict?json({error:error.message,code:error.code},error.status):errorResponse(error);}
export async function GET(request:Request){try{const owner=requireIdentity(request).id,url=new URL(request.url);return json({conversation:directorPage(readDirector(owner,url.searchParams.get('id')||''),url.searchParams.get('beforeMessageId'),Number(url.searchParams.get('limit')||20))});}catch(error){return failure(error);}}
export async function POST(request:Request){try{sameOrigin(request);const owner=requireIdentity(request).id,body=await request.json();
  if(body.action==='open')return json({conversation:directorPage(openDirector(owner,body.id,body.settings))});
  if(body.action==='quote')return json({quote:await quoteDirectorTurn(owner,body)},201);
  if(body.action==='turn')throw new DirectorConflict('请先查看并确认本轮编导费用','DIRECTOR_QUOTE_REQUIRED',409);
  if(body.action==='apply')return json({application:applyDirector(owner,body)});
  throw new DirectorConflict('编导操作无效','DIRECTOR_ACTION_INVALID',400);
}catch(error){return failure(error);}}
