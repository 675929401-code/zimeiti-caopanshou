#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { canonicalJson, sha256 } from "./lib/json-schema-contract.mjs";

const ARCHIVE_METADATA_MAX_BUFFER = 64 * 1024 * 1024;
const BROWSER_VALIDATIONS = Object.freeze([
  "desktop-precise-route-visual-1440x900",
  "desktop-two-adjacent-pages-visual",
  "console-and-request-errors",
]);
const CHECKLIST_VALIDATION = "full-desktop-release-checklist";
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const CANDIDATE_ADMIN_PERMISSIONS = Object.freeze([
  "admin.accounts.manage", "members.view", "member_content.view", "members.manage", "members.delete",
  "member_permissions.manage", "invitations.manage", "packages.manage", "cards.manage", "billing.view",
  "wallet.adjust", "billing.export", "agents.view", "agents.manage", "prompts.view", "prompts.edit",
  "internal_tools.manage", "models.view", "models.manage", "platform.settings.manage", "brand.settings.manage",
  "integrations.manage", "payment.settings.manage", "white_label.manage", "announcements.manage", "security.view",
  "security.manage", "logs.view", "logs.export", "backups.manage", "deployment.execute",
]);

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--") || values.has(name)) fail("ARGUMENT_INVALID", name);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("ARGUMENT_VALUE_REQUIRED", name);
    values.set(name, value);
    index += 1;
  }
  return values;
}

function requireDirectory(candidate, label) {
  const resolved = fs.realpathSync.native(path.resolve(candidate));
  const stats = fs.lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("DIRECTORY_UNSAFE", label);
  return resolved;
}

function requireFreshDirectory(candidate, label) {
  const resolved = path.resolve(candidate);
  if (fs.existsSync(resolved)) fail("OUTPUT_ALREADY_EXISTS", label);
  const parent = requireDirectory(path.dirname(resolved), `${label}-parent`);
  if (path.dirname(resolved) !== parent) fail("OUTPUT_PARENT_REDIRECTED", label);
  fs.mkdirSync(resolved, { recursive: false, mode: 0o700 });
  return fs.realpathSync.native(resolved);
}

function readJson(filePath, code) {
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) fail(code, "not-regular");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error;
    fail(code, error instanceof Error ? error.message : String(error));
  }
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createCandidateJwt(secret, claims) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64UrlJson({ alg: "HS256", typ: "JWT" })}.${base64UrlJson({ ...claims, iat: now, exp: now + 60 * 60 })}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function sendJson(request, response, status, value, count = null) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (count !== null) response.setHeader("Content-Range", count > 0 ? `0-${count - 1}/${count}` : "*/0");
  response.setHeader("Content-Length", String(request.method === "HEAD" ? 0 : body.length));
  response.end(request.method === "HEAD" ? undefined : body);
}

