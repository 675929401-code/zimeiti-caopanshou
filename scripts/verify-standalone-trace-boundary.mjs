#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const config = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
const ffmpegResolver = fs.readFileSync(path.join(root, "src", "lib", "video-postprocess.ts"), "utf8");
const extractVideoCache = fs.readFileSync(path.join(root, "src", "lib", "extract-local-video-cache.ts"), "utf8");
const videoThumbnailRoute = fs.readFileSync(path.join(root, "src", "app", "api", "video", "thumbnail", "[taskId]", "route.ts"), "utf8");
const digitalHumanMedia = fs.readFileSync(path.join(root, "src", "lib", "digital-human-media.ts"), "utf8");
const longDigitalHumanMedia = fs.readFileSync(path.join(root, "src", "lib", "digital-human-long-media.ts"), "utf8");
const manjuRegistry = fs.readFileSync(path.join(root, "src", "lib", "server", "manju-public-asset-registry.ts"), "utf8");
const standaloneAssets = fs.readFileSync(path.join(root, "scripts", "prepare-next-standalone-assets.mjs"), "utf8");
const buildRunner = fs.readFileSync(path.join(root, "scripts", "run-build.mjs"), "utf8");
const releaseBuildRunner = fs.readFileSync(path.join(root, "scripts", "build-release-vnext.mjs"), "utf8");
const traceExcludedCheckoutRoots = [
  ".codex-backups",
  ".codex-evidence",
  ".tmp-e2e",
  ".codex-temp",
  ".next-validation",
  ".next-local-acceptance",
  ".next-local-acceptance-next",
  "--output=.codex-evidence",
  "%SystemDrive%",
  "artifacts",
  "assets",
  "backups",
  "data",
  "deploy",
  "docs",
  "evidence-archive",
  "prompts",
  "research",
  "research-output",
  "runtime",
  "scripts",
  "src",
  "supabase",
  "tests",
  "voice-platform",
  "任务快照",
  "备份快照",
];
const allowedPackagedScriptFiles = [
  "scripts/backup-postgres-consistent.mjs",
  "scripts/backup-recovery-helper.mjs",
  "scripts/contracts/backup-receipt.v1.schema.json",
  "scripts/contracts/restore-receipt.v1.schema.json",
];
const forbiddenRuntimeRoots = traceExcludedCheckoutRoots.filter(relativePath => relativePath !== "scripts");
const mutableStandaloneRoots = ["runtime"];

