import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "../src/lib/story-director-overtime-gate";
import {
  configuredStoryboardPromptPushCapability,
  hasStoryboardPromptPushCapability,
  setStoryboardPromptPushCapability,
  configuredAgentPromptPushTarget,
  isAgentPromptPushTargetConfigurationValid,
  resolveAgentPromptPushTarget,
  setAgentPromptPushTarget,
} from "../src/lib/storyboard-prompt-push-capability";
import { publicStoryboardDirectorOutputStyle } from "../src/lib/storyboard-director-public-output-style";
import { canonicalAgentModelBinding } from "../src/lib/agent-model-binding";
import { normalizeStoryboardDirectorContractActivation, StoryboardDirectorContractActivationError, STORYBOARD_DIRECTOR_CONTRACT_FIELDS } from "../src/lib/storyboard-director-contract-activation";

const checks: string[] = [];
function check(name: string, fn: () => void) {
  fn();
  checks.push(name);
}

check("legacy official directors keep the handoff icon when the new field is absent", () => {
  assert.equal(hasStoryboardPromptPushCapability(STORY_DIRECTOR_MOVIE_AGENT_ID, {}), true);
  assert.equal(hasStoryboardPromptPushCapability(STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, undefined), true);
});

check("an explicit false disables the icon even for an official director", () => {
  const style = { storyboardPromptHandoff: { enabled: false }, private_style: "kept" };
  assert.equal(hasStoryboardPromptPushCapability(STORY_DIRECTOR_MOVIE_AGENT_ID, style), false);
  assert.equal(configuredStoryboardPromptPushCapability(style), false);
});

check("ordinary agents keep video by default and may explicitly select storyboard", () => {
  assert.equal(hasStoryboardPromptPushCapability("ordinary-agent", {}), false);
  const enabled = setStoryboardPromptPushCapability({ fontSize: 16 }, true);
  assert.equal(hasStoryboardPromptPushCapability("ordinary-agent", enabled), true);
  assert.equal(configuredStoryboardPromptPushCapability(enabled), true);
  assert.equal((enabled as { fontSize: number }).fontSize, 16);
});

check("malformed capability data never enables a generic agent", () => {
  for (const value of [null, [], "true", { storyboardPromptHandoff: null }, { storyboardPromptHandoff: { enabled: "true" } }]) {
    assert.equal(hasStoryboardPromptPushCapability("ordinary-agent", value), false);
  }
});

check("the public catalog preserves legacy capability bits without private style", () => {
  assert.deepEqual(
    publicStoryboardDirectorOutputStyle("ordinary-agent", { storyboardPromptHandoff: { enabled: true }, private_style: "omit" }),
    { storyboardPromptHandoff: { enabled: true } },
  );
  assert.equal(publicStoryboardDirectorOutputStyle("ordinary-agent", { private_style: "omit" }), undefined);
});

check("the UI and public catalog use the same capability contract", () => {
  const messageItem = readFileSync("src/components/chat/message-item.tsx", "utf8");
  const messageContent = readFileSync("src/components/chat/message-content.tsx", "utf8");
  const adminToggle = readFileSync("src/components/admin/StoryboardPromptPushCapabilityToggle.tsx", "utf8");
  const publicStyle = readFileSync("src/lib/storyboard-director-public-output-style.ts", "utf8");
  assert.match(messageItem, /hasStoryboardPromptPushCapability|resolveAgentPromptPushTarget/);
  assert.match(messageItem, /StructuredStoryboardHandoff/);
  assert.match(messageContent, /hasStoryboardPromptPushCapability|resolveAgentPromptPushTarget/);
  assert.match(adminToggle, /提示词推送目标/);
  assert.match(adminToggle, /<option value="storyboard-workbench">分镜编排/);
  assert.match(adminToggle, /<option value="video">视频创作/);
  assert.match(adminToggle, /当前推送目标无效/);
  assert.match(publicStyle, /STORYBOARD_PROMPT_HANDOFF_KEY/);
});

check("catalog-confirmed stable IDs preserve defaults without matching display names", () => {
  for (const id of [STORY_DIRECTOR_MOVIE_AGENT_ID, STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, "agent-1793171231055-r9qzu6", "agent-1793173660476-ci8pl8"]) {
    assert.equal(resolveAgentPromptPushTarget(id, {}), "storyboard-workbench");
  }
  for (const id of ["agent-1785658026345-k6yy99", "agent-1785688061259-4xww99", "new-agent", "爆梗分镜导演", "3D故事导演"]) assert.equal(resolveAgentPromptPushTarget(id, {}), "video");
});

