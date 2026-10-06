import "server-only";

import {
  normalizeFeatureNavigationKeys,
  normalizeMemberAgentNavigationKeys,
  type MemberPermissionSnapshot,
} from "@/lib/member-permissions";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type PermissionAuthorityOptions = {
  knownRole?: string | null;
};

export async function readMemberPermissionSnapshot(
  userId: string,
  options: PermissionAuthorityOptions = {},
): Promise<MemberPermissionSnapshot> {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return unavailableSnapshot("", options.knownRole || "student", "invalid");
  }
  try {
    const database = getSupabaseAdminClient();
    const { data, error } = await database.rpc("read_member_permission_snapshot", {
      p_user_id: normalizedUserId,
    });
    if (error) {
      console.error("Member permission authority read failed:", error.message);
      return unavailableSnapshot(normalizedUserId, options.knownRole || "student", "unavailable");
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
    return {
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
  } catch (error) {
    console.error("Member permission authority unavailable:", error);
    return unavailableSnapshot(normalizedUserId, options.knownRole || "student", "unavailable");
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
