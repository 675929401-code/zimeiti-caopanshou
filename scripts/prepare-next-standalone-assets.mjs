#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    options.set(argument, next);
    index += 1;
  } else {
    options.set(argument, "1");
  }
}

function stop(message, code = 1) {
  console.error(`[standalone-assets] FAIL ${message}`);
  process.exit(code);
}

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireDirectory(label, directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    stop(`${label} is missing or not a directory: ${directory}`, 2);
  }
}

function requireFile(label, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    stop(`${label} is missing or not a file: ${filePath}`, 2);
  }
}

function removeGeneratedDirectory(root, target, label) {
  const resolvedRoot = fs.realpathSync(root);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const resolvedParent = fs.realpathSync(parent);
  if (!isInsideOrEqual(resolvedRoot, resolvedParent)) {
    stop(`${label} parent escapes standalone root: ${target}`, 2);
  }
  if (fs.existsSync(target)) {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) {
      // Next/local rehearsal builds may leave a junction from standalone/.next/static
      // back to the project .next/static directory. Deployment artifacts must be
      // self-contained, so replace the link itself with a real directory. The
      // target path has already been proven to live under standaloneRoot; rmSync
      // removes the reparse point/link, not the linked build source.
      fs.rmSync(target, { recursive: true, force: true });
      return;
    }
    if (!stats.isDirectory()) stop(`${label} target must be a directory: ${target}`, 2);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function pathIsExcluded(relativePath, excludedRoots) {
  const normalized = normalize(relativePath);
  return excludedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function copyTree(source, destination, options_ = {}) {
  const sourceRoot = fs.realpathSync(source);
  const excludedRoots = options_.excludedRoots || [];
  const metrics = options_.metrics || { files: 0, directories: 0, bytes: 0 };

  function copyEntry(sourcePath, destinationPath) {
    const relativePath = normalize(path.relative(source, sourcePath));
    if (relativePath && pathIsExcluded(relativePath, excludedRoots)) return;

    const stats = fs.lstatSync(sourcePath);
    if (stats.isSymbolicLink()) {
      const realTarget = fs.realpathSync(sourcePath);
      if (!isInsideOrEqual(sourceRoot, realTarget)) {
        stop(`refusing to materialize symlink escaping source root: ${sourcePath} -> ${realTarget}`, 2);
      }
      const targetStats = fs.statSync(sourcePath);
      if (targetStats.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        metrics.directories += 1;
        for (const entry of fs.readdirSync(realTarget, { withFileTypes: true })) {
          copyEntry(path.join(realTarget, entry.name), path.join(destinationPath, entry.name));
        }
      } else if (targetStats.isFile()) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
        fs.chmodSync(destinationPath, targetStats.mode);
        metrics.files += 1;
        metrics.bytes += targetStats.size;
      } else {
        stop(`unsupported symlink target: ${sourcePath}`, 2);
      }
      return;
    }

    if (stats.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      metrics.directories += 1;
      for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
        copyEntry(path.join(sourcePath, entry.name), path.join(destinationPath, entry.name));
      }
      return;
    }

    if (stats.isFile()) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
      fs.chmodSync(destinationPath, stats.mode);
      metrics.files += 1;
      metrics.bytes += stats.size;
      return;
    }

    stop(`unsupported filesystem entry in standalone asset input: ${sourcePath}`, 2);
  }

  copyEntry(source, destination);
  return metrics;
}

function readPolicy(root) {
  const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
  if (!fs.existsSync(policyPath)) return null;
  return JSON.parse(fs.readFileSync(policyPath, "utf8"));
}

function publicExclusionsForWeb(policy) {
  const exclusions = new Set(["uploads"]);
  for (const relativePath of policy?.runtime?.mutablePaths || []) {
    const normalized = normalize(relativePath);
    if (normalized === "public" || normalized.startsWith("public/")) {
      const stripped = normalized === "public" ? "" : normalized.slice("public/".length);
      if (stripped) exclusions.add(stripped);
    }
  }
  for (const relativePath of policy?.assets?.forbiddenPublicRoots || []) {
    const normalized = normalize(relativePath);
    if (normalized === "public" || normalized.startsWith("public/")) {
      const stripped = normalized === "public" ? "" : normalized.slice("public/".length);
      if (stripped) exclusions.add(stripped);
    }
  }
  return [...exclusions].sort();
}

function publicExclusionsForVoice() {
  return ["reference-audio"];
}

function sha256File(filePath) {
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

function countFiles(directory) {
  let files = 0;
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files += 1;
    }
  }
  walk(directory);
  return files;
}

function pruneBrokenSymlinks(directory) {
  let removed = 0;

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          fs.realpathSync(target);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            stop(`could not inspect standalone symbolic link: ${target}: ${error instanceof Error ? error.message : String(error)}`, 2);
          }
          fs.unlinkSync(target);
          removed += 1;
        }
        continue;
      }
      if (entry.isDirectory()) walk(target);
    }
  }

  walk(directory);
  return removed;
}

