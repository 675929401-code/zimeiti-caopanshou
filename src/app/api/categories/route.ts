import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { hasCurrentSelfUseGrant, isViewOnlyAgentAccess } from "@/lib/agent-catalog-lifecycle";
import { getAgentNavigationKey } from "@/lib/agent-category-access";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";
import { canReadOwnerInternalAgentCatalog } from "@/lib/server/internal-agent-catalog-access";

type CategoryRecord = {
  id: string;
  name: string;
  icon: string | null;
  description?: string | null;
  sort_order: number;
  visibility?: string | null;
  is_active?: boolean;
};

async function getCategoriesFromSupabase() {
  const client = getSupabaseClient();
  const result = await client
    .from("categories")
    .select("id, name, icon, description, sort_order, visibility, is_active")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (result.error) throw result.error;
  return (result.data || []) as CategoryRecord[];
}

async function getCategories() {
  try {
    return await getCategoriesFromSupabase();
  } catch (error) {
    console.error("[categories] Supabase data source unavailable:", error);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  try {
    let categories = await getCategories();
    let isAdmin = false;
    let ownerSelfUse = false;
    let allowedCategoryNames: Set<string> | null = null;

    const token = getTokenFromHeaders(request.headers);
    if (token) {
      const payload = await verifyToken(token);
      if (payload?.userId) {
        if (payload.role === "admin") {
          isAdmin = await canReadOwnerInternalAgentCatalog(request);
        }
        const permission = await readMemberPermissionSnapshot(payload.userId, { knownRole: payload.role });
        if (permission.authorityStatus !== "ready" || !permission.integrityValid) {
          throw new Error(`MEMBER_PERMISSION_${permission.authorityStatus.toUpperCase()}`);
        }
        const agentResult = await getSupabaseClient()
          .from("agents")
          .select("id,name,category")
          .is("deleted_at", null);
        if (agentResult.error) throw agentResult.error;
        ownerSelfUse = isAdmin && hasCurrentSelfUseGrant(permission);
        const granted = new Set(permission.agentNavigationKeys);
        allowedCategoryNames = new Set(
          (agentResult.data || []).flatMap((agent: { id: unknown; name: unknown; category: unknown }) => {
            const navigationKey = getAgentNavigationKey({
              id: String(agent.id || ""),
              name: String(agent.name || ""),
              category: agent.category == null ? null : String(agent.category),
            });
            return navigationKey && granted.has(navigationKey) && agent.category ? [String(agent.category)] : [];
          }),
        );
      }
    }

    categories = categories.filter((category) => {
      if (category.name === "自用" && !ownerSelfUse) return false;
      if (!isAdmin && (category.visibility === "private" || category.name.trim() === "自用")) return false;
      if (allowedCategoryNames !== null && !allowedCategoryNames.has(category.name)) return false;
      return true;
    });

    return NextResponse.json({
      categories: categories.map((category) => ({
        ...category,
        user_can_use: !isViewOnlyAgentAccess({category:category.name},category,ownerSelfUse),
      })),
    });
  } catch (err) {
    console.error("Failed to fetch categories:", err);
    return NextResponse.json({ error: "获取分类失败" }, { status: 500 });
  }
}
