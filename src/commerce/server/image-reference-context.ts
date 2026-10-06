import {createHash} from 'node:crypto';
import {readAsset,assetBytes} from './assets';
import {getImageInputContract} from '../image-input-contract';
import {compileImageReferenceDocument,type ImageReferenceDocument,type CompiledImageReference} from '../shared/image-reference-mentions';
import type {JobInput} from './jobs';

export type ImageReferenceSnapshot = {version:1;mode:'legacy'|'mentions';document:ImageReferenceDocument;references:CompiledImageReference[];fingerprint:string};
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function imageSnapshotHash(value:unknown){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
export function hasImageReferenceIdentity(input:JobInput){return input.kind==='image'&&(input.imageReferenceDocument!==undefined || (Array.isArray(input.references)&&input.references.some(r=>r.instanceId!==undefined)));}

/** Only the service constructs this snapshot. No client-provided owner or SHA is
 * trusted. Numbered new ordinary-image requests require a document; dedicated
 * detail-set requests retain their separately claimed row/quote authority.
 */
export function prepareImageReferenceInput(owner:string,input:JobInput):{input:JobInput;snapshot?:ImageReferenceSnapshot} {
  if(input.kind!=='image'){
    if(input.imageReferenceDocument!==undefined)throw Error('图片提及文档只能用于图片任务');
    return {input};
  }
  const required=hasImageReferenceIdentity(input)||(!input.purpose?.startsWith('detail-set.')&&/@图片\d+/.test(input.prompt));
  if(!required){
    // New legacy/plain requests still bind file bytes. Preserve their historical
    // raw reference order and input shape; never invent mention identities in it.
    const references=(input.references||[]).map((r,i)=>{const asset=readAsset(r.id,owner);if(!asset)throw Error('参考图片已删除或不属于当前账号');return {id:r.id,instanceId:'legacy-ref:'+i,slot:r.slot,number:i+1,label:'@图片'+(i+1),sha256:asset.sha256};});
    const content={mode:'legacy' as const,document:{version:1 as const,text:input.prompt,mentions:[]},references};
    return {input,snapshot:{version:1,...content,fingerprint:imageSnapshotHash({skillId:input.skillId||'default',...content})}};
  }
  if(input.imageReferenceDocument===undefined)throw Error('图片编号或素材实例缺少引用文档，请重新选择并核对图片提及');
  if(!Array.isArray(input.references||[])||(input.references||[]).some(r=>typeof r.instanceId!=='string'||!r.instanceId))throw Error('每张参考图片都需要稳定的实例 ID');
  const assets=new Map((input.references||[]).map(r=>{const asset=readAsset(r.id,owner);if(!asset)throw Error('参考图片已删除或不属于当前账号');return [asset.id,asset] as const;}));
  const compiled=compileImageReferenceDocument({document:input.imageReferenceDocument,text:input.prompt,owner,
    references:(input.references||[]).map(r=>({instanceId:r.instanceId!,assetId:r.id,slot:r.slot,name:assets.get(r.id)!.name})),
    slotOrder:getImageInputContract(input.skillId).slots.map(s=>s.id),ownedAssets:[...assets.values()]});
  const snapshot:ImageReferenceSnapshot={version:1,mode:'mentions',...compiled,fingerprint:imageSnapshotHash({skillId:input.skillId||'default',mode:'mentions',...compiled})};
  return {input:{...input,imageReferenceDocument:compiled.document,references:compiled.references.map(r=>({id:r.id,slot:r.slot,instanceId:r.instanceId}))},snapshot};
}

/** Metadata must still match the saved authorization snapshot at claim and send.
 * Old queued jobs without identity fields retain their original legacy behavior.
 */
export function verifyImageReferenceSnapshot(owner:string,input:JobInput,snapshot:ImageReferenceSnapshot|undefined){
  if(!snapshot&&!hasImageReferenceIdentity(input))return;
  if(!snapshot||snapshot.version!==1)throw Error('图片引用来源快照缺失，请重新核对原任务');
  const current=prepareImageReferenceInput(owner,input).snapshot;
  if(!current||imageSnapshotHash(snapshot)!==imageSnapshotHash(current))throw Error('图片正文、引用顺序或素材 SHA 已改变，请重新核对');
}

/** Check physical bytes as well as the asset table. Deletion/byte replacement
 * while queued fails before dispatch; unknown/poll/save paths do not replay it.
 */
export async function verifyImageReferenceBytes(owner:string,input:JobInput,snapshot:ImageReferenceSnapshot|undefined){
  verifyImageReferenceSnapshot(owner,input,snapshot);
  if(!snapshot)return;
  for(const [id,sha] of new Map(snapshot.references.map(r=>[r.id,r.sha256]))){
    const asset=readAsset(id,owner);if(!asset)throw Error('参考图片已删除或不属于当前账号');
    const bytes=await assetBytes(asset);
    if(createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('参考图片实际文件与来源 SHA 不一致，请重新上传');
  }
  verifyImageReferenceSnapshot(owner,input,snapshot);
}

export function imageMentionBinding(snapshot:ImageReferenceSnapshot|undefined){
  return snapshot?.mode==='mentions'?'\n图片提及绑定（编号与实际图片输入顺序一致）：\n'+snapshot.references.map(r=>`${r.label}：参考${r.number}，角色 ${r.slot}`).join('\n'):'';
}
