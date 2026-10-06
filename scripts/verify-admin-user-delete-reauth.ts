import assert from "node:assert/strict";
import {
  ADMIN_USER_DELETE_REAUTH_TTL_SECONDS,
  createAdminUserAccountReauth,
  createAdminUserDeleteReauth,
  verifyAdminUserAccountReauth,
  verifyAdminUserDeleteReauth,
} from "../src/lib/admin-user-delete-reauth";

async function main() {
  const admin = { userId: "admin-delete-contract", sessionId: "session-a" };
  const before = Date.now();
  const verification = await createAdminUserDeleteReauth(admin);
  const after = Date.now();

  assert.ok(verification.token.length > 40, "DELETE_REAUTH_TOKEN_MISSING");
  assert.equal(verification.expiresInSeconds, ADMIN_USER_DELETE_REAUTH_TTL_SECONDS);
  assert.ok(
    verification.expiresAt >= before + ADMIN_USER_DELETE_REAUTH_TTL_SECONDS * 1000 - 1_000,
    "DELETE_REAUTH_EXPIRY_TOO_SHORT",
  );
  assert.ok(
    verification.expiresAt <= after + ADMIN_USER_DELETE_REAUTH_TTL_SECONDS * 1000 + 1_000,
    "DELETE_REAUTH_EXPIRY_TOO_LONG",
  );
  assert.equal(await verifyAdminUserDeleteReauth(verification.token, admin), true);
  assert.equal(
    await verifyAdminUserDeleteReauth(verification.token, { userId: "other-admin", sessionId: "session-a" }),
    false,
    "DELETE_REAUTH_MUST_BIND_ADMIN",
  );
  assert.equal(
    await verifyAdminUserDeleteReauth(verification.token, { userId: admin.userId, sessionId: "session-b" }),
    false,
    "DELETE_REAUTH_MUST_BIND_SESSION",
  );
  assert.equal(await verifyAdminUserDeleteReauth("invalid", admin), false);
  assert.equal(await verifyAdminUserDeleteReauth(null, admin), false);

  const accountRecovery = await createAdminUserAccountReauth(admin);
  assert.equal(await verifyAdminUserAccountReauth(accountRecovery.token, admin), true);
  assert.equal(
    await verifyAdminUserAccountReauth(accountRecovery.token, { ...admin, sessionId: "session-b" }),
    false,
    "ACCOUNT_REAUTH_MUST_BIND_SESSION",
  );
  assert.equal(
    await verifyAdminUserDeleteReauth(accountRecovery.token, admin),
    false,
    "ACCOUNT_REAUTH_MUST_NOT_AUTHORIZE_DELETE",
  );
  assert.equal(
    await verifyAdminUserAccountReauth(verification.token, admin),
    false,
    "DELETE_REAUTH_MUST_NOT_AUTHORIZE_ACCOUNT_RECOVERY",
  );

  console.log("admin user sensitive reauth contracts: PASS");
}

void main();
