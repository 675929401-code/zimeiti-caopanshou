import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { isPersistentVideoUri, resolvePersistentVideoUri } from "@/lib/video-persistence";
import { trustedVideoProviderResultHostname } from "@/lib/video-provider-result-url";
import { authorizeVideoMediaRequest } from "@/lib/video-media-auth";
import {
  authorizeMemberContentAccess,
  authorizeMemberContentDiscovery,
} from "@/lib/server/member-content-authority";
import {
  safeMediaFetch,
  trustedRelayHostnamesFromEnv,
  type SafeMediaAuthorization,
} from "@/lib/safe-media-fetch";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { isAutodlComfyuiHostedProtocol } from "@/lib/video-autodl-comfyui-workflow";
import { markVideoUpstreamSourceExpired } from "@/lib/video-source-expiry";
import {
  AUTODL_H3_SELFHOST_GATEWAY_ORIGIN,
  AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
  assertAutodlH3SelfhostModelBinding,
  fetchAutodlH3SelfhostResult,
  isAutodlH3Selfhost,
  redactAutodlH3SelfhostResultUrl,
} from "@/lib/autodl-h3-selfhost";

export const dynamic = "force-dynamic";

function isUpstreamErrorDocument(contentType: string) {
  return /^(?:text\/html|application\/(?:json|problem\+json))(?:;|$)/iu.test(contentType.trim());
}

/**
 * GET /api/video/proxy-download?taskId=...&name=...&media_ticket=...
 * 服务端代理下载视频，绕过跨域限制
 *
 * 支持：
 * 1. 下载必须绑定数据库中的已完成任务，拒绝任意 URL 代理
 * 2. 需认证 URL（含 /v1/videos/）→ 通过 taskId 查找模型配置，注入 API key 代理下载
 * 3. 优先使用 storage_url（本地文件），fallback 到 video_url
 * 4. CDN 不可达时自动降级到 /content 端点（与 proxy 路由行为一致）
 */
