import assert from "node:assert/strict";
import {
  AGENT_WORKBENCH_HANDOFF_TTL_MS,
  acknowledgeAgentWorkbenchHandoff,
  acknowledgeAgentWorkbenchHandoffAcrossTabs,
  agentWorkbenchHandoffStorageKey,
  buildHomepageStoryboardDraftDetail,
  createAgentWorkbenchHandoff,
  readAgentWorkbenchHandoff,
  readAgentWorkbenchHandoffAcrossTabs,
  readStoryboardIntakeForMessage,
  resolveStoryboardHandoffContract,
  saveAgentWorkbenchHandoff,
  type AgentWorkbenchHandoffStorage,
} from "../src/lib/agent-workbench-handoff";
import { createUserScopedWorkbenchStorage } from "../src/lib/workbench-user-storage";
import type { StoryboardDirectorInput, StoryboardDirectorPackage } from "../src/lib/storyboard-director-protocol";
import type { StructuredAgentOutputReadyDetail } from "../src/lib/structured-agent-output";

class MemoryStorage implements AgentWorkbenchHandoffStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const originalInput: StoryboardDirectorInput = {
  schema_version: "storyboard_director_input.v1", segmented_script: "1.【女孩抬手，小狗追逐蓝色羽毛。】",
  director_mode: "cinematic", animation_style: "温暖3D动画", aspect_ratio: "16:9",
  target_duration_seconds: 10, special_notes: "女孩米色毛衣，小狗红色项圈。无对白。",
};
const packageFixture: StoryboardDirectorPackage = {
  schema_version: "storyboard_director_output.v1", artifact_type: "storyboard_director_package", director_mode: "cinematic",
  input: structuredClone(originalInput),
  segments: [{
    segment_id: "segment_001", source_index: 1, narration: "女孩抬手，小狗追逐蓝色羽毛。",
    target_duration_seconds: 10, estimated_narration_duration: 3, panel_count: 4, layout: "two_by_two", pacing_mode: "medium",
    actual_shot_count: 3,
    shot_time_ranges: [
      { shot_id: "shot_01", start_seconds: 0, end_seconds: 3, action_beat: "女孩抬手" },
      { shot_id: "shot_02", start_seconds: 3, end_seconds: 7, action_beat: "小狗追逐羽毛" },
      { shot_id: "shot_03", start_seconds: 7, end_seconds: 10, action_beat: "两者停下" },
    ], panoramic_anchor_role: null,
    continuity_links: [
      { from_shot: "shot_01", to_shot: "shot_02", link_type: "gaze_bridge", description: "视线指向羽毛" },
      { from_shot: "shot_02", to_shot: "shot_03", link_type: "action_bridge", description: "动作自然收束" },
    ], character_assets: ["米色毛衣女孩", "红色项圈小狗"],
    semantic_visualizations: [{ trigger: "惊喜", visual_form: "蓝色羽毛轻飘", interaction: "随动作起落" }],
    storyboard_image_prompt: "严格四格2x2连续故事板；米色毛衣女孩与红色项圈小狗，蓝色羽毛漂浮。",
    image_to_video_prompt: "10秒3镜头，0-3秒女孩抬手，3-7秒小狗追逐羽毛，7-10秒停下；只留脚步声，无对白。",
  }],
};
function detail(id: string): StructuredAgentOutputReadyDetail {
  return {
    message_id: id, commit_key: `commit-${id}`, schema_version: "storyboard_director_output.v1", source: "stable_json",
    segments: [], machine_payload: structuredClone(packageFixture), expected_input: structuredClone(originalInput),
  };
}
const target = "storyboard-workbench";
const now = Date.now();
const checks: string[] = [];
function test(name: string, run: () => void) { run(); checks.push(name); }

test("A and B keep distinct slots and can arrive in either order", () => {
  const storage = new MemoryStorage();
  const first = saveAgentWorkbenchHandoff(detail("A"), target, storage)!;
  const second = saveAgentWorkbenchHandoff(detail("B"), target, storage)!;
  assert.ok(first); assert.ok(second); assert.notEqual(first.handoff_id, second.handoff_id);
  assert.equal(storage.getItem(agentWorkbenchHandoffStorageKey(target)), null);
  const b = readAgentWorkbenchHandoff(target, storage, Date.now(), second.handoff_id);
  const a = readAgentWorkbenchHandoff(target, storage, Date.now(), first.handoff_id);
  assert.ok(a.ok && b.ok);
  assert.equal(a.handoff.payload.message_id, "A"); assert.equal(b.handoff.payload.message_id, "B");
  assert.ok(readAgentWorkbenchHandoff(target, storage, Date.now(), first.handoff_id).ok, "failed save / refresh retains exact payload");
  assert.ok(acknowledgeAgentWorkbenchHandoff(target, first.handoff_id, storage));
  assert.equal(readAgentWorkbenchHandoff(target, storage, Date.now(), first.handoff_id).ok, false);
  assert.ok(readAgentWorkbenchHandoff(target, storage, Date.now(), second.handoff_id).ok, "A ACK must not consume B");
  assert.ok(acknowledgeAgentWorkbenchHandoff(target, first.handoff_id, storage), "ACK retry is idempotent");
});

