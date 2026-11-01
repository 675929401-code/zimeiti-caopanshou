import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { getTokenFromHeaders } from "@/lib/auth";
import {
  ADMIN_PERMISSION_CATALOG,
  ADMIN_TAB_PERMISSIONS,
  adminPermissionCatalogForSelf,
  hasAdminPermissionRequirement,
} from "@/lib/admin-governance";
import {
  readAdminAccessSnapshot,
  readAdminMaintenanceLockSnapshot,
  readAdminStepUpSnapshot,
} from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminToken(getTokenFromHeaders(request.headers));
  if (!authorization.ok) {
    return NextResponse.json(
      { error: authorization.error, code: authorization.code },
      { status: authorization.status },
    );
  }

  const access = await readAdminAccessSnapshot(authorization.actor.userId);
  if (access.authorityStatus !== "ready" || !access.integrityValid) {
    return NextResponse.json(
      {
        error: "后台授权档案尚未就绪或完整性校验失败",
        code: "ADMIN_AUTHORITY_NOT_READY",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const isSuperAdmin = access.adminLevel === "super_admin";
  const maintenanceLock = await readAdminMaintenanceLockSnapshot();
  const grantedCatalog = ADMIN_PERMISSION_CATALOG.filter((permission) =>
    access.permissionKeys.includes(permission.key),
  );
  const stepUpPermission = grantedCatalog.find((permission) => permission.stepUpRequired)?.key;
  const stepUp = maintenanceLock.enabled
    ? { status: "maintenance" as const, expiresAt: maintenanceLock.expiresAt, authMethod: null, sessionId: null }
    : stepUpPermission
    ? await readAdminStepUpSnapshot(request, authorization.actor.userId, stepUpPermission)
    : { status: "missing" as const, expiresAt: null, authMethod: null, sessionId: null };
  let managementPasswordSet = false;
  if (isSuperAdmin) {
    const { data } = await getSupabaseAdminClient()
      .from("platform_settings")
      .select("setting_value")
      .in("setting_key", ["operation_password", "operation_password_hash"]);
    managementPasswordSet = Array.isArray(data) && data.some((row) => Boolean(row.setting_value));
  }

  const completeTabAccess = Object.fromEntries(
    Object.entries(ADMIN_TAB_PERMISSIONS).map(([tab, requirement]) => [
      tab,
      tab === "super-admin"
        ? true // Authenticated administrators may inspect the public directory only.
        : isSuperAdmin
          ? true
          : tab === "aiweb-import"
          ? hasAdminPermissionRequirement(access.permissionKeys, requirement)
            && access.permissionKeys.includes("prompts.edit")
          : hasAdminPermissionRequirement(access.permissionKeys, requirement),
    ]),
  );
  const tabAccess = isSuperAdmin
    ? completeTabAccess
    : Object.fromEntries(
      Object.entries(completeTabAccess).filter(([, allowed]) => allowed === true),
    );

  return NextResponse.json({
    access: {
      authorityStatus: access.authorityStatus,
      integrityValid: access.integrityValid,
      adminLevel: access.adminLevel,
      permissionKeys: access.permissionKeys,
      revision: access.revision,
      profileActive: access.profileActive,
      updatedAt: access.updatedAt,
    },
    stepUp: stepUp.status === "ready" || stepUp.status === "maintenance"
      ? stepUp
      : { status: stepUp.status, expiresAt: null, authMethod: null },
    maintenanceLock: {
      status: maintenanceLock.status,
      enabled: maintenanceLock.enabled,
      revision: maintenanceLock.revision,
      enabledAt: maintenanceLock.enabledAt,
      expiresAt: maintenanceLock.expiresAt,
      enableReason: maintenanceLock.enableReason,
      disabledAt: maintenanceLock.disabledAt,
      disableReason: maintenanceLock.disableReason,
      maxDurationMinutes: maintenanceLock.maxDurationMinutes,
    },
    tabAccess,
    managementPasswordSet,
    catalog: adminPermissionCatalogForSelf(access.permissionKeys),
  }, { headers: { "Cache-Control": "no-store" } });
}
