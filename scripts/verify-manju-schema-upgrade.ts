import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MANJU_SCHEMA_UPGRADE_DOMAINS,
  ManjuSchemaUpgradeError,
  buildSchema11Payload,
  parseLocalHostAllowlist,
  parseUpgradeArguments,
  validateProtectedTarget,
  validateServiceRoleJwt,
} from "./upgrade-manju-config-schema";

const root = process.cwd();
const upgradePath = resolve(root, "scripts/upgrade-manju-config-schema.ts");
const source = readFileSync(upgradePath, "utf8");
const compact = source.replace(/\s+/gu, "");
const checks: Array<{ name: string; ok: true }> = [];

function check(name: string, assertion: () => void): void {
  assertion();
  checks.push({ name, ok: true });
}

function expectUpgradeError(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => (
    error instanceof ManjuSchemaUpgradeError && error.code === code
  ));
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function serviceRoleJwt(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    encodeJwtPart({ alg: "HS256", typ: "JWT" }),
    encodeJwtPart({ role: "service_role", exp: now + 3600, ...overrides }),
    Buffer.alloc(32, 7).toString("base64url"),
  ].join(".");
}

check("source:default-dry-run-and-domain-selection", () => {
  assert.match(source, /if \(!args\.apply\) return;/u);
  assert.match(source, /--domain=/u);
  assert.match(source, /--domain/u);
  assert.deepEqual(parseUpgradeArguments([]), {
    apply: false,
    confirmedTargetHost: "",
    domains: [...MANJU_SCHEMA_UPGRADE_DOMAINS],
  });
  assert.deepEqual(parseUpgradeArguments(["--domain=media"]).domains, ["media"]);
  assert.deepEqual(parseUpgradeArguments(["--domain", "prompt"]).domains, ["prompt"]);
  expectUpgradeError(
    "MANJU_SCHEMA_UPGRADE_DOMAIN_REJECTED",
    () => parseUpgradeArguments(["--domain=agent"]),
  );
});

check("target:https-exact-confirmation-service-role-and-local-allowlist", () => {
  const host = "project.aidap-global.cn-beijing.volces.com";
  const jwt = serviceRoleJwt();
  const allowlist = parseLocalHostAllowlist(host);
  validateServiceRoleJwt(jwt);
  assert.deepEqual(validateProtectedTarget({
    rawUrl: `https://${host}/`,
    serviceRoleJwt: jwt,
    apply: true,
    confirmedTargetHost: host,
    localAllowedHosts: allowlist,
  }), { host, locallyAllowlisted: true });
  expectUpgradeError(
    "MANJU_SCHEMA_UPGRADE_TARGET_REJECTED",
    () => validateProtectedTarget({
      rawUrl: `http://${host}/`,
      serviceRoleJwt: jwt,
      apply: false,
      confirmedTargetHost: "",
      localAllowedHosts: allowlist,
    }),
  );
  expectUpgradeError(
    "MANJU_SCHEMA_UPGRADE_TARGET_CONFIRMATION_REQUIRED",
    () => validateProtectedTarget({
      rawUrl: `https://${host}/`,
      serviceRoleJwt: jwt,
      apply: true,
      confirmedTargetHost: "",
      localAllowedHosts: allowlist,
    }),
  );
  expectUpgradeError(
    "MANJU_SCHEMA_UPGRADE_LOCAL_ALLOWLIST_REQUIRED",
    () => validateProtectedTarget({
      rawUrl: `https://${host}/`,
      serviceRoleJwt: jwt,
      apply: true,
      confirmedTargetHost: host,
      localAllowedHosts: new Set(),
    }),
  );
  expectUpgradeError(
    "MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_REQUIRED",
    () => validateServiceRoleJwt(serviceRoleJwt({ role: "authenticated" })),
  );
  expectUpgradeError(
    "MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_EXPIRED",
    () => validateServiceRoleJwt(serviceRoleJwt({ exp: 1 })),
  );
  validateServiceRoleJwt(serviceRoleJwt({ iss: "supabase" }));
  validateServiceRoleJwt(
    serviceRoleJwt({ iss: `https://${host}/auth/v1` }),
    Date.now(),
    host,
  );
  expectUpgradeError(
    "MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_ISSUER_INVALID",
    () => validateServiceRoleJwt(
      serviceRoleJwt({ iss: "https://evil.example/auth/v1" }),
      Date.now(),
      host,
    ),
  );
  expectUpgradeError(
    "MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_ISSUER_INVALID",
    () => validateServiceRoleJwt(serviceRoleJwt({ iss: "evil\u0000issuer" })),
  );
});

