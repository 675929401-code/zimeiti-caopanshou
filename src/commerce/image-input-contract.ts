// Browser-safe input contracts re-expressed from the observed public catalog.
// These are not the target's private prompts or model implementation.
import {IMAGE_SKILLS} from './components/commerce-agent/catalog';

export type ImageInputSlot={id:string;publicKey:string;label:string;min:number;max:number;kinds:readonly ['image']};
export type ImageInputContract={skillId:string;publicKey:string;publicVersion:number;label:string;slots:readonly ImageInputSlot[];mediaMaxCount:Readonly<{image:number;video:0;audio:0}>;minTextReferences:number;promptRequired:boolean;surfaces:readonly ('toolbox'|'canvas')[]};
export const IMAGE_PUBLIC_CATALOG_REVISION=1337841977;
const publicContracts:Record<string,{key:string;version:number;max:number;slotKeys?:Record<string,string>;minText?:number}>={
 default:{key:'default',version:8,max:9,slotKeys:{reference:'product'}},
 'face-turnaround':{key:'character-face-turnaround',version:10,max:3},
 'character-sheet':{key:'character-fullbody-sheet',version:10,max:5},
 'change-face':{key:'change-face',version:7,max:9},
 'face-fusion':{key:'dual-face-fusion',version:8,max:9,slotKeys:{face1:'face_1',face2:'face_2'}},
 'change-cloth':{key:'change-cloth',version:15,max:6},
 'product-use':{key:'model-product-try-on',version:10,max:9},
 'white-background':{key:'product-white-background',version:14,max:9},
 'clothing-redesign':{key:'element-replace',version:7,max:9,slotKeys:{cloth:'product',print:'printing'}},
 'background-change':{key:'background-change',version:6,max:9,slotKeys:{background:'backround'}},
 'portrait-realism':{key:'portrait-realism-enhance',version:8,max:9},
 'image-refine':{key:'product-refine',version:8,max:9},
 'script-storyboard':{key:'script-storyboard',version:3,max:9,minText:1,slotKeys:{reference:'references'}},
 'storyboard-replace':{key:'storyboard-element-replace',version:5,max:9,slotKeys:{grid:'nine_grid',reference:'references'}},
 'video-first-frame':{key:'video-reference-first-frame',version:3,max:9,slotKeys:{reference:'references'}},
 'product-consistency':{key:'product-consistency-reference',version:5,max:9},
};
export const IMAGE_INPUT_CONTRACTS:readonly ImageInputContract[]=Object.freeze(IMAGE_SKILLS.map(skill=>{
 const spec=publicContracts[skill.id];if(!spec)throw Error('图片技能缺少公开契约映射：'+skill.id);
 return Object.freeze({skillId:skill.id,publicKey:spec.key,publicVersion:spec.version,label:skill.name,
  slots:Object.freeze(skill.slots.map(s=>Object.freeze({id:s.id,publicKey:spec.slotKeys?.[s.id]||s.id,label:s.label,min:s.min,max:s.max,kinds:Object.freeze(['image'] as const)}))),
  mediaMaxCount:Object.freeze({image:spec.max,video:0 as const,audio:0 as const}),minTextReferences:spec.minText||0,promptRequired:!!skill.promptRequired,
  surfaces:Object.freeze(skill.canvasOnly?['canvas' as const]:['toolbox' as const,'canvas' as const])});
}));
export class ImageInputContractError extends Error {
 constructor(public readonly code:string,message:string,public readonly detail:Readonly<Record<string,unknown>>={}){super(message);this.name='ImageInputContractError';}
}
function fail(code:string,message:string,detail:Record<string,unknown>={}):never{throw new ImageInputContractError(code,message,detail);}
export function getImageInputContract(skillId:unknown='default'):ImageInputContract {
 const id=skillId===undefined?'default':skillId;
 const contract=IMAGE_INPUT_CONTRACTS.find(c=>c.skillId===id);
 if(!contract)fail('UNKNOWN_IMAGE_SKILL','图片技能不存在，请重新选择技能');return contract;
}
export type ImageOutputFormat='PNG'|'JPEG'|'WEBP';
export const IMAGE_UI_OUTPUT_FORMATS:readonly ImageOutputFormat[]=Object.freeze(['PNG','JPEG']);
export function normalizeImageFormat(value:unknown):ImageOutputFormat|undefined {
 // Omitted format preserves the existing downloaded format. WEBP remains an
 // explicit local export extension; its existence does not imply a target UI.
 if(value===undefined)return undefined;
 if(typeof value!=='string')fail('INVALID_IMAGE_FORMAT','图片输出格式无效，请选择 PNG 或 JPEG');
 const normalized=value.trim().toUpperCase()==='JPG'?'JPEG':value.trim().toUpperCase();
 if(!['PNG','JPEG','WEBP'].includes(normalized))fail('INVALID_IMAGE_FORMAT','图片输出格式无效，请选择 PNG 或 JPEG');
 return normalized as ImageOutputFormat;
}
export type ImageReference={id:string;slot:string};
export type ImageInputShape={skillId?:unknown;prompt:unknown;references?:unknown;format?:unknown};
export type NormalizedImageInput={skillId:string;prompt:string;references:ImageReference[];format?:ImageOutputFormat};
export type ResolvedImageAsset={id:string;type:string};

