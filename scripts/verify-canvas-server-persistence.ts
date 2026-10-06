import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const route = readFileSync(resolve(root, "src/app/api/canvas/route.ts"), "utf8");
const component = readFileSync(resolve(root, "src/components/manual-canvas.tsx"), "utf8");
const migration = readFileSync(resolve(root, "supabase/migrations/20260825170854_canvas_server_persistence.sql"), "utf8");
const rollback = readFileSync(resolve(root, "supabase/rollbacks/20260825170854_canvas_server_persistence.rollback.sql"), "utf8");

const checks: Record<string, boolean> = {
  rootApiAuthenticates: /requireUser\(request\)/u.test(route) && /status: 401/u.test(route),
  readsAreOwnerScoped: /\.eq\("owner_id", ownerId\)/u.test(route) && /\.eq\("owner_id", user\.userId\)/u.test(route),
  listAndDetailExist: /includeDocuments/u.test(route) && /searchParams\.get\("canvasId"\)/u.test(route),
  saveAndCopyExist: /action: z\.literal\("save"\)/u.test(route) && /action: z\.literal\("copy"\)/u.test(route),
  casIsAtomic: /CANVAS_REVISION_CONFLICT/u.test(migration) && /for update;/u.test(migration),
  idempotencyIsReservedFirst: /insert into public\.canvas_document_requests[\s\S]+on conflict[\s\S]+for update;/u.test(migration),
  stableMediaOnly: /CANVAS_EMBEDDED_MEDIA_FORBIDDEN/u.test(route) && /CANVAS_TEMPORARY_MEDIA_FORBIDDEN/u.test(route),
  ownerAssetReadback: /\.from\("user_files"\)[\s\S]+\.eq\("user_id", ownerId\)/u.test(route),
  readResignsAssets: /storageManager\.getSignedUrl/u.test(route) && /expireTime: 60 \* 60/u.test(route),
  stableObjectUri: /object:\/\//u.test(route) && /app-public:\/\//u.test(route),
  serviceRoleFailsClosed: /CANVAS_SERVICE_ROLE_MISSING/u.test(route) && /grant execute[\s\S]+service_role/u.test(migration),
  viewportIsServerPersisted: /viewport: ViewportSchema/u.test(route) && /onMoveEnd=/u.test(component),
  executionStateIsServerPersisted: /runHistory: z\.array/u.test(route) && /diagnostics: z\.array/u.test(route),
  fingerprintUsesStableMediaRefs: /stableCanvasMediaIdentity/u.test(component) && /imageRefs:/u.test(component) && /audioRefs:/u.test(component),
  migrationHasRls: /enable row level security/u.test(migration) && /auth\.uid\(\)::text/u.test(migration),
  rollbackIsDedicated: /drop function if exists public\.save_canvas_document_atomic/u.test(rollback) && /drop table if exists public\.canvas_documents/u.test(rollback),
  noCanvasSessionLocalWrites: !/localStorage\.setItem\(canvasSessionsStorageKey/u.test(component),
  noGraphLocalWrites: !/localStorage\.setItem\(graphStorageKey/u.test(component),
  noRunHistoryLocalWrites: !/localStorage\.setItem\(canvasRunHistoryStorageKey/u.test(component),
  clientUsesCanvasApi: /fetch\("\/api\/canvas/u.test(component),
};

async function main() {
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `${name} failed`);
  const api = await import("../src/app/api/canvas/route");
  const unauthorizedGet = await api.GET(new Request("http://canvas.local/api/canvas"));
  const unauthorizedPost = await api.POST(new Request("http://canvas.local/api/canvas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  const unauthorizedDelete = await api.DELETE(new Request("http://canvas.local/api/canvas", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  const runtimeChecks = {
    anonymousGetIs401: unauthorizedGet.status === 401,
    anonymousPostIs401: unauthorizedPost.status === 401,
    anonymousDeleteIs401: unauthorizedDelete.status === 401,
  };
  for (const [name, passed] of Object.entries(runtimeChecks)) assert.equal(passed, true, `${name} failed`);
  const allChecks = { ...checks, ...runtimeChecks };
  console.log(JSON.stringify({ ok: true, checks: allChecks, trueChecks: Object.values(allChecks).filter(Boolean).length }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
