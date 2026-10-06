import {get,put} from './store';
import {assetBytes,readAsset} from './assets';
import {probeGeneratedAudioDuration} from '../../lib/digital-human-media';
import {createHash} from 'node:crypto';
import {parseDirectorOutput,directorDisplayText,directorGenerationText,isStructuredDirectorOutput} from './director-output';
import {findDirectorCard,type DirectorCard} from './director-catalog';
import type {JobInput,Job} from './jobs';
import {DIRECTOR_AUDIO_MAX_SECONDS,DIRECTOR_REFERENCE_LIMIT,type DirectorApplication,type DirectorBusinessResult,type DirectorConversation,type DirectorMessage,type DirectorReference,type DirectorSettings,type DirectorTurnContext} from './director-conversation-schema';
import {COMMERCE_VIDEO_MAX_TOTAL_DURATION} from '../shared/video-generation-capabilities';

export class DirectorConflict extends Error {
  constructor(message:string, public code='DIRECTOR_CONFLICT', public status=409){super(message);}
}
export function requireDirector(owner:string,id:string) {
  const value=get<DirectorConversation>('director-conversations',id,owner);
  if(!value)throw new DirectorConflict('编导会话不存在','DIRECTOR_NOT_FOUND',404);
  return value;
}
export const directorContentHash=(content:string)=>createHash('sha256').update(content).digest('hex');
export const directorSourceConfigurationHash=(source:Pick<Job,'configurationSnapshot'|'model'|'promptVersion'|'route'>)=>directorContentHash(JSON.stringify({configurationSnapshot:source.configurationSnapshot||null,modelConfigHash:source.model.configHash,promptVersion:source.promptVersion,routeId:source.route?.id||null,routeRevision:source.route?.revision||null}));
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const mediaKind=(type:string)=>type.startsWith('image/')?'image':type.startsWith('video/')?'video':type.startsWith('audio/')?'audio':type.startsWith('application/')||type.startsWith('text/')?'document':'';

function validateFieldValue(field:NonNullable<DirectorCard['inputFields']>[number],value:unknown){
  const invalid=():never=>{throw new DirectorConflict(`编导输入字段“${field.title}”不符合已发布规则`,'DIRECTOR_SELECTIONS_INVALID',400);};
  if(value===undefined||value===null||value===''){if(field.required&&field.defaultValue===undefined)invalid();return;}
  if(field.type==='boolean'){if(typeof value!=='boolean')invalid();return;}
  if(field.type==='number'){
    if(typeof value!=='number'||!Number.isFinite(value))invalid();
    const numericValue=value as number;
    if(field.validation?.min!==undefined&&numericValue<field.validation.min||field.validation?.max!==undefined&&numericValue>field.validation.max)invalid();
    return;
  }
  if(typeof value!=='string')invalid();
  const stringValue=value as string;
  if(field.type==='select'&&(!field.options?.length||!field.options.includes(stringValue)))invalid();
  if(field.validation?.maxLength!==undefined&&stringValue.length>field.validation.maxLength)invalid();
  if(field.validation?.pattern){let expression:RegExp;try{expression=new RegExp(field.validation.pattern,'u');}catch{return invalid();}if(!expression.test(stringValue))invalid();}
}

/** Validate administrator-defined fields against the exact published card, while legacy cards accept no hidden fields. */
export function validateDirectorSelections(settings:DirectorSettings,spec=findDirectorCard(settings.skillKey)){
  if(!spec)throw new DirectorConflict('编导卡不存在或已经停用','DIRECTOR_SKILL_CHANGED',409);
  const fields=spec.inputFields||[];
  const allowed=new Set(fields.map(field=>field.id));
  if(Object.keys(settings.selections).some(key=>!allowed.has(key)))throw new DirectorConflict('编导输入包含未发布字段','DIRECTOR_SELECTIONS_INVALID',400);
  const values:Record<string,unknown>={...settings.selections,spokenLanguage:settings.spokenLanguage,scriptDuration:settings.durationSeconds,generateAudio:settings.generateAudio};
  fields.forEach(field=>validateFieldValue(field,values[field.id]===undefined?field.defaultValue:values[field.id]));
  return spec;
}

