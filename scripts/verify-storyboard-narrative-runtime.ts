import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { officialStoryboardDirectorIdentity, serverStoryboardDirectorIdentity, hasStoryboardNarrativeRuntimeContract } from "../src/lib/storyboard-director-identity";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "../src/lib/story-director-overtime-gate";
import { publicStoryboardDirectorOutputStyle } from "../src/lib/storyboard-director-public-output-style";
import { buildStoryboardDirectorReferenceContext, type StoryboardDirectorReferenceDependencies } from "../src/lib/server/storyboard-director-reference-context";
import { buildStoryboardDirectorCastingContext } from "../src/lib/server/storyboard-director-casting-context";
import { STORYBOARD_DIRECTOR_NARRATIVE_STYLES } from "../src/lib/storyboard-director-narrative-catalog";
import { STORYBOARD_DIRECTOR_TEXT_STYLES, buildStoryboardDirectorTextCasting } from "../src/lib/storyboard-director-text-casting";
import { readStoryboardIntakeSnapshotForMessage, resolveStoryboardHandoffContract } from "../src/lib/agent-workbench-handoff";
import type { StoryboardDirectorInput } from "../src/lib/storyboard-director-protocol";

const id = STORY_DIRECTOR_MOVIE_AGENT_ID;
const flags = { production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: "2026-10-23T18:00:00Z",
  performance_contract: "storyboard_performance.v1", performance_contract_activated_at: "2026-10-23T18:00:00Z" };
