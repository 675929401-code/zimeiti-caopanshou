import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ensureSourceVersion } from "./local-revision.mjs";
import { recordOperation } from "./project-operations.mjs";
import {
  computeLocalBuildFingerprint,
  writeLocalBuildFingerprintReceipt,
} from "./local-build-fingerprint.mjs";
import { assertNoActiveLocalLlmRequests } from "./local-build-active-llm-guard.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: options.shell || false,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      PUPPETEER_SKIP_DOWNLOAD: "1",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      ...options.env,
    },
  });

  if (result.error) {
    console.error(`[run-build] ${command} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`[run-build] terminated by ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function removeStandaloneSecrets(root) {
  const standaloneRoot = path.join(root, ".next", "standalone");
  if (!fs.existsSync(standaloneRoot)) return;
  const forbidden = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.relative(standaloneRoot, entryPath).replace(/\\/gu, "/");
      const forbiddenName = entry.name === ".env"
        || entry.name.startsWith(".env.")
        || entry.name === ".npmrc"
        || entry.name === ".secure";
      if (forbiddenName) {
        forbidden.push(relativePath);
        fs.rmSync(entryPath, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  }
  walk(standaloneRoot);
  if (forbidden.length > 0) {
    console.log(`[run-build] Removed ${forbidden.length} runtime secret file/director${forbidden.length === 1 ? "y" : "ies"} from standalone output.`);
  }
}

function removeStandaloneNonArtifactRoots(root) {
  const standaloneRoot = path.join(root, ".next", "standalone");
  if (!fs.existsSync(standaloneRoot)) return;
  const nonArtifactRoots = [
    ".codex-backups",
    ".codex-evidence",
    ".codex-temp",
    ".next-validation",
    ".next-local-acceptance",
    ".next-local-acceptance-next",
    ".tmp-e2e",
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
    // Mutable runtime state is provisioned outside the release artifact. Next
    // tracing may copy the local directory, including private key containers,
    // so remove the complete root before the sensitive-path verification.
    "runtime",
    "scripts",
    "src",
    "supabase",
    "tests",
    "voice-platform",
    "任务快照",
    "备份快照",
  ];
  const removed = [];
  for (const relativePath of nonArtifactRoots) {
    const target = path.join(standaloneRoot, relativePath);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(relativePath);
  }
  if (removed.length > 0) {
    console.log(`[run-build] Removed ${removed.length} non-artifact checkout root${removed.length === 1 ? "" : "s"} from standalone output.`);
  }
}

function acquireBuildLock(buildLock) {
  try {
    return fs.openSync(buildLock, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;

    let lockPid = null;
    try {
      const lock = JSON.parse(fs.readFileSync(buildLock, "utf8"));
      const parsedPid = Number(lock?.pid);
      lockPid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
    } catch {}

    if (lockPid !== null) {
      try {
        process.kill(lockPid, 0);
        throw new Error(`[run-build] Build lock is owned by active PID ${lockPid}: ${buildLock}`);
      } catch (probeError) {
        if (probeError?.code !== "ESRCH") throw probeError;
      }
    }

    fs.rmSync(buildLock, { force: true });
    console.warn(`[run-build] Removed stale build lock: ${buildLock}`);
    return fs.openSync(buildLock, "wx");
  }
}

function stopOwnedLocalPreview(root, port = 5000) {
  const expectedServerEntry = path.join(root, ".next", "standalone", "server.js");
  const windowsRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$port=[int]$env:LOCAL_BUILD_PREVIEW_PORT",
    "$expected=([string]$env:LOCAL_BUILD_SERVER_ENTRY).Replace('/','\\')",
    "$owners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)",
    "if($owners.Count -eq 0){Write-Output '{\"status\":\"offline\"}';exit 0}",
    "if($owners.Count -ne 1){Write-Error 'LOCAL_BUILD_PREVIEW_OWNER_AMBIGUOUS';exit 3}",
    "$process=Get-CimInstance Win32_Process -Filter (\"ProcessId=\"+$owners[0])",
    "$command=([string]$process.CommandLine).Replace('/','\\')",
    "if($process.Name -ne 'node.exe' -or $command.IndexOf($expected,[StringComparison]::OrdinalIgnoreCase) -lt 0){Write-Error 'LOCAL_BUILD_PREVIEW_OWNER_MISMATCH';exit 4}",
    "Stop-Process -Id $owners[0] -Force",
    "Wait-Process -Id $owners[0] -Timeout 15 -ErrorAction SilentlyContinue",
    "Write-Output ('{\"status\":\"stopped\",\"pid\":'+$owners[0]+'}')",
  ].join(";");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      LOCAL_BUILD_PREVIEW_PORT: String(port),
      LOCAL_BUILD_SERVER_ENTRY: expectedServerEntry,
    },
  });
  if (result.error) throw new Error(`[run-build] Local preview ownership check could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`[run-build] Refusing to stop an unverified process on port ${port}: ${(result.stderr || result.stdout || "unknown").trim()}`);
  }
  const summary = String(result.stdout || "").trim();
  console.log(`[run-build] Local preview drain result: ${summary || '{"status":"unknown"}'}`);
}

if (process.platform === "win32") {
  const root = process.cwd();
  const buildLock = path.join(root, ".codex-build.lock");
  const buildLockFd = acquireBuildLock(buildLock);
  fs.writeFileSync(buildLockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let buildCompleted = false;
  let buildingVersion = "";
  let completedBuildId = "";
  process.on("exit", (code) => {
    try {
      recordOperation(root, {
        stage: "local-build", status: buildCompleted && code === 0 ? "passed" : "failed",
        sourceVersion: buildingVersion, buildId: completedBuildId,
        summary: buildCompleted && code === 0 ? "本地构建及产物检查通过；尚需实际网页验收" : "本地构建未完成；不得复用本轮验收标记",
        nextAction: buildCompleted && code === 0 ? "启动并核对本地版本，验证改动页面和至少两个关联页面" : "检查本次构建输出，修复后重建；不要推送",
      });
    } finally { fs.closeSync(buildLockFd); fs.unlinkSync(buildLock); }
  });
  await assertNoActiveLocalLlmRequests();
  stopOwnedLocalPreview(root);
  const revision = ensureSourceVersion(root);
  buildingVersion = revision.sourceVersion;
  recordOperation(root, { stage: "local-build", status: "running", sourceVersion: buildingVersion, buildId: "", summary: "已更新源码版本，开始本地构建", nextAction: "等待本轮构建终态，不同时启动第二个构建" });
  console.log(`[run-build] Source version: ${revision.sourceVersion}`);
  run(process.execPath, ["./scripts/release-workflow.mjs", "refresh-metadata"]);
  console.log("[run-build] Verifying embedded runtime resources match their reviewed source contracts.");
  run(process.execPath, ["./scripts/verify-embedded-runtime-resources.mjs"]);
  const sourceBefore = computeLocalBuildFingerprint(root);
  // Next 16.2 Turbopack can attach a route's dynamic temporary-file trace to
  // the shared instrumentation chunk and copy the entire checkout into the
  // standalone artifact. Webpack's NFT path respects outputFileTracingExcludes
  // and is the audited production builder for this filesystem-heavy service.
  console.log("[run-build] Windows detected: using audited Next.js Webpack production build.");
  run(process.execPath, ["--require", "./scripts/next-windows-trace-globs.cjs", "./node_modules/next/dist/bin/next", "build", "--webpack"]);
  console.log("[run-build] Preparing Next.js standalone static/public assets.");
  run(process.execPath, ["./scripts/prepare-next-standalone-assets.mjs", "--service", "web"]);
  removeStandaloneSecrets(root);
  removeStandaloneNonArtifactRoots(root);
  console.log("[run-build] Verifying standalone output contains no forbidden secret paths.");
  run(process.execPath, ["./scripts/package-standalone-artifact.mjs", "--verify-sensitive-root", path.join(root, ".next", "standalone")]);
  console.log("[run-build] Verifying standalone output contains only production runtime roots.");
  run(process.execPath, ["./scripts/verify-standalone-trace-boundary.mjs", "--artifact"]);
  const receipt = writeLocalBuildFingerprintReceipt(root, ".next/local-source-fingerprint.v1.json", sourceBefore.fingerprint);
  completedBuildId = receipt.buildId;
  buildCompleted = true;
  console.log(`[run-build] Local source fingerprint captured for BUILD_ID=${receipt.buildId}.`);
} else {
  console.log("[run-build] POSIX detected: using deployment build.sh.");
  run("bash", ["./scripts/build.sh"]);
}
