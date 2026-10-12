import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const WORKER_NAME = "agent-hub-media-worker";
const WORKER_PORTS = [5102, 5103];
const STATE_SCHEMA = "zimeiti-media-worker-transaction.v1";

function fail(message) {
  throw new Error(message);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function valueOf(entry, key) {
  return entry?.pm2_env?.[key]
    ?? entry?.pm2_env?.env?.[key]
    ?? entry?.env?.[key]
    ?? entry?.[key];
}

function statusOf(entry) {
  return entry?.pm2_env?.status ?? entry?.status ?? "";
}

function assertSafeAbsoluteDirectory(directory, expectedPrefix) {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${expectedPrefix}${path.sep}`)) fail("TRANSACTION_ROOT_OUTSIDE_CONTROL_PLANE");
  const relative = path.relative(expectedPrefix, resolved);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$/u.test(relative) || relative.includes(path.sep)) {
    fail("TRANSACTION_ROOT_IDENTITY_INVALID");
  }
  return resolved;
}

function assertTrustedFile(filePath, expectedSha256, label) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256 || "")) fail(`${label}_SHA256_INVALID`);
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.uid !== 0 || stats.gid !== 0 || (stats.mode & 0o077) !== 0) {
    fail(`${label}_METADATA_UNSAFE`);
  }
  if (sha256File(filePath) !== expectedSha256) fail(`${label}_CHANGED`);
  return path.resolve(filePath);
}

function assertRootControlledParentChain(target, stopAt) {
  const stop = path.resolve(stopAt);
  let current = path.resolve(target);
  for (;;) {
    const stats = fs.lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink() || fs.realpathSync(current) !== current
      || stats.uid !== 0 || stats.gid !== 0 || (stats.mode & 0o022) !== 0) {
      fail("TRANSACTION_PARENT_UNSAFE");
    }
    if (current === stop) return;
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${stop}${path.sep}`)) fail("TRANSACTION_PARENT_ESCAPED");
    current = parent;
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label}_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 90_000,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  if (result.error || result.status !== 0) {
    fail(`${options.label || command}_FAILED:${result.error?.message || String(result.status)}`);
  }
  return result.stdout;
}

function pm2Entries() {
  return JSON.parse(run("pm2", ["jlist"], { label: "PM2_JLIST" }));
}

