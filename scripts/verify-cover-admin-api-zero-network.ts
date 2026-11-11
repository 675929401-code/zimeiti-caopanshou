import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import * as metadata from "../src/lib/cover-style-catalog";
import * as config from "../src/lib/server/cover-style-config";
import * as defaults from "../src/lib/server/cover-style-defaults";
import { readCoverRequestJson, CoverRequestBodyError } from "../src/lib/server/cover-request-body";
import { adminRequirementForRequest } from "../src/lib/admin-governance";

let networkCalls = 0;
const forbidden = (): never => { networkCalls++; throw new Error("NETWORK_DATABASE_PROVIDER_FORBIDDEN"); };
const originalFetch = globalThis.fetch;
globalThis.fetch = forbidden;
const checks: string[] = [];
const check = async (name: string, run: () => unknown) => { await run(); checks.push(name); };
function load(file: string, imports: Record<string, unknown>): Record<string, unknown> {
  const moduleContainer = { exports: {} };
  const source = ts.transpileModule(readFileSync(file, "utf8"), { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(source.outputText, { module: moduleContainer, exports: moduleContainer.exports, Buffer, URL, Request, Response, console, structuredClone, fetch: forbidden,
    require(id: string) { assert.ok(Object.hasOwn(imports, id), `Unapproved import ${id}`); return imports[id]; } }, { filename: file });
  return moduleContainer.exports;
}
const validatedModels: config.CoverWorkflowDraftInput[] = [];
let rejectModel = false;
const store = load("src/lib/server/cover-style-store.ts", {
  "server-only": {}, "node:crypto": crypto, zod: { z }, "../cover-style-catalog": metadata,
  "@/storage/database/supabase-client": { getSupabaseAdminClient: forbidden },
  "./cover-style-defaults": defaults, "./cover-style-config": config,
  "./cover-workflow-publication": { validateCoverWorkflowPublication: () => undefined },
  "./cover-admin-runtime": { validateCoverWorkflowModels: async (input: unknown) => {
    const parsed = config.CoverWorkflowDraftInputSchema.parse(input); validatedModels.push(parsed);
    if (rejectModel) throw new config.CoverStyleStoreError("COVER_ANALYSIS_CONFIGURED_MODEL_UNAVAILABLE", "fixture configured model unavailable", 422);
  } },
}) as unknown as typeof import("../src/lib/server/cover-style-store");
type Row = { id: string; setting_key: string; setting_value: string; updated_at: string | null };
class MemoryDb {
  row: Row | null = null; writes = 0; reads = 0; failRead = false; failReadback = false;
  from(table: string) {
    assert.equal(table, "platform_settings");
    let operation = "read", payload: Partial<Row> = {}; const filters: Array<[string, unknown]> = [];
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      insert: (value: Partial<Row>) => { operation = "insert"; payload = value; return query; },
      update: (value: Partial<Row>) => { operation = "update"; payload = value; return query; },
      maybeSingle: async () => {
        if (operation === "read") { this.reads++; return this.failRead || this.failReadback && this.writes ? { data: null, error: { code: "fixture" } } : { data: this.row ? structuredClone(this.row) : null, error: null }; }
        this.writes++;
        if (operation === "insert" && this.row) return { data: null, error: { code: "23505" } };
        if (operation === "update" && (!this.row || filters.some(([key, value]) => this.row![key as keyof Row] !== value))) return { data: null, error: null };
        this.row = { id: this.row?.id ?? "fixture-row", ...this.row, ...payload } as Row;
        return { data: structuredClone(this.row), error: null };
      } };
    return query;
  }
  client() { return this as unknown as Parameters<typeof store.loadCoverStyleCatalog>[0]; }
}
type Role = "anonymous" | "member" | "no-prompts" | "locked" | "viewer" | "editor";
let role: Role = "anonymous", database = new MemoryDb(), optionFailure = false, mutations = 0, previews = 0, optionReads = 0;
const admissions: Array<{ permission: string; requireStepUp: boolean }> = [];
const sentinel = "PRIVATE_COVER_API_FIXTURE_RULE";
const previewInput = z.object({ mode: z.enum(["script", "product", "reference", "compose"]), text: z.string().max(20_000).optional() }).strict();
const route = load("src/app/api/admin/cover-styles/route.ts", {
  "next/server": { NextResponse: { json: Response.json.bind(Response) } },
  "@/lib/server/admin-governance-authority": { authorizeAdminCapability: async (_request: unknown, permission: string, options: { requireStepUp: boolean }) => {
    admissions.push({ permission, requireStepUp: options.requireStepUp });
    const status = role === "anonymous" ? 401 : role === "member" || role === "no-prompts" || role === "viewer" && permission !== "prompts.view" ? 403 : role === "locked" ? 428 : 0;
    return status ? { ok: false, response: Response.json({ error: "fixture denied" }, { status }) } : { ok: true, actor: { userId: "fixture-admin" } };
  } },
  "@/lib/server/cover-request-body": { readCoverRequestJson, CoverRequestBodyError },
  "@/lib/server/cover-style-config": config,
  "@/lib/server/cover-style-store": { ...store,
    loadCoverStyleCatalog: () => store.loadCoverStyleCatalog(database.client()),
    mutateCoverStyleCatalog: async (actor: string, body: unknown) => { mutations++; return store.mutateCoverStyleCatalog(actor, body, database.client()); },
  },
  "@/lib/server/cover-admin-runtime": {
    readCoverAnalysisModelOptions: async () => { optionReads++; if (optionFailure) throw new Error("fixture option read unavailable"); return [{ id: "11111111-1111-4111-8111-111111111111", displayName: "Fixture model", imageParsing: true, available: true }]; },
    previewCoverAnalysisRuntime: async (input: unknown) => {
      const parsed = previewInput.safeParse(input); if (!parsed.success) throw new config.CoverStyleStoreError("COVER_ADMIN_PREVIEW_INPUT_INVALID", "fixture invalid preview", 400);
      previews++; return { systemPrompt: sentinel, userMessage: parsed.data.text ?? "", mode: parsed.data.mode, model: { id: null, displayName: "Fixture model", source: "automatic", available: true }, styleApplied: parsed.data.mode === "script", readonlyProtocolVersion: "fixture/1", textUnits: sentinel.length };
    },
  },
}) as unknown as { GET(request: Request & { nextUrl: URL }): Promise<Response>; POST(request: Request): Promise<Response> };
function request(body?: unknown, query = "") {
  const url = new URL(`https://fixture.invalid/api/admin/cover-styles${query}`);
  return Object.assign(new Request(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { nextUrl: url });
}
function noncache(response: Response) { assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0"); }
async function mutation(action: Record<string, unknown>) {
  const before = await store.loadCoverStyleCatalog(database.client());
  return { expectedRevision: before.catalog.revision, expectedHash: before.hash, ...action };
}
const workflowDraft = { sharedRules: sentinel, textModelId: "11111111-1111-4111-8111-111111111111", imageModelId: null };

async function main() {
  try {
    await check("proxy delegates POST action authority to bounded route; GET remains protected", () => {
      assert.equal(adminRequirementForRequest("/api/admin/cover-styles", "POST"), null);
      assert.equal(adminRequirementForRequest("/api/admin/cover-styles", "GET")?.permission, "prompts.view");
    });
    await check("anonymous/member/insufficient/locked requests cannot read, preview or mutate", async () => {
      for (const candidate of ["anonymous", "member", "no-prompts", "locked"] as const) {
        role = candidate; const touched = [database.reads, database.writes, mutations, previews, optionReads];
        for (const response of [await route.GET(request()), await route.POST(request({ action: "preview", mode: "script" })), await route.POST(request(await mutation({ action: "workflow-draft", draft: workflowDraft })))]) {
          assert.equal(response.status, candidate === "anonymous" ? 401 : candidate === "locked" ? 428 : 403); noncache(response);
          assert.ok(!(await response.text()).includes(sentinel));
        }
        // The fixture mutation() above reads once only to construct a valid CAS body.
        assert.equal(database.reads, touched[0] + 1); assert.deepEqual([database.writes, mutations, previews, optionReads], touched.slice(1));
      }
    });
    await check("view-only admin can read and preview but cannot create a draft", async () => {
      role = "viewer"; const reads = await route.GET(request()); assert.equal(reads.status, 200); noncache(reads);
      const untouched = [database.writes, mutations]; const response = await route.POST(request({ action: "preview", mode: "compose", text: "sample" }));
      assert.equal(response.status, 200); noncache(response); assert.equal((await response.json()).preview.systemPrompt, sentinel);
      const denied = await route.POST(request(await mutation({ action: "workflow-draft", draft: workflowDraft })));
      assert.equal(denied.status, 403); noncache(denied); assert.deepEqual([database.writes, mutations], untouched);
      assert.equal(previews, 1);
    });
    await check("strict preview/body schemas reject extra authority claims, malformed and oversized JSON", async () => {
      role = "editor"; const touched = [database.writes, mutations, previews];
      const extra = await route.POST(request({ action: "preview", mode: "script", actorId: "forged" })); assert.equal(extra.status, 400); noncache(extra);
      const forged = await route.POST(request(await mutation({ action: "workflow-publish", draft: workflowDraft }))); assert.equal(forged.status, 400); noncache(forged);
      const malformed = await route.POST(new Request("https://fixture.invalid", { method: "POST", body: "{" })); assert.equal(malformed.status, 422); noncache(malformed);
      const large = await route.POST(new Request("https://fixture.invalid", { method: "POST", body: "x".repeat(512 * 1024 + 1) })); assert.equal(large.status, 413); noncache(large);
      assert.deepEqual([database.writes, mutations, previews], touched);
    });
    await check("editor draft is not current; publication validates only the server-picked target", async () => {
      role = "editor"; database = new MemoryDb();
      const saved = await route.POST(request(await mutation({ action: "workflow-draft", draft: workflowDraft })));
      assert.equal(saved.status, 200); noncache(saved); const draftDto = await saved.json(); assert.notEqual(draftDto.workflow.current.sharedRules, sentinel);
      const beforePublish = await mutation({ action: "workflow-publish" });
      const stale = await route.POST(request({ ...beforePublish, expectedRevision: -1 })); assert.equal(stale.status, 400); noncache(stale);
      const validationsBefore = validatedModels.length;
      const conflict = await route.POST(request({ ...beforePublish, expectedRevision: 0 })); assert.equal(conflict.status, 409); noncache(conflict); assert.equal(validatedModels.length, validationsBefore);
      rejectModel = true; const writesBefore = database.writes;
      const invalidModel = await route.POST(request(beforePublish)); assert.equal(invalidModel.status, 422); noncache(invalidModel); assert.equal(database.writes, writesBefore);
      assert.deepEqual(JSON.parse(JSON.stringify(validatedModels.at(-1))), workflowDraft);
      rejectModel = false; const published = await route.POST(request(beforePublish)); assert.equal(published.status, 200); noncache(published);
      const active = await published.json(); assert.equal(active.workflow.current.sharedRules, sentinel);
      const rollback = await route.POST(request(await mutation({ action: "workflow-rollback", releaseId: draftDto.workflow.current.releaseId })));
      assert.equal(rollback.status, 200); noncache(rollback); assert.equal((await rollback.json()).workflow.current.releaseId, draftDto.workflow.current.releaseId);
    });
    await check("successful write survives supplemental option-read failure without a duplicate mutation", async () => {
      database = new MemoryDb(); optionFailure = true; const before = mutations;
      const response = await route.POST(request(await mutation({ action: "workflow-draft", draft: workflowDraft })));
      assert.equal(response.status, 200); noncache(response); const data = await response.json(); assert.equal(data.ok, true); assert.equal(data.modelOptionsUnavailable, true);
      assert.equal(mutations, before + 1); assert.equal(database.writes, 1); optionFailure = false;
    });
    await check("unknown write and unavailable read return private safe failures and never retry", async () => {
      database = new MemoryDb(); const input = await mutation({ action: "workflow-draft", draft: workflowDraft }); database.failReadback = true;
      const before = mutations; const unknown = await route.POST(request(input)); assert.equal(unknown.status, 503); noncache(unknown);
      const data = await unknown.json(); assert.equal(data.outcome, "unknown"); assert.equal(data.retryable, false); assert.equal(mutations, before + 1); assert.equal(database.writes, 1);
      database.failRead = true; const response = await route.GET(request()); assert.equal(response.status, 503); noncache(response); assert.ok(!(await response.text()).includes(sentinel));
    });
    assert.ok(admissions.every(admission => admission.requireStepUp)); assert.equal(networkCalls, 0);
    console.log(JSON.stringify({ passed: true, checks: checks.length, cases: checks, networkCalls, realDatabaseCalls: 0, providerCalls: 0,
      boundary: "Real private route, governance classifier, strict schemas and central store with in-memory DB/auth/model guards. Runtime compiler/model validation and live browser acceptance are separate." }, null, 2));
  } finally { globalThis.fetch = originalFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