const prompt = readFileSync("prompts/storyboard-narrative-unified-20261023.md", "utf8");
const row = { id, system_prompt: prompt, output_style: flags };
const content = (mode = "普通模式", style: string = STORYBOARD_DIRECTOR_NARRATIVE_STYLES[4].label) => `segmented_script: 1.【主人停在门边，金毛把球放回毯子。】\ntarget_duration_seconds: 10\naspect_ratio: 9:16\nowner_gender: 男主人\ndog_breed: 按原文识别，未指定由导演确定\nanimation_style: ${style}\nspecial_notes: 墨绿卫衣、卡其长裤、白鞋；保持原文的可能性语气。\nvideo_model_profile: 自动通用（分镜工作台再选择模型）\nvisual_asset_mode: ${mode}`;
const request = (text = content()) => ({ agentId: id, agentRow: row, verifiedUserId: "private-account-seed", messages: [{ role: "user", content: text }] });
const calls = { projects: 0, images: 0, reads: 0 };
const deps: StoryboardDirectorReferenceDependencies = {
  async loadOwnedProject() { calls.projects++; throw new Error("DATABASE_FORBIDDEN"); },
  async loadOwnedImage() { calls.images++; throw new Error("DATABASE_FORBIDDEN"); },
  async verifyReadableImage() { calls.reads++; throw new Error("NETWORK_FORBIDDEN"); },
};
const payload = (context: string) => JSON.parse(context.split("\n").find(line => line.startsWith("{"))!);
const checks: string[] = [];
const check = (name: string, fn: () => void) => { fn(); checks.push(name); };
async function main() {
  check("official identities use stable IDs, never display labels", () => {
    assert.equal(officialStoryboardDirectorIdentity(id)?.mode, "cinematic");
    assert.equal(officialStoryboardDirectorIdentity(STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID)?.mode, "high_energy");
    for (const value of ["叙事版", "电影叙事", "narrative", "other-agent", undefined]) assert.equal(officialStoryboardDirectorIdentity(value), undefined);
  });
  check("new narrative runtime requires server identity, both contract flags, activation times and all prompt markers", () => {
    assert.equal(serverStoryboardDirectorIdentity(request())?.mode, "cinematic");
    assert.equal(serverStoryboardDirectorIdentity({ ...request(), agentId: "other-agent" }), undefined);
    assert.equal(serverStoryboardDirectorIdentity({ ...request(), agentRow: { ...row, id: "other-agent" } }), undefined);
    for (const key of Object.keys(flags)) {
      const altered = { ...flags } as Record<string, unknown>; delete altered[key];
      assert.equal(hasStoryboardNarrativeRuntimeContract(altered), false);
      assert.equal(serverStoryboardDirectorIdentity({ ...request(), agentRow: { ...row, output_style: altered } }), undefined);
    }
    for (const marker of ["storyboard_director_contract.v2", "storyboard_director_plan.v1", "storyboard_performance.v1"]) {
      assert.equal(serverStoryboardDirectorIdentity({ ...request(), agentRow: { ...row, system_prompt: prompt.replaceAll(marker, "old_marker") } }), undefined);
    }
  });
  check("public metadata publishes only the four contract scalars", () => {
    const publicStyle = publicStoryboardDirectorOutputStyle(id, { ...flags, director_mode: "high_energy", private_prompt: "PRIVATE_SENTINEL", api_key: "PRIVATE_SENTINEL" });
    assert.deepEqual(publicStyle, flags);
    assert.ok(!JSON.stringify(publicStyle).includes("PRIVATE_SENTINEL"));
    assert.deepEqual(publicStoryboardDirectorOutputStyle(STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, flags), flags);
    assert.equal(publicStoryboardDirectorOutputStyle(id, { schema_version: "old_prompt" }), undefined);
    for (const legacy of ["legacy-style", false, 7, []]) assert.equal(publicStoryboardDirectorOutputStyle(id, legacy), undefined);
    const partial = publicStoryboardDirectorOutputStyle(id, { production_contract_version: flags.production_contract_version });
    assert.equal(partial?.performance_contract, "invalid");
  });
  check("trusted identity with the public contract resolves cinematic intake and preserves old-message activation boundary", () => {
    const messages = [{ id: "user", role: "user", content: content(), timestamp: Date.parse("2026-10-23T19:00:00Z") }, { id: "assistant", role: "assistant", content: "fixture" }];
    const publicStyle = publicStoryboardDirectorOutputStyle(id, flags)!;
    const mode = hasStoryboardNarrativeRuntimeContract(publicStyle) ? officialStoryboardDirectorIdentity(id)?.mode : undefined;
    const intake = readStoryboardIntakeSnapshotForMessage(messages, "assistant", mode)!;
    assert.equal(intake.input.director_mode, "cinematic"); assert.equal(intake.input.dog_breed, "按原文识别，未指定由导演确定");
    assert.equal(resolveStoryboardHandoffContract(messages, "assistant", publicStyle).requirePerformancePlan, true);
    messages[0].timestamp = Date.parse("2026-10-23T17:00:00Z");
    const legacy = resolveStoryboardHandoffContract(messages, "assistant", publicStyle);
    assert.equal(legacy.allowLegacyUnverified, true); assert.equal(legacy.requirePerformancePlan, false);
  });
  check("actual agent catalog mapping derives cinematic internally only for an activated official narrative", () => {
    const source = readFileSync("src/contexts/app-context.tsx", "utf8");
    const ast = ts.createSourceFile("app-context.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer = "";
    let mapped = false;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "outputStyle") initializer = node.initializer?.getText(ast) || "";
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "apiAgents.push") {
        const argument = node.arguments[0];
        mapped = ts.isObjectLiteralExpression(argument) && argument.properties.some(property => ts.isShorthandPropertyAssignment(property) && property.name.text === "outputStyle");
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(initializer && mapped, "real catalog mapping must use the derived style");
    const compiled = ts.transpileModule(`(bot, agentId) => (${initializer})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const mapStyle = vm.runInNewContext(compiled, { officialStoryboardDirectorIdentity, hasStoryboardNarrativeRuntimeContract }) as (bot: { output_style?: unknown }, agentId: unknown) => unknown;
    const ordinary = { fontSize: 16, director_mode: "high_energy" };
    const active = { ...flags, director_mode: "high_energy" };
    assert.deepEqual(JSON.parse(JSON.stringify(mapStyle({ output_style: active }, id))), { ...flags, director_mode: "cinematic" });
    assert.deepEqual(active, { ...flags, director_mode: "high_energy" });
    for (const agentId of [STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, "other-agent", "叙事版", undefined]) assert.equal(mapStyle({ output_style: active }, agentId), active);
    for (const output_style of [ordinary, { ...flags, performance_contract_activated_at: "invalid" }, "legacy-value"]) assert.equal(mapStyle({ output_style }, id), output_style);
    assert.deepEqual(JSON.parse(JSON.stringify(mapStyle({}, id))), {});
  });
  const ordinary = await buildStoryboardDirectorReferenceContext(request(), deps);
  const reference = await buildStoryboardDirectorReferenceContext(request(content("参考图模式")), deps);
  check("normal and reference host routing use cinematic and never look up media for a new complete plan", () => {
    assert.match(ordinary, /HOST_ASSETS_NOT_REQUIRED/u); assert.equal(payload(ordinary).input.director_mode, "cinematic");
    assert.match(reference, /HOST_DIRECTOR_PLAN/u); assert.equal(payload(reference).phase, "planned");
    assert.equal(payload(reference).referenceImagesVerified, false); assert.equal(payload(reference).input.director_mode, "cinematic");
    assert.deepEqual(calls, { projects: 0, images: 0, reads: 0 });
  });
  for (const agentRow of [{ ...row, output_style: {} }, { ...row, system_prompt: "old cinematic prompt" }]) {
    assert.equal(await buildStoryboardDirectorReferenceContext({ ...request(), agentRow }, deps), "");
    assert.equal(buildStoryboardDirectorCastingContext({ ...request(), agentRow }), "");
  }
  checks.push("old cinematic rows keep prior runtime behavior until explicit new-contract activation");
  check("normal and reference share the same whole-script identity seed, with no contradictory assets-only plan instruction", () => {
    const first = buildStoryboardDirectorCastingContext(request());
    const second = buildStoryboardDirectorCastingContext(request(content("参考图模式")));
    assert.deepEqual(payload(first).resolved_text_casting, payload(second).resolved_text_casting);
    assert.equal(payload(first).resolved_text_casting.style.status, "catalog");
    assert.ok(!first.includes("private-account-seed"));
    assert.match(second, /一次交完整文字计划/u); assert.doesNotMatch(second, /未验证资产不输出分镜/u);
    assert.match(second, /逐项采用确认后解锁/u);
    assert.match(second, /首次定妆先按本轮所选风格确定头身比例/u);
    assert.match(second, /既有参考项目的比例与身份沿用已采用结果/u);
    assert.match(second, /表情强度、动作幅度、景别和运镜节奏均依当前事件/u);
  });
  check("all ten original v4.3.2 cinematic style labels have runtime rendering locks", () => {
    const historical = readFileSync("prompts/storyboard-voiceover-cinematic-v4.3.2.md", "utf8");
    const styleSection = historical.split("# 3D风格库与互斥路由")[1].split(/\n#/u)[0];
    const originalStyles = [...styleSection.matchAll(/^- \*\*([^*]+)\*\*：([^\r\n]+)/gmu)].map(match => ({ label: match[1], material_lock: match[2] }));
    assert.deepEqual(STORYBOARD_DIRECTOR_NARRATIVE_STYLES.map(style => style.label), originalStyles.map(style => style.label));
    for (const [index, style] of STORYBOARD_DIRECTOR_NARRATIVE_STYLES.entries()) {
      assert.equal(style.material_lock.match(/^人物[\d.至]+头身/u)?.[0], originalStyles[index].material_lock.match(/^人物[\d.至]+头身/u)?.[0]);
      assert.equal(style.material_lock.split("禁混：")[1], originalStyles[index].material_lock.split("禁混：")[1]);
      assert.doesNotMatch(style.material_lock, /克制表情|快速反应切换|短促推近与喜剧停顿|运镜快而稳|稳定横移|轨道、推进和精确跟拍为主/u);
    }
    assert.match(STORYBOARD_DIRECTOR_NARRATIVE_STYLES[4].material_lock, /细腻而清晰可辨的表情/u);
    const original = payload(buildStoryboardDirectorCastingContext(request())).resolved_text_casting;
    for (const style of STORYBOARD_DIRECTOR_NARRATIVE_STYLES) {
      const cast = payload(buildStoryboardDirectorCastingContext(request(content("普通模式", style.label)))).resolved_text_casting;
      assert.equal(cast.style.status, "catalog"); assert.equal(cast.style.matched_label, style.label); assert.equal(cast.style.material_lock, style.material_lock);
      assert.equal(cast.selection_id, original.selection_id); assert.deepEqual(cast.selected, original.selected);
    }
  });
  check("custom appearance, age, clothing and unknown styles remain user data rather than overwritten catalog locks", () => {
    const input = payload(ordinary).input as StoryboardDirectorInput;
    const custom = buildStoryboardDirectorTextCasting({ ...input, animation_style: "自定义纸艺", special_notes: "65岁女主人、银色短发、红色连衣裙" }, "private-account-seed", "cinematic");
    assert.equal(custom.style.requested_label, "自定义纸艺"); assert.equal(custom.style.status, "custom-required");
    assert.equal(custom.selected?.outfit.apply_lock_line, false); assert.equal(custom.selected?.outfit.usage, "fallback-only");
    assert.deepEqual([...custom.user_override_policy.user_directed_aspects].sort(), ["age", "hair", "wardrobe"]);
    assert.equal(STORYBOARD_DIRECTOR_TEXT_STYLES.length, 6);
  });
  check("explicit wrong director mode is rejected rather than silently rewritten", () => {
    assert.equal(buildStoryboardDirectorCastingContext(request(content() + "\ndirector_mode: high_energy")), "");
  });
  assert.match(await buildStoryboardDirectorReferenceContext(request(content() + "\ndirector_mode: high_energy"), deps), /official_director_mode_mismatch/u);
  const output = ".codex-evidence/director-refinement-20261023/narrative-followup";
  mkdirSync(output, { recursive: true }); const report = { passed: true, checks, calls, networkRequests: 0, databaseWrites: 0, modelRequests: 0 };
  writeFileSync(`${output}/runtime-contract-result.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