check("explicit target and false precedence are shared by both destination choices", () => {
  assert.equal(resolveAgentPromptPushTarget("new-agent", { storyboardPromptHandoff: { target: "storyboard-workbench" } }), "storyboard-workbench");
  assert.equal(resolveAgentPromptPushTarget(STORY_DIRECTOR_MOVIE_AGENT_ID, { storyboardPromptHandoff: { target: "video", enabled: true } }), "video");
  assert.equal(resolveAgentPromptPushTarget("new-agent", { storyboardPromptHandoff: { target: "storyboard-workbench", enabled: false } }), "video");
  assert.equal(resolveAgentPromptPushTarget("new-agent", { storyboardPromptHandoff: { enabled: true } }), "storyboard-workbench");
  for (const target of [null, "", "invalid", "canvas", "commerce", "youcai", "film-studio", [], {}]) {
    const value = { storyboardPromptHandoff: { enabled: true, target } };
    assert.equal(isAgentPromptPushTargetConfigurationValid(value), false);
    assert.equal(resolveAgentPromptPushTarget("new-agent", value), undefined);
    assert.equal(configuredAgentPromptPushTarget(value), undefined);
    const disabledInvalid = { storyboardPromptHandoff: { enabled: false, target } };
    assert.equal(resolveAgentPromptPushTarget("new-agent", disabledInvalid), undefined);
    assert.equal(resolveAgentPromptPushTarget("new-agent", publicStoryboardDirectorOutputStyle("new-agent", disabledInvalid)), undefined);
  }
});

check("target setters preserve unrelated styles and the legacy setter remains compatible", () => {
  const original = { fontSize: 17, hybridImageGeneration: { enabled: true, modelId: "unchanged" }, storyboardPromptHandoff: { enabled: true, extra: "preserved" } };
  const video = setAgentPromptPushTarget(original, "video");
  assert.deepEqual(video, { ...original, storyboardPromptHandoff: { enabled: false, target: "video", extra: "preserved" } });
  assert.deepEqual(original.storyboardPromptHandoff, { enabled: true, extra: "preserved" });
  assert.equal(resolveAgentPromptPushTarget("new-agent", setAgentPromptPushTarget(video, "storyboard-workbench")), "storyboard-workbench");
  assert.equal(resolveAgentPromptPushTarget("new-agent", setStoryboardPromptPushCapability(video, true)), "storyboard-workbench");
});

check("public serialization roundtrips target-only and legacy fields without leaking private metadata", () => {
  for (const target of ["video", "storyboard-workbench"] as const) {
    const value = { storyboardPromptHandoff: { target, private_note: "DO_NOT_EXPOSE" }, private_style: "DO_NOT_EXPOSE" };
    const serialized = publicStoryboardDirectorOutputStyle("new-agent", value);
    assert.deepEqual(serialized, { storyboardPromptHandoff: { target } });
    assert.equal(resolveAgentPromptPushTarget("new-agent", serialized), target);
    assert.ok(!JSON.stringify(serialized).includes("DO_NOT_EXPOSE"));
  }
  const invalid = publicStoryboardDirectorOutputStyle("new-agent", { storyboardPromptHandoff: { enabled: true, target: "PRIVATE_INVALID_VALUE" } });
  assert.deepEqual(invalid, { storyboardPromptHandoff: { enabled: true, target: "invalid" } });
  assert.equal(resolveAgentPromptPushTarget("new-agent", invalid), undefined);
});

function actualFunction(name: string, globals: Record<string, unknown>): (...args: unknown[]) => unknown {
  const file = "src/app/api/admin/agents/route.ts", source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `ACTUAL_HANDLER_FUNCTION_REQUIRED:${name}`);
  const fixtureModule = { exports: undefined as unknown };
  const compiled = ts.transpileModule("module.exports=" + declaration.getText(tree).replace(/^export\s+/u, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, { module: fixtureModule, Response, console: { error: () => undefined }, ...globals });
  return fixtureModule.exports as (...args: unknown[]) => unknown;
}

