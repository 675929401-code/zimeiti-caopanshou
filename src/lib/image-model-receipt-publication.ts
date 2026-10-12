import {createHash} from "node:crypto";
import sharp from "sharp";
import type {AdminAuthorizationResult} from "@/lib/admin-auth";
import type {getSupabaseAdminClient} from "@/storage/database/supabase-client";
import {storageManager} from "@/storage/object";
import {probeProductionDatabaseReadiness} from "@/lib/production-database-readiness";
import {readGeneratedImageMaterial} from "@/lib/server/generated-image-reference";
import {authorizeImageValidationProof,assertImageValidationDatabase,imageValidationFailure,imageValidationRequestIdentity,loadImageAdminValidationContext,type ImageValidationProof} from "@/lib/image-admin-validation";

export const IMAGE_RECEIPT_PUBLICATION_INTENT="retain_validation_evidence_and_publish";
const MAX=30*1024*1024;
const object=(value:unknown):Record<string,unknown>=>value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:{};
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const same=(left:unknown,right:unknown)=>JSON.stringify(Object.entries(object(left)).sort(([a],[b])=>a.localeCompare(b)))===JSON.stringify(Object.entries(object(right)).sort(([a],[b])=>a.localeCompare(b)));
export async function readBoundedImagePublicationBody(request:Request,limit:number):Promise<Buffer>{
  if(!request.body)imageValidationFailure("IMAGE_PUBLICATION_INPUT_INVALID","发布请求为空",400);
  const reader=request.body.getReader(),chunks:Buffer[]=[];let size=0;
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>limit){await reader.cancel();imageValidationFailure("IMAGE_PUBLICATION_BYTES_INVALID","发布请求超过大小上限",413);}chunks.push(Buffer.from(item.value));}}finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
export async function verifyImagePublicationBytes(buffer:Buffer,contentType:string) {
  if(!buffer.length || buffer.length>MAX || !["image/png","image/jpeg","image/webp"].includes(contentType))imageValidationFailure("IMAGE_PUBLICATION_BYTES_INVALID","请选择原验证图片，大小不得超过 30MB",422);
  const decoder=sharp(buffer,{failOn:"error",limitInputPixels:40_000_000});
  const metadata=await decoder.metadata();
  if(metadata.format!==(contentType==="image/jpeg"?"jpeg":contentType.slice(6)))imageValidationFailure("IMAGE_PUBLICATION_BYTES_INVALID","图片类型与完整内容不匹配",422);
  const decoded=await decoder.raw().toBuffer();
  const width=Number(metadata.width),height=Number(metadata.height);
  if(!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width<=0 || height<=0 || width>32768 || height>32768 || !decoded.length)imageValidationFailure("IMAGE_PUBLICATION_BYTES_INVALID","原验证图片无法完整解码",422);
  return {size:buffer.length,contentType,width,height,sha256:sha(buffer)};
}
type Input={db:ReturnType<typeof getSupabaseAdminClient>;authorization:AdminAuthorizationResult;modelId:string;imageRecordId:string;proof:ImageValidationProof;intent:unknown;readInline?:()=>Promise<{buffer:Buffer;contentType:string}>};
type Dependencies={readiness?:typeof probeProductionDatabaseReadiness;readProvider?:typeof readGeneratedImageMaterial;storage?:Pick<typeof storageManager,"headPublicationObjectOnly"|"readBounded"|"uploadPublicationObjectOnly">};

