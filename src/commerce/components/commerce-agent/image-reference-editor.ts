import {createImageReferenceDocument,reconcileImageReferenceDocument,validateImageReferenceDocument,orderImageReferenceInstances,type ImageReferenceDocument,type ImageReferenceInstance} from '../../shared/image-reference-mentions';

export type ImageEditorMaterial={id:string;serverId?:string;slot:string;name:string};
export function imageEditorReferences(materials:readonly ImageEditorMaterial[]):ImageReferenceInstance[]{return materials.map(value=>({instanceId:value.id,assetId:value.serverId||null,slot:value.slot,name:value.name}));}
/** A general reference can carry into a one-role tool without guessing its intended role. */
export function assignSingleImageSlot<T extends ImageEditorMaterial>(items:readonly T[],slots:readonly {id:string;max:number}[]):T[]{
 if(slots.length!==1)return [...items];
 const target=slots[0],assigned=items.filter(item=>item.slot===target.id);
 const used=new Set(assigned.map(item=>item.serverId||item.id));
 let available=target.max-assigned.length;
 return items.map(item=>{
  const identity=item.serverId||item.id;
  if(item.slot!=='reference'||item.slot===target.id||available<=0||used.has(identity))return item;
  available--;used.add(identity);return {...item,slot:target.id};
 });
}
/**
 * Cross-tool or library references arrive with a slot the current tool does not know.
 * Fill open slots in display order (first come, first served); overflow keeps its
 * unknown slot so the manual assignment row can still place it. Returns the original
 * array reference when nothing moved so callers can skip a state write.
 */
export function assignOpenImageSlots<T extends ImageEditorMaterial>(items:readonly T[],slots:readonly {id:string;max:number;kinds?:readonly string[]}[]):T[]{
 const slotIds=new Set(slots.map(slot=>slot.id));
 const counts=new Map<string,number>(),used=new Set<string>();
 for(const item of items){if(!slotIds.has(item.slot))continue;counts.set(item.slot,(counts.get(item.slot)||0)+1);used.add(item.serverId||item.id);}
 let changed=false;
 const next=items.map(item=>{
  if(slotIds.has(item.slot))return item;
  const identity=item.serverId||item.id;
  if(used.has(identity))return item;
  const type=(item as T&{type?:string}).type||'',kind=type.startsWith('image/')?'image':type.startsWith('video/')?'video':type.startsWith('audio/')?'audio':'';
  const target=slots.find(slot=>(!slot.kinds||slot.kinds.includes(kind))&&(counts.get(slot.id)||0)<slot.max);
  if(!target)return item;
  counts.set(target.id,(counts.get(target.id)||0)+1);used.add(identity);changed=true;
  return {...item,slot:target.id};
 });
 return changed?next:items as T[];
}
export function orderImageEditorMaterials<T extends ImageEditorMaterial>(materials:readonly T[],slots:readonly string[]):T[]{const ordered=orderImageReferenceInstances(imageEditorReferences(materials),slots);return ordered.map(value=>materials.find(material=>material.id===value.instanceId)!);}
/** Legacy numbered text has no recoverable identity. Require an explicit binding. */
export function restoreImageEditorDocument(text:string,document:ImageReferenceDocument|undefined,materials:readonly ImageEditorMaterial[],slots:readonly string[]){
 const refs=imageEditorReferences(materials),initial=document||createImageReferenceDocument(text,[],slots);
 if(initial.text!==text)throw Error('图片正文与保存的引用文档不一致，请重新核对原任务');
 const restored=reconcileImageReferenceDocument(initial,refs,slots);return validateImageReferenceDocument(restored,text===initial.text?restored.text:text,refs,slots,{allowUnresolved:true});
}
export function imageLegacyFilenameMentions(text:string,refs:readonly ImageReferenceInstance[]){return [...new Set(refs.filter(value=>value.name&&text.includes('@'+value.name)).map(value=>value.name))];}

/** Missing assets remain in the canonical sequence. Availability cannot renumber saved text. */
export function markUnavailableImageReferences(document:ImageReferenceDocument,unavailableInstanceIds:readonly string[]):ImageReferenceDocument{
 const unavailable=new Set(unavailableInstanceIds);return {...document,mentions:document.mentions.map(value=>value.instanceId&&unavailable.has(value.instanceId)?{...value,status:'missing' as const}:value)};
}
