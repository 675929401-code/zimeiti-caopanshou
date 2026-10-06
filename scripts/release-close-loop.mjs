#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
// Keep the historical npm alias fail-closed before reading configuration or
// spawning any command. All writes use the current accepted-release publisher.
if ([...args].some(arg => arg === "--push-git" || arg.startsWith("--push-git="))) {
  console.error("LEGACY_GIT_PUSH_DISABLED: use 自媒体操盘手版本工作台.ps1 -Action Publish after local release acceptance.");
  process.exit(2);
}
const humanMode = args.has("--human") || args.has("--summary");
const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const topologyPath = path.join(root, "deploy", "environments", "production-topology.template.json");
const topology = fs.existsSync(topologyPath) ? JSON.parse(fs.readFileSync(topologyPath, "utf8")) : null;
const releaseRepo = path.resolve(
  process.env.RELEASE_REPO
    || path.join(root, "..", "Git发布仓", "zimeiti-caopanshou-source-vnext"),
);
const gitBin = process.env.GIT_BIN || "git";
const databaseEnvNames = policy.database?.migrationDatabaseUrlEnv || [
  "DEPLOY_DATABASE_URL",
  "SUPABASE_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
];

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

function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function remoteHost(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value) return null;
  if (/^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("/") || value.includes("\\")) {
    return null;
  }
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
  if (/^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("/") || value.includes("\\")) {
    return value;
  }
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

function summarizeCheck(gate, checkName) {
  const check = Array.isArray(gate?.checks)
    ? gate.checks.find((item) => item?.name === checkName)
    : null;
  if (!check) return null;
  return {
    name: check.name,
    passed: check.passed,
    severity: check.severity,
    detail: check.detail,
    data: check.data,
  };
}

function statusLabel(ok) {
  return ok ? "通过" : "未通过";
}

function yesNo(value) {
  return value ? "是" : "否";
}

function formatHumanReport(result) {
  const lines = [];
  const codeOk = result.gates.code.status === "PASS";
  const productionOk = result.gates.production.status === "PASS";
  const release = result.releaseRepo;
  const database = result.database;
  const schema = result.gates.production.productionSchema;
  const gitTopology = result.recommendedTopology?.git;
  const productionEnvironment = result.productionEnvironment;

  lines.push("自媒体操盘手发布闭环状态");
  lines.push("");
  lines.push(`总体结论：${result.ok ? "可以进入服务器部署" : "暂不能正式部署"}`);
  lines.push(`生成时间：${result.generatedAt}`);
  lines.push("");
  lines.push("一、本地端");
  lines.push(`- 代码门禁：${statusLabel(codeOk)}（${result.gates.code.status}）`);
  if (result.gates.code.localPreview?.detail) lines.push(`- 本地预览：${result.gates.code.localPreview.detail}`);
  if (result.gates.code.source?.detail) lines.push(`- 源码/素材：${result.gates.code.source.detail}`);
  lines.push("");
  lines.push("二、Git 发布仓");
  lines.push(`- 发布仓存在：${yesNo(release.exists)}`);
  lines.push(`- 分支：${release.branch || "未知"}`);
  lines.push(`- 提交：${release.head || "未知"}`);
  lines.push(`- 工作区干净：${yesNo(release.clean)}`);
  lines.push(`- 正式远程就绪：${yesNo(release.formalRemotesReady)}`);
  if (release.missingRemotes?.length) lines.push(`- 缺少远程：${release.missingRemotes.join("、")}`);
  if (release.remotes?.length) {
    lines.push(`- 当前远程：${release.remotes.map((remote) => `${remote.name}(${remote.host})`).join("、")}`);
  }
  if (gitTopology) {
    lines.push(`- 推荐主仓：${gitTopology.origin}`);
    lines.push(`- 推荐备份：${gitTopology.backup}`);
  }
  lines.push("");
  lines.push("三、生产数据库");
  lines.push(`- 数据库直连变量已配置：${yesNo(database.configured)}`);
  if (database.plan?.migrationCount !== undefined) {
    lines.push(`- 本地迁移文件：${database.plan.migrationCount} 个`);
    lines.push(`- 迁移清单：${database.plan.manifestSha256 || "未知"}`);
  }
  if (schema?.detail) lines.push(`- 线上结构状态：${schema.detail}`);
  lines.push("");
  lines.push("四、服务器与素材环境");
  if (productionEnvironment) {
    lines.push(`- 环境门禁：${statusLabel(productionEnvironment.status === "PASS")}（${productionEnvironment.status}）`);
    const envChecks = productionEnvironment.checks || {};
    if (envChecks.serverSshTarget?.detail) lines.push(`- SSH 目标：${envChecks.serverSshTarget.detail}`);
    if (envChecks.serverReleaseRoot?.detail) lines.push(`- 发布根目录：${envChecks.serverReleaseRoot.detail}`);
    if (envChecks.assetStorageMode?.detail) lines.push(`- 素材模式：${envChecks.assetStorageMode.detail}`);
  } else {
    lines.push("- 环境门禁：未知");
  }
  lines.push("");
  lines.push("五、上线门禁");
  lines.push(`- 生产门禁：${statusLabel(productionOk)}（${result.gates.production.status}）`);
  if (result.blockers.length) {
    lines.push(`- 当前阻断：${result.blockers.join("、")}`);
  } else {
    lines.push("- 当前阻断：无");
  }
  lines.push("");
  lines.push("下一步");
  for (const action of result.nextActions) lines.push(`- ${action}`);
  lines.push("");
  lines.push("安全提醒：不要把数据库密码、Git token、SSH 私钥发到聊天里；只配置到本机环境变量、CI Secret 或服务器面板。");
  return lines.join("\n");
}

