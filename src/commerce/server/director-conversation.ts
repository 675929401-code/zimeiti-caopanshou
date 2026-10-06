import {db,get,put,transaction} from './store';
import {createJob,type JobInput,type Job,type Conversation} from './jobs';
import {createCommerceJobQuote} from './quotes';
import {findDirectorCard} from './director-catalog';
import {readAsset} from './assets';
import {DIRECTOR_OUTPUT_PROTOCOL} from './director-output';
import {DirectorConflict,directorSourceConfigurationHash,requireDirector,synchronizeDirector,inspectDirectorMessage,validateDirectorReferences,validateDirectorSelections,verifyDirectorAudioReferences} from './director-turn-claim';
import type {DirectorApplication,DirectorConversation,DirectorPage,DirectorReference,DirectorSettings,DirectorTurnContext,DirectorVideoSettings} from './director-conversation-schema';
import {COMMERCE_VIDEO_MAX_TOTAL_DURATION} from '../shared/video-generation-capabilities';

const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
export function directorSettings(value:unknown):DirectorSettings {
  const raw=value as Partial<DirectorSettings>|null;
  const spec=findDirectorCard(raw?.skillKey||'');
  if(!raw||!spec||!Number.isInteger(raw.durationSeconds)||Number(raw.durationSeconds)<4||Number(raw.durationSeconds)>COMMERCE_VIDEO_MAX_TOTAL_DURATION||!['中文','英文','泰国','马来西亚','巴西','不限'].includes(raw.spokenLanguage||'')||typeof raw.generateAudio!=='boolean')throw new DirectorConflict(`请选择有效的编导场景、语言、声音和4–${COMMERCE_VIDEO_MAX_TOTAL_DURATION}秒时长`,'DIRECTOR_SETTINGS_INVALID',400);
  const selections=raw.selections||{};
  if(typeof selections!=='object'||Array.isArray(selections)||Object.keys(selections).length>20||JSON.stringify(selections).length>8000||Object.entries(selections).some(([k,v])=>!k||k.length>80||!['string','boolean','number'].includes(typeof v)&&!(Array.isArray(v)&&v.every(x=>typeof x==='string'))||typeof v==='number'&&!Number.isFinite(v)))throw new DirectorConflict('编导选择项格式不正确','DIRECTOR_SELECTIONS_INVALID',400);
  const settings={skillKey:spec.key,selections,spokenLanguage:raw.spokenLanguage!,durationSeconds:raw.durationSeconds!,generateAudio:raw.generateAudio};
  validateDirectorSelections(settings,spec);
  return settings;
}
export function openDirector(owner:string,id:string,settings:unknown) {
  if(!uuid(id))throw new DirectorConflict('会话编号无效','DIRECTOR_ID_INVALID',400);
  const normalized=directorSettings(settings);
  return transaction(()=>{
    const current=get<DirectorConversation>('director-conversations',id,owner);
    if(current)return synchronizeDirector(owner,current);
    if(db().prepare("SELECT id FROM records WHERE bucket='director-conversations' AND id=?").get(id))throw new DirectorConflict('会话不存在','DIRECTOR_NOT_FOUND',404);
    const now=Date.now();const value:DirectorConversation={id,createdAt:now,updatedAt:now,latestScriptMessageId:null,activeJobId:null,settings:normalized,messages:[]};
    // Existing same-owner conversations can be reopened; their actual completed jobs remain the source of truth.
    const legacy=get<Conversation>('conversations',id,owner);
    for(const m of legacy?.messages||[]){if(!m.jobId)continue;const j=get<Job>('jobs',m.jobId,owner);if(!j||j.input.purpose!=='director')continue;
      const settings=directorSettings({skillKey:j.input.director||normalized.skillKey,selections:{},spokenLanguage:j.input.spokenLanguage||normalized.spokenLanguage,durationSeconds:j.input.scriptDuration||normalized.durationSeconds,generateAudio:j.input.generateAudio??true});
      const refs=(j.input.references||[]).map(r=>{const a=readAsset(r.id,owner);return {...r,instanceId:r.id,name:a?.name||'已失效素材',type:a?.type||''};});
      if(m.role==='assistant'&&j.status!=='succeeded')continue;
      value.messages.push({id:m.id,sequence:value.messages.length,role:m.role,content:m.content,status:'completed',jobId:j.id,operationId:j.input.requestId,baseMessageId:value.latestScriptMessageId,createdAt:j.createdAt,settings,references:refs,billing:{status:'unconfirmed'}});
      if(m.role==='assistant')value.latestScriptMessageId=m.id;
      else if(['queued','running','processing','unknown'].includes(j.status)){
        if(value.activeJobId&&value.activeJobId!==j.id)throw new DirectorConflict('旧会话有多个未结束任务，请先核对原任务','DIRECTOR_LEGACY_ACTIVE');
        value.messages.push({id:crypto.randomUUID(),sequence:value.messages.length,role:'assistant',content:j.text||'',status:j.status==='unknown'?'unknown':j.status==='queued'?'pending':'streaming',jobId:j.id,operationId:j.input.requestId,baseMessageId:value.latestScriptMessageId,createdAt:j.createdAt,settings,references:refs,billing:{status:'unconfirmed'}});value.activeJobId=j.id;
      }
    }
    return synchronizeDirector(owner,value);
  });
}
export function readDirector(owner:string,id:string) {return transaction(()=>synchronizeDirector(owner,requireDirector(owner,id)));}
export function directorPage(value:DirectorConversation,before?:string|null,limit=20):DirectorPage {
  if(!Number.isInteger(limit)||limit<1||limit>50)throw new DirectorConflict('历史分页数量无效','DIRECTOR_PAGE_INVALID',400);
  const end=before?value.messages.findIndex(m=>m.id===before):value.messages.length;
  if(end<0)throw new DirectorConflict('历史消息游标失效，请重新读取','DIRECTOR_CURSOR_INVALID',400);
  const start=Math.max(0,end-limit),messages=value.messages.slice(start,end);
  return {...value,messages,hasMore:start>0,nextCursor:start>0?messages[0]?.id||null:null};
}
function directorTurnInput(owner:string,body:Record<string,unknown>) {
  if(!uuid(body.id)||!uuid(body.operationId)||!(body.expectedScriptMessageId===null||uuid(body.expectedScriptMessageId))||typeof body.message!=='string'||body.message.length>8000)throw new DirectorConflict('编导消息参数无效','DIRECTOR_TURN_INVALID',400);
  const settings=directorSettings(body.settings),references=validateDirectorReferences(owner,settings,body.references);
  const spec=findDirectorCard(settings.skillKey)!;
  const current=readDirector(owner,String(body.id));
  if(current.settings.skillKey!==settings.skillKey)throw new DirectorConflict('请为不同编导场景新建会话','DIRECTOR_SKILL_CHANGED');
  const context:DirectorTurnContext={conversationId:String(body.id),expectedScriptMessageId:body.expectedScriptMessageId as string|null,operationId:String(body.operationId),settings,references,outputProtocol:DIRECTOR_OUTPUT_PROTOCOL};
  const input:JobInput&{directorTurn:DirectorTurnContext}={requestId:String(body.operationId),kind:'agent',modelId:'',prompt:body.message,purpose:'director',director:spec.name==='默认'?'默认编导':spec.name,conversationId:String(body.id),spokenLanguage:settings.spokenLanguage,scriptDuration:settings.durationSeconds,generateAudio:settings.generateAudio,references:references.map(r=>({id:r.id,slot:r.slot})),directorTurn:context};
  return input;
}
export async function quoteDirectorTurn(owner:string,body:Record<string,unknown>){const input=directorTurnInput(owner,body);await verifyDirectorAudioReferences(owner,input.directorTurn.settings,input.directorTurn.references);return createCommerceJobQuote(owner,input);}
/** Legacy server-only compatibility. New browser clients must quote and confirm through /api/commerce/jobs. */
export async function submitDirectorTurn(owner:string,body:Record<string,unknown>) {const input=directorTurnInput(owner,body);await verifyDirectorAudioReferences(owner,input.directorTurn.settings,input.directorTurn.references);return createJob(owner,input);}
export function applyDirector(owner:string,body:Record<string,unknown>):DirectorApplication {
  return transaction(()=>{
    const value=synchronizeDirector(owner,requireDirector(owner,String(body.id||'')));
    if(value.activeJobId)throw new DirectorConflict('当前脚本仍在生成或待核对，请等待原任务','DIRECTOR_ACTIVE');
    if(value.latestScriptMessageId!==body.expectedScriptMessageId||body.messageId!==value.latestScriptMessageId)throw new DirectorConflict('请先读取并应用最新完成的脚本','DIRECTOR_STALE_SCRIPT');
    const message=value.messages.find(m=>m.id===body.messageId&&m.role==='assistant');
    if(!message||message.status!=='completed'||!message.content.trim())throw new DirectorConflict('此消息尚未完成，不能应用','DIRECTOR_NOT_COMPLETED');
    const business=inspectDirectorMessage(message);
    if(business.state!=='ready'||!business.generationText||business.sourceContentHash!==message.business?.sourceContentHash)throw new DirectorConflict('这条回复尚不是通过校验的完整脚本；追问或旧格式不能直接应用','DIRECTOR_SCRIPT_NOT_READY');
    const source=get<Job>('jobs',message.jobId,owner);
    if(!source||source.status!=='succeeded'||source.input.purpose!=='director'||source.input.conversationId!==value.id||source.text!==message.content)throw new DirectorConflict('来源脚本任务不存在或已经变化','DIRECTOR_APPLICATION_CHANGED');
    const supplied=validateDirectorReferences(owner,message.settings,body.references);
    const fingerprint=(refs:DirectorReference[])=>JSON.stringify(refs.map(r=>({id:r.id,slot:r.slot,instanceId:r.instanceId||r.id})));
    if(fingerprint(supplied)!==fingerprint(message.references)||JSON.stringify(directorSettings(body.settings))!==JSON.stringify(message.settings))throw new DirectorConflict('素材或脚本设置已经改变，请先重新创作脚本','DIRECTOR_APPLICATION_CHANGED');
    const suppliedVideo=body.videoSettings as Partial<DirectorVideoSettings>|null;
    if(!suppliedVideo||typeof suppliedVideo.aspectRatio!=='string'||!/^\d{1,3}:\d{1,3}$/.test(suppliedVideo.aspectRatio)||typeof suppliedVideo.resolution!=='string'||suppliedVideo.resolution.length>40)throw new DirectorConflict('视频画幅或分辨率设置无效','DIRECTOR_VIDEO_SETTINGS_INVALID',400);
    const videoSettings:DirectorVideoSettings={aspectRatio:suppliedVideo.aspectRatio,resolution:suppliedVideo.resolution,duration:message.settings.durationSeconds,generateAudio:message.settings.generateAudio};
    const application:DirectorApplication={id:crypto.randomUUID(),conversationId:value.id,messageId:message.id,jobId:message.jobId,script:business.generationText,settings:message.settings,sourceReferences:message.references,references:message.references.map(r=>({id:r.id,slot:r.type?.startsWith('audio/')?'sound':'reference'})),videoSettings,createdAt:Date.now(),outputProtocol:message.outputProtocol,sourceContentHash:business.sourceContentHash,sourceConfigurationHash:directorSourceConfigurationHash(source)};
    put('director-applications',application.id,owner,application);return application;
  });
}
