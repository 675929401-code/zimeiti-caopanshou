import { NextRequest, NextResponse } from "next/server";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

/* ── 视频通知结构体 ── */
export interface VideoNotificationItem {
  id: string;
  content: string;
  type: "info" | "warning" | "important"; // info=蓝/灰, warning=黄, important=红
  enabled: boolean;
  created_at: string;
}

/** 将旧格式 string[] 兼容转换为 VideoNotificationItem[] */
function migrateLegacy(raw: unknown[], scope: string): VideoNotificationItem[] {
  return raw.map((item, i) => {
    if (typeof item === "string") {
      return {
        id: `legacy-${scope}-${i}`,
        content: item,
        type: "info" as const,
        enabled: true,
        created_at: "",
      };
    }
    return item as VideoNotificationItem;
  });
}

type NotificationWriteAuthorization = Extract<AdminCapabilityResult, { ok: true }>;

async function auditNotificationWrite(
  request: NextRequest,
  authorization: NotificationWriteAuthorization,
  result: "success" | "failure",
  reasonCode: string,
  type = "video",
  metadata: Record<string, unknown> = {},
) {
  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    permissionKey: "announcements.manage",
    action: "video_notification_save",
    result,
    reasonCode,
    resource: `platform_settings:${type}_notifications`,
    request,
    metadata,
  });
}

// GET /api/notifications?type=video — 获取通知列表（含自动推荐）
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const type = String(searchParams.get("type") || searchParams.get("scope") || "video").trim().toLowerCase();
    const raw = searchParams.get("raw") === "1"; // 管理后台需要含禁用项的完整数据
    if (!/^[a-z0-9_-]{1,40}$/u.test(type)) {
      return NextResponse.json({ success: false, notifications: [], error: "通知范围无效" }, { status: 400 });
    }
    if (raw) {
      const authorization = await authorizeAdminCapability(request, "announcements.manage", {
        operation: "video_notification_read",
      });
      if (!authorization.ok) return authorization.response;
    }
    const settingKey = `${type}_notifications`;

    const supabase = getSupabaseAdminClient();

    // 并行获取通知和模型数据
    const [notifResult, modelsResult] = await Promise.all([
      supabase.from("platform_settings").select("setting_value").eq("setting_key", settingKey).maybeSingle(),
      supabase.from("video_models").select("id, name, is_active, is_hidden, total_requests, success_count, fail_count, last_success_at").eq("is_active", true).eq("is_hidden", false),
    ]);
    if (notifResult.error) throw notifResult.error;

    let adminNotifications: VideoNotificationItem[] = [];
    if (notifResult.data) {
      try {
        const parsed = JSON.parse(notifResult.data.setting_value);
        if (Array.isArray(parsed)) {
          adminNotifications = migrateLegacy(parsed, type);
        }
      } catch {
        adminNotifications = [];
      }
    }

    // 管理后台 raw 模式：返回全部（含禁用项），不含自动推荐
    if (raw) {
      return NextResponse.json({ success: true, notifications: adminNotifications });
    }

    // 只返回启用的通知
    const enabledAdmin = adminNotifications.filter((n) => n.enabled);

    // 自动推荐：基于模型成功率生成推荐信息
    const autoRecommendations: VideoNotificationItem[] = [];
    const models = modelsResult.error ? [] : modelsResult.data || [];
    if (modelsResult.error) {
      console.warn("[Notifications] model recommendations unavailable:", modelsResult.error.message);
    }

    if (models.length > 0 && type === "video") {
      const withStats = models
        .filter((m: Record<string, unknown>) => Number(m.total_requests) > 0)
        .map((m: Record<string, unknown>) => {
          const total = Number(m.total_requests) || 0;
          const success = Number(m.success_count) || 0;
          return { ...m, rate: Math.round((success / total) * 100) };
        })
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => (b.rate as number) - (a.rate as number));

      if (withStats.length > 0) {
        const best = withStats[0] as Record<string, unknown>;
        if ((best.rate as number) >= 80) {
          autoRecommendations.push({
            id: "auto-best",
            content: `推荐优先使用 ${best.name}（成功率${best.rate}%）`,
            type: "info",
            enabled: true,
            created_at: new Date().toISOString(),
          });
        }
      }

      const unstable = withStats.filter((m: Record<string, unknown>) => (m.rate as number) < 50 && Number(m.total_requests) >= 3);
      for (const m of unstable) {
        autoRecommendations.push({
          id: `auto-unstable-${(m as Record<string, unknown>).id}`,
          content: `${(m as Record<string, unknown>).name} 当前不稳定，成功率${(m as Record<string, unknown>).rate}%，建议换用其他模型`,
          type: "warning",
          enabled: true,
          created_at: new Date().toISOString(),
        });
      }
    }

    // 合并：管理员通知在前，自动推荐在后
    const allNotifications = [...enabledAdmin, ...autoRecommendations];

    return NextResponse.json({
      success: true,
      notifications: allNotifications,
      recommendationsAvailable: !modelsResult.error,
    });
  } catch (error) {
    console.error("[Notifications] Error:", error);
    return NextResponse.json(
      { success: false, notifications: [], error: "视频通知暂时无法读取" },
      { status: 503 },
    );
  }
}

