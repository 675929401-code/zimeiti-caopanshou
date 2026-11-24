import { NextRequest, NextResponse } from "next/server";
import { canonicalAgentModelBinding } from "@/lib/agent-model-binding";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { appendAdminGovernanceAudit } from "@/lib/server/admin-governance-authority";
import { invalidateAgentConfigCache } from "@/app/api/llm/llm-state";
import { invalidateBotsCache } from "@/lib/bots-cache";
import { updateAgentByRevision } from "@/lib/server/agent-config-cas";

const MODEL_BINDING_COLUMNS = [
  "id",
  "name",
  "model_name",
  "description",
  "category",
  "is_active",
  "is_hidden",
  "user_access",
  "api_key",
] as const;

type BatchBody = {
  agentIds?: unknown;
  modelId?: unknown;
  expectedRevisions?: unknown;
};

type AgentRow = {
  id: string;
  name: string;
  category: string | null;
  user_access: string | null;
  source: string | null;
  model_id: string | null;
  config_revision: number;
  deleted_at: string | null;
};

type BatchItemResult = {
  agentId: string;
  name: string;
  ok: boolean;
  changed?: boolean;
  revision?: number;
  code?: string;
  error?: string;
};

function noStoreJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("请选择要批量设置的智能体");
  const ids = Array.from(new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean)));
  if (ids.length === 0) throw new Error("请选择要批量设置的智能体");
  if (ids.length > 200) throw new Error("单次最多批量设置 200 个智能体");
  if (ids.some((id) => !/^[A-Za-z0-9_-]{1,120}$/u.test(id))) throw new Error("智能体 ID 格式无效");
  return ids;
}

export async function POST(request: NextRequest) {
  const management = await authorizeAdminCapability(request, "agents.manage", {
    requireStepUp: true,
    operation: "agent_batch_model",
  });
  if (!management.ok) return management.response;
  const modelAccess = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "agent_model_configuration_edit",
  });
  if (!modelAccess.ok) return modelAccess.response;
  const actorId = management.user.id;
  const actorLevel = management.access.adminLevel;

  let agentIds: string[] = [];
  try {
    const body = (await request.json().catch(() => ({}))) as BatchBody;
    agentIds = normalizeAgentIds(body.agentIds);
    const modelId = String(body.modelId || "").trim();
    if (!modelId) throw new Error("请选择要设置的对话模型");

    const client = getSupabaseClient();
    const { data: model, error: modelError } = await client
      .from("llm_models")
      .select(MODEL_BINDING_COLUMNS.join(","))
      .eq("id", modelId)
      .maybeSingle();
    if (modelError) throw new Error("读取模型失败，请稍后重试");
    const binding = canonicalAgentModelBinding(modelId, model as Record<string, unknown> | null);

    const { data: rows, error: rowsError } = await client
      .from("agents")
      .select("id,name,category,user_access,source,model_id,config_revision,deleted_at")
      .in("id", agentIds)
      .is("deleted_at", null);
    if (rowsError) throw new Error("读取智能体失败，请稍后重试");
    const agentRows = (rows || []) as AgentRow[];
    const byId = new Map(agentRows.map((row) => [row.id, row]));
    let canManageInternal = true;
    if (agentRows.some((row) => row.user_access === "hidden")) {
      canManageInternal = (await authorizeAdminCapability(request, "internal_tools.manage", {
        requireStepUp: true,
        operation: "agent_batch_model_internal_check",
      })).ok;
    }
    const expectedRevisions = body.expectedRevisions && typeof body.expectedRevisions === "object"
      ? body.expectedRevisions as Record<string, unknown>
      : {};

    const results: BatchItemResult[] = [];
    let changedCount = 0;
    let failedCount = 0;

    for (const agentId of agentIds) {
      const row = byId.get(agentId);
      if (!row) {
        failedCount += 1;
        results.push({ agentId, name: agentId, ok: false, code: "AGENT_NOT_FOUND", error: "智能体不存在或已删除" });
        continue;
      }
      if (row.user_access === "hidden" && !canManageInternal) {
        failedCount += 1;
        results.push({ agentId, name: row.name, ok: false, code: "INTERNAL_ACCESS_REQUIRED", error: "该智能体属于内部范围，需要内部工具权限" });
        continue;
      }
      if (row.model_id === binding.model_id) {
        results.push({ agentId, name: row.name, ok: true, changed: false, revision: Number(row.config_revision) });
        continue;
      }
      const requestedRevision = Number(expectedRevisions[agentId]);
      const expectedRevision = Number.isSafeInteger(requestedRevision) && requestedRevision > 0
        ? requestedRevision
        : Number(row.config_revision);
      const mutation = await updateAgentByRevision({
        agentId,
        expectedRevision,
        fields: {
          model_id: binding.model_id,
          model: binding.model,
          updated_at: new Date().toISOString(),
        },
      });
      if (mutation.error) {
        failedCount += 1;
        results.push({ agentId, name: row.name, ok: false, code: "UPDATE_FAILED", error: "写入失败，请刷新后重试" });
        continue;
      }
      if (!mutation.data) {
        failedCount += 1;
        results.push({
          agentId,
          name: row.name,
          ok: false,
          code: "REVISION_CONFLICT",
          error: "配置已被其他窗口修改，请刷新后重试",
        });
        continue;
      }
      changedCount += 1;
      invalidateAgentConfigCache(agentId);
      results.push({
        agentId,
        name: row.name,
        ok: true,
        changed: true,
        revision: Number((mutation.data as { config_revision?: number }).config_revision || expectedRevision + 1),
      });
    }

    if (changedCount > 0) invalidateBotsCache();

    await appendAdminGovernanceAudit({
      actorId,
      actorLevel,
      permissionKey: "agents.manage",
      action: "agent_batch_model_update",
      result: failedCount === 0 ? "success" : "failure",
      reasonCode: failedCount === 0 ? "BATCH_MODEL_UPDATED" : "BATCH_MODEL_PARTIAL",
      resource: "agents",
      request,
      metadata: {
        requested: agentIds.length,
        changed: changedCount,
        failed: failedCount,
        modelId: binding.model_id,
        model: binding.model,
      },
    });

    return noStoreJson({
      success: failedCount === 0,
      model: { id: binding.model_id, modelName: binding.model },
      requested: agentIds.length,
      changed: changedCount,
      failed: failedCount,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "批量设置对话模型失败";
    const status = /请选择|格式|最多/u.test(message) ? 400 : 500;
    return noStoreJson({ success: false, error: message, code: "AGENT_BATCH_MODEL_FAILED" }, status);
  }
}