/** Re-resolve every asset and enforce this card's slot count, file size and media-role contract. */
export function validateDirectorReferences(owner:string,settings:DirectorSettings,value:unknown):DirectorReference[]{
  if(!Array.isArray(value)||value.length>DIRECTOR_REFERENCE_LIMIT)throw new DirectorConflict(`编导参考素材最多${DIRECTOR_REFERENCE_LIMIT}项`,'DIRECTOR_REFERENCES_INVALID',400);
  const spec=validateDirectorSelections(settings),counts=new Map(spec.slots.map(slot=>[slot.key,0]));
  const references=value.map((item,index)=>{
    const raw=item as Partial<DirectorReference>|null;
    if(!raw||!uuid(raw.id)||typeof raw.slot!=='string'||raw.slot.length>100||raw.instanceId!==undefined&&(typeof raw.instanceId!=='string'||raw.instanceId.length>120))throw new DirectorConflict(`第 ${index+1} 项素材引用格式不正确`,'DIRECTOR_REFERENCES_INVALID',400);
    const slot=spec.slots.find(candidate=>candidate.key===raw.slot);
    if(!slot)throw new DirectorConflict(`第 ${index+1} 项素材没有对应当前编导卡的已发布职责`,'DIRECTOR_REFERENCE_ROLE_INVALID',400);
    const asset=readAsset(raw.id,owner);
    if(!asset)throw new DirectorConflict('参考素材不存在或不可用','DIRECTOR_ASSET_MISSING',404);
    const kind=mediaKind(asset.type);
    if(!kind||!slot.kinds.includes(kind))throw new DirectorConflict(`素材“${asset.name}”不能用于“${slot.label}”职责`,'DIRECTOR_REFERENCE_TYPE_INVALID',400);
    if(slot.maxFileBytes!==undefined&&asset.size>slot.maxFileBytes)throw new DirectorConflict(`素材“${asset.name}”超过“${slot.label}”文件大小限制`,'DIRECTOR_REFERENCE_SIZE_INVALID',400);
    counts.set(slot.key,(counts.get(slot.key)||0)+1);
    return {id:asset.id,slot:slot.key,instanceId:raw.instanceId||asset.id,name:asset.name,type:asset.type};
  });
  for(const slot of spec.slots){const count=counts.get(slot.key)||0;if(count<slot.min||count>slot.max)throw new DirectorConflict(`“${slot.label}”需要 ${slot.min}–${slot.max} 个素材，当前为 ${count} 个`,'DIRECTOR_REFERENCE_COUNT_INVALID',400);}
  return references;
}

function audioExtension(type:string){return type==='audio/mpeg'?'.mp3':type==='audio/mp4'?'.m4a':type==='audio/x-wav'?'.wav':'.'+type.split('/')[1];}
/** Server-side duration gate. Audio stays opaque to the text model and is only retained for the downstream video model. */
export async function verifyDirectorAudioReferences(owner:string,settings:DirectorSettings,value:unknown){
  const references=validateDirectorReferences(owner,settings,value),spec=findDirectorCard(settings.skillKey)!;
  for(const reference of references){
    const asset=readAsset(reference.id,owner);if(!asset?.type.startsWith('audio/'))continue;
    let duration:number;try{duration=await probeGeneratedAudioDuration(await assetBytes(asset),audioExtension(asset.type));}catch{throw new DirectorConflict(`无法读取声音素材“${asset.name}”的实际时长，请重新上传有效音频`,'DIRECTOR_AUDIO_DURATION_INVALID',400);}
    const slot=spec.slots.find(candidate=>candidate.key===reference.slot);const minimum=slot?.minDurationSeconds===undefined?0:Math.max(0,Number(slot.minDurationSeconds));const maximum=Math.min(DIRECTOR_AUDIO_MAX_SECONDS,Number(slot?.maxDurationSeconds??DIRECTOR_AUDIO_MAX_SECONDS));
    if(duration<minimum||duration>maximum+0.05)throw new DirectorConflict(`声音素材“${asset.name}”${minimum>0?`需为 ${minimum}–${maximum} 秒`:`不能超过 ${maximum} 秒`}，当前约 ${duration.toFixed(1)} 秒`,'DIRECTOR_AUDIO_DURATION_INVALID',400);
  }
  return references;
}

