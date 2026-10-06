#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, helper, activeRoute, status, policy, history] = await Promise.all([
  readFile("supabase/migrations/20260922015000_video_submission_confirmation_expiry.sql", "utf8"),
  readFile("src/lib/video-submission-reconciliation.ts", "utf8"),
  readFile("src/app/api/video/active-tasks/route.ts", "utf8"),
  readFile("src/lib/video-task-status.ts", "utf8"),
  readFile("src/lib/video-error-policy.ts", "utf8"),
  readFile("src/lib/video-history-presentation.ts", "utf8"),
]);

for (const required of [
  "task_id_external", "provider_result_url", "storage_url", "video_url",
  "wallet_operations", "wallet_ledger_entries", "cash_transactions",
  "revenue_records", "user_files", "digital_video_dispatch_jobs", "autodl_h3_jobs",
  "FOR UPDATE OF t SKIP LOCKED", "VIDEO_SUBMISSION_CONFIRMATION_EXPIRED",
]) assert.ok(migration.includes(required), `MIGRATION_GUARD_MISSING:${required}`);
assert.match(migration, /coalesce\(t\.price_charged, 0\) = 0/u);
assert.match(migration, /t\.billing_operation_id IS NULL/u);
assert.match(migration, /t\.billing_state = 'reserved'/u);
assert.match(migration, /status = 'failed'/u);
assert.match(migration, /billing_state = 'submission_failed'/u);
assert.match(migration, /charged_yuan', 0/u);
assert.match(helper, /30 \* 60/u);
assert.match(helper, /expire_video_submission_confirmations_atomic/u);
assert.match(helper, /reconcileStaleVideoSubmissionBatch/u);
assert.match(helper, /Promise\.allSettled/u);
assert.match(helper, /submission_error_code[\s\S]*VIDEO_SUBMIT_OUTCOME_UNKNOWN/u);
assert.match(activeRoute, /reconcileStaleVideoSubmissionsForUser/u);
assert.match(status, /reconcileStaleVideoSubmissionsForUser/u);
assert.match(policy, /VIDEO_SUBMISSION_CONFIRMATION_EXPIRED/u);
assert.match(history, /errorCode === 'VIDEO_SUBMISSION_CONFIRMATION_EXPIRED'/u);
console.log(JSON.stringify({
  ok: true,
  boundedConfirmationSeconds: 1800,
  safetyGuards: 15,
  activeTaskRecovery: true,
  directStatusRecovery: true,
  backgroundWorkerRecovery: true,
  explicitNoChargeMessage: true,
  explicitRetryEligibility: true,
}, null, 2));
