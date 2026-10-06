import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const targetFile = path.join(projectRoot, "backups", "latest.json");

function parseSnapshot(content, source) {
  try {
    const data = JSON.parse(content.replace(/^\uFEFF/, ""));
    return {
      content,
      source,
      backupTime: data.backup_time || "",
      agents: Array.isArray(data.config?.agents) ? data.config.agents.length : 0,
      conversations: Array.isArray(data.logs?.conversations) ? data.logs.conversations.length : 0,
      categories: Array.isArray(data.config?.categories) ? data.config.categories.length : 0,
    };
  } catch {
    return null;
  }
}

function isBetter(candidate, current) {
  if (!current) return true;
  if (candidate.agents !== current.agents) return candidate.agents > current.agents;
  if (candidate.conversations !== current.conversations) return candidate.conversations > current.conversations;
  return String(candidate.backupTime).localeCompare(String(current.backupTime)) > 0;
}

function readCurrentCandidate() {
  if (!fs.existsSync(targetFile)) return null;
  return parseSnapshot(fs.readFileSync(targetFile, "utf8"), targetFile);
}

function gitPaths(repoDir) {
  try {
    const output = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "-C", repoDir, "ls-tree", "-r", "-z", "--name-only", "HEAD"],
      { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 }
    );
    return output
      .toString("utf8")
      .split("\0")
      .filter((item) => item.endsWith("latest.json"))
      .filter((item) => item.includes("/数据备份/") || item.includes("/backups/"));
  } catch {
    return [];
  }
}

function readGitCandidate(repoDir, filePath) {
  try {
    const content = execFileSync("git", ["-C", repoDir, "show", `HEAD:${filePath}`], {
      encoding: "utf8",
      maxBuffer: 140 * 1024 * 1024,
    });
    return parseSnapshot(content, `${repoDir}:${filePath}`);
  } catch {
    return null;
  }
}

function findGitBackupCandidates() {
  const workspaceDir = path.dirname(projectRoot);
  const logDir = path.join(workspaceDir, "运行日志");
  if (!fs.existsSync(logDir)) return [];

  const repos = fs
    .readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("Git拉取副本-"))
    .map((entry) => path.join(logDir, entry.name))
    .filter((repoDir) => fs.existsSync(path.join(repoDir, ".git")));

  const candidates = [];
  for (const repoDir of repos) {
    for (const filePath of gitPaths(repoDir)) {
      const candidate = readGitCandidate(repoDir, filePath);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

const RUN_LOG_DIR = "\u8fd0\u884c\u65e5\u5fd7";
const GIT_PULL_PREFIX = "Git\u62c9\u53d6\u526f\u672c-";
const DATA_BACKUP_SEGMENT = "/\u6570\u636e\u5907\u4efd/";

function gitPathsUnicodeSafe(repoDir) {
  try {
    const output = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "-C", repoDir, "ls-tree", "-r", "-z", "--name-only", "HEAD"],
      { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 }
    );
    return output
      .toString("utf8")
      .split("\0")
      .filter((item) => item.endsWith("latest.json"))
      .filter((item) => item.includes(DATA_BACKUP_SEGMENT) || item.includes("/backups/"));
  } catch {
    return [];
  }
}

function findGitBackupCandidatesUnicodeSafe() {
  const workspaceDir = path.dirname(projectRoot);
  const logDir = path.join(workspaceDir, RUN_LOG_DIR);
  if (!fs.existsSync(logDir)) return [];

  const repos = fs
    .readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(GIT_PULL_PREFIX))
    .map((entry) => path.join(logDir, entry.name))
    .filter((repoDir) => fs.existsSync(path.join(repoDir, ".git")));

  const candidates = [];
  for (const repoDir of repos) {
    for (const filePath of gitPathsUnicodeSafe(repoDir)) {
      const candidate = readGitCandidate(repoDir, filePath);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

const current = readCurrentCandidate();
let best = current;
for (const candidate of [...findGitBackupCandidates(), ...findGitBackupCandidatesUnicodeSafe()]) {
  if (isBetter(candidate, best)) best = candidate;
}

if (!best) {
  console.log("[backup] No local backup snapshot found.");
  process.exit(0);
}

if (best !== current && isBetter(best, current)) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  if (current) {
    const backupFile = path.join(path.dirname(targetFile), "latest.before-auto-refresh.json");
    fs.writeFileSync(backupFile, current.content.replace(/^\uFEFF/, ""), "utf8");
  }
  fs.writeFileSync(targetFile, best.content.replace(/^\uFEFF/, ""), "utf8");
  console.log(`[backup] Refreshed local snapshot: ${best.backupTime}, agents=${best.agents}, conversations=${best.conversations}`);
} else {
  console.log(`[backup] Local snapshot ready: ${best.backupTime}, agents=${best.agents}, conversations=${best.conversations}`);
}
