#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertJsonSchema, canonicalJson, sha256 } from "./lib/json-schema-contract.mjs";

function argsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error("ARGUMENT_VALUE_REQUIRED");
    result.set(key, value);
    index += 1;
  }
  return result;
}

function readJson(file, code) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(code); }
}

function main() {
  const args = argsMap(process.argv.slice(2));
  const root = path.resolve(args.get("--root") || process.cwd());
  const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scopePath = path.resolve(args.get("--scope-receipt") || "");
  const outputPath = path.resolve(args.get("--output") || "");
  const policyPath = path.resolve(args.get("--policy") || path.join(toolRoot, "deploy/policies/release-change-scope.v1.json"));
  const scopeSchemaPath = path.resolve(args.get("--scope-schema") || path.join(toolRoot, "scripts/contracts/release-change-scope-receipt.v1.schema.json"));
  const schemaPath = path.resolve(args.get("--schema") || path.join(toolRoot, "scripts/contracts/release-targeted-regression-receipt.v1.schema.json"));
  execFileSync(process.execPath, [path.join(toolRoot, "scripts/classify-release-change-scope.mjs"), "--root", root, "--policy", policyPath, "--schema", scopeSchemaPath, "--verify-receipt", scopePath, "--quiet"], { cwd: root, stdio: "pipe" });
  const scope = readJson(scopePath, "SCOPE_RECEIPT_INVALID");
  if (scope.classification !== "FAST" || scope.input.kind !== "git-range" || !scope.input.trustedBase) {
    throw new Error("FAST_TRUSTED_GIT_RANGE_REQUIRED");
  }
  const policy = readJson(policyPath, "SCOPE_POLICY_INVALID");
  const rules = new Map(policy.fastTargetedRegressionRules.map((rule) => [rule.id, rule]));
  const changedFiles = scope.changedFiles.map((file) => {
    if (file.targetedRegressionIds.length === 0) throw new Error(`TARGETED_REGRESSION_UNMAPPED:${file.path}`);
    return { path: file.path, regressionIds: [...file.targetedRegressionIds] };
  });
  const commands = new Map();
  for (const file of scope.changedFiles) {
    for (const regressionId of file.targetedRegressionIds) {
      const rule = rules.get(regressionId);
      if (!rule) throw new Error(`TARGETED_REGRESSION_RULE_MISSING:${regressionId}`);
      const executable = rule.command.executable;
      const commandArgs = rule.command.args.map((value) => value === "{path}" ? file.path : value);
      const key = canonicalJson({ regressionId, executable, args: commandArgs });
      commands.set(key, { regressionId, executable, args: commandArgs });
    }
  }
  const executions = [];
  for (const command of commands.values()) {
    const result = spawnSync(command.executable, command.args, { cwd: root, encoding: "utf8", stdio: "inherit", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`TARGETED_REGRESSION_FAILED:${command.regressionId}`);
    executions.push({ ...command, exitCode: 0 });
  }
  const receipt = {
    schemaVersion: "zimeiti-release-targeted-regression-receipt.v1",
    scopeReceiptId: scope.receiptId,
    scopeReceiptSha256: sha256(fs.readFileSync(scopePath)),
    subjectCommit: scope.input.head,
    classification: "FAST",
    changedFiles,
    executions,
    result: "passed",
  };
  assertJsonSchema(readJson(schemaPath, "TARGETED_REGRESSION_SCHEMA_INVALID"), receipt, "TARGETED_REGRESSION_RECEIPT_INVALID");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

try { main(); } catch (error) {
  process.stderr.write(`RELEASE_TARGETED_REGRESSION_FAILED ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}\n`);
  process.exitCode = 2;
}
