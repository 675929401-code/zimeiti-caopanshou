import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export type AgentDeletedScope = "active" | "deleted" | "any";

export function parseExpectedAgentRevision(input: Record<string, unknown>): number | null {
  const raw = input.expected_revision ?? input.expectedRevision;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
  }
  if (typeof raw !== "string" || !/^[1-9]\d*$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function expectedAgentRevisionRequired(currentRevision: unknown = null): NextResponse {
  return NextResponse.json({
    error: "修改智能体配置时必须提供当前 expected_revision。",
    code: "AGENT_EXPECTED_REVISION_REQUIRED",
    current_revision: currentRevision,
  }, { status: 400 });
}

export function agentRevisionConflict(
  expectedRevision: number,
  currentRevision: unknown,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json({
    error: "智能体配置已被其他管理员更新，请刷新后重新编辑。",
    code: "AGENT_CONFIG_REVISION_CONFLICT",
    expected_revision: expectedRevision,
    current_revision: currentRevision,
    ...extra,
  }, { status: 409 });
}

const AGENT_BATCH_CONFLICT_CODES = new Set(["23505", "23514", "40001", "P0002"]);

export function isAgentBatchConflict(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code || "");
  const message = String(error.message || "");
  return AGENT_BATCH_CONFLICT_CODES.has(code)
    || message.includes("AGENT_CONFIG_REVISION_CONFLICT")
    || message.includes("AGENT_REORDER_CATEGORY_INCOMPLETE")
    || message.includes("COZE_IMPORT_INSERT_TARGET_EXISTS")
    || message.includes("COZE_IMPORT_UPDATE_TARGET_NOT_FOUND");
}

export function agentBatchConflict(extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({
    error: "智能体配置已发生并发变化，本次事务零写入。请刷新后重试。",
    code: "AGENT_CONFIG_REVISION_CONFLICT",
    ...extra,
  }, { status: 409 });
}

function applyDeletedScope<T extends {
  is: (column: string, value: null) => T;
  not: (column: string, operator: string, value: null) => T;
}>(query: T, scope: AgentDeletedScope): T {
  if (scope === "active") return query.is("deleted_at", null);
  if (scope === "deleted") return query.not("deleted_at", "is", null);
  return query;
}

export async function readAgentRevision(agentId: string): Promise<{
  revision: number | null;
  deleted: boolean | null;
  error: unknown;
}> {
  const { data, error } = await getSupabaseClient()
    .from("agents")
    .select("config_revision,deleted_at")
    .eq("id", agentId)
    .maybeSingle();
  return {
    revision: Number.isSafeInteger(Number(data?.config_revision)) ? Number(data?.config_revision) : null,
    deleted: data ? data.deleted_at !== null : null,
    error,
  };
}

export async function updateAgentByRevision(options: {
  agentId: string;
  expectedRevision: number;
  fields: Record<string, unknown>;
  deletedScope?: AgentDeletedScope;
}) {
  const client = getSupabaseClient();
  let query = client
    .from("agents")
    .update(options.fields)
    .eq("id", options.agentId)
    .eq("config_revision", options.expectedRevision);
  query = applyDeletedScope(query, options.deletedScope || "any");
  const { data, error } = await query.select("id,config_revision").maybeSingle();
  if (error || data) return { data, error, currentRevision: null };
  const latest = await readAgentRevision(options.agentId);
  return { data: null, error: latest.error, currentRevision: latest.revision };
}

export async function deleteAgentByRevision(options: {
  agentId: string;
  expectedRevision: number;
  deletedScope?: AgentDeletedScope;
}) {
  const client = getSupabaseClient();
  let query = client
    .from("agents")
    .delete()
    .eq("id", options.agentId)
    .eq("config_revision", options.expectedRevision);
  query = applyDeletedScope(query, options.deletedScope || "any");
  const { data, error } = await query.select("id").maybeSingle();
  if (error || data) return { data, error, currentRevision: null };
  const latest = await readAgentRevision(options.agentId);
  return { data: null, error: latest.error, currentRevision: latest.revision };
}
