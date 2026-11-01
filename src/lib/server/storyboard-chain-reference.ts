import { createHash } from "node:crypto";
import { isImageEphemeralReceipt } from "@/lib/image-ephemeral-delivery";
import { storageManager } from "@/storage/object";
import { resolveOwnedStoryboardImageUrl } from "@/lib/storyboard-image-read";
import { StoryboardChainRequestSchema, storyboardChainManualReferences, resolveStoryboardExecutionMode, storyboardChainInputFingerprint, storyboardChainConfirmationFingerprint, storyboardChainDependencyFingerprint, type StoryboardChainRun, type StoryboardChainRequest, type StoryboardChainCard } from "@/lib/storyboard-chain-contract";
import { type GeneratedImageReference } from "@/lib/generated-image-reference";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { resolveGeneratedImageReference, readGeneratedImageMaterial } from "@/lib/server/generated-image-reference";
import { parseImageFailureRequestSnapshot } from "@/lib/image-failure-history";

export class StoryboardChainReferenceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}
type OwnedProject = { id: string; owner_id: string; deleted: boolean; document: unknown };
type OwnedRecord = { record_id: string; user_id: string; client_idempotency_key: string; request_snapshot: unknown; state: unknown; delivery_state: unknown; response: unknown };
export type StoryboardChainReferenceDependencies = {
  loadProject(id: string, owner: string): Promise<OwnedProject | null>;
  loadRecord(id: string, owner: string): Promise<OwnedRecord | null>;
  resolve(reference: GeneratedImageReference, owner: string, source: StoryboardChainCard, projectId: string, record: OwnedRecord): Promise<string>;
};
const defaults: StoryboardChainReferenceDependencies = {
  async loadProject(id,owner) { const {data,error}=await getSupabaseAdminClient().from("storyboard_projects").select("id,owner_id,deleted,document").eq("id",id).eq("owner_id",owner).eq("deleted",false).maybeSingle(); if(error) throw new StoryboardChainReferenceError("STORYBOARD_CHAIN_LOOKUP_UNAVAILABLE","串联任务暂时无法核验",503); return data; },
  async loadRecord(id,owner) { const {data,error}=await getSupabaseAdminClient().from("image_generation_requests").select("record_id,user_id,client_idempotency_key,request_snapshot,state,delivery_state,response").eq("record_id",id).eq("user_id",owner).maybeSingle(); if(error) throw new StoryboardChainReferenceError("STORYBOARD_CHAIN_LOOKUP_UNAVAILABLE","串联图片暂时无法核验",503); return data; },
  async resolve(reference,owner,source,projectId,record) {
    if(source.imageAssetId && source.imageStorageKey) return resolveStoryboardChainOwnedOriginal({owner,projectId,card:source,receipt:record.response,recordId:reference.recordId});
    const material = await readGeneratedImageMaterial({userId:owner, reference});
    await decodeStoryboardChainImage(material.buffer);
    return resolveGeneratedImageReference({ userId:owner, reference });
  },
};
const reject = (code: string, message: string): never => { throw new StoryboardChainReferenceError(code,message); };
/** Checks the saved document and immutable image request; client URLs/decoded flags grant nothing. */
export async function resolveStoryboardChainReferences(input: { userId: string; chainContext: StoryboardChainRequest; prompt: string; modelId?: string; aspectRatio?: string; resolution?: string; maxReferenceImages: number; manualReferences: string[] }, deps=defaults): Promise<string[]> {
  const ctx=StoryboardChainRequestSchema.parse(input.chainContext);
  if (input.maxReferenceImages < 1) reject("STORYBOARD_CHAIN_MODEL_UNSUPPORTED","串联模式需要至少一个参考图位置，本次未提交或扣费");
  const project=await deps.loadProject(ctx.projectId,input.userId);
  if (!project || project.id!==ctx.projectId || project.owner_id!==input.userId || project.deleted!==false) reject("STORYBOARD_CHAIN_PROJECT_NOT_OWNED","串联任务不存在或不属于当前账号");
  const run=project!.document as StoryboardChainRun;
  if (!run || !Array.isArray(run.cards) || run.id!==ctx.projectId || resolveStoryboardExecutionMode(run)!=="chained" || run.visualAssetPlan?.mode!=="off" || run.chainRevision!==ctx.chainRevision) reject("STORYBOARD_CHAIN_STALE","串联任务模式或版本已变化，请保存后重新检查");
  const cards=[...run.cards].sort((a,b)=>a.order-b.order);
  if(new Set(cards.map(c=>c.id)).size!==cards.length || new Set(cards.map(c=>c.order)).size!==cards.length) reject("STORYBOARD_CHAIN_ORDER_INVALID","串联分段顺序无效");
  const index=cards.findIndex(c=>c.id===ctx.cardId), card=cards[index];
  if (!card || card.imagePrompt.trim()!==input.prompt.trim() || (input.modelId && run.imageModelId!==input.modelId) || (input.aspectRatio && (run.imageRatio || run.ratio)!==input.aspectRatio) || (input.resolution && run.imageResolution?.toUpperCase()!==input.resolution.toUpperCase())) reject("STORYBOARD_CHAIN_INPUT_STALE","串联输入与已保存任务不一致");
  if (storyboardChainManualReferences(card).length > 0 || input.manualReferences.length > 0) reject("STORYBOARD_CHAIN_REFERENCE_SLOT_CONFLICT","串联模式的参考位置由首段与紧邻前段占用；请先移除手动参考图后再串联，本次未提交或扣费");
  if(index===0) { if(ctx.anchor || ctx.previous) reject("STORYBOARD_CHAIN_FIRST_CARD_INVALID","首段不能携带串联图片"); return input.manualReferences; }
  const immediatePrevious=cards[index-1];
  if(immediatePrevious.imageStatus!=="done" || immediatePrevious.imageMediaState || immediatePrevious.imageReferenceState==="stale" || !(immediatePrevious.imageRecordId || immediatePrevious.imageRef?.recordId)) reject("STORYBOARD_CHAIN_PREVIOUS_NOT_DELIVERED","紧邻前段尚未保存当前交付结果");
  const first=cards[0], confirmation=first.chainAnchorConfirmation;
  if (!confirmation || confirmation.recordId!==(first.imageRef?.recordId || first.imageRecordId) || confirmation.chainRevision!==ctx.chainRevision || confirmation.inputFingerprint!==storyboardChainInputFingerprint(run,first)) reject("STORYBOARD_CHAIN_ANCHOR_UNCONFIRMED","请先保存并明确采用首段图片");
  if(!ctx.anchor || ctx.anchor.cardId!==first.id || ctx.anchor.imageRef.recordId!==(first.imageRef?.recordId || first.imageRecordId) || ctx.anchor.imageRef.transform || ctx.anchor.confirmationFingerprint!==storyboardChainConfirmationFingerprint(confirmation!)) reject("STORYBOARD_CHAIN_ANCHOR_STALE","首段采用记录已变化");
  const chosen: Array<{card:StoryboardChainCard;ref:GeneratedImageReference;consume:boolean}>=[{card:first,ref:ctx.anchor!.imageRef,consume:true}];
  if(index>=2 && input.maxReferenceImages>=2) {
    const prev=cards[index-1];
    if(!ctx.previous || ctx.previous.cardId!==prev.id || ctx.previous.imageRef.recordId!==(prev.imageRef?.recordId || prev.imageRecordId) || ctx.previous.imageRef.transform || ctx.previous.dependencyFingerprint!==storyboardChainDependencyFingerprint(run,prev)) reject("STORYBOARD_CHAIN_PREVIOUS_STALE","紧邻前段尚未保存可用图片或依赖已变化");
    chosen.push({card:prev,ref:ctx.previous!.imageRef,consume:true});
  } else if(ctx.previous) reject("STORYBOARD_CHAIN_PREVIOUS_UNEXPECTED","当前分段或模型不能携带前段参考");
  if(index>=2 && input.maxReferenceImages===1) chosen.push({card:immediatePrevious,ref:{schema:"generated_image_ref.v1",recordId:(immediatePrevious.imageRecordId || immediatePrevious.imageRef?.recordId)!},consume:false});
  const urls:string[]=[];
  for(const {card:source,ref,consume} of chosen) {
    if(source.imageStatus!=="done" || source.imageMediaState || source.imageReferenceState === "stale" || storyboardChainManualReferences(source).length > 0 || (source.imageRecordId || source.imageRef?.recordId)!==ref.recordId || (source.imageRef && source.imageRef.recordId!==ref.recordId) || source.imageRef?.transform) reject("STORYBOARD_CHAIN_IMAGE_NOT_CURRENT","串联图片不是已保存的当前交付结果");
    const row=await deps.loadRecord(ref.recordId,input.userId);
    const snapshot=parseImageFailureRequestSnapshot(row?.request_snapshot);
    if(!row || row.state!=="completed" || row.delivery_state!=="delivered" || row.user_id!==input.userId || row.record_id!==ref.recordId || !snapshot?.chainContext || snapshot.chainContext.projectId!==ctx.projectId || snapshot.chainContext.cardId!==source.id || snapshot.chainContext.chainRevision!==ctx.chainRevision || snapshot.prompt.trim()!==source.imagePrompt.trim() || snapshot.publicModelId!==run.imageModelId || snapshot.aspectRatio!==(run.imageRatio || run.ratio) || snapshot.resolution!==run.imageResolution?.toUpperCase()) reject("STORYBOARD_CHAIN_RECORD_MISMATCH","串联图片不属于本任务本分段当前输入");
    const sourceIndex=cards.findIndex(c=>c.id===source.id);
    if(sourceIndex>0 && (!snapshot!.chainContext!.anchor || snapshot!.chainContext!.anchor.cardId!==first.id || snapshot!.chainContext!.anchor.imageRef.recordId!==(first.imageRef?.recordId || first.imageRecordId) || snapshot!.chainContext!.anchor.confirmationFingerprint!==storyboardChainConfirmationFingerprint(confirmation!))) reject("STORYBOARD_CHAIN_DEPENDENCY_STALE","前段生成时的首段采用记录已失效");
    const sourcePrevious=snapshot!.chainContext!.previous;
    if(sourcePrevious && (sourceIndex<2 || sourcePrevious.cardId!==cards[sourceIndex-1].id || sourcePrevious.dependencyFingerprint!==storyboardChainDependencyFingerprint(run,cards[sourceIndex-1]))) reject("STORYBOARD_CHAIN_DEPENDENCY_STALE","前段生成依赖已变化");
    const url=await deps.resolve(ref,input.userId,source,ctx.projectId,row!); if(consume && !urls.includes(url)) urls.push(url);
  }
  const merged=[...new Set([...urls,...input.manualReferences])];
  if(merged.length>input.maxReferenceImages) reject("STORYBOARD_CHAIN_REFERENCE_SLOT_CONFLICT","串联图片与手动参考图超过模型位置，请调整后再提交");
  return merged;
}

