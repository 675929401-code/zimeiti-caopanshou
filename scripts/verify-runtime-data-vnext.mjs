#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(fs.readFileSync(path.join(projectRoot, "deploy", "policies", "release-policy.json"), "utf8"));
const argumentIndex = process.argv.indexOf("--data-root");
const explicitDataRoot = argumentIndex >= 0;
const configuredRoot = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : "data";

if (!configuredRoot) throw new Error("--data-root requires a directory");
const dataRoot = path.resolve(projectRoot, configuredRoot);
if (path.parse(dataRoot).root === dataRoot) throw new Error("runtime data root cannot be a filesystem root");
if (!fs.existsSync(dataRoot)) {
  if (explicitDataRoot) throw new Error(`runtime data root does not exist: ${dataRoot}`);
  console.log(JSON.stringify({
    ok: true,
    status: "EXTERNAL_RUNTIME_DATA_NOT_PRESENT",
    dataRoot,
    requiredFiles: policy.runtime.requiredDataFiles || [],
    contentsRedacted: true,
    note: "Clean source repositories intentionally exclude runtime data; pass --data-root to verify a mounted data release.",
  }, null, 2));
  process.exit(0);
}
const rootStats = fs.lstatSync(dataRoot);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("runtime data root must be a real directory");

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function resolveRequiredFile(relativePath) {
  const normalized = relativePath.split("/").join(path.sep);
  const filePath = path.resolve(dataRoot, normalized);
  if (!filePath.startsWith(`${dataRoot}${path.sep}`)) throw new Error(`runtime data path escaped root: ${relativePath}`);
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`runtime data path must be a real file: ${relativePath}`);
  if (stats.size > 100 * 1024 * 1024) throw new Error(`runtime JSON exceeds 100 MiB safety limit: ${relativePath}`);
  return { filePath, stats };
}

function actualShape(value) {
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  return typeof value;
}

function verifyCustomVoices(value) {
  if (!Array.isArray(value)) throw new Error("custom-voices.json must be an array");
  const ids = new Set();
  for (const [index, voice] of value.entries()) {
    if (!voice || typeof voice !== "object" || Array.isArray(voice)) throw new Error(`custom voice ${index} is invalid`);
    if (Object.hasOwn(voice, "url")) throw new Error(`custom voice ${index} persists an expiring signed URL`);
    for (const field of ["id", "name", "userId", "fileKey", "createdAt"]) {
      if (typeof voice[field] !== "string" || !voice[field].trim()) throw new Error(`custom voice ${index} is missing ${field}`);
    }
    if (ids.has(voice.id)) throw new Error(`duplicate custom voice id: ${voice.id}`);
    ids.add(voice.id);
    if (!Number.isFinite(voice.size) || voice.size < 0) throw new Error(`custom voice ${index} has invalid size`);
  }
}

const records = [];
for (const relativePath of policy.runtime.requiredDataFiles || []) {
  const { filePath, stats } = resolveRequiredFile(relativePath);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const expectedShape = policy.runtime.requiredDataShapes?.[relativePath];
  const shape = actualShape(value);
  if (expectedShape && shape !== expectedShape) {
    throw new Error(`runtime data shape mismatch for ${relativePath}: expected ${expectedShape}, received ${shape}`);
  }
  if (relativePath === "custom-voices.json") verifyCustomVoices(value);
  records.push({
    path: relativePath,
    shape,
    records: Array.isArray(value) ? value.length : null,
    bytes: stats.size,
    sha256: sha256File(filePath),
  });
}

const leftovers = [];
function findAtomicLeftovers(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`runtime data contains a symbolic link: ${path.relative(dataRoot, filePath)}`);
    if (entry.isDirectory()) findAtomicLeftovers(filePath);
    if (entry.isFile() && /[.](?:tmp|replace-backup)-/u.test(entry.name)) leftovers.push(path.relative(dataRoot, filePath));
  }
}
findAtomicLeftovers(dataRoot);
if (leftovers.length) throw new Error(`runtime data contains unfinished atomic-write files: ${leftovers.join(", ")}`);

console.log(JSON.stringify({
  ok: true,
  dataRoot,
  fileCount: records.length,
  files: records,
  contentsRedacted: true,
}, null, 2));
