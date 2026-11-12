import "server-only";

import {
  normalizeFeatureNavigationKeys,
  normalizeMemberAgentNavigationKeys,
  type MemberPermissionSnapshot,
} from "@/lib/member-permissions";
import { PRIMARY_NAVIGATION_ORDER } from "@/lib/marketplace-navigation";
import { AGENT_NAVIGATION_OPTIONS } from "@/lib/agent-category-access";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type PermissionAuthorityOptions = {
  knownRole?: string | null;
};

/**
 * 会员权限 schema 缺席判定（2026-10-08 R870 生产修复）。
 * 生产数据库尚未应用 member_permission_* 迁移时 RPC 返回 PGRST202。
 * 权限门控系统上线前（v2.23 及更早）所有登录用户可见全部功能，
 * 因此 schema 缺席时回退"全量放行"快照——恢复门控前的既有行为，
 * 而不是 fail-closed 把首页/模型调用/收藏全部打成 503。
 * 迁移应用后 RPC 成功返回，真实门控自动接管，本回退不再触发。
 */
const MEMBER_PERMISSION_SCHEMA_ABSENT_CODES = new Set(["42P01", "PGRST202", "PGRST204", "PGRST205"]);
const permissionSnapshotCache = new Map<string, { value: MemberPermissionSnapshot; expiresAt: number }>();
const permissionInFlight = new Map<string, Promise<MemberPermissionSnapshot>>();

function fallbackPermissionSnapshot(userId: string) {
  const cached = permissionSnapshotCache.get(userId);
  return cached && cached.expiresAt > Date.now() ? cached.value : undefined;
}

/** One retry for transient network failures; successful snapshots are kept only for fallback. */
async function readPermissionRpc(database: ReturnType<typeof getSupabaseAdminClient>, userId: string) {
  let result = await database.rpc("read_member_permission_snapshot", { p_user_id: userId });
  for (let attempt = 0; attempt < 2 && result.error && /fetch failed|network|timeout|ECONNRESET|ETIMEDOUT/i.test(String(result.error.message || "")); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    result = await database.rpc("read_member_permission_snapshot", { p_user_id: userId });
  }
  return result;
}

function isMemberPermissionSchemaAbsent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; message?: string; details?: string };
  const code = String(value.code || "");
  const message = `${value.message || ""} ${value.details || ""}`;
  return MEMBER_PERMISSION_SCHEMA_ABSENT_CODES.has(code)
    || /read_member_permission_snapshot|member_permission/iu.test(message);
}

function legacyFullAccessSnapshot(userId: string, role: string): MemberPermissionSnapshot {
  // Fail closed by default: a missing permission schema must not silently grant
  // every feature. The explicit env flag exists only for a staged migration
  // window where the old behavior must be preserved temporarily.
  if (process.env.MEMBER_PERMISSION_LEGACY_FULL_ACCESS !== "1") {
    return unavailableSnapshot(userId, role, "unavailable");
  }
  return {
    userId,
    role,
    featureNavigationKeys: normalizeFeatureNavigationKeys(PRIMARY_NAVIGATION_ORDER),
    agentNavigationKeys: normalizeMemberAgentNavigationKeys(AGENT_NAVIGATION_OPTIONS.map((item) => item.key)),
    revision: 0,
    checksum: "legacy-schema-absent",
    sourceProfileKey: null,
    sourceProfileVersion: null,
    updatedAt: null,
    updatedBy: null,
    reason: "legacy-fallback: member permission schema absent, pre-gating behavior",
    integrityValid: true,
    authorityStatus: "ready",
  };
}

export function readMemberPermissionSnapshot(
  userId: string,
  options: PermissionAuthorityOptions = {},
): Promise<MemberPermissionSnapshot> {
  const key = String(userId || "").trim();
  const running = permissionInFlight.get(key);
  if (running) return running;
  const request = readMemberPermissionSnapshotInternal(userId, options).finally(() => permissionInFlight.delete(key));
  permissionInFlight.set(key, request);
  return request;
}

async function readMemberPermissionSnapshotInternal(
  userId: string,
  options: PermissionAuthorityOptions = {},
): Promise<MemberPermissionSnapshot> {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return unavailableSnapshot("", options.knownRole || "student", "invalid");
  }
  try {
    const database = getSupabaseAdminClient();
    const { data, error } = await readPermissionRpc(database, normalizedUserId);
    if (error) {
      if (isMemberPermissionSchemaAbsent(error)) {
        console.warn("[member-permission] schema absent; legacy full-access snapshot until migrations applied");
        return legacyFullAccessSnapshot(normalizedUserId, options.knownRole || "student");
      }
      console.error("Member permission authority read failed:", error.message);
      return fallbackPermissionSnapshot(normalizedUserId) ?? unavailableSnapshot(normalizedUserId, options.knownRole || "student", "unavailable");
    }
    const row = (data || {}) as Record<string, unknown>;
    const role = String(row.role || options.knownRole || "student");
    const status = String(row.authority_status || "missing");
    const integrityValid = row.integrity_valid === true;
    if (status !== "ready" || !integrityValid) {
      return unavailableSnapshot(
        normalizedUserId,
        role,
        status === "missing" ? "missing" : "invalid",
      );
    }
    const snapshot: MemberPermissionSnapshot = {
      userId: normalizedUserId,
      role,
      featureNavigationKeys: normalizeFeatureNavigationKeys(row.feature_navigation_keys),
      agentNavigationKeys: normalizeMemberAgentNavigationKeys(row.agent_navigation_keys),
      revision: Number(row.revision || 0),
      checksum: String(row.checksum || ""),
      sourceProfileKey: typeof row.source_profile_key === "string" ? row.source_profile_key : null,
      sourceProfileVersion: Number.isInteger(Number(row.source_profile_version)) ? Number(row.source_profile_version) : null,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
      reason: typeof row.reason === "string" ? row.reason : "",
      integrityValid: true,
      authorityStatus: "ready",
    };
    permissionSnapshotCache.set(normalizedUserId, { value: snapshot, expiresAt: Date.now() + 5 * 60_000 });
    return snapshot;
  } catch (error) {
    if (isMemberPermissionSchemaAbsent(error)) {
      console.warn("[member-permission] schema absent (thrown); legacy full-access snapshot until migrations applied");
      return legacyFullAccessSnapshot(normalizedUserId, options.knownRole || "student");
    }
    console.error("Member permission authority unavailable:", error);
    return fallbackPermissionSnapshot(normalizedUserId) ?? unavailableSnapshot(normalizedUserId, options.knownRole || "student", "unavailable");
  }
}

function unavailableSnapshot(
  userId: string,
  role: string,
  status: "missing" | "invalid" | "unavailable",
): MemberPermissionSnapshot {
  return {
    userId,
    role,
    featureNavigationKeys: [],
    agentNavigationKeys: [],
    revision: 0,
    checksum: "",
    sourceProfileKey: null,
    sourceProfileVersion: null,
    updatedAt: null,
    updatedBy: null,
    reason: "",
    integrityValid: false,
    authorityStatus: status,
  };
}
