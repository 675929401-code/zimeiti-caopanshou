import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { visibleAdminCategoryRows } from "@/lib/admin-agent-catalog-visibility";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { invalidateBotsCache } from "@/lib/bots-cache";

async function authorizeCategoryMutation(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, "agents.manage", {
    operation,
    requireStepUp: true,
  });
}

async function authorizeInternalCategoryMutation(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, "internal_tools.manage", {
    operation,
    requireStepUp: true,
  });
}

// GET - List all categories
export async function GET(request: NextRequest) {
  const listingAccess = await authorizeAdminCapability(request, "agents.view", {
    operation: "agent_categories_read",
    requireStepUp: false,
  });
  if (!listingAccess.ok) return listingAccess.response;

  const includeInternal = request.nextUrl.searchParams.get("include_internal") === "1";
  if (includeInternal) {
    const internalAccess = await authorizeAdminCapability(request, "internal_tools.manage", {
      operation: "private_agent_categories_read",
      requireStepUp: true,
    });
    if (!internalAccess.ok) return internalAccess.response;
  }

  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("categories")
      .select("id,name,icon,description,sort_order,visibility,is_active")
      .order("sort_order", { ascending: true });

    if (error) return NextResponse.json({ error: "获取分类失败" }, { status: 500 });
    return NextResponse.json(
      { categories: visibleAdminCategoryRows(data || [], includeInternal) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "获取分类失败" }, { status: 500 });
  }
}

// POST - Create category
export async function POST(request: NextRequest) {
  const managementAccess = await authorizeCategoryMutation(request, "agent_category_create");
  if (!managementAccess.ok) return managementAccess.response;

  try {
    const body = await request.json();
    const { name, icon, description, sortOrder, visibility } = body;
    if (!name) return NextResponse.json({ error: "分类名称不能为空" }, { status: 400 });
    if (visibility === "private" || name === "自用") {
      const internalAccess = await authorizeInternalCategoryMutation(request, "internal_agent_category_create");
      if (!internalAccess.ok) return internalAccess.response;
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from("categories")
      .insert({
        name,
        icon: icon || "",
        description: description || "",
        sort_order: sortOrder || 0,
        visibility: visibility || "normal",
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "分类名称已存在" }, { status: 400 });
      return NextResponse.json({ error: `创建分类失败: ${error.message}` }, { status: 500 });
    }

    // Category publication and user authorization are independent operations.
    // A newly published navigation item must never grant itself to existing users.
    invalidateBotsCache();

    return NextResponse.json({ success: true, category: data });
  } catch {
    return NextResponse.json({ error: "创建分类失败" }, { status: 500 });
  }
}

// PUT - Update category
export async function PUT(request: NextRequest) {
  const managementAccess = await authorizeCategoryMutation(request, "agent_category_update");
  if (!managementAccess.ok) return managementAccess.response;

  try {
    const body = await request.json();
    const { categoryId, name, icon, description, sortOrder, isActive } = body;
    if (!categoryId) return NextResponse.json({ error: "分类ID不能为空" }, { status: 400 });

    const client = getSupabaseClient();
    const { data: previousCategory, error: previousError } = await client
      .from("categories")
      .select("id, name, icon, description, sort_order, is_active, visibility")
      .eq("id", categoryId)
      .maybeSingle();
    if (previousError) return NextResponse.json({ error: `读取分类失败: ${previousError.message}` }, { status: 500 });
    if (!previousCategory) return NextResponse.json({ error: "分类不存在" }, { status: 404 });
    if (
      previousCategory.visibility === "private"
      || previousCategory.name === "自用"
      || body.visibility === "private"
      || name === "自用"
    ) {
      const internalAccess = await authorizeInternalCategoryMutation(request, "internal_agent_category_update");
      if (!internalAccess.ok) return internalAccess.response;
    }
    if (previousCategory.name === "自用" && name !== undefined && name !== "自用") {
      return NextResponse.json({ error: "“内部工具”的系统标识固定为“自用”，请修改展示文案而不是内部分类名" }, { status: 400 });
    }

    const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) fields.name = name;
    if (icon !== undefined) fields.icon = icon;
    if (description !== undefined) fields.description = description;
    if (sortOrder !== undefined) fields.sort_order = sortOrder;
    if (isActive !== undefined) fields.is_active = isActive;
    if (body.visibility !== undefined) fields.visibility = body.visibility;

    const { data, error } = await client
      .from("categories")
      .update(fields)
      .eq("id", categoryId)
      .select()
      .single();

    if (error) return NextResponse.json({ error: `更新分类失败: ${error.message}` }, { status: 500 });

    if (name !== undefined && name !== previousCategory.name) {
      const { error: agentRenameError } = await client
        .from("agents")
        .update({ category: name, updated_at: new Date().toISOString() })
        .eq("category", previousCategory.name);
      if (agentRenameError) {
        const rollback = await client
          .from("categories")
          .update({
            name: previousCategory.name,
            icon: previousCategory.icon,
            description: previousCategory.description,
            sort_order: previousCategory.sort_order,
            is_active: previousCategory.is_active,
            visibility: previousCategory.visibility,
            updated_at: new Date().toISOString(),
          })
          .eq("id", categoryId);
        console.error("Category rename failed; rollback result:", agentRenameError, rollback.error);
        return NextResponse.json({ error: "分类改名未完成，已恢复原分类" }, { status: 500 });
      }
    }

    // Making an item visible updates the catalog only. User grants stay unchanged.
    invalidateBotsCache();

    return NextResponse.json({ success: true, category: data });
  } catch {
    return NextResponse.json({ error: "更新分类失败" }, { status: 500 });
  }
}

