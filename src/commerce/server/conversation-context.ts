import {createHash} from 'node:crypto';
import {db,get} from './store';

type Message={id:string;role:'user'|'assistant';content:string;jobId?:string;assetIds?:string[]};
type StoredConversation={messages:Message[]};
type SourceJob={status:string;input:{conversationId?:string}};
export type ConversationContextSnapshot={
  version:1;conversationId:string|null;jobId:string;capturedAt:number;
  messages:Message[];currentReferences:{id:string;slot:string;instanceId?:string}[];
  textCharacters:number;sha256:string;
};
// This is a local payload bound, not a claim about any provider's token capacity.
export const CONTEXT_MAX_CHARACTERS=120000;
export const CONTEXT_MAX_MESSAGES=400;
function digest(value:Omit<ConversationContextSnapshot,'sha256'>){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

/** Capture successful history while createJob's transaction owns the new turn. */
export function captureConversationContext(owner:string,conversationId:string|undefined,jobId:string,prompt:string,references:{id:string;slot:string;instanceId?:string}[]=[]):ConversationContextSnapshot {
  if(conversationId!==undefined&&(typeof conversationId!=='string'||!conversationId||conversationId.length>160))throw Error('会话编号无效');
  if(conversationId){
    if(db().prepare("SELECT 1 FROM records WHERE bucket='conversations' AND id=? AND owner<>?").get(conversationId,owner))throw Error('会话不存在或不属于当前账号，请新建会话');
    if(db().prepare("SELECT 1 FROM records WHERE bucket='jobs' AND owner=? AND id<>? AND json_extract(value,'$.input.kind')='agent' AND json_extract(value,'$.input.conversationId')=? AND json_extract(value,'$.status') IN ('queued','running','processing','saving','unknown','save_failed') LIMIT 1").get(owner,jobId,conversationId))throw Error('此会话已有未结束或待核对的回复，请查看原任务后继续；同一会话不能同时发送多轮');
  }
  const history=conversationId?get<StoredConversation>('conversations',conversationId,owner)?.messages||[]:[];
  const messages:Message[]=[];
  for(const message of history){
    if(message.jobId===jobId)continue;
    if(message.role!=='user'&&message.role!=='assistant'||typeof message.content!=='string')continue;
    if(message.jobId){const source=get<SourceJob>('jobs',message.jobId,owner);if(!source||source.status!=='succeeded'||source.input.conversationId!==conversationId)continue;}
    messages.push({id:message.id,role:message.role,content:message.content,...(message.jobId?{jobId:message.jobId}:{}),...(message.assetIds?.length?{assetIds:[...message.assetIds]}:{})});
  }
  messages.push({id:jobId+':current',role:'user',content:prompt,jobId,assetIds:references.map(r=>r.id)});
  const textCharacters=messages.reduce((total,message)=>total+message.content.length,0);
  if(textCharacters>CONTEXT_MAX_CHARACTERS||messages.length>CONTEXT_MAX_MESSAGES)throw Error('当前对话内容过长，未提交生成。请新建会话并带入已确认的要求和参考素材；原对话会保留，不会自动删掉早先条件。');
  const content={version:1 as const,conversationId:conversationId||null,jobId,capturedAt:Date.now(),messages,currentReferences:references.map(r=>({id:r.id,slot:r.slot,...(r.instanceId?{instanceId:r.instanceId}:{})})),textCharacters};
  return {...content,sha256:digest(content)};
}

export function snapshotChatMessages(snapshot:ConversationContextSnapshot,jobId:string,prompt:string,system:string,images:string[]) {
  const {sha256,...content}=snapshot;
  if(snapshot.version!==1||snapshot.jobId!==jobId||digest(content)!==sha256||snapshot.messages.at(-1)?.jobId!==jobId||snapshot.messages.at(-1)?.content!==prompt)throw Error('本轮上下文快照校验失败，未发送模型请求');
  const note='\n会话上下文规则：以下历史按原顺序保留，后续明确修改替代相冲突的旧要求，未修改的已确认要求继续生效。历史助手输出是讨论内容，不能自动当作用户确认的商品事实。历史素材记录仅说明当时的引用身份，不含历史图片字节；不得把过去的参考编号直接套到本轮。本轮可观察素材仅为最新用户消息实际附带的图片，缺失的视觉依据需要重新提供。\n本轮参考身份与职责：'+JSON.stringify(snapshot.currentReferences);
  const messages:{role:string;content:unknown}[]=[{role:'system',content:system+note}];
  for(const entry of snapshot.messages.slice(0,-1))messages.push({role:entry.role,content:entry.content+(entry.assetIds?.length?'\n【该历史消息的素材身份记录，非本轮图片附件：'+JSON.stringify(entry.assetIds)+'】':'')});
  messages.push({role:'user',content:images.length?[{type:'text',text:prompt},...images.map(url=>({type:'image_url',image_url:{url}}))]:prompt});
  return messages;
}
