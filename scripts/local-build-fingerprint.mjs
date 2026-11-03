import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RECEIPT_SCHEMA_VERSION = 1;
const EXCLUDED_PREFIXES = [
  ".git/",
  ".next/",
  ".runtime/",
  ".codex-",
  ".tmp-e2e/",
  "node_modules/",
  "backups/",
  "data/",
  "logs/",
  "coverage/",
  "evidence-archive/",
  "public/uploads/",
  "voice-platform/node_modules/",
];
const LOCAL_ENV_FILES = [
  ".env.production.local",
  ".env.local",
  ".env.production",
  ".env",
];
const GENERATED_SOURCE_FILES = new Set([
  "next-env.d.ts",
  "voice-platform/next-env.d.ts",
]);

function normalize(value) {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function isExcluded(relativePath) {
  const normalized = normalize(relativePath);
  return GENERATED_SOURCE_FILES.has(normalized)
    || EXCLUDED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function hashFile(filePath) {
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

function gitFileList(root) {
  // A release helper may have set core.worktree to a staging snapshot.
  // Enumerate inputs in the exact source directory that is being built.
  const result = spawnSync("git", [`--work-tree=${root}`, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot enumerate local build inputs: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function computeLocalBuildFingerprint(rootInput = process.cwd(), { omitFiles = [] } = {}) {
  const root = path.resolve(rootInput);
  const candidates = new Set(gitFileList(root));
  for (const relativePath of LOCAL_ENV_FILES) {
    if (fs.existsSync(path.join(root, relativePath))) candidates.add(relativePath);
  }
  const files = [];
  for (const relativePath of [...candidates].map(normalize).sort((left, right) => left.localeCompare(right, "en"))) {
    if (isExcluded(relativePath) || omitFiles.includes(relativePath)) continue;
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (!fs.existsSync(absolutePath)) continue;
    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`local build input cannot be a symbolic link: ${relativePath}`);
    }
    if (!stats.isFile()) continue;
    files.push({ path: relativePath, bytes: stats.size, sha256: hashFile(absolutePath) });
  }
  const fingerprint = crypto.createHash("sha256")
    .update(files.map((file) => `${file.sha256}  ${file.path}\n`).join(""))
    .digest("hex");
  return { schemaVersion: RECEIPT_SCHEMA_VERSION, fingerprint, fileCount: files.length };
}

export function writeLocalBuildFingerprintReceipt(rootInput, outputInput, expectedFingerprint) {
  const root = path.resolve(rootInput);
  const outputPath = path.resolve(root, outputInput);
  const current = computeLocalBuildFingerprint(root);
  if (expectedFingerprint && current.fingerprint !== expectedFingerprint) {
    throw new Error("source changed while the local production bundle was building; discard this bundle and rebuild");
  }
  const buildIdPath = path.join(root, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) throw new Error("cannot write local build receipt without .next/BUILD_ID");
  const receipt = {
    ...current,
    kind: "local-production-preview-source-fingerprint",
    buildId: fs.readFileSync(buildIdPath, "utf8").trim(),
    capturedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, outputPath);
  return receipt;
}

export function verifyLocalBuildFingerprintReceipt(rootInput, inputInput) {
  const root = path.resolve(rootInput);
  const inputPath = path.resolve(root, inputInput);
  if (!fs.existsSync(inputPath)) {
    throw new Error("local production bundle has no source fingerprint receipt; run the production build first");
  }
  const receipt = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const buildIdPath = path.join(root, ".next", "BUILD_ID");
  const buildId = fs.existsSync(buildIdPath) ? fs.readFileSync(buildIdPath, "utf8").trim() : "";
  const current = computeLocalBuildFingerprint(root);
  if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || receipt?.kind !== "local-production-preview-source-fingerprint"
    || receipt?.buildId !== buildId
    || receipt?.fingerprint !== current.fingerprint
    || receipt?.fileCount !== current.fileCount) {
    throw new Error("local production bundle is stale relative to the current source; rebuild before starting port 5000");
  }
  return { ...current, buildId };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const command = process.argv[2] || "calculate";
  const root = path.resolve(process.argv[3] || process.cwd());
  const receiptPath = process.argv[4] || ".next/local-source-fingerprint.v1.json";
  try {
    const result = command === "capture"
      ? writeLocalBuildFingerprintReceipt(root, receiptPath)
      : command === "verify"
        ? verifyLocalBuildFingerprintReceipt(root, receiptPath)
        : computeLocalBuildFingerprint(root);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
