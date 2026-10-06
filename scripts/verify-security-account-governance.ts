import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getAccountGovernanceInfo, normalizeAccountDisplayName } from "@/lib/account-governance";
import { normalizeDisplayText } from "@/lib/display-normalization";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");

function asLatin1Mojibake(input: string): string {
  return String.fromCharCode(...new TextEncoder().encode(input));
}

async function createAdminToken(): Promise<string> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("users")
    .select("id, username, display_name")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || "No active admin account available");
  return createToken({
    userId: String(data.id),
    username: String(data.username),
    role: "admin",
    displayName: String(data.display_name || "验收管理员"),
    sessionId: `security-account-governance-${randomUUID()}`,
  });
}

async function readJson(pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0 CodexAccountGovernanceVerifier",
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  return { response, payload };
}

async function main() {
  const original = "充值10元=500积分";
  assert.equal(normalizeDisplayText(asLatin1Mojibake(original), "fallback"), original);

  const fixtureAccount = {
    username: "e2e_img_1786109129038",
    display_name: "E2E??????",
    email: "e2e_img_1786109129038@example.invalid",
    phone: "13909129038",
    allowed_categories: [],
    last_sign_in_at: null,
  };
  const governance = getAccountGovernanceInfo(fixtureAccount);
  assert.equal(governance.isFixture, true);
  assert.equal(governance.isSuspicious, true);
  assert.equal(normalizeAccountDisplayName(fixtureAccount), "E2E测试账号（已隔离）");

  const token = await createAdminToken();
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const users = await readJson("/api/admin/users?search=13909129038&pageSize=10", {
    headers: authHeaders,
  });
  assert.equal(users.response.status, 200);
  const target = users.payload.users?.[0];
  assert.ok(target, "fixture account should be visible for admin governance");
  assert.equal(target.accountFlags?.isFixture, true);
  assert.equal(target.accountKind, "fixture");

  const blockedCreate = await readJson("/api/admin/users", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      phone: "13988889999",
      email: `e2e_${Date.now()}@example.invalid`,
      password: "123456",
      displayName: "E2E测试账号",
      role: "student",
      credits: 0,
      allowedCategories: [],
    }),
  });
  assert.equal(blockedCreate.response.status, 400);

  const blockedRegister = await readJson("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email: `e2e_${Date.now()}@example.invalid`,
      phone: "13988889998",
      code: "000000",
      displayName: "E2E测试账号",
      password: "123456",
      invitationCode: "TESTCODE",
    }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(blockedRegister.response.status, 400);

  const idempotencyKey = `verify-${Date.now()}-${randomUUID()}`;
  const blockedCashTopup = await readJson("/api/admin/cash", {
    method: "POST",
    headers: { ...authHeaders, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      userId: target.id,
      amount: 0.01,
      description: "验证：测试账号不允许现金充值",
      idempotencyKey,
    }),
  });
  assert.equal(blockedCashTopup.response.status, 400);

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "mojibake-display-normalization",
      "fixture-account-detection",
      "admin-fixture-create-block",
      "public-register-fixture-block",
      "fixture-cash-topup-block",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