// DELETE - Delete category and optionally migrate agents
export async function DELETE(request: NextRequest) {
  const managementAccess = await authorizeCategoryMutation(request, "agent_category_delete");
  if (!managementAccess.ok) return managementAccess.response;

  try {
    // 同时支持 URL query params 和 JSON body（与其他方法保持一致）
    const { searchParams } = new URL(request.url);
    let categoryId = searchParams.get("id");
    let migrateTo = searchParams.get("migrate_to");

    // 如果 URL 参数中没有，尝试从 JSON body 读取
    if (!categoryId) {
      try {
        const body = await request.json();
        if (body.id) categoryId = body.id;
        if (body.migrate_to) migrateTo = body.migrate_to;
      } catch {
        // body 为空或非 JSON，忽略
      }
    }

    if (!categoryId) return NextResponse.json({ error: "分类ID不能为空" }, { status: 400 });

    const client = getSupabaseClient();

    // Get the category name before deleting
    const { data: cat } = await client.from("categories").select("name,visibility").eq("id", categoryId).single();
    if (!cat) return NextResponse.json({ error: "分类不存在" }, { status: 404 });
    if (cat.visibility === "private" || cat.name === "自用") {
      const internalAccess = await authorizeInternalCategoryMutation(request, "internal_agent_category_delete");
      if (!internalAccess.ok) return internalAccess.response;
    }
    if (cat.name === "自用") {
      return NextResponse.json({ error: "“内部工具”是固定智能体导航，不能删除其内部分类" }, { status: 400 });
    }

    let targetCategoryName: string | null = null;
    if (migrateTo) {
      const { data: targetCategory, error: targetError } = await client
        .from("categories")
        .select("id, name")
        .eq("id", migrateTo)
        .maybeSingle();
      if (targetError) return NextResponse.json({ error: `读取目标分类失败: ${targetError.message}` }, { status: 500 });
      if (!targetCategory || targetCategory.id === categoryId) {
        return NextResponse.json({ error: "请选择其他有效分类作为迁移目标" }, { status: 400 });
      }
      targetCategoryName = targetCategory.name;
    }

    const { data: agentsToMove, error: agentsToMoveError } = await client
      .from("agents")
      .select("id")
      .eq("category", cat.name)
      .is("deleted_at", null);
    if (agentsToMoveError) {
      return NextResponse.json({ error: `读取分类智能体失败: ${agentsToMoveError.message}` }, { status: 500 });
    }
    const movedAgentIds = (agentsToMove || []).map((agent: { id: string }) => agent.id);

    // Move agents first. A failure must stop deletion instead of returning false success.
    if (migrateTo && movedAgentIds.length > 0) {
      const { error: migrateError } = await client
        .from("agents")
        .update({ category: targetCategoryName, updated_at: new Date().toISOString() })
        .in("id", movedAgentIds);
      if (migrateError) return NextResponse.json({ error: `迁移智能体失败: ${migrateError.message}` }, { status: 500 });
    } else if (movedAgentIds.length > 0) {
      const { error: detachError } = await client
        .from("agents")
        .update({ category: null, updated_at: new Date().toISOString() })
        .in("id", movedAgentIds);
      if (detachError) return NextResponse.json({ error: `清空智能体分类失败: ${detachError.message}` }, { status: 500 });
    }

    // Delete the category
    const { error } = await client.from("categories").delete().eq("id", categoryId);
    if (error) {
      const restore = movedAgentIds.length > 0
        ? await client
            .from("agents")
            .update({ category: cat.name, updated_at: new Date().toISOString() })
            .in("id", movedAgentIds)
        : { error: null };
      console.error("Category delete failed; agent rollback result:", error, restore.error);
      return NextResponse.json({ error: `删除分类失败: ${error.message}` }, { status: 500 });
    }

    const { data: usersWithGrants, error: usersError } = await client
      .from("users")
      .select("id, allowed_categories")
      .neq("role", "admin");
    if (usersError) {
      console.error("Deleted category grant cleanup read failed:", usersError);
    } else {
      const cleanupResults = await Promise.all((usersWithGrants || []).map(async (user: { id: string; allowed_categories: unknown }) => {
        const grants = Array.isArray(user.allowed_categories) ? user.allowed_categories.map(String) : [];
        if (!grants.includes(categoryId as string)) return null;
        return client
          .from("users")
          .update({ allowed_categories: grants.filter((id: string) => id !== categoryId) })
          .eq("id", user.id);
      }));
      const cleanupFailure = cleanupResults.find((result) => result?.error)?.error;
      if (cleanupFailure) console.error("Deleted category grant cleanup write failed:", cleanupFailure);
    }

    invalidateBotsCache();

    return NextResponse.json({ success: true, migrated: !!migrateTo });
  } catch {
    return NextResponse.json({ error: "删除分类失败" }, { status: 500 });
  }
}
