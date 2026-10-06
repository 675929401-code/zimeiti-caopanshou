export type AdminUserVerificationPurpose = "create" | "email_change" | "password_reset";

export function adminUserVerificationKey(
  purpose: AdminUserVerificationPurpose,
  adminUserId: string,
  targetUserId?: string,
): string {
  const adminId = adminUserId.trim();
  const targetId = targetUserId?.trim();

  if (!adminId) throw new Error("管理员身份不能为空");
  if (purpose !== "create" && !targetId) throw new Error("目标用户不能为空");

  return targetId
    ? `admin_${purpose}:${adminId}:${targetId}`
    : `admin_${purpose}:${adminId}`;
}

export function maskQqEmail(email: string): string {
  const [qq = "", domain = "qq.com"] = email.split("@");
  if (qq.length <= 4) return `${qq.slice(0, 1)}***@${domain}`;
  return `${qq.slice(0, 2)}***${qq.slice(-2)}@${domain}`;
}
