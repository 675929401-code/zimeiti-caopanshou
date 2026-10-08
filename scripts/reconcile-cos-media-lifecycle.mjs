#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import COS from "cos-nodejs-sdk-v5";
import dotenv from "dotenv";

const root = process.cwd();
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const confirmPlanSha256 = valueOf("--confirm-plan-sha256").toLowerCase();
const policyPath = path.join(root, "deploy", "policies", "media-object-retention.v1.json");
const evidenceRoot = path.join(root, ".codex-evidence", "cos-media-lifecycle");
const ownedRulePrefix = "zimeiti-media-retention-v1-";

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

function valueOf(name) {
  const exact = args.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  assert.ok(value, `${name}_REQUIRED`);
  return value;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function scalar(value) {
  if (Array.isArray(value)) return scalar(value[0]);
  return String(value ?? "").trim();
}

function rulePrefix(rule) {
  return scalar(rule?.Filter?.Prefix ?? rule?.Prefix);
}

function ruleDays(rule) {
  return Number(scalar(rule?.Expiration?.Days));
}

function desiredRules(policy) {
  return policy.rules.flatMap((policyRule) => policyRule.prefixes.map((prefix, index) => ({
    ID: `${ownedRulePrefix}${policyRule.id}-${String(index + 1).padStart(2, "0")}`,
    Status: "Enabled",
    Filter: { Prefix: prefix },
    Expiration: { Days: String(policyRule.expirationDays) },
  })));
}

function buildPlan({ bucket, region, currentRules, desired }) {
  const foreignRules = currentRules.filter((rule) => !scalar(rule.ID).startsWith(ownedRulePrefix));
  const conflicts = foreignRules.flatMap((rule) => {
    const target = desired.find((candidate) => rulePrefix(candidate) === rulePrefix(rule));
    if (!target || (scalar(rule.Status) === "Enabled" && ruleDays(rule) === ruleDays(target))) return [];
    return [{
      existingRuleId: scalar(rule.ID) || null,
      prefix: rulePrefix(rule),
      existingStatus: scalar(rule.Status) || null,
      existingDays: Number.isFinite(ruleDays(rule)) ? ruleDays(rule) : null,
      desiredDays: ruleDays(target),
    }];
  });
  const plannedRules = [...foreignRules, ...desired];
  const core = {
    schemaVersion: 1,
    policyVersion: "media-object-retention.v1",
    bucket,
    region,
    currentLifecycleSha256: sha256(currentRules),
    plannedLifecycleSha256: sha256(plannedRules),
    existingRuleCount: currentRules.length,
    preservedForeignRuleCount: foreignRules.length,
    desiredRuleCount: desired.length,
    conflicts,
    desired: desired.map((rule) => ({ id: rule.ID, prefix: rulePrefix(rule), expirationDays: ruleDays(rule) })),
  };
  return { ...core, planSha256: sha256(core), plannedRules };
}

async function readLifecycle(cos, bucket, region) {
  const result = await cos.getBucketLifecycle({ Bucket: bucket, Region: region, Headers: {} });
  return {
    statusCode: Number(result.statusCode || 0),
    rules: Array.isArray(result.Rules) ? result.Rules : [],
  };
}

function verifyReadback(readbackRules, desired) {
  const byId = new Map(readbackRules.map((rule) => [scalar(rule.ID), rule]));
  const failures = [];
  for (const expected of desired) {
    const actual = byId.get(expected.ID);
    if (!actual
      || scalar(actual.Status) !== "Enabled"
      || rulePrefix(actual) !== rulePrefix(expected)
      || ruleDays(actual) !== ruleDays(expected)) {
      failures.push(expected.ID);
    }
  }
  assert.deepEqual(failures, [], `COS_LIFECYCLE_READBACK_MISMATCH:${failures.join(",")}`);
}

function writeEvidence(name, report) {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const output = path.join(evidenceRoot, name);
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return output;
}

async function main() {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  assert.equal(policy.version, "media-object-retention.v1", "MEDIA_RETENTION_POLICY_VERSION_INVALID");
  const bucket = requiredEnvironment("COS_BUCKET");
  const region = requiredEnvironment("COS_REGION");
  const cos = new COS({
    SecretId: requiredEnvironment("COS_SECRET_ID"),
    SecretKey: requiredEnvironment("COS_SECRET_KEY"),
    Timeout: 30_000,
    MaxRetryTimes: 1,
  });
  const desired = desiredRules(policy);
  const before = await readLifecycle(cos, bucket, region);
  const plan = buildPlan({ bucket, region, currentRules: before.rules, desired });
  const publicPlan = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "plannedRules"));

  if (!apply) {
    const report = {
      ok: plan.conflicts.length === 0,
      mode: "plan",
      observedAt: new Date().toISOString(),
      ...publicPlan,
      externalWrites: 0,
      credentialsPrinted: false,
      applyRequires: `--apply --confirm-plan-sha256=${plan.planSha256}`,
    };
    const output = writeEvidence("latest-plan.json", report);
    console.log(JSON.stringify({ ...report, output }, null, 2));
    if (plan.conflicts.length > 0) process.exitCode = 1;
    return;
  }

  assert.match(confirmPlanSha256, /^[a-f0-9]{64}$/u, "COS_LIFECYCLE_PLAN_CONFIRMATION_REQUIRED");
  assert.equal(confirmPlanSha256, plan.planSha256, "COS_LIFECYCLE_PLAN_CHANGED");
  assert.deepEqual(plan.conflicts, [], "COS_LIFECYCLE_CONFLICT_REQUIRES_REVIEW");
  const result = await cos.putBucketLifecycle({
    Bucket: bucket,
    Region: region,
    Rules: plan.plannedRules,
    Headers: {},
  });
  const after = await readLifecycle(cos, bucket, region);
  verifyReadback(after.rules, desired);
  const report = {
    ok: true,
    mode: "apply-and-readback",
    appliedAt: new Date().toISOString(),
    ...publicPlan,
    putStatusCode: Number(result.statusCode || 0),
    readbackStatusCode: after.statusCode,
    readbackLifecycleSha256: sha256(after.rules),
    readbackRuleCount: after.rules.length,
    verifiedDesiredRuleCount: desired.length,
    externalWrites: 1,
    credentialsPrinted: false,
  };
  const timestamp = report.appliedAt.replace(/[-:.]/gu, "").replace("Z", "Z");
  const output = writeEvidence(`${timestamp}-receipt.json`, report);
  console.log(JSON.stringify({ ...report, output }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    mode: apply ? "apply" : "plan",
    code: error instanceof Error ? error.message.slice(0, 300) : "UNKNOWN_ERROR",
    externalWrites: 0,
    credentialsPrinted: false,
  }, null, 2));
  process.exitCode = 1;
});
