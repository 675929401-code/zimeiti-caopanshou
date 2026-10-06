import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { UploadValidationError, validateUploadBuffer } from "@/lib/file-upload-security";
import {
  processLocalMedia,
  type LocalMediaAction,
  type LocalMediaInput,
  type SubtitleRegion,
} from "@/lib/local-media-processor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 220 * 1024 * 1024;
const ACTIONS = new Set<LocalMediaAction>([
  "trim", "concat", "mute", "extract-audio", "replace-audio", "subtitle-region", "gif",
]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/aac", "audio/webm", "audio/flac", "audio/x-flac"]);

function numberField(form: FormData, key: string) {
  const value = Number(form.get(key));
  return Number.isFinite(value) ? value : undefined;
}

async function validatedFile(file: File, allowedTypes: Set<string>): Promise<LocalMediaInput> {
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) throw new UploadValidationError("文件大小无效", "FILE_SIZE_INVALID");
  const bytes = Buffer.from(await file.arrayBuffer());
  const validated = validateUploadBuffer(bytes, file.type || "application/octet-stream");
  if (!allowedTypes.has(validated.contentType)) throw new UploadValidationError("媒体类型不受支持", "MEDIA_TYPE_INVALID");
  return { bytes, extension: validated.extension };
}

export async function POST(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const user = authorization.user;

    const contentType = request.headers.get("content-type") || "";
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (!contentType.includes("multipart/form-data")) return NextResponse.json({ error: "请使用文件表单提交" }, { status: 415 });
    if (!Number.isFinite(contentLength) || contentLength <= 0) return NextResponse.json({ error: "缺少有效的请求大小" }, { status: 411 });
    if (contentLength > MAX_TOTAL_BYTES + 2 * 1024 * 1024) return NextResponse.json({ error: "请求体过大" }, { status: 413 });

    const form = await request.formData();
    const action = String(form.get("action") || "") as LocalMediaAction;
    if (!ACTIONS.has(action)) return NextResponse.json({ error: "不支持的媒体操作" }, { status: 400 });

    const videoFiles = form.getAll("videos").filter((item): item is File => item instanceof File);
    if (!videoFiles.length || videoFiles.length > 8) return NextResponse.json({ error: "请选择 1 到 8 个视频" }, { status: 400 });
    const total = videoFiles.reduce((sum, item) => sum + item.size, 0);
    if (total > MAX_TOTAL_BYTES) return NextResponse.json({ error: "视频总大小超过 220MB" }, { status: 413 });
    const inputs = await Promise.all(videoFiles.map((file) => validatedFile(file, VIDEO_TYPES)));

    const audioFile = form.get("audio");
    const audio = audioFile instanceof File ? await validatedFile(audioFile, AUDIO_TYPES) : undefined;
    const subtitleRegion = String(form.get("subtitleRegion") || "bottom") as SubtitleRegion;
    if (!["bottom", "middle-bottom", "middle-top", "top"].includes(subtitleRegion)) {
      return NextResponse.json({ error: "字幕区域无效" }, { status: 400 });
    }

    const result = await processLocalMedia({
      action,
      inputs,
      audio,
      startSeconds: numberField(form, "startSeconds"),
      endSeconds: numberField(form, "endSeconds"),
      subtitleRegion,
    });

    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Length": String(result.bytes.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 415 });
    }
    console.error("[LocalMedia] processing failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: error instanceof Error ? error.message : "媒体处理失败" }, { status: 500 });
  }
}