async function saveNotifications(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "announcements.manage", {
    operation: "video_notification_save",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;

  let notifType = "video";
  try {
    const body = await request.json().catch(() => null) as {
      type?: string;
      scope?: string;
      notifications?: VideoNotificationItem[];
    } | null;
    if (!body) {
      await auditNotificationWrite(request, authorization, "failure", "NOTIFICATION_REQUEST_INVALID");
      return NextResponse.json({ error: "请求内容无效" }, { status: 400 });
    }
    const { type, scope, notifications } = body;

    notifType = String(type || scope || "video").trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/u.test(notifType) || !Array.isArray(notifications)) {
      await auditNotificationWrite(
        request,
        authorization,
        "failure",
        "NOTIFICATION_VALIDATION_FAILED",
        notifType || "video",
      );
      return NextResponse.json({ error: "参数错误" }, { status: 400 });
    }

    const settingKey = `${notifType}_notifications`;
    const supabase = getSupabaseAdminClient();

    const { data: existing } = await supabase
      .from("platform_settings")
      .select("id")
      .eq("setting_key", settingKey)
      .single();

    let error;
    if (existing) {
      ({ error } = await supabase
        .from("platform_settings")
        .update({ setting_value: JSON.stringify(notifications), updated_at: new Date().toISOString() })
        .eq("setting_key", settingKey));
    } else {
      ({ error } = await supabase
        .from("platform_settings")
        .insert({ id: settingKey, setting_key: settingKey, setting_value: JSON.stringify(notifications) }));
    }

    if (error) {
      console.error("[Notifications] DB error:", error);
      await auditNotificationWrite(
        request,
        authorization,
        "failure",
        "NOTIFICATION_SAVE_DB_FAILED",
        notifType,
        { count: notifications.length },
      );
      return NextResponse.json({ error: "保存失败" }, { status: 500 });
    }

    await auditNotificationWrite(
      request,
      authorization,
      "success",
      "NOTIFICATION_SAVE_SUCCEEDED",
      notifType,
      {
        count: notifications.length,
        enabledCount: notifications.filter((item) => item?.enabled === true).length,
      },
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    await auditNotificationWrite(
      request,
      authorization,
      "failure",
      "NOTIFICATION_SAVE_FAILED",
      notifType,
    );
    console.error("[Notifications] Save error:", error);
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}

// POST /api/notifications — 保存通知列表（管理员）
export async function POST(request: NextRequest) {
  return saveNotifications(request);
}

// PUT /api/notifications — 兼容旧调用（管理员保存）
export async function PUT(request: NextRequest) {
  return saveNotifications(request);
}