function workerIdentity(entry) {
  const cwd = fs.realpathSync(entry.pm2_env?.pm_cwd);
  const executable = fs.realpathSync(entry.pm2_env?.pm_exec_path);
  const port = Number(valueOf(entry, "PORT"));
  const identity = {
    name: entry.name,
    cwd,
    executable,
    port,
    releaseId: String(valueOf(entry, "RELEASE_ID") || ""),
    commitSha: String(valueOf(entry, "DEPLOY_COMMIT_SHA") || ""),
    buildId: String(valueOf(entry, "EXPECTED_BUILD_ID") || ""),
    sourceVersion: String(valueOf(entry, "RELEASE_SOURCE_VERSION") || ""),
    buildOutputDigest: String(valueOf(entry, "RELEASE_BUILD_OUTPUT_DIGEST") || ""),
    assetDigest: String(valueOf(entry, "ASSET_DIGEST") || ""),
    assetManifestSha256: String(valueOf(entry, "ASSET_MANIFEST_SHA256") || ""),
    execMode: String(entry.pm2_env?.exec_mode || ""),
    processFlags: {
      media: String(valueOf(entry, "MEDIA_QUEUE_WORKER_PROCESS") || ""),
      video: String(valueOf(entry, "DIGITAL_VIDEO_QUEUE_WORKER") || ""),
      human: String(valueOf(entry, "DIGITAL_HUMAN_LONG_WORKER") || ""),
    },
  };
  if (identity.name !== WORKER_NAME || statusOf(entry) !== "online" || !Number.isInteger(entry.pid) || entry.pid <= 0) {
    fail("MEDIA_WORKER_NOT_ONLINE");
  }
  if (!WORKER_PORTS.includes(port) || identity.execMode !== "fork_mode" || identity.executable !== path.join(cwd, "server.js")) {
    fail("MEDIA_WORKER_TOPOLOGY_INVALID");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(identity.releaseId)
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(identity.commitSha)
    || !/^[A-Za-z0-9._-]{1,256}$/u.test(identity.buildId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(identity.sourceVersion)
    || !/^[a-f0-9]{64}$/u.test(identity.buildOutputDigest)
    || !/^[a-f0-9]{64}$/u.test(identity.assetDigest)
    || !/^[a-f0-9]{64}$/u.test(identity.assetManifestSha256)) {
    fail("MEDIA_WORKER_RELEASE_IDENTITY_INVALID");
  }
  if (Object.values(identity.processFlags).some((value) => value !== "1")) fail("MEDIA_WORKER_ROLE_FLAGS_INVALID");
  return identity;
}

export function snapshotWorkers(entries) {
  const workers = entries.filter((entry) => entry?.name === WORKER_NAME);
  if (workers.length !== 2) fail(`MEDIA_WORKER_COUNT_INVALID:${workers.length}`);
  const identities = workers.map(workerIdentity).sort((left, right) => left.port - right.port);
  if (identities[0].port !== WORKER_PORTS[0] || identities[1].port !== WORKER_PORTS[1]) fail("MEDIA_WORKER_PORT_SET_INVALID");
  const commonKeys = ["cwd", "releaseId", "commitSha", "buildId", "sourceVersion", "buildOutputDigest", "assetDigest", "assetManifestSha256"];
  for (const key of commonKeys) {
    if (identities.some((identity) => identity[key] !== identities[0][key])) fail(`MEDIA_WORKER_IDENTITY_SPLIT:${key}`);
  }
  return { ...identities[0], ports: WORKER_PORTS };
}

function listenerPids(port) {
  const output = run("ss", ["-H", "-ltnp", `sport = :${port}`], { label: "SS_LISTENER" });
  return [...output.matchAll(/pid=([0-9]+),/gu)].map((match) => Number(match[1]));
}

export function workersMatch(entries, expected) {
  try {
    const actual = snapshotWorkers(entries);
    const keys = ["cwd", "releaseId", "commitSha", "buildId", "sourceVersion", "buildOutputDigest", "assetDigest", "assetManifestSha256"];
    return keys.every((key) => actual[key] === expected[key])
      && actual.ports.length === expected.ports.length
      && actual.ports.every((port, index) => port === expected.ports[index]);
  } catch {
    return false;
  }
}

export function dumpWorkersMatch(entries, expected) {
  try {
    const workers = entries.filter((entry) => entry?.name === WORKER_NAME);
    if (workers.length !== 2) return false;
    const normalized = workers.map((entry) => ({
      status: statusOf(entry),
      cwd: fs.realpathSync(entry.pm_cwd ?? entry.pm2_env?.pm_cwd),
      executable: fs.realpathSync(entry.pm_exec_path ?? entry.pm2_env?.pm_exec_path),
      execMode: String(entry.exec_mode ?? entry.pm2_env?.exec_mode ?? ""),
      port: Number(valueOf(entry, "PORT")),
      releaseId: String(valueOf(entry, "RELEASE_ID") || ""),
      commitSha: String(valueOf(entry, "DEPLOY_COMMIT_SHA") || ""),
      buildId: String(valueOf(entry, "EXPECTED_BUILD_ID") || ""),
      sourceVersion: String(valueOf(entry, "RELEASE_SOURCE_VERSION") || ""),
      buildOutputDigest: String(valueOf(entry, "RELEASE_BUILD_OUTPUT_DIGEST") || ""),
      assetDigest: String(valueOf(entry, "ASSET_DIGEST") || ""),
      assetManifestSha256: String(valueOf(entry, "ASSET_MANIFEST_SHA256") || ""),
      processFlags: ["MEDIA_QUEUE_WORKER_PROCESS", "DIGITAL_VIDEO_QUEUE_WORKER", "DIGITAL_HUMAN_LONG_WORKER"]
        .map((key) => String(valueOf(entry, key) || "")),
    })).sort((left, right) => left.port - right.port);
    return normalized.every((entry, index) => entry.status === "online" && entry.port === WORKER_PORTS[index]
      && entry.executable === path.join(entry.cwd, "server.js") && entry.execMode === "fork_mode"
      && entry.processFlags.every((value) => value === "1")
      && ["cwd", "releaseId", "commitSha", "buildId", "sourceVersion", "buildOutputDigest", "assetDigest", "assetManifestSha256"]
        .every((key) => entry[key] === expected[key]));
  } catch {
    return false;
  }
}

function environmentFor(root, identity) {
  const shared = path.join(root, "shared");
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return {
    ...env,
    NODE_ENV: "production",
    COZE_PROJECT_ENV: "PROD",
    RELEASE_ROOT: root,
    WEB_RELEASE_DIR: identity.cwd,
    APP_DATA_DIR: path.join(shared, "data"),
    APP_RUNTIME_DIR: path.join(shared, "runtime"),
    COMMERCE_DATA_DIR: path.join(shared, "runtime", "commerce-agent"),
    COMMERCE_DISCOVERY_CATALOG: path.join(shared, "runtime", "commerce-discovery", "catalog.json"),
    COMMERCE_GATEWAY_KEY_FILE: path.join(shared, "runtime", "commerce-agent", "main-gateway.key"),
    IDEMPOTENCY_DIR: path.join(shared, "runtime", "llm-request-idempotency"),
    BACKUP_DIR: path.join(shared, "backups"),
    PUBLIC_ASSET_ROOT: path.join(shared, "assets", "current", "public"),
    STORAGE_LOCAL_BASE_PATH: path.join(shared, "uploads"),
    VOICE_SQLITE_PATH: path.join(shared, "voice", "voice.db"),
    VOICE_REFERENCE_AUDIO_DIR: path.join(shared, "voice", "reference-audio"),
    RELEASE_ID: identity.releaseId,
    DEPLOY_COMMIT_SHA: identity.commitSha,
    EXPECTED_BUILD_ID: identity.buildId,
    RELEASE_SOURCE_VERSION: identity.sourceVersion,
    RELEASE_BUILD_OUTPUT_DIGEST: identity.buildOutputDigest,
    ASSET_DIGEST: identity.assetDigest,
    ASSET_MANIFEST_SHA256: identity.assetManifestSha256,
    MEDIA_QUEUE_WORKER_INSTANCES: "2",
    MEDIA_QUEUE_WORKER_PORT: String(WORKER_PORTS[0]),
  };
}

async function waitForWorkers(expected, requireHttp = true) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const entries = pm2Entries();
    if (workersMatch(entries, expected)) {
      const actualWorkers = entries.filter((entry) => entry?.name === WORKER_NAME);
      const listenersMatch = actualWorkers.every((entry) => listenerPids(Number(valueOf(entry, "PORT"))).includes(entry.pid));
      if (listenersMatch) {
        if (!requireHttp) return;
        const versions = await Promise.all(WORKER_PORTS.map(async (port) => {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(3_000) });
            const value = await response.json();
            return response.ok && value.releaseId === expected.releaseId && value.deployCommitSha === expected.commitSha
              && value.buildId === expected.buildId && value.sourceVersion === expected.sourceVersion;
          } catch { return false; }
        }));
        if (versions.every(Boolean)) return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail("MEDIA_WORKER_READINESS_TIMEOUT");
}

