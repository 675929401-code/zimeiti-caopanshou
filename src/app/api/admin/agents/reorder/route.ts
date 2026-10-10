import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { invalidateBotsCache } from "@/lib/bots-cache";
import { invalidateAgentConfigCache } from "@/app/api/llm/llm-state";
import {
  agentBatchConflict,
  agentRevisionConflict,
  isAgentBatchConflict,
  parseExpectedAgentRevision,
} from "@/lib/server/agent-config-cas";

type ReorderEntry = { id: string; expected_revision: number };
type ReorderAgentRow = {
  id: string;
  category: string | null;
  user_access: string | null;
  config_revision: number;
};
type CategoryOrderRow = { id: string; category: string | null };

function normalizedCategory(value: string | null | undefined): string {
  return String(value || "未分类");
}

/** PUT /api/admin/agents/reorder — 按分类批量更新智能体排序。 */
export async function PUT(request: NextRequest) {
  const managementAccess = await authorizeAdminCapability(request, "agents.manage", {
    operation: "agent_reorder",
    requireStepUp: true,
  });
  if (!managementAccess.ok) return managementAccess.response;

  try {
    const body = await request.json() as Record<string, unknown>;
    const rawEntries = Array.isArray(body.agents) ? body.agents : [];
    const entries: ReorderEntry[] = rawEntries.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const record = raw as Record<string, unknown>;
      const revision = parseExpectedAgentRevision(record);
      return typeof record.id === "string" && revision !== null
        ? [{ id: record.id, expected_revision: revision }]
        : [];
    });
    if (entries.length === 0 || entries.length !== rawEntries.length) {
      return NextResponse.json({
        error: "agents 必须包含每个智能体的 id 与 expected_revision。",
        code: "AGENT_EXPECTED_REVISION_REQUIRED",
      }, { status: 400 });
    }
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      return NextResponse.json({ error: "排序列表包含重复智能体" }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data: agents, error: fetchError } = await client
      .from("agents")
      .select("id,category,user_access,config_revision")
      .in("id", entries.map((entry) => entry.id))
      .is("deleted_at", null);
    if (fetchError) return NextResponse.json({ error: "获取智能体信息失败" }, { status: 500 });
    if ((agents || []).length !== entries.length) {
      return NextResponse.json({ error: "排序列表包含不存在或已删除的智能体" }, { status: 404 });
    }

    const agentRows = (agents || []) as ReorderAgentRow[];
    const affectedCategories = Array.from(new Set(agentRows.map((agent) => normalizedCategory(agent.category))));
    const { data: completeCategoryRows, error: completeCategoryError } = await client
      .from("agents")
      .select("id,category")
      .is("deleted_at", null);
    if (completeCategoryError) {
      return NextResponse.json({ error: "读取完整分类排序失败", updated: 0 }, { status: 500 });
    }
    const completeIds = new Set(((completeCategoryRows || []) as CategoryOrderRow[])
      .filter((agent) => affectedCategories.includes(normalizedCategory(agent.category as string | null)))
      .map((agent) => String(agent.id)));
    const submittedIds = new Set(entries.map((entry) => entry.id));
    if (completeIds.size !== submittedIds.size || [...completeIds].some((id) => !submittedIds.has(id))) {
      return agentBatchConflict({
        error: "排序必须提交受影响分类的完整智能体顺序；筛选或收藏子集不能覆盖分类排序。",
        code: "AGENT_REORDER_CATEGORY_INCOMPLETE",
        updated: 0,
      });
    }
    const privateCategories = new Set<string>();
    const categoryNames = Array.from(new Set(agentRows.map((agent) => String(agent.category || "")).filter(Boolean)));
    if (categoryNames.length > 0) {
      const { data: categories } = await client
        .from("categories")
        .select("name,visibility")
        .in("name", categoryNames);
      for (const category of categories || []) {
        if (category.visibility === "private") privateCategories.add(String(category.name));
      }
    }
    if (agentRows.some((agent) => agent.user_access === "hidden" || agent.category === "自用" || privateCategories.has(String(agent.category)))) {
      const internalAccess = await authorizeAdminCapability(request, "internal_tools.manage", {
        operation: "internal_agent_reorder",
        requireStepUp: true,
      });
      if (!internalAccess.ok) return internalAccess.response;
    }

    const byId = new Map(agentRows.map((agent) => [String(agent.id), agent]));
    for (const entry of entries) {
      const current = byId.get(entry.id);
      if (Number(current?.config_revision) !== entry.expected_revision) {
        return agentRevisionConflict(entry.expected_revision, current?.config_revision ?? null, { agent_id: entry.id, updated: 0 });
      }
    }

    const { data: result, error: mutationError } = await client.rpc("apply_agent_reorder_cas_v1", {
      p_entries: entries,
    });
    if (mutationError) {
      if (isAgentBatchConflict(mutationError)) return agentBatchConflict({ updated: 0 });
      return NextResponse.json({ error: "排序更新失败", updated: 0 }, { status: 500 });
    }

    for (const entry of entries) invalidateAgentConfigCache(entry.id);
    invalidateBotsCache();
    return NextResponse.json({
      success: true,
      updated: Number((result as { updated?: unknown } | null)?.updated || entries.length),
    });
  } catch (err) {
    console.error("[reorder] Error:", err);
    return NextResponse.json({ error: "排序更新失败" }, { status: 500 });
  }
}
