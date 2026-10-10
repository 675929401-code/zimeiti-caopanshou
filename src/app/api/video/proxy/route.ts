/**
 * 视频代理端点 — 解决上游视频 URL 在浏览器无法直接播放的问题
 *
 * 场景1：gaorui 等平台返回的 /v1/videos/{id}/content URL 需要 Authorization header，
 *        浏览器 <video> 标签无法发送此 header → 流式代理 + 注入 API key
 *
 * 场景2：CDN 直链（media.veo9.uk / vidgen.x.ai）可能被墙或无 CORS 头，
 *        浏览器 <video> 直接加载会网络异常 → 流式代理 + Range 透传
 *
 * 方案：前端始终使用 /api/video/proxy?id=xxx，后端根据 URL 类型决策：
 *       - 本地存储 / 对象存储直链 → 302 重定向（同源/有CORS，faststart 已处理）
 *       - CDN 直链 → 流式代理（解决被墙 + 无 CORS 问题，透传 Range 请求）
 *       - 需认证 URL → 流式代理 + 注入 API key
 *       支持 Range 请求转发，允许视频 seek。
 *
 * 安全：仅代理数据库中已完成的视频任务的 URL，禁止代理任意 URL。
 */
import { NextRequest, NextResponse } from "next/server";
import { isAutodlComfyuiHostedProtocol } from "@/lib/video-autodl-comfyui-workflow";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { isPersistentVideoUri, resolvePersistentVideoUri } from "@/lib/video-persistence";
import { trustedVideoProviderResultHostname } from "@/lib/video-provider-result-url";
import { authorizeVideoMediaRequest } from "@/lib/video-media-auth";
import { createVideoAccessTicket } from "@/lib/video-access-ticket";
import {
  authorizeMemberContentAccess,
  authorizeMemberContentDiscovery,
} from "@/lib/server/member-content-authority";
import { SafeFetchError, validateSafeUrl } from "@/lib/safe-fetch";
import { safeMediaFetch, trustedRelayHostnamesFromEnv, type SafeMediaAuthorization } from "@/lib/safe-media-fetch";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { markVideoUpstreamSourceExpired } from "@/lib/video-source-expiry";
import { inferVideoContentType } from "@/lib/video-content-type";
import {
  AUTODL_H3_SELFHOST_PROTOCOL,
  assertAutodlH3SelfhostModelBinding,
  fetchAutodlH3SelfhostResult,
  resolveAutodlH3SelfhostResultUrl,
} from "@/lib/autodl-h3-selfhost";

export const dynamic = "force-dynamic";

/** 已知 CDN 域名（上游直链，可能被墙/无 CORS 头，需流式代理） */
const CDN_DOMAINS = ["media.veo9.uk", "vidgen.x.ai", "ngrok"];

/** 对象存储域名（有 CORS 头 + faststart 已处理，可 302 重定向） */
const OBJECT_STORAGE_DOMAINS = ["coze-storage", "supabase.co"];

type CachedVideoTask = { task: Record<string, unknown>; cachedAt: number };
const taskCache = new Map<string, CachedVideoTask>();
const TASK_CACHE_TTL_MS = 5 * 60_000;
const videoContentTypeCache = new Map<string, string>();

// VIDEO_PROXY_RANGE_CONTRACT_BEGIN
type ParsedByteRange =
  | { kind: "closed"; start: number; end: number }
  | { kind: "open"; start: number }
  | { kind: "suffix"; length: number };

type VideoProxyHeaderContract =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string };

