import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  readUnifiedMessagingStatus,
  UnifiedMessagingStatusError,
  type UnifiedMessagingDatabaseClient,
} from "../src/lib/unified-messaging-control-plane";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20261002150000_unified_messaging_control_plane.sql"),
  "utf8",
);
const rollback = readFileSync(
  resolve(root, "supabase/rollbacks/20261002150000_unified_messaging_control_plane.rollback.sql"),
  "utf8",
);
const route = readFileSync(
  resolve(root, "src/app/api/admin/unified-messaging/status/route.ts"),
  "utf8",
);
const domain = readFileSync(
  resolve(root, "src/lib/unified-messaging-control-plane.ts"),
  "utf8",
);
const localVerifier = readFileSync(
  resolve(root, "scripts/verify-unified-messaging-control-plane-local.mjs"),
  "utf8",
);

const tables = [
  "message_templates",
  "message_surface_policies",
  "message_campaigns",
  "message_campaign_runs",
  "message_deliveries",
  "message_events",
  "message_outbox",
  "message_dead_letters",
] as const;

test("migration creates the complete stage-one control-plane boundary", () => {
  assert.match(migration, /^BEGIN;/u);
  assert.match(migration, /COMMIT;\s*$/u);
  for (const table of tables) {
    assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS public.${table}`), `missing ${table}`);
    assert.ok(migration.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`), `RLS missing for ${table}`);
    assert.ok(migration.includes(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated`), `direct grants not revoked for ${table}`);
  }
  assert.match(migration, /status text NOT NULL DEFAULT 'pending'.*'retry'.*'dead_letter'/su);
  assert.match(migration, /UNIQUE \(delivery_id, event_key\)/u);
  assert.match(migration, /idempotency_key text NOT NULL UNIQUE/u);
});

test("outbox functions provide idempotent enqueue, leased claims, retry, and dead-letter settlement", () => {
  for (const name of [
    "enqueue_message_outbox_atomic",
    "claim_message_outbox_batch",
    "settle_message_outbox_attempt",
    "get_unified_messaging_status",
  ]) {
    assert.ok(migration.includes(`FUNCTION public.${name}`), `missing ${name}`);
  }
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /MESSAGE_OUTBOX_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/u);
  assert.match(migration, /lease_token = gen_random_uuid\(\)/u);
  assert.match(migration, /v_next_status := 'retry'/u);
  assert.match(migration, /v_next_status := 'dead_letter'/u);
  assert.match(migration, /ON CONFLICT \(outbox_id\) DO NOTHING/u);
  assert.match(migration, /Business RPCs must call it inside the same database transaction/u);
});

test("migration does not bridge or backfill any legacy message chain", () => {
  const executableSql = migration.replace(/--[^\r\n]*/gu, "");
  for (const legacyTable of ["announcements", "user_notifications", "popup_pushes", "platform_settings"]) {
    assert.doesNotMatch(executableSql, new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|ALTER\\s+TABLE)\\s+public\\.${legacyTable}`, "iu"));
  }
});

test("rollback is transactional and refuses to erase durable evidence", () => {
  assert.match(rollback, /^BEGIN;/u);
  assert.match(rollback, /ROLLBACK_BLOCKED_UNIFIED_MESSAGING_EVIDENCE_EXISTS/u);
  assert.match(rollback, /COMMIT;\s*$/u);
  for (const table of tables) {
    assert.ok(rollback.includes(`SELECT 1 FROM public.${table}`), `rollback guard missing ${table}`);
    assert.ok(rollback.includes(`DROP TABLE IF EXISTS public.${table}`), `rollback drop missing ${table}`);
  }
});

test("local verifier is identity locked and always closes its outer transaction", () => {
  for (const fragment of [
    'runtime.localOnly, true',
    'runtime.ownerConnection?.host, "127.0.0.1"',
    'Number(runtime.ownerConnection?.port), 54322',
    'runtime.ownerConnection?.database, "zimeiti_local"',
    '--confirm-local-unified-messaging-control-plane',
    'await client.query("BEGIN")',
    'await client.query("ROLLBACK")',
    'persistentFixtures: 0',
    'migrationLedgerWrites: 0',
    'productionWrites: 0',
  ]) {
    assert.ok(localVerifier.includes(fragment), `local verifier missing ${fragment}`);
  }
  assert.match(localVerifier, /UNIFIED_MESSAGING_MIGRATION_ALREADY_APPLIED/u);
  assert.match(localVerifier, /ROLLBACK_BLOCKED_UNIFIED_MESSAGING_EVIDENCE_EXISTS/u);
  assert.match(localVerifier, /MESSAGE_OUTBOX_IDEMPOTENCY_CONFLICT/u);
});

test("admin status endpoint is authenticated, read only, and explicit about unavailable schema", () => {
  assert.match(route, /export async function GET/u);
  assert.match(route, /authorizeAdminCapability\(request, "announcements\.manage"/u);
  assert.match(route, /getSupabaseAdminClient\(\)/u);
  assert.match(route, /readUnifiedMessagingStatus/u);
  assert.match(route, /Cache-Control/u);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.doesNotMatch(route, /\.(?:insert|update|upsert|delete)\(/u);
  assert.equal(domain.includes('database.rpc("get_unified_messaging_status")'), true);
  assert.equal(domain.includes("legacyHistoryMigrated: false"), true);
  assert.equal(domain.includes("outboxWorkerConnected: false"), true);
  assert.equal(domain.includes("endUserSurfacesConnected: false"), true);
});

test("server domain normalizes a database receipt without overstating integrations", async () => {
  const database: UnifiedMessagingDatabaseClient = {
    async rpc(name) {
      assert.equal(name, "get_unified_messaging_status");
      return {
        error: null,
        data: {
          schemaVersion: 1,
          migration: "20261002150000",
          asOf: "2026-10-02T08:00:00.000Z",
          tableCounts: { templates: 2, campaigns: 1, outbox: 3 },
          outbox: { pending: 1, retry: 1, published: 1, oldestDueAt: "2026-10-02T07:59:00.000Z" },
          deliveries: { queued: 4, read: 2 },
          deadLetters: { open: 1 },
          surfacePolicies: { active: 2 },
        },
      };
    },
  };

  const status = await readUnifiedMessagingStatus(database);
  assert.equal(status.phase, "foundation_only");
  assert.equal(status.database.tableCounts.templates, 2);
  assert.equal(status.database.tableCounts.events, 0);
  assert.equal(status.database.outbox.due, 0);
  assert.deepEqual(status.integration.connectedLegacyChains, []);
  assert.deepEqual(status.integration.pendingLegacyChains, [
    "announcements",
    "account_notifications",
    "popup_pushes",
    "video_notifications",
  ]);
});

test("server domain fails closed when the migration is absent", async () => {
  const database: UnifiedMessagingDatabaseClient = {
    async rpc() {
      return {
        data: null,
        error: { code: "PGRST202", message: "Could not find public.get_unified_messaging_status" },
      };
    },
  };
  await assert.rejects(
    () => readUnifiedMessagingStatus(database),
    (error: unknown) => error instanceof UnifiedMessagingStatusError
      && error.code === "UNIFIED_MESSAGING_SCHEMA_REQUIRED",
  );
});