async function verifyActualHandlers() {
  const NextResponse = { json: (body: unknown, options?: ResponseInit) => Response.json(body, options) };
  const targetFailure = actualFunction("invalidPromptPushTargetResponse", { NextResponse, isAgentPromptPushTargetConfigurationValid });
  let reads = 0, writes = 0, captured: Record<string, unknown> | undefined;
  const current = { id: "owned-agent", category: "existing", user_access: "available", config_revision: 1, system_prompt: "unchanged", output_style: { private_style: "kept" } };
  const database = {
    from: (table: string) => {
      reads++;
      const query = {
        select: () => query, eq: () => query,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: table === "llm_models" ? { id: "model", name: "text", model_name: "text", is_active: true, user_access: "available", api_key: "RAM_ONLY_FAKE" } : { ...current, ...captured }, error: null }),
        insert: (row: Record<string, unknown>) => { writes++; captured = row; return query; },
        update: (row: Record<string, unknown>) => { writes++; captured = row; return query; },
        single: async () => ({ data: { ...captured, config_revision: 1 }, error: null }),
      };
      return query;
    },
  };
  const globals = {
    NextResponse, invalidPromptPushTargetResponse: targetFailure,
    authorizeAgentMutation: async () => ({ ok: true, actor: { userId: "admin" } }),
    authorizeAgentFieldChanges: async () => null,
    categoryRequiresInternalAccess: async () => false,
    getSupabaseClient: () => database, canonicalAgentModelBinding,
    AGENT_MODEL_BINDING_COLUMNS: ["id"], storeAvatarIfNeeded: async () => "", assertManagedCoverReference: async () => "",
    replacementSecret: () => undefined, normalizeAgentPresetFields: () => [],
    publicAgent: (row: unknown) => row, invalidateAgentConfigCache: () => undefined, invalidateBotsCache: () => undefined,
    parseExpectedAgentRevision: (body: Record<string, unknown>) => Number(body.expected_revision),
    normalizeStoryboardDirectorContractActivation, StoryboardDirectorContractActivationError, STORYBOARD_DIRECTOR_CONTRACT_FIELDS,
    agentImageFailure: () => null,
    hasOwnInput: (body: Record<string, unknown>, keys: string[]) => keys.some(key => Object.hasOwn(body, key)),
    AGENT_PROMPT_INPUT_KEYS: ["system_prompt", "systemPrompt", "directorContractAction"],
    agentRevisionConflict: () => Response.json({ code: "AGENT_CONFIG_REVISION_CONFLICT" }, { status: 409 }),
  };
  for (const method of ["POST", "PUT"]) for (const alias of ["output_style", "outputStyle"]) {
    const handler = actualFunction(method, globals);
    for (const target of [null, "", "commerce", "youcai", "canvas", "film-studio", [], {}]) {
      reads = 0; writes = 0;
      const response = await handler({ json: async () => ({ agentId: current.id, [alias]: { storyboardPromptHandoff: { enabled: true, target } } }) }) as Response;
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "AGENT_PROMPT_PUSH_TARGET_INVALID");
      assert.equal(reads, 0); assert.equal(writes, 0);
    }
    for (const style of [setAgentPromptPushTarget({ private_style: "kept" }, "video"), setAgentPromptPushTarget({ private_style: "kept" }, "storyboard-workbench"), { storyboardPromptHandoff: { enabled: true } }, { storyboardPromptHandoff: { enabled: false } }, { private_style: "kept" }]) {
      reads = 0; writes = 0; captured = undefined;
      const response = await handler({ json: async () => ({ agentId: current.id, expected_revision: 1, name: "owned", category: "existing", source: "llm", model_id: "model", sort_order: 7, [alias]: style }) }) as Response;
      assert.equal(response.status, 200, `${method}:${alias}:${JSON.stringify(style)}`);
      assert.equal(writes, 1);
      assert.deepEqual((captured as Record<string, unknown> | undefined)?.output_style, style);
    }
  }
  writes = 0; reads = 0;
  const stale = actualFunction("PUT", globals);
  assert.equal((await stale({ json: async () => ({ agentId: current.id, expected_revision: 0, output_style: setAgentPromptPushTarget({}, "video") }) }) as Response).status, 409);
  assert.equal(writes, 0);
  for (const method of ["POST", "PUT"]) {
    writes = 0; reads = 0;
    const denied = actualFunction(method, { ...globals, authorizeAgentMutation: async () => ({ ok: false, response: Response.json({ code: "ADMIN_PERMISSION_DENIED" }, { status: 403 }) }) });
    assert.equal((await denied({ json: async () => { throw new Error("AUTH_MUST_RUN_FIRST"); } }) as Response).status, 403);
    assert.equal(writes, 0); assert.equal(reads, 0);
    const fieldDenied = actualFunction(method, { ...globals, authorizeAgentFieldChanges: async () => Response.json({ code: "ADMIN_PERMISSION_DENIED" }, { status: 403 }) });
    assert.equal((await fieldDenied({ json: async () => ({ output_style: { storyboardPromptHandoff: { target: "invalid" } } }) }) as Response).status, 403);
    assert.equal(writes, 0); assert.equal(reads, 0);
  }
  checks.push("actual POST/PUT reject invalid target aliases before DB reads/writes, persist both legal targets, and preserve auth ordering");
}

const report = {
  passed: true,
  checks,
  effects: { networkRequests: 0, databaseReads: 0, databaseWrites: 0, modelRequests: 0 },
  scope: "actual pure resolver/serializer and AST-loaded POST/PUT with in-memory database fixtures; no browser, provider, real database, or credential access",
};
verifyActualHandlers().then(() => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
