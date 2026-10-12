import { NextResponse } from "next/server";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { getTokenFromHeaders } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { ImageAdminValidationError, type ImageValidationProof } from "@/lib/image-admin-validation";
import { publishValidatedImageModel } from "@/lib/image-model-publication";
import {publishImageModelReceipt,IMAGE_RECEIPT_PUBLICATION_INTENT,readBoundedImagePublicationBody} from "@/lib/image-model-receipt-publication";
import { assertPublishedModelPoolEntry } from "@/lib/server/platform-configuration-compatibility";
import { PlatformConfigurationError } from "@/lib/server/platform-configuration-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Staged target: /api/admin/cover-models/validation/publish. Never generates. */
export async function POST(request: Request) {
  try {
    const authorization = await authorizeAdminToken(getTokenFromHeaders(request.headers));
    if (!authorization.ok) return NextResponse.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });
    const multipart=request.headers.get("content-type")?.startsWith("multipart/form-data")===true;
    const metadata=request.headers.get("x-image-publication-request");
    if(multipart && (!metadata || metadata.length>8192))return NextResponse.json({error:"发布存证请求身份不完整",code:"IMAGE_PUBLICATION_INPUT_INVALID"},{status:400,headers:{"Cache-Control":"no-store"}});
    const body = (multipart?JSON.parse(decodeURIComponent(metadata!)):JSON.parse((await readBoundedImagePublicationBody(request,16384)).toString("utf8"))) as { modelId?: string; imageRecordId?: string; proof?: ImageValidationProof; confirmation?: unknown;intent?:unknown };
    await assertPublishedModelPoolEntry("cover_models", String(body.modelId || ""));
    if(body.intent!==undefined && body.intent!==IMAGE_RECEIPT_PUBLICATION_INTENT)return NextResponse.json({error:"发布意图无效",code:"IMAGE_PUBLICATION_INPUT_INVALID"},{status:400,headers:{"Cache-Control":"no-store"}});
    const result = body.intent===IMAGE_RECEIPT_PUBLICATION_INTENT ? await publishImageModelReceipt({db:getSupabaseAdminClient(),authorization,modelId:String(body.modelId||""),imageRecordId:String(body.imageRecordId||""),proof:body.proof as ImageValidationProof,intent:body.intent,
      ...(multipart?{readInline:async()=>{
        const bytes=await readBoundedImagePublicationBody(request,30*1024*1024+65536);
        const form=await new Response(new Uint8Array(bytes),{headers:{"Content-Type":request.headers.get("content-type")!}}).formData(); const file=form.get("file");
        if(!(file instanceof File) || [...form.keys()].some(key=>key!=="file") || form.getAll("file").length!==1 || file.size<=0 || file.size>30*1024*1024)throw new ImageAdminValidationError("IMAGE_PUBLICATION_BYTES_INVALID","请选择 30MB 以内的原验证图片",413);
        return {buffer:Buffer.from(await file.arrayBuffer()),contentType:file.type};
      }}:{})}) : await publishValidatedImageModel({ db: getSupabaseAdminClient(), authorization,
      modelId: String(body.modelId || ""), imageRecordId: String(body.imageRecordId || ""),
      proof: body.proof as ImageValidationProof, confirmation: body.confirmation });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformConfigurationError) {
      return NextResponse.json({ error: error.message, code: error.code, published: false }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const known = error instanceof ImageAdminValidationError;
    return NextResponse.json({ error: known ? error.message : "生图模型发布暂未确认，请保留原证明查询", code: known ? error.code : "IMAGE_PUBLICATION_UNKNOWN" },
      { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
