#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// LEGACY_DEPLOY_DISABLED
// 旧 wangzhanbeifen 历史仓已冻结。此脚本不得作为当前版本的发布入口；
// 未来只有在新建干净私有 origin/backup、完成凭据轮换并取得当次授权后，
// 才能由人工审查后替换为新的发布脚本。
console.error("BLOCKED: 旧 Gitee 发布入口已冻结；本地 当前版本/ 是开发事实源，禁止向 wangzhanbeifen 推送。");
process.exit(2);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(process.env.PROJECT_ROOT || path.join(scriptDir, ".."));
const repoUrl = process.env.REPO_URL || "git@gitee.com:zhujunguo/wangzhanbeifen.git";
const branch = process.env.BRANCH || "main";
const sourceSubdir = process.env.SOURCE_SUBDIR || "自媒体操盘手/V2.6_20260806_沙箱项目定稿/源码";
const dryRun = process.argv.includes("--dry-run");
const messageArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run" && arg !== "--");
const commitMessage = messageArgs.join(" ").trim() || `release: full source ${new Date().toISOString()}`;
const tempDir = path.join(os.tmpdir(), `agent-hub-gitee-full-${process.pid}`);

const excludedRootNames = new Set([
  ".git",
  ".next",
  "node_modules",
  ".secure",
  ".codex-designs",
  ".codex-screenshots",
  ".codex-temp",
  ".logs",
  ".rollback-voice-studio",
  ".tmp-help-audit",
  ".tmp-runtime",
  ".tmp-e2e",
  "tmp",
  "backups",
  "logs",
  "tsconfig.tsbuildinfo",
]);

const excludedRelativePaths = new Set([
  "public/uploads",
  "scripts/tencent_key",
]);

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: process.env,
    stdio: options.stdio || "inherit",
  });
}

function runStatus(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: process.env,
    stdio: options.stdio || "inherit",
  }).status ?? 1;
}

function rmSafe(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isExcluded(relativePath, name) {
  const posix = toPosix(relativePath);
  if (excludedRootNames.has(posix) || excludedRootNames.has(name)) return true;
  if (excludedRelativePaths.has(posix)) return true;
  if (name === ".env" || name.startsWith(".env.local") || name.startsWith(".env.production")) return true;
  if (name.endsWith(".log") || name.endsWith(".tmp") || name.endsWith(".temp")) return true;
  return false;
}

function copyTree(sourceDir, targetDir, baseDir = sourceDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(baseDir, sourcePath);
    if (isExcluded(relativePath, entry.name)) continue;
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath, baseDir);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function findForbidden(dir) {
  const found = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(dir, fullPath));
      if ([".env.local", ".next", "node_modules"].includes(entry.name) || relativePath === "scripts/tencent_key") {
        found.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) walk(fullPath);
    }
  }
  walk(dir);
  return found;
}

try {
  log("Running local release preflight");
  run(process.execPath, [path.join(projectRoot, "scripts/release-preflight.mjs"), "--root", projectRoot]);

  rmSafe(tempDir);
  log(`Cloning ${repoUrl}#${branch}`);
  run("git", ["clone", "--branch", branch, repoUrl, tempDir]);

  run("git", ["config", "user.email", process.env.GIT_USER_EMAIL || "release@agent-hub.local"], { cwd: tempDir });
  run("git", ["config", "user.name", process.env.GIT_USER_NAME || "Agent Hub Release Bot"], { cwd: tempDir });

  const targetDir = path.resolve(tempDir, sourceSubdir);
  if (!targetDir.startsWith(path.resolve(tempDir) + path.sep)) {
    throw new Error(`Refusing to write outside temp repo: ${targetDir}`);
  }

  rmSafe(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  log(`Copying full source into repo path: ${sourceSubdir}`);
  copyTree(projectRoot, targetDir);

  fs.writeFileSync(path.join(targetDir, "deploy-manifest.json"), `${JSON.stringify({
    kind: "agent-hub-full-source-release",
    source_subdir: sourceSubdir,
    published_at: new Date().toISOString(),
    commit_message: commitMessage,
    data_policy: "code plus static avatars; env, uploads, backups, node_modules and build outputs are excluded",
  }, null, 2)}\n`);

  log("Running packaged release preflight");
  run(process.execPath, [path.join(targetDir, "scripts/release-preflight.mjs"), "--root", targetDir]);

  const forbidden = findForbidden(targetDir);
  if (forbidden.length > 0) {
    throw new Error(`Packaged release contains forbidden files: ${forbidden.join(", ")}`);
  }

  run("git", ["add", "-A", sourceSubdir], { cwd: tempDir });
  const diffStatus = runStatus("git", ["diff", "--cached", "--quiet"], { cwd: tempDir, stdio: "ignore" });
  if (diffStatus === 0) {
    log("No source changes to publish.");
    process.exit(0);
  }

  if (dryRun) {
    run("git", ["diff", "--cached", "--stat"], { cwd: tempDir });
    log("Dry run complete. No commit or push was made.");
    process.exit(0);
  }

  run("git", ["commit", "-m", commitMessage], { cwd: tempDir });
  run("git", ["push", "origin", branch], { cwd: tempDir });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf8" }).trim();
  log(`Published full source release: ${commit}`);
  log(`Server webhook should deploy this exact commit from: ${sourceSubdir}`);
} catch (error) {
  console.error(`Release publish failed: ${error instanceof Error ? error.message : String(error)}`);
  if (String(error?.message || "").includes("Could not read from remote repository")) {
    console.error("Check that this machine has read/write access to the Gitee repo, or set REPO_URL to an HTTPS/token remote.");
  }
  process.exitCode = 1;
} finally {
  if (tempDir.startsWith(os.tmpdir())) rmSafe(tempDir);
}
