import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders, verifyToken, type JWTPayload } from "@/lib/auth";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";
import {
  announcementPriorityWeight,
  isAnnouncementActive,
  normalizeAnnouncementDelivery,
  safeAnnouncementUrl,
  type AnnouncementDelivery,
  type AnnouncementRecord,
} from "@/lib/announcement-domain";
import {
  ANNOUNCEMENT_PRIVATE_HEADERS,
  ANNOUNCEMENT_SELECT,
  announcementBackendError,
  announcementRecordFromRow,
} from "@/lib/announcement-delivery-server";

async function getViewer(request: Request): Promise<JWTPayload | null> {
  const token = getTokenFromHeaders(request.headers);
  return token ? verifyToken(token) : null;
}

type AnnouncementWriteAuthorization = Extract<AdminCapabilityResult, { ok: true }>;
type AnnouncementWriteAction = "create" | "update" | "delete";

async function auditAnnouncementWrite(
  request: NextRequest,
  authorization: AnnouncementWriteAuthorization,
  action: AnnouncementWriteAction,
  result: "success" | "failure",
  reasonCode: string,
  announcementId?: string,
  metadata: Record<string, unknown> = {},
) {
  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    permissionKey: "announcements.manage",
    action: `announcement_${action}`,
    result,
    reasonCode,
    resource: announcementId ? `announcement:${announcementId}` : "announcements",
    request,
    metadata,
  });
}

async function authorizeAnnouncementWrite(request: NextRequest, action: AnnouncementWriteAction) {
  return authorizeAdminCapability(request, "announcements.manage", {
    operation: `announcement_${action}`,
    requireStepUp: true,
  });
}

async function announcementWriteFailure(
  request: NextRequest,
  authorization: AnnouncementWriteAuthorization,
  action: AnnouncementWriteAction,
  reasonCode: string,
  response: NextResponse,
  announcementId?: string,
) {
  await auditAnnouncementWrite(request, authorization, action, "failure", reasonCode, announcementId);
  return response;
}

function validateBody(body: Record<string, unknown>) {
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 255) : "";
  const content = typeof body.content === "string" ? body.content.trim().slice(0, 20_000) : "";
  if (!title || !content) return { error: "标题和内容不能为空" } as const;

  const isPinned = Boolean(body.is_pinned ?? body.isPinned);
  const delivery = normalizeAnnouncementDelivery(body as Partial<AnnouncementDelivery>, isPinned);
  const error = validateDelivery(delivery);
  if (error) return { error } as const;

  return {
    title,
    content,
    isPinned,
    imageUrl: safeAnnouncementUrl(body.image_url),
    linkUrl: safeAnnouncementUrl(body.link_url),
    linkText: typeof body.link_text === "string" ? body.link_text.trim().slice(0, 80) : "",
    delivery,
  } as const;
}

function validateDelivery(delivery: AnnouncementDelivery): string | null {
  if (delivery.status === "scheduled" && !delivery.publish_at) {
    return "定时公告必须设置发布时间";
  }
  if (
    delivery.publish_at && delivery.expires_at
    && new Date(delivery.expires_at).getTime() <= new Date(delivery.publish_at).getTime()
  ) {
    return "有效期结束时间必须晚于发布时间";
  }
  if (delivery.target_audience === "selected" && delivery.target_user_ids.length === 0) {
    return "指定用户公告至少需要一个用户 ID";
  }
  return null;
}

function deliveryColumns(delivery: AnnouncementDelivery) {
  return {
    priority: delivery.priority,
    status: delivery.status,
    summary: delivery.summary,
    publish_at: delivery.publish_at,
    expires_at: delivery.expires_at,
    target_audience: delivery.target_audience,
    target_user_ids: delivery.target_user_ids,
    frequency_hours: delivery.frequency_hours,
    max_impressions: delivery.max_impressions,
    require_ack: delivery.require_ack,
  };
}