/** Complete pixel decode, shared by production reference resolution and zero-network byte fixtures. */
export async function decodeStoryboardChainImage(buffer: Buffer): Promise<void> {
  const { default: sharp } = await import("sharp");
  await sharp(buffer,{failOn:"error",limitInputPixels:40_000_000}).raw().toBuffer();
}
/** Recheck the saved dependency graph immediately before reservation and dispatch; never regenerate. */
export async function assertStoryboardChainDispatchCurrent(input: Parameters<typeof resolveStoryboardChainReferences>[0]) {
  await resolveStoryboardChainReferences(input,{...defaults,resolve:async(reference)=>`validated-image://${reference.recordId}`});
}

export type StoryboardChainOwnedOriginalDependencies = {
  readOwned(input: { owner:string; assetId:string; storageKey:string }): Promise<{assetId:string;storageKey:string;url:string;buffer:Buffer;meta?:Record<string,unknown>}>;
};
const ownedOriginalDefaults:StoryboardChainOwnedOriginalDependencies = {
  async readOwned(input) {
    const db=getSupabaseAdminClient();
    const signed=await resolveOwnedStoryboardImageUrl({db,userId:input.owner,assetId:input.assetId,storageKey:input.storageKey});
    const {data,error}=await db.from("user_files").select("storage_provider,source,meta").eq("user_id",input.owner).eq("id",input.assetId).eq("storage_key",input.storageKey).eq("file_category","image").maybeSingle();
    if(error || !data || data.source!=="image-workbench" || data.storage_provider!=="tencent_cos") throw new StoryboardChainReferenceError("STORYBOARD_CHAIN_ORIGINAL_NOT_OWNED","原图保存记录无法确认");
    const buffer=await storageManager.readBounded(input.storageKey,25*1024*1024,20_000,"tencent_cos");
    return {...signed,buffer,meta:data.meta as Record<string,unknown>};
  },
};
/** Only the byte-identical original export of this immutable receipt; no crop/other owned asset. */
export async function resolveStoryboardChainOwnedOriginal(input:{owner:string;projectId:string;card:StoryboardChainCard;receipt:unknown;recordId?:string},deps=ownedOriginalDefaults):Promise<string> {
  const {card,receipt}=input;
  const recordId=input.recordId || (isImageEphemeralReceipt(receipt)?receipt.recordId:undefined);
  if(!card.imageAssetId || !card.imageStorageKey || !recordId || recordId!==(card.imageRecordId || card.imageRef?.recordId) || card.imageRef?.transform) reject("STORYBOARD_CHAIN_ORIGINAL_MISMATCH","保存原图与当前分段记录不一致");
  const owned=await deps.readOwned({owner:input.owner,assetId:card.imageAssetId!,storageKey:card.imageStorageKey!});
  const byteHash=createHash("sha256").update(owned.buffer).digest("hex");
  const trace="storyboard-board-export-"+createHash("sha256").update(JSON.stringify([input.owner,input.projectId,card.id,recordId,byteHash])).digest("hex");
  const stableName=createHash("sha256").update(`${input.owner}\0${trace}`).digest("hex").slice(0,48);
  const expectedKeyPrefix=`image-workbench/by-trace/${stableName}-1.`;
  const immutableHash=isImageEphemeralReceipt(receipt) ? receipt.sha256 : owned.meta?.chain_original_schema==="storyboard_chain_original.v1" && owned.meta.chain_project_id===input.projectId && owned.meta.chain_card_id===card.id && owned.meta.chain_record_id===recordId ? owned.meta.chain_original_sha256 : undefined;
  if(owned.assetId!==card.imageAssetId || owned.storageKey!==card.imageStorageKey || !["png","jpg","webp"].some(ext=>owned.storageKey===expectedKeyPrefix+ext) || byteHash!==immutableHash || (isImageEphemeralReceipt(receipt) && owned.buffer.length!==receipt.byteLength)) reject("STORYBOARD_CHAIN_ORIGINAL_MISMATCH","保存图片不是本任务本分段的完整原图");
  await decodeStoryboardChainImage(owned.buffer);
  const {validatePublicImageResultUrl}=await import("@/lib/image-result-network");
  if(deps===ownedOriginalDefaults) await validatePublicImageResultUrl(owned.url);
  return owned.url;
}

