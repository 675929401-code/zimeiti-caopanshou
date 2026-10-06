#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.resolve(root, relative), "utf8").replace(/^\uFEFF/u, "");
const migrationName = "20260929093000_announcement_account_delivery.sql";
const rollbackName = "20260929093000_announcement_account_delivery.rollback.sql";
const migration = read(`supabase/migrations/${migrationName}`);
const rollback = read(`supabase/rollbacks/${rollbackName}`);
const legacyRoute = read("src/app/api/announcements/route.ts");
const inboxRoute = read("src/app/api/announcements/inbox/route.ts");
const readRoute = read("src/app/api/announcements/[id]/read/route.ts");
const pushRoute = read("src/app/api/admin/announcements/[id]/push/route.ts");
const statusRoute = read("src/app/api/admin/announcements/[id]/delivery-status/route.ts");
const domain = read("src/lib/announcement-domain.ts");
const serverDomain = read("src/lib/announcement-delivery-server.ts");
const applyScript = read("scripts/apply-announcement-delivery-local.mjs");
const databaseVerifier = read("scripts/verify-announcement-delivery-local.mjs");

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
}

check("migration:transaction", /^BEGIN;/u.test(migration.trim()) && /COMMIT;\s*$/u.test(migration), "forward migration is atomic");
check("migration:account-reads", migration.includes("CREATE TABLE IF NOT EXISTS public.announcement_user_reads"), "per-account revision receipts exist");
check("migration:push-runs", migration.includes("CREATE TABLE IF NOT EXISTS public.announcement_push_runs"), "push runs are audited");
check("migration:first-publish-trigger", migration.includes("announcements_initialize_first_push") && migration.includes("NEW.push_revision := 1"), "first publication starts at revision 1");
check("migration:repush-cas", migration.includes("FOR UPDATE") && migration.includes("v_previous <> p_expected_revision") && migration.includes("ANNOUNCEMENT_REVISION_CONFLICT"), "repush uses row lock and expected revision");
check("migration:read-idempotency", migration.includes("ON CONFLICT (announcement_id, revision, user_id) DO NOTHING"), "read writes are idempotent");
check("migration:least-privilege", [
  "REVOKE ALL ON TABLE public.announcement_push_runs FROM PUBLIC, anon, authenticated",
  "REVOKE ALL ON TABLE public.announcement_user_reads FROM PUBLIC, anon, authenticated",
  "GRANT EXECUTE ON FUNCTION public.mark_announcement_read",
  "GRANT EXECUTE ON FUNCTION public.repush_announcement_atomic",
].every((fragment) => migration.includes(fragment)), "RLS and service-role-only permissions are declared");
check("rollback:evidence-guard", rollback.includes("ROLLBACK_BLOCKED_ANNOUNCEMENT_READ_EVIDENCE_EXISTS") && rollback.includes("ROLLBACK_BLOCKED_ANNOUNCEMENT_REPUSH_EVIDENCE_EXISTS"), "rollback refuses durable evidence deletion");
check("legacy-crud:compatible", ["export async function GET", "export async function POST", "export async function PUT", "export async function DELETE"].every((fragment) => legacyRoute.includes(fragment)), "existing CRUD methods remain");
check("legacy-crud:no-platform-settings", !legacyRoute.includes("platform_settings") && !serverDomain.includes("platform_settings"), "delivery truth no longer falls back to settings JSON");
check("schema:fail-closed", legacyRoute.includes("ANNOUNCEMENT_SELECT") && serverDomain.includes("ANNOUNCEMENT_SCHEMA_REQUIRED"), "missing migration returns explicit unavailable result");
check("inbox:authenticated", inboxRoute.includes("withAuth(request"), "inbox requires a current account");
check("inbox:read-only", !/\.(?:insert|update|upsert|delete|rpc)\(/u.test(inboxRoute), "polling has no write operation");
check("inbox:contract", ["announcements", "cursor", "serverTime", "unchanged", "readAt", "revision", "isRead"].every((fragment) => inboxRoute.includes(fragment)), "inbox returns revision-aware read state and cursor");
check("read:authenticated", readRoute.includes("withAuth(request") && readRoute.includes("mark_announcement_read"), "read receipt is account authenticated");
check("push:admin", pushRoute.includes("withAdminAuth(request") && pushRoute.includes("expectedRevision") && pushRoute.includes("repush_announcement_atomic"), "repush is admin-only CAS");
check("status:admin", statusRoute.includes("withAdminAuth(request") && statusRoute.includes("get_announcement_delivery_status"), "delivery status is admin-only");
check("status:pagination", ["pageSize", "read", "unread", "pagination"].every((fragment) => statusRoute.includes(fragment) || domain.includes(fragment)), "delivery status supports filters and bounded pagination");
check("domain:dto", ["push_revision", "first_published_at", "last_pushed_at", "AnnouncementInboxResponse", "AnnouncementDeliveryStatusResponse"].every((fragment) => domain.includes(fragment)), "shared DTOs expose revision fields");
check("local-apply:hard-target", [
  'runtime.localOnly, true',
  'runtime.ownerConnection?.host, "127.0.0.1"',
  'runtime.ownerConnection?.port), 54322',
  'runtime.ownerConnection?.database, "zimeiti_local"',
  "MIGRATION_LEDGER_HASH_CONFLICT",
  "--confirm-local-announcement-delivery",
].every((fragment) => applyScript.includes(fragment)), "single-migration runner is loopback-only, explicit and hash checked");
check("database-test:coverage", [
  "FIRST_PUBLICATION_REVISION_MUST_BE_ONE",
  "ORDINARY_EDIT_MUST_NOT_REPUSH",
  "IDEMPOTENT_READ_TIMESTAMP_MUST_BE_STABLE",
  "ACCOUNT_READ_STATE_MUST_BE_ISOLATED",
  "CAS_CONCURRENCY_MUST_HAVE_ONE_WINNER",
].every((fragment) => databaseVerifier.includes(fragment)), "local database verifier covers required state and concurrency cases");

const failed = checks.filter((item) => !item.passed);
const report = {
  passed: failed.length === 0,
  migration: migrationName,
  migrationSha256: crypto.createHash("sha256").update(migration).digest("hex"),
  rollback: rollbackName,
  summary: { passed: checks.length - failed.length, total: checks.length },
  failed,
  checks,
  databaseWrites: 0,
  productionWrites: 0,
  providerRequests: 0,
};
console.log(JSON.stringify(report, null, 2));
assert.equal(failed.length, 0, "ANNOUNCEMENT_DELIVERY_CONTRACT_VERIFICATION_FAILED");