check("payload:additive-upgrade-preserves-legal-user-values", () => {
  const prompt = buildSchema11Payload("prompt", {
    custom_policy: "keep-user-value",
  });
  assert.equal(prompt.payload.custom_policy, "keep-user-value");
  assert.ok(prompt.addedPaths.includes("$.runtime_prompts"));

  const content = buildSchema11Payload("content", {
    brand: "用户品牌",
  });
  assert.equal(content.payload.brand, "用户品牌");
  assert.equal(content.payload.account_route, "/youcai/profile");
  assert.ok(Array.isArray(content.payload.navigation));

  const media = buildSchema11Payload("media", {
    user_media_policy: "keep-user-value",
  });
  assert.equal(media.payload.user_media_policy, "keep-user-value");
  assert.ok(media.addedPaths.includes("$.showcase_catalog"));

  const featureFlags = buildSchema11Payload("feature_flags", {
    canvas: false,
  });
  assert.equal(featureFlags.payload.canvas, false);
  assert.equal(featureFlags.payload.assets, true);
});

check("payload:illegal-existing-fields-fail-without-silent-deletion", () => {
  assert.throws(() => buildSchema11Payload("content", {
    brand: "用户品牌",
    retired_unknown_field: "must-not-be-silently-dropped",
  }));
  assert.throws(() => buildSchema11Payload("feature_flags", {
    canvas: "not-a-boolean",
  }));
});

check("source:legacy-compat-zero-and-native-generation-cas", () => {
  assert.match(source, /\.from\("manju_config_storage_state"\)/u);
  assert.match(source, /Number\(row\.generation\) < 0/u);
  assert.match(source, /generation:\s*0/u);
  assert.match(source, /scope\.authority\.generation === 0/u);
  assert.match(source, /MANJU_SCHEMA_UPGRADE_STORAGE_GENERATION_INVALID/u);
  assert.match(source, /MANJU_SCHEMA_UPGRADE_NATIVE_WRITE_PRECONDITION_INVALID/u);
  assert.match(source, /assertSameAuthority/u);
  assert.match(source, /assertSameActive/u);
  assert.match(source, /p_expected_generation: scope\.authority\.generation/u);
  assert.match(source, /p_expected_storage_revision: scope\.compat\.storageRevision/u);
  assert.match(source, /p_expected_active_release_id: scope\.active\.release\.id/u);
});

check("source:save-publish-reread-and-idempotency", () => {
  assert.match(source, /commit_manju_config_compat_envelope/u);
  assert.match(source, /save_manju_config_draft/u);
  assert.match(source, /publish_manju_config_revision/u);
  assert.match(source, /publish-existing-draft/u);
  assert.match(source, /action: "current"/u);
  assert.match(source, /const afterDraft = await loadScope/u);
  assert.match(source, /const beforePublish = await loadScope/u);
  assert.match(source, /const afterPublish = await loadScope/u);
  assert.match(source, /MANJU_SCHEMA_UPGRADE_POSTPUBLISH_VERIFICATION_FAILED/u);
});

check("source:legacy-compat-update-only-no-destructive-writes", () => {
  assert.match(compact, /\.from\("platform_settings"\)\.update\(/u);
  assert.doesNotMatch(compact, /\.from\("platform_settings"\)\.(?:insert|upsert|delete)\(/u);
  assert.doesNotMatch(source, /rollback_manju_config_release|rollbackManjuCompatRelease/u);
  assert.doesNotMatch(compact, /\.from\("manju_config_(?:active|revisions|releases)"\)\.(?:insert|update|upsert|delete)\(/u);
});

check("source:durable-recovery-without-automatic-rollback", () => {
  assert.match(source, /manju-schema-upgrade-recovery\.v1/u);
  assert.match(source, /automatic_rollback_attempted: false/u);
  assert.match(source, /previous_release_id/u);
  assert.match(source, /previous_revision_id/u);
  assert.match(source, /expected_storage_generation/u);
  assert.match(source, /expected_active_release_id/u);
  assert.match(source, /writeCheckpoint/u);
});

console.log(JSON.stringify({
  ok: true,
  verifier: "verify-manju-schema-upgrade",
  network_requests: 0,
  database_writes: 0,
  checks,
}, null, 2));