export type StoryboardChainOriginalBinding = {projectId:string;cardId:string;recordId:string};
export async function verifyStoryboardChainOriginalExport(input:{userId:string;binding:StoryboardChainOriginalBinding;buffer:Buffer},deps:StoryboardChainReferenceDependencies=defaults,readOriginal=readGeneratedImageMaterial):Promise<Record<string,string>> {
  const {binding}=input;
  if(!binding || Object.keys(binding).some(k=>!["projectId","cardId","recordId"].includes(k)) || !/^[A-Za-z0-9:_-]{8,160}$/u.test(binding.projectId) || typeof binding.cardId!=="string" || !binding.cardId || binding.cardId.length>160 || !/^[a-f0-9]{64}$/u.test(binding.recordId)) reject("STORYBOARD_CHAIN_ORIGINAL_INVALID","原图绑定参数无效");
  const project=await deps.loadProject(binding.projectId,input.userId);
  const run=project?.document as StoryboardChainRun;
  const card=run?.cards?.find(c=>c.id===binding.cardId);
  if(!project || project.owner_id!==input.userId || project.id!==binding.projectId || project.deleted || !card || (card.imageRecordId || card.imageRef?.recordId)!==binding.recordId || resolveStoryboardExecutionMode(run)!=="chained") reject("STORYBOARD_CHAIN_ORIGINAL_MISMATCH","原图不是已保存的本任务本分段当前记录");
  const row=await deps.loadRecord(binding.recordId,input.userId);
  const snapshot=parseImageFailureRequestSnapshot(row?.request_snapshot);
  if(!row || row.user_id!==input.userId || row.record_id!==binding.recordId || row.state!=="completed" || row.delivery_state!=="delivered" || snapshot?.chainContext?.projectId!==binding.projectId || snapshot.chainContext.cardId!==binding.cardId) reject("STORYBOARD_CHAIN_ORIGINAL_MISMATCH","原生成请求与任务分段不匹配");
  const sha=createHash("sha256").update(input.buffer).digest("hex");
  if(isImageEphemeralReceipt(row!.response)) {
    if(row!.response.recordId!==binding.recordId || row!.response.sha256!==sha || row!.response.byteLength!==input.buffer.length) reject("STORYBOARD_CHAIN_ORIGINAL_MISMATCH","提交文件不是原生成完整图片");
  } else {
    const original=await readOriginal({userId:input.userId,reference:{schema:"generated_image_ref.v1",recordId:binding.recordId},maxBytes:25*1024*1024});
    if(createHash("sha256").update(original.buffer).digest("hex")!==sha || original.buffer.length!==input.buffer.length) reject("STORYBOARD_CHAIN_ORIGINAL_MISMATCH","提交文件不是原生成完整图片");
  }
  await decodeStoryboardChainImage(input.buffer);
  return {chain_original_schema:"storyboard_chain_original.v1",chain_project_id:binding.projectId,chain_card_id:binding.cardId,chain_record_id:binding.recordId,chain_original_sha256:sha};
}

/** Project save/readback preserves owned originals only after exact immutable provenance and byte validation. */
export async function resolveStoryboardChainSavedOriginal(input:{userId:string;projectId:string;card:StoryboardChainCard},deps=defaults,ownedDeps=ownedOriginalDefaults):Promise<string> {
  const recordId=input.card.imageRecordId || input.card.imageRef?.recordId;
  if(!recordId) reject("STORYBOARD_CHAIN_ORIGINAL_MISMATCH","原图记录缺失");
  const row=await deps.loadRecord(recordId!,input.userId);
  const snapshot=parseImageFailureRequestSnapshot(row?.request_snapshot);
  if(!row || row.user_id!==input.userId || row.record_id!==recordId || row.state!=="completed" || row.delivery_state!=="delivered" || snapshot?.chainContext?.projectId!==input.projectId || snapshot.chainContext.cardId!==input.card.id) reject("STORYBOARD_CHAIN_ORIGINAL_MISMATCH","保存原图不属于当前任务分段");
  return resolveStoryboardChainOwnedOriginal({owner:input.userId,projectId:input.projectId,card:input.card,receipt:row!.response,recordId},ownedDeps);
}
