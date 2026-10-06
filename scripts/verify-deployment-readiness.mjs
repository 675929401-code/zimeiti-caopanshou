#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const args = process.argv.slice(2);
const modeArg = valueOf("--mode") || "production";
const mode = modeArg === "code" ? "code" : "production";
const root = path.resolve(valueOf("--root") || process.cwd());
const defaultReleaseRepo = fs.existsSync(path.join(root, ".git"))
  ? root
  : path.join(root, "..", "Git发布仓", "zimeiti-caopanshou-source-vnext");
const releaseRepo = path.resolve(
  valueOf("--release-repo")
    || defaultReleaseRepo,
);
const baseUrl = (valueOf("--base-url") || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const gitBin = process.env.GIT_BIN || "git";
const nodeTsxRunner = path.join(root, "scripts", "run-node-maintenance-tsx.mjs");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function valueOf(name) {
  const exact = args.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    encoding: "utf8",
    windowsHide: true,
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

function httpJson(urlPath, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, baseUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      { method: "GET", timeout: timeoutMs, headers: { Accept: "application/json" } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // keep null; the body is intentionally not printed in full
          }
          resolve({
            ok: response.statusCode && response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            json,
            bodyPreview: json ? null : body.slice(0, 240),
          });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("request timeout"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, status: 0, json: null, error: error.message });
    });
    request.end();
  });
}

function httpResource(urlPath, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, baseUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      { method: "GET", timeout: timeoutMs, headers: { Accept: "image/*,video/*;q=0.9,*/*;q=0.1" } },
      (response) => {
        const result = {
          ok: response.statusCode && response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          contentType: String(response.headers["content-type"] || ""),
          cacheControl: String(response.headers["cache-control"] || ""),
        };
        response.resume();
        resolve(result);
      },
    );
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", (error) => {
      resolve({ ok: false, status: 0, contentType: "", cacheControl: "", error: error.message });
    });
    request.end();
  });
}

