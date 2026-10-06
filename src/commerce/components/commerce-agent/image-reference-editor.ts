import {createImageReferenceDocument,reconcileImageReferenceDocument,validateImageReferenceDocument,orderImageReferenceInstances,type ImageReferenceDocument,type ImageReferenceInstance} from '../../shared/image-reference-mentions';

export type ImageEditorMaterial={id:string;serverId?:string;slot:string;name:string};
export function imageEditorReferences(materials:readonly ImageEditorMaterial[]):ImageReferenceInstance[]{return materials.map(value=>({instanceId:value.id,assetId:value.serverId||null,slot:value.slot,name:value.name}));}
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
