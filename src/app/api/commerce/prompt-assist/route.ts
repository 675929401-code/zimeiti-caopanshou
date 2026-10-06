import {after} from 'next/server';
import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {json,errorResponse} from '../../../../commerce/server/http';
import {openAssist,readAssist,publicAssist,editAssist,quoteAssist} from '../../../../commerce/server/prompt-assist';
import {refreshJob} from '../../../../commerce/server/jobs';
import {startAssistPreparation,runAssistPreparation,applyAssist} from '../../../../commerce/server/prompt-assist-reference';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=300;
export async function GET(request:Request){try{const owner=requireIdentity(request).id;const s=readAssist(owner,new URL(request.url).searchParams.get('id')||'');if(s.activeJobId)after(()=>refreshJob(s.activeJobId!,owner));if(s.preparation&&['queued','running'].includes(s.preparation.status))after(()=>runAssistPreparation(owner,s.id,s.preparation!.id));return json({session:publicAssist(s)});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{sameOrigin(request);const owner=requireIdentity(request).id;const body=await request.json();
 if(body.action==='open')return json({session:publicAssist(openAssist(owner,body))});
 if(body.action==='edit')return json({session:publicAssist(editAssist(owner,body.id,body.revision,body.changes))});
 if(body.action==='prepare-reference'){const s=startAssistPreparation(owner,body.id,body.revision);after(()=>runAssistPreparation(owner,s.id,s.preparation!.id));return json({session:publicAssist(s)},202);}
 if(body.action==='apply')return json({application:applyAssist(owner,body.id,body.revision)});
 if(body.action==='quote')return json({quote:await quoteAssist(owner,body.id,body.revision,body.stage)});
 if(body.action==='confirm')throw Error('请通过统一任务接口确认报价');
 throw Error('帮我写操作无效');
 }catch(error){return errorResponse(error);}}
