export type AuthSnapshotIssueSeverity = "error" | "warning";

export interface AuthSnapshotIssue {
  severity: AuthSnapshotIssueSeverity;
  code: string;
  message: string;
  userId?: string;
  username?: string;
}

export interface AuthSnapshotGuardReport {
  ok: boolean;
  checkedUsers: number;
  errorCount: number;
  warningCount: number;
  passwordHashAlgorithm: "bcrypt";
  generatedAt: string;
  issues: AuthSnapshotIssue[];
}

export class AuthSnapshotGuardError extends Error {
  report: AuthSnapshotGuardReport;

  constructor(label: string, report: AuthSnapshotGuardReport) {
    const topIssues = report.issues
      .filter((issue) => issue.severity === "error")
      .slice(0, 5)
      .map((issue) => issue.message)
      .join("；");
    super(`${label} 认证快照不完整，已阻止继续保存：${topIssues || "未知认证错误"}`);
    this.name = "AuthSnapshotGuardError";
    this.report = report;
  }
}

const BCRYPT_HASH_RE = /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toSafeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function validateAuthSnapshotUsers(users: unknown): AuthSnapshotGuardReport {
  const issues: AuthSnapshotIssue[] = [];
  const rows = Array.isArray(users) ? users : [];

  if (!Array.isArray(users)) {
    issues.push({
      severity: "error",
      code: "users_not_array",
      message: "备份缺少 core.users 用户表，无法保证原账号密码可登录",
    });
  }

  if (rows.length === 0) {
    issues.push({
      severity: "error",
      code: "users_empty",
      message: "备份中的用户数量为 0，不能作为可恢复登录的业务数据快照",
    });
  }

  rows.forEach((row, index) => {
    const user = asRecord(row);
    const userId = toSafeString(user.id) || `row-${index + 1}`;
    const username = toSafeString(user.username) || toSafeString(user.email) || toSafeString(user.phone);
    const passwordHash = toSafeString(user.password_hash);

    if (!passwordHash) {
      issues.push({
        severity: "error",
        code: "password_hash_missing",
        message: `用户 ${username || userId} 缺少 password_hash，恢复后原密码必然无法登录`,
        userId,
        username,
      });
      return;
    }

    if (!BCRYPT_HASH_RE.test(passwordHash)) {
      issues.push({
        severity: "error",
        code: "password_hash_invalid",
        message: `用户 ${username || userId} 的 password_hash 不是有效 bcrypt 哈希，已阻止写入备份`,
        userId,
        username,
      });
    }

    const role = toSafeString(user.role);
    if (role && role !== "admin" && role !== "student") {
      issues.push({
        severity: "warning",
        code: "role_unknown",
        message: `用户 ${username || userId} 的角色 ${role} 不在 admin/student 范围内，请确认是否为历史数据`,
        userId,
        username,
      });
    }
  });

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;

  return {
    ok: errorCount === 0,
    checkedUsers: rows.length,
    errorCount,
    warningCount,
    passwordHashAlgorithm: "bcrypt",
    generatedAt: new Date().toISOString(),
    issues,
  };
}

export function assertAuthSnapshotUsable(users: unknown, label = "数据备份"): AuthSnapshotGuardReport {
  const report = validateAuthSnapshotUsers(users);
  if (!report.ok) {
    throw new AuthSnapshotGuardError(label, report);
  }
  return report;
}