function parseSingleByteRange(value: string | null): ParsedByteRange | null {
  if (!value) return null;
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/iu.exec(value.trim());
  if (!match) return null;
  if (match[3]) {
    const length = Number(match[3]);
    return Number.isSafeInteger(length) && length > 0 ? { kind: "suffix", length } : null;
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (!match[2]) return { kind: "open", start };
  const end = Number(match[2]);
  return Number.isSafeInteger(end) && end >= start ? { kind: "closed", start, end } : null;
}

function buildVideoProxyResponseHeaders(input: {
  requestRange: string | null;
  upstreamStatus: number;
  upstreamContentRange: string | null;
  upstreamContentLength: string | null;
  upstreamAcceptRanges: string | null;
  contentType: string | null;
}): VideoProxyHeaderContract {
  const baseHeaders: Record<string, string> = {
    "Cache-Control": input.upstreamStatus === 416 ? "private, no-store" : "private, max-age=300",
    "Content-Disposition": "inline",
    "Referrer-Policy": "no-referrer",
  };

  if (input.upstreamStatus === 416) {
    if (!input.requestRange) return { ok: false, error: "上游无 Range 请求却返回 416" };
    const unsatisfied = /^bytes \*\/(\d+)$/iu.exec(input.upstreamContentRange || "");
    if (!unsatisfied || !Number.isSafeInteger(Number(unsatisfied[1]))) {
      return { ok: false, error: "视频源返回了错误的 416 Content-Range" };
    }
    baseHeaders["Accept-Ranges"] = "bytes";
    baseHeaders["Content-Range"] = `bytes */${Number(unsatisfied[1])}`;
    if (/^\d+$/u.test(input.upstreamContentLength || "")) {
      baseHeaders["Content-Length"] = String(Number(input.upstreamContentLength));
    }
    if (input.contentType) baseHeaders["Content-Type"] = input.contentType;
    return { ok: true, headers: baseHeaders };
  }

  if (input.upstreamStatus === 206) {
    const requested = parseSingleByteRange(input.requestRange);
    const satisfied = /^bytes (\d+)-(\d+)\/(\d+)$/iu.exec(input.upstreamContentRange || "");
    if (!requested || !satisfied) {
      return { ok: false, error: "视频源返回了不完整的 Range 响应" };
    }
    const start = Number(satisfied[1]);
    const end = Number(satisfied[2]);
    const total = Number(satisfied[3]);
    if (![start, end, total].every(Number.isSafeInteger) || total <= 0 || start > end || end >= total) {
      return { ok: false, error: "视频源返回了错误的 Content-Range" };
    }
    const matchesRequest = requested.kind === "closed"
      ? start === requested.start && end === Math.min(requested.end, total - 1)
      : requested.kind === "open"
        ? start === requested.start
        : end === total - 1 && end - start + 1 === Math.min(requested.length, total);
    if (!matchesRequest) return { ok: false, error: "视频源 Content-Range 与请求不匹配" };
    if (!input.contentType) return { ok: false, error: "视频源容器类型无法确认" };
    return {
      ok: true,
      headers: {
        ...baseHeaders,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Type": input.contentType,
      },
    };
  }

  if (input.upstreamStatus !== 200 || input.requestRange) {
    return { ok: false, error: input.requestRange ? "视频源忽略了 Range 请求" : "视频源响应状态无效" };
  }
  if (!input.contentType) return { ok: false, error: "视频源容器类型无法确认" };
  baseHeaders["Content-Type"] = input.contentType;
  if (/\bbytes\b/iu.test(input.upstreamAcceptRanges || "")) baseHeaders["Accept-Ranges"] = "bytes";
  if (/^\d+$/u.test(input.upstreamContentLength || "")) {
    baseHeaders["Content-Length"] = String(Number(input.upstreamContentLength));
  }
  return { ok: true, headers: baseHeaders };
}
// VIDEO_PROXY_RANGE_CONTRACT_END

async function getCompletedVideoTask(taskId: string, userId: string, isAdmin: boolean) {
  const cacheKey = `${isAdmin ? "admin" : userId}:${taskId}`;
  const cached = taskCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < TASK_CACHE_TTL_MS) return cached.task;

  const supabase = getSupabaseClient();
  const fields = "id, video_url, storage_url, provider_result_url, model_id, status, user_id, task_id_external, source_expired_at";
  let localQuery = supabase
    .from("video_tasks")
    .select(fields)
    .eq("id", taskId);
  if (!isAdmin) localQuery = localQuery.eq("user_id", userId);
  const { data: byLocal, error: localError } = await localQuery.maybeSingle();
  if (localError) throw localError;

  let task = byLocal as Record<string, unknown> | undefined;
  if (!task) {
    let externalQuery = supabase
      .from("video_tasks")
      .select(fields)
      .eq("task_id_external", taskId)
      .eq("status", "completed");
    if (!isAdmin) externalQuery = externalQuery.eq("user_id", userId);
    const { data: byExternal, error: externalError } = await externalQuery
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (externalError) throw externalError;
    task = byExternal?.[0] as Record<string, unknown> | undefined;
  }

  if (task?.status === "completed") {
    taskCache.set(cacheKey, { task, cachedAt: Date.now() });
    if (taskCache.size > 500) {
      const cutoff = Date.now() - TASK_CACHE_TTL_MS;
      for (const [key, value] of taskCache) {
        if (value.cachedAt < cutoff) taskCache.delete(key);
      }
    }
  }
  return task || null;
}

