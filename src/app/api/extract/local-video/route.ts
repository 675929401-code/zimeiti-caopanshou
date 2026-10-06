import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  isExtractLocalVideoHash,
  resolveExtractLocalVideoPath,
} from "@/lib/extract-local-video-cache";
import {
  verifyExtractLocalVideoSignature,
  verifyExtractTemporaryVideoSignature,
} from "@/lib/extract-download-signature";
import { parseSingleByteRange } from "@/lib/http-byte-range";

// 提供本地缓存的视频文件给 LLM/ASR 服务访问
// GET /api/extract/local-video?file=xxx

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const fileHash = searchParams.get("file") || "";
    const ownerId = searchParams.get("owner") || "";
    const downloadMode = searchParams.get("mode") === "download" ? "download" : "play";

    if (!isExtractLocalVideoHash(fileHash)) {
      return NextResponse.json({ error: "无效的文件标识" }, { status: 400 });
    }
    const temporaryOwnerDelivery = Boolean(ownerId);
    const signatureValid = temporaryOwnerDelivery
      ? verifyExtractTemporaryVideoSignature(
        fileHash,
        ownerId,
        searchParams.get("expires"),
        searchParams.get("sig"),
      )
      : verifyExtractLocalVideoSignature(
        fileHash,
        searchParams.get("expires"),
        searchParams.get("sig"),
      );
    if (!signatureValid) {
      return NextResponse.json({ error: "取件链接无效或已过期" }, { status: 403 });
    }

    const filePath = resolveExtractLocalVideoPath(fileHash);

    // 安全检查：确保文件存在且是视频文件
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }

    if (!fileStat.isFile() || fileStat.size < 1_000 || fileStat.size > 300 * 1024 * 1024) {
      return NextResponse.json({ error: "文件损坏" }, { status: 500 });
    }

    const range = parseSingleByteRange(request.headers.get("range"), fileStat.size);
    if (range === "invalid") {
      return new NextResponse(null, {
        status: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${fileStat.size}`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const body = Readable.toWeb(createReadStream(filePath, range || undefined)) as ReadableStream<Uint8Array>;
    const contentLength = range ? range.end - range.start + 1 : fileStat.size;

    return new NextResponse(body, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": contentLength.toString(),
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}` } : {}),
        "Content-Disposition": downloadMode === "download"
          ? "attachment; filename*=UTF-8''" + encodeURIComponent("extracted-video.mp4")
          : "inline; filename=extracted-video.mp4",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "读取本地视频失败";
    console.error("[Extract Local Video] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