function readReleaseRepo() {
  const repoExists = fs.existsSync(path.join(releaseRepo, ".git"));
  if (!repoExists) return { exists: false, path: releaseRepo };
  const branch = run(gitBin, ["branch", "--show-current"], { cwd: releaseRepo }).stdout.trim();
  const head = run(gitBin, ["rev-parse", "--short=12", "HEAD"], { cwd: releaseRepo }).stdout.trim();
  const status = run(gitBin, ["status", "--porcelain=v1"], { cwd: releaseRepo }).stdout.trim();
  const remotes = run(gitBin, ["remote"], { cwd: releaseRepo }).stdout
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name) => {
      const url = run(gitBin, ["remote", "get-url", name], { cwd: releaseRepo }).stdout.trim();
      return { name, url: redactRemoteUrl(url), host: remoteHost(url) || "local" };
    });
  const required = policy.git?.requiredRemotes || [];
  const configured = new Set(remotes.map((item) => item.name));
  const missing = required.filter((name) => !configured.has(name));
  const localRequired = remotes
    .filter((item) => required.includes(item.name))
    .filter((item) => item.host === "local")
    .map((item) => item.name);
  const distinctHosts = new Set(remotes.filter((item) => required.includes(item.name)).map((item) => item.host));
  return {
    exists: true,
    path: releaseRepo,
    branch,
    head,
    clean: status.length === 0,
    remotes,
    requiredRemotes: required,
    missingRemotes: missing,
    localRequiredRemotes: localRequired,
    distinctRequiredRemoteHosts: distinctHosts.size,
    formalRemotesReady: missing.length === 0
      && (policy.git?.allowLocalRemotes !== false || localRequired.length === 0)
      && (!policy.git?.requireDistinctRemoteHosts || distinctHosts.size === required.length),
  };
}

function getDatabaseEnvState() {
  return databaseEnvNames.map((name) => {
    const value = process.env[name];
    let host = null;
    if (value) {
      try {
        host = new URL(value).hostname;
      } catch {
        host = "configured-but-not-url";
      }
    }
    return { name, configured: Boolean(value), host };
  });
}

const codeGateResult = run(process.execPath, ["./scripts/verify-deployment-readiness.mjs", "--mode=code"]);
const codeGate = extractJsonObject(codeGateResult.stdout);
const releaseRepoState = readReleaseRepo();
const gitPush = { attempted: false, reason: "Read-only legacy diagnostic; publish via 自媒体操盘手版本工作台.ps1 -Action Publish" };
const migrationPlanResult = run(process.execPath, ["./scripts/db-migration-release.mjs", "plan"]);
const migrationPlan = extractJsonObject(migrationPlanResult.stdout);
const databaseEnvState = getDatabaseEnvState();
const databaseConfigured = databaseEnvState.some((item) => item.configured);
const migrationStatusResult = databaseConfigured
  ? run(process.execPath, ["./scripts/db-migration-release.mjs", "status"])
  : null;
const migrationStatus = migrationStatusResult ? extractJsonObject(migrationStatusResult.stdout) : null;
const productionGateResult = run(process.execPath, ["./scripts/verify-deployment-readiness.mjs", "--mode=production"]);
const productionGate = extractJsonObject(productionGateResult.stdout);
const productionEnvironmentResult = run(process.execPath, ["./scripts/verify-production-environment.mjs", "--json"]);
const productionEnvironmentGate = extractJsonObject(productionEnvironmentResult.stdout);

const blockers = [];
if (!(codeGateResult.status === 0 && codeGate?.status === "PASS")) {
  blockers.push("CODE_GATE_NOT_PASS");
}
if (!releaseRepoState.formalRemotesReady) {
  blockers.push("FORMAL_GIT_REMOTES_NOT_READY");
}
if (!databaseConfigured) {
  blockers.push("DEPLOY_DATABASE_URL_NOT_CONFIGURED");
}
if (productionGate?.status !== "PASS") {
  const productionBlockers = Array.isArray(productionGate?.checks)
    ? productionGate.checks
        .filter((item) => item?.severity === "blocker")
        .map((item) => item.name)
    : ["PRODUCTION_GATE_NOT_PASS"];
  blockers.push(...productionBlockers);
}
if (productionEnvironmentGate?.status !== "PASS") {
  blockers.push("production-environment");
}
if (gitPush.attempted && !gitPush.ok) {
  blockers.push("FORMAL_GIT_PUSH_FAILED");
}