export async function GET(request: NextRequest) {
  try {
    const client = getSupabaseClient();
    const adminMode = new URL(request.url).searchParams.get("admin") === "1";
    let viewer: JWTPayload | null;
    if (adminMode) {
      const authorization = await authorizeAdminCapability(request, "announcements.manage", {
        operation: "announcement_read",
        requireStepUp: false,
      });
      if (!authorization.ok) return authorization.response;
      viewer = authorization.actor;
    } else {
      viewer = await getViewer(request);
    }

    let query = client.from("announcements").select(ANNOUNCEMENT_SELECT);
    if (!adminMode) query = query.eq("is_active", true);
    const { data, error } = await query
      .order("is_pinned", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) return announcementBackendError(error, "获取公告失败");

    const announcements = (data || [])
      .map((row: Record<string, unknown>) => announcementRecordFromRow(row))
      .filter((announcement: AnnouncementRecord) => adminMode || isAnnouncementActive(announcement, viewer))
      .sort((a: AnnouncementRecord, b: AnnouncementRecord) => {
        const priority = announcementPriorityWeight(b.priority) - announcementPriorityWeight(a.priority);
        if (priority) return priority;
        if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

    return NextResponse.json({ announcements }, { headers: ANNOUNCEMENT_PRIVATE_HEADERS });
  } catch (error) {
    console.error("Failed to fetch announcements:", error);
    return announcementBackendError(error, "获取公告失败");
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAnnouncementWrite(request, "create");
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return announcementWriteFailure(
        request,
        authorization,
        "create",
        "ANNOUNCEMENT_REQUEST_INVALID",
        NextResponse.json({ error: "请求内容无效" }, { status: 400 }),
      );
    }
    const validated = validateBody(body);
    if ("error" in validated) {
      return announcementWriteFailure(
        request,
        authorization,
        "create",
        "ANNOUNCEMENT_VALIDATION_FAILED",
        NextResponse.json({ error: validated.error }, { status: 400 }),
      );
    }

    const client = getSupabaseClient();
    const isActive = validated.delivery.status === "published" || validated.delivery.status === "scheduled";
    const { data, error } = await client
      .from("announcements")
      .insert({
        title: validated.title,
        content: validated.content,
        is_pinned: validated.isPinned,
        is_active: isActive,
        image_url: validated.imageUrl,
        link_url: validated.linkUrl,
        link_text: validated.linkText,
        ...deliveryColumns(validated.delivery),
      })
      .select(ANNOUNCEMENT_SELECT)
      .single();
    if (error) {
      return announcementWriteFailure(
        request,
        authorization,
        "create",
        "ANNOUNCEMENT_CREATE_DB_FAILED",
        announcementBackendError(error, "创建公告失败"),
      );
    }

    const announcementId = String((data as Record<string, unknown>).id || "");
    await auditAnnouncementWrite(
      request,
      authorization,
      "create",
      "success",
      "ANNOUNCEMENT_CREATE_SUCCEEDED",
      announcementId,
      {
        status: validated.delivery.status,
        priority: validated.delivery.priority,
        targetAudience: validated.delivery.target_audience,
      },
    );
    return NextResponse.json({ success: true, announcement: announcementRecordFromRow(data) });
  } catch (error) {
    await auditAnnouncementWrite(
      request,
      authorization,
      "create",
      "failure",
      "ANNOUNCEMENT_CREATE_FAILED",
    );
    console.error("Failed to create announcement:", error);
    return announcementBackendError(error, "创建公告失败");
  }
}

export async function PUT(request: NextRequest) {
  const authorization = await authorizeAnnouncementWrite(request, "update");
  if (!authorization.ok) return authorization.response;
  let announcementId = "";
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return announcementWriteFailure(
        request,
        authorization,
        "update",
        "ANNOUNCEMENT_REQUEST_INVALID",
        NextResponse.json({ error: "请求内容无效" }, { status: 400 }),
      );
    }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    announcementId = id;
    if (!id) {
      return announcementWriteFailure(
        request,
        authorization,
        "update",
        "ANNOUNCEMENT_ID_REQUIRED",
        NextResponse.json({ error: "缺少公告ID" }, { status: 400 }),
      );
    }

    const client = getSupabaseClient();
    const { data: currentRow, error: currentError } = await client
      .from("announcements")
      .select(ANNOUNCEMENT_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (currentError) {
      return announcementWriteFailure(
        request,
        authorization,
        "update",
        "ANNOUNCEMENT_READ_FAILED",
        announcementBackendError(currentError, "读取公告失败"),
        id,
      );
    }
    if (!currentRow) {
      return announcementWriteFailure(
        request,
        authorization,
        "update",
        "ANNOUNCEMENT_NOT_FOUND",
        NextResponse.json({ error: "公告不存在" }, { status: 404 }),
        id,
      );
    }

    const current = announcementRecordFromRow(currentRow);
    const isPinned = body.is_pinned === undefined && body.isPinned === undefined
      ? current.is_pinned
      : Boolean(body.is_pinned ?? body.isPinned);
    const delivery = normalizeAnnouncementDelivery(
      { ...current, ...body } as Partial<AnnouncementDelivery>,
      isPinned,
    );
    const deliveryError = validateDelivery(delivery);
    if (deliveryError) {
      return announcementWriteFailure(
        request,
        authorization,
        "update",
        "ANNOUNCEMENT_VALIDATION_FAILED",
        NextResponse.json({ error: deliveryError }, { status: 400 }),
        id,
      );
    }

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      is_active: delivery.status === "published" || delivery.status === "scheduled",
      ...deliveryColumns(delivery),
    };
    if (typeof body.title === "string" && body.title.trim()) updateData.title = body.title.trim().slice(0, 255);
    if (typeof body.content === "string" && body.content.trim()) updateData.content = body.content.trim().slice(0, 20_000);
    if (body.is_pinned !== undefined || body.isPinned !== undefined) updateData.is_pinned = isPinned;
    if (body.image_url !== undefined) updateData.image_url = safeAnnouncementUrl(body.image_url);
    if (body.link_url !== undefined) updateData.link_url = safeAnnouncementUrl(body.link_url);
    if (body.link_text !== undefined) {
      updateData.link_text = typeof body.link_text === "string" ? body.link_text.trim().slice(0, 80) : "";
    }

    const { data, error } = await client
      .from("announcements")
      .update(updateData)
      .eq("id", id)
      .select(ANNOUNCEMENT_SELECT)
      .maybeSingle();
    if (error) {
      return announcementWriteFailure(
        request,
        authorization,
        "update",
        "ANNOUNCEMENT_UPDATE_DB_FAILED",
        announcementBackendError(error, "更新公告失败"),
        id,
      );
    }
    if (!data) {
      return announcementWriteFailure(
        request,
        authorization,
        "update",
        "ANNOUNCEMENT_NOT_FOUND",
        NextResponse.json({ error: "公告不存在" }, { status: 404 }),
        id,
      );
    }
    await auditAnnouncementWrite(
      request,
      authorization,
      "update",
      "success",
      "ANNOUNCEMENT_UPDATE_SUCCEEDED",
      id,
      {
        status: delivery.status,
        priority: delivery.priority,
        targetAudience: delivery.target_audience,
      },
    );
    return NextResponse.json({ success: true, announcement: announcementRecordFromRow(data) });
  } catch (error) {
    await auditAnnouncementWrite(
      request,
      authorization,
      "update",
      "failure",
      "ANNOUNCEMENT_UPDATE_FAILED",
      announcementId || undefined,
    );
    console.error("Failed to update announcement:", error);
    return announcementBackendError(error, "更新公告失败");
  }
}