function clearCompletedVideoTaskCache(task: Record<string, unknown>, requestedTaskId: string) {
  const ids = new Set([requestedTaskId, String(task.id || ''), String(task.task_id_external || '')].filter(Boolean));
  for (const key of taskCache.keys()) {
    if ([...ids].some((id) => key.endsWith(`:${id}`))) taskCache.delete(key);
  }
}

async function peekStreamPrefix(body: ReadableStream<Uint8Array>, minimumBytes = 16) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (totalBytes < minimumBytes) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value?.byteLength) {
      chunks.push(result.value);
      totalBytes += result.value.byteLength;
    }
  }
  const prefix = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let replayIndex = 0;
  const replayBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (replayIndex < chunks.length) {
        controller.enqueue(chunks[replayIndex]);
        replayIndex += 1;
        return;
      }
      const result = await reader.read();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return { prefix, replayBody };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("id");
  const forceOrigin = searchParams.get("source") === "origin";

  if (!taskId) {
    return NextResponse.json({ error: "缺少 id 参数" }, { status: 400 });
  }

  // <video> 无法附带 Authorization，因此只接受短时、任务绑定的媒体票据。
  // 主登录令牌仅允许出现在 Header/Cookie 中，禁止进入 URL、历史和访问日志。
  const authorization = await authorizeVideoMediaRequest(request, taskId, "playback");
  if (!authorization.ok) return authorization.response;
  const identity = authorization.user;
  const currentUserId = identity.userId;
  const isAdmin = identity.role === "admin";

  try {
    // 1. 从数据库查询任务，获取 video_url / storage_url 和 model_id
    const supabase = getSupabaseClient();

    // 优先用 task_id_external（上游ID）查询，fallback 到本地 id
    let task = await getCompletedVideoTask(taskId, currentUserId, false);
    if (!task && isAdmin) {
      const discovery = await authorizeMemberContentDiscovery(
        request,
        identity,
        { operation: "member_video_playback_discovery" },
      );
      if (!discovery.ok) return discovery.response;
      task = await getCompletedVideoTask(taskId, currentUserId, true);
    }

    if (!task) {
      return NextResponse.json({ error: "任务不存在" }, { status: 404 });
    }

    const contentAccess = await authorizeMemberContentAccess(
      request,
      { userId: currentUserId, role: identity.role },
      String(task.user_id || ""),
      { operation: "member_video_playback" },
    );
    if (!contentAccess.ok) return contentAccess.response;

    if (task.status !== "completed") {
      return NextResponse.json({ error: "任务未完成" }, { status: 400 });
    }
    if (task.source_expired_at) {
      clearCompletedVideoTaskCache(task, taskId);
      return NextResponse.json({ error: "视频源已到期，请使用此前下载的文件" }, { status: 410 });
    }

    // 2. 确定最佳视频 URL：兼容既有对象存储；新任务直接代理上游结果。
    const storageUrl = task.storage_url as string | null;
    const providerResultUrl = task.provider_result_url as string | null;
    const directVideoUrl = task.video_url as string | null;
    
    let videoUrl = "";
    let canRedirect = false; // 是否可以302重定向（同源/有CORS的URL）
    let selectedFromStorage = false;
    let trustedPersistentStorageHostname = "";
    
    if (storageUrl && !forceOrigin && isPersistentVideoUri(storageUrl)) {
      videoUrl = await resolvePersistentVideoUri(storageUrl);
      canRedirect = true;
      selectedFromStorage = true;
      trustedPersistentStorageHostname = new URL(videoUrl).hostname;
    } else if (storageUrl && !forceOrigin) {
      if (storageUrl.startsWith("http") && OBJECT_STORAGE_DOMAINS.some(d => storageUrl.includes(d))) {
        // 对象存储URL（如Supabase Storage签名URL），有CORS+faststart → 可302重定向
        videoUrl = storageUrl;
        canRedirect = true;
        selectedFromStorage = true;
      } else if (storageUrl.startsWith("/api/video/storage/")) {
        // Server-local video files are retired. Old rows fall through to the
        // provider result and are never copied back onto the server disk.
        console.warn(`[视频代理] 已忽略旧本地存储地址，改用上游结果: taskId=${taskId}`);
      }
    }
    
    if (!videoUrl && (providerResultUrl || directVideoUrl)) {
      videoUrl = providerResultUrl || directVideoUrl || "";
      // CDN直链不设 canRedirect → 走流式代理（CDN可能被墙/无CORS）
    }
    
    if (!videoUrl) {
      return NextResponse.json({ error: "视频 URL 为空" }, { status: 404 });
    }

    // 自租 H3 结果通过管理员配置的精确回环 origin 取件；只允许签名 /v1/files 路径。
    // 其他供应商继续走原有公网 SSRF 防护，不能因为接入本地隧道而全局放开私网地址。
    const { data: model } = task.model_id
      ? await supabase
          .from("video_models")
          .select("provider, model_name, api_key, api_endpoint, protocol_type, api_protocol_config")
          .eq("id", task.model_id)
          .maybeSingle()
      : { data: null };
    const isAutodlH3Selfhost = model?.protocol_type === AUTODL_H3_SELFHOST_PROTOCOL;
    try {
      if (model) {
        assertAutodlH3SelfhostModelBinding({
          kind: "video",
          provider: model.provider,
          protocolType: model.protocol_type,
          modelName: model.model_name,
          apiEndpoint: model.api_endpoint,
          apiKey: model.api_key,
        });
      }
    } catch {
      return NextResponse.json({ error: "视频模型的渠道配置未通过安全校验" }, { status: 502 });
    }

    const isAutodlH3TemporarySource = isAutodlH3Selfhost && !selectedFromStorage;
    const isAutoDLComfy = isAutodlComfyuiHostedProtocol(model?.protocol_type);
    let trustedProviderResultHostname = "";
    if (!selectedFromStorage) {
      try {
        trustedProviderResultHostname = trustedVideoProviderResultHostname(videoUrl, {
          protocolType: model?.protocol_type,
          apiProtocolConfig: model?.api_protocol_config,
          apiEndpoint: model?.api_endpoint,
        });
      } catch {
        return NextResponse.json({ error: "上游视频结果地址未通过渠道安全校验" }, { status: 502 });
      }
    }
    const trustedMediaHostnames = [...new Set([
      ...trustedRelayHostnamesFromEnv(),
      trustedPersistentStorageHostname,
      trustedProviderResultHostname,
    ].filter(Boolean))];

    if (isAutodlH3TemporarySource) {
      try {
        videoUrl = resolveAutodlH3SelfhostResultUrl(videoUrl, String(model?.api_endpoint || ""));
      } catch {
        return NextResponse.json({ error: "AutoDL H3 自租视频地址未通过同源签名校验" }, { status: 502 });
      }
    } else {
      try {
        // 任务结果来自外部供应商。即使 URL 已入库，代理前仍要做 DNS 与私网地址复核，
        // 防止被攻陷的上游借视频回源访问本机、VPC 或云元数据地址。
        await validateSafeUrl(videoUrl, {
          trustedHostnames: trustedMediaHostnames,
        });
      } catch (urlError) {
        const code = urlError instanceof SafeFetchError ? urlError.code : "VIDEO_SOURCE_URL_INVALID";
        console.warn("[视频代理] 已拒绝不安全的视频源地址", { taskId, code });
        return NextResponse.json({ error: "视频源地址未通过安全校验" }, { status: 502 });
      }
    }

    // 3. URL 路由决策：
    //    - 本地存储 / 对象存储 → 302 重定向（同源，支持 Range，faststart 已处理）
    //    - CDN 直链 / 需认证 URL → 流式代理（解决被墙+无CORS+认证问题）
    //    - 截帧请求 → 始终流式代理（避免 canvas 跨域限制）
    const forCapture = searchParams.get("forCapture") === "1";
  if (canRedirect && !forCapture) {
    let redirectUrl = videoUrl;
    try {
      const parsed = new URL(videoUrl, request.nextUrl.origin);
      if (parsed.pathname.startsWith("/api/video/")) {
        const sameOriginUrl = new URL(`${parsed.pathname}${parsed.search}`, request.nextUrl.origin);
        const storageTaskId = parsed.pathname.startsWith("/api/video/storage/")
          ? decodeURIComponent(parsed.pathname.slice("/api/video/storage/".length))
          : taskId;
        const mediaTicket = await createVideoAccessTicket({
          taskId: storageTaskId,
          userId: contentAccess.deliveryIdentity.userId,
          role: contentAccess.deliveryIdentity.role,
          scope: "playback",
        });
        sameOriginUrl.searchParams.set("media_ticket", mediaTicket);
        redirectUrl = sameOriginUrl.toString();
      }
    } catch {}
    return NextResponse.redirect(redirectUrl, 302);
  }

    // 4. 读取任务所属模型凭据。凭据不会直接放入通用 headers；
    // safeMediaFetch 只会在媒体 URL 与模型 endpoint 完全同源时注入。
    const providerKey = !isAutodlH3Selfhost && model?.api_key ? resolveProviderSecret(model.api_key) : "";
    const providerAuthorization: SafeMediaAuthorization | null = !isAutodlH3Selfhost && providerKey && model?.api_endpoint
      ? { origin: String(model.api_endpoint), value: isAutoDLComfy ? providerKey : `Bearer ${providerKey}` }
      : null;

    // 5. 请求上游视频（转发 Range 请求）
    // 支持 CDN 不可达时自动 fallback 到 API /content 端点
    const rangeHeader = request.headers.get("range");
    
    let upstreamResp: Response | null = null;
    let usedFallback = false;
    let upstreamSourceUrl = videoUrl;
    let directExpiryStatus: 404 | 410 | null = null;
    let fallbackExpiryStatus: 404 | 410 | null = null;
    
    // 先真实探测供应商返回的原始地址。域名可达性会随机房和网络变化，不能永久硬编码跳过。
    try {
      const directHeaders: Record<string, string> = {
        "Accept": "video/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; CanvasVideoProxy/1.0)",
      };
      if (rangeHeader) directHeaders["Range"] = rangeHeader;
      const directResult = isAutodlH3TemporarySource
        ? await fetchAutodlH3SelfhostResult(videoUrl, String(model?.api_endpoint || ""), {
            headers: directHeaders,
            timeoutMs: 300_000,
          })
        : await safeMediaFetch(videoUrl, {
            headers: directHeaders,
            authorization: providerAuthorization,
            timeoutMs: 20_000,
            // 旧版持久对象存储兼容地址已由 resolvePersistentVideoUri 解析并在上方
            // 完成精确 hostname 校验。截首帧时必须把同一信任边界传入
            // 实际流式回源；否则 Clash/TUN 的 fake-IP DNS 会被 SSRF 层
            // 当作私网地址拒绝，浏览器可播放但封面生成会误报 404。
            trustedHostnames: trustedMediaHostnames,
          });
      upstreamResp = directResult.response;
      upstreamSourceUrl = directResult.finalUrl;
      if (!upstreamResp.ok && upstreamResp.status !== 206 && upstreamResp.status !== 416) {
        const directStatus = upstreamResp.status;
        directExpiryStatus = directStatus === 404 || directStatus === 410 ? directStatus : null;
        await upstreamResp.body?.cancel().catch(() => undefined);
        upstreamResp = null;
        console.warn(`[视频代理] 原始地址返回 ${directStatus}，准备尝试备用接口: taskId=${taskId}`);
      }
    } catch (fetchErr) {
      console.warn(`[视频代理] 原始地址不可达，准备尝试备用接口: taskId=${taskId}, error=`, fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
      upstreamResp = null;
    }
    
    // 尝试2: 原始结果地址不可达时，fallback 到供应商 /content 端点。
    // gaorui_video 的结果地址会随供应商存储集群变化；上方已经按协议白名单、
    // DNS 和私网规则完成了安全校验，因此不能再用一组过时的 CDN 域名阻断其
    // 受鉴权的 /content 取件。其他协议仍只保留既有 CDN 域名兜底，避免全局放行。
    const supportsProviderContentFallback = model?.protocol_type === "gaorui_video"
      || CDN_DOMAINS.some((domain) => videoUrl.includes(domain));
    const hasProviderContentFallback = Boolean(
      !isAutoDLComfy
      && !isAutodlH3Selfhost
      && supportsProviderContentFallback
      && model?.api_key
      && model?.api_endpoint
      && task.task_id_external,
    );
    if (!upstreamResp && hasProviderContentFallback) {
      if (model?.api_key && model?.api_endpoint && task.task_id_external) {
        // 构建 /content 端点 URL: {api_endpoint}/videos/{task_id}/content
        // 注意: api_endpoint 可能已包含 /v1 (如 https://gaorui.cc/v1)，不能重复追加
        const apiBase = (model.api_endpoint as string).replace(/\/+$/, "");
        const extTaskId = task.task_id_external as string;
        const contentUrl = `${apiBase}/videos/${extTaskId}/content`;
        
        console.log(`[视频代理] CDN不可达，fallback到/content端点: taskId=${taskId}`);
        
        try {
          const fallbackHeaders: Record<string, string> = {
            "Accept": "video/*,*/*;q=0.8",
          };
          if (rangeHeader) fallbackHeaders["Range"] = rangeHeader;
          const fallbackResult = await safeMediaFetch(contentUrl, {
            headers: fallbackHeaders,
            authorization: providerAuthorization,
            timeoutMs: 300_000,
            trustedHostnames: trustedMediaHostnames,
          });
          upstreamResp = fallbackResult.response;
          upstreamSourceUrl = fallbackResult.finalUrl;
          usedFallback = true;
          if (!upstreamResp.ok && [404, 410].includes(upstreamResp.status)) {
            fallbackExpiryStatus = upstreamResp.status as 404 | 410;
          }
        } catch (fallbackErr) {
          console.error(`[视频代理] /content端点也失败: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
          upstreamResp = null;
        }
      }
    }
    
    if (!upstreamResp) {
      const confirmedExpiryStatus = directExpiryStatus
        && (!hasProviderContentFallback || fallbackExpiryStatus)
        ? (fallbackExpiryStatus || directExpiryStatus)
        : null;
      if (confirmedExpiryStatus) {
        await markVideoUpstreamSourceExpired({
          taskId: String(task.id || taskId),
          userId: String(task.user_id || ''),
          httpStatus: confirmedExpiryStatus,
        });
        clearCompletedVideoTaskCache(task, taskId);
      }
      return NextResponse.json(
        { error: confirmedExpiryStatus ? "视频源已到期，请使用此前下载的文件" : "视频源暂时不可达，请稍后重试" },
        { status: confirmedExpiryStatus ? 410 : 502 }
      );
    }

    if (!upstreamResp.ok && upstreamResp.status !== 206 && upstreamResp.status !== 416) {
      const fallbackReturnedExpired = [404, 410].includes(upstreamResp.status)
        ? upstreamResp.status as 404 | 410
        : null;
      const confirmedExpiryStatus = fallbackReturnedExpired
        && directExpiryStatus
        ? fallbackReturnedExpired
        : (!hasProviderContentFallback && (fallbackReturnedExpired || directExpiryStatus));
      await upstreamResp.body?.cancel().catch(() => undefined);
      if (confirmedExpiryStatus) {
        await markVideoUpstreamSourceExpired({
          taskId: String(task.id || taskId),
          userId: String(task.user_id || ''),
          httpStatus: confirmedExpiryStatus,
        });
        clearCompletedVideoTaskCache(task, taskId);
      }
      console.error(`[视频代理] 上游返回 ${upstreamResp.status}${usedFallback ? '(fallback)' : ''}: taskId=${taskId}`);
      return NextResponse.json(
        { error: confirmedExpiryStatus ? "视频源已到期，请使用此前下载的文件" : `视频源返回 ${upstreamResp.status}` },
        { status: confirmedExpiryStatus ? 410 : upstreamResp.status >= 500 ? 502 : upstreamResp.status }
      );
    }

    if (upstreamResp.status === 416) {
      const contract = buildVideoProxyResponseHeaders({
        requestRange: rangeHeader,
        upstreamStatus: upstreamResp.status,
        upstreamContentRange: upstreamResp.headers.get("content-range"),
        upstreamContentLength: upstreamResp.headers.get("content-length"),
        upstreamAcceptRanges: upstreamResp.headers.get("accept-ranges"),
        contentType: upstreamResp.headers.get("content-type"),
      });
      if (!contract.ok) {
        await upstreamResp.body?.cancel().catch(() => undefined);
        return NextResponse.json({ error: contract.error }, { status: 502 });
      }
      return new NextResponse(upstreamResp.body, { status: 416, headers: contract.headers });
    }

    const upstreamContentType = String(upstreamResp.headers.get("content-type") || "").toLowerCase();
    if (/^(?:text\/html|application\/(?:json|problem\+json))/u.test(upstreamContentType)) {
      await upstreamResp.body?.cancel().catch(() => undefined);
      return NextResponse.json(
        { error: "视频源返回的不是可播放媒体" },
        { status: 502 },
      );
    }

    // 6. 流式转发给浏览器（保持上游的 Range 响应）。未知二进制必须
    // 通过容器魔数确认，不能一律伪装成 MP4；否则 nosniff 下会产生跨浏览器差异。
    const contentTypeCacheKey = `${String(task.id || taskId)}:${upstreamSourceUrl}`;
    let responseBody = upstreamResp.body;
    let contentType = inferVideoContentType({
      declaredContentType: upstreamResp.headers.get("content-type"),
      sourceUrl: upstreamSourceUrl,
      cachedContentType: videoContentTypeCache.get(contentTypeCacheKey),
    });
    const startsAtZero = !rangeHeader || /^bytes=0-/iu.test(rangeHeader);
    if (!contentType && responseBody && startsAtZero) {
      const peeked = await peekStreamPrefix(responseBody);
      responseBody = peeked.replayBody;
      contentType = inferVideoContentType({
        declaredContentType: upstreamResp.headers.get("content-type"),
        sourceUrl: upstreamSourceUrl,
        prefix: peeked.prefix,
      });
    }
    if (!contentType || !responseBody) {
      await responseBody?.cancel().catch(() => undefined);
      return NextResponse.json({ error: "视频源容器类型无法确认" }, { status: 502 });
    }
    videoContentTypeCache.set(contentTypeCacheKey, contentType);
    if (videoContentTypeCache.size > 500) videoContentTypeCache.delete(videoContentTypeCache.keys().next().value || "");
    const contract = buildVideoProxyResponseHeaders({
      requestRange: rangeHeader,
      upstreamStatus: upstreamResp.status,
      upstreamContentRange: upstreamResp.headers.get("content-range"),
      upstreamContentLength: upstreamResp.headers.get("content-length"),
      upstreamAcceptRanges: upstreamResp.headers.get("accept-ranges"),
      contentType,
    });
    if (!contract.ok) {
      await responseBody.cancel().catch(() => undefined);
      return NextResponse.json({ error: contract.error }, { status: 502 });
    }

    return new NextResponse(responseBody, {
      status: upstreamResp.status,
      headers: contract.headers,
    });
  } catch (e) {
    console.error("[视频代理] 异常:", e);
    return NextResponse.json({ error: "代理失败" }, { status: 500 });
  }
}
