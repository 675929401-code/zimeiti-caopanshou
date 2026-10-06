import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {list,remove} from '../../../../commerce/server/store';
import type {Conversation} from '../../../../commerce/server/jobs';
import {json,errorResponse} from '../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request){try{return json({conversations:list<Conversation>('conversations',requireIdentity(request).id)});}catch(e){return errorResponse(e);}}
export async function DELETE(request:Request){try{sameOrigin(request);const user=requireIdentity(request);const {id}=await request.json();remove('conversations',id,user.id);return json({ok:true});}catch(e){return errorResponse(e);}}
