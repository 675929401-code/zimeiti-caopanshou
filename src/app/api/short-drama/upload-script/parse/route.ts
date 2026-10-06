import { NextRequest, NextResponse } from "next/server";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";
import {
  parseUploadedScriptFile,
  UploadScriptError,
} from "@/lib/short-drama/upload-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await authorizeShortDramaRequest(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new UploadScriptError("FILE_REQUIRED", "请选择剧本文件");
    }
    const parsed = parseUploadedScriptFile({
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json({ ok: true, file: parsed }, { status: 200 });
  } catch (error) {
    if (error instanceof UploadScriptError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
    }
    const status = Number((error as { status?: unknown } | null)?.status || 500);
    const code = String((error as { code?: unknown } | null)?.code || "UPLOAD_PARSE_FAILED");
    const message = error instanceof Error ? error.message : "剧本读取失败";
    return NextResponse.json({ ok: false, code, error: message }, { status });
  }
}