function remoteHost(remoteUrl) {
  const value = String(remoteUrl || "").trim();
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

function safeRemoteMetadata(name, remoteUrl) {
  const value = String(remoteUrl || "").trim();
  const host = remoteHost(value);
  const local = host === null;
  const scpLike = value.includes("://") ? null : /^([^@:]+@)?([^:/]+):(.+)$/u.exec(value);
  let kind = "unknown";
  let embeddedCredential = false;

  if (/^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("\\\\") || value.startsWith("/")) {
    kind = "local";
  } else if (scpLike) {
    kind = "ssh";
    // An SSH username identifies the transport account. It is not a password,
    // but the raw userinfo and repository path still do not belong in a
    // machine-readable readiness report that may be persisted or shared.
  } else {
    try {
      const parsed = new URL(value);
      kind = parsed.protocol.replace(/:$/u, "") || "unknown";
      embeddedCredential = Boolean(parsed.password)
        || (parsed.protocol === "https:" && Boolean(parsed.username));
    } catch {
      kind = "unknown";
    }
  }

  return {
    name,
    kind,
    host: host || "local",
    local,
    embeddedCredential,
  };
}

function verdict({
  name,
  passed,
  hardInProduction = false,
  hardInCode = false,
  detail,
  data,
  next,
}) {
  const hard = mode === "production" ? hardInProduction : hardInCode;
  return {
    name,
    passed: Boolean(passed),
    severity: passed ? "pass" : hard ? "blocker" : "warning",
    detail,
    ...(data === undefined ? {} : { data }),
    ...(next ? { next } : {}),
  };
}

function summarizeFailed(commandResult) {
  return commandResult.error
    || commandResult.stderr.trim().split(/\r?\n/u).slice(0, 3).join("\n")
    || commandResult.stdout.trim().split(/\r?\n/u).slice(0, 3).join("\n")
    || `exit ${commandResult.status}`;
}

function runTsx(scriptPath) {
  if (fs.existsSync(nodeTsxRunner)) return run(process.execPath, [nodeTsxRunner, scriptPath]);
  return fs.existsSync(tsxCli)
    ? run(process.execPath, [tsxCli, scriptPath])
    : {
        status: 1,
        stdout: "",
        stderr: "Missing scripts/run-node-maintenance-tsx.mjs and local tsx CLI",
        error: null,
      };
}

async function main() {
  const checks = [];
  const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
  const policy = readJson(policyPath);
  const packageJson = readJson(path.join(root, "package.json"));

  const sourceAudit = run(process.execPath, ["./scripts/release-workflow.mjs", "audit"]);
  const sourceAuditJson = extractJsonObject(sourceAudit.stdout);
  checks.push(verdict({
    name: "source-audit",
    passed: sourceAudit.status === 0 && sourceAuditJson?.status === "PASS",
    hardInProduction: true,
    hardInCode: true,
    detail: sourceAuditJson
      ? `${sourceAuditJson.source?.files ?? "?"} source files, ${sourceAuditJson.externalAssets?.files ?? "?"} external assets`
      : summarizeFailed(sourceAudit),
    data: sourceAuditJson ? {
      fingerprint: sourceAuditJson.source?.fingerprint,
      externalAssetDigest: sourceAuditJson.externalAssets?.pinnedDigest,
      failures: sourceAuditJson.failures || [],
    } : undefined,
    next: "先让 release-workflow audit 通过，再进入任何部署或发布仓同步。",
  }));

  const runnerSource = fs.existsSync(nodeTsxRunner) ? fs.readFileSync(nodeTsxRunner, "utf8") : "";
  const packageScripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const rawTsxScripts = Object.entries(packageScripts)
    .filter(([, command]) => typeof command === "string")
    .filter(([, command]) => /(?:^|\s)(?:pnpm\s+exec\s+)?tsx\s+\.\/scripts\/[^&|;]+\.ts\b/u.test(command))
    .map(([name, command]) => ({ name, command }));
  const toolchainOk = packageJson.packageManager === "pnpm@9.0.0"
    && packageJson.engines?.pnpm === "9.0.0"
    && runnerSource.includes("process.execPath")
    && runnerSource.includes("--import")
    && runnerSource.includes("tsx")
    && runnerSource.includes("Refusing to run a target outside scripts/*.ts")
    && rawTsxScripts.length === 0;
  checks.push(verdict({
    name: "package-toolchain",
    passed: toolchainOk,
    hardInProduction: true,
    hardInCode: true,
    detail: toolchainOk
      ? "package manager pinned; TS maintenance scripts use the project runner"
      : "package toolchain is not reproducible",
    data: {
      packageManager: packageJson.packageManager,
      pnpmEngine: packageJson.engines?.pnpm,
      runner: fs.existsSync(nodeTsxRunner) ? "present" : "missing",
      rawTsxScripts,
    },
    next: "固定 Corepack/pnpm 版本，并让 scripts/*.ts 验收入口统一走 scripts/run-node-maintenance-tsx.mjs。",
  }));

  const secretAudit = run(process.execPath, ["./scripts/verify-release-secret-exposure.mjs"]);
  const secretAuditJson = extractJsonObject(secretAudit.stdout);
  checks.push(verdict({
    name: "release-secret-exposure",
    passed: secretAudit.status === 0 && secretAuditJson?.status === "PASS",
    hardInProduction: true,
    hardInCode: true,
    detail: secretAuditJson
      ? `worktree blockers=${secretAuditJson.summary?.workingTreeBlockingCount ?? "?"}, history blockers=${secretAuditJson.summary?.historyBlockingCount ?? "?"}`
      : summarizeFailed(secretAudit),
    data: secretAuditJson ? {
      status: secretAuditJson.status,
      summary: secretAuditJson.summary,
      workingTree: secretAuditJson.workingTree,
      gitHistory: secretAuditJson.gitHistory,
    } : undefined,
    next: "轮换所有历史泄露凭据，并在建立新干净私有仓前清除或重建含密钥的 Git 历史。",
  }));

  const capacityAudit = run(process.execPath, ["./scripts/verify-release-operational-capacity.mjs", `--mode=${mode}`]);
  const capacityAuditJson = extractJsonObject(capacityAudit.stdout);
  checks.push(verdict({
    name: "operational-capacity",
    passed: capacityAudit.status === 0 && capacityAuditJson?.status === "PASS",
    hardInProduction: true,
    hardInCode: true,
    detail: capacityAuditJson
      ? `${capacityAuditJson.summary?.passed ?? "?"} pass, ${capacityAuditJson.summary?.blockers ?? "?"} blockers`
      : summarizeFailed(capacityAudit),
    data: capacityAuditJson ? {
      targetConcurrency: capacityAuditJson.targetConcurrency,
      summary: capacityAuditJson.summary,
      failed: (capacityAuditJson.checks || [])
        .filter((item) => item.severity !== "pass")
        .map((item) => ({ name: item.name, severity: item.severity, detail: item.detail, evidence: item.evidence })),
    } : undefined,
    next: "高并发发布前实现共享限流状态和浏览器直传对象存储，并在生产门禁补齐恢复演练证据。",
  }));

  for (const item of [
    {
      name: "manju-skill-governance",
      script: "./scripts/verify-manju-skill-governance.ts",
      next: "修复漫剧工作台 Skill 后台治理入口、36 项卡片映射、配置域契约后再部署。",
    },
    {
      name: "manju-public-assets",
      script: "./scripts/verify-manju-public-assets.ts",
      next: "修复后台上传、素材登记、公开读取代理与 /api/inspiration 映射后再部署。",
    },
  ]) {
    const result = runTsx(item.script);
    const resultJson = extractJsonObject(result.stdout);
    checks.push(verdict({
      name: item.name,
      passed: result.status === 0 && resultJson?.ok === true,
      hardInProduction: true,
      hardInCode: true,
      detail: resultJson?.summary
        ? `${resultJson.summary.passed}/${resultJson.summary.total} checks passed`
        : summarizeFailed(result),
      data: resultJson ? {
        failed: resultJson.failed || [],
      } : undefined,
      next: item.next,
    }));
  }

  const migrationRunner = run(process.execPath, ["./scripts/db-migration-release.mjs", "plan"]);
  const migrationRunnerJson = extractJsonObject(migrationRunner.stdout);
  const migrationRunnerOk = migrationRunner.status === 0
    && migrationRunnerJson?.ok === true
    && /^[a-f0-9]{64}$/u.test(migrationRunnerJson?.manifestSha256 || "")
    && migrationRunnerJson?.databaseWrites === 0;
  checks.push(verdict({
    name: "database-migration-runner",
    passed: migrationRunnerOk,
    hardInProduction: true,
    hardInCode: true,
    detail: migrationRunnerJson
      ? `${migrationRunnerJson.migrationCount ?? "?"} migrations, manifest=${migrationRunnerJson.manifestSha256 ?? "missing"}`
      : summarizeFailed(migrationRunner),
    data: migrationRunnerJson ? {
      migrationRoot: migrationRunnerJson.migrationRoot,
      manifestSha256: migrationRunnerJson.manifestSha256,
      migrationCount: migrationRunnerJson.migrationCount,
      databaseConfigured: migrationRunnerJson.database?.configured,
      invalid: migrationRunnerJson.invalid,
      warnings: migrationRunnerJson.warnings,
    } : undefined,
    next: "先让 deploy:db:verify 与 deploy:db:plan 通过；生产缺表时按 plan 哈希和备份回执执行 deploy:db:apply。",
  }));

  const startScriptPath = path.join(root, "scripts", "run-start.mjs");
  const startScript = fs.existsSync(startScriptPath) ? fs.readFileSync(startScriptPath, "utf8") : "";
  checks.push(verdict({
    name: "standalone-start-script",
    passed: startScript.includes("\".next\", \"standalone\"")
      && startScript.includes("server.js")
      && startScript.includes("ensureLinkedDirectory")
      && startScript.includes("verifyLocalBuildFingerprintReceipt")
      && startScript.includes("./scripts/start.sh")
      && !startScript.includes("\"start\", \"-p\""),
    hardInProduction: false,
    hardInCode: true,
    detail: startScript ? "standalone server.js startup with Windows local preview fallback" : "scripts/run-start.mjs missing",
    next: "生产 standalone 构建必须用 server.js 启动，并确保 .next/static 与 public 已随 release artifact 可读。",
  }));

  const diskBuildIdPath = path.join(root, ".next", "BUILD_ID");
  const diskBuildId = fs.existsSync(diskBuildIdPath)
    ? fs.readFileSync(diskBuildIdPath, "utf8").trim()
    : null;
  const version = await httpJson("/api/version");
  const liveBuildId = typeof version.json?.buildId === "string"
    ? version.json.buildId
    : typeof version.json?.version === "string"
      ? version.json.version
      : null;
  checks.push(verdict({
    name: "local-preview-build",
    passed: Boolean(diskBuildId && liveBuildId && diskBuildId === liveBuildId),
    hardInProduction: false,
    hardInCode: true,
    detail: liveBuildId
      ? `live build ${liveBuildId}${diskBuildId ? `, disk build ${diskBuildId}` : ""}`
      : `local preview unavailable at ${baseUrl}/api/version`,
    data: { diskBuildId, liveBuildId, status: version.status },
    next: "重新构建并重启 127.0.0.1:5000，确认 /api/version 与 .next/BUILD_ID 一致。",
  }));

  const runtimeConfig = await httpJson("/api/youcai/runtime-config");
  checks.push(verdict({
    name: "manju-runtime-config",
    passed: runtimeConfig.ok && runtimeConfig.json?.ok === true && runtimeConfig.json?.state === "ready",
    hardInProduction: true,
    hardInCode: false,
    detail: runtimeConfig.ok
      ? "runtime config ready"
      : `${runtimeConfig.status || "no-http"} ${runtimeConfig.json?.code || runtimeConfig.error || "runtime unavailable"}`,
    data: runtimeConfig.json ? {
      code: runtimeConfig.json.code,
      state: runtimeConfig.json.state,
      missingDomains: runtimeConfig.json.missing_domains,
      storageMode: runtimeConfig.json.storage_mode,
    } : undefined,
    next: "完成配置控制平面迁移并发布 1.1.0 production 配置后再放行生产部署。",
  }));

  const skillCatalog = await httpJson("/api/youcai/skills");
  const skillCount = Number.isFinite(skillCatalog.json?.count)
    ? Number(skillCatalog.json.count)
    : Number.isFinite(skillCatalog.json?.catalog_count)
      ? Number(skillCatalog.json.catalog_count)
      : Array.isArray(skillCatalog.json?.skills)
        ? skillCatalog.json.skills.length
        : 0;
  checks.push(verdict({
    name: "youcai-skill-api",
    passed: skillCatalog.ok && skillCatalog.json?.ok === true && skillCount > 0,
    hardInProduction: true,
    hardInCode: false,
    detail: skillCatalog.ok
      ? `skill API ready, visible=${skillCount}`
      : `${skillCatalog.status || "no-http"} ${skillCatalog.json?.code || skillCatalog.error || "skill API unavailable"}`,
    data: skillCatalog.json ? {
      code: skillCatalog.json.code,
      total: skillCatalog.json.total,
      count: skillCount,
      mode: skillCatalog.json.mode,
      operation: skillCatalog.json.operation,
    } : undefined,
    next: "Skill 包为空时必须继续提供可见的内置目录；安装/自建/发布能力仍按 package store 状态独立验收。",
  }));

  const discovery = await httpJson("/api/commerce/v1/discover/home", 15_000);
  const discoveryItems = Array.isArray(discovery.json?.items) ? discovery.json.items : [];
  const discoveryMediaPath = discoveryItems
    .map((item) => item && typeof item === "object" ? item.coverUrl : null)
    .find((value) => typeof value === "string" && /^\/commerce\/discovery\/media\/[a-f0-9]{64}\.[a-z0-9]{2,8}$/iu.test(value));
  const discoveryMedia = discoveryMediaPath
    ? await httpResource(discoveryMediaPath, 15_000)
    : { ok: false, status: 0, contentType: "", cacheControl: "", error: "cover media path missing" };
  const discoveryReady = discovery.ok
    && discovery.json?.schema === 1
    && discoveryItems.length > 0
    && Boolean(discoveryMediaPath)
    && discoveryMedia.ok
    && /^(?:image|video)\//iu.test(discoveryMedia.contentType);
  checks.push(verdict({
    name: "commerce-discovery-media",
    passed: discoveryReady,
    hardInProduction: true,
    hardInCode: false,
    detail: discoveryReady
      ? `${discoveryItems.length} discovery items; verified one same-origin media response`
      : `catalog HTTP ${discovery.status || "unavailable"}; media HTTP ${discoveryMedia.status || "unavailable"}`,
    data: {
      itemCount: discoveryItems.length,
      mediaPathPresent: Boolean(discoveryMediaPath),
      mediaStatus: discoveryMedia.status,
      mediaContentType: discoveryMedia.contentType,
      mediaCacheControl: discoveryMedia.cacheControl,
    },
    next: "带货案例目录、动态媒体路由和 shared/runtime/commerce-discovery 镜像必须同时可读，缺一项即阻断发布。",
  }));

  if (mode === "production") {
    const schema = runTsx("./scripts/verify-production-schema-readiness.ts");
    const schemaJson = extractJsonObject(schema.stdout);
    checks.push(verdict({
      name: "production-schema",
      passed: schema.status === 0 && schemaJson?.readiness !== "migration_not_ready",
      hardInProduction: true,
      hardInCode: false,
      detail: schemaJson
        ? `${schemaJson.readiness}; missing tables=${schemaJson.missingTables?.length ?? 0}, missing rpcs=${schemaJson.missingRpcs?.length ?? 0}`
        : summarizeFailed(schema),
      data: schemaJson ? {
        readiness: schemaJson.readiness,
        missingTables: schemaJson.missingTables,
        missingRpcs: schemaJson.missingRpcs,
        missingColumns: schemaJson.missingColumns,
        databaseWrites: schemaJson.databaseWrites,
        paidModelCalls: schemaJson.paidModelCalls,
      } : undefined,
      next: "生产数据库先备份，再按 migrationRoot 的 reviewed forward-only 流程执行迁移。",
    }));
  } else {
    checks.push(verdict({
      name: "production-schema",
      passed: true,
      detail: "skipped in code mode; production database verification requires an explicit production gate",
      data: { networkCalls: 0, databaseWrites: 0, paidModelCalls: 0 },
      next: "仅在获准的生产预检中运行生产数据库只读核验。",
    }));
  }

  const repoExists = fs.existsSync(releaseRepo) && fs.existsSync(path.join(releaseRepo, ".git"));
  let repoData = { releaseRepo, exists: repoExists };
  let repoClean = false;
  let branchOk = false;
  let remotesOk = false;
  if (repoExists) {
    const status = run(gitBin, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: releaseRepo });
    const branch = run(gitBin, ["branch", "--show-current"], { cwd: releaseRepo });
    const remotes = run(gitBin, ["remote"], { cwd: releaseRepo });
    const remoteRows = [];
    for (const name of remotes.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
      const url = run(gitBin, ["remote", "get-url", name], { cwd: releaseRepo }).stdout.trim();
      remoteRows.push(safeRemoteMetadata(name, url));
    }
    repoClean = status.status === 0 && status.stdout.length === 0;
    branchOk = branch.stdout.trim() === policy.git.primaryBranch;
    const required = policy.git.requiredRemotes || [];
    const configured = new Set(remoteRows.map((item) => item.name));
    const missing = required.filter((name) => !configured.has(name));
    const localRequired = remoteRows
      .filter((item) => required.includes(item.name))
      .filter((item) => item.local)
      .map((item) => item.name);
    const credentialedRequired = remoteRows
      .filter((item) => required.includes(item.name) && item.embeddedCredential)
      .map((item) => item.name);
    const distinctHosts = new Set(remoteRows.filter((item) => required.includes(item.name)).map((item) => item.host));
    remotesOk = missing.length === 0
      && (policy.git.allowLocalRemotes !== false || localRequired.length === 0)
      && credentialedRequired.length === 0
      && (!policy.git.requireDistinctRemoteHosts || distinctHosts.size === required.length);
    repoData = {
      ...repoData,
      clean: repoClean,
      branch: branch.stdout.trim(),
      expectedBranch: policy.git.primaryBranch,
      requiredRemotes: required,
      remotes: remoteRows,
      missingRemotes: missing,
      localRequiredRemotes: localRequired,
      credentialedRequiredRemotes: credentialedRequired,
    };
  }
  checks.push(verdict({
    name: "release-repository",
    passed: repoExists && repoClean && branchOk && (mode === "code" || remotesOk),
    hardInProduction: true,
    hardInCode: true,
    detail: repoExists
      ? `clean=${repoClean}, branch=${repoData.branch || "unknown"}, formalRemotes=${remotesOk}`
      : `missing release repo: ${releaseRepo}`,
    data: repoData,
    next: mode === "production"
      ? "配置正式 origin 与独立 backup 远端并推送同一 commit。"
      : "code 模式允许本地归档远端继续优化；生产模式仍必须配置 origin/backup。",
  }));

  const blockers = checks.filter((check) => check.severity === "blocker");
  const warnings = checks.filter((check) => check.severity === "warning");
  const result = {
    verifier: "deployment-readiness",
    mode,
    status: blockers.length === 0 ? "PASS" : "NO_GO",
    generatedAt: new Date().toISOString(),
    baseUrl,
    releaseRepo,
    summary: {
      blockers: blockers.length,
      warnings: warnings.length,
      passed: checks.filter((check) => check.severity === "pass").length,
    },
    checks,
    nextActions: [
      ...blockers.map((check) => ({ check: check.name, action: check.next })),
      ...warnings.map((check) => ({ check: check.name, action: check.next })),
    ],
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(blockers.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({
    verifier: "deployment-readiness",
    status: "ERROR",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(2);
});