test("same content repeated clicks have unique delivery IDs", () => {
  const first = createAgentWorkbenchHandoff(detail("A"), target, now)!;
  const second = createAgentWorkbenchHandoff(detail("A"), target, now)!;
  assert.notEqual(first.handoff_id, second.handoff_id);
  assert.equal(first.payload.commit_key, second.payload.commit_key);
});

test("exact-ID reads never pick legacy or another pending handoff", () => {
  const storage = new MemoryStorage();
  const legacy = createAgentWorkbenchHandoff(detail("legacy"), target, now)!;
  storage.setItem(agentWorkbenchHandoffStorageKey(target), JSON.stringify(legacy));
  assert.equal(readAgentWorkbenchHandoff(target, storage, now, "missing-id").ok, false);
  assert.ok(readAgentWorkbenchHandoff(target, storage, now).ok, "old links can still read only old slot");
  const newer = createAgentWorkbenchHandoff(detail("newer"), target, now)!;
  storage.setItem(agentWorkbenchHandoffStorageKey(target), JSON.stringify(newer));
  assert.ok(acknowledgeAgentWorkbenchHandoff(target, legacy.handoff_id, storage));
  const retained = readAgentWorkbenchHandoff(target, storage, now);
  assert.ok(retained.ok); assert.equal(retained.handoff.handoff_id, newer.handoff_id);
});

test("swapped IDs, malformed IDs and expired payloads cannot import", () => {
  const storage = new MemoryStorage();
  const envelope = createAgentWorkbenchHandoff(detail("A"), target, now)!;
  storage.setItem(agentWorkbenchHandoffStorageKey(target, "other-id"), JSON.stringify(envelope));
  const wrong = readAgentWorkbenchHandoff(target, storage, now, "other-id");
  assert.ok(!wrong.ok); assert.equal(wrong.code, "ID_MISMATCH");
  assert.equal(readAgentWorkbenchHandoff(target, storage, now, "../../bad").ok, false);
  storage.setItem(agentWorkbenchHandoffStorageKey(target, envelope.handoff_id), JSON.stringify(envelope));
  const expired = readAgentWorkbenchHandoff(target, storage, now + AGENT_WORKBENCH_HANDOFF_TTL_MS + 1, envelope.handoff_id);
  assert.ok(!expired.ok); assert.equal(expired.code, "EXPIRED");
  assert.equal(storage.getItem(agentWorkbenchHandoffStorageKey(target, envelope.handoff_id)), null);
});

