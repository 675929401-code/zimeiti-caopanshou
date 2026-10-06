import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  type StoryboardDirectorPackage,
} from "../src/lib/storyboard-director-protocol";
import type { StructuredAgentOutputReadyDetail } from "../src/lib/structured-agent-output";
import {
  AGENT_WORKBENCH_HANDOFF_TTL_MS,
  agentWorkbenchHandoffStorageKey,
  createAgentWorkbenchHandoff,
  parseAgentWorkbenchHandoff,
  readAgentWorkbenchHandoff,
  saveAgentWorkbenchHandoff,
  type AgentWorkbenchHandoffStorage,
  type AgentWorkbenchHandoffTarget,
} from "../src/lib/agent-workbench-handoff";

class MemoryStorage implements AgentWorkbenchHandoffStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function fixturePackage(): StoryboardDirectorPackage {
  return {
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    director_mode: "cinematic",
    input: {
      schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
      segmented_script: "1.【雨夜里，女孩看见小狗追逐蓝色羽毛。】",
      director_mode: "cinematic",
      animation_style: "电影级温暖3D动画",
      aspect_ratio: "16:9",
      target_duration_seconds: 10,
      special_notes: "女孩与小狗造型必须保持一致。",
    },
    segments: [{
      segment_id: "segment_001",
      source_index: 1,
      narration: "雨夜里，女孩看见小狗追逐蓝色羽毛。",
      target_duration_seconds: 10,
      estimated_narration_duration: 3,
      panel_count: 4,
      layout: "two_by_two",
      pacing_mode: "medium",
      actual_shot_count: 3,
      shot_time_ranges: [
        { shot_id: "shot_01", start_seconds: 0, end_seconds: 3, action_beat: "女孩发现蓝色羽毛" },
        { shot_id: "shot_02", start_seconds: 3, end_seconds: 6.5, action_beat: "小狗追逐羽毛" },
        { shot_id: "shot_03", start_seconds: 6.5, end_seconds: 10, action_beat: "两者在窗边停下" },
      ],
      panoramic_anchor_role: null,
      continuity_links: [
        { from_shot: "shot_01", to_shot: "shot_02", link_type: "gaze_bridge", description: "女孩视线引向羽毛" },
        { from_shot: "shot_02", to_shot: "shot_03", link_type: "action_bridge", description: "追逐动作连续收束" },
      ],
      character_assets: ["黑发女孩，米色毛衣", "柯基犬，红色项圈"],
      semantic_visualizations: [{ trigger: "惊喜", visual_form: "蓝色柔光粒子", interaction: "随羽毛移动" }],
      storyboard_image_prompt: "严格4格2x2连续故事板，雨夜室内，女孩和柯基追逐蓝色羽毛。",
      image_to_video_prompt: "10秒，实际3个镜头。0-3秒发现；3-6.5秒追逐；6.5-10秒平稳收束。无对白。",
    }],
  };
}

const detail: StructuredAgentOutputReadyDetail = {
  message_id: "handoff-message-001",
  commit_key: "handoff-commit-001",
  schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  source: "stable_json",
  segments: [],
  machine_payload: fixturePackage(),
};

const now = Date.UTC(2026, 7, 27, 12, 0, 0);
const targets: AgentWorkbenchHandoffTarget[] = ["storyboard-workbench", "canvas", "film-studio"];

for (const target of targets) {
  const created = createAgentWorkbenchHandoff(detail, target, now);
  assert.ok(created, `${target} should accept a stable storyboard payload`);
  assert.equal(created.target, target);
  assert.equal(created.source_route, "/tools/text/text-chat");
  assert.equal(Date.parse(created.expires_at) - Date.parse(created.created_at), AGENT_WORKBENCH_HANDOFF_TTL_MS);

  const storage = new MemoryStorage();
  const saved = saveAgentWorkbenchHandoff(detail, target, storage);
  assert.ok(saved, `${target} handoff should persist`);
  const stored = storage.getItem(agentWorkbenchHandoffStorageKey(target));
  assert.ok(stored, `${target} should use a target-specific storage key`);
  storage.setItem(`agent_workbench_handoff_receipt_v1:${target}:${saved.handoff_id}`, JSON.stringify({ legacy: true }));

  const fresh = readAgentWorkbenchHandoff(target, storage, Date.now());
  if (!fresh.ok) throw new Error(fresh.error);
  assert.equal(fresh.ok, true, `${target} should read its own handoff`);
  assert.equal(fresh.handoff.target, target);
  assert.equal(storage.getItem(agentWorkbenchHandoffStorageKey(target)), null, `${target} payload should be removed before use`);
  assert.equal(storage.getItem(`agent_workbench_handoff_receipt_v1:${target}:${saved.handoff_id}`), null, `${target} legacy receipt should be removed`);
  const consumed = readAgentWorkbenchHandoff(target, storage, Date.now());
  if (consumed.ok) throw new Error("consumed handoff unexpectedly remained readable");
  assert.equal(consumed.ok, false);
  assert.equal(consumed.code, "MISSING");
}

