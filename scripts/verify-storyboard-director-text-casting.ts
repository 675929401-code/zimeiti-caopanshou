import assert from "node:assert/strict";
import type { StoryboardDirectorInput } from "../src/lib/storyboard-director-protocol";
import {
  buildStoryboardDirectorTextCasting,
  STORYBOARD_DIRECTOR_TEXT_OUTFITS,
  STORYBOARD_DIRECTOR_TEXT_STYLES,
} from "../src/lib/storyboard-director-text-casting";

const initial: StoryboardDirectorInput = {
  schema_version: "storyboard_director_input.v1", segmented_script: "1.【狗狗低头看着球，主人发现它正等待回应。】\n2.【主人靠近，狗狗抬起头。】",
  director_mode: "high_energy", animation_style: "皮克斯式高能3D宠物科普动画", aspect_ratio: "16:9",
  target_duration_seconds: 10, special_notes: "", owner_gender: "文案优先，未指定默认女主人", dog_breed: "柯基",
  visual_asset_mode: "普通模式",
};
let passed = 0;
function check(name: string, verify: () => void) {
  try { verify(); passed++; }
  catch (error) { throw new Error(name, { cause: error }); }
}
function cast(changes: Partial<StoryboardDirectorInput> = {}, seed = "fixture-account") {
  return buildStoryboardDirectorTextCasting({ ...initial, ...changes }, seed);
}

