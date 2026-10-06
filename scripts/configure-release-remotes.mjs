#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const releaseRepo = path.resolve(
  process.env.RELEASE_REPO
    || path.join(root, "..", "Git发布仓", "zimeiti-caopanshou-source-vnext"),
);
const gitBin = process.env.GIT_BIN || "git";
const requiredRemotes = policy.git?.requiredRemotes || ["origin", "backup"];

function valueOf(name) {
  const prefix = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : "";
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : null,
  };
}

function fail(message, data = {}) {
  console.error(JSON.stringify({
    ok: false,
    applied: false,
    error: message,
    ...data,
  }, null, 2));
  process.exit(1);
}

function isLocalPath(value) {
  return /^[a-zA-Z]:[\\/]/u.test(value)
    || value.startsWith("\\\\")
    || value.startsWith("/")
    || value.includes("\\");
}

function remoteHost(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value || isLocalPath(value)) return null;
  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      if (!["https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname || parsed.password) return null;
      if (parsed.protocol === "https:" && parsed.username) return null;
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  const scpLike = /^([^@:]+@)?([^:/]+):[^:]+$/u.exec(value);
  return scpLike ? scpLike[2].toLowerCase() : null;
}

function redactRemoteUrl(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value) return value;
  if (isLocalPath(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return value.replace(/^([^@\s]+)@([^:\s]+):/u, "git@$2:");
  }
}

function describeRemote(name, url) {
  return {
    name,
    url: redactRemoteUrl(url),
    host: remoteHost(url),
  };
}

function readExistingRemotes() {
  const names = run(gitBin, ["remote"], { cwd: releaseRepo }).stdout
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return names.map((name) => {
    const url = run(gitBin, ["remote", "get-url", name], { cwd: releaseRepo }).stdout.trim();
    return describeRemote(name, url);
  });
}

function setRemote(name, url) {
  const existing = run(gitBin, ["remote", "get-url", name], { cwd: releaseRepo });
  if (existing.status === 0) {
    return run(gitBin, ["remote", "set-url", name, url], { cwd: releaseRepo });
  }
  return run(gitBin, ["remote", "add", name, url], { cwd: releaseRepo });
}

if (!fs.existsSync(path.join(releaseRepo, ".git"))) {
  fail("RELEASE_REPO_NOT_FOUND", { releaseRepo });
}

const provided = Object.fromEntries(requiredRemotes.map((name) => [name, valueOf(`--${name}`) || process.env[`RELEASE_${name.toUpperCase()}_URL`] || ""]));
const missingInputs = requiredRemotes.filter((name) => !provided[name]);
if (missingInputs.length) {
  fail("MISSING_REMOTE_URLS", {
    releaseRepo,
    missingInputs,
    usage: "node ./scripts/configure-release-remotes.mjs --origin=<git-url> --backup=<git-url> [--apply]",
    envAlternative: "RELEASE_ORIGIN_URL and RELEASE_BACKUP_URL",
    safety: "Do not include passwords, tokens, or private keys in remote URLs.",
    existingRemotes: readExistingRemotes(),
  });
}

const candidates = requiredRemotes.map((name) => describeRemote(name, provided[name]));
const invalid = candidates.filter((remote) => !remote.host);
if (invalid.length) {
  fail("INVALID_OR_LOCAL_REMOTE_URL", {
    releaseRepo,
    invalid,
    rule: "origin and backup must be non-local SSH or HTTPS remotes; HTTPS URLs must not contain username/password/token.",
  });
}

const hosts = new Set(candidates.map((remote) => remote.host));
if (policy.git?.requireDistinctRemoteHosts && hosts.size !== candidates.length) {
  fail("REMOTE_HOSTS_NOT_DISTINCT", {
    releaseRepo,
    remotes: candidates,
    rule: "origin and backup must be on distinct remote hosts.",
  });
}

const branch = run(gitBin, ["branch", "--show-current"], { cwd: releaseRepo }).stdout.trim();
const status = run(gitBin, ["status", "--porcelain=v1"], { cwd: releaseRepo }).stdout.trim();
if (branch !== policy.git?.primaryBranch) {
  fail("RELEASE_BRANCH_MISMATCH", { releaseRepo, branch, expectedBranch: policy.git?.primaryBranch });
}
if (status.length) {
  fail("RELEASE_REPO_NOT_CLEAN", { releaseRepo, status: status.split(/\r?\n/u).slice(0, 20) });
}

const before = readExistingRemotes();
const appliedResults = [];
if (apply) {
  for (const [name, url] of Object.entries(provided)) {
    const result = setRemote(name, url);
    appliedResults.push({
      name,
      ok: result.status === 0,
      status: result.status,
      stderrPreview: (result.stderr || result.error || "").split(/\r?\n/u).slice(0, 4).join("\n"),
    });
  }
  if (!appliedResults.every((item) => item.ok)) {
    fail("REMOTE_WRITE_FAILED", { releaseRepo, remotes: candidates, appliedResults, before, after: readExistingRemotes() });
  }
}

console.log(JSON.stringify({
  ok: true,
  applied: apply,
  releaseRepo,
  requiredRemotes,
  remotes: candidates,
  before,
  after: apply ? readExistingRemotes() : before,
  next: apply
    ? "After current local release acceptance, use 自媒体操盘手版本工作台.ps1 -Action Publish to verify and push the exact commit to backup and origin."
    : "Review the remotes, then rerun with --apply to write origin and backup.",
}, null, 2));