/** Bind revisions to the exact validated script instead of relying on an informal chat-history hint. */
export function currentDirectorScriptContext(owner:string,input:JobInput){
  const context=(input as JobInput&{directorTurn?:DirectorTurnContext}).directorTurn;
  if(!context?.expectedScriptMessageId)return '';
  const conversation=requireDirector(owner,context.conversationId);
  const message=conversation.messages.find(candidate=>candidate.id===context.expectedScriptMessageId&&candidate.role==='assistant');
  if(!message||message.status!=='completed')throw new DirectorConflict('当前脚本版本不存在或尚未完成','DIRECTOR_STALE_SCRIPT');
  const business=inspectDirectorMessage(message);
  if(business.state!=='ready'||!business.generationText)throw new DirectorConflict('当前脚本版本未通过结构校验','DIRECTOR_SCRIPT_NOT_READY');
  return `脚本消息ID：${message.id}\n脚本内容SHA-256：${business.sourceContentHash}\n以下是必须作为本轮修改基准的完整当前脚本；只改用户明确要求的部分，其余镜头和约束逐项保留：\n${message.content}`;
}
export function inspectDirectorMessage(message:DirectorMessage):DirectorBusinessResult {
 const sourceContentHash=directorContentHash(message.content);
 if(!message.outputProtocol||!isStructuredDirectorOutput(message.content))return {version:1,state:'legacy_unverified',sourceContentHash,displayText:message.content,error:'原回复已保留，但不是可校验的新格式。可复制查看；请升级自定义编导提示词或继续要求输出完整新格式脚本。'};
 try{const reply=parseDirectorOutput(message.content,message.settings,message.references,message.outputProtocol);return {version:1,state:reply.replyType==='script'?'ready':'needs_input',sourceContentHash,displayText:directorDisplayText(reply,message.references),...(reply.replyType==='script'?{generationText:directorGenerationText(reply,message.references)}:{}),reply};}
 catch(error){return {version:1,state:'invalid',sourceContentHash,displayText:'这份回复尚未通过脚本校验，原文已保留。',error:error instanceof Error?error.message:'脚本格式无效'};}
}
function migrateDirectorBusiness(value:DirectorConversation){
 if(value.businessProtocolVersion)return;
 value.legacyLatestScriptMessageId=value.latestScriptMessageId;
 for(const message of value.messages)if(message.role==='assistant'&&message.status==='completed'){
  // History predating this protocol is NEVER silently promoted to a validated script.
  message.business={version:1,state:'legacy_unverified',sourceContentHash:directorContentHash(message.content),displayText:message.content,error:'旧格式回复已保留，尚未通过新脚本校验。可复制查看，或继续对话生成可应用的新稿。'};
 }
 value.latestScriptMessageId=null;value.businessProtocolVersion=1;
}
/** Caller owns the transaction. Synchronization only reads the original job; it never dispatches or retries it. */
export function synchronizeDirector(owner:string,value:DirectorConversation) {
  const migrated=!value.businessProtocolVersion;migrateDirectorBusiness(value);
  if(!value.activeJobId){if(migrated)put('director-conversations',value.id,owner,value);return value;}
  const original=get<Job>('jobs',value.activeJobId,owner);
  const message=value.messages.find(m=>m.role==='assistant'&&m.jobId===value.activeJobId);
  if(!original||!message)throw new DirectorConflict('原编导任务记录缺失，请保留会话并核对','DIRECTOR_JOB_MISSING');
  message.content=original.text||'';
  if(original.status==='succeeded') {
    const previousLegacyBase=!message.outputProtocol&&!value.latestScriptMessageId&&value.legacyLatestScriptMessageId===message.baseMessageId;
    if(value.latestScriptMessageId!==message.baseMessageId&&!previousLegacyBase){message.status='failed';message.error='脚本基准版本已变化，结果未覆盖当前脚本';}
    else if(!message.content.trim()){message.status='failed';message.error='原任务没有可用脚本';}
    else {message.status='completed';message.error=undefined;message.business=inspectDirectorMessage(message);if(message.business.state==='ready')value.latestScriptMessageId=message.id;}
    value.activeJobId=null;
  } else if(['failed','save_failed'].includes(original.status)) {
    message.status='failed';message.error=original.error||'脚本生成失败';value.activeJobId=null;
  } else if(original.status==='unknown') {
    message.status='unknown';message.error='原任务结果待核对，请勿重复提交';
  } else {message.status=original.status==='queued'?'pending':'streaming';message.error=undefined;}
  value.updatedAt=Math.max(value.updatedAt,original.updatedAt);
  put('director-conversations',value.id,owner,value);
  return value;
}

