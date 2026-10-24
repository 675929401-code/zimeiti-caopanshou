import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import * as promptContract from "../src/lib/storyboard-agent-prompt-contract";
import { STORYBOARD_AGENT_PROMPT, STORYBOARD_AGENT_VERSION } from "../src/lib/storyboard-workbench";

// Execute the real route with isolated authorization/storage dependencies; no DB or network.
const routeSource = readFileSync("src/app/api/storyboard/agent/route.ts", "utf8");
const compiled = transpileModule(routeSource, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
const saved: Array<{ prompt: string; version: string; updatedAt: string }> = [];
const authorizations: Array<{ capability: string; options: unknown }> = [];
let denied = false;
let storageFailure = false;
let databaseClients = 0;
let jsonReads = 0;
const database = Object.freeze({ isolated: true });
const dependencies: Record<string, unknown> = {
  "next/server": { NextResponse },
  "@/storage/database/supabase-client": {
    getSupabaseAdminClient: () => { databaseClients += 1; return database; },
  },
  "@/lib/storyboard-workbench": { STORYBOARD_AGENT_VERSION },
  "@/lib/storyboard-agent-prompt-contract": promptContract,
  "@/lib/server/storyboard-agent-store": {
    saveStoryboardAgentConfig: async (client: unknown, config: typeof saved[number]) => {
      assert.equal(client, database);
      if (storageFailure) throw new Error("isolated storage failure");
      saved.push(config);
    },
  },
  "@/lib/server/admin-governance-authority": {
    authorizeAdminCapability: async (_request: unknown, capability: string, options: unknown) => {
      authorizations.push({ capability, options });
      return denied
        ? { ok: false, response: NextResponse.json({ error: "denied" }, { status: 403 }) }
        : { ok: true };
    },
  },
};
const routeModule = { exports: {} as { PUT(request: NextRequest): Promise<Response> } };
new Function("require", "module", "exports", compiled)((name: string) => {
  assert.ok(Object.hasOwn(dependencies, name), `Unexpected route dependency: ${name}`);
  return dependencies[name];
}, routeModule, routeModule.exports);

async function request(body: unknown, malformed = false) {
  return routeModule.exports.PUT({ json: async () => {
    jsonReads += 1;
    if (malformed) throw new SyntaxError("isolated malformed JSON");
    return body;
  } } as unknown as NextRequest);
}

async function main() {
  const { STORYBOARD_AGENT_PROMPT_MIN_LENGTH: min, STORYBOARD_AGENT_PROMPT_MAX_LENGTH: max } = promptContract;
  assert.ok(STORYBOARD_AGENT_PROMPT.length > 20_000, "Fixture must reproduce the former default-save failure");
  let accepted = 0;
  for (const prompt of [STORYBOARD_AGENT_PROMPT, "字".repeat(min), "字".repeat(max)]) {
    const response = await request({ prompt });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.prompt, prompt);
    assert.equal(result.version, STORYBOARD_AGENT_VERSION);
    assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
    assert.equal(saved.at(-1)?.prompt, prompt, "Save the full prompt without truncation");
    accepted += 1;
  }
  const normalized = await request({ prompt: `  ${"字".repeat(min)}  ` });
  assert.equal(normalized.status, 200);
  assert.equal(saved.at(-1)?.prompt, "字".repeat(min), "Preserve the existing trim behavior");

  let rejected = 0;
  const savesBeforeInvalid = saved.length;
  const clientsBeforeInvalid = databaseClients;
  for (const body of [
    { prompt: "字".repeat(min - 1) },
    { prompt: "字".repeat(max + 1) },
    { prompt: " ".repeat(min) },
    { prompt: 123 }, {}, null, [],
  ]) {
    const response = await request(body);
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.code, "STORYBOARD_AGENT_PROMPT_INVALID");
    assert.equal(result.minLength, min);
    assert.equal(result.maxLength, max);
    assert.ok(result.error.length > 0);
    if (body && "prompt" in body && typeof body.prompt === "string" && body.prompt.length > max) {
      assert.match(result.error, /50000/u);
    }
    rejected += 1;
  }
  const malformed = await request(null, true);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "STORYBOARD_AGENT_PROMPT_INVALID_JSON");
  assert.equal(saved.length, savesBeforeInvalid);
  assert.equal(databaseClients, clientsBeforeInvalid, "Invalid requests must not initialize database access");

  denied = true;
  const readsBeforeDenied = jsonReads;
  const unauthorized = await request({ prompt: STORYBOARD_AGENT_PROMPT });
  assert.equal(unauthorized.status, 403);
  assert.equal(jsonReads, readsBeforeDenied, "Authorization must precede body parsing");
  assert.equal(databaseClients, clientsBeforeInvalid);
  for (const authorization of authorizations) {
    assert.deepEqual(authorization, {
      capability: "prompts.edit",
      options: { operation: "storyboard_prompt_update", requireStepUp: true },
    });
  }

  denied = false;
  storageFailure = true;
  const failedSave = await request({ prompt: STORYBOARD_AGENT_PROMPT });
  assert.equal(failedSave.status, 500);
  assert.equal((await failedSave.json()).error, "isolated storage failure");
  assert.equal(saved.length, savesBeforeInvalid, "Failed saves must not return success");

  console.log(JSON.stringify({
    result: "PASS", defaultPromptLength: STORYBOARD_AGENT_PROMPT.length,
    minLength: min, maxLength: max, acceptedBoundariesAndDefault: accepted,
    rejectedInputs: rejected, trimCompatibility: true, malformedJson400: true,
    authorizationBeforeParse: true, editCapabilityAndStepUpPreserved: true,
    invalidRequestsReachStorage: false, storageFailure500: true,
    realDatabaseWrites: 0, realNetworkRequests: 0,
  }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