export function validateImageInputShape(input:ImageInputShape):NormalizedImageInput {
 if(!input||typeof input!=='object')fail('INVALID_IMAGE_INPUT','图片创作参数无效');
 const contract=getImageInputContract(input.skillId),format=normalizeImageFormat(input.format);
 if(typeof input.prompt!=='string'||input.prompt.length>20000)fail('INVALID_IMAGE_PROMPT','图片创作要求无效或超过服务端长度限制');
 if(contract.promptRequired&&!input.prompt.trim())fail('IMAGE_PROMPT_REQUIRED','请填写图片创作要求');
 const raw=input.references===undefined?[]:input.references;
 if(!Array.isArray(raw))fail('INVALID_IMAGE_REFERENCES','图片参考素材格式无效');
 const references:ImageReference[]=[],seen=new Set<string>();
 for(const value of raw){
  if(!value||typeof value!=='object'||typeof value.id!=='string'||!value.id.trim()||value.id.length>200||typeof value.slot!=='string')fail('INVALID_IMAGE_REFERENCES','图片参考素材缺少有效的素材 ID 或角色');
  const slot=contract.slots.find(s=>s.id===value.slot);
  if(!slot)fail('UNKNOWN_IMAGE_SLOT','请将参考素材分配到当前图片技能对应的角色，或移除未分配素材',{skillId:contract.skillId,slot:typeof value.slot==='string'?value.slot.slice(0,80):null});
  const key=JSON.stringify([value.id,slot.id]);
  if(seen.has(key))fail('DUPLICATE_IMAGE_REFERENCE',`${slot.label}中同一素材不能重复添加`,{slot:slot.id});
  seen.add(key);references.push({id:value.id,slot:slot.id});
 }
 if(references.length>contract.mediaMaxCount.image)fail('IMAGE_REFERENCE_LIMIT',`${contract.label}最多添加 ${contract.mediaMaxCount.image} 张参考图片`,{maximum:contract.mediaMaxCount.image,actual:references.length});
 for(const slot of contract.slots){const count=references.filter(r=>r.slot===slot.id).length;
  if(count<slot.min)fail('IMAGE_SLOT_REQUIRED',`${slot.label}至少需要 ${slot.min} 张图片`,{slot:slot.id,minimum:slot.min,actual:count});
  if(count>slot.max)fail('IMAGE_SLOT_LIMIT',`${slot.label}最多添加 ${slot.max} 张图片`,{slot:slot.id,maximum:slot.max,actual:count});
 }
 // Keep input count separate from image output count / storyboard grid count.
 return {skillId:contract.skillId,prompt:input.prompt,references,...(format?{format}:{})};
}

/** Assets MUST come from the current owner's asset store on the server.
 * Client-side MIME validation is only a usability check, never ownership proof.
 * Cross-role reuse is allowed: only same-asset/same-role duplicates are rejected.
 * The target's deep-video cross-role exclusion is not a generic image rule.
 */