export async function DELETE(request: NextRequest) {
  const authorization = await authorizeAnnouncementWrite(request, "delete");
  if (!authorization.ok) return authorization.response;
  let announcementId = "";
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim() || "";
    announcementId = id;
    if (!id) {
      return announcementWriteFailure(
        request,
        authorization,
        "delete",
        "ANNOUNCEMENT_ID_REQUIRED",
        NextResponse.json({ error: "缺少公告ID" }, { status: 400 }),
      );
    }

    const client = getSupabaseClient();
    // Selecting a migration-owned column makes missing schema a clear 503
    // instead of silently deleting through the pre-upgrade shape.
    const { data: current, error: readError } = await client
      .from("announcements")
      .select("id,push_revision")
      .eq("id", id)
      .maybeSingle();
    if (readError) {
      return announcementWriteFailure(
        request,
        authorization,
        "delete",
        "ANNOUNCEMENT_READ_FAILED",
        announcementBackendError(readError, "删除公告失败"),
        id,
      );
    }
    if (!current) {
      return announcementWriteFailure(
        request,
        authorization,
        "delete",
        "ANNOUNCEMENT_NOT_FOUND",
        NextResponse.json({ error: "公告不存在" }, { status: 404 }),
        id,
      );
    }

    const { error } = await client.from("announcements").delete().eq("id", id);
    if (error) {
      return announcementWriteFailure(
        request,
        authorization,
        "delete",
        "ANNOUNCEMENT_DELETE_DB_FAILED",
        announcementBackendError(error, "删除公告失败"),
        id,
      );
    }
    await auditAnnouncementWrite(
      request,
      authorization,
      "delete",
      "success",
      "ANNOUNCEMENT_DELETE_SUCCEEDED",
      id,
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    await auditAnnouncementWrite(
      request,
      authorization,
      "delete",
      "failure",
      "ANNOUNCEMENT_DELETE_FAILED",
      announcementId || undefined,
    );
    console.error("Failed to delete announcement:", error);
    return announcementBackendError(error, "删除公告失败");
  }
}
