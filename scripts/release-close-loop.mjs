#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const AUTHORITY = "../../../99_系统协议/02_操作协议/自媒体操盘手部署执行规约-当前版.md";
const WINDOWS_SOURCE = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本";
const fail = (code) => Object.assign(new Error(code), { diagnosticCode: code });

export function parseDiagnosticArgs(args) {
  if (args.some(arg => arg === "--push-git" || arg.startsWith("--push-git="))) {
    throw fail("LEGACY_GIT_PUSH_DISABLED");
  }
  const supported = new Set(["--human", "--summary", "--json", "--help", "-h"]);
  if (args.some(arg => !supported.has(arg))) throw fail("LOCAL_DIAGNOSTIC_ARGUMENT_UNSUPPORTED");
  return { help: args.includes("--help") || args.includes("-h"), human: args.includes("--human") || args.includes("--summary") };
}

export function metadataEnvironment(environment, platform = process.platform) {
  const result = {};
  // Do not spread inherited environment: database URLs, tokens and Git redirects
  // must never reach even a read-only child process.
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "WINDIR", "TEMP", "TMP"]) {
    if (environment[key]) result[key] = environment[key];
  }
  return { ...result, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

export function readLocalGit(root, execute = spawnSync, environment = process.env) {
  const allowed = {
    root: ["rev-parse", "--show-toplevel"],
    branch: ["branch", "--show-current"],
    head: ["rev-parse", "--verify", "HEAD"],
    status: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    remotes: ["remote"],
  };
  const results = {};
  for (const [key, args] of Object.entries(allowed)) {
    const result = execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
      cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 512 * 1024,
      env: metadataEnvironment(environment),
    });
    if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== "string") throw fail("LOCAL_GIT_METADATA_UNAVAILABLE");
    results[key] = result.stdout;
  }
  const normalize = value => path.resolve(value).replace(/\\/gu, "/").toLowerCase();
  if (normalize(results.root.trim()) !== normalize(root)) throw fail("LOCAL_GIT_ROOT_MISMATCH");
  const head = results.head.trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) throw fail("LOCAL_GIT_HEAD_INVALID");
  const remoteNames = results.remotes.split(/\r?\n/u).filter(Boolean);
  if (!remoteNames.every(name => /^[A-Za-z0-9._-]+$/u.test(name))) throw fail("LOCAL_GIT_REMOTE_NAME_INVALID");
  return { head, branch: results.branch.trim(), clean: results.status.length === 0, changedPathCount: results.status.split("\0").filter(Boolean).length, remoteNames, remoteDestinations: "NOT_INSPECTED" };
}

export async function collectLocalDiagnostic(root, dependencies = {}) {
  const cwd = dependencies.cwd || process.cwd();
  const platform = dependencies.platform || process.platform;
  const realpath = dependencies.realpath || fs.realpathSync;
  const actualRoot = realpath(root);
  if (realpath(cwd).toLowerCase() !== actualRoot.toLowerCase()) throw fail("LOCAL_DIAGNOSTIC_CWD_MUST_BE_SOURCE");
  if (platform === "win32" && actualRoot.replace(/\\/gu, "/").toLowerCase() !== WINDOWS_SOURCE.toLowerCase()) throw fail("LOCAL_DIAGNOSTIC_F_SOURCE_REQUIRED");
  const authorityPath = path.resolve(actualRoot, AUTHORITY);
  const exists = dependencies.exists || fs.existsSync;
  if (!exists(authorityPath)) throw fail("DEPLOYMENT_AUTHORITY_MISSING");
  const load = dependencies.loadEnvironment || (async () => import("./inspect-engineering-environment.mjs"));
  const { collectEngineeringEnvironment, evaluateEngineeringEnvironment } = await load();
  const bundle = collectEngineeringEnvironment(actualRoot);
  // Empty runtime intentionally means source-contract-only. This entry never
  // invokes pnpm, installs tools, reads runtime secrets or probes remote systems.
  const evaluated = evaluateEngineeringEnvironment(bundle, {});
  const nodeVersion = dependencies.nodeVersion || process.versions.node;
  const git = readLocalGit(actualRoot, dependencies.executeGit || spawnSync, dependencies.environment || process.env);
  const errors = [...evaluated.errors];
  if (nodeVersion !== evaluated.toolchain.nodeVersion) errors.push("LOCAL_NODE_VERSION_DRIFT");
  if (!git.clean) errors.push("SOURCE_WORKTREE_DIRTY");
  return {
    schemaVersion: "local-engineering-diagnostic.v1", generatedAt: new Date().toISOString(),
    scope: "local-diagnostic-source-contract-and-git-metadata-only", ok: errors.length === 0,
    sourceRoot: actualRoot, errors, git,
    engineering: { verdict: "SOURCE_CONTRACT_ONLY", declaredToolchain: evaluated.toolchain, observedNodeVersion: nodeVersion, runtimePnpm: "NOT_OBSERVED" },
    localPreview: { runningLatest: "UNKNOWN-not-inspected" },
    github: { verdict: "UNKNOWN-not-inspected" },
    database: { verdict: "UNKNOWN-not-inspected" },
    production: { verdict: "UNKNOWN-not-inspected" },
    deploymentAuthority: authorityPath, nextActions: [{ kind: "READ_AUTHORITY", path: authorityPath }],
  };
}

export function formatHumanReport(report) {
  return [
    "自媒体操盘手 · 本地工程诊断",
    "范围：当前唯一源码、工程合同和本地 Git 元数据。",
    `本地检查：${report.ok ? "通过" : "未通过"}`,
    `源码：${report.sourceRoot}`,
    `分支：${report.git.branch || "detached HEAD"}；提交：${report.git.head}`,
    `工作区：${report.git.clean ? "干净" : "有未提交改动"}；远端名称：${report.git.remoteNames.join("、") || "无"}`,
    `Node：${report.engineering.observedNodeVersion}；pnpm：未观测`,
    `本地问题：${report.errors.join("、") || "无"}`,
    "当前网页、GitHub、数据库和服务器：未检查；本报告不授予发布许可。",
    "后续动作与门禁只从唯一部署规约读取：",
    report.deploymentAuthority,
  ].join("\n");
}

async function main() {
  // Argument rejection precedes cwd/config reads, local-module imports and all
  // subprocesses. Retired push remains closed even in an empty/broken cwd.
  const options = parseDiagnosticArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/release-close-loop.mjs [--human|--json]\nLocal source diagnostic only. See " + AUTHORITY);
    return;
  }
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const report = await collectLocalDiagnostic(sourceRoot);
  console.log(options.human ? formatHumanReport(report) : JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => {
    const code = error.diagnosticCode || "LOCAL_DIAGNOSTIC_FAILED";
    console.error(JSON.stringify({ schemaVersion: "local-engineering-diagnostic.v1", scope: "local-diagnostic", ok: false, error: code }));
    process.exitCode = ["LEGACY_GIT_PUSH_DISABLED", "LOCAL_DIAGNOSTIC_ARGUMENT_UNSUPPORTED"].includes(code) ? 2 : 1;
  });
}