export function validateImageInput(input:ImageInputShape,assets:readonly ResolvedImageAsset[],capabilities?:Readonly<Record<string,unknown>>):NormalizedImageInput {
 const normalized=validateImageInputShape(input);
 if(!Array.isArray(assets))fail('INVALID_IMAGE_ASSETS','图片素材校验结果无效');
 const byId=new Map<string,ResolvedImageAsset>();
 for(const asset of assets){if(!asset||typeof asset.id!=='string'||typeof asset.type!=='string')fail('INVALID_IMAGE_ASSETS','图片素材元数据无效');
  if(byId.has(asset.id)&&byId.get(asset.id)!.type!==asset.type)fail('INVALID_IMAGE_ASSETS','同一图片素材返回了冲突的文件类型');byId.set(asset.id,asset);
 }
 for(const ref of normalized.references){const asset=byId.get(ref.id);if(!asset)fail('IMAGE_ASSET_MISSING','参考素材不存在或不属于当前账号');
  if(!/^image\/(png|jpeg|webp)$/i.test(asset.type))fail('IMAGE_ASSET_TYPE','图片技能仅支持已保存的 PNG、JPEG 或 WEBP 图片',{slot:ref.slot});
 }
 if(capabilities&&normalized.references.length){
  if(capabilities.available===false)fail('IMAGE_MODEL_UNAVAILABLE','当前图片模型不可用');
  if(!capabilities.supportsReferenceInput&&!capabilities.supportsImageInput)fail('IMAGE_MODEL_NO_REFERENCE','此模型不支持参考图，请选择支持图片输入的模型');
  const raw=capabilities.maxReferenceImages;
  const unspecified=raw===undefined||raw===null||typeof raw==='string'&&!raw.trim();
  if(!unspecified&&typeof raw!=='number'&&typeof raw!=='string')fail('INVALID_IMAGE_MODEL_LIMIT','图片模型参考素材上限无效，请核对模型能力配置');
  const maximum=unspecified?1:Number(raw);
  if(!Number.isInteger(maximum)||maximum<0)fail('INVALID_IMAGE_MODEL_LIMIT','图片模型参考素材上限无效，请核对模型能力配置');
  if(normalized.references.length>maximum)fail('IMAGE_MODEL_REFERENCE_LIMIT',`此模型最多支持 ${maximum} 张参考图片`,{maximum,actual:normalized.references.length});
 }
 return normalized;
}

export type ImageTextSource={sourceNodeId:string;text:string;contentHash:string;role:'instruction'|'reference'|'derived'};
/** Call with text provenance derived on the server from the stored graph and
 * completed source steps. Never accept sources or a count from request JSON as
 * evidence of a script connection. Graph owner/version/hash checks are external.
 */
export function validateImageTextSources(skillId:unknown,sources:readonly ImageTextSource[]):readonly ImageTextSource[]{
 const contract=getImageInputContract(skillId);if(!Array.isArray(sources))fail('INVALID_IMAGE_TEXT_SOURCES','图片脚本文本来源无效');
 const actual=new Map<string,ImageTextSource>();
 for(const source of sources){
  if(!source||!['instruction','reference','derived'].includes(source.role)||typeof source.sourceNodeId!=='string'||!source.sourceNodeId.trim()||typeof source.text!=='string'||typeof source.contentHash!=='string'||!/^[a-f0-9]{64}$/i.test(source.contentHash))fail('INVALID_IMAGE_TEXT_SOURCES','图片脚本文本来源或内容指纹无效');
  if(source.role==='derived'||!source.text.trim())continue;
  const previous=actual.get(source.sourceNodeId);
  if(previous&&(previous.text!==source.text||previous.contentHash!==source.contentHash))fail('CONFLICTING_IMAGE_TEXT_SOURCE','同一脚本来源存在冲突版本，请重新核对画布');
  actual.set(source.sourceNodeId,{...source});
 }
 if(actual.size<contract.minTextReferences)fail('IMAGE_TEXT_SOURCE_REQUIRED',`${contract.label}需要连接至少 ${contract.minTextReferences} 个有正文的脚本文本来源`,{minimum:contract.minTextReferences,actual:actual.size});
 return [...actual.values()];
}
