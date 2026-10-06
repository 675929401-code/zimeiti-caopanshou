#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const topologyPath = path.join(root, "deploy", "environments", "production-topology.template.json");
const topology = fs.existsSync(topologyPath) ? JSON.parse(fs.readFileSync(topologyPath, "utf8")) : null;
const releaseRepo = path.resolve(
  process.env.RELEASE_REPO
    || path.join(root, "..", "Git发布仓", "zimeiti-caopanshou-source-vnext"),
);
const outputRoot = path.resolve(
  valueOf("--output")
    || process.env.RELEASE_HANDOFF_DIR
    || path.join(root, "..", "Git发布仓", "release-handoffs"),
);
const gitBin = process.env.GIT_BIN || "git";

function valueOf(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1].trim();
  return "";
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    encoding: options.encoding === "buffer" ? undefined : "utf8",
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
  console.error(JSON.stringify({ ok: false, error: message, ...data }, null, 2));
  process.exit(1);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/[.]\d{3}Z$/u, "Z");
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

if (!fs.existsSync(path.join(releaseRepo, ".git"))) {
  fail("RELEASE_REPO_NOT_FOUND", { releaseRepo });
}

const branch = run(gitBin, ["branch", "--show-current"], { cwd: releaseRepo }).stdout.trim();
const expectedBranch = policy.git?.primaryBranch || "main";
if (branch !== expectedBranch) fail("RELEASE_BRANCH_MISMATCH", { branch, expectedBranch, releaseRepo });

const status = run(gitBin, ["status", "--porcelain=v1"], { cwd: releaseRepo }).stdout.trim();
if (status.length) {
  fail("RELEASE_REPO_NOT_CLEAN", { releaseRepo, status: status.split(/\r?\n/u).slice(0, 30) });
}

const commitSha = run(gitBin, ["rev-parse", "HEAD"], { cwd: releaseRepo }).stdout.trim();
const shortSha = commitSha.slice(0, 12);
const generatedAt = new Date().toISOString();
const handoffDir = path.join(outputRoot, `${safeTimestamp()}-${shortSha}`);
if (fs.existsSync(handoffDir)) fail("HANDOFF_OUTPUT_ALREADY_EXISTS", { handoffDir });
fs.mkdirSync(handoffDir, { recursive: true });

const sourceMetadata = readJsonIfExists(path.join(releaseRepo, ".release", "source-files.v1.json"));
const publicAssets = readJsonIfExists(path.join(releaseRepo, "deploy", "manifests", "public-assets.v1.json"));
const topologyCopy = topology ? path.join(handoffDir, "production-topology.template.json") : null;
if (topology && topologyCopy) {
  fs.writeFileSync(topologyCopy, `${JSON.stringify(topology, null, 2)}\n`, "utf8");
}

const bundlePath = path.join(handoffDir, `zimeiti-caopanshou-source-vnext-${shortSha}.bundle`);
const archivePath = path.join(handoffDir, `zimeiti-caopanshou-source-vnext-${shortSha}.zip`);
const bundle = run(gitBin, ["bundle", "create", bundlePath, "HEAD", "--branches", "--tags"], { cwd: releaseRepo });
if (bundle.status !== 0) fail("GIT_BUNDLE_CREATE_FAILED", { stderr: bundle.stderr || bundle.error });
const archive = run(gitBin, ["archive", "--format=zip", "--output", archivePath, "HEAD"], { cwd: releaseRepo });
if (archive.status !== 0) fail("GIT_ARCHIVE_CREATE_FAILED", { stderr: archive.stderr || archive.error });

const bundleVerify = run(gitBin, ["bundle", "verify", bundlePath], { cwd: releaseRepo });
if (bundleVerify.status !== 0) {
  fail("GIT_BUNDLE_VERIFY_FAILED", { stderr: bundleVerify.stderr || bundleVerify.error });
}

const manifest = {
  schemaVersion: 1,
  projectId: policy.projectId,
  generatedAt,
  releaseRepo,
  branch,
  commitSha,
  shortSha,
  source: sourceMetadata ? {
    sourceFingerprint: sourceMetadata.sourceFingerprint,
    fileCount: sourceMetadata.fileCount,
    totalBytes: sourceMetadata.totalBytes,
    assetDigest: sourceMetadata.assetDigest,
    assetVersion: sourceMetadata.assetVersion,
    policySha256: sourceMetadata.policySha256,
  } : null,
  assets: publicAssets ? {
    manifestSha256: sourceMetadata?.assetManifestSha256 || null,
    externalAssetDigest: sourceMetadata?.assetDigest || null,
  } : null,
  files: {
    gitBundle: {
      path: path.basename(bundlePath),
      sha256: sha256File(bundlePath),
      bytes: fs.statSync(bundlePath).size,
      purpose: "可用 git clone <bundle> 或 git push 到新建远程仓库，保留 Git 历史。"
    },
    sourceZip: {
      path: path.basename(archivePath),
      sha256: sha256File(archivePath),
      bytes: fs.statSync(archivePath).size,
      purpose: "给不会使用 Git bundle 的平台或人工审查使用；不作为服务器最终部署制品。"
    },
    topology: topologyCopy ? {
      path: path.basename(topologyCopy),
      sha256: sha256File(topologyCopy),
      bytes: fs.statSync(topologyCopy).size,
      purpose: "不含密钥的生产拓扑选择与部署边界。"
    } : null,
  },
  recommendedNext: [
    "创建空的 Gitee 私有主仓和独立私有备份仓。",
    "运行 npm run deploy:remotes 检查仓库地址。",
    "运行 npm run deploy:remotes:apply 写入 origin/backup。",
    "运行 npm run deploy:close-loop:push 推送本 commit。",
    "配置 DEPLOY_DATABASE_URL、完成数据库备份，再进入 migration apply。",
  ],
  safety: [
    "本交接包不包含 .env、.npmrc、node_modules、.next、数据库、上传素材或运行日志。",
    "不要把数据库密码、Git token、SSH 私钥写入此目录。",
    "sourceZip 仅用于源码交接，不等同于可直接覆盖服务器的生产 artifact。"
  ],
};

const manifestPath = path.join(handoffDir, "handoff-manifest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  ok: true,
  handoffDir,
  commitSha,
  shortSha,
  bundle: manifest.files.gitBundle,
  sourceZip: manifest.files.sourceZip,
  topology: manifest.files.topology,
  manifest: {
    path: manifestPath,
    sha256: sha256File(manifestPath),
  },
}, null, 2));