async function waitForPortsFree() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (WORKER_PORTS.every((port) => listenerPids(port).length === 0)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("MEDIA_WORKER_PORT_DRAIN_TIMEOUT");
}

function identityFromCurrent(root) {
  const current = fs.realpathSync(path.join(root, "current-web"));
  const manifest = readJson(path.join(current, "release-manifest.json"), "CURRENT_RELEASE_MANIFEST");
  const required = {
    cwd: current,
    releaseId: manifest.releaseId,
    commitSha: manifest.commitSha,
    buildId: manifest.buildId,
    sourceVersion: manifest.sourceVersion,
    buildOutputDigest: manifest.buildOutputDigest,
    assetDigest: manifest.assetDigest,
    assetManifestSha256: manifest.assetManifestSha256,
    ports: WORKER_PORTS,
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(required.releaseId || "")
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(required.commitSha || "")
    || !/^[A-Za-z0-9._-]{1,256}$/u.test(required.buildId || "")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(required.sourceVersion || "")
    || !/^[a-f0-9]{64}$/u.test(required.buildOutputDigest || "")
    || !/^[a-f0-9]{64}$/u.test(required.assetDigest || "")
    || !/^[a-f0-9]{64}$/u.test(required.assetManifestSha256 || "")) {
    fail("CURRENT_RELEASE_IDENTITY_INVALID");
  }
  return required;
}