function normalizedDirectorKey(value:unknown) {
  if(typeof value!=='string')return undefined;
  return findDirectorCard(value)?.key;
}
/** The jobs endpoint can reach this claim without passing through directorSettings().
 * Validate the complete declaration here without normalizing or rewriting its saved payload.
 * Language/duration/options may legitimately change between turns; only scene identity is fixed.
 */
function validateClaimSettings(value:unknown):asserts value is DirectorSettings {
  const invalid=()=>{throw new DirectorConflict('编导设置声明不完整或格式无效','DIRECTOR_SETTINGS_INVALID',400);};
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const raw=value as Record<string,unknown>,keys=['skillKey','selections','spokenLanguage','durationSeconds','generateAudio'];
  if(Object.keys(raw).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(raw,key)))return invalid();
  if(typeof raw.skillKey!=='string'||normalizedDirectorKey(raw.skillKey)!==raw.skillKey||!Number.isInteger(raw.durationSeconds)||Number(raw.durationSeconds)<4||Number(raw.durationSeconds)>COMMERCE_VIDEO_MAX_TOTAL_DURATION||typeof raw.spokenLanguage!=='string'||!['中文','英文','泰国','马来西亚','巴西','不限'].includes(raw.spokenLanguage)||typeof raw.generateAudio!=='boolean')return invalid();
  const selections=raw.selections;
  if(!selections||typeof selections!=='object'||Array.isArray(selections)||Object.keys(selections).length>20||JSON.stringify(selections).length>8000||Object.entries(selections).some(([key,item])=>!key||key.length>80||!['string','boolean','number'].includes(typeof item)&&!(Array.isArray(item)&&item.every(part=>typeof part==='string'))||typeof item==='number'&&!Number.isFinite(item)))return invalid();
  validateDirectorSelections(value as DirectorSettings);
}

/** Called inside createJob's existing transaction, after its request claim. No nested transaction or network calls. */
export function claimDirectorTurn(owner:string,input:JobInput,jobId:string) {
  const context=(input as JobInput&{directorTurn?:DirectorTurnContext}).directorTurn;
  if(!context)return; // Legacy jobs remain readable; the dedicated endpoint always supplies this context.
  if(context.outputProtocol!==undefined&&!['director-script/v1','director-script/v2'].includes(context.outputProtocol))throw new DirectorConflict('编导输出协议版本不受支持','DIRECTOR_PROTOCOL_INVALID',400);
  if(input.kind!=='agent'||input.purpose!=='director'||input.conversationId!==context.conversationId||input.requestId!==context.operationId)throw new DirectorConflict('编导任务上下文不一致','DIRECTOR_INPUT_MISMATCH');
  validateClaimSettings(context.settings);
  const references=validateDirectorReferences(owner,context.settings,context.references);
  if(normalizedDirectorKey(input.director)!==context.settings.skillKey||input.scriptDuration!==context.settings.durationSeconds||input.spokenLanguage!==context.settings.spokenLanguage||(input.generateAudio!==undefined&&typeof input.generateAudio!=='boolean')||(input.generateAudio??true)!==context.settings.generateAudio)throw new DirectorConflict('实际编导路由、语言、时长或声音与本轮设置声明不一致','DIRECTOR_SETTINGS_MISMATCH');
  const value=synchronizeDirector(owner,requireDirector(owner,context.conversationId));
  if(value.activeJobId)throw new DirectorConflict('此编导会话仍有未结束任务，请查看原任务','DIRECTOR_ACTIVE');
  if(value.latestScriptMessageId!==context.expectedScriptMessageId)throw new DirectorConflict('脚本已更新，请读取最新版本后再修改','DIRECTOR_STALE_SCRIPT');
  if(context.settings.skillKey!==value.settings.skillKey)throw new DirectorConflict('编导场景或设置已变化','DIRECTOR_SETTINGS_MISMATCH');
  if(JSON.stringify(input.references||[])!==JSON.stringify(references.map(r=>({id:r.id,slot:r.slot})))||JSON.stringify(context.references.map(r=>({id:r.id,slot:r.slot,instanceId:r.instanceId||r.id})))!==JSON.stringify(references.map(r=>({id:r.id,slot:r.slot,instanceId:r.instanceId||r.id}))))throw new DirectorConflict('编导素材上下文不一致','DIRECTOR_REFERENCES_MISMATCH');
  const base={jobId,operationId:input.requestId,baseMessageId:value.latestScriptMessageId,createdAt:Date.now(),settings:context.settings,references,outputProtocol:context.outputProtocol,billing:{status:'unconfirmed' as const}};
  const user:DirectorMessage={...base,id:crypto.randomUUID(),sequence:value.messages.length,role:'user',content:input.prompt,status:'completed'};
  const assistant:DirectorMessage={...base,id:crypto.randomUUID(),sequence:value.messages.length+1,role:'assistant',content:'',status:'pending'};
  value.messages.push(user,assistant);value.settings=context.settings;value.activeJobId=jobId;value.updatedAt=Date.now();
  put('director-conversations',value.id,owner,value);
}

