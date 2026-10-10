import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { invalidateBotsCache } from "@/lib/bots-cache";
import { invalidateAgentConfigCache } from "@/app/api/llm/llm-state";
import {
  agentRevisionConflict,
  deleteAgentByRevision,
  expectedAgentRevisionRequired,
  parseExpectedAgentRevision,
  updateAgentByRevision,
} from "@/lib/server/agent-config-cas";

async function authorizeRestoreMutation(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, "agents.manage", {
    operation,
    requireStepUp: true,
  });
}

async function authorizeInternalAgent(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, "internal_tools.manage", {
    operation,
    requireStepUp: true,
  });
}

async function loadDeletedAgent(agentId: string) {
  return getSupabaseClient()
    .from("agents")
    .select("id,category,user_access,config_revision,deleted_at")
    .eq("id", agentId)
    .maybeSingle();
}

async function requiresInternalAccess(agent: { category?: unknown; user_access?: unknown }) {
  if (agent.user_access === "hidden" || agent.category === "自用") return true;
  if (typeof agent.category !== "string" || !agent.category) return false;
  const { data } = await getSupabaseClient()
    .from("categories")
    .select("visibility")
    .eq("name", agent.category)
    .maybeSingle();
  return data?.visibility === "private";
}

// POST - 恢复已删除的智能体
export async function POST(request: NextRequest) {
  const managementAccess = await authorizeRestoreMutation(request, "agent_restore");
  if (!managementAccess.ok) return managementAccess.response;

  try {
    const body = await request.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    if (!agentId) return NextResponse.json({ error: "智能体ID不能为空" }, { status: 400 });

    const current = await loadDeletedAgent(agentId);
    if (current.error) return NextResponse.json({ error: "读取智能体失败" }, { status: 500 });
    if (!current.data || current.data.deleted_at === null) {
      return NextResponse.json({ error: "回收站中未找到该智能体" }, { status: 404 });
    }
    if (await requiresInternalAccess(current.data)) {
      const internalAccess = await authorizeInternalAgent(request, "internal_agent_restore");
      if (!internalAccess.ok) return internalAccess.response;
    }

    const expectedRevision = parseExpectedAgentRevision(body);
    if (expectedRevision === null) return expectedAgentRevisionRequired(current.data.config_revision);
    const mutation = await updateAgentByRevision({
      agentId,
      expectedRevision,
      fields: { deleted_at: null, updated_at: new Date().toISOString() },
      deletedScope: "deleted",
    });
    if (mutation.error) return NextResponse.json({ error: "恢复智能体失败" }, { status: 500 });
    if (!mutation.data) return agentRevisionConflict(expectedRevision, mutation.currentRevision, { operation: "restore" });

    invalidateAgentConfigCache(agentId);
    invalidateBotsCache();
    return NextResponse.json({ success: true, message: "已恢复智能体", agent: mutation.data });
  } catch (err) {
    console.error("Restore agent error:", err);
    return NextResponse.json({ error: "恢复智能体失败" }, { status: 500 });
  }
}

// DELETE - 永久删除智能体（兼容旧回收站调用方）
export async function DELETE(request: NextRequest) {
  const managementAccess = await authorizeRestoreMutation(request, "agent_permanent_delete");
  if (!managementAccess.ok) return managementAccess.response;

  try {
    const agentId = request.nextUrl.searchParams.get("id") || "";
    if (!agentId) return NextResponse.json({ error: "智能体ID不能为空" }, { status: 400 });

    const current = await loadDeletedAgent(agentId);
    if (current.error) return NextResponse.json({ error: "读取智能体失败" }, { status: 500 });
    if (!current.data || current.data.deleted_at === null) {
      return NextResponse.json({ error: "回收站中未找到该智能体" }, { status: 404 });
    }
    if (await requiresInternalAccess(current.data)) {
      const internalAccess = await authorizeInternalAgent(request, "internal_agent_permanent_delete");
      if (!internalAccess.ok) return internalAccess.response;
    }

    const expectedRevision = parseExpectedAgentRevision({
      expected_revision: request.nextUrl.searchParams.get("expected_revision"),
    });
    if (expectedRevision === null) return expectedAgentRevisionRequired(current.data.config_revision);
    const mutation = await deleteAgentByRevision({ agentId, expectedRevision, deletedScope: "deleted" });
    if (mutation.error) return NextResponse.json({ error: "永久删除失败" }, { status: 500 });
    if (!mutation.data) return agentRevisionConflict(expectedRevision, mutation.currentRevision, { operation: "permanent_delete" });

    invalidateAgentConfigCache(agentId);
    invalidateBotsCache();
    return NextResponse.json({ success: true, message: "已永久删除" });
  } catch (err) {
    console.error("Permanent delete error:", err);
    return NextResponse.json({ error: "永久删除失败" }, { status: 500 });
  }
}