test("current-account scope is required for cross-tab read and ACK", () => {
  const sessionStorage = new MemoryStorage(); const localStorage = new MemoryStorage();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage, localStorage } });
  const actor = (userId: string) => {
    localStorage.setItem("auth_user", JSON.stringify({ id: userId }));
    localStorage.setItem("auth_token", `test.${Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.test`);
  };
  try {
    actor("A");
    const ownerAStorage = createUserScopedWorkbenchStorage(localStorage, "A");
    const envelope = saveAgentWorkbenchHandoff(detail("A"), target, ownerAStorage)!;
    actor("B");
    assert.equal(readAgentWorkbenchHandoffAcrossTabs(target, "A", Date.now(), envelope.handoff_id).ok, false);
    assert.equal(readAgentWorkbenchHandoffAcrossTabs(target, "B", Date.now(), envelope.handoff_id).ok, false);
    assert.equal(acknowledgeAgentWorkbenchHandoffAcrossTabs(target, "A", envelope.handoff_id), false);
    actor("A");
    assert.ok(readAgentWorkbenchHandoffAcrossTabs(target, "A", Date.now(), envelope.handoff_id).ok);
    assert.ok(acknowledgeAgentWorkbenchHandoffAcrossTabs(target, "A", envelope.handoff_id));
    assert.equal(readAgentWorkbenchHandoffAcrossTabs(target, "A", Date.now(), envelope.handoff_id).ok, false);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("the independent intake survives delivery and rejects altered outputs", () => {
  const message = { id: "from-chat", role: "assistant" as const, content: JSON.stringify(packageFixture) };
  assert.ok(buildHomepageStoryboardDraftDetail(message, originalInput));
  assert.equal(buildHomepageStoryboardDraftDetail(message), null);
  const changed = structuredClone(originalInput); changed.aspect_ratio = "9:16";
  assert.equal(buildHomepageStoryboardDraftDetail(message, changed), null);
  const envelope = createAgentWorkbenchHandoff(detail("A"), target, now)!;
  assert.deepEqual(envelope.payload.expected_input, originalInput);
});

test("chat intake uses the exact preceding card and rejects incomplete or ambiguous cards", () => {
  const card = "segmented_script: 1.【女孩抬手，小狗追逐蓝色羽毛。】\nanimation_style: 温暖3D动画\naspect_ratio: 16:9\ntarget_duration_seconds: 10\nspecial_notes: 女孩米色毛衣，小狗红色项圈。无对白。";
  const messages = [
    { id: "user-A", role: "user", content: card },
    { id: "assistant-A", role: "assistant", content: "original A output" },
    { id: "user-B", role: "user", content: card.replace("16:9", "9:16") },
    { id: "assistant-B", role: "assistant", content: "original B output" },
  ];
  assert.equal(readStoryboardIntakeForMessage(messages, "assistant-A", "cinematic")?.aspect_ratio, "16:9");
  assert.equal(readStoryboardIntakeForMessage(messages, "assistant-B", "narrative")?.director_mode, "cinematic");
  assert.equal(readStoryboardIntakeForMessage(messages, "assistant-B", "cinematic")?.aspect_ratio, "9:16");
  for (const content of ["继续", "segmented_script: 原文\naspect_ratio: 9:16", `${card}\naspect_ratio: 9:16`, card.replace("16:9", "1:1")]) {
    assert.equal(readStoryboardIntakeForMessage([...messages.slice(0, 2), { ...messages[2], content }, messages[3]], "assistant-B"), undefined);
  }
});

test("host activation time requires the current contract for new cards without upgrading historical replies", () => {
  const style = { production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: new Date(now).toISOString() };
  const messages = [
    { id: "old-user", role: "user", timestamp: now - 1 }, { id: "old-reply", role: "assistant", timestamp: now + 1 },
    { id: "new-user", role: "user", timestamp: now + 2 }, { id: "new-reply", role: "assistant", timestamp: now + 3 },
  ];
  assert.deepEqual(resolveStoryboardHandoffContract(messages, "old-reply", style), { allowLegacyUnverified: true });
  assert.equal(resolveStoryboardHandoffContract(messages, "new-reply", style).requiredVersion, "storyboard_director_contract.v2");
  assert.ok(resolveStoryboardHandoffContract(messages, "new-reply", { production_contract_version: style.production_contract_version }).error);
  assert.ok(resolveStoryboardHandoffContract([{ id: "user", role: "user" }, { id: "reply", role: "assistant" }], "reply", style).error);
  assert.deepEqual(resolveStoryboardHandoffContract(messages, "old-reply", {}), {});
  const message = { id: "reply", role: "assistant" as const, content: JSON.stringify(packageFixture) };
  assert.equal(buildHomepageStoryboardDraftDetail(message, originalInput, "storyboard_director_contract.v2"), null, "new card cannot drop the current output marker");
});

test("known pre-activation legacy replies keep core input checks while missing newer card choices remain unverified", () => {
  const historicalCard = { ...originalInput, owner_gender: "女主人", dog_breed: "金毛", video_model_profile: "自动通用", visual_asset_mode: "普通模式" };
  const message = { id: "legacy-reply", role: "assistant" as const, content: JSON.stringify(packageFixture) };
  assert.equal(buildHomepageStoryboardDraftDetail(message, historicalCard), null, "unknown provenance cannot invoke compatibility");
  const compatible = buildHomepageStoryboardDraftDetail(message, historicalCard, undefined, { allowLegacyUnverified: true });
  assert.ok(compatible); assert.equal(compatible.legacy_input_compatibility, true);
  assert.ok(createAgentWorkbenchHandoff(compatible, target));
  assert.equal(buildHomepageStoryboardDraftDetail(message, { ...historicalCard, aspect_ratio: "9:16" }, undefined, { allowLegacyUnverified: true }), null);
  assert.equal(buildHomepageStoryboardDraftDetail(message, historicalCard, "storyboard_director_contract.v2", { allowLegacyUnverified: true }), null);
});

console.log(JSON.stringify({ ok: true, checks, contract: "zero-network; per-click-ID; per-user-scope; exact-read; durable-save-ACK; two-minute-TTL" }, null, 2));