/** Same boundary as verifyAssistApplication, before a video can be sent to a provider. */
export function verifyDirectorApplication(owner:string,input:JobInput) {
  const id=(input as JobInput&{directorApplicationId?:string}).directorApplicationId;if(!id)return;
  const a=get<DirectorApplication>('director-applications',id,owner);
  if(!a)throw new DirectorConflict('编导应用记录不存在','DIRECTOR_APPLICATION_MISSING');
  if(a.outputProtocol!==undefined&&!['director-script/v1','director-script/v2'].includes(a.outputProtocol))throw new DirectorConflict('编导应用协议版本不受支持','DIRECTOR_PROTOCOL_INVALID',400);
  const conversation=requireDirector(owner,a.conversationId);
  const effectiveLatest=a.outputProtocol?conversation.latestScriptMessageId:(conversation.latestScriptMessageId||conversation.legacyLatestScriptMessageId);
  if(conversation.activeJobId||effectiveLatest!==a.messageId||input.kind!=='video'||input.prompt!==a.script||input.parentJobId!==a.jobId||JSON.stringify(input.references||[])!==JSON.stringify(a.references)||input.duration!==a.videoSettings.duration||input.aspectRatio!==a.videoSettings.aspectRatio||input.resolution!==a.videoSettings.resolution||(input.generateAudio??true)!==a.videoSettings.generateAudio)throw new DirectorConflict('当前正文、素材、参数或脚本版本与编导应用不一致，请重新应用或解除来源绑定','DIRECTOR_APPLICATION_CHANGED');
  if(a.outputProtocol){const message=conversation.messages.find(m=>m.id===a.messageId&&m.role==='assistant');if(!message||message.status!=='completed')throw new DirectorConflict('来源脚本已经不可用','DIRECTOR_APPLICATION_CHANGED');const business=inspectDirectorMessage(message);const source=get<Job>('jobs',a.jobId,owner);const configurationMatches=a.sourceConfigurationHash?!!source&&directorSourceConfigurationHash(source)===a.sourceConfigurationHash:a.outputProtocol==='director-script/v1';if(!source||source.status!=='succeeded'||source.input.purpose!=='director'||source.input.conversationId!==a.conversationId||!configurationMatches)throw new DirectorConflict('来源脚本任务或配置快照已经变化，请重新应用','DIRECTOR_APPLICATION_CHANGED');if(business.state!=='ready'||business.sourceContentHash!==a.sourceContentHash||business.generationText!==a.script)throw new DirectorConflict('来源脚本正文或校验版本已变化，请重新应用','DIRECTOR_APPLICATION_CHANGED');}
  return a;
}
