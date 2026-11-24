import {requireIdentity,sameOrigin} from '../../../../commerce/server/auth';
import {get,list,put,remove} from '../../../../commerce/server/store';
import type {Conversation} from '../../../../commerce/server/jobs';
import type {DirectorConversation} from '../../../../commerce/server/director-conversation-schema';
import {inspectDirectorMessage} from '../../../../commerce/server/director-turn-claim';
import {json,errorResponse} from '../../../../commerce/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
function memberTranscript(conversation:Conversation,owner:string):Conversation{
  if(!conversation.messages.some(m=>m.role==='assistant'&&m.jobId&&/^\s*(?:`{3}json\s*)?\{/.test(m.content)))return conversation;
  const director=get<DirectorConversation>('director-conversations',conversation.id,owner);
  if(!director)return conversation;
  const replies=new Map(director.messages.filter(m=>m.role==='assistant'&&m.outputProtocol).map(m=>[m.jobId,m]));
  return {...conversation,messages:conversation.messages.map(message=>{
    const reply=message.role==='assistant'&&message.jobId?replies.get(message.jobId):undefined;
    if(!reply)return message;
    const display=inspectDirectorMessage({...reply,content:message.content});
    return {...message,content:display.displayText};
  })};
}
export async function GET(request:Request){
  try{
    const owner=requireIdentity(request).id;
    const conversations=list<Conversation>('conversations',owner).map(item=>memberTranscript(item,owner));
    return json({conversations});
  }catch(e){return errorResponse(e);}
}
export async function DELETE(request:Request){try{sameOrigin(request);const user=requireIdentity(request);const {id}=await request.json();remove('conversations',id,user.id);return json({ok:true});}catch(e){return errorResponse(e);}}
export async function PATCH(request:Request){
  try{
    sameOrigin(request);const user=requireIdentity(request);
    const {id,title}=await request.json();
    const next=String(title||'').trim();
    if(!next||next.length>60)return json({error:'会话名称需为 1-60 个字符'},400);
    const chat=get<Conversation>('conversations',String(id||''),user.id);
    if(!chat)return json({error:'会话不存在'},404);
    put('conversations',chat.id,user.id,{...chat,title:next});
    return json({ok:true});
  }catch(e){return errorResponse(e);}
}
