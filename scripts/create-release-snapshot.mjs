#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument.startsWith("--") && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    argumentsMap.set(argument, process.argv[index + 1]);
    index += 1;
  }
}

const sourceRoot = path.resolve(argumentsMap.get("--source") || process.cwd());
const outputRootRaw = argumentsMap.get("--output");
if (!outputRootRaw) {
  console.error("Usage: node scripts/create-release-snapshot.mjs --output <new-empty-directory> [--source <project-root>]");
  process.exit(2);
}

const outputRoot = path.resolve(outputRootRaw);
const sourcePrefix = `${sourceRoot}${path.sep}`;
const outputPrefix = `${outputRoot}${path.sep}`;
if (outputRoot === sourceRoot || outputRoot.startsWith(sourcePrefix) || sourceRoot.startsWith(outputPrefix)) {
  console.error("Refusing to create a release snapshot inside, equal to, or above the source tree.");
  process.exit(2);
}
if (fs.existsSync(outputRoot)) {
  console.error(`Refusing to overwrite an existing output directory: ${outputRoot}`);
  process.exit(2);
}

const preflight = spawnSync(
  process.execPath,
  [path.join(sourceRoot, "scripts", "release-preflight.mjs"), "--root", sourceRoot, "--strict-legacy", "1"],
  { cwd: sourceRoot, encoding: "utf8" },
);
if (preflight.stdout) process.stdout.write(preflight.stdout);
if (preflight.stderr) process.stderr.write(preflight.stderr);
if (preflight.status !== 0) {
  console.error("Release snapshot aborted because the source preflight failed.");
  process.exit(preflight.status ?? 1);
}

function normalizeRelativePath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function wildcardRuleToRegExp(rule) {
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`);
}

const ignoreFile = path.join(sourceRoot, ".releaseignore");
if (!fs.existsSync(ignoreFile)) {
  console.error("Missing .releaseignore; refusing to guess the release boundary.");
  process.exit(2);
}

const ignoreRules = fs.readFileSync(ignoreFile, "utf8")
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const alwaysExcludedDirectoryNames = new Set([
  ".git",
  ".next",
  "node_modules",
  ".secure",
  ".codex-backups",
  ".codex-evidence",
  ".codex-runtime",
  ".codex-temp",
  ".tmp-e2e",
  ".tmp-help-audit",
  ".tmp-runtime",
  "backups",
  "logs",
  "tmp",
]);

function isIgnored(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => alwaysExcludedDirectoryNames.has(segment))) return true;
  const baseName = segments.at(-1) || "";
  if (
    baseName.endsWith(".log")
    || baseName.includes(".tsbuildinfo")
    || [".db", ".sqlite", ".sqlite3"].includes(path.extname(baseName).toLowerCase())
    || /-(?:wal|shm)$/u.test(baseName)
    || /^\.env\.(?:local|production)/u.test(baseName)
  ) return true;
  return ignoreRules.some((rawRule) => {
    const directoryRule = rawRule.endsWith("/");
    const rule = normalizeRelativePath(rawRule);
    if (!rule) return false;
    if (directoryRule) return normalized === rule || normalized.startsWith(`${rule}/`);
    if (rule.includes("*")) return wildcardRuleToRegExp(rule).test(normalized);
    return normalized === rule;
  });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const sourceFiles = [];
function collect(currentDirectory) {
  const entries = fs.readdirSync(currentDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = normalizeRelativePath(path.relative(sourceRoot, absolutePath));
    if (isIgnored(relativePath)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Release source contains an unsupported symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      collect(absolutePath);
      continue;
    }
    if (entry.isFile()) sourceFiles.push({ absolutePath, relativePath });
  }
}

try {
  collect(sourceRoot);
  fs.mkdirSync(outputRoot, { recursive: false });

  let totalBytes = 0;
  const hashLines = [];
  for (const file of sourceFiles) {
    const destination = path.join(outputRoot, file.relativePath.split("/").join(path.sep));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.absolutePath, destination);
    const stats = fs.statSync(file.absolutePath);
    totalBytes += stats.size;
    hashLines.push(`${sha256File(file.absolutePath)}  ${file.relativePath}`);
  }

  const hashDocument = `${hashLines.join("\n")}\n`;
  fs.writeFileSync(path.join(outputRoot, "RELEASE-FILES.sha256"), hashDocument, "utf8");

  const generatedAt = new Date().toISOString();
  const inventorySha256 = crypto.createHash("sha256").update(hashDocument).digest("hex");
  fs.writeFileSync(
    path.join(outputRoot, "deploy-manifest.json"),
    `${JSON.stringify({
      kind: "self-media-operator-production-release",
      schema_version: 1,
      generated_at: generatedAt,
      source_file_count: sourceFiles.length,
      source_bytes: totalBytes,
      source_inventory_sha256: inventorySha256,
      excluded_runtime_state: ["environment files", "uploads", "backups", "dependencies", "build outputs", "local evidence"],
      deployment_policy: "immutable release directory plus atomic current symlink and retained rollback",
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(outputRoot, "release-security-report.json"),
    `${JSON.stringify({
      generated_at: generatedAt,
      source_preflight: "passed",
      secret_policy: "environment-only; no source fallback credentials",
      release_inventory_sha256: inventorySha256,
      note: "Binary files larger than 2 MiB are inventoried and hashed; text secret patterns are checked by release-preflight.mjs.",
    }, null, 2)}\n`,
    "utf8",
  );

  console.log(`Release snapshot created: ${outputRoot}`);
  console.log(`Snapshot source inventory: ${sourceFiles.length} files, ${totalBytes} bytes, sha256=${inventorySha256}`);
} catch (error) {
  console.error(`Release snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
