import {createHash,randomUUID} from 'node:crypto';
import {get,put,remove,db,transaction} from './store';
import {readAsset} from './assets';
import {getImageInputContract} from '../image-input-contract';
import {editImageReferenceDocument,reconcileImageReferenceDocument,validateImageReferenceDocument,type ImageReferenceDocument} from '../shared/image-reference-mentions';
import {COMMERCE_VIDEO_MAX_TOTAL_DURATION} from '../shared/video-generation-capabilities';

export type SavedPromptReference={instanceId:string;assetId:string;slot:string;name:string;type:string;sha256:string;available?:boolean};
export type SavedPromptMetadata={image_skill_id?:string;aspect_ratio?:string;resolution?:string;format?:string;duration?:number;generate_audio?:boolean;imageReferenceDocument?:ImageReferenceDocument};
export type UserPrompt={id:string;title:string;prompt_text:string;context_type:string;source_type:string;metadata_json:SavedPromptMetadata;reference_elements_json:SavedPromptReference[];revision:number;created_at:number;updated_at:number};
type StoredPrompt=UserPrompt&{owner:string};
const bucket='user-prompts',contexts=['image','video','agent','canvas-text','canvas-image','canvas-video','canvas-chat'];
export class UserPromptError extends Error{constructor(public code:string,message:string,public status=400){super(message);}}
function fail(code:string,message:string,status=400):never{throw new UserPromptError(code,message,status);}
const identifier=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=200&&v.trim()===v&&!/[\u0000-\u001f\u007f]/.test(v);
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_INPUT','提示词内容格式无效');return value as Record<string,unknown>;}
function text(value:unknown,max:number,label:string){if(typeof value!=='string'||!value.trim()||value.length>max)fail('INVALID_TEXT',label+'不能为空或过长');return value;}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function owned(owner:string,id:string){const row=get<StoredPrompt>(bucket,id,owner);if(!row)fail('PROMPT_NOT_FOUND','提示词不存在或不属于当前账号',404);return row;}
function metadata(value:unknown):SavedPromptMetadata{
 const raw=value===undefined?{}:object(value),result:SavedPromptMetadata={};
 for(const key of ['image_skill_id','aspect_ratio','resolution','format'] as const){if(raw[key]!==undefined){if(typeof raw[key]!=='string'||raw[key].length>80)fail('INVALID_METADATA','提示词创作设置无效');result[key]=raw[key];}}
 if(result.image_skill_id)getImageInputContract(result.image_skill_id);
 if(raw.duration!==undefined){if(typeof raw.duration!=='number'||!Number.isFinite(raw.duration)||raw.duration<1||raw.duration>COMMERCE_VIDEO_MAX_TOTAL_DURATION)fail('INVALID_DURATION','提示词视频时长无效');result.duration=raw.duration;}
 if(raw.generate_audio!==undefined){if(typeof raw.generate_audio!=='boolean')fail('INVALID_AUDIO','提示词声音设置无效');result.generate_audio=raw.generate_audio;}
 if(raw.imageReferenceDocument!==undefined)result.imageReferenceDocument=raw.imageReferenceDocument as ImageReferenceDocument;
 return result;
}
function normalized(owner:string,value:unknown,previous?:StoredPrompt){
 const raw=object(value);if(JSON.stringify(raw).length>120000)fail('INPUT_TOO_LARGE','提示词及参考内容过大');
 const title=text(raw.title===undefined?previous?.title:raw.title,160,'标题').trim(),prompt_text=text(raw.prompt_text===undefined?previous?.prompt_text:raw.prompt_text,20000,'提示词正文'),context_type=raw.context_type??previous?.context_type??'image',source_type=raw.source_type??previous?.source_type??'manual';
 if(typeof context_type!=='string'||!contexts.includes(context_type))fail('INVALID_CONTEXT','提示词使用位置无效');
 if(!['manual','editor','canvas'].includes(String(source_type)))fail('INVALID_SOURCE','提示词来源无效');
 const meta=metadata(raw.metadata_json===undefined?previous?.metadata_json:raw.metadata_json),refs=raw.reference_elements_json===undefined?previous?.reference_elements_json??[]:raw.reference_elements_json;
 if(!Array.isArray(refs)||refs.length>24)fail('INVALID_REFERENCES','提示词最多保存24个参考素材');
 const seen=new Set<string>(),pairs=new Set<string>();
 const reference_elements_json=refs.map((ref:unknown):SavedPromptReference=>{
  const r=object(ref);if(!identifier(r.instanceId)||!identifier(r.assetId)||typeof r.slot!=='string'||r.slot.length>100)fail('INVALID_REFERENCE','参考素材缺少固定编号或角色');
  const instanceId=r.instanceId as string,assetId=r.assetId as string,slot=r.slot;
  if(seen.has(instanceId)||pairs.has(assetId+'\0'+slot))fail('DUPLICATE_REFERENCE','提示词包含重复的参考素材实例');seen.add(instanceId);pairs.add(assetId+'\0'+slot);
  const asset=readAsset(assetId,owner),old=previous?.reference_elements_json.find(p=>p.instanceId===instanceId&&p.assetId===assetId&&p.slot===slot);
  if(!asset){if(old)return {...old};fail('ASSET_NOT_OWNED','参考素材不存在或不属于当前账号');}
  if(old&&old.sha256!==asset.sha256)fail('ASSET_CHANGED','参考素材内容已变化，请重新选择后保存');
  return {instanceId,assetId,slot,name:asset.name,type:asset.type,sha256:asset.sha256};
 });
 if(meta.imageReferenceDocument){
  if(!['image','canvas-image'].includes(context_type))fail('INVALID_DOCUMENT_CONTEXT','图片提及文档只能用于图片提示词');
  const order=getImageInputContract(meta.image_skill_id||'default').slots.map(s=>s.id);
  const instances=reference_elements_json.map(r=>({instanceId:r.instanceId,assetId:r.assetId,slot:r.slot,name:r.name}));
  if(previous&&raw.metadata_json===undefined&&prompt_text!==previous.prompt_text)meta.imageReferenceDocument=editImageReferenceDocument(meta.imageReferenceDocument,prompt_text,instances,order);
  // Saving without references is explicit. Keep the literal token and mark it
  // unresolved; it must not attach to a future image with the same filename.
  const rawDoc=object(meta.imageReferenceDocument);if(rawDoc.text!==prompt_text)fail('DOCUMENT_TEXT_MISMATCH','提示词正文和图片引用文档不一致');
  const sourceDoc=instances.length?meta.imageReferenceDocument:{...meta.imageReferenceDocument,mentions:meta.imageReferenceDocument.mentions.map(m=>({...m,instanceId:null,assetId:null,slot:null,status:'missing' as const}))};
  const doc=reconcileImageReferenceDocument(sourceDoc,instances,order);
  meta.imageReferenceDocument=validateImageReferenceDocument(doc,prompt_text,instances,order,{allowUnresolved:true});
 }
 return {title,prompt_text,context_type,source_type:String(source_type),metadata_json:meta,reference_elements_json};
}
function publicValue(value:StoredPrompt):UserPrompt{
 const {owner,...result}=value;
 const references=result.reference_elements_json.map(ref=>{const asset=readAsset(ref.assetId,owner);return {...ref,available:!!asset&&asset.sha256===ref.sha256};});
 const meta={...result.metadata_json};
 if(meta.imageReferenceDocument){const slots=getImageInputContract(meta.image_skill_id||'default').slots.map(s=>s.id);const document={...meta.imageReferenceDocument,mentions:meta.imageReferenceDocument.mentions.map(m=>references.some(r=>r.instanceId===m.instanceId&&r.assetId===m.assetId&&r.available)?m:{...m,status:'missing' as const})};meta.imageReferenceDocument=reconcileImageReferenceDocument(document,references.map(r=>({instanceId:r.instanceId,assetId:r.assetId,slot:r.slot,name:r.name})),slots);}
 return {...result,metadata_json:meta,reference_elements_json:references};
}
export function readUserPrompt(owner:string,id:string){return publicValue(owned(owner,id));}
export function listUserPrompts(owner:string,query:URLSearchParams){
 const limit=Number(query.get('limit')||20);if(!Number.isInteger(limit)||limit<1||limit>100)fail('INVALID_LIMIT','提示词每页数量无效');
 let cursor:{ownerHash:string;updated:number;id:string}|undefined;
 if(query.get('cursor')){try{if(query.get('cursor')!.length>1000)throw Error();cursor=JSON.parse(Buffer.from(query.get('cursor')!,'base64url').toString('utf8'));if(!cursor||cursor.ownerHash!==digest(owner)||!Number.isSafeInteger(cursor.updated)||!identifier(cursor.id))throw Error();}catch{fail('INVALID_CURSOR','提示词分页位置无效，请重新加载');}}
 const params:unknown[]=[bucket,owner];let where='bucket=? AND owner=?';
 if(cursor){where+=' AND (updated<? OR (updated=? AND id<?))';params.push(cursor.updated,cursor.updated,cursor.id);}
 const rows=db().prepare(`SELECT value,updated,id FROM records WHERE ${where} ORDER BY updated DESC,id DESC LIMIT ?`).all(...params,limit+1),hasMore=rows.length>limit,visible=rows.slice(0,limit),last=visible.at(-1);
 return {items:visible.map(row=>publicValue(JSON.parse(String(row.value)) as StoredPrompt)),next_cursor:hasMore&&last?Buffer.from(JSON.stringify({ownerHash:digest(owner),updated:Number(last.updated),id:String(last.id)})).toString('base64url'):null};
}
export function createUserPrompt(owner:string,body:unknown){
 const raw=object(body),operationId=raw.operation_id;if(!identifier(operationId))fail('OPERATION_REQUIRED','保存提示词需要独立操作编号');
 const operationKey=digest([owner,operationId]),fingerprint=digest(raw);
 return transaction(()=>{
  const prior=get<{fingerprint:string;id:string}>('user-prompt-operations',operationKey,owner);if(prior){if(prior.fingerprint!==fingerprint)fail('OPERATION_CONFLICT','同一次保存的内容已改变，请重新确认',409);return readUserPrompt(owner,prior.id);}
  const content=normalized(owner,raw),now=Date.now(),value:StoredPrompt={...content,id:randomUUID(),owner,revision:1,created_at:now,updated_at:now};
  put(bucket,value.id,owner,value);put('user-prompt-operations',operationKey,owner,{fingerprint,id:value.id});return publicValue(value);
 });
}
export function updateUserPrompt(owner:string,id:string,body:unknown){return transaction(()=>{
 const raw=object(body);if(raw.operation_id!==undefined&&!identifier(raw.operation_id))fail('INVALID_OPERATION','提示词修改操作编号无效');
 const operationKey=raw.operation_id?digest([owner,id,'update',raw.operation_id]):undefined,fingerprint=digest(raw);
 if(operationKey){const prior=get<{fingerprint:string;revision:number}>('user-prompt-updates',operationKey,owner);if(prior){if(prior.fingerprint!==fingerprint)fail('OPERATION_CONFLICT','同一次修改的内容已变化，请重新确认',409);const current=owned(owner,id);if(current.revision!==prior.revision)fail('REVISION_CONFLICT','该次修改已保存，但条目之后又有修改，请重新加载',409);return publicValue(current);}}
 const previous=owned(owner,id);if(raw.expected_revision!==previous.revision)fail('REVISION_CONFLICT','提示词已在其他页面修改，请重新加载后再保存',409);
 const content=normalized(owner,raw,previous),value:StoredPrompt={...previous,...content,revision:previous.revision+1,updated_at:Date.now()};put(bucket,id,owner,value);if(operationKey)put('user-prompt-updates',operationKey,owner,{fingerprint,revision:value.revision});return publicValue(value);
});}
export function deleteUserPrompt(owner:string,id:string,expected:unknown){return transaction(()=>{
 const prior=get<{revision:number}>('user-prompt-deletions',id,owner);if(prior&&prior.revision===expected)return {ok:true};
 const previous=owned(owner,id);if(expected!==previous.revision)fail('REVISION_CONFLICT','提示词已变化，请重新核对后再删除',409);remove(bucket,id,owner);put('user-prompt-deletions',id,owner,{revision:previous.revision});return {ok:true};
});}