const originalFetch = globalThis.fetch;
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error("Network forbidden in pure casting checks"); };
try {
  check("Ten migrated outfit identities are unique and complete", () => {
    assert.deepEqual(STORYBOARD_DIRECTOR_TEXT_OUTFITS.map(value => value.id), ["F01", "F02", "F03", "F04", "F05", "F06", "M01", "M02", "M03", "M04"]);
    assert.equal(new Set(STORYBOARD_DIRECTOR_TEXT_OUTFITS.map(value => value.name)).size, 10);
    for (const outfit of STORYBOARD_DIRECTOR_TEXT_OUTFITS) {
      assert.ok(outfit.items.length >= 4 && outfit.items.every(item => item.length >= 2));
      assert.ok(outfit.materials.length >= 4 && outfit.contexts.includes("general"));
      assert.equal(outfit.gender, outfit.id.startsWith("F") ? "female" : "male");
    }
  });
  check("Input remains unchanged and the same whole-script selection reproduces", () => {
    const input = Object.freeze(structuredClone(initial)), before = JSON.stringify(input);
    const first = buildStoryboardDirectorTextCasting(input, "fixture-account");
    assert.deepEqual(first, buildStoryboardDirectorTextCasting(input, "fixture-account"));
    assert.equal(JSON.stringify(input), before);
    assert.equal(first.strategy.selection_scope, "whole-script");
    assert.match(first.selection_id, /^casting_[a-f0-9]{16}$/u);
    assert.equal(first.schema_version, "storyboard_director_text_casting.v1");
  });
  check("Ordinary and initial reference workflows select the same text identity", () => {
    const ordinary = cast(), reference = cast({ visual_asset_mode: "参考图模式" });
    assert.deepEqual(ordinary, reference);
  });
  check("The opaque selection never exposes the account seed", () => {
    const privateSeed = "private-account-8b3d-secret-fixture";
    assert.equal(JSON.stringify(cast({}, privateSeed)).includes(privateSeed), false);
    assert.notEqual(cast({}, privateSeed).selection_id, cast({}, "other-account").selection_id);
  });
  check("Explicit male and female cards stay within their respective catalogs", () => {
    const male = cast({ owner_gender: "男主人" }), female = cast({ owner_gender: "女主人" });
    assert.equal(male.selected?.gender, "male"); assert.match(male.selected!.outfit.id, /^M0[1-4]$/u);
    assert.equal(female.selected?.gender, "female"); assert.match(female.selected!.outfit.id, /^F0[1-6]$/u);
    assert.match(female.selected!.appearance_default, /黑棕(?:高马尾|蓬松半扎发)/u);
    assert.doesNotMatch(female.selected!.appearance_default, /或/u);
    assert.match(male.selected!.persona_default, /帅气|清爽/u); assert.match(female.selected!.persona_default, /时尚|时髦/u);
    assert.match(male.selected!.persona_default, /姿态|动作/u); assert.match(female.selected!.persona_default, /姿态|动作/u);
  });
  check("An explicit card outranks conflicting note and script gender cues", () => {
    const result = cast({ owner_gender: "男主人", special_notes: "女主人站在客厅。", segmented_script: "1.【女孩发现狗狗。】" });
    assert.equal(result.selected?.gender, "male"); assert.equal(result.strategy.gender.evidence_from, "explicit-card-choice");
    assert.equal(result.user_override_policy.user_material.special_notes, "女主人站在客厅。");
  });
  check("Notes outrank script cues for a script-priority card", () => {
    const result = cast({ special_notes: "本片男主人。", segmented_script: "1.【女主人听见狗狗。】" });
    assert.equal(result.selected?.gender, "male"); assert.equal(result.strategy.gender.evidence_from, "special-notes-cues");
  });
  check("Multiple mentioned genders remain unresolved with separate fallbacks", () => {
    const result = cast({ special_notes: "男主人和女主人分别看向狗狗。" });
    assert.equal(result.selected, null); assert.equal(result.strategy.gender.value, "unresolved");
    assert.deepEqual(result.gender_fallbacks?.map(value => value.gender), ["female", "male"]);
    assert.match(result.gender_fallbacks![0].outfit.id, /^F/u); assert.match(result.gender_fallbacks![1].outfit.id, /^M/u);
  });
  check("A user red dress and elderly silver hair are preserved outside the catalog", () => {
    const notes = "八十岁的老人，银发盘起，身穿红色连衣裙和黑色皮鞋，脸上有自然皱纹。";
    const result = cast({ owner_gender: "女主人", special_notes: notes });
    assert.equal(result.strategy.kind, "user-directed");
    assert.equal(result.selected!.outfit.usage, "fallback-only"); assert.equal(result.selected!.outfit.apply_lock_line, false);
    assert.equal(result.user_override_policy.user_material.special_notes, notes);
    for (const aspect of ["wardrobe", "age", "hair", "appearance"]) assert.ok(result.user_override_policy.user_directed_aspects.includes(aspect as "wardrobe"));
    assert.doesNotMatch(result.selected!.appearance_default, /年轻|黑棕|高马尾|半扎发/u);
    assert.match(result.user_override_policy.instruction, /不得.*覆盖.*红裙/u);
  });
  check("Explicit script age and hairstyle also suppress incompatible defaults", () => {
    const result = cast({ owner_gender: "男主人", segmented_script: "1.【70岁男主人留着白发长辫，轻轻蹲下。】" });
    assert.equal(result.selected?.gender, "male");
    assert.ok(result.user_override_policy.user_directed_aspects.includes("age"));
    assert.ok(result.user_override_policy.user_directed_aspects.includes("hair"));
    assert.doesNotMatch(result.selected!.appearance_default, /年轻|短发/u);
  });
  check("Bounded outdoor cues narrow the eligible fallback set", () => {
    for (const owner_gender of ["男主人", "女主人"]) {
      const result = cast({ owner_gender, segmented_script: "1.【主人在公园散步，狗狗沿着小路跑步。】" });
      assert.equal(result.strategy.semantic_context, "outdoor");
      assert.ok(result.selected!.outfit.compatible_contexts.includes("outdoor"));
      assert.ok(["F03", "F04", "M01", "M03"].includes(result.selected!.outfit.id));
      assert.equal(result.strategy.context_interpretation, "bounded-cues-for-fallback-ranking");
    }
  });
  check("Everyday cues avoid the outdoor-only fallback and obvious negation is respected", () => {
    const result = cast({ segmented_script: "1.【女主人在客厅观察狗狗，不要户外场景。】" });
    assert.equal(result.strategy.semantic_context, "everyday"); assert.ok(result.selected!.outfit.compatible_contexts.includes("everyday"));
    assert.notEqual(result.selected!.outfit.id, "F03");
  });
  check("Equivalent candidates vary across whole scripts and never per segment", () => {
    const choices = new Set(Array.from({ length: 24 }, (_, index) => cast({ segmented_script: `1.【第${index}篇：主人观察狗狗的反应。】\n2.【它停下来等待。】` }).selected!.outfit.id));
    assert.ok(choices.size >= 3);
    const result = cast(); assert.equal(Array.isArray(result.selected), false);
    assert.ok(result.selected!.outfit.lock_line.startsWith(`${result.selected!.outfit.id}｜${result.selected!.outfit.name}｜`));
    for (const item of result.selected!.outfit.items) assert.ok(result.selected!.outfit.lock_line.includes(item));
  });
  check("Six exact high-energy styles preserve the same clothing and identity", () => {
    assert.deepEqual(STORYBOARD_DIRECTOR_TEXT_STYLES.map(value => value.label), [
      "皮克斯式高能3D宠物科普动画", "皮克斯式温暖家庭3D动画", "迪士尼式夸张冒险3D动画", "黏土定格质感3D动画", "欧美玩具电影质感3D动画", "日系Q版电影级3D动画",
    ]);
    const expectedMaterial = [/毛发|布料/u, /次表面散射|柔光/u, /方向光|姿态/u, /黏土|手作/u, /塑料|绒毛/u, /Q版|圆润/u];
    const original = cast();
    for (const [index, style] of STORYBOARD_DIRECTOR_TEXT_STYLES.entries()) {
      const result = cast({ animation_style: style.label });
      assert.equal(result.style.status, "catalog"); assert.equal(result.style.matched_label, style.label);
      assert.match(result.style.material_lock, expectedMaterial[index]);
      assert.deepEqual(result.selected, original.selected); assert.equal(result.selection_id, original.selection_id);
      assert.equal(result.style.scope, "rendering-only");
      assert.doesNotMatch(result.style.material_lock, /红裙|牛仔裤|卫衣|短发|马尾/u);
    }
  });
  check("Unknown styles preserve their value instead of selecting the default", () => {
    const result = cast({ animation_style: "用户自定水墨纸艺风格" });
    assert.equal(result.style.status, "custom-required"); assert.equal(result.style.requested_label, "用户自定水墨纸艺风格");
    assert.equal(result.style.matched_label, undefined); assert.deepEqual(result.selected, cast().selected);
  });
  check("The historical high-energy label prefix is only a rendering alias", () => {
    const result = cast({ animation_style: "对标皮克斯式高能3D宠物科普动画" });
    assert.equal(result.style.matched_label, STORYBOARD_DIRECTOR_TEXT_STYLES[0].label);
    assert.equal(result.style.requested_label, "对标皮克斯式高能3D宠物科普动画");
  });
  check("Text casting cannot masquerade as a generated or published image", () => {
    const forbiddenKeys = new Set(["source", "presetId", "storageKey", "historyRecordId", "previewUrl", "assetId"]);
    const walk = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) { assert.equal(forbiddenKeys.has(key), false, key); walk(child); }
    };
    walk(cast()); walk(cast({ special_notes: "女主人和男主人出现。" }));
  });
  check("The pure module never attempts network access", () => { assert.equal(networkRequests, 0); });
  console.log(JSON.stringify({ passed, failed: 0, networkRequests, databaseWrites: 0, modelRequests: 0,
    scope: "whole-script deterministic text casting, migrated outfits, user override precedence and six rendering styles" }));
} finally { globalThis.fetch = originalFetch; }
