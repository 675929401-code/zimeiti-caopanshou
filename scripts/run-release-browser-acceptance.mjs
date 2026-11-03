#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { canonicalJson, sha256 } from "./lib/json-schema-contract.mjs";
import { validateAcceptanceExecution, validateAutomaticTrigger, validateRun } from "./release-run-provenance.mjs";
import { verifyCandidatePackage } from "./deployment-control-plane.mjs";

const ARCHIVE_METADATA_MAX_BUFFER = 64 * 1024 * 1024;
const BROWSER_VALIDATIONS = Object.freeze([
  "desktop-precise-route-visual-1440x900",
  "desktop-two-adjacent-pages-visual",
  "console-and-request-errors",
]);
const CHECKLIST_VALIDATION = "full-desktop-release-checklist";
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const NETWORK_CONSOLE_ERROR = /^Failed to load resource: the server responded with a status of \d{3} \([^)]*\)$/u;
const CANDIDATE_BROWSER_ASSET_FIXTURE_ROOT = "scripts/fixtures/release-browser-assets";
const CANDIDATE_BROWSER_ASSETS = Object.freeze([
  Object.freeze({
    path: "public/avatars/voice-studio/portraits.webp",
    fixturePath: "scripts/fixtures/release-browser-assets/portraits.webp",
    urlPath: "/avatars/voice-studio/portraits.webp",
    bytes: 110_838,
    sha256: "bed09115f796eedc58bffe927694ebe9e679232db7338d94efe62b396bd930cf",
    contentType: "image/webp",
  }),
  Object.freeze({
    path: "public/product-assets/youcai-demo-v1/storyboard-modes/manifest.json",
    fixturePath: "scripts/fixtures/release-browser-assets/storyboard-modes-manifest.json",
    urlPath: "/product-assets/youcai-demo-v1/storyboard-modes/manifest.json",
    bytes: 1_959,
    sha256: "c100d5a99653260d3f123fc1459e44a5c494947ed6052040b2a60365df8f6863",
    contentType: "application/json",
  }),
  Object.freeze({
    path: "public/product-assets/youcai-demo-v1/storyboard-modes/exaggerated.webp",
    fixturePath: "scripts/fixtures/release-browser-assets/storyboard-modes-exaggerated.webp",
    urlPath: "/product-assets/youcai-demo-v1/storyboard-modes/exaggerated.webp",
    bytes: 177_510,
    sha256: "5576636e227ec31f3906f620ea69511cf1b3949e3f6b01818ce160835557e590",
    contentType: "image/webp",
  }),
  Object.freeze({
    path: "public/product-assets/youcai-demo-v1/storyboard-modes/cinematic.webp",
    fixturePath: "scripts/fixtures/release-browser-assets/storyboard-modes-cinematic.webp",
    urlPath: "/product-assets/youcai-demo-v1/storyboard-modes/cinematic.webp",
    bytes: 143_796,
    sha256: "ab7ce5863a05656c8e1df1dc3d0c0e72db1a939ed43883d0e07a630df7a3bc12",
    contentType: "image/webp",
  }),
  Object.freeze({
    path: "public/product-assets/youcai-demo-v1/storyboard-modes/lyrical.webp",
    fixturePath: "scripts/fixtures/release-browser-assets/storyboard-modes-lyrical.webp",
    urlPath: "/product-assets/youcai-demo-v1/storyboard-modes/lyrical.webp",
    bytes: 128_510,
    sha256: "9af142b4015c0145041c7e7dd3c79f726e3567b17efa8b33affb35fdf540269a",
    contentType: "image/webp",
  }),
  Object.freeze({
    path: "public/help/storyboard-video-case.zh-CN.vtt",
    fixturePath: "scripts/fixtures/release-browser-assets/storyboard-video-captions.vtt",
    urlPath: "/help/storyboard-video-case.zh-CN.vtt",
    bytes: 147,
    sha256: "c44f2c33a2bb064b7dc60e5ddda7db9a9f8d58182fbf46cced73bcda0861902c",
    contentType: "text/vtt",
  }),
]);
// The release scope is shared by the Web and Voice candidates. Keep the
// user-visible route identity in the signed evidence, while opening each route
// on the service that actually owns it. Retired bookmarks are accepted only
// when they land on their reviewed canonical destination.
const BROWSER_ROUTE_TARGETS = Object.freeze({
  "/admin": Object.freeze({ service: "web", expectedRoute: "/admin?tab=dashboard&view=overview" }),
  "/extract": Object.freeze({ service: "web", expectedRoute: "/tools?tab=text" }),
  "/formatter": Object.freeze({ service: "web", expectedRoute: "/tools?tab=format" }),
  "/segmenter": Object.freeze({ service: "web", expectedRoute: "/tools?tab=segment", expectedTool: "segment" }),
  "/tools": Object.freeze({ service: "web", expectedRoute: "/tools?tab=text" }),
  "/tools/utility": Object.freeze({ service: "web", expectedRoute: "/tools/utility?tab=text", expectedTool: "text" }),
  "/workspace": Object.freeze({
    service: "voice",
    navigationRoute: "/voice-platform/workspace",
    expectedRoute: "/voice-platform/workspace",
  }),
});
const CANDIDATE_ADMIN_PERMISSIONS = Object.freeze([
  "admin.accounts.manage", "members.view", "member_content.view", "members.manage", "members.delete",
  "member_permissions.manage", "invitations.manage", "packages.manage", "cards.manage", "billing.view",
  "wallet.adjust", "billing.export", "agents.view", "agents.manage", "prompts.view", "prompts.edit",
  "internal_tools.manage", "models.view", "models.manage", "platform.settings.manage", "brand.settings.manage",
  "integrations.manage", "payment.settings.manage", "white_label.manage", "announcements.manage", "security.view",
  "security.manage", "logs.view", "logs.export", "backups.manage", "deployment.execute",
]);
const CANDIDATE_FEATURE_NAVIGATION_KEYS = Object.freeze([
  "marketplace", "toolbox", "storyboard_workbench", "image_workbench", "create",
  "voice", "cover", "youcai", "commerce_agent",
]);
const CANDIDATE_AGENT_NAVIGATION_KEYS = Object.freeze([
  "bip:loop", "task:影像编导", "task:文案创作", "task:获客转化", "自用",
]);
const BENIGN_NAVIGATION_ABORT_KEYS = new Set([
  "/admin|/admin/extraction-reconciliation",
  "/cover|/",
  "/demo/popup-styles|/",
  "/digital-human|/",
  "/digital-human|/voice-studio/workspace",
  "/help|/",
  "/help|/admin/help",
  "/storyboard-workbench|/",
  "/tools|/",
  "/tools/utility|/",
  "/video|/",
  "/voice-studio/imitate|/voice-studio/imitate",
  "/voice-studio/imitate|/voice-studio/voices",
  "/voice-studio/imitate|/voice-studio/workspace",
  "/voice-studio/workspace|/voice-studio/imitate",
  "/voice-studio/workspace|/voice-studio/voices",
  "/voice-studio/workspace|/voice-studio/workspace",
  "/youcai/storyboard-workbench|/",
  "/youcai/storyboard-workbench|/youcai",
  "/youcai/storyboard-workbench|/youcai/profile",
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

// Isolated browser fixture: these values are synthetic and do not represent the live DB.
const VOICE_TASK_RPCS = Object.freeze([
  'begin_voice_generation_atomic','finalize_voice_generation_atomic','refund_voice_generation_atomic',
  'reserve_voice_training_authorization_atomic','release_voice_training_authorization_atomic',
  'finalize_voice_training_authorization_atomic','claim_voice_training_provider_call_atomic',
  'mark_voice_training_provider_attempt_atomic','release_voice_training_terminal_atomic',
  'finalize_voice_training_ready_atomic','apply_wallet_operation_atomic',
]);
const VOICE_OPENAPI = Object.freeze({paths:Object.fromEntries(VOICE_TASK_RPCS.map((name)=>[`/rpc/${name}`,{post:{}}]))});

// Object keys must use the same JS code-point sorting as stableJson() in the
// real manju-runtime-config module, rather than Intl.Collator ordering.
function manjuStableJson(value) {
 if(value===null || typeof value!=='object') return JSON.stringify(value);
 if(Array.isArray(value)) return `[${value.map(manjuStableJson).join(',')}]`;
 return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${manjuStableJson(value[key])}`).join(',')}}`;
}
const MANJU_PAYLOADS=Object.freeze({
 content:{brand:'漫剧工作台',navigation:['/youcai/assets','/youcai/skills','/youcai/tools','/youcai/tools/text/text-chat','/youcai/tools/film-studio','/youcai/tools/canvas','/youcai/inspiration','/youcai/youcai-tv','/youcai/articles','/youcai/recharge','/youcai/referral'],account_route:'/youcai/profile'},
 media:{accepted_types:['image','video','audio','music'],source:'personal-assets',require_owned_asset:true,require_persisted_result:true,allow_temporary_success:false,selection_routes_stay_in_manju:true,showcase_catalog:{v1:{inspiration:{overrides:{}},canvas_examples:{overrides:{}},banners:{overrides:{}},hero:{}}}},
 feature_flags:{creative_agent:true,film_studio:true,canvas:true,inspiration:true,assets:true,general_script:true,drama_script:true,formal_drama:false,script_upload:true},
});
const sha=(value)=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const domains=['content','media','feature_flags'];
const at='2026-01-01T00:00:00.000Z';
const MANJU_ROWS=Object.freeze(domains.map((domain,index)=>{
 const payload=MANJU_PAYLOADS[domain];
 const payload_hash=sha(manjuStableJson(payload));
 const releaseId=`00000000-0000-4000-8000-00000000010${index+1}`;
 const revisionId=`00000000-0000-4000-8000-00000000020${index+1}`;
 const etag=`${payload_hash}:1`;
 return Object.freeze({
  state:{environment:'production',domain,state:'native',generation:1},
  active:{environment:'production',domain,active_release_id:releaseId,active_revision_id:revisionId,etag},
  release:{id:releaseId,environment:'production',domain,release_number:1,revision_id:revisionId,release_kind:'publish',etag},
  revision:{id:revisionId,environment:'production',domain,version:1,status:'published',payload,payload_hash,schema_version:'1.1.0',published_at:at},
 });
}));
const tables=Object.freeze({manju_config_storage_state:'state',manju_config_active:'active',manju_config_releases:'release',manju_config_revisions:'revision'});
// Integrate after `isReadOnlyTableRequest` and before generic REST fallback.
// Returning undefined means this helper has no opinion; matched routes are GET/HEAD only.
function candidateFixtureResponse(method,url,objectResponse=false) {
 if(method!=='GET' && method!=='HEAD') return undefined;
 const {pathname,searchParams}=url;
 if(pathname==='/rest/v1/') return {status:200,value:VOICE_OPENAPI,count:null};
 const table=pathname.startsWith('/rest/v1/')?pathname.slice('/rest/v1/'.length):'';
 const kind=tables[table];
 if(kind){
  let rows=MANJU_ROWS.map((row)=>row[kind]);
  for(const [key,filter] of searchParams){
   if(key==='select') {
    if(filter.split(',').some((column)=>!Object.hasOwn(MANJU_ROWS[0][kind],column))) return {status:400,value:{code:'CANDIDATE_FIXTURE_UNKNOWN_COLUMN'},count:null};
    continue;
   }
   if(key==='limit') {
    if(!/^\d+$/.test(filter)) return {status:400,value:{code:'CANDIDATE_FIXTURE_UNSUPPORTED_FILTER'},count:null};
    continue;
   }
   if(!Object.hasOwn(rows[0] || MANJU_ROWS[0][kind],key)) return {status:400,value:{code:'CANDIDATE_FIXTURE_UNKNOWN_COLUMN'},count:null};
   if(filter.startsWith('eq.')) rows=rows.filter((row)=>String(row[key])===filter.slice(3));
   else if(filter.startsWith('in.(') && filter.endsWith(')')){
    const accepted=filter.slice(4,-1).split(',').map((part)=>part.replace(/^"|"$/g,''));
    rows=rows.filter((row)=>accepted.includes(String(row[key])));
   } else return {status:400,value:{code:'CANDIDATE_FIXTURE_UNSUPPORTED_FILTER'},count:null};
  }
  const limit=searchParams.get('limit');
  if(limit!==null) rows=rows.slice(0,Number(limit));
  if(objectResponse && rows.length!==1)return {status:406,value:{code:'PGRST116',details:`The result contains ${rows.length} rows`,message:'JSON object requested, multiple (or no) rows returned'},count:null};
  return {status:200,value:objectResponse?rows[0]:rows,count:rows.length};
 }
 if(table==='voice_generation_requests'||table==='voice_training_authorization_jobs')return {status:200,value:[],count:0};
 return undefined;
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
    const requestMethod = request.method || "GET";
    const isReadOnlyTableRequest = requestMethod === "GET" || requestMethod === "HEAD";
    const rejectMethod = (allow) => {
      response.setHeader("Allow", allow);
      sendJson(request, response, 405, { code: "CANDIDATE_FIXTURE_METHOD_NOT_ALLOWED" });
    };
    requests.push({ method: requestMethod, path: url.pathname });
    const objectResponse = String(request.headers.accept || "").includes("application/vnd.pgrst.object+json");
    const fixtureResponse = candidateFixtureResponse(requestMethod, url, objectResponse);
    if (fixtureResponse) {
      sendJson(request, response, fixtureResponse.status, fixtureResponse.value, fixtureResponse.count);
      return;
    }
    if (url.pathname === "/rest/v1/users") {
      if (!isReadOnlyTableRequest) {
        rejectMethod("GET, HEAD");
        return;
      }
      sendJson(request, response, 200, objectResponse ? admin : [admin], 1);
      return;
    }
    if (url.pathname === "/rest/v1/user_auth_sessions") {
      if (!isReadOnlyTableRequest) {
        rejectMethod("GET, HEAD");
        return;
      }
      const row = { user_id: admin.id, session_id: sessionId, revoked_at: null, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
      sendJson(request, response, 200, objectResponse ? row : [row], 1);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/rpc/") && requestMethod !== "POST") {
      rejectMethod("POST");
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
    if (url.pathname === "/rest/v1/rpc/read_member_permission_snapshot") {
      sendJson(request, response, 200, {
        role: "admin",
        authority_status: "ready",
        integrity_valid: true,
        feature_navigation_keys: CANDIDATE_FEATURE_NAVIGATION_KEYS,
        agent_navigation_keys: CANDIDATE_AGENT_NAVIGATION_KEYS,
        revision: 1,
        checksum: "candidate-read-only",
        source_profile_key: "candidate-release",
        source_profile_version: 1,
        updated_at: new Date().toISOString(),
        updated_by: admin.id,
        reason: "isolated candidate browser acceptance",
      });
      return;
    }
    if (url.pathname === "/rest/v1/rpc/read_extraction_account_history"
      || url.pathname === "/rest/v1/rpc/read_image_model_publication_state") {
      sendJson(request, response, 200, []);
      return;
    }
    if (url.pathname === "/rest/v1/rpc/recover_llm_credit_reservations_atomic") {
      if (requestMethod !== "POST") {
        rejectMethod("POST");
        return;
      }
      // The production function returns the number of stale holds released.
      // The isolated candidate starts with no holds, so zero is authoritative.
      sendJson(request, response, 200, 0);
      return;
    }
    if (url.pathname === "/rest/v1/rpc/expire_video_submission_confirmations_atomic") {
      if (requestMethod !== "POST") {
        rejectMethod("POST");
        return;
      }
      sendJson(request, response, 200, {
        expired_count: 0,
        protected_dispatch_count: 0,
        task_ids: [],
        charged_yuan: 0,
      });
      return;
    }
    if (url.pathname === "/rest/v1/rpc/append_admin_governance_audit") {
      if (requestMethod !== "POST") {
        rejectMethod("POST");
        return;
      }
      // PostgREST serializes the UUID scalar returned by the production RPC.
      sendJson(request, response, 200, "00000000-0000-4000-8000-000000000002");
      return;
    }
    if (url.pathname === "/rest/v1/diagnostic_logs") {
      if (requestMethod !== "POST") {
        rejectMethod("POST");
        return;
      }
      const row = {
        id: "00000000-0000-4000-8000-000000000003",
        created_at: "2026-01-01T00:00:00.000Z",
      };
      sendJson(request, response, 201, objectResponse ? row : [row], 1);
      return;
    }
    if (url.pathname === "/rest/v1/product_usage_events"
      || url.pathname === "/rest/v1/operation_flight_events") {
      if (requestMethod !== "POST") {
        rejectMethod("POST");
        return;
      }
      sendJson(request, response, 201, []);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const rpcName = url.pathname.slice("/rest/v1/rpc/".length);
      if (!rpcName.startsWith("read_")) {
        rejectMethod("POST");
        return;
      }
      sendJson(request, response, 200, {});
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      if (!isReadOnlyTableRequest) {
        rejectMethod("GET, HEAD");
        return;
      }
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

function materializeCandidateBrowserAssets(checkoutRoot, publicRoot, candidatePublicRoot, assetManifest) {
  const manifestEntries = new Map(assetManifest.files.map((entry) => [entry.path, entry]));
  const materialized = [];
  const checkoutRealRoot = fs.realpathSync(checkoutRoot);
  const fixtureRootPath = path.join(checkoutRoot, CANDIDATE_BROWSER_ASSET_FIXTURE_ROOT);
  const fixtureRootStats = fs.lstatSync(fixtureRootPath);
  if (!fixtureRootStats.isDirectory() || fixtureRootStats.isSymbolicLink()) fail("BROWSER_ASSET_FIXTURE_ROOT_UNSAFE");
  const fixtureRealRoot = fs.realpathSync(fixtureRootPath);
  for (const expected of CANDIDATE_BROWSER_ASSETS) {
    const logical = canonicalArtifactPath(expected.path);
    if (logical !== expected.path || !expected.fixturePath.startsWith(`${CANDIDATE_BROWSER_ASSET_FIXTURE_ROOT}/`) || !/^[a-z0-9-]+\.(?:webp|json|vtt)$/u.test(expected.fixturePath.slice(CANDIDATE_BROWSER_ASSET_FIXTURE_ROOT.length + 1))) {
      fail("BROWSER_ASSET_MAPPING_INVALID", logical);
    }
    const entry = manifestEntries.get(logical);
    if (!entry) fail("BROWSER_ASSET_MANIFEST_ENTRY_MISSING", logical);
    if (entry.bytes !== expected.bytes || entry.sha256 !== expected.sha256) fail("BROWSER_ASSET_MANIFEST_ENTRY_MISMATCH", logical);
    const publicRelative = logical.replace(/^public\//u, "");
    if (publicRelative === logical) fail("BROWSER_ASSET_PATH_INVALID", logical);
    if (`/${publicRelative}` !== expected.urlPath) fail("BROWSER_ASSET_URL_MAPPING_INVALID", logical);
    const tracked = run("git", ["-C", checkoutRoot, "ls-files", "--error-unmatch", "--", expected.fixturePath], {
      code: "BROWSER_ASSET_FIXTURE_NOT_TRACKED",
    }).trim();
    if (tracked !== expected.fixturePath) fail("BROWSER_ASSET_FIXTURE_NOT_TRACKED", expected.fixturePath);
    const sourcePath = path.join(checkoutRoot, ...expected.fixturePath.split("/"));
    const sourceStats = fs.lstatSync(sourcePath);
    const sourceRealPath = fs.realpathSync(sourcePath);
    const sourceRelativeToCheckout = path.relative(checkoutRealRoot, sourceRealPath);
    const sourceRelativeToFixture = path.relative(fixtureRealRoot, sourceRealPath).split(path.sep).join("/");
    if (!sourceRelativeToCheckout || sourceRelativeToCheckout.startsWith(`..${path.sep}`)
      || path.isAbsolute(sourceRelativeToCheckout) || sourceRelativeToFixture !== expected.fixturePath.slice(CANDIDATE_BROWSER_ASSET_FIXTURE_ROOT.length + 1)
      || !sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.nlink !== 1 || sourceStats.size !== entry.bytes
      || sha256File(sourcePath) !== entry.sha256) fail("BROWSER_ASSET_SOURCE_MISMATCH", logical);
    const destinations = [
      { kind: "external-public-root", root: publicRoot },
      { kind: "web-candidate-static-overlay", root: candidatePublicRoot },
    ];
    for (const destination of destinations) {
      const destinationPath = path.join(destination.root, ...publicRelative.split("/"));
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      const destinationStats = fs.lstatSync(destinationPath);
      if (!destinationStats.isFile() || destinationStats.isSymbolicLink() || destinationStats.size !== entry.bytes
        || sha256File(destinationPath) !== entry.sha256) fail("BROWSER_ASSET_DESTINATION_MISMATCH", `${logical}:${destination.kind}`);
    }
    materialized.push({
      path: logical,
      fixturePath: expected.fixturePath,
      urlPath: expected.urlPath,
      bytes: entry.bytes,
      sha256: entry.sha256,
      contentType: expected.contentType,
      destinations: destinations.map((destination) => destination.kind),
    });
  }
  return materialized;
}

function prepareAssetMetadata(workRoot, checkoutRoot, webPayload, webManifest) {
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
  const materialized = materializeCandidateBrowserAssets(checkoutRoot, publicRoot, path.join(webPayload, "public"), assetManifest);
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
    candidateRuntimeOnly: true,
    activationEligible: false,
    completeAssetSetVerified: false,
    materializedRequiredFileCount: materialized.length,
    verifiedAt: new Date().toISOString(),
  });
  return { publicRoot, manifestSha256, assetManifest, materialized };
}

function seedCandidateVoicePricingCatalog(databasePath) {
  const database = new DatabaseSync(databasePath);
  const rows = [
    ["candidate-seed-tts-2-0", "Doubao-TTS 2.0", "seed-tts-2.0", "seed-tts-2.0", 1, 1000, 1, "千字符", 0, 1, 0],
    ["candidate-seed-icl-2-0", "Doubao-ICL 1.0", "seed-icl-2.0", "seed-icl-2.0", 1, 1000, 1, "千字符", 0, 1, 1],
    ["candidate-seed-audio-1-0", "Seed-Audio 1.0", "seed-audio-1.0", "seed-audio-1.0", 1, 1, 1, "分钟", 0, 1, 2],
  ];
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    const before = database.prepare('SELECT COUNT(*) AS count FROM "ModelConfig"').get();
    if (Number(before.count) !== 0) fail("CANDIDATE_VOICE_PRICING_FIXTURE_NOT_EMPTY");
    const insert = database.prepare('INSERT INTO "ModelConfig" (id,name,modelId,resourceId,apiKey,totalPrice,totalChars,costPrice,unit,profitMargin,isActive,sort,createdAt,updatedAt) VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)');
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) insert.run(...row);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const readback = database.prepare('SELECT id,modelId,apiKey,isActive FROM "ModelConfig" ORDER BY sort,id').all();
    if (readback.length !== rows.length || readback.some((row, index) => (
      row.id !== rows[index][0] || row.modelId !== rows[index][2] || row.apiKey !== null || Number(row.isActive) !== 1
    ))) fail("CANDIDATE_VOICE_PRICING_FIXTURE_INVALID");
    return {
      count: readback.length,
      modelIds: readback.map((row) => row.modelId),
      apiKeyAbsent: readback.every((row) => row.apiKey === null),
      allActive: readback.every((row) => Number(row.isActive) === 1),
    };
  } finally {
    database.close();
  }
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
  const voicePricingFixture = seedCandidateVoicePricingCatalog(voiceDatabase);
  const catalogPath = path.join(discoveryDir, "catalog.json");
  fs.writeFileSync(catalogPath, `${JSON.stringify({ schema: 1, items: [], order: { video: [], image: [], canvas: [] }, homeOrder: { video: [], image: [], canvas: [] } })}\n`, { mode: 0o600 });
  const gatewayKeyPath = path.join(commerceDir, "main-gateway.key");
  fs.writeFileSync(gatewayKeyPath, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
  return { stateRoot, dataDir, runtimeDir, commerceDir, discoveryDir, idempotencyDir, backupDir, uploadDir, referenceAudioDir, voiceDatabase, catalogPath, gatewayKeyPath, voicePricingFixture };
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
    // Candidate processes have no inherited provider credentials and every
    // database/file target below is an isolated local fixture. Keep normal
    // browser writes enabled so telemetry routes exercise their real proxy,
    // authentication, validation, and persistence contracts.
    DEV_READ_ONLY_MODE: "0",
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
    environment.BASE_URL = `http://127.0.0.1:${port}`;
    environment.PRODUCTION_SITE_URL = environment.BASE_URL;
    environment.PRODUCT_USAGE_POLICY_BASIS_CODE = "candidate-browser-acceptance";
    environment.PRODUCT_USAGE_NOTICE_VERSION = "candidate-v1";
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
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid URL]";
  }
}

function utilityRequestDiagnostics(requestUrl) {
  const tabs = requestUrl.searchParams.getAll("tab");
  const reviewedTabs = new Set(["text", "video", "segment", "format"]);
  return {
    pathname: "/tools/utility",
    tab: tabs.length === 1 && reviewedTabs.has(tabs[0]) ? tabs[0] : null,
    rscPresent: requestUrl.searchParams.has("_rsc"),
    otherParametersPresent: [...requestUrl.searchParams.keys()].some((key) => key !== "tab" && key !== "_rsc"),
  };
}

function isReviewedUtilityRscRequest(request, baseUrl) {
  if (!baseUrl || request.method() !== "GET" || request.resourceType() !== "fetch") return false;
  const headers = request.headers();
  if (headers.rsc !== "1" || headers["next-router-prefetch"] !== undefined
    || headers["next-router-segment-prefetch"] !== undefined || headers.purpose === "prefetch"
    || String(headers["sec-purpose"] || "").split(/\s*;\s*/u).includes("prefetch")) return false;
  try {
    const url = new URL(request.url());
    const params = url.searchParams;
    const rsc = params.getAll("_rsc");
    return url.origin === new URL(baseUrl).origin && url.pathname === "/tools/utility"
      && params.getAll("tab").length === 1 && params.get("tab") === "text"
      && rsc.length === 1 && /^[a-z0-9]{1,32}$/u.test(rsc[0])
      && [...params.keys()].every((key) => key === "tab" || key === "_rsc");
  } catch {
    return false;
  }
}

function reviewedUtilityRscIdentity(request, baseUrl) {
  if (!isReviewedUtilityRscRequest(request, baseUrl)) return null;
  const headers = request.headers();
  const state = headers["next-router-state-tree"];
  if (typeof state !== "string" || !state.trim() || state.length > 65_536) return null;
  const routerHeaders = Object.entries(headers)
    .filter(([name]) => name === "rsc" || name.startsWith("next-"))
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  if (routerHeaders.length > 64 || routerHeaders.some(([, value]) => typeof value !== "string" || value.length > 65_536)) return null;
  try {
    // This identity is used only in memory. It must never enter the report.
    return JSON.stringify([new URL(request.url()).href, routerHeaders]);
  } catch {
    return null;
  }
}

function reviewedUtilityAbortSuperseded({ pending, completed, routeFailures, finalUrlMatches, toolVerified }) {
  if (pending.length !== 1 || typeof pending[0].identity !== "string" || !pending[0].identity
    || routeFailures.length || !finalUrlMatches || !toolVerified) return false;
  return completed.some((receipt) => receipt.sequence > pending[0].sequence
    && receipt.identity === pending[0].identity && receipt.status === 200 && receipt.contentType === "text/x-component");
}

function reviewedUtilityAbortEvidence(pending, receipt) {
  return { ...pending.item, failedSequence: pending.sequence,
    subsequentCompletedRsc: { sequence: receipt.sequence, status: receipt.status, contentType: receipt.contentType },
    finalUrlMatches: true, toolVerified: true };
}

function resolveBrowserRouteTarget(route, serviceOrigins) {
  const reviewed = BROWSER_ROUTE_TARGETS[route] || { service: "web", expectedRoute: route };
  const baseUrl = serviceOrigins[reviewed.service];
  return {
    service: reviewed.service,
    baseUrl,
    navigationUrl: baseUrl ? new URL(reviewed.navigationRoute || route, baseUrl) : null,
    expectedUrl: baseUrl ? new URL(reviewed.expectedRoute, baseUrl) : null,
    expectedTool: reviewed.expectedTool || null,
  };
}

function matchesReviewedRoute(actualUrl, expectedUrl) {
  return actualUrl.origin === expectedUrl.origin
    && actualUrl.pathname === expectedUrl.pathname
    && actualUrl.search === expectedUrl.search;
}

function resolveBenignNavigationSourceRoute(route) {
  const reviewed = BROWSER_ROUTE_TARGETS[route];
  return reviewed?.service === "web"
    ? new URL(reviewed.expectedRoute, "http://candidate.invalid").pathname
    : route;
}

// Only the two reviewed legacy/default entries below get a tool-specific
// smoke check.  Filling a synthetic value exercises hydration and input state;
// it does not submit a request or invoke a paid provider.
async function verifyReviewedTool(page, expectedTool) {
  if (!expectedTool) return;
  const controls = {
    segment: { root: '[data-page="tools"]', panel: "#tool-panel-segment", tab: "#tool-tab-segment", label: "需要分段的文案" },
    text: { root: '[data-page="tools-utility"]', panel: "#toolbox-active-panel", tab: "#tool-tab-text", label: "文案分享文本或链接" },
  }[expectedTool];
  if (!controls) fail("BROWSER_TOOL_CONTRACT_INVALID");
  const root = page.locator(controls.root);
  const tab = root.locator(controls.tab);
  const panel = root.locator(controls.panel);
  await tab.waitFor({ state: "visible", timeout: 15_000 });
  if (await tab.getAttribute("role") !== "tab" || await tab.getAttribute("aria-selected") !== "true") {
    fail("BROWSER_TOOL_TAB_INVALID", expectedTool);
  }
  await panel.waitFor({ state: "visible", timeout: 15_000 });
  const input = panel.getByRole("textbox", { name: controls.label, exact: true });
  await input.fill("候选验收输入", { timeout: 15_000 });
  await page.waitForTimeout(250);
  if (await input.inputValue() !== "候选验收输入") fail("BROWSER_TOOL_INPUT_INVALID", expectedTool);
  await input.fill("");
  if (await input.inputValue() !== "") fail("BROWSER_TOOL_INPUT_CLEAR_FAILED", expectedTool);
}

async function verifyHelpCaptions(page) {
  const track = page.locator('track[src="/help/storyboard-video-case.zh-CN.vtt"]');
  if (await track.count() !== 1) fail("BROWSER_HELP_CAPTION_TRACK_MISSING");
  await track.evaluate((element) => { element.track.mode = "hidden"; });
  await page.waitForFunction(() => {
    const element = document.querySelector('track[src="/help/storyboard-video-case.zh-CN.vtt"]');
    return element?.readyState === 2 && element.track.cues && element.track.cues.length > 0;
  }, null, { timeout: 15_000 });
}

async function verifyPublishedPreviewProductionDenial(request, webOrigin) {
  const origin = new URL(webOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) fail("BROWSER_LOCAL_PREVIEW_ORIGIN_INVALID");
  const target = new URL("/published-preview?format=json", origin).toString();
  const response = await request.get(target, { failOnStatusCode: false, timeout: 12_000, maxRedirects: 0 });
  try {
    const headers = response.headers();
    if (response.status() !== 404 || response.url() !== target || headers.location || headers["set-cookie"]
      || !/^application\/json(?:\s*;|$)/iu.test(headers["content-type"] || "")
      || !/(?:^|,)\s*no-store\s*(?:,|$)/iu.test(headers["cache-control"] || "")) {
      fail("BROWSER_LOCAL_PREVIEW_DENIAL_INVALID");
    }
    const bytes = await response.body();
    if (bytes.length > 1024) fail("BROWSER_LOCAL_PREVIEW_DENIAL_BODY_INVALID");
    let body;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { fail("BROWSER_LOCAL_PREVIEW_DENIAL_BODY_INVALID"); }
    if (!body || Object.keys(body).join(",") !== "code" || body.code !== "FORMAL_PREVIEW_LOCAL_ONLY") {
      fail("BROWSER_LOCAL_PREVIEW_DENIAL_BODY_INVALID");
    }
    return { route: "/published-preview?format=json", method: "GET", status: 404,
      code: body.code, cacheControl: headers["cache-control"], result: "passed" };
  } finally { await response.dispose(); }
}

async function runBrowserAcceptance(serviceOrigins, routes, screenshotRoot, authToken, authUser, requiredAssets, publishedPreviewExpected) {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block", reducedMotion: "reduce" });
  const cookieOrigins = [...new Set(Object.values(serviceOrigins).filter(Boolean))];
  await context.addCookies(cookieOrigins.map((url) => ({
    name: "auth_token",
    value: authToken,
    url,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1000) + 60 * 60,
  })));
  await context.addInitScript(({ token, user }) => {
    window.localStorage.setItem("auth_token", token);
    window.localStorage.setItem("auth_user", JSON.stringify(user));
    window.sessionStorage.setItem("entered_app", "1");
  }, { token: authToken, user: authUser });
  const results = [];
  const blockingFailures = [];
  const consoleErrors = [];
  const requestFailures = [];
  const nonBlockingHttpErrors = [];
  const benignNavigationAborts = [];
  const reviewedUtilityNavigationAborts = [];
  const requiredAssetResponses = [];
  const localOnlyEntryChecks = [];
  try {
    if (publishedPreviewExpected) {
      try { localOnlyEntryChecks.push(await verifyPublishedPreviewProductionDenial(context.request, serviceOrigins.web)); }
      catch { blockingFailures.push({ route: "/published-preview?format=json", code: "BROWSER_LOCAL_PREVIEW_DENIAL_FAILED" }); }
    }
    for (const asset of requiredAssets) {
      const assetUrl = new URL(asset.urlPath, serviceOrigins.web).toString();
      try {
        const response = await context.request.get(assetUrl, { failOnStatusCode: false, timeout: 30_000 });
        const body = await response.body();
        const contentType = String(response.headers()["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        const receipt = {
          path: asset.path,
          urlPath: asset.urlPath,
          status: response.status(),
          contentType,
          bytes: body.length,
          sha256: sha256(body),
        };
        requiredAssetResponses.push(receipt);
        await response.dispose();
        if (receipt.status !== 200 || contentType !== asset.contentType
          || receipt.bytes !== asset.bytes || receipt.sha256 !== asset.sha256) {
          blockingFailures.push({ route: asset.urlPath, code: "BROWSER_REQUIRED_ASSET_INVALID", detail: JSON.stringify(receipt) });
        }
      } catch (error) {
        const detail = `${asset.urlPath}:${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
        requiredAssetResponses.push({ path: asset.path, urlPath: asset.urlPath, status: null, contentType: "", bytes: null, sha256: null, error: detail });
        blockingFailures.push({ route: asset.urlPath, code: "BROWSER_REQUIRED_ASSET_REQUEST_FAILED", detail });
      }
    }
    for (const [index, route] of routes.entries()) {
      const page = await context.newPage();
      const target = resolveBrowserRouteTarget(route, serviceOrigins);
      const routeFailures = [];
      let responseStatus = null;
      let finalPath = "";
      let finalSearch = "";
      let title = "";
      let bodyText = "";
      let screenshot = "";
      const startedAt = Date.now();
      const requestStartedAt = new WeakMap();
      let pagePhase = "navigating";
      let requestSequence = 0;
      let finalUrlMatches = false;
      let toolVerified = false;
      const utilityPendingAborts = [];
      const utilityCompletedPromises = [];
      page.setDefaultTimeout(30_000);
      page.on("request", (request) => requestStartedAt.set(request, Date.now()));
      page.on("requestfinished", (request) => {
        if (route !== "/tools/utility" || pagePhase !== "checking") return;
        const identity = reviewedUtilityRscIdentity(request, target.baseUrl);
        if (!identity) return;
        const sequence = ++requestSequence;
        utilityCompletedPromises.push(request.response().then((response) => ({
          sequence,
          identity,
          status: response?.status() ?? null,
          contentType: String(response?.headers()["content-type"] || "").split(";", 1)[0].trim().toLowerCase(),
        })).catch(() => ({ sequence, identity, status: null, contentType: "" })));
      });
      page.on("console", (message) => {
        const text = message.text();
        // Chromium duplicates HTTP failures as URL-less console messages.
        // The response/request listeners below retain the URL, resource type,
        // origin, status, and abort reason and are the authoritative gate.
        if (message.type() === "error" && !NETWORK_CONSOLE_ERROR.test(text)) {
          consoleErrors.push({ route, text: text.slice(0, 1000) });
        }
      });
      page.on("pageerror", (error) => consoleErrors.push({ route, text: `${error.name}:${error.message}`.slice(0, 1000) }));
      page.on("requestfailed", (request) => {
        const resourceType = request.resourceType();
        const error = request.failure()?.errorText || "requestfailed";
        const requestHeaders = request.headers();
        const nextRouterPrefetch = /^[12]$/u.test(requestHeaders["next-router-prefetch"] || "")
          || typeof requestHeaders["next-router-segment-prefetch"] === "string"
          || requestHeaders.purpose === "prefetch"
          || String(requestHeaders["sec-purpose"] || "").split(/\s*;\s*/u).includes("prefetch");
        let sameOrigin = false;
        let pathname = "";
        let utilityDiagnostics = null;
        try {
          const requestUrl = new URL(request.url());
          sameOrigin = Boolean(target.baseUrl) && requestUrl.origin === new URL(target.baseUrl).origin;
          pathname = requestUrl.pathname;
          if (sameOrigin && route === "/tools/utility" && pathname === "/tools/utility") {
            utilityDiagnostics = utilityRequestDiagnostics(requestUrl);
          }
        } catch {
          sameOrigin = false;
        }
        const item = {
          route,
          method: request.method(),
          resourceType,
          sameOrigin,
          nextRouterPrefetch,
          url: cleanUrl(request.url()),
          error,
        };
        if (utilityDiagnostics) {
          item.utilityDiagnostics = utilityDiagnostics;
          item.pagePhase = pagePhase;
          item.elapsedMs = Date.now() - startedAt;
          item.requestDurationMs = requestStartedAt.has(request) ? Date.now() - requestStartedAt.get(request) : null;
        }
        const benignNavigationKey = `${resolveBenignNavigationSourceRoute(route)}|${pathname}`;
        const utilityIdentity = route === "/tools/utility" && pagePhase === "checking" && error === "net::ERR_ABORTED"
          ? reviewedUtilityRscIdentity(request, target.baseUrl) : null;
        if (sameOrigin && item.method === "GET" && resourceType === "fetch" && error === "net::ERR_ABORTED"
          && nextRouterPrefetch && BENIGN_NAVIGATION_ABORT_KEYS.has(benignNavigationKey)) {
          benignNavigationAborts.push(item);
        } else if (utilityIdentity) {
          utilityPendingAborts.push({ item, sequence: ++requestSequence, identity: utilityIdentity });
        } else {
          requestFailures.push(item);
        }
      });
      page.on("response", (response) => {
        if (response.status() < 400) return;
        const request = response.request();
        let sameOrigin = false;
        let pathname = "";
        try {
          const responseUrl = new URL(response.url());
          sameOrigin = Boolean(target.baseUrl) && responseUrl.origin === new URL(target.baseUrl).origin;
          pathname = responseUrl.pathname;
        } catch {
          sameOrigin = false;
        }
        const item = {
          route,
          method: request.method(),
          status: response.status(),
          resourceType: request.resourceType(),
          sameOrigin,
          url: cleanUrl(response.url()),
        };
        // Every same-origin HTTP failure is release-blocking, including images,
        // fonts, media, and non-API fetches. This keeps the URL-less Chromium
        // console duplicate filter above safe because the response listener
        // remains the authoritative, URL-aware gate for candidate resources.
        if (sameOrigin || ["document", "script", "stylesheet"].includes(request.resourceType())) requestFailures.push(item);
        else nonBlockingHttpErrors.push(item);
      });
      try {
        if (!target.navigationUrl || !target.expectedUrl) {
          fail("BROWSER_ROUTE_SERVICE_UNAVAILABLE", `${route}:${target.service}`);
        }
        const response = await page.goto(target.navigationUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
        pagePhase = "checking";
        responseStatus = response?.status() ?? null;
        await page.waitForTimeout(1_500);
        const finalUrl = new URL(page.url());
        finalPath = finalUrl.pathname;
        finalSearch = finalUrl.search;
        if (!response || responseStatus >= 400) {
          routeFailures.push({ code: "BROWSER_DOCUMENT_HTTP_FAILED", detail: `${route}:${responseStatus ?? "no-response"}` });
        }
        finalUrlMatches = matchesReviewedRoute(finalUrl, target.expectedUrl);
        if (!finalUrlMatches) {
          routeFailures.push({ code: "BROWSER_ROUTE_REDIRECTED", detail: `${route}:${finalPath}${finalSearch}` });
        } else {
          await verifyReviewedTool(page, target.expectedTool);
          if (route === "/tools/utility") toolVerified = target.expectedTool === "text";
          if (route === "/help") await verifyHelpCaptions(page);
        }
        const body = page.locator("body");
        await body.waitFor({ state: "visible" });
        bodyText = (await body.innerText()).trim();
        if (bodyText.length < 20 || /Application error|Internal Server Error|This page could not be found/iu.test(bodyText)) {
          routeFailures.push({ code: "BROWSER_PAGE_RENDER_INVALID", detail: `${route}:${bodyText.slice(0, 200)}` });
        }
        title = await page.title();
      } catch (error) {
        routeFailures.push({
          code: "BROWSER_ROUTE_EXECUTION_FAILED",
          detail: `${route}:${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
        });
      }
      screenshot = path.join(screenshotRoot, routeFileName(route, index));
      try {
        await page.screenshot({ path: screenshot, fullPage: false, animations: "disabled" });
      } catch (error) {
        routeFailures.push({
          code: "BROWSER_SCREENSHOT_FAILED",
          detail: `${route}:${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
        });
        screenshot = "";
      }
      blockingFailures.push(...routeFailures.map((failure) => ({ route, ...failure })));
      results.push({
        route,
        service: target.service,
        finalPath,
        finalSearch,
        status: responseStatus,
        title,
        visibleTextCharacters: bodyText.length,
        elapsedMs: Date.now() - startedAt,
        screenshot: screenshot ? path.basename(screenshot) : null,
        screenshotSha256: screenshot ? sha256File(screenshot) : null,
        failures: routeFailures,
      });
      pagePhase = "closing";
      await page.close();
      if (utilityPendingAborts.length) {
        const completed = await Promise.all(utilityCompletedPromises);
        if (reviewedUtilityAbortSuperseded({ pending: utilityPendingAborts, completed, routeFailures, finalUrlMatches, toolVerified })) {
          const receipt = completed.find((entry) => entry.sequence > utilityPendingAborts[0].sequence
            && entry.identity === utilityPendingAborts[0].identity
            && entry.status === 200 && entry.contentType === "text/x-component");
          reviewedUtilityNavigationAborts.push(reviewedUtilityAbortEvidence(utilityPendingAborts[0], receipt));
        } else {
          requestFailures.push(...utilityPendingAborts.map(({ item }) => item));
        }
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return { routes: results, blockingFailures, consoleErrors, requestFailures, nonBlockingHttpErrors, benignNavigationAborts, reviewedUtilityNavigationAborts, requiredAssetResponses, localOnlyEntryChecks };
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
      controlPlane: bundle.subject.controlPlane,
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
  // Observe the executable checkout, then reject provenance drift before output creation or secret access.
  const toolchainCommit = run("git", ["-C", checkoutRoot, "rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(toolchainCommit)) fail("TOOLCHAIN_COMMIT_INVALID");
  const eventCommit = process.env.GITHUB_SHA;
  const candidateRunId = process.env.CANDIDATE_RUN_ID;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = readJson(process.env.GITHUB_EVENT_PATH, "ACCEPTANCE_EVENT_INVALID");
  const candidateRun = readJson(process.env.ACCEPTANCE_CANDIDATE_RUN_PATH, "CANDIDATE_RUN_INVALID");
  const policy = readJson(path.join(checkoutRoot, "deploy/policies/release-policy.json"), "RELEASE_POLICY_INVALID");
  const provenanceOptions = { primaryRepository: policy.git?.primaryRepository, runId: candidateRunId, toolchainSha: toolchainCommit, eventCommit };
  const candidateCommit = validateRun(candidateRun, { ...provenanceOptions, kind: "candidate", automatic: eventName === "workflow_run" });
  if (eventName === "workflow_run") validateAutomaticTrigger(event, candidateRun, provenanceOptions);
  else {
    run("git", ["-C", checkoutRoot, "merge-base", "--is-ancestor", candidateCommit, toolchainCommit]);
    const changedPaths = run("git", ["-C", checkoutRoot, "diff", "--name-only", "-z", `${candidateCommit}..${toolchainCommit}`]).split("\0").filter(Boolean);
    validateAcceptanceExecution({ eventName, executedCommit: toolchainCommit, eventCommit, candidateCommit, candidateAncestor: true, changedPaths });
  }
  const bundle = readJson(path.join(candidateRoot, "release-change-validations.json"), "CANDIDATE_BUNDLE_INVALID");
  // Bind and read the entire candidate control package before output or signing-key access.
  verifyCandidatePackage(path.join(candidateRoot, "candidate-packages", "control-plane"), bundle.subject.controlPlane, candidateRun, process.env.GITHUB_REPOSITORY);
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
  const expectedSubjectCommit = candidateCommit;
  if (bundle.target !== "source-candidate" || bundle.status !== "source-candidate-pending-required"
    || bundle.subject.commit !== expectedSubjectCommit
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
  const assets = prepareAssetMetadata(workRoot, checkoutRoot, extracted.web.payloadRoot, extracted.web.manifest);
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
    const authUser = {
      id: databaseFixture.admin.id,
      username: databaseFixture.admin.username,
      displayName: databaseFixture.admin.display_name,
      phone: "",
      email: databaseFixture.admin.email,
      avatarUrl: "",
      role: databaseFixture.admin.role,
      credits: databaseFixture.admin.credits,
      reservedCredits: databaseFixture.admin.credits_reserved,
      is_active: databaseFixture.admin.is_active,
      allowedCategories: null,
      memberStatus: databaseFixture.admin.member_status,
      themePreference: null,
      themeModePreference: null,
      themePreferenceExpiresAt: null,
      themePreferenceStatus: "absent",
      hasPassword: true,
      status: databaseFixture.admin.status,
    };
    for (const service of bundle.subject.services) {
      processes[service] = startCandidate(extracted[service].payloadRoot, extracted[service].manifest, states[service], assets, ports[service], service, reportRoot, acceptance);
    }
    runtimeReadbacks = {};
    for (const service of bundle.subject.services) {
      const readinessPath = extracted[service].manifest.readinessPath;
      runtimeReadbacks[service] = await waitForReadiness(`http://127.0.0.1:${ports[service]}${readinessPath}`, extracted[service].manifest, service);
    }
    // This entry belongs to local 5000 only. Keep normal production routes strict
    // and test its production refusal separately against the same packaged Web.
    const publishedPreviewExpected = fs.existsSync(path.join(checkoutRoot, "src", "app", "published-preview", "route.ts"));
    if (publishedPreviewExpected && !fs.existsSync(path.join(extracted.web.payloadRoot, ".next", "server", "app", "published-preview", "route.js"))) {
      fail("BROWSER_LOCAL_PREVIEW_ENTRY_NOT_PACKAGED");
    }
    browserReport = await runBrowserAcceptance({
      web: `http://127.0.0.1:${ports.web}`,
      voice: ports.voice ? `http://127.0.0.1:${ports.voice}` : null,
    }, routes, screenshotRoot, authToken, authUser, assets.materialized, publishedPreviewExpected);
  } finally {
    await Promise.all(Object.values(processes).map((entry) => stopChild(entry.child)));
    await stopFixtureServer(databaseFixture?.server);
  }

  const databaseMethodsAndPaths = [...new Set(databaseFixture.requests.map((entry) => `${entry.method} ${entry.path}`))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const requiredIsolatedWrites = [
    "POST /rest/v1/rpc/expire_video_submission_confirmations_atomic",
    "POST /rest/v1/rpc/recover_llm_credit_reservations_atomic",
    "POST /rest/v1/product_usage_events",
  ];
  const missingRequiredIsolatedWrites = requiredIsolatedWrites.filter((entry) => !databaseMethodsAndPaths.includes(entry));

  const report = {
    schemaVersion: "zimeiti-release-browser-acceptance-report.v1",
    checkedAt: new Date().toISOString(),
    candidateBundleId: bundle.bundleId,
    toolchain: {
      commit: toolchainCommit,
      executedCommit: toolchainCommit,
      eventCommit,
      candidateCommit,
      candidateRunId,
      fixturePaths: assets.materialized.map((asset) => asset.fixturePath),
    },
    subject: bundle.subject,
    viewport: VIEWPORT,
    runtimeReadbacks,
    routes: browserReport.routes,
    blockingFailures: browserReport.blockingFailures,
    consoleErrors: browserReport.consoleErrors,
    requestFailures: browserReport.requestFailures,
    nonBlockingHttpErrors: browserReport.nonBlockingHttpErrors,
    benignNavigationAborts: browserReport.benignNavigationAborts,
    reviewedUtilityNavigationAborts: browserReport.reviewedUtilityNavigationAborts,
    requiredAssetResponses: browserReport.requiredAssetResponses,
    localOnlyEntryChecks: browserReport.localOnlyEntryChecks,
    assetFixture: {
      localOnly: true,
      source: "git-tracked-verifier-fixture-bound-to-candidate-asset-manifest",
      overlayOnly: true,
      activationEligible: false,
      completeAssetSetVerified: false,
      candidateArchiveSha256: bundle.subject.candidatePayloads.web.archiveSha256,
      candidateAssetManifestSha256: assets.manifestSha256,
      candidateAssetDigest: assets.assetManifest.digest,
      materialized: assets.materialized,
    },
    voicePricingFixtures: Object.fromEntries(Object.entries(states).map(([service, state]) => [service, state.voicePricingFixture])),
    databaseFixture: {
      localOnly: true,
      requestCount: databaseFixture.requests.length,
      methodsAndPaths: databaseMethodsAndPaths,
      requiredIsolatedWrites,
      missingRequiredIsolatedWrites,
      paths: [...new Set(databaseFixture.requests.map((entry) => entry.path))].sort((left, right) => left.localeCompare(right, "en")),
    },
    result: missingRequiredIsolatedWrites.length || browserReport.blockingFailures.length
      || browserReport.consoleErrors.length || browserReport.requestFailures.length
      ? "failed"
      : "passed",
  };
  const reportPath = path.join(reportRoot, "browser-acceptance-report.json");
  writeJson(reportPath, report);
  if (missingRequiredIsolatedWrites.length) {
    fail("CANDIDATE_DATABASE_FIXTURE_WRITE_MISSING", missingRequiredIsolatedWrites.join(","));
  }
  if (browserReport.blockingFailures.length) fail("BROWSER_ROUTE_FAILURES", JSON.stringify(browserReport.blockingFailures.slice(0, 25)));
  if (browserReport.consoleErrors.length) fail("BROWSER_CONSOLE_ERRORS", JSON.stringify(browserReport.consoleErrors.slice(0, 25)));
  if (browserReport.requestFailures.length) fail("BROWSER_REQUEST_FAILURES", JSON.stringify(browserReport.requestFailures.slice(0, 25)));
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
