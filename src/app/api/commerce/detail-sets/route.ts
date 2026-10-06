import {after} from 'next/server';
import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {json,errorResponse} from '../../../../commerce/server/http';
import {openDetailSet,readDetailSet,publicDetailSet,listDetailSets,editDetailSet,quoteDetailSet,confirmDetailSet,advanceDetailSet,releasePausedDetailRun} from '../../../../commerce/server/detail-sets';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=300;
export async function GET(request:Request){try{const owner=requireIdentity(request).id,id=new URL(request.url).searchParams.get('id');if(!id)return json({sessions:listDetailSets(owner)});const s=readDetailSet(owner,id);if(s.analysisActiveJobId||s.activeRunId)after(()=>advanceDetailSet(owner,id));return json({session:publicDetailSet(s)});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{sameOrigin(request);const owner=requireIdentity(request).id,body=await request.json();
 if(body.action==='open')return json({session:publicDetailSet(openDetailSet(owner,body))});
 if(body.action==='edit')return json({session:publicDetailSet(editDetailSet(owner,body.id,body.revision,body.changes))});
 if(body.action==='quote')return json({quote:await quoteDetailSet(owner,body.id,body.revision,body.stage,body.rowId)});
 if(body.action==='confirm'){const result=await confirmDetailSet(owner,body.quoteId);after(()=>advanceDetailSet(owner,result.sessionId));return json(result,202);}
 if(body.action==='release-paused')return json({session:publicDetailSet(releasePausedDetailRun(owner,body.id,body.revision))});
 throw Error('商详操作无效');
 }catch(error){return errorResponse(error);}}
