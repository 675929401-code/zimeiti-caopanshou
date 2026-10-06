import { SignJWT, jwtVerify } from "jose";
import { getJwtSecretKey, type JWTPayload } from "@/lib/auth";

export const ADMIN_USER_DELETE_REAUTH_HEADER = "x-admin-user-delete-reauth";
export const ADMIN_USER_ACCOUNT_REAUTH_HEADER = "x-admin-user-account-reauth";
export const ADMIN_CAMI_ASSIGNMENT_REAUTH_HEADER = "x-admin-cami-assignment-reauth";
export const ADMIN_USER_DELETE_REAUTH_TTL_SECONDS = 10 * 60;
export const ADMIN_USER_ACCOUNT_REAUTH_TTL_SECONDS = 10 * 60;
export const ADMIN_CAMI_ASSIGNMENT_REAUTH_TTL_SECONDS = 5 * 60;

const TOKEN_ISSUER = "zimeiti-admin";
type AdminUserSensitivePurpose = "admin_user_delete" | "admin_user_account_recovery" | "admin_cami_assignment";

const PURPOSE_CONFIG: Record<AdminUserSensitivePurpose, {
  audience: string;
  tokenUse: string;
  ttlSeconds: number;
}> = {
  admin_user_delete: {
    audience: "admin-user-delete",
    tokenUse: "admin_user_delete_reauth",
    ttlSeconds: ADMIN_USER_DELETE_REAUTH_TTL_SECONDS,
  },
  admin_user_account_recovery: {
    audience: "admin-user-account-recovery",
    tokenUse: "admin_user_account_recovery_reauth",
    ttlSeconds: ADMIN_USER_ACCOUNT_REAUTH_TTL_SECONDS,
  },
  admin_cami_assignment: {
    audience: "admin-cami-assignment",
    tokenUse: "admin_cami_assignment_reauth",
    ttlSeconds: ADMIN_CAMI_ASSIGNMENT_REAUTH_TTL_SECONDS,
  },
};

export interface AdminUserDeleteReauth {
  token: string;
  expiresAt: number;
  expiresInSeconds: number;
}

async function createAdminUserSensitiveReauth(
  admin: Pick<JWTPayload, "userId" | "sessionId">,
  purpose: AdminUserSensitivePurpose,
): Promise<AdminUserDeleteReauth> {
  const config = PURPOSE_CONFIG[purpose];
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAtSeconds + config.ttlSeconds;
  const token = await new SignJWT({
    tokenUse: config.tokenUse,
    adminUserId: admin.userId,
    authSessionId: admin.sessionId || null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(config.audience)
    .setSubject(admin.userId)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(getJwtSecretKey());

  return {
    token,
    expiresAt: expiresAtSeconds * 1000,
    expiresInSeconds: config.ttlSeconds,
  };
}

async function verifyAdminUserSensitiveReauth(
  token: string | null | undefined,
  admin: Pick<JWTPayload, "userId" | "sessionId">,
  purpose: AdminUserSensitivePurpose,
): Promise<boolean> {
  if (!token) return false;
  const config = PURPOSE_CONFIG[purpose];
  try {
    const { payload } = await jwtVerify(token, getJwtSecretKey(), {
      issuer: TOKEN_ISSUER,
      audience: config.audience,
    });
    if (
      payload.tokenUse !== config.tokenUse
      || payload.sub !== admin.userId
      || payload.adminUserId !== admin.userId
    ) {
      return false;
    }
    const tokenSessionId = typeof payload.authSessionId === "string" ? payload.authSessionId : "";
    const currentSessionId = admin.sessionId || "";
    return tokenSessionId === currentSessionId;
  } catch {
    return false;
  }
}

export function createAdminUserDeleteReauth(
  admin: Pick<JWTPayload, "userId" | "sessionId">,
): Promise<AdminUserDeleteReauth> {
  return createAdminUserSensitiveReauth(admin, "admin_user_delete");
}

export function verifyAdminUserDeleteReauth(
  token: string | null | undefined,
  admin: Pick<JWTPayload, "userId" | "sessionId">,
): Promise<boolean> {
  return verifyAdminUserSensitiveReauth(token, admin, "admin_user_delete");
}

export function createAdminUserAccountReauth(
  admin: Pick<JWTPayload, "userId" | "sessionId">,
): Promise<AdminUserDeleteReauth> {
  return createAdminUserSensitiveReauth(admin, "admin_user_account_recovery");
}

export function verifyAdminUserAccountReauth(
  token: string | null | undefined,
  admin: Pick<JWTPayload, "userId" | "sessionId">,
): Promise<boolean> {
  return verifyAdminUserSensitiveReauth(token, admin, "admin_user_account_recovery");
}

export function createAdminCamiAssignmentReauth(
  admin: Pick<JWTPayload, "userId" | "sessionId">,
): Promise<AdminUserDeleteReauth> {
  return createAdminUserSensitiveReauth(admin, "admin_cami_assignment");
}

export function verifyAdminCamiAssignmentReauth(
  token: string | null | undefined,
  admin: Pick<JWTPayload, "userId" | "sessionId">,
): Promise<boolean> {
  return verifyAdminUserSensitiveReauth(token, admin, "admin_cami_assignment");
}
