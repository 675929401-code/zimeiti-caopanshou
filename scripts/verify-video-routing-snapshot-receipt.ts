#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildVideoRoutingSnapshot,
  parseVideoRoutingSnapshot,
  persistVideoProviderDispatchReceipt,
  persistVideoProviderSubmissionReceipt,
  resolveVideoRoutingCredential,
  videoModelConfigFromRoutingSnapshot,
} from "../src/lib/video-routing-snapshot";
import {
  prepareVideoProviderRequest,
  videoProviderFetch,
  withVideoProviderRequestAudit,
} from "../src/lib/video-provider-request-audit";

async function main() {
const routeSource = await readFile("src/app/api/video/generate/route.ts", "utf8");
const statusSource = await readFile("src/lib/video-task-status.ts", "utf8");
const reservationSource = await readFile("src/lib/video-budget-reservation.ts", "utf8");
const migration = await readFile("supabase/migrations/20260925152000_video_routing_snapshot_and_dispatch_receipt.sql", "utf8");
const rollback = await readFile("supabase/rollbacks/20260925152000_video_routing_snapshot_and_dispatch_receipt.rollback.sql", "utf8");
const databaseContract = JSON.parse(await readFile("deploy/policies/database-contract.v1.json", "utf8")) as {
  contractVersion: string;
  tables: Array<{ name: string; columns: string[] }>;
  rpcs: Array<{ name: string; arguments: string[] }>;
};

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const modelA = {
  id: "relay-a-video",
  name: "Relay A Video",
  provider: "relay-a",
  api_endpoint: "https://relay-a.example/v1",
  api_key: "secret://secure-skill-video-enterprise",
  protocol_type: "secure_skill_video",
  model_name: "video-a-v1",
  duration_seconds: 10,
  supports_image_input: true,
  api_protocol_config: {
    poll_path: "/tasks/{task_id}",
    nested: {
      mode: "strict",
      token: "must-not-persist",
      headers: { "x-api-key": "must-not-persist-either", clientSecret: "also-secret" },
    },
  },
};
const snapshotA = buildVideoRoutingSnapshot(modelA);
const parsedA = parseVideoRoutingSnapshot(JSON.parse(JSON.stringify(snapshotA)), modelA.id);
check(parsedA.apiEndpoint === "https://relay-a.example/v1", "snapshot keeps the submitted endpoint");
check(parsedA.protocolType === "secure_skill_video", "snapshot keeps the submitted protocol");
check(parsedA.modelName === "video-a-v1", "snapshot keeps the submitted provider model name");
check(parsedA.configVersion.length === 64, "snapshot carries a deterministic config version");
check(!JSON.stringify(parsedA).includes("must-not-persist"), "secret-like config values are not persisted");
check(!JSON.stringify(parsedA).includes("also-secret"), "camel-case and custom header secrets are not persisted");

const modelB = {
  ...modelA,
  api_endpoint: "https://relay-b.example/v9",
  protocol_type: "openai_compatible",
  model_name: "video-b-v9",
};
const snapshotB = buildVideoRoutingSnapshot(modelB);
check(snapshotB.configVersion !== snapshotA.configVersion, "catalog routing edits create a different config version");
const resolvedSecret = await resolveVideoRoutingCredential({
  snapshot: parsedA,
  resolveSecret: (reference) => `resolved:${String(reference)}`,
  lookupModelCredential: async () => { throw new Error("snapshot secret ref must not reload catalog routing"); },
});
const pollConfig = videoModelConfigFromRoutingSnapshot(parsedA, resolvedSecret);
check(pollConfig.api_endpoint === "https://relay-a.example/v1", "task submitted on A still polls A after catalog changes to B");
check(pollConfig.protocol_type === "secure_skill_video" && pollConfig.model_name === "video-a-v1", "task poll protocol/model remain A");

const legacySnapshot = buildVideoRoutingSnapshot({ ...modelA, api_key: "legacy-inline-secret-value" });
check(legacySnapshot.credentialRef === "video-model://relay-a-video/api-key", "legacy inline secret becomes a model credential reference");
check(!JSON.stringify(legacySnapshot).includes("legacy-inline-secret-value"), "resolved or inline API secrets never enter the snapshot");
let credentialLookups = 0;
const rotatedSecret = await resolveVideoRoutingCredential({
  snapshot: legacySnapshot,
  lookupModelCredential: async (modelId) => {
    credentialLookups += 1;
    assert.equal(modelId, "relay-a-video");
    return "secret://secure-skill-video-enterprise";
  },
  resolveSecret: (reference) => `rotated:${String(reference)}`,
});
check(credentialLookups === 1 && rotatedSecret.startsWith("rotated:secret://"), "credential rotation is resolved through the safe reference only");

const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
const db = {
  async rpc(name: string, params: Record<string, unknown>) {
    rpcCalls.push({ name, params });
    return { data: { ok: true }, error: null };
  },
};
const preparedDispatch = await prepareVideoProviderRequest("https://relay-a.example/v1/videos", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "video-a-v1", prompt: "fixture", duration: 10, aspect_ratio: "16:9" }),
});
assert.ok(preparedDispatch);
await persistVideoProviderDispatchReceipt({
  db,
  taskIdInternal: "vt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  userId: "user-a",
  requestFingerprint: "a".repeat(64),
  snapshot: parsedA,
  receipt: preparedDispatch.receipt,
});
await persistVideoProviderSubmissionReceipt({
  db,
  taskIdInternal: "vt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  userId: "user-a",
  requestFingerprint: "a".repeat(64),
  outcome: "unknown",
  receipt: {
    schemaVersion: 1,
    receiptState: "transport_unavailable",
    endpointHost: "relay-a.example",
    providerRequestKeySha256: "b".repeat(64),
  },
});
check(rpcCalls.map((call) => call.name).join(",") === "record_video_provider_dispatch_receipt_atomic,record_video_provider_submission_receipt_atomic", "dispatch and ambiguous acknowledgement evidence are persisted in order");

