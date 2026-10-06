/**
 * 本地视频存储代理端点
 *
 * 当对象存储不可用时（如生产环境缺少配置），
 * 视频转存到 /tmp/video-storage/ 后通过此端点代理播放。
 * 支持 Range 请求，允许视频 seek。
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { authorizeVideoMediaRequest } from "@/lib/video-media-auth";
import {
  authorizeMemberContentAccess,
  authorizeMemberContentDiscovery,
} from "@/lib/server/member-content-authority";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { resolvePersistentVideoUri } from "@/lib/video-persistence";
import {
  createVideoAccessTicket,
  type VideoAccessIdentity,
} from "@/lib/video-access-ticket";

const LOCAL_VIDEO_DIR = "/tmp/video-storage";

async function redirectToOriginProxy(_req: NextRequest, taskId: string, identity: VideoAccessIdentity) {
  const params = new URLSearchParams({ id: taskId, source: "origin" });
  params.set("media_ticket", await createVideoAccessTicket({
    taskId,
    userId: identity.userId,
    role: identity.role,
    scope: "playback",
  }));
  // Keep the redirect same-origin without trusting Host/X-Forwarded-* input.
  // A relative Location is valid for HTTP redirects and cannot be turned into
  // an attacker-controlled absolute URL by a forged proxy header.
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: `/api/video/proxy?${params.toString()}`,
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Authorization",
    },
  });
}

function looksLikePlayableVideo(filePath: string, fileSize: number): boolean {
  if (fileSize < 1024) return false;
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(Math.min(32, fileSize));
    fs.readSync(fd, header, 0, header.length, 0);
    const ascii = header.toString("latin1");
    return ascii.includes("ftyp") || ascii.includes("webm") || header.includes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  } finally {
    fs.closeSync(fd);
  }
}

function streamFile(filePath: string, start: number, end: number) {
  return Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
}

async function canAccessVideoTask(req: NextRequest, taskId: string): Promise<VideoAccessIdentity | Response | null> {
  const authorization = await authorizeVideoMediaRequest(req, taskId, "playback");
  if (!authorization.ok) return authorization.response;
  const identity = authorization.user;

  const supabase = getSupabaseClient();
  const findOwner = async (allowCrossMember: boolean) => {
    let byLocalQuery = supabase
      .from("video_tasks")
      .select("user_id")
      .eq("id", taskId);
    if (!allowCrossMember) byLocalQuery = byLocalQuery.eq("user_id", identity.userId);
    const { data: byLocal, error: byLocalError } = await byLocalQuery.maybeSingle();
    if (byLocalError) throw byLocalError;
    const localOwnerId = String((byLocal as { user_id?: string } | null)?.user_id || "");
    if (localOwnerId) return localOwnerId;

    let byExternalQuery = supabase
      .from("video_tasks")
      .select("user_id")
      .eq("task_id_external", taskId);
    if (!allowCrossMember) byExternalQuery = byExternalQuery.eq("user_id", identity.userId);
    const { data: byExternal, error: byExternalError } = await byExternalQuery
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (byExternalError) throw byExternalError;
    return String(byExternal?.[0]?.user_id || "");
  };

  let ownerId: string;
  try {
    ownerId = await findOwner(false);
    if (!ownerId && identity.role === "admin") {
      const discovery = await authorizeMemberContentDiscovery(
        req,
        identity,
        { operation: "member_video_storage_discovery" },
      );
      if (!discovery.ok) return discovery.response;
      ownerId = await findOwner(true);
    }
  } catch {
    return NextResponse.json({ error: "视频权限暂时无法核验" }, { status: 503 });
  }

  if (!ownerId) return null;
  const contentAccess = await authorizeMemberContentAccess(
    req,
    identity,
    ownerId,
    { operation: "member_video_storage_playback" },
  );
  return contentAccess.ok ? contentAccess.deliveryIdentity : contentAccess.response;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;

  // 安全检查：防止路径遍历（允许 UUID 含连字符和点号）
  if (!/^[a-zA-Z0-9_.-]+$/.test(taskId)) {
    return NextResponse.json({ error: "无效的任务 ID" }, { status: 400 });
  }

  const identity = await canAccessVideoTask(req, taskId);
  if (identity instanceof Response) return identity;
  if (!identity) {
    return NextResponse.json({ error: "无权访问该视频" }, { status: 403 });
  }

  const filePath = path.join(LOCAL_VIDEO_DIR, `${taskId}.mp4`);

  if (!fs.existsSync(filePath)) {
    const supabase = getSupabaseClient();
    const storedByIdQuery = supabase
      .from("video_tasks")
      .select("storage_url")
      .eq("id", taskId);
    const { data: storedById, error: storedByIdError } = identity.role === "admin"
      ? await storedByIdQuery.maybeSingle()
      : await storedByIdQuery.eq("user_id", identity.userId).maybeSingle();
    if (storedByIdError) {
      return NextResponse.json({ error: "视频地址暂时无法读取" }, { status: 503 });
    }
    let storageUrl = (storedById as { storage_url?: string } | null)?.storage_url || "";
    if (!storageUrl) {
      const storedByExternalQuery = supabase
        .from("video_tasks")
        .select("storage_url")
        .eq("task_id_external", taskId)
        .order("completed_at", { ascending: false, nullsFirst: false })
        .limit(1);
      const { data: storedByExternal, error: storedByExternalError } = identity.role === "admin"
        ? await storedByExternalQuery
        : await storedByExternalQuery.eq("user_id", identity.userId);
      if (storedByExternalError) {
        return NextResponse.json({ error: "视频地址暂时无法读取" }, { status: 503 });
      }
      storageUrl = storedByExternal?.[0]?.storage_url || "";
    }
    if (storageUrl) {
      const signedUrl = await resolvePersistentVideoUri(storageUrl);
      return NextResponse.redirect(signedUrl, 302);
    }
    // 本地文件不存在（服务器重启清空/tmp等场景）→ 302重定向到proxy路由降级播放
    return await redirectToOriginProxy(req, taskId, identity);
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  if (!looksLikePlayableVideo(filePath, fileSize)) {
    console.warn(`[video-storage] local cache is not a playable video, fallback to origin: taskId=${taskId}, size=${fileSize}`);
    return await redirectToOriginProxy(req, taskId, identity);
  }

  // 处理 Range 请求（浏览器 <video> 标签 seek 时需要）
  const rangeHeader = req.headers.get("range");

  if (rangeHeader) {
    // 解析 Range: bytes=start-end
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      return NextResponse.json({ error: "无效的 Range 请求" }, { status: 400 });
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

    // 越界检查
    if (start >= fileSize || end >= fileSize || start > end) {
      return new NextResponse(null, {
        status: 416, // Range Not Satisfiable
        headers: {
          "Content-Range": `bytes */${fileSize}`,
        },
      });
    }

    const chunkSize = end - start + 1;
    return new NextResponse(streamFile(filePath, start, end), {
      status: 206, // Partial Content
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=300",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  // 无 Range 请求：返回完整文件
  return new NextResponse(streamFile(filePath, 0, fileSize - 1), {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=300",
      "Referrer-Policy": "no-referrer",
    },
  });
}
