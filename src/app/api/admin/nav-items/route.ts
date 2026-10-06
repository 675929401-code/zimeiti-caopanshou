import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { visibleAdminNavigationRows } from "@/lib/admin-agent-catalog-visibility";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

async function authorizeNavigationMutation(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, "agents.manage", {
    operation,
    requireStepUp: true,
  });
}

async function authorizeInternalNavigationMutation(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, "internal_tools.manage", {
    operation,
    requireStepUp: true,
  });
}

// GET - 获取所有导航项
export async function GET(request: NextRequest) {
  try {
    const listingAccess = await authorizeAdminCapability(request, "agents.view", {
      operation: "agent_navigation_read",
      requireStepUp: false,
    });
    if (!listingAccess.ok) return listingAccess.response;

    const includeInternal = request.nextUrl.searchParams.get("include_internal") === "1";
    if (includeInternal) {
      const internalAccess = await authorizeAdminCapability(request, "internal_tools.manage", {
        operation: "internal_agent_navigation_read",
        requireStepUp: true,
      });
      if (!internalAccess.ok) return internalAccess.response;
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from("nav_items")
      .select("id,name,icon,icon_type,icon_image,description,status,sort_order,is_active")
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[nav-items] GET error:", error);
      return NextResponse.json({ error: "获取导航项失败" }, { status: 500 });
    }
    return NextResponse.json(
      { navItems: visibleAdminNavigationRows(data || [], includeInternal) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    console.error("[nav-items] GET exception:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// POST - 添加导航项
export async function POST(request: NextRequest) {
  try {
    const managementAccess = await authorizeNavigationMutation(request, "agent_navigation_create");
    if (!managementAccess.ok) return managementAccess.response;

    const body = await request.json();
    const { name, icon, icon_type, icon_image, description, status, sort_order } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "导航项名称不能为空" }, { status: 400 });
    }
    if (status === "hidden") {
      const internalAccess = await authorizeInternalNavigationMutation(request, "internal_agent_navigation_create");
      if (!internalAccess.ok) return internalAccess.response;
    }

    const client = getSupabaseClient();

    // 获取最大排序号
    const { data: maxSort } = await client
      .from("nav_items")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1);

    const nextSort = sort_order ?? ((maxSort?.[0]?.sort_order ?? 0) + 1);

    const { data, error } = await client
      .from("nav_items")
      .insert({
        name: name.trim(),
        icon: icon || "CircleDot",
        icon_type: icon_type || "lucide",
        icon_image: icon_image || "",
        description: description || "",
        status: status || "developing",
        sort_order: nextSort,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error("[nav-items] POST error:", error);
      return NextResponse.json({ error: "添加导航项失败" }, { status: 500 });
    }
    return NextResponse.json({ navItem: data });
  } catch (err) {
    console.error("[nav-items] POST exception:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// PUT - 更新导航项（单个或批量排序）
export async function PUT(request: NextRequest) {
  try {
    const managementAccess = await authorizeNavigationMutation(request, "agent_navigation_update");
    if (!managementAccess.ok) return managementAccess.response;

    const body = await request.json();
    const client = getSupabaseClient();

    // 批量排序
    if (body.items && Array.isArray(body.items)) {
      const itemIds = body.items.map((item: { id?: unknown }) => String(item?.id || "")).filter(Boolean);
      if (itemIds.length > 0) {
        const { data: existingItems, error: existingItemsError } = await client
          .from("nav_items")
          .select("id,status")
          .in("id", itemIds);
        if (existingItemsError) return NextResponse.json({ error: "读取导航项失败" }, { status: 500 });
        if ((existingItems || []).some((item: { status?: string | null }) => item.status === "hidden")) {
          const internalAccess = await authorizeInternalNavigationMutation(request, "internal_agent_navigation_reorder");
          if (!internalAccess.ok) return internalAccess.response;
        }
      }
      for (const item of body.items) {
        await client
          .from("nav_items")
          .update({ sort_order: item.sort_order, updated_at: new Date().toISOString() })
          .eq("id", item.id);
      }
      return NextResponse.json({ success: true });
    }

    // 单个更新
    const { id, name, icon, icon_type, icon_image, description, status, sort_order, is_active } = body;
    if (!id) {
      return NextResponse.json({ error: "缺少导航项ID" }, { status: 400 });
    }

    const { data: existingItem, error: existingItemError } = await client
      .from("nav_items")
      .select("id,status")
      .eq("id", id)
      .maybeSingle();
    if (existingItemError) return NextResponse.json({ error: "读取导航项失败" }, { status: 500 });
    if (!existingItem) return NextResponse.json({ error: "导航项不存在" }, { status: 404 });
    if (existingItem.status === "hidden" || status === "hidden") {
      const internalAccess = await authorizeInternalNavigationMutation(request, "internal_agent_navigation_update");
      if (!internalAccess.ok) return internalAccess.response;
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name.trim();
    if (icon !== undefined) updates.icon = icon;
    if (icon_type !== undefined) updates.icon_type = icon_type;
    if (icon_image !== undefined) updates.icon_image = icon_image;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await client
      .from("nav_items")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("[nav-items] PUT error:", error);
      return NextResponse.json({ error: "更新导航项失败" }, { status: 500 });
    }
    return NextResponse.json({ navItem: data });
  } catch (err) {
    console.error("[nav-items] PUT exception:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// DELETE - 删除导航项
export async function DELETE(request: NextRequest) {
  try {
    const managementAccess = await authorizeNavigationMutation(request, "agent_navigation_delete");
    if (!managementAccess.ok) return managementAccess.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "缺少导航项ID" }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data: existingItem, error: existingItemError } = await client
      .from("nav_items")
      .select("id,status")
      .eq("id", id)
      .maybeSingle();
    if (existingItemError) return NextResponse.json({ error: "读取导航项失败" }, { status: 500 });
    if (!existingItem) return NextResponse.json({ error: "导航项不存在" }, { status: 404 });
    if (existingItem.status === "hidden") {
      const internalAccess = await authorizeInternalNavigationMutation(request, "internal_agent_navigation_delete");
      if (!internalAccess.ok) return internalAccess.response;
    }
    const { error } = await client
      .from("nav_items")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("[nav-items] DELETE error:", error);
      return NextResponse.json({ error: "删除导航项失败" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[nav-items] DELETE exception:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}