assert.match(config, /outputFileTracingExcludes\s*:\s*\{/u, "Next standalone trace exclusions are required");
assert.match(buildRunner, /"build", "--webpack"/u, "production builds must use the audited Webpack NFT implementation");
assert.match(ffmpegResolver, /process\.env\.NODE_ENV === "production"\) \{\s*return PACKAGED_FFMPEG_EXECUTABLE;/u, "production FFmpeg path must be deterministic");
assert.match(ffmpegResolver, /PACKAGED_FFMPEG_EXECUTABLE[\s\S]*?"runtime-tools\\\\ffmpeg\.exe"[\s\S]*?"runtime-tools\/ffmpeg"/u, "packaged FFmpeg paths must be platform literals");
assert.match(ffmpegResolver, /DEVELOPMENT_FFMPEG_EXECUTABLE[\s\S]*?"node_modules\\\\ffmpeg-static\\\\ffmpeg\.exe"[\s\S]*?"node_modules\/ffmpeg-static\/ffmpeg"/u, "development FFmpeg paths must be platform literals");
assert.doesNotMatch(ffmpegResolver, /from "ffmpeg-static"|require\(["']ffmpeg-static["']\)/u, "ffmpeg-static dynamic package entrypoint must not enter the Next runtime graph");
assert.doesNotMatch(ffmpegResolver, /path\.join\([^\n]*process\.cwd\(\)[^\n]*runtime-tools/u, "Turbopack must not receive a dynamic production runtime root");
assert.ok((ffmpegResolver.match(/turbopackIgnore: true/gu) || []).length >= 12, "all runtime temp filesystem paths must be excluded from build tracing");
assert.doesNotMatch(ffmpegResolver, /readdirSync|statSync|resolvePnpmFfmpeg/u, "FFmpeg resolver must not dynamically scan the checkout");
assert.match(extractVideoCache, /resolveAppRuntimeDir\(\)[\s\S]*?["']extract-videos["']/u, "temporary extraction videos must use the external runtime directory");
assert.doesNotMatch(extractVideoCache, /tmpdir\(\)[\s\S]*?["']extract-videos["']/u, "build tracing must not capture the machine temporary directory");
assert.match(videoThumbnailRoute, /resolveAppRuntimeDir\(\)[\s\S]*?["']video-thumbnails["']/u, "video thumbnails must use the external runtime directory");
assert.doesNotMatch(videoThumbnailRoute, /tmpdir\(\)[\s\S]*?["']video-thumbnails["']/u, "build tracing must not capture the thumbnail temporary directory");
assert.match(digitalHumanMedia, /resolveAppRuntimeDir\(\)/u, "digital-human upload probes must use the external runtime directory contract");
assert.doesNotMatch(digitalHumanMedia, /process\.cwd\(\)[\s\S]{0,120}data/u, "digital-human upload probes must not trace checkout data");
assert.match(longDigitalHumanMedia, /resolveAppRuntimeDir\(\)/u, "long digital-human media must use the external runtime directory contract");
assert.doesNotMatch(longDigitalHumanMedia, /process\.cwd\(\)[\s\S]{0,120}data/u, "long digital-human media must not trace checkout data");
assert.match(manjuRegistry, /resolveAppDataFile\(DEFAULT_REGISTRY_NAME\)/u, "Manju assets must use the external data directory contract");
assert.doesNotMatch(manjuRegistry, /process\.cwd\(\)[\s\S]{0,120}data/u, "Manju assets must not trace checkout data");
assert.match(standaloneAssets, /materializeWebFfprobe/u, "standalone build must materialize ffprobe for upload metadata checks");
assert.match(standaloneAssets, /materializeBackupControlPlane/u, "standalone build must materialize the complete backup control plane");
for (const requiredBackupRuntime of [
  "runtime-tools/backup-data.sh",
  "scripts/backup-recovery-helper.mjs",
  "scripts/backup-postgres-consistent.mjs",
  "scripts/contracts/backup-receipt.v1.schema.json",
  "scripts/contracts/restore-receipt.v1.schema.json",
]) {
  assert.ok(standaloneAssets.includes(`relative: "${requiredBackupRuntime}"`), `standalone backup bundle is missing ${requiredBackupRuntime}`);
}
const nonArtifactRootsMatch = buildRunner.match(/const nonArtifactRoots = \[([\s\S]*?)\n  \];/u);
assert.ok(nonArtifactRootsMatch, "build runner must declare its standalone non-artifact roots");
for (const relativePath of mutableStandaloneRoots) {
  assert.ok(
    nonArtifactRootsMatch[1].includes(`"${relativePath}"`),
    `standalone cleanup must remove mutable ${relativePath} state`,
  );
}
const cleanupCallIndex = buildRunner.indexOf("removeStandaloneNonArtifactRoots(root);");
const sensitiveCheckIndex = buildRunner.indexOf("package-standalone-artifact.mjs");
assert.ok(cleanupCallIndex >= 0, "build runner must invoke standalone non-artifact cleanup");
assert.ok(sensitiveCheckIndex >= 0, "build runner must invoke standalone sensitive-path verification");
assert.ok(
  cleanupCallIndex < sensitiveCheckIndex,
  "standalone mutable roots must be removed before sensitive-path verification",
);
const releaseCleanupIndex = releaseBuildRunner.indexOf('for (const relativePath of ["runtime"])');
const releaseProvenanceIndex = releaseBuildRunner.indexOf("const provenance = {");
assert.ok(releaseCleanupIndex >= 0, "release build must remove mutable runtime state from standalone output");
assert.ok(
  releaseProvenanceIndex > releaseCleanupIndex,
  "release build must remove mutable runtime state before issuing provenance",
);
for (const relativePath of traceExcludedCheckoutRoots) {
  assert.ok(
    config.includes(`'./${relativePath}/**/*'`),
    `Next trace boundary must exclude ${relativePath}`,
  );
}

if (process.argv.includes("--artifact")) {
  const standaloneRoot = path.join(root, ".next", "standalone");
  assert.ok(fs.statSync(standaloneRoot).isDirectory(), "standalone output is missing");
  const leakedRoots = [...new Set([...forbiddenRuntimeRoots, ...mutableStandaloneRoots])]
    .filter((relativePath) => fs.existsSync(path.join(standaloneRoot, relativePath)));
  assert.deepEqual(leakedRoots, [], `standalone output contains non-runtime checkout roots: ${leakedRoots.join(", ")}`);
  const packagedScriptsRoot = path.join(standaloneRoot, "scripts");
  const packagedScripts = [];
  if (fs.existsSync(packagedScriptsRoot)) {
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile()) packagedScripts.push(path.relative(standaloneRoot, target).split(path.sep).join("/"));
        else assert.fail(`standalone scripts contains non-regular entry: ${target}`);
      }
    };
    walk(packagedScriptsRoot);
  }
  assert.deepEqual(packagedScripts.sort(), [...allowedPackagedScriptFiles].sort(), "standalone scripts must contain only the backup control-plane allowlist");
}

console.log(JSON.stringify({
  status: "PASS",
  excludedCheckoutRoots: traceExcludedCheckoutRoots.length,
  allowedPackagedScripts: allowedPackagedScriptFiles.length,
  purgedMutableRoots: mutableStandaloneRoots.length,
  artifactVerified: process.argv.includes("--artifact"),
}, null, 2));