function stopWorkers() {
  const matches = pm2Entries().filter((entry) => entry?.name === WORKER_NAME);
  if (matches.length) run("pm2", ["stop", WORKER_NAME], { label: "PM2_STOP_WORKERS" });
}

function deleteWorkers() {
  const matches = pm2Entries().filter((entry) => entry?.name === WORKER_NAME);
  if (matches.length) run("pm2", ["delete", WORKER_NAME], { label: "PM2_DELETE_WORKERS" });
}

async function startWorkers(configPath, root, identity) {
  if (pm2Entries().some((entry) => entry?.name === WORKER_NAME)) fail("MEDIA_WORKER_SLOT_STILL_EXISTS");
  run("pm2", ["start", configPath, "--only", WORKER_NAME, "--env", "production", "--update-env"], {
    label: "PM2_START_WORKERS",
    env: environmentFor(root, identity),
  });
  await waitForWorkers(identity, true);
}

function readState(statePath) {
  const state = readJson(statePath, "TRANSACTION_STATE");
  if (state.schemaVersion !== STATE_SCHEMA || state.workerName !== WORKER_NAME || !state.previous) fail("TRANSACTION_STATE_SCHEMA_INVALID");
  return state;
}

async function main() {
  const [phase, transactionRootArg] = process.argv.slice(2);
  if (!new Set(["prepare", "activated", "precommit", "persisted", "rollback-before", "rollback-after", "rollback-persisted"]).has(phase)) {
    fail("TRANSACTION_PHASE_INVALID");
  }
  if (process.platform !== "linux" || process.geteuid?.() !== 0) fail("LINUX_ROOT_REQUIRED");
  if (process.env.DIRECT_HOOK_SERVICE !== "web") fail("WEB_TRANSACTION_REQUIRED");
  const root = path.resolve(process.env.DIRECT_HOOK_RELEASE_ROOT || "");
  if (root !== "/data/web") fail("RELEASE_ROOT_INVALID");
  const controlRoot = "/data/direct-deploy/transactions";
  const transactionRoot = assertSafeAbsoluteDirectory(transactionRootArg, controlRoot);
  assertRootControlledParentChain(controlRoot, "/data/direct-deploy");
  const configPath = assertTrustedFile(
    path.resolve(process.env.DIRECT_HOOK_PM2_CONFIG_PATH || ""),
    process.env.DIRECT_HOOK_PM2_CONFIG_SHA256,
    "PM2_CONFIG",
  );
  const statePath = path.join(transactionRoot, "media-worker-state.json");

  if (phase === "prepare") {
    if (fs.existsSync(transactionRoot)) fail("TRANSACTION_ROOT_ALREADY_EXISTS");
    const previous = snapshotWorkers(pm2Entries());
    await waitForWorkers(previous, true);
    const expectedCurrent = fs.realpathSync(path.join(root, "current-web"));
    if (previous.cwd !== expectedCurrent) fail("MEDIA_WORKER_CURRENT_POINTER_MISMATCH");
    fs.mkdirSync(transactionRoot, { mode: 0o700 });
    fs.chownSync(transactionRoot, 0, 0);
    assertRootControlledParentChain(transactionRoot, controlRoot);
    const state = {
      schemaVersion: STATE_SCHEMA,
      workerName: WORKER_NAME,
      preparedAt: new Date().toISOString(),
      configPath,
      configSha256: sha256File(configPath),
      previous,
      status: "snapshot-written",
    };
    atomicWriteJson(statePath, state);
    stopWorkers();
    await waitForPortsFree();
    deleteWorkers();
    state.status = "prepared";
    atomicWriteJson(statePath, state);
    process.stdout.write(`${JSON.stringify({ ok: true, phase, releaseId: previous.releaseId, ports: WORKER_PORTS })}\n`);
    return;
  }

  if (!fs.existsSync(statePath)) fail("TRANSACTION_STATE_MISSING");
  assertRootControlledParentChain(transactionRoot, controlRoot);
  assertTrustedFile(statePath, sha256File(statePath), "TRANSACTION_STATE");
  const state = readState(statePath);
  if (state.configPath !== configPath || state.configSha256 !== sha256File(configPath)) fail("TRANSACTION_CONFIG_CHANGED");

  if (phase === "activated") {
    if (state.status !== "prepared") fail("TRANSACTION_PHASE_ORDER_INVALID");
    const next = identityFromCurrent(root);
    await startWorkers(configPath, root, next);
    state.next = next;
    state.status = "activated";
    atomicWriteJson(statePath, state);
  } else if (phase === "precommit") {
    if (state.status !== "activated") fail("TRANSACTION_PHASE_ORDER_INVALID");
    if (!state.next || !workersMatch(pm2Entries(), state.next)) fail("MEDIA_WORKER_PRECOMMIT_MISMATCH");
    await waitForWorkers(state.next, true);
    state.status = "precommit";
    atomicWriteJson(statePath, state);
  } else if (phase === "persisted") {
    if (state.status !== "precommit") fail("TRANSACTION_PHASE_ORDER_INVALID");
    if (!state.next) fail("MEDIA_WORKER_NEXT_IDENTITY_MISSING");
    const dumpPath = "/root/.pm2/dump.pm2";
    assertTrustedFile(dumpPath, sha256File(dumpPath), "PM2_DUMP");
    const dump = readJson(dumpPath, "PM2_DUMP");
    if (!dumpWorkersMatch(dump, state.next)) fail("MEDIA_WORKER_DUMP_MISMATCH");
    state.status = "persisted";
    state.persistedAt = new Date().toISOString();
    atomicWriteJson(statePath, state);
  } else if (phase === "rollback-before") {
    // A previous rollback-after attempt may have failed after the workers were
    // stopped but before their prior identity was proven online. Treat that
    // state as a retryable rollback prerequisite instead of stranding the
    // transaction in an unrecoverable half-rollback.
    if (!["snapshot-written", "prepared", "activated", "precommit", "persisted", "rollback-stopped", "rolled-back"].includes(state.status)) fail("TRANSACTION_PHASE_ORDER_INVALID");
    stopWorkers();
    await waitForPortsFree();
    deleteWorkers();
    state.status = "rollback-stopped";
    atomicWriteJson(statePath, state);
  } else if (phase === "rollback-after") {
    if (state.status !== "rollback-stopped") fail("TRANSACTION_PHASE_ORDER_INVALID");
    await startWorkers(configPath, root, state.previous);
    state.status = "rolled-back";
    state.rolledBackAt = new Date().toISOString();
    atomicWriteJson(statePath, state);
  } else if (phase === "rollback-persisted") {
    if (state.status !== "rolled-back") fail("TRANSACTION_PHASE_ORDER_INVALID");
    const dumpPath = "/root/.pm2/dump.pm2";
    assertTrustedFile(dumpPath, sha256File(dumpPath), "PM2_DUMP");
    const dump = readJson(dumpPath, "PM2_DUMP");
    if (!dumpWorkersMatch(dump, state.previous)) fail("MEDIA_WORKER_ROLLBACK_DUMP_MISMATCH");
    state.status = "rollback-persisted";
    atomicWriteJson(statePath, state);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, phase, status: state.status })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
