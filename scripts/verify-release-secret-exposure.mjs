#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const mode = process.argv.includes("--include-local-evidence") ? "local-evidence" : "release-candidate";
const maximumTextBytes = 2 * 1024 * 1024;
const releaseRoots = ["src", "scripts", "deploy", "docs", "supabase", "public", "voice-platform"];
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

function runGit(arguments_) {
  return spawnSync("git", arguments_, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function historyFindings() {
  const commitsResult = runGit(["rev-list", "--all"]);
  if (commitsResult.status !== 0) return { available: false, commits: 0, findings: [] };
  const commits = commitsResult.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
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
      const result = runGit(["-c", "core.quotePath=false", "grep", "-I", "-l", "-E", pattern, commit, "--"]);
      if (![0, 1].includes(result.status)) continue;
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
      if (blob.status !== 0 || Buffer.byteLength(blob.stdout, "utf8") > maximumTextBytes) continue;
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
  return { available: true, commits: commits.length, findings };
}

const workingTreeFindings = [];
for (const relativeRoot of [...releaseRoots, ...(mode === "local-evidence" ? evidenceRoots : [])]) {
  walk(path.join(root, relativeRoot), workingTreeFindings);
}
workingTreeFindings.sort((left, right) => left.path.localeCompare(right.path));
const history = historyFindings();
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
  verifier: "release-secret-exposure",
  mode,
  status,
  outputPolicy: "paths-categories-counts-only",
  summary: { blockingCount, reviewCount, workingTreeBlockingCount, historyBlockingCount },
  workingTree: { findingFiles: workingTreeFindings.length, findings: workingTreeFindings },
  gitHistory: history,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "PASS" ? 0 : result.status === "REVIEW_REQUIRED" ? 1 : 2);
