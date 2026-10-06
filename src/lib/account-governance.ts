import { isLikelyMojibake, normalizeDisplayText } from "@/lib/display-normalization";

export type AccountLike = {
  username?: string | null;
  name?: string | null;
  display_name?: string | null;
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  role?: string | null;
  status?: string | null;
  member_status?: string | null;
  memberStatus?: string | null;
  last_sign_in_at?: string | null;
  lastActive?: string | null;
  allowed_categories?: unknown;
  allowedCategories?: unknown;
};

export type AccountGovernanceInfo = {
  isFixture: boolean;
  isSuspicious: boolean;
  label: string | null;
  reasons: string[];
};

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isReservedFixtureEmail(email: unknown): boolean {
  const value = normalized(email);
  return /@(?:example\.invalid|example\.test|test\.invalid)$/iu.test(value);
}

function hasFixtureName(value: unknown): boolean {
  const text = normalized(value);
  return /(?:^|[\s_-])(?:e2e|test|fixture|sandbox|自动化验收)(?:$|[\s_-])/iu.test(text)
    || /^e2e[_-]/iu.test(text)
    || /^test[_-]/iu.test(text)
    || text.includes("e2e");
}

function hasNeverLoggedIn(account: AccountLike): boolean {
  return !account.last_sign_in_at && !account.lastActive;
}

function hasNoUserScope(account: AccountLike): boolean {
  const cats = account.allowedCategories ?? account.allowed_categories;
  return Array.isArray(cats) && cats.length === 0;
}

export function getAccountGovernanceInfo(account: AccountLike): AccountGovernanceInfo {
  const reasons: string[] = [];
  const displayName = account.displayName ?? account.display_name ?? account.name ?? "";

  if (isReservedFixtureEmail(account.email)) reasons.push("测试邮箱域");
  if (hasFixtureName(account.username) || hasFixtureName(displayName)) reasons.push("E2E/测试命名");
  if (isLikelyMojibake(displayName)) reasons.push("显示名乱码");
  if (hasNeverLoggedIn(account)) reasons.push("从未登录");
  if (hasNoUserScope(account)) reasons.push("无功能权限");

  const isFixture = isReservedFixtureEmail(account.email)
    || hasFixtureName(account.username)
    || hasFixtureName(displayName);
  const isSuspicious = isFixture || reasons.length >= 3;

  return {
    isFixture,
    isSuspicious,
    label: isFixture ? "测试/验收账号" : isSuspicious ? "可疑账号" : null,
    reasons,
  };
}

export function shouldRejectReservedFixtureIdentity(account: AccountLike): boolean {
  return isReservedFixtureEmail(account.email)
    || hasFixtureName(account.username)
    || hasFixtureName(account.displayName ?? account.display_name ?? account.name);
}

export function normalizeAccountDisplayName(account: AccountLike, fallback = "未知用户"): string {
  const rawName = account.name ?? account.displayName ?? account.display_name ?? account.username ?? account.phone ?? "";
  const normalizedName = normalizeDisplayText(rawName, "");
  const governance = getAccountGovernanceInfo(account);
  if (governance.isFixture && (!normalizedName || /\?{3,}/u.test(String(rawName)) || isLikelyMojibake(rawName))) {
    return "E2E测试账号（已隔离）";
  }
  return normalizedName || normalizeDisplayText(account.phone, fallback) || fallback;
}