function materializeWebFfmpeg(standaloneRoot) {
  let source;
  try {
    source = require("ffmpeg-static");
  } catch (error) {
    stop(`ffmpeg-static could not be resolved: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (typeof source !== "string") stop("ffmpeg-static did not expose a platform binary", 2);
  requireFile("ffmpeg-static binary", source);

  const runtimeToolsRoot = path.join(standaloneRoot, "runtime-tools");
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const target = path.join(runtimeToolsRoot, binaryName);
  fs.mkdirSync(runtimeToolsRoot, { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  requireFile("standalone ffmpeg runtime", target);

  return {
    path: normalize(path.relative(standaloneRoot, target)),
    bytes: fs.statSync(target).size,
    sha256: sha256File(target),
  };
}

function materializeWebFfprobe(standaloneRoot) {
  let source;
  try {
    const ffprobe = require("ffprobe-static");
    source = ffprobe?.path;
  } catch (error) {
    stop(`ffprobe-static could not be resolved: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (typeof source !== "string") stop("ffprobe-static did not expose a platform binary", 2);
  requireFile("ffprobe-static binary", source);

  const runtimeToolsRoot = path.join(standaloneRoot, "runtime-tools");
  const binaryName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const target = path.join(runtimeToolsRoot, binaryName);
  fs.mkdirSync(runtimeToolsRoot, { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  requireFile("standalone ffprobe runtime", target);

  return {
    path: normalize(path.relative(standaloneRoot, target)),
    bytes: fs.statSync(target).size,
    sha256: sha256File(target),
  };
}

function materializeDevelopmentBackupScript(root, standaloneRoot) {
  const source = path.join(root, "runtime-tools", "backup-data.sh");
  requireFile("development backup script", source);
  const target = path.join(standaloneRoot, "runtime-tools", "backup-data.sh");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  requireFile("standalone backup runtime", target);
  return {
    path: normalize(path.relative(standaloneRoot, target)),
    bytes: fs.statSync(target).size,
    sha256: sha256File(target),
  };
}

function main() {
  const root = path.resolve(options.get("--root") || process.cwd());
  const service = options.get("--service") || "web";
  if (!["web", "voice"].includes(service)) stop("--service must be web or voice", 2);

  const policy = readPolicy(root);
  const serviceRoot = service === "web" ? root : path.join(root, "voice-platform");
  const standaloneRelative = service === "web"
    ? policy?.services?.web?.standaloneDirectory || ".next/standalone"
    : policy?.services?.voice?.standaloneDirectory || "voice-platform/.next/standalone";
  const buildRelative = service === "web"
    ? policy?.services?.web?.buildDirectory || ".next"
    : policy?.services?.voice?.buildDirectory || "voice-platform/.next";

  const standaloneRoot = path.join(root, ...normalize(standaloneRelative).split("/"));
  const buildRoot = path.join(root, ...normalize(buildRelative).split("/"));
  const staticRoot = path.join(buildRoot, "static");
  const buildIdPath = path.join(buildRoot, "BUILD_ID");
  const serverEntrypoint = path.join(standaloneRoot, "server.js");
  const targetStatic = path.join(standaloneRoot, ".next", "static");
  const publicRoot = service === "web" ? path.join(root, "public") : path.join(root, "voice-platform", "public");
  const targetPublic = path.join(standaloneRoot, "public");

  requireDirectory("project root", root);
  requireDirectory("standalone root", standaloneRoot);
  requireDirectory("Next static root", staticRoot);
  requireFile("standalone server", serverEntrypoint);
  requireFile("BUILD_ID", buildIdPath);

  removeGeneratedDirectory(standaloneRoot, targetStatic, "standalone static");
  const staticMetrics = copyTree(staticRoot, targetStatic);
  if (staticMetrics.files <= 0) stop("no Next static files were copied into standalone output", 2);

  let publicMetrics = { files: 0, directories: 0, bytes: 0 };
  let publicExcludedRoots = [];
  if (fs.existsSync(publicRoot)) {
    publicExcludedRoots = service === "web" ? publicExclusionsForWeb(policy) : publicExclusionsForVoice();
    removeGeneratedDirectory(standaloneRoot, targetPublic, "standalone public");
    publicMetrics = copyTree(publicRoot, targetPublic, { excludedRoots: publicExcludedRoots });
  }

  const runtimeTools = service === "web"
    ? {
        ffmpeg: materializeWebFfmpeg(standaloneRoot),
        ffprobe: materializeWebFfprobe(standaloneRoot),
        backupScript: materializeDevelopmentBackupScript(root, standaloneRoot),
      }
    : {};
  // pnpm may leave hoisted links whose package targets were intentionally not
  // selected by Next's output-file trace. Such links are unusable at runtime
  // and make an otherwise self-contained artifact impossible to inventory.
  // Remove only links that are already broken inside the generated standalone
  // tree; valid dependency links remain untouched and are materialized later.
  const prunedBrokenSymlinks = pruneBrokenSymlinks(standaloneRoot);

  const buildId = fs.readFileSync(buildIdPath, "utf8").trim();
  const receipt = {
    schemaVersion: 1,
    kind: "next-standalone-assets-ready",
    service,
    buildId,
    preparedAt: new Date().toISOString(),
    source: {
      staticRoot: normalize(path.relative(root, staticRoot)),
      publicRoot: fs.existsSync(publicRoot) ? normalize(path.relative(root, publicRoot)) : null,
    },
    target: {
      standaloneRoot: normalize(path.relative(root, standaloneRoot)),
      staticRoot: normalize(path.relative(root, targetStatic)),
      publicRoot: fs.existsSync(publicRoot) ? normalize(path.relative(root, targetPublic)) : null,
    },
    exclusions: {
      publicRoots: publicExcludedRoots,
    },
    counts: {
      staticFiles: countFiles(targetStatic),
      publicFiles: fs.existsSync(targetPublic) ? countFiles(targetPublic) : 0,
      runtimeToolFiles: Object.keys(runtimeTools).length,
      prunedBrokenSymlinks,
    },
    runtimeTools,
    sample: {
      buildIdSha256: sha256File(buildIdPath),
    },
  };

  const receiptPath = path.join(standaloneRoot, ".release", "standalone-assets.ready.v1.json");
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  console.log(`[standalone-assets] PASS service=${service} build=${buildId} staticFiles=${receipt.counts.staticFiles} publicFiles=${receipt.counts.publicFiles}`);
  console.log(`[standalone-assets] RECEIPT ${receiptPath}`);
}

main();
