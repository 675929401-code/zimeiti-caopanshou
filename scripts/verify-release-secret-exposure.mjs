#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const root = process.cwd();
const cli = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) throw new Error("ARGUMENT_NAME_REQUIRED");
  const next = process.argv[index + 1];
  if (next !== undefined && !next.startsWith("--")) { cli.set(token, next); index += 1; }
  else cli.set(token, "1");
}
const mode = process.argv.includes("--include-local-evidence") ? "local-evidence" : "release-candidate";
const maximumTextBytes = 2 * 1024 * 1024;
const evidenceRoots = ["artifacts", ".logs", ".codex-evidence"];
const skippedDirectoryNames = new Set([
  ".git", ".next", "node_modules", "backups", ".codex-backups", ".codex-task-snapshots",
  ".codex-snapshots", ".codex-temp", ".secure", "public/uploads",
  "public/storyboard-reviews", "public/demo-assets",
]);
const textExtensions = new Set([
  ".cjs", ".css", ".env", ".example", ".html", ".js", ".json", ".jsx", ".log",
  ".md", ".mjs", ".prisma", ".ps1", ".sh", ".sql", ".svg", ".toml", ".ts",
  ".tsx", ".txt", ".yaml", ".yml",
]);
const placeholder = /(?:\[?redacted\]?|fixture|synthetic|example|placeholder|dummy|sample|your[_-]|replace[_-]|change.?me|xxxx|secret:\/\/|env:\/\/|process\.env|import\.meta\.env|<[^>]+>|\{[^}]+\})/iu;
const codeReference = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;
const powershellCommand = /^[A-Z][a-z]+(?:To|From|Out|In|New|Get|Set|Convert|Protect|Unprotect)?-[A-Z][A-Za-z]+$/u;
const credentialLabel = /(?:access[ _-]?key(?:[ _-]?(?:id|secret))?|api[ _-]?key(?:[ _-]?(?:id|secret))?|client[ _-]?secret|auth[ _-]?secret|jwt[ _-]?secret|service[ _-]?role[ _-]?key|private[ _-]?key|password|passwd|token)/iu;
const credentialAssignment = /(?:access[ _-]?key(?:[ _-]?(?:id|secret))?|api[ _-]?key(?:[ _-]?(?:id|secret))?|client[ _-]?secret|auth[ _-]?secret|jwt[ _-]?secret|service[ _-]?role[ _-]?key|private[ _-]?key|password|passwd|token)\s*["']?\s*[:=]\s*["'`]?([A-Za-z0-9][A-Za-z0-9._~+/=-]{11,})/igu;
const directPatterns = [
  { category: "private-key-pem", expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu },
  { category: "credentialed-url", expression: /https?:\/\/[^/\s:@]+:[^/\s@]+@/giu },
  { category: "jwt-like", expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  { category: "provider-access-key-id", expression: /\b(?:AKLT|AKID|LTAI)[A-Za-z0-9]{12,}\b/gu },
];
const highConfidenceCategories = new Set(directPatterns.map(({ category }) => category));

function normalize(value) {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function isSkipped(relativePath) {
  const normalized = normalize(relativePath);
  if (normalized === "scripts/verify-release-secret-exposure.mjs") return true;
  return [...skippedDirectoryNames].some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function candidateLooksSecret(value, line) {
  const candidate = String(value || "").replace(/["'`),;\]}]+$/u, "");
  if (candidate.length < 12 || placeholder.test(candidate) || placeholder.test(line)) return false;
  if (codeReference.test(candidate) || powershellCommand.test(candidate)) return false;
  if (/^(?:true|false|null|undefined)$/iu.test(candidate)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[._~+/=-]/u].filter((pattern) => pattern.test(candidate)).length;
  return candidate.length >= 24 ? classes >= 2 : candidate.length >= 16 && classes >= 3;
}

function isExplicitPatternFixture(relativePath, line) {
  const normalized = normalize(relativePath || "");
  if (!/(?:^|\/)(?:verify|test)[^/]*\.(?:[cm]?[jt]sx?|ps1)$/iu.test(normalized)
    && !normalized.startsWith(".codex-evidence/")) return false;
  return /(?:RegExp|\.test\s*\(|\.match\s*\(|\.includes\s*\(|expression\s*:|pattern\s*:|regex|fixture|synthetic|example)/iu.test(line);
}

function isProviderSecretFilename(relativePath, line, candidate) {
  if (normalize(relativePath) !== "src/lib/provider-secret.ts") return false;
  // Only an exact alias -> alias.token mapping is a filename, never a token body.
  const mapping = line.match(/^\s*"([a-z][a-z0-9-]+)":\s*"([a-z][a-z0-9.-]+)",?\s*$/u);
  return Boolean(mapping && mapping[2] === `${mapping[1]}.token` && candidate === mapping[2]);
}

function findingsFor(text, relativePath = "") {
  const counts = new Map();
  for (const { category, expression } of directPatterns) {
    let count = 0;
    for (const line of text.split(/\r?\n/u)) {
      expression.lastIndex = 0;
      for (const match of line.match(expression) || []) {
        if (!placeholder.test(match) && !isExplicitPatternFixture(relativePath, line)) count += 1;
      }
    }
    if (count > 0) counts.set(category, count);
  }
  for (const line of text.split(/\r?\n/u)) {
    if (!credentialLabel.test(line)) continue;
    credentialAssignment.lastIndex = 0;
    let match;
    while ((match = credentialAssignment.exec(line)) !== null) {
      if (candidateLooksSecret(match[1], line) && !isProviderSecretFilename(relativePath, line, match[1])) {
        counts.set("named-credential-literal", (counts.get("named-credential-literal") || 0) + 1);
      }
    }
  }
  return counts;
}

function walk(directory, output) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = normalize(path.relative(root, absolutePath));
    if (isSkipped(relativePath)) continue;
    if (entry.isDirectory()) {
      walk(absolutePath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(absolutePath);
    if (stat.size > maximumTextBytes) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(extension) && !entry.name.startsWith(".env")) continue;
    const bytes = fs.readFileSync(absolutePath);
    if (bytes.includes(0)) continue;
    const counts = findingsFor(bytes.toString("utf8"), relativePath);
    if (counts.size > 0) {
      output.push({
        path: relativePath,
        categories: [...counts.entries()].map(([category, count]) => ({ category, count })),
      });
    }
  }
}

// Kept as the scanner-contract extraction boundary; runtime fills this array
// only after all pure detection functions have been defined.
const workingTreeFindings = [];

function runGit(arguments_) {
  return spawnSync("git", arguments_, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function candidateFindings(commit) {
  const listed = runGit(["ls-tree", "-r", "-z", "--name-only", commit]);
  if (listed.status !== 0) throw new Error("SECRET_SCAN_CANDIDATE_TREE_UNAVAILABLE");
  const findings = [];
  for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
    if (isSkipped(relativePath)) continue;
    const extension = path.extname(relativePath).toLowerCase();
    if (!textExtensions.has(extension) && !path.basename(relativePath).startsWith(".env")) continue;
    const blob = runGit(["show", `${commit}:${relativePath}`]);
    if (blob.status !== 0) throw new Error("SECRET_SCAN_CANDIDATE_BLOB_UNAVAILABLE");
    if (Buffer.byteLength(blob.stdout, "utf8") > maximumTextBytes || blob.stdout.includes("\0")) continue;
    const counts = findingsFor(blob.stdout, relativePath);
    if (counts.size > 0) findings.push({
      path: normalize(relativePath),
      categories: [...counts.entries()].map(([category, count]) => ({ category, count })),
    });
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

function resolveCommit(revision) {
  const result = runGit(["rev-parse", "--verify", `${revision}^{commit}`]);
  if (result.status !== 0) throw new Error("SECRET_SCAN_GIT_REVISION_UNRESOLVED");
  return result.stdout.trim().toLowerCase();
}

function historyFindings(baseArgument, headArgument, includeBase) {
  let base = null;
  let head = null;
  let commitsResult;
  if (baseArgument || headArgument) {
    if (!baseArgument || !headArgument) throw new Error("SECRET_SCAN_HISTORY_RANGE_INCOMPLETE");
    base = resolveCommit(baseArgument);
    head = resolveCommit(headArgument);
    const ancestry = runGit(["merge-base", "--is-ancestor", base, head]);
    if (ancestry.status !== 0) throw new Error("SECRET_SCAN_HISTORY_BASE_NOT_ANCESTOR");
    commitsResult = runGit(["rev-list", "--reverse", `${base}..${head}`]);
  } else {
    commitsResult = runGit(["rev-list", "--all"]);
  }
  if (commitsResult.status !== 0) throw new Error("SECRET_SCAN_HISTORY_UNAVAILABLE");
  const commits = commitsResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  if (includeBase && base) commits.unshift(base);
  const candidateExpressions = [
    { category: "private-key-pem", pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
    { category: "credentialed-url", pattern: "https?://[^/[:space:]:@]+:[^/[:space:]@]+@" },
    { category: "jwt-like", pattern: "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}" },
    { category: "provider-access-key-id", pattern: "(AKLT|AKID|LTAI)[A-Za-z0-9]{12,}" },
    { category: "named-credential-candidate", pattern: "(api.?key|access.?key|client.?secret|auth.?secret|jwt.?secret|password|token)[[:space:]]*[:=][[:space:]]*[^[:space:]]{12,}" },
  ];
  const aggregate = new Map();
  for (const commit of commits) {
    const candidatePaths = new Set();
    for (const { pattern } of candidateExpressions) {
      const result = runGit(["-c", "core.quotePath=false", "grep", "-I", "-l", "-E", "-e", pattern, commit, "--"]);
      if (![0, 1].includes(result.status)) throw new Error("SECRET_SCAN_GIT_GREP_FAILED");
      for (const raw of result.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)) {
        const separator = raw.indexOf(":");
        const relativePath = separator >= 0 ? raw.slice(separator + 1) : raw;
        if (isSkipped(relativePath)) continue;
        candidatePaths.add(normalize(relativePath));
      }
    }
    for (const relativePath of candidatePaths) {
      const extension = path.extname(relativePath).toLowerCase();
      if (!textExtensions.has(extension) && !path.basename(relativePath).startsWith(".env")) continue;
      const blob = runGit(["show", `${commit}:${relativePath}`]);
      if (blob.status !== 0) throw new Error("SECRET_SCAN_GIT_BLOB_UNAVAILABLE");
      if (Buffer.byteLength(blob.stdout, "utf8") > maximumTextBytes) continue;
      for (const [category] of findingsFor(blob.stdout, relativePath)) {
        const key = `${relativePath}\u0000${category}`;
        aggregate.set(key, (aggregate.get(key) || 0) + 1);
      }
    }
  }
  const findings = [...aggregate.entries()].map(([key, commitCount]) => {
    const [relativePath, category] = key.split("\u0000");
    return { path: relativePath, category, commitCount };
  }).sort((left, right) => left.path.localeCompare(right.path) || left.category.localeCompare(right.category));
  return { available: true, base, head, includeBase, commits: commits.length, findings };
}

const candidateCommit = cli.has("--candidate-commit") ? resolveCommit(cli.get("--candidate-commit")) : resolveCommit("HEAD");
const headCommit = resolveCommit("HEAD");
if (candidateCommit !== headCommit) throw new Error("SECRET_SCAN_CANDIDATE_NOT_HEAD");
if (cli.has("--require-clean-candidate")) {
  const dirty = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty.status !== 0 || dirty.stdout.length > 0) throw new Error("SECRET_SCAN_CANDIDATE_NOT_CLEAN");
}
workingTreeFindings.push(...candidateFindings(candidateCommit));
if (mode === "local-evidence") {
  for (const relativeRoot of evidenceRoots) walk(path.join(root, relativeRoot), workingTreeFindings);
  workingTreeFindings.sort((left, right) => left.path.localeCompare(right.path));
}
const history = historyFindings(cli.get("--history-base"), cli.get("--history-head"), cli.has("--include-history-base"));
let scopeReceiptId = null;
let scopeReceiptSha256 = null;
if (cli.has("--scope-receipt")) {
  const scopeBytes = fs.readFileSync(path.resolve(cli.get("--scope-receipt")));
  const scope = JSON.parse(scopeBytes.toString("utf8"));
  if (!/^scope-[a-f0-9]{24}$/u.test(String(scope.receiptId || ""))) throw new Error("SECRET_SCAN_SCOPE_RECEIPT_INVALID");
  scopeReceiptId = scope.receiptId;
  scopeReceiptSha256 = crypto.createHash("sha256").update(scopeBytes).digest("hex");
}
const workingTreeBlockingCount = workingTreeFindings.reduce((total, entry) => total
  + entry.categories.filter(({ category }) => highConfidenceCategories.has(category))
    .reduce((count, item) => count + item.count, 0), 0);
const historyBlockingCount = history.findings
  .filter(({ category }) => highConfidenceCategories.has(category))
  .reduce((total, entry) => total + entry.commitCount, 0);
const blockingCount = workingTreeBlockingCount + historyBlockingCount;
const reviewCount = workingTreeFindings.reduce((total, entry) => total
  + entry.categories.filter(({ category }) => !highConfidenceCategories.has(category))
    .reduce((count, item) => count + item.count, 0), 0)
  + history.findings.filter(({ category }) => !highConfidenceCategories.has(category)).length;
const status = blockingCount > 0 ? "BLOCKED" : reviewCount > 0 ? "REVIEW_REQUIRED" : "PASS";
const result = {
  schemaVersion: "zimeiti-release-secret-exposure-receipt.v1",
  verifier: "release-secret-exposure",
  mode,
  status,
  scopeReceiptId,
  scopeReceiptSha256,
  candidate: { commit: candidateCommit, cleanRequired: cli.has("--require-clean-candidate") },
  outputPolicy: "paths-categories-counts-only",
  summary: { blockingCount, reviewCount, workingTreeBlockingCount, historyBlockingCount },
  workingTree: { findingFiles: workingTreeFindings.length, findings: workingTreeFindings },
  gitHistory: history,
};

const body = `${JSON.stringify(result, null, 2)}\n`;
if (cli.has("--receipt")) {
  const receiptPath = path.resolve(cli.get("--receipt"));
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, receiptPath);
}
process.stdout.write(body);
process.exit(result.status === "PASS" ? 0 : result.status === "REVIEW_REQUIRED" ? 1 : 2);