const result = {
  ok: blockers.length === 0,
  canExecuteServerDeploy: blockers.length === 0,
  generatedAt: new Date().toISOString(),
  releaseRepo: releaseRepoState,
  gates: {
    code: {
      exitCode: codeGateResult.status,
      status: codeGate?.status || "UNKNOWN",
      summary: codeGate?.summary,
      source: summarizeCheck(codeGate, "source-audit"),
      toolchain: summarizeCheck(codeGate, "package-toolchain"),
      localPreview: summarizeCheck(codeGate, "local-preview-build"),
    },
    production: {
      exitCode: productionGateResult.status,
      status: productionGate?.status || "UNKNOWN",
      summary: productionGate?.summary,
      productionSchema: summarizeCheck(productionGate, "production-schema"),
      releaseRepository: summarizeCheck(productionGate, "release-repository"),
    },
  },
  productionEnvironment: productionEnvironmentGate ? {
    exitCode: productionEnvironmentResult.status,
    status: productionEnvironmentGate.status,
    summary: productionEnvironmentGate.summary,
    checks: {
      gitFormalRemotes: summarizeCheck(productionEnvironmentGate, "git-formal-remotes"),
      databaseMigrationUrl: summarizeCheck(productionEnvironmentGate, "database-migration-url"),
      serverSshTarget: summarizeCheck(productionEnvironmentGate, "server-ssh-target"),
      serverReleaseRoot: summarizeCheck(productionEnvironmentGate, "server-release-root"),
      serverIncomingDir: summarizeCheck(productionEnvironmentGate, "server-incoming-dir"),
      assetStorageMode: summarizeCheck(productionEnvironmentGate, "asset-storage-mode"),
      cosCdnConfig: summarizeCheck(productionEnvironmentGate, "cos-cdn-config"),
    },
  } : {
    exitCode: productionEnvironmentResult.status,
    status: "UNKNOWN",
    summary: null,
    checks: {},
  },
  database: {
    env: databaseEnvState,
    configured: databaseConfigured,
    plan: migrationPlan ? {
      ok: migrationPlan.ok,
      migrationRoot: migrationPlan.migrationRoot,
      migrationCount: migrationPlan.migrationCount,
      manifestSha256: migrationPlan.manifestSha256,
      databaseConfigured: migrationPlan.database?.configured,
      invalid: migrationPlan.invalid,
      warnings: migrationPlan.warnings,
    } : {
      ok: false,
      error: migrationPlanResult.error || migrationPlanResult.stderr.split(/\r?\n/u).slice(0, 4).join("\n"),
    },
    status: migrationStatus ? {
      ok: migrationStatus.ok,
      targetHost: migrationStatus.database?.targetHost || migrationStatus.targetHost,
      appliedCount: migrationStatus.appliedCount,
      pendingCount: migrationStatus.pendingCount,
      manifestSha256: migrationStatus.manifestSha256,
    } : null,
  },
  recommendedTopology: topology ? {
    git: {
      origin: topology.git?.primaryRemote?.recommendedProvider,
      backup: topology.git?.backupRemote?.recommendedProvider,
      originRepositoryName: topology.git?.primaryRemote?.repositoryName,
      backupRepositoryName: topology.git?.backupRemote?.repositoryName,
    },
    assets: {
      shortTerm: topology.assets?.shortTerm?.strategy,
      longTerm: topology.assets?.longTerm?.strategy,
    },
    serverDeployMode: topology.serverDeploy?.mode,
  } : null,
  gitPush,
  blockers: Array.from(new Set(blockers)),
  nextActions: blockers.length === 0 ? [
    "Run the artifact build/package flow, then execute scripts/deploy-artifact-vnext.sh --plan and --execute on the server.",
  ] : [
    ...(releaseRepoState.formalRemotesReady ? [] : ["Read docs/本地版本与发布协议.md and the configured version workbench. Use its Publish action only after current local release acceptance."]),
    ...(databaseConfigured ? [] : ["Set DEPLOY_DATABASE_URL or another approved database URL variable in the shell/CI/secret manager; do not paste it into chat."]),
    ...(productionEnvironmentGate?.status === "PASS" ? [] : ["Configure production env from deploy/environments/production.env.example, then run npm run deploy:env:verify."]),
    ...(productionGate?.status === "PASS" ? [] : ["After database backup and migration apply, rerun npm run deploy:ready until production status is PASS."]),
  ],
};

console.log(humanMode ? formatHumanReport(result) : JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