async function startCandidateDatabaseFixture(port) {
  const sessionId = `candidate-${crypto.randomUUID()}`;
  const admin = {
    id: "00000000-0000-4000-8000-000000000001",
    username: "candidate-admin",
    email: "candidate-admin@example.invalid",
    role: "admin",
    status: "active",
    is_active: true,
    display_name: "候选验收管理员",
    phone: null,
    member_status: "active",
    member_expires_at: null,
    credits: 100000,
    credits_reserved: 0,
    cash_balance: 0,
    allowed_categories: null,
    theme_preference: null,
    password_hash: "candidate-fixture-only",
    session_id: sessionId,
  };
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    requests.push({ method: request.method || "GET", path: url.pathname });
    const objectResponse = String(request.headers.accept || "").includes("application/vnd.pgrst.object+json");
    if (url.pathname === "/rest/v1/users") {
      sendJson(request, response, 200, objectResponse ? admin : [admin], 1);
      return;
    }
    if (url.pathname === "/rest/v1/user_auth_sessions") {
      const row = { user_id: admin.id, session_id: sessionId, revoked_at: null, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
      sendJson(request, response, 200, objectResponse ? row : [row], 1);
      return;
    }
    if (url.pathname === "/rest/v1/rpc/read_admin_access_snapshot") {
      sendJson(request, response, 200, {
        authority_status: "ready", integrity_valid: true, admin_level: "super_admin",
        permission_keys: CANDIDATE_ADMIN_PERMISSIONS, revision: 1,
        checksum: "candidate-read-only", profile_active: true, updated_at: new Date().toISOString(),
      });
      return;
    }
    if (url.pathname === "/rest/v1/rpc/read_admin_step_up_session") {
      sendJson(request, response, 200, { status: "missing", expires_at: null, auth_method: null, session_id: null });
      return;
    }
    if (url.pathname === "/rest/v1/rpc/read_admin_step_up_maintenance_lock") {
      sendJson(request, response, 200, {
        status: "ready", enabled: false, revision: 1, enabled_by: null, enabled_at: null,
        expires_at: null, enable_reason: "", disabled_by: null, disabled_at: null,
        disable_reason: "", max_duration_minutes: 30, updated_at: new Date().toISOString(),
      });
      return;
    }
    if (url.pathname === "/rest/v1/rpc/read_published_platform_brand") {
      // A null RPC result is the production contract for "no published brand".
      // Returning the generic empty object would be interpreted as a corrupt
      // published revision and make the root layout fail closed with HTTP 500.
      sendJson(request, response, 200, null);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      sendJson(request, response, 200, {});
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      sendJson(request, response, 200, objectResponse ? {} : [], 0);
      return;
    }
    sendJson(request, response, 404, { code: "CANDIDATE_FIXTURE_NOT_FOUND" });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const serviceRoleSecret = crypto.randomBytes(48).toString("hex");
  return {
    server,
    requests,
    admin,
    sessionId,
    url: `http://127.0.0.1:${port}`,
    serviceRoleKey: createCandidateJwt(serviceRoleSecret, { role: "service_role", iss: "candidate-local" }),
  };
}

async function stopFixtureServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail(options.code || "COMMAND_FAILED", `${command}:${result.error?.message || result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

function canonicalArtifactPath(raw) {
  const normalized = raw.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!normalized || normalized.includes("\\") || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) fail("ARCHIVE_PATH_UNSAFE", raw);
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || path.posix.normalize(normalized) !== normalized) {
    fail("ARCHIVE_PATH_UNSAFE", raw);
  }
  return normalized;
}

function inspectArchive(archivePath) {
  const listing = run("tar", ["-tzf", archivePath], {
    code: "ARCHIVE_LIST_FAILED",
    maxBuffer: ARCHIVE_METADATA_MAX_BUFFER,
  });
  const verbose = run("tar", ["-tvzf", archivePath], {
    code: "ARCHIVE_VERBOSE_LIST_FAILED",
    maxBuffer: ARCHIVE_METADATA_MAX_BUFFER,
  });
  const names = listing.split(/\r?\n/u).filter(Boolean);
  const types = verbose.split(/\r?\n/u).filter(Boolean);
  if (names.length !== types.length || names.length < 2) fail("ARCHIVE_LISTING_INVALID");
  const collisionKeys = new Set();
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] === "." || names[index] === "./") continue;
    const logical = canonicalArtifactPath(names[index]);
    const collision = logical.normalize("NFC").toLocaleLowerCase("en-US");
    if (collisionKeys.has(collision)) fail("ARCHIVE_PATH_COLLISION", logical);
    collisionKeys.add(collision);
    if (!new Set(["-", "d"]).has(types[index][0])) fail("ARCHIVE_ENTRY_TYPE_FORBIDDEN", logical);
  }
}

function verifyExtractedPayload(payloadRoot, bundle, service, archivePath) {
  const manifestPath = path.join(payloadRoot, "release-manifest.json");
  const manifest = readJson(manifestPath, "RELEASE_MANIFEST_INVALID");
  const subject = bundle.subject;
  const expectedPayload = subject.candidatePayloads[service];
  if (manifest.schemaVersion !== 2 || manifest.projectId !== "zimeiti-caopanshou" || manifest.service !== service
    || manifest.commitSha !== subject.commit || manifest.sourceVersion !== subject.sourceVersion
    || manifest.buildId !== subject.builds[service] || manifest.buildOutputDigest !== subject.buildOutputDigests[service]
    || manifest.releaseId !== expectedPayload.releaseId || manifest.artifactDigest !== expectedPayload.artifactDigest
    || manifest.fileCount !== expectedPayload.fileCount || manifest.totalBytes !== expectedPayload.totalBytes
    || sha256File(archivePath) !== expectedPayload.archiveSha256 || !Array.isArray(manifest.files)) {
    fail("CANDIDATE_PAYLOAD_IDENTITY_MISMATCH", service);
  }

  const actual = [];
  const collisions = new Set();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const entryPath = path.join(directory, entry.name);
      const relative = canonicalArtifactPath(path.relative(payloadRoot, entryPath).split(path.sep).join("/"));
      const stats = fs.lstatSync(entryPath);
      if (stats.isSymbolicLink()) fail("CANDIDATE_PAYLOAD_LINK_FORBIDDEN", relative);
      const collision = relative.normalize("NFC").toLocaleLowerCase("en-US");
      if (collisions.has(collision)) fail("CANDIDATE_PAYLOAD_PATH_COLLISION", relative);
      collisions.add(collision);
      if (stats.isDirectory()) {
        actual.push({ path: relative, kind: "directory", mode: stats.mode & 0o777, bytes: 0, sha256: null });
        walk(entryPath);
      } else if (stats.isFile() && relative !== "release-manifest.json") {
        actual.push({ path: relative, kind: "file", mode: stats.mode & 0o777, bytes: stats.size, sha256: sha256File(entryPath) });
      } else if (!stats.isFile()) {
        fail("CANDIDATE_PAYLOAD_ENTRY_FORBIDDEN", relative);
      }
    }
  };
  walk(payloadRoot);
  actual.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) fail("CANDIDATE_PAYLOAD_INVENTORY_MISMATCH", service);
  if (sha256(canonicalJson(actual)) !== manifest.artifactDigest) fail("CANDIDATE_PAYLOAD_DIGEST_MISMATCH", service);
  return manifest;
}

function extractCandidate(candidateRoot, workRoot, bundle, service) {
  const payload = bundle.subject.candidatePayloads[service];
  if (!payload) fail("CANDIDATE_SERVICE_PAYLOAD_MISSING", service);
  const archive = path.join(candidateRoot, "candidate-packages", `${service}-${payload.releaseId}.tar.gz`);
  const stats = fs.lstatSync(archive);
  if (!stats.isFile() || stats.isSymbolicLink() || sha256File(archive) !== payload.archiveSha256) {
    fail("CANDIDATE_ARCHIVE_SHA256_MISMATCH", service);
  }
  inspectArchive(archive);
  const payloadRoot = path.join(workRoot, "payloads", service);
  fs.mkdirSync(payloadRoot, { recursive: true, mode: 0o700 });
  run("tar", ["-xzf", archive, "-C", payloadRoot], { code: "CANDIDATE_ARCHIVE_EXTRACT_FAILED", timeout: 300_000 });
  return { payloadRoot, manifest: verifyExtractedPayload(payloadRoot, bundle, service, archive) };
}

function prepareAssetMetadata(workRoot, webPayload, webManifest) {
  const manifestSource = path.join(webPayload, ".release", "public-assets.v1.json");
  const assetManifest = readJson(manifestSource, "PUBLIC_ASSET_MANIFEST_INVALID");
  const manifestSha256 = sha256File(manifestSource);
  if (assetManifest.digest !== webManifest.assetDigest || assetManifest.assetVersion !== webManifest.assetVersion
    || manifestSha256 !== webManifest.assetManifestSha256 || !Array.isArray(assetManifest.files)) {
    fail("PUBLIC_ASSET_MANIFEST_BINDING_MISMATCH");
  }
  const releaseRoot = path.join(workRoot, "assets", assetManifest.assetVersion);
  const publicRoot = path.join(releaseRoot, "public");
  const metadataRoot = path.join(releaseRoot, ".release");
  fs.mkdirSync(publicRoot, { recursive: true });
  fs.mkdirSync(metadataRoot, { recursive: true });
  fs.copyFileSync(manifestSource, path.join(metadataRoot, "public-assets.v1.json"), fs.constants.COPYFILE_EXCL);
  writeJson(path.join(metadataRoot, "public-assets.ready.v1.json"), {
    schemaVersion: 1,
    projectId: assetManifest.projectId,
    kind: "public-assets-readiness-receipt",
    status: "READY",
    assetVersion: assetManifest.assetVersion,
    assetDigest: assetManifest.digest,
    assetPolicySha256: assetManifest.assetPolicySha256,
    manifestSha256,
    fileCount: assetManifest.fileCount,
    totalBytes: assetManifest.totalBytes,
    mutableUploadsIncluded: false,
    verificationMode: "full-sha256",
    storageBackend: "disk",
    location: `ci-metadata-only/${assetManifest.assetVersion}`,
    verifiedAt: new Date().toISOString(),
  });
  return { publicRoot, manifestSha256, assetManifest };
}

function prepareState(root, checkoutRoot, schemaDatabase, service) {
  const stateRoot = path.join(root, `${service}-state`);
  const dataDir = path.join(stateRoot, "data");
  const runtimeDir = path.join(stateRoot, "runtime");
  const commerceDir = path.join(runtimeDir, "commerce-agent");
  const discoveryDir = path.join(runtimeDir, "commerce-discovery");
  const idempotencyDir = path.join(runtimeDir, "llm-request-idempotency");
  const backupDir = path.join(stateRoot, "backups");
  const uploadDir = path.join(stateRoot, "uploads");
  const voiceDir = path.join(stateRoot, "voice");
  const referenceAudioDir = path.join(voiceDir, "reference-audio");
  const voiceDatabase = path.join(voiceDir, "voice.db");
  for (const directory of [runtimeDir, commerceDir, discoveryDir, path.join(discoveryDir, "media"), idempotencyDir, backupDir, uploadDir, voiceDir, referenceAudioDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (service === "web") {
    run("python3", [path.join(checkoutRoot, "scripts", "prepare-candidate-readiness-fixtures.py"),
      "--service", "web", "--input-root", path.dirname(schemaDatabase), "--input", schemaDatabase,
      "--output-root", stateRoot, "--output", dataDir, "--voice-output", voiceDatabase],
    { code: "WEB_FIXTURE_PREPARATION_FAILED", timeout: 120_000 });
  } else {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    run("python3", [path.join(checkoutRoot, "scripts", "prepare-candidate-readiness-fixtures.py"),
      "--service", "voice", "--input-root", path.dirname(schemaDatabase), "--input", schemaDatabase,
      "--output-root", stateRoot, "--output", voiceDatabase],
    { code: "VOICE_FIXTURE_PREPARATION_FAILED", timeout: 120_000 });
  }
  const catalogPath = path.join(discoveryDir, "catalog.json");
  fs.writeFileSync(catalogPath, `${JSON.stringify({ schema: 1, items: [], order: { video: [], image: [], canvas: [] }, homeOrder: { video: [], image: [], canvas: [] } })}\n`, { mode: 0o600 });
  const gatewayKeyPath = path.join(commerceDir, "main-gateway.key");
  fs.writeFileSync(gatewayKeyPath, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
  return { stateRoot, dataDir, runtimeDir, commerceDir, discoveryDir, idempotencyDir, backupDir, uploadDir, referenceAudioDir, voiceDatabase, catalogPath, gatewayKeyPath };
}

function createSchemaDatabase(checkoutRoot, workRoot) {
  const schemaRoot = path.join(workRoot, "schema-source");
  fs.mkdirSync(schemaRoot, { recursive: true, mode: 0o700 });
  const databasePath = path.join(schemaRoot, "voice-schema.db");
  run("pnpm", ["--dir", path.join(checkoutRoot, "voice-platform"), "exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], {
    cwd: checkoutRoot,
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
    code: "VOICE_SCHEMA_CREATION_FAILED",
    timeout: 180_000,
  });
  if (!fs.existsSync(databasePath) || fs.statSync(databasePath).size < 1) fail("VOICE_SCHEMA_DATABASE_EMPTY");
  return databasePath;
}

function candidateEnvironment(payloadRoot, manifest, state, assets, port, service, acceptance) {
  const environment = {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: path.join(state.stateRoot, "home"),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    RELEASE_READINESS_PROFILE: "candidate-runtime-v1",
    RELEASE_CANDIDATE_MODE: "isolated",
    SERVER_ENV_DISCOVERY_DISABLED: "1",
    DEV_READ_ONLY_MODE: "1",
    RELEASE_ROOT: payloadRoot,
    APP_DATA_DIR: state.dataDir,
    APP_RUNTIME_DIR: state.runtimeDir,
    COMMERCE_DATA_DIR: state.commerceDir,
    COMMERCE_DISCOVERY_CATALOG: state.catalogPath,
    COMMERCE_GATEWAY_KEY_FILE: state.gatewayKeyPath,
    IDEMPOTENCY_DIR: state.idempotencyDir,
    BACKUP_DIR: state.backupDir,
    PUBLIC_ASSET_ROOT: assets.publicRoot,
    VOICE_SQLITE_PATH: state.voiceDatabase,
    VOICE_REFERENCE_AUDIO_DIR: state.referenceAudioDir,
    ASSET_DIGEST: service === "web" ? manifest.assetDigest : assets.assetManifest.digest,
    ASSET_MANIFEST_SHA256: assets.manifestSha256,
    RELEASE_ID: manifest.releaseId,
    DEPLOY_COMMIT_SHA: manifest.commitSha,
    EXPECTED_BUILD_ID: manifest.buildId,
    RELEASE_SOURCE_VERSION: manifest.sourceVersion,
    RELEASE_BUILD_OUTPUT_DIGEST: manifest.buildOutputDigest,
    COZE_PROJECT_ENV: "PROD",
  };
  fs.mkdirSync(environment.HOME, { recursive: true, mode: 0o700 });
  if (service === "web") {
    environment.JWT_SECRET = acceptance.jwtSecret;
    environment.COZE_SUPABASE_URL = acceptance.database.url;
    environment.COZE_SUPABASE_SERVICE_ROLE_KEY = acceptance.database.serviceRoleKey;
    environment.STORAGE_LOCAL_BASE_PATH = state.uploadDir;
  } else {
    environment.AUTH_SECRET = crypto.randomBytes(48).toString("hex");
    environment.DATABASE_URL = `file:${state.voiceDatabase}`;
  }
  return environment;
}

function startCandidate(payloadRoot, manifest, state, assets, port, service, reportRoot, acceptance) {
  const logPath = path.join(reportRoot, `${service}-candidate.log`);
  const descriptor = fs.openSync(logPath, "wx", 0o600);
  const child = spawn(process.execPath, [path.join(payloadRoot, "server.js")], {
    cwd: payloadRoot,
    env: candidateEnvironment(payloadRoot, manifest, state, assets, port, service, acceptance),
    stdio: ["ignore", descriptor, descriptor],
    windowsHide: true,
  });
  fs.closeSync(descriptor);
  return { child, logPath };
}

async function waitForReadiness(url, manifest, service) {
  let last = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000), headers: { "Cache-Control": "no-cache" } });
      last = await response.json();
      if (response.ok && last?.ready === true) break;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (last?.ready !== true || last.activationReady !== false || last.readinessProfile !== "candidate-runtime-v1"
    || last.service !== service || last.releaseId !== manifest.releaseId || last.commitSha !== manifest.commitSha
    || last.buildId !== manifest.buildId || last.sourceVersion !== manifest.sourceVersion
    || last.buildOutputDigest !== manifest.buildOutputDigest
    || (service === "web" && last.assetDigest !== manifest.assetDigest)) {
    fail("CANDIDATE_READINESS_IDENTITY_MISMATCH", `${service}:${JSON.stringify(last)}`);
  }
  return last;
}

function routeFileName(route, index) {
  const slug = route === "/" ? "home" : route.replace(/^\//u, "").replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "") || "route";
  return `${String(index + 1).padStart(2, "0")}-${slug}.png`;
}

function cleanUrl(raw) {
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(raw).slice(0, 300);
  }
}

async function runBrowserAcceptance(baseUrl, routes, screenshotRoot, authToken) {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.addCookies([{
    name: "auth_token",
    value: authToken,
    url: baseUrl,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1000) + 60 * 60,
  }]);
  const results = [];
  const consoleErrors = [];
  const requestFailures = [];
  const nonBlockingHttpErrors = [];
  try {
    for (const [index, route] of routes.entries()) {
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push({ route, text: message.text().slice(0, 1000) });
      });
      page.on("pageerror", (error) => consoleErrors.push({ route, text: `${error.name}:${error.message}`.slice(0, 1000) }));
      page.on("requestfailed", (request) => requestFailures.push({ route, resourceType: request.resourceType(), url: cleanUrl(request.url()), error: request.failure()?.errorText || "requestfailed" }));
      page.on("response", (response) => {
        if (response.status() < 400) return;
        const request = response.request();
        const item = { route, status: response.status(), resourceType: request.resourceType(), url: cleanUrl(response.url()) };
        if (["document", "script", "stylesheet"].includes(request.resourceType())) requestFailures.push(item);
        else nonBlockingHttpErrors.push(item);
      });
      const startedAt = Date.now();
      const response = await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1_500);
      const finalUrl = new URL(page.url());
      const expectedUrl = new URL(route, baseUrl);
      if (!response || response.status() >= 400) fail("BROWSER_DOCUMENT_HTTP_FAILED", `${route}:${response?.status() ?? "no-response"}`);
      if (finalUrl.pathname !== expectedUrl.pathname) fail("BROWSER_ROUTE_REDIRECTED", `${route}:${finalUrl.pathname}`);
      const body = page.locator("body");
      await body.waitFor({ state: "visible" });
      const bodyText = (await body.innerText()).trim();
      if (bodyText.length < 20 || /Application error|Internal Server Error|This page could not be found/iu.test(bodyText)) {
        fail("BROWSER_PAGE_RENDER_INVALID", `${route}:${bodyText.slice(0, 200)}`);
      }
      const screenshot = path.join(screenshotRoot, routeFileName(route, index));
      await page.screenshot({ path: screenshot, fullPage: false, animations: "disabled" });
      results.push({
        route,
        finalPath: finalUrl.pathname,
        status: response.status(),
        title: await page.title(),
        visibleTextCharacters: bodyText.length,
        elapsedMs: Date.now() - startedAt,
        screenshot: path.basename(screenshot),
        screenshotSha256: sha256File(screenshot),
      });
      await page.close();
    }
  } finally {
    await context.close();
    await browser.close();
  }
  if (consoleErrors.length) fail("BROWSER_CONSOLE_ERRORS", JSON.stringify(consoleErrors.slice(0, 10)));
  if (requestFailures.length) fail("BROWSER_REQUEST_FAILURES", JSON.stringify(requestFailures.slice(0, 10)));
  return { routes: results, consoleErrors, requestFailures, nonBlockingHttpErrors };
}

function runtimeIdentity(bundle, service) {
  if (!bundle.subject.services.includes(service)) return null;
  return {
    commit: bundle.subject.commit,
    sourceVersion: bundle.subject.sourceVersion,
    buildId: bundle.subject.builds[service],
    buildOutputDigest: bundle.subject.buildOutputDigests[service],
  };
}

function signBrowserEvidence(bundle, validationId, index, privateKey, issuer, evidenceRoot, checkedAt) {
  const evidenceRef = `${validationId}.json`;
  const evidencePath = path.join(evidenceRoot, evidenceRef);
  const evidence = {
    schemaVersion: "zimeiti-release-browser-acceptance-evidence.v1",
    receiptId: `github-browser-${process.env.GITHUB_RUN_ID || "local"}-${index}-${crypto.randomBytes(8).toString("hex")}`,
    nonce: crypto.randomBytes(24).toString("base64url"),
    checkedAt,
    subject: {
      commit: bundle.subject.commit,
      sourceVersion: bundle.subject.sourceVersion,
      builds: bundle.subject.builds,
      buildOutputDigests: bundle.subject.buildOutputDigests,
      candidatePayloads: bundle.subject.candidatePayloads,
    },
    runtimeReadbacks: { web: runtimeIdentity(bundle, "web"), voice: runtimeIdentity(bundle, "voice") },
    viewport: VIEWPORT,
    preciseRoute: bundle.scope.browserAcceptance.preciseRoute,
    adjacentRoutes: bundle.scope.browserAcceptance.requiredRoutes.filter((route) => route !== bundle.scope.browserAcceptance.preciseRoute),
    consoleErrors: [],
    requestFailures: [],
    result: "passed",
  };
  writeJson(evidencePath, evidence);
  const evidenceBytes = fs.readFileSync(evidencePath);
  const issuedAt = new Date().toISOString();
  const signature = {
    schemaVersion: "zimeiti-release-browser-acceptance-signature.v1",
    algorithm: "Ed25519",
    issuerId: issuer.issuerId,
    publicKeyFingerprint: issuer.publicKeyFingerprint,
    receiptId: evidence.receiptId,
    nonce: evidence.nonce,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 12 * 60 * 60 * 1000).toISOString(),
    evidenceType: "release-browser-acceptance",
    targetSha256: sha256(evidenceBytes),
    subjectCommit: bundle.subject.commit,
    sourceVersion: bundle.subject.sourceVersion,
    webBuildId: bundle.subject.builds.web,
    voiceBuildId: bundle.subject.builds.voice,
    webOutputDigest: bundle.subject.buildOutputDigests.web,
    voiceOutputDigest: bundle.subject.buildOutputDigests.voice,
  };
  signature.signature = crypto.sign(null, Buffer.from(canonicalJson(signature)), privateKey).toString("base64");
  const signaturePath = `${evidencePath}.sig.json`;
  writeJson(signaturePath, signature);
  return { evidenceRef, evidenceSha256: sha256(evidenceBytes), signatureRef: `${evidenceRef}.sig.json`, signatureSha256: sha256File(signaturePath) };
}

function recomputeBundleId(bundle) {
  const payload = { ...bundle };
  delete payload.bundleId;
  return `validation-${sha256(canonicalJson(payload)).slice(0, 24)}`;
}

function createExternalBundle(bundle, evidenceRoot, privateKey, issuer, reportSha256) {
  const external = structuredClone(bundle);
  const originallyPending = new Set(external.attestations.filter((entry) => entry.status !== "passed").map((entry) => entry.validationId));
  const allowedPending = new Set([...BROWSER_VALIDATIONS, CHECKLIST_VALIDATION]);
  for (const validationId of originallyPending) if (!allowedPending.has(validationId)) fail("UNHANDLED_EXTERNAL_VALIDATION", validationId);
  for (const validationId of BROWSER_VALIDATIONS) if (!originallyPending.has(validationId)) fail("BROWSER_VALIDATION_NOT_PENDING", validationId);
  for (const entry of external.attestations) {
    entry.status = "pending-required";
    entry.executor = "unassigned";
    entry.evidenceRef = null;
    entry.evidenceSha256 = null;
    entry.signatureRef = null;
    entry.signatureSha256 = null;
  }
  const checkedAt = new Date().toISOString();
  for (const [index, validationId] of BROWSER_VALIDATIONS.entries()) {
    const entry = external.attestations.find((candidate) => candidate.validationId === validationId);
    const signed = signBrowserEvidence(bundle, validationId, index, privateKey, issuer, evidenceRoot, checkedAt);
    Object.assign(entry, { status: "passed", executor: "external-browser", ...signed });
  }
  if (originallyPending.has(CHECKLIST_VALIDATION)) {
    const evidenceRef = `${CHECKLIST_VALIDATION}.json`;
    const evidencePath = path.join(evidenceRoot, evidenceRef);
    writeJson(evidencePath, {
      schemaVersion: "zimeiti-release-change-validation-evidence.v1",
      scopeReceiptId: bundle.scope.receiptId,
      subjectCommit: bundle.subject.commit,
      validationId: CHECKLIST_VALIDATION,
      executor: "external-verifier",
      result: "passed",
      evidenceLabel: `exact-artifact-runtime-and-required-route-report-sha256-${reportSha256}`,
    });
    const entry = external.attestations.find((candidate) => candidate.validationId === CHECKLIST_VALIDATION);
    Object.assign(entry, { status: "passed", executor: "external-verifier", evidenceRef, evidenceSha256: sha256File(evidencePath), signatureRef: null, signatureSha256: null });
  }
  external.summary = {
    requiredCount: external.attestations.length,
    passedCount: external.attestations.filter((entry) => entry.status === "passed").length,
    pendingCount: external.attestations.filter((entry) => entry.status === "pending-required").length,
    failedCount: external.attestations.filter((entry) => entry.status === "failed").length,
  };
  external.bundleId = recomputeBundleId(external);
  return external;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null) fail("CANDIDATE_PROCESS_CLEANUP_FAILED", String(child.pid));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checkoutRoot = requireDirectory(args.get("--checkout-root") || process.cwd(), "checkout-root");
  const candidateRoot = requireDirectory(args.get("--candidate-root") || "", "candidate-root");
  const workRoot = requireFreshDirectory(args.get("--work-root") || "", "work-root");
  const outputRoot = requireFreshDirectory(args.get("--output-root") || "", "output-root");
  const evidenceRoot = path.join(outputRoot, "evidence");
  const reportRoot = path.join(outputRoot, "reports");
  const screenshotRoot = path.join(outputRoot, "screenshots");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.mkdirSync(screenshotRoot, { recursive: true });

  if (process.platform !== "linux" || !workRoot.startsWith("/data/")
    || fs.statSync("/").dev === fs.statSync("/data").dev || fs.statSync(workRoot).dev !== fs.statSync("/data").dev) {
    fail("DEDICATED_DATA_MOUNT_REQUIRED");
  }
  const bundle = readJson(path.join(candidateRoot, "release-change-validations.json"), "CANDIDATE_BUNDLE_INVALID");
  if (bundle.target !== "source-candidate" || bundle.status !== "source-candidate-pending-required"
    || bundle.subject.commit !== String(process.env.GITHUB_SHA || bundle.subject.commit).toLowerCase()
    || !bundle.subject.services.includes("web")) fail("CANDIDATE_BUNDLE_PHASE_INVALID");
  const routes = bundle.scope.browserAcceptance.requiredRoutes;
  if (!Array.isArray(routes) || routes.length < 3 || new Set(routes).size !== routes.length
    || !routes.includes(bundle.scope.browserAcceptance.preciseRoute)) fail("BROWSER_ROUTE_SCOPE_INVALID");

  const secretName = args.get("--private-key-env") || "RELEASE_BROWSER_ACCEPTANCE_ED25519_PRIVATE_KEY";
  const privateKeyPem = process.env[secretName];
  delete process.env[secretName];
  if (!privateKeyPem || !/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/u.test(privateKeyPem)) fail("BROWSER_SIGNING_KEY_MISSING");
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") fail("BROWSER_SIGNING_KEY_NOT_ED25519");
  const publicKey = crypto.createPublicKey(privateKey);
  const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
  const trustPolicy = readJson(path.join(checkoutRoot, "deploy", "policies", "release-acceptance-trusted-issuers.v1.json"), "TRUST_POLICY_INVALID");
  const issuerId = args.get("--issuer-id") || "github-actions-browser-v1";
  const issuer = trustPolicy.issuers?.find((entry) => entry.issuerId === issuerId);
  if (!issuer || issuer.publicKeyFingerprint !== fingerprint || issuer.publicKeyPem !== publicKey.export({ type: "spki", format: "pem" }).toString()) {
    fail("BROWSER_SIGNING_KEY_NOT_TRUSTED");
  }

  const extracted = {};
  for (const service of bundle.subject.services) extracted[service] = extractCandidate(candidateRoot, workRoot, bundle, service);
  const assets = prepareAssetMetadata(workRoot, extracted.web.payloadRoot, extracted.web.manifest);
  const schemaDatabase = createSchemaDatabase(checkoutRoot, workRoot);
  const states = {};
  for (const service of bundle.subject.services) states[service] = prepareState(workRoot, checkoutRoot, schemaDatabase, service);
  const fixturePort = Number(args.get("--fixture-port") || 15100);
  if (!Number.isInteger(fixturePort) || fixturePort < 1024 || fixturePort > 64000) fail("FIXTURE_PORT_INVALID");
  const ports = {
    web: Number(extracted.web.manifest.port),
    voice: extracted.voice ? Number(extracted.voice.manifest.port) : null,
    database: fixturePort,
  };
  const activePorts = [
    ports.web,
    ports.database,
    ...(bundle.subject.services.includes("voice") ? [ports.voice] : []),
  ];
  if (activePorts.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
    || new Set(activePorts).size !== activePorts.length) fail("CANDIDATE_PORT_CONTRACT_INVALID");
  const processes = {};
  const jwtSecret = crypto.randomBytes(48).toString("hex");
  let databaseFixture;
  let runtimeReadbacks;
  let browserReport;
  try {
    databaseFixture = await startCandidateDatabaseFixture(ports.database);
    const acceptance = { jwtSecret, database: databaseFixture };
    const authToken = createCandidateJwt(jwtSecret, {
      userId: databaseFixture.admin.id,
      username: databaseFixture.admin.username,
      role: "admin",
      displayName: databaseFixture.admin.display_name,
      sessionId: databaseFixture.sessionId,
    });
    for (const service of bundle.subject.services) {
      processes[service] = startCandidate(extracted[service].payloadRoot, extracted[service].manifest, states[service], assets, ports[service], service, reportRoot, acceptance);
    }
    runtimeReadbacks = {};
    for (const service of bundle.subject.services) {
      const readinessPath = extracted[service].manifest.readinessPath;
      runtimeReadbacks[service] = await waitForReadiness(`http://127.0.0.1:${ports[service]}${readinessPath}`, extracted[service].manifest, service);
    }
    browserReport = await runBrowserAcceptance(`http://127.0.0.1:${ports.web}`, routes, screenshotRoot, authToken);
  } finally {
    await Promise.all(Object.values(processes).map((entry) => stopChild(entry.child)));
    await stopFixtureServer(databaseFixture?.server);
  }

  const report = {
    schemaVersion: "zimeiti-release-browser-acceptance-report.v1",
    checkedAt: new Date().toISOString(),
    candidateBundleId: bundle.bundleId,
    subject: bundle.subject,
    viewport: VIEWPORT,
    runtimeReadbacks,
    routes: browserReport.routes,
    consoleErrors: browserReport.consoleErrors,
    requestFailures: browserReport.requestFailures,
    nonBlockingHttpErrors: browserReport.nonBlockingHttpErrors,
    databaseFixture: {
      localOnly: true,
      requestCount: databaseFixture.requests.length,
      paths: [...new Set(databaseFixture.requests.map((entry) => entry.path))].sort((left, right) => left.localeCompare(right, "en")),
    },
    result: "passed",
  };
  const reportPath = path.join(reportRoot, "browser-acceptance-report.json");
  writeJson(reportPath, report);
  const externalBundle = createExternalBundle(bundle, evidenceRoot, privateKey, issuer, sha256File(reportPath));
  writeJson(path.join(outputRoot, "bundle.json"), externalBundle);
  process.stdout.write(`${JSON.stringify({
    passed: true,
    commit: bundle.subject.commit,
    bundleId: externalBundle.bundleId,
    routes: routes.length,
    screenshots: browserReport.routes.length,
    reportSha256: sha256File(reportPath),
  })}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