/** Only an explicit administrator publication action may retain an independent evidence asset. */
export async function publishImageModelReceipt(input:Input,dependencies:Dependencies={}) {
  assertImageValidationDatabase(input.db);
  if(input.intent!==IMAGE_RECEIPT_PUBLICATION_INTENT)imageValidationFailure("IMAGE_PUBLICATION_CONFIRMATION_REQUIRED","请明确确认保存验证凭证并发布模型",400);
  const context=await loadImageAdminValidationContext(input.db,input.modelId,input.authorization);
  authorizeImageValidationProof(context,input.proof,input.authorization);
  const attempt=context.existing, identity=imageValidationRequestIdentity(context.userId,context.validationKey);
  if(!attempt || attempt.user_id!==context.userId || attempt.validation_id!==context.validationId || attempt.image_record_id!==identity.recordId || input.imageRecordId!==identity.recordId || attempt.state==="rejected")imageValidationFailure("IMAGE_PUBLICATION_REQUEST_MISMATCH","仅能存证当前配置的原验证图片");
  const result=await input.db.from("image_generation_requests").select("record_id,user_id,client_idempotency_key,client_trace_id,payload_fingerprint,state,response,request_snapshot,delivery_state,delivery_asset_id,provider_dispatch_receipt,provider_submission_receipt").eq("record_id",identity.recordId).eq("user_id",context.userId).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  const request=object(result.data), response=object(request.response), dispatch=object(request.provider_dispatch_receipt), submission=object(request.provider_submission_receipt);
  const mode=response.deliveryMode;
  if(result.error || request.record_id!==identity.recordId || request.user_id!==context.userId || request.client_idempotency_key!==context.validationKey || request.client_trace_id!==context.validationKey || request.payload_fingerprint!==attempt.payload_fingerprint || request.state!=="completed" || request.delivery_state!=="delivered" || request.delivery_asset_id!=null || response.selectedModelId!==context.model.id || !["provider_url","inline_ephemeral"].includes(String(mode)) || dispatch.schema!=="image_provider_dispatch_receipt.v1" || submission.schema!=="image_provider_submission_receipt.v1" || !/^[a-f0-9]{64}$/u.test(String(dispatch.receiptSha256)) || !/^[a-f0-9]{64}$/u.test(String(submission.receiptSha256)) || submission.dispatchReceiptSha256!==dispatch.receiptSha256 || submission.transportState!=="response_received" || Number(submission.responseStatus)<200 || Number(submission.responseStatus)>299 || !Number.isInteger(submission.responseStatus))imageValidationFailure("IMAGE_PUBLICATION_REQUEST_INCOMPLETE","原验证任务与上游完成收据尚不可确认");
  if(Number(response.selectedCostPrice)!==Number(context.model.cost_price) || (mode==="inline_ephemeral" && (Number(response.cashCharged)!==Number(context.model.selling_price) || response.billingReferenceId!==identity.billingKey)))imageValidationFailure("IMAGE_PUBLICATION_BILLING_INCOMPLETE","原验证费用与当前配置不匹配");
  const snapshot=object(request.request_snapshot),price=Number(context.model.selling_price);
  if(snapshot.quotedPriceYuan==null || Number(snapshot.quotedPriceYuan)!==price || Number(attempt.quoted_price_yuan)!==price || Number(attempt.cost_price_yuan)!==Number(context.model.cost_price))imageValidationFailure('IMAGE_PUBLICATION_BILLING_INCOMPLETE','原验证报价与当前配置不匹配');
  const operations=await input.db.from('wallet_operations').select('id,user_id,wallet,operation_kind,idempotency_key,status,amount,delta').eq('user_id',context.userId).in('idempotency_key',[identity.billingKey,identity.billingKey+':release']);
  const wallet:Record<string,unknown>[]=Array.isArray(operations.data)?operations.data.map(object):[];
  if(operations.error || wallet.some(op=>op.operation_kind==='cash_refund') || (price===0 ? (wallet.length!==0 || snapshot.billingExempt!==true) : (wallet.length!==1 || wallet[0].wallet!=='cash' || wallet[0].operation_kind!=='cash_charge' || wallet[0].status!=='completed' || Number(wallet[0].amount)!==price || Number(wallet[0].delta)!==-price)))imageValidationFailure('IMAGE_PUBLICATION_BILLING_INCOMPLETE','原验证扣费或免扣证据尚不可确认');
  const readiness=await (dependencies.readiness||probeProductionDatabaseReadiness)();
  if(readiness.state==="probe-unavailable" || readiness.missingRpcs.includes("publish_image_model_validation_receipt") || readiness.missingRpcArguments.some(value=>value.startsWith("publish_image_model_validation_receipt.")))imageValidationFailure("IMAGE_PUBLICATION_MIGRATION_NOT_READY","发布存证升级尚未就绪；原任务与费用收据已保留",503);
  const storage=dependencies.storage||storageManager;
  let bytes:{buffer:Buffer;contentType:string}, evidence:Record<string,unknown>;
  if(attempt.state==="published") {
    evidence=object(attempt.evidence);
    const digest=String(evidence.sha256||"");
    if(!/^[a-f0-9]{64}$/u.test(digest) || evidence.schema!=="image_publication_receipt.v1" || evidence.sourceMode!==mode)imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN","原发布存证尚不可确认",503);
    const key=`admin-image-publication/${sha(context.userId)}/${context.validationId}/${identity.recordId}/${digest}`;
    const head=await storage.headPublicationObjectOnly(key);
    if(!head || head.size>MAX || head.size<=0)imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN","原发布存证暂不可读取",503);
    bytes={buffer:await storage.readBounded(key,head.size,20_000,"tencent_cos"),contentType:head.contentType};
  } else {
    if(mode==="inline_ephemeral") {
      if(!input.readInline)imageValidationFailure("IMAGE_PUBLICATION_ORIGINAL_IMAGE_REQUIRED","请提供本页原验证图片或选择已下载的同一原图",422);
      bytes=await input.readInline();
    } else {
      if(input.readInline)imageValidationFailure("IMAGE_PUBLICATION_INPUT_INVALID","链接交付只允许服务端读取原归属图片",400);
      bytes=await (dependencies.readProvider||readGeneratedImageMaterial)({userId:context.userId,reference:{schema:"generated_image_ref.v1",recordId:identity.recordId},maxBytes:MAX});
    }
    evidence={};
  }
  const verified=await verifyImagePublicationBytes(bytes.buffer,bytes.contentType);
  if(mode==="inline_ephemeral" && (verified.sha256!==response.sha256 || verified.size!==response.byteLength || verified.contentType!==response.contentType || verified.width!==response.width || verified.height!==response.height))imageValidationFailure("IMAGE_PUBLICATION_INLINE_BYTES_MISMATCH","选择的图片与原验证图像摘要不一致",422);
  if(verified.width!==Number(response.width) || verified.height!==Number(response.height))imageValidationFailure("IMAGE_PUBLICATION_BYTES_INVALID","图像尺寸与原任务不匹配",422);
  const expectedEvidence={schema:"image_publication_receipt.v1",sourceMode:mode,sha256:verified.sha256,width:verified.width,height:verified.height,dispatchReceiptSha256:dispatch.receiptSha256,submissionReceiptSha256:submission.receiptSha256,...(mode==="provider_url"?{providerUrlSha256:sha(String(response.providerUrl||""))}:{})};
  if(attempt.state==="published" && !same(evidence,expectedEvidence))imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN","已发布凭证与原任务不匹配",503);
  const key=`admin-image-publication/${sha(context.userId)}/${context.validationId}/${identity.recordId}/${verified.sha256}`;
  const existing=await storage.headPublicationObjectOnly(key);
  if(existing) {
    if(existing.size!==verified.size || existing.contentType!==verified.contentType || sha(await storage.readBounded(key,verified.size,20_000,"tencent_cos"))!==verified.sha256)imageValidationFailure("IMAGE_PUBLICATION_ASSET_COLLISION","存证对象存在冲突，未发布",409);
  } else {
    try {await storage.uploadPublicationObjectOnly(bytes.buffer,key,verified.contentType);}catch{imageValidationFailure("IMAGE_PUBLICATION_OBJECT_UPLOAD_UNKNOWN","存证上传结果未知；请重试同一发布操作，不要重新生成",503);}
  }
  const head=await storage.headPublicationObjectOnly(key);
  if(!head || head.size!==verified.size || head.contentType!==verified.contentType)imageValidationFailure("IMAGE_PUBLICATION_OBJECT_UNAVAILABLE","存证对象尚不可确认",503);
  const savedBytes=await storage.readBounded(key,verified.size,20_000,"tencent_cos"), savedImage=await verifyImagePublicationBytes(savedBytes,head.contentType);
  if(savedImage.sha256!==verified.sha256)imageValidationFailure("IMAGE_PUBLICATION_OBJECT_MISMATCH","存证对象内容不一致",503);
  const latest=await loadImageAdminValidationContext(input.db,input.modelId,input.authorization);authorizeImageValidationProof(latest,input.proof,input.authorization);
  const args={p_validation_id:context.validationId,p_user_id:context.userId,p_configuration_hash:context.configurationHash,p_model_snapshot_hash:context.modelSnapshotHash,p_expected_active:latest.model.is_active,p_expected_hidden:latest.model.is_hidden,p_verified_key:key,p_verified_size:verified.size,p_verified_type:verified.contentType,p_evidence:expectedEvidence};
  const verifyAsset=async(assetId:unknown)=>{
    const lookup=await input.db.from("user_files").select("id,user_id,storage_key,storage_provider,file_size,content_type,file_category,source,is_public,meta").eq("id",String(assetId||"")).eq("user_id",context.userId).maybeSingle();
    const asset=object(lookup.data),meta=object(asset.meta);
    if(lookup.error || String(asset.id)!==String(assetId) || asset.user_id!==context.userId || asset.storage_key!==key || asset.storage_provider!=="tencent_cos" || Number(asset.file_size)!==verified.size || asset.content_type!==verified.contentType || asset.file_category!=="image" || asset.source!=="admin_image_publication" || asset.is_public!==false || meta.purpose!=="admin_image_publication" || meta.validationId!==context.validationId || meta.imageRecordId!==identity.recordId || meta.configurationHash!==context.configurationHash || meta.modelSnapshotHash!==context.modelSnapshotHash || meta.payloadFingerprint!==attempt.payload_fingerprint || meta.sourceMode!==mode || meta.sha256!==verified.sha256 || meta.size!==verified.size || meta.contentType!==verified.contentType || meta.width!==verified.width || meta.height!==verified.height || meta.billingReferenceId!==identity.billingKey || meta.billingOperationId!==(price===0?null:String(wallet[0].id)))imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN","原发布资产与凭证绑定尚不可确认",503);
  };
  let saved;try{saved=await input.db.rpc("publish_image_model_validation_receipt",args);}catch{saved={data:null,error:{code:"UNKNOWN"}};}
  if(saved.error) {
    if(saved.error.code==="40001")imageValidationFailure("IMAGE_VALIDATION_CONFIGURATION_CHANGED","发布期间配置已修改，原凭证不能发布当前配置");
    // A lost ACK only reads the same validation; it never uploads, charges, or generates again.
    const confirmation=await input.db.from("image_model_validations").select("state,user_id,image_record_id,asset_id,evidence,configuration_hash,model_snapshot_hash").eq("validation_id",context.validationId).eq("user_id",context.userId).maybeSingle();
    const confirmed=object(confirmation.data);
    if(confirmation.error || confirmed.state!=="published" || confirmed.user_id!==context.userId || confirmed.image_record_id!==identity.recordId || confirmed.configuration_hash!==context.configurationHash || confirmed.model_snapshot_hash!==context.modelSnapshotHash || !confirmed.asset_id || !same(confirmed.evidence,expectedEvidence))imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN","发布结果未知；请保留原任务读取，不要重新生成",503);
    const config=await loadImageAdminValidationContext(input.db,input.modelId,input.authorization);authorizeImageValidationProof(config,input.proof,input.authorization);
    if(config.model.is_active!==true || config.model.is_hidden!==false)imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN","发布配置尚不可确认",503);
    await verifyAsset(confirmed.asset_id);
    return {success:true,alreadyPublished:true,modelId:context.model.id,imageRecordId:identity.recordId,assetId:String(confirmed.asset_id)};
  }
  const receipt=object(saved.data);
  if(receipt.success!==true || typeof receipt.alreadyPublished!=="boolean" || receipt.validationId!==context.validationId || receipt.modelId!==context.model.id || receipt.imageRecordId!==identity.recordId || !receipt.assetId)imageValidationFailure("IMAGE_PUBLICATION_SAVE_UNKNOWN","发布收据不完整，请读取原记录",503);
  await verifyAsset(receipt.assetId);
  return {success:true,alreadyPublished:receipt.alreadyPublished,modelId:context.model.id,imageRecordId:identity.recordId,assetId:String(receipt.assetId)};
}