export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name") || "video.mp4";
  const taskId = request.nextUrl.searchParams.get("taskId") || request.nextUrl.searchParams.get("id");
  if (!taskId) {
    return NextResponse.json({ error: "下载必须绑定已完成的视频任务" }, { status: 400 });
  }

  const authorization = await authorizeVideoMediaRequest(request, taskId, "download");
  if (!authorization.ok) return authorization.response;
  const identity = authorization.user;
  const currentUserId = identity.userId;
  const isAdmin = identity.role === "admin";

  // 如果没有 url，尝试通过 taskId 从数据库查找
  let effectiveUrl: string | null = null;
  let selectedFromStorage = false;
  let trustedPersistentStorageHostname = "";
  let trustedProviderResultHostname = "";
  let taskInternalId = "";
  let taskOwnerId = "";
  // 降级 /content 端点所需信息
  let fallbackInfo: { apiKey: string; apiEndpoint: string; taskIdExternal: string; protocolType: string } | null = null;

  if (taskId) {
    try {
      const supabase = getSupabaseClient();

      const taskFields = "id, video_url, storage_url, provider_result_url, model_id, user_id, task_id_external, status, source_expired_at";
      const readTask = async (allowCrossMember: boolean) => {
        let localQuery = supabase
          .from("video_tasks")
          .select(taskFields)
          .eq("id", taskId);
        if (!allowCrossMember) localQuery = localQuery.eq("user_id", currentUserId);
        const { data: byLocal, error: localError } = await localQuery.maybeSingle();
        if (localError) throw localError;
        if (byLocal) return byLocal as Record<string, unknown>;

        let externalQuery = supabase
          .from("video_tasks")
          .select(taskFields)
          .eq("task_id_external", taskId);
        if (!allowCrossMember) externalQuery = externalQuery.eq("user_id", currentUserId);
        const { data: byExternal, error: externalError } = await externalQuery
          .order("created_at", { ascending: false })
          .limit(1);
        if (externalError) throw externalError;
        return (byExternal?.[0] as Record<string, unknown> | undefined) || null;
      };

      // First search only within the caller's own tasks. An administrator must
      // pass the capability and step-up gate before any cross-member lookup, so
      // 403/404 differences cannot be used to probe whether another task exists.
      let task = await readTask(false);
      if (!task && isAdmin) {
        const discovery = await authorizeMemberContentDiscovery(
          request,
          identity,
          { requireStepUp: true, operation: "member_video_download_discovery" },
        );
        if (!discovery.ok) return discovery.response;
        task = await readTask(true);
      }

      if (task) {
        const contentAccess = await authorizeMemberContentAccess(
          request,
          { userId: currentUserId, role: identity.role },
          String(task.user_id || ""),
          { requireStepUp: true, operation: "member_video_download" },
        );
        if (!contentAccess.ok) return contentAccess.response;
        if (task.status !== "completed") {
          return NextResponse.json({ error: "任务尚未完成" }, { status: 409 });
        }
        if (task.source_expired_at) {
          return NextResponse.json({ error: "视频源已到期，请使用此前下载的文件" }, { status: 410 });
        }
        taskInternalId = String(task.id || taskId);
        taskOwnerId = String(task.user_id || "");

        const storageUrl = task.storage_url as string | null;
        const providerResultUrl = task.provider_result_url as string | null;
        const videoUrl = task.video_url as string | null;
        const directResultUrl = providerResultUrl || videoUrl;

        // storage_url 优先，但需验证本地文件是否真实存在
        // 本地存储路径如 /api/video/storage/xxx → 检查对应文件
        if (storageUrl) {
          if (isPersistentVideoUri(storageUrl)) {
            effectiveUrl = await resolvePersistentVideoUri(storageUrl);
            selectedFromStorage = true;
            trustedPersistentStorageHostname = new URL(effectiveUrl).hostname;
          } else if (storageUrl.startsWith("/api/video/storage/")) {
            // Server-local video files are no longer a delivery source. Old
            // rows fall back to the provider URL and are never recreated.
            effectiveUrl = directResultUrl || null;
          } else if (storageUrl.startsWith("http")) {
            // 对象存储 URL，直接使用
            effectiveUrl = storageUrl;
            selectedFromStorage = true;
          } else if (storageUrl.startsWith("/")) {
            // 其他相对路径（如 Supabase Storage 路径），构建完整 URL
            const domain = process.env.COZE_PROJECT_DOMAIN_DEFAULT || "";
            effectiveUrl = `${domain}${storageUrl}`;
            selectedFromStorage = true;
          } else {
            effectiveUrl = directResultUrl || storageUrl;
          }
        } else {
          effectiveUrl = directResultUrl;
        }

        // 获取模型 API key + api_endpoint（降级 /content 端点需要）
        if (task.model_id) {
          const { data: model, error: modelError } = await supabase
            .from("video_models")
            .select("provider, model_name, api_key, api_endpoint, protocol_type, api_protocol_config")
            .eq("id", task.model_id)
            .maybeSingle();
          if (modelError) throw modelError;
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
          const protocolType = String(model?.protocol_type || "");
          if (!selectedFromStorage && effectiveUrl) {
            trustedProviderResultHostname = trustedVideoProviderResultHostname(effectiveUrl, {
              protocolType,
              apiProtocolConfig: model?.api_protocol_config,
              apiEndpoint: model?.api_endpoint,
            });
          }
          if (model?.api_endpoint && task.task_id_external && (isAutodlH3Selfhost(protocolType) || model.api_key)) {
            fallbackInfo = {
              apiKey: isAutodlH3Selfhost(protocolType) ? "" : resolveProviderSecret(model.api_key),
              apiEndpoint: model.api_endpoint as string,
              taskIdExternal: task.task_id_external as string,
              protocolType,
            };
          }
        }
      }
    } catch {
      return NextResponse.json({ error: "视频任务暂时无法读取" }, { status: 503 });
    }
  }

  if (!effectiveUrl) {
    return NextResponse.json({ error: "任务没有可下载的视频" }, { status: 404 });
  }

  const trustedMediaHostnames = [...new Set([
    ...trustedRelayHostnamesFromEnv(),
    trustedPersistentStorageHostname,
    trustedProviderResultHostname,
  ].filter(Boolean))];

  if (!fallbackInfo && !selectedFromStorage && effectiveUrl) {
    try {
      if (new URL(effectiveUrl).origin === AUTODL_H3_SELFHOST_GATEWAY_ORIGIN) {
        fallbackInfo = {
          apiKey: "",
          apiEndpoint: AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
          taskIdExternal: taskId,
          protocolType: "autodl_h3_selfhost",
        };
      }
    } catch {
      // Invalid URLs are rejected by the normal safe download path below.
    }
  }

  const isAutodlH3TemporaryFallback = Boolean(
    fallbackInfo
    && isAutodlH3Selfhost(fallbackInfo.protocolType)
    && !selectedFromStorage,
  );

  if (isAutodlH3TemporaryFallback && fallbackInfo) {
    const redactedUrl = redactAutodlH3SelfhostResultUrl(effectiveUrl, fallbackInfo.apiEndpoint);
    try {
      const { response } = await fetchAutodlH3SelfhostResult(effectiveUrl, fallbackInfo.apiEndpoint, {
        timeoutMs: 300_000,
      });
      if (!response.ok) {
        const expiredStatus = [404, 410].includes(response.status)
          ? response.status as 404 | 410
          : null;
        await response.body?.cancel().catch(() => undefined);
        console.warn("[下载代理] AutoDL H3 临时取件失败", {
          taskId,
          sourceUrl: redactedUrl,
          status: response.status,
        });
        if (expiredStatus && taskInternalId && taskOwnerId) {
          await markVideoUpstreamSourceExpired({ taskId: taskInternalId, userId: taskOwnerId, httpStatus: expiredStatus });
        }
        return NextResponse.json(
          { error: expiredStatus ? "视频源已到期，请使用此前下载的文件" : "H3 临时结果下载失败" },
          { status: expiredStatus ? 410 : 502 },
        );
      }
      const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "video/mp4" || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        console.warn("[下载代理] AutoDL H3 临时取件类型无效", {
          taskId,
          sourceUrl: redactedUrl,
          contentType: contentType || "missing",
        });
        return NextResponse.json({ error: "H3 临时结果类型无效" }, { status: 502 });
      }
      return new NextResponse(response.body, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
          "Cache-Control": "private, no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error || "unknown error"))
        .replace(/https?:\/\/\S+/giu, "[redacted-url]")
        .slice(0, 500);
      console.error("[下载代理] AutoDL H3 临时取件异常", {
        taskId,
        sourceUrl: redactedUrl,
        error: message,
      });
      return NextResponse.json({ error: "H3 临时结果下载失败" }, { status: 502 });
    }
  }

  let directExpiryStatus: 404 | 410 | null = null;
  let fallbackExpiryStatus: 404 | 410 | null = null;

  // --- 下载辅助函数 ---
  const downloadFromUrl = async (
    downloadUrl: string,
    source: "direct" | "fallback",
    authorization?: SafeMediaAuthorization | null,
  ): Promise<NextResponse> => {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (compatible; VideoProxy/1.0)",
      "Accept": "video/*,*/*;q=0.8",
    };
    const { response } = await safeMediaFetch(downloadUrl, {
      headers,
      authorization,
      timeoutMs: 300_000,
      trustedHostnames: trustedMediaHostnames,
    });

    if (!response.ok) {
      if ([404, 410].includes(response.status)) {
        if (source === "fallback") fallbackExpiryStatus = response.status as 404 | 410;
        else directExpiryStatus = response.status as 404 | 410;
      }
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`上游返回 ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "video/mp4";
    const body = response.body;

    if (isUpstreamErrorDocument(contentType)) {
      await body?.cancel().catch(() => undefined);
      throw new Error("上游返回的不是视频文件");
    }

    if (!body) {
      throw new Error("上游无响应体");
    }

    // 流式代理，避免大文件全部缓冲到内存
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
        "Cache-Control": "private, max-age=300",
        "Referrer-Policy": "no-referrer",
      },
    });
  };

  try {
    // 判断是否需要 API key 认证（/content 端点需要）
    const providerAuthorization: SafeMediaAuthorization | null = fallbackInfo && !isAutodlH3Selfhost(fallbackInfo.protocolType)
      ? {
          origin: fallbackInfo.apiEndpoint,
          value: isAutodlComfyuiHostedProtocol(fallbackInfo.protocolType)
            ? fallbackInfo.apiKey
            : `Bearer ${fallbackInfo.apiKey}`,
        }
      : null;

    // 先尝试供应商真实返回的地址；网络可达性不能用永久域名黑名单判断。
    try {
      const quickHeaders: Record<string, string> = {
        "Accept": "video/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; CanvasVideoProxy/1.0)",
      };
      const { response: cdnResponse } = await safeMediaFetch(effectiveUrl, {
        headers: quickHeaders,
        authorization: providerAuthorization,
        timeoutMs: 30_000,
        trustedHostnames: trustedMediaHostnames,
      });

      if (cdnResponse.ok) {
        const contentType = cdnResponse.headers.get("content-type") || "video/mp4";
        const body = cdnResponse.body;
        if (body && !isUpstreamErrorDocument(contentType)) {
          return new NextResponse(body, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
              "Cache-Control": "private, max-age=300",
              "Referrer-Policy": "no-referrer",
            },
          });
        }
      }
      if ([404, 410].includes(cdnResponse.status)) directExpiryStatus = cdnResponse.status as 404 | 410;
      await cdnResponse.body?.cancel().catch(() => undefined);
      console.warn(`[下载代理] 原始地址返回 ${cdnResponse.status}，尝试备用接口: taskId=${taskId}`);
    } catch (cdnErr) {
      console.warn(`[下载代理] 原始地址不可达，尝试备用接口: taskId=${taskId}, error=${cdnErr instanceof Error ? cdnErr.message : String(cdnErr)}`);
    }

    // 尝试2: 原始地址不可达时，降级到 /content 端点（与 proxy 路由行为一致）
    if (
      fallbackInfo
      && !isAutodlComfyuiHostedProtocol(fallbackInfo.protocolType)
      && !isAutodlH3Selfhost(fallbackInfo.protocolType)
    ) {
      const apiBase = fallbackInfo.apiEndpoint.replace(/\/+$/, "");
      // api_endpoint 可能已包含 /v1（如 https://gaorui.cc/v1），不能重复追加
      const contentUrl = `${apiBase}/videos/${fallbackInfo.taskIdExternal}/content`;

      console.log(`[下载代理] 降级到 /content 端点: taskId=${taskId}`);

      try {
        return await downloadFromUrl(contentUrl, "fallback", providerAuthorization);
      } catch (fallbackErr) {
        console.error(`[下载代理] /content 端点也失败: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      }
    }

    // 尝试3: 最后兜底 — 用长超时重试原始 URL（适用于大文件慢速下载）
    try {
      return await downloadFromUrl(effectiveUrl, "direct", providerAuthorization);
    } catch (finalErr) {
      console.warn(`[下载代理] 最终取件失败: taskId=${taskId}, error=${finalErr instanceof Error ? finalErr.message : String(finalErr)}`);
      const fallbackSupported = Boolean(
        fallbackInfo
        && !isAutodlComfyuiHostedProtocol(fallbackInfo.protocolType)
        && !isAutodlH3Selfhost(fallbackInfo.protocolType),
      );
      const confirmedExpiryStatus = directExpiryStatus
        && (!fallbackSupported || fallbackExpiryStatus)
        ? (fallbackExpiryStatus || directExpiryStatus)
        : null;
      if (confirmedExpiryStatus && taskInternalId && taskOwnerId) {
        await markVideoUpstreamSourceExpired({
          taskId: taskInternalId,
          userId: taskOwnerId,
          httpStatus: confirmedExpiryStatus,
        });
      }
      return NextResponse.json(
        { error: confirmedExpiryStatus ? "视频源已到期，请使用此前下载的文件" : "视频源暂时不可达，请稍后重试" },
        { status: confirmedExpiryStatus ? 410 : 502 },
      );
    }
  } catch (err) {
    console.warn(`[下载代理] 下载异常: taskId=${taskId}, error=${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "视频暂时无法下载" }, { status: 502 });
  }
}