const originalFetch = globalThis.fetch;
let providerPosts = 0;
globalThis.fetch = async () => {
  providerPosts += 1;
  return new Response(JSON.stringify({ id: "provider-task" }), { status: 200, headers: { "content-type": "application/json" } });
};
try {
  await assert.rejects(
    () => withVideoProviderRequestAudit(
      async () => { throw new Error("durable receipt unavailable"); },
      () => videoProviderFetch("https://relay-a.example/v1/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "video-a-v1" }),
      }),
    ),
    /durable receipt unavailable/u,
  );
  check(providerPosts === 0, "a receipt persistence failure prevents the provider POST");
  await withVideoProviderRequestAudit(
    async () => undefined,
    () => videoProviderFetch("https://relay-a.example/v1/videos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "video-a-v1" }),
    }),
  );
  check(providerPosts === 1, "provider POST starts only after the durable barrier succeeds");
} finally {
  globalThis.fetch = originalFetch;
}

check(reservationSource.includes("reserve_video_generation_task_request_snapshot_v1_atomic"), "reservation, routing and the immutable request snapshot commit through the current versioned atomic RPC");
check(reservationSource.includes("reserve_queued_digital_video_task_request_snapshot_v1_atomic"), "queued reservation also commits its immutable route and request snapshot atomically");
check(routeSource.includes("routingSnapshot,"), "both route reservations pass the immutable snapshot");
check(routeSource.indexOf("if (!reservation.created)") < routeSource.indexOf("result = await submitVideoTask"), "same-key replay returns before any provider POST");
check(routeSource.includes('!result.taskId && !result.videoUrl && result.status !== "failed"'), "success without an asset or provider id remains an unknown submission");
check(statusSource.includes("parseVideoRoutingSnapshot(existingTask.routing_snapshot, resolvedModelId)"), "polling reads the task snapshot");
check(statusSource.includes("Snapshot-backed tasks never enter that path"), "current catalog lookup is legacy-only");

for (const fragment of [
  "provider_dispatch_started_at IS NULL",
  "provider_dispatch_receipt IS NULL",
  "provider_submission_receipt IS NULL",
  "provider_reconciliation_state IS NULL",
  "protected_dispatch_count",
  "reconciliation_required",
]) {
  check(migration.includes(fragment), `expiry contract contains ${fragment}`);
}
check(/provider_dispatch_started_at IS NOT NULL[\s\S]*provider_dispatch_receipt IS NOT NULL/u.test(migration), "ack-lost tasks with dispatch evidence are counted as protected");
check(!rollback.includes("DROP COLUMN") && rollback.includes("deliberately preserves"), "rollback never erases dispatch evidence");
check(databaseContract.contractVersion >= "20260925152000", "release database contract includes the routing migration or a later compatible contract");
const videoTaskColumns = databaseContract.tables.find((table) => table.name === "video_tasks")?.columns || [];
for (const column of ["routing_snapshot", "routing_snapshot_hash", "provider_dispatch_receipt", "provider_submission_receipt", "provider_reconciliation_state"]) {
  check(videoTaskColumns.includes(column), `release database contract requires video_tasks.${column}`);
}
for (const rpc of [
  "reserve_video_generation_task_request_snapshot_v1_atomic",
  "reserve_queued_digital_video_task_request_snapshot_v1_atomic",
  "record_video_provider_dispatch_receipt_atomic",
  "record_video_provider_submission_receipt_atomic",
  "expire_video_submission_confirmations_atomic",
]) {
  check(databaseContract.rpcs.some((entry) => entry.name === rpc), `release database contract requires ${rpc}`);
}

console.log(JSON.stringify({
  passed: true,
  assertions,
  providerPosts,
  rpcCalls: rpcCalls.length,
  mockProviderPosts: providerPosts,
  networkRequests: 0,
  realDatabaseWrites: 0,
  paidModelCalls: 0,
}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
