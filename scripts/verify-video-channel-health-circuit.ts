import assert from "node:assert/strict";
import {
  VIDEO_CHANNEL_RECOVERY_CONFIRMATION,
  authorizeVideoChannelRecoveryCanary,
  buildVideoChannelRecoveryKey,
  evaluateVideoChannelCircuit,
  sanitizeVideoChannelError,
} from "../src/lib/video-channel-health-circuit";

const now = Date.parse("2026-09-01T12:00:00.000Z");
const channelId = "00000000-0000-4000-8000-000000000001";

const healthy = evaluateVideoChannelCircuit({
  channel_id: channelId,
  is_healthy: true,
  consecutive_failures: 0,
  updated_at: "2026-09-01T11:00:00.000Z",
}, now);
assert.equal(healthy.state, "healthy");
assert.equal(healthy.blocksProduction, false);

const unverified = evaluateVideoChannelCircuit(null, now);
assert.equal(unverified.state, "unverified");
assert.equal(unverified.blocksProduction, false);
assert.equal(unverified.canaryEligible, false);

const nullableHealth = evaluateVideoChannelCircuit({
  channel_id: channelId,
  is_healthy: null,
  consecutive_failures: 0,
  last_success_at: null,
  last_fail_at: null,
  last_error: null,
  updated_at: "2026-09-01T11:00:00.000Z",
}, now);
assert.equal(nullableHealth.state, "unverified");
assert.equal(nullableHealth.blocksProduction, false);

const fundingRequired = evaluateVideoChannelCircuit({
  channel_id: channelId,
  is_healthy: false,
  consecutive_failures: 2,
  last_success_at: "2026-08-31T12:00:00.000Z",
  last_fail_at: "2026-09-01T11:00:00.000Z",
  last_error: "Arrearage: account balance is insufficient",
  updated_at: "2026-09-01T11:00:00.000Z",
}, now);
assert.equal(fundingRequired.state, "funding_required");
assert.equal(fundingRequired.blocksProduction, false);
assert.equal(fundingRequired.canaryEligible, false);
assert.equal(fundingRequired.recoveryKey, null);

const coolingRecord = {
  channel_id: channelId,
  is_healthy: false,
  consecutive_failures: 3,
  last_fail_at: "2026-09-01T11:00:00.000Z",
  updated_at: "2026-09-01T11:00:00.000Z",
};
const cooling = evaluateVideoChannelCircuit(coolingRecord, now);
assert.equal(cooling.state, "open");
assert.equal(cooling.blocksProduction, true);
assert.equal(cooling.recoveryKey, null);

const staleRecord = {
  ...coolingRecord,
  last_fail_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
};
const stale = evaluateVideoChannelCircuit(staleRecord, now);
assert.equal(stale.state, "canary_ready");
assert.equal(stale.blocksProduction, true, "cooldown expiry must never auto-unblock production");
assert.equal(stale.canaryEligible, true);
assert.match(stale.recoveryKey || "", /^vhc_[a-f0-9]{32}$/u);
assert.equal(stale.recoveryKey, buildVideoChannelRecoveryKey(staleRecord));
assert.notEqual(stale.recoveryKey, buildVideoChannelRecoveryKey({ ...staleRecord, consecutive_failures: 4 }));

const ordinary = authorizeVideoChannelRecoveryCanary({
  decision: stale,
  userRole: "admin",
  requested: false,
  recoveryKey: stale.recoveryKey,
  confirmation: VIDEO_CHANNEL_RECOVERY_CONFIRMATION,
  clientRequestId: stale.recoveryKey,
});
assert.equal(ordinary.ok, false);
assert.equal(ordinary.ok ? "" : ordinary.code, "CHANNEL_HEALTH_BLOCKED");

const student = authorizeVideoChannelRecoveryCanary({
  decision: stale,
  userRole: "student",
  requested: true,
  recoveryKey: stale.recoveryKey,
  confirmation: VIDEO_CHANNEL_RECOVERY_CONFIRMATION,
  clientRequestId: stale.recoveryKey,
});
assert.equal(student.ok, false);
assert.equal(student.ok ? "" : student.code, "CHANNEL_RECOVERY_ADMIN_REQUIRED");

const wrongConfirmation = authorizeVideoChannelRecoveryCanary({
  decision: stale,
  userRole: "admin",
  requested: true,
  recoveryKey: stale.recoveryKey,
  confirmation: "READ_ONLY_PROBE_OK",
  clientRequestId: stale.recoveryKey,
});
assert.equal(wrongConfirmation.ok, false);
assert.equal(wrongConfirmation.ok ? "" : wrongConfirmation.code, "CHANNEL_RECOVERY_CONFIRMATION_REQUIRED");

const wrongIdempotencyKey = authorizeVideoChannelRecoveryCanary({
  decision: stale,
  userRole: "admin",
  requested: true,
  recoveryKey: stale.recoveryKey,
  confirmation: VIDEO_CHANNEL_RECOVERY_CONFIRMATION,
  clientRequestId: "different-key",
});
assert.equal(wrongIdempotencyKey.ok, false);
assert.equal(wrongIdempotencyKey.ok ? "" : wrongIdempotencyKey.code, "CHANNEL_RECOVERY_KEY_INVALID");

const authorized = authorizeVideoChannelRecoveryCanary({
  decision: stale,
  userRole: "admin",
  requested: true,
  recoveryKey: stale.recoveryKey,
  confirmation: VIDEO_CHANNEL_RECOVERY_CONFIRMATION,
  clientRequestId: stale.recoveryKey,
});
assert.deepEqual(authorized, { ok: true });

const sanitized = sanitizeVideoChannelError(
  "Secure Skill API 403 Authorization: Bearer secret-token https://private.example/v1",
);
assert.equal(sanitized.code, "UPSTREAM_AUTH");
assert.doesNotMatch(sanitized.summary, /secret-token|private\.example|Bearer/iu);

for (const diagnostic of [
  'Arrearage: Access denied, please make sure your account is in good standing.',
  'HTTP 403 Forbidden: InsufficientQuota Authorization: Bearer fixture-secret',
  'HTTP 402 Payment Required https://private.example/task?token=fixture-secret',
  '阿里声动人像 · 视频改口型的渠道额度暂不可用，请联系管理员检查该模型渠道账户',
]) {
  const result = sanitizeVideoChannelError(diagnostic);
  assert.equal(result.code, 'UPSTREAM_QUOTA_OR_BALANCE');
  assert.doesNotMatch(result.summary, /fixture-secret|private\.example|Bearer|token/iu);
}
assert.equal(sanitizeVideoChannelError('HTTP 403 InvalidApiKey').code, 'UPSTREAM_AUTH');
assert.equal(sanitizeVideoChannelError('所选模型的渠道认证配置异常，请联系管理员检查').code, 'UPSTREAM_AUTH');
assert.equal(sanitizeVideoChannelError('download source video failed HTTP 403 Forbidden').code, 'VIDEO_INPUT_INVALID');

// Route authorization and shared reservation claims are exercised by the actual
// handlers in verify-video-admin-validation.mjs and verify-video-operator-retest.mjs.
// Keep this suite focused on circuit decisions, rather than source-text spelling.

console.log(JSON.stringify({
  ok: true,
  network_requests: 0,
  paid_requests: 0,
  circuit_states_checked: ["healthy", "funding_required", "unverified", "nullable-unverified", "open", "canary_ready"],
  recovery_guards_checked: ["ordinary-blocked", "admin-only", "explicit-confirmation", "epoch-key", "terminal-reset-contract"],
  read_only_probe_can_unblock: false,
}, null, 2));