const malformedStorage = new MemoryStorage();
malformedStorage.setItem(agentWorkbenchHandoffStorageKey("canvas"), "{broken");
const malformed = readAgentWorkbenchHandoff("canvas", malformedStorage, now);
assert.equal(malformed.ok, false);
assert.equal(malformedStorage.getItem(agentWorkbenchHandoffStorageKey("canvas")), null, "malformed payload must be deleted before parse");

const validEnvelope = createAgentWorkbenchHandoff(detail, "canvas", now);
assert.ok(validEnvelope);
const mismatch = parseAgentWorkbenchHandoff(JSON.stringify(validEnvelope), "film-studio", { nowMs: now + 1 });
if (mismatch.ok) throw new Error("target mismatch unexpectedly passed");
assert.equal(mismatch.ok, false);
assert.equal(mismatch.code, "TARGET_MISMATCH");

const expired = parseAgentWorkbenchHandoff(JSON.stringify(validEnvelope), "canvas", {
  nowMs: now + AGENT_WORKBENCH_HANDOFF_TTL_MS + 1,
});
if (expired.ok) throw new Error("expired handoff unexpectedly passed");
assert.equal(expired.ok, false);
assert.equal(expired.code, "EXPIRED");

assert.equal(createAgentWorkbenchHandoff({ ...detail, source: "legacy_text_blocks" }, "canvas", now), null);
assert.equal(createAgentWorkbenchHandoff({ ...detail, commit_key: "" }, "canvas", now), null);

const root = process.cwd();
const agentSource = readFileSync(join(root, "src/features/official-core-routes/official-agent-route.tsx"), "utf8");
const storyboardSource = readFileSync(join(root, "src/components/storyboard-workbench.tsx"), "utf8");
const canvasSource = readFileSync(join(root, "src/components/manual-canvas.tsx"), "utf8");
const filmSource = readFileSync(join(root, "src/features/youcai-film-studio/youcai-film-studio-portal.tsx"), "utf8");

for (const route of [
  "/storyboard-workbench?entry=agent&handoff=storyboard",
  "/storyboard-workbench?entry=agent&handoff=storyboard&legacy=canvas",
  "/tools/film-studio?entry=agent&handoff=storyboard",
]) {
  assert.ok(agentSource.includes(route), `Agent should expose ${route}`);
}
assert.ok(agentSource.includes('result.kind !== "storyboard_director"') || agentSource.includes('result.kind === "storyboard_director"'));
assert.ok(agentSource.includes('result.source !== "stable_json"') || agentSource.includes('result.source === "stable_json"'));

assert.ok(storyboardSource.includes('readAgentWorkbenchHandoff("storyboard-workbench"'));
assert.ok(storyboardSource.includes('data-testid="agent-storyboard-handoff-confirm"'));
assert.ok(storyboardSource.includes("agentHandoffConsumedRef.current = true"));
assert.equal(storyboardSource.includes("acknowledgeAgentWorkbenchHandoff"), false);

assert.ok(canvasSource.includes('readAgentWorkbenchHandoff("canvas")'));
assert.ok(canvasSource.includes('searchParams.get("entry") !== "agent"'));
assert.ok(canvasSource.includes("确认导入"));
assert.equal(canvasSource.includes("STRUCTURED_AGENT_OUTPUT_READY_EVENT"), false, "Canvas must not auto-consume the global Agent event");
assert.ok(canvasSource.includes("agentHandoffConsumedRef.current = true"));
assert.equal(canvasSource.includes("acknowledgeAgentWorkbenchHandoff"), false);

assert.ok(filmSource.includes('readAgentWorkbenchHandoff("film-studio")'));
assert.ok(filmSource.includes('fetch("/api/short-drama/projects"'));
assert.ok(filmSource.includes("/api/short-drama/projects/${encodeURIComponent(projectId)}"));
assert.ok(filmSource.indexOf("const readback = await fetch") < filmSource.indexOf("router.push(`/tools/film-studio/projects/"));
assert.ok(filmSource.includes("agentHandoffConsumedRef.current = true"));
assert.equal(filmSource.includes("acknowledgeAgentWorkbenchHandoff"), false);
assert.ok(filmSource.includes("确认后只创建项目，不会生成图片或视频"));

console.log(JSON.stringify({
  ok: true,
  targets,
  tests: 48,
  contract: "stable-json-only; target-scoped; two-minute-delete-before-parse; explicit-confirm; film-readback-before-navigation",
}, null, 2));
