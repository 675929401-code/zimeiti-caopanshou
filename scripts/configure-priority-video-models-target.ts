import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

import {
  buildPriorityVideoModelPlan,
  NEW_MODEL_IDS,
  EXISTING_PRICE_IDS,
  VEO_COMPONENTS_ID,
  type VideoModelRecord,
} from "./configure-priority-video-models-local";

type JsonRecord = Record<string, unknown>;

const APPLY_CONFIRMATION = "AUTHORIZE_PRIORITY_VIDEO_MODELS_PRODUCTION_20260917";

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function publicRow(row: VideoModelRecord) {
  const { api_key: credential, api_protocol_config: config, ...safe } = row;
  return {
    ...safe,
    credentialReferenceConfigured: String(credential || "").startsWith("secret://"),
    credentialReferenceSha256: createHash("sha256").update(String(credential || "")).digest("hex"),
    api_protocol_config: {
      ...record(config),
      __model_activation_gate: record(record(config).__model_activation_gate).state || null,
    },
  };
}

function persistedShape(actual: VideoModelRecord | undefined, target: VideoModelRecord) {
  if (!actual) return undefined;
  return Object.fromEntries(Object.keys(target).map((key) => [key, actual[key]]));
}

function parseArguments(argumentsList: string[]) {
  const apply = argumentsList.includes("--apply");
  const includeVeoTierUpdate = argumentsList.includes("--include-veo-tier-update");
  const unknown = argumentsList.filter((entry) => !["--apply", "--include-veo-tier-update"].includes(entry));
  assert.deepEqual(unknown, [], `Unknown arguments: ${unknown.join(", ")}`);
  return { apply, includeVeoTierUpdate };
}

export function selectPriorityVideoProductionTargets(
  before: VideoModelRecord[],
  includeVeoTierUpdate = false,
) {
  const plan = buildPriorityVideoModelPlan(before);
  assert.deepEqual(plan.missingExistingIds, [], `Required existing models are missing: ${plan.missingExistingIds.join(", ")}`);
  const safeTargetIds = new Set<string>([...NEW_MODEL_IDS, ...EXISTING_PRICE_IDS]);
  if (includeVeoTierUpdate) safeTargetIds.add(VEO_COMPONENTS_ID);
  const targets = plan.after.filter((row) => safeTargetIds.has(row.id));
  for (const row of targets) {
    assert.ok(String(row.api_key || "").startsWith("secret://"), `${row.id} must store only a secret reference`);
  }
  return { plan, safeTargetIds, targets };
}

async function main() {
  const { apply, includeVeoTierUpdate } = parseArguments(process.argv.slice(2));
  const url = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "").trim();
  const releaseVersion = String(process.env.DEPLOY_RELEASE_VERSION || "").trim();
  const sourceVersion = String(process.env.DEPLOY_SOURCE_VERSION || "").trim();
  assert.ok(/^https:\/\//u.test(url), "REMOTE_HTTPS_SUPABASE_URL_REQUIRED");
  assert.ok(!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/u.test(url), "LOCAL_DATABASE_FORBIDDEN");
  assert.ok(serviceRoleKey.length >= 32, "SUPABASE_SERVICE_ROLE_KEY_REQUIRED");
  assert.match(releaseVersion, /^V[1-9]\d*\.[1-9]\d*$/u, "DEPLOY_RELEASE_VERSION_REQUIRED");
  assert.match(sourceVersion, /^R\d{6}-\d{8}-[a-f0-9]{8}$/u, "DEPLOY_SOURCE_VERSION_REQUIRED");

  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const beforeResult = await db.from("video_models").select("*").order("id");
  if (beforeResult.error) throw beforeResult.error;
  const before = (beforeResult.data || []) as VideoModelRecord[];
  // Existing VEO tier semantics changed and therefore require their own real
  // canary. A normal production configuration sync must not hide an existing
  // working VEO row. It is opt-in until that evidence exists.
  const { safeTargetIds, targets } = selectPriorityVideoProductionTargets(before, includeVeoTierUpdate);

  const result = {
    schemaVersion: 1,
    target: "production",
    mode: apply ? "apply" : "plan",
    releaseVersion,
    sourceVersion,
    includeVeoTierUpdate,
    targetIds: targets.map((row) => row.id).sort(),
    models: targets.map(publicRow),
    secretsPrinted: false,
    providerRequests: 0,
    paidGenerationCalls: 0,
  };

  if (!apply) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  assert.equal(process.platform, "linux", "PRODUCTION_APPLY_REQUIRES_LINUX_SERVER");
  assert.equal(process.env.PRIORITY_VIDEO_MODEL_PRODUCTION_APPLY, APPLY_CONFIRMATION, "PRODUCTION_APPLY_CONFIRMATION_REQUIRED");
  const sharedRoot = path.resolve(String(process.env.DEPLOY_SHARED_ROOT || "/data/web/shared"));
  assert.ok(sharedRoot === "/data/web/shared" || sharedRoot.startsWith("/data/web/shared/"), "EXACT_PRODUCTION_SHARED_ROOT_REQUIRED");
  const receiptDirectory = path.join(sharedRoot, "backups", "config", `${releaseVersion}-priority-video-models`);
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(receiptDirectory, "before.sanitized.json"), `${JSON.stringify({
    schemaVersion: 1,
    releaseVersion,
    sourceVersion,
    createdAt: new Date().toISOString(),
    rows: before.filter((row) => safeTargetIds.has(row.id)).map(publicRow),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const write = await db.from("video_models").upsert(targets, { onConflict: "id" });
  if (write.error) throw write.error;
  const afterResult = await db.from("video_models").select("*").order("id");
  if (afterResult.error) throw afterResult.error;
  const actual = (afterResult.data || []) as VideoModelRecord[];
  const actualById = new Map(actual.map((row) => [row.id, row]));
  for (const target of targets) {
    assert.equal(stable(persistedShape(actualById.get(target.id), target)), stable(target), `${target.id} write verification failed`);
  }
  assert.equal(
    stable(actual.filter((row) => !safeTargetIds.has(row.id))),
    stable(before.filter((row) => !safeTargetIds.has(row.id))),
    "A non-target production video model changed",
  );
  await writeFile(path.join(receiptDirectory, "receipt.sanitized.json"), `${JSON.stringify({
    ...result,
    mode: "applied",
    appliedAt: new Date().toISOString(),
    nonTargetModelsUnchanged: true,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ ...result, mode: "applied", receiptDirectory, nonTargetModelsUnchanged: true }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      failed: true,
      message: error instanceof Error ? error.message : String(error),
      secretsPrinted: false,
      providerRequests: 0,
      paidGenerationCalls: 0,
    })}\n`);
    process.exitCode = 1;
  });
}
