import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
  STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  renderStoryboardDirectorPackage,
  type StoryboardDirectorPackage,
} from "../src/lib/storyboard-director-protocol";
import {
  IncrementalStructuredOutputSession,
  parseStructuredAgentOutput,
  publishStructuredAgentOutputOnce,
} from "../src/lib/structured-agent-output";
import { mergeContinuationText, SseEventStreamDecoder } from "../src/lib/sse-stream-decoder";
import { AGENT_PROMPT_PACKAGE_VERSION } from "../src/lib/agent-engineer-protocol";
import { MessageContent } from "../src/components/chat/message-content";

function fixturePackage(): StoryboardDirectorPackage {
  return {
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    director_mode: "cinematic",
    input: {
      schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
      segmented_script: "1.【狗狗听见钥匙声，立刻紧张起来。】\n2.【主人蹲下拥抱它，它终于放心。】",
      director_mode: "cinematic",
      animation_style: "温暖家庭3D动画电影",
      aspect_ratio: "16:9",
      target_duration_seconds: 10,
      special_notes: "成年金毛，蜂蜜金长毛；中国青年女性，白色针织衫和深蓝牛仔裤。",
    },
    segments: [
      {
        segment_id: "segment_001",
        source_index: 1,
        narration: "狗狗听见钥匙声，立刻紧张起来。",
        target_duration_seconds: 10,
        estimated_narration_duration: 2.5,
        panel_count: 4,
        layout: "two_by_two",
        pacing_mode: "medium",
        actual_shot_count: 3,
        shot_time_ranges: [
          { shot_id: "shot_01", start_seconds: 0, end_seconds: 3, action_beat: "听见钥匙并停住" },
          { shot_id: "shot_02", start_seconds: 3, end_seconds: 6.5, action_beat: "紧张后退并观察" },
          { shot_id: "shot_03", start_seconds: 6.5, end_seconds: 10, action_beat: "贴近门边确认声音来源" },
        ],
        panoramic_anchor_role: null,
        continuity_links: [
          { from_shot: "shot_01", to_shot: "shot_02", link_type: "sound_bridge", description: "钥匙声延续到后退动作" },
          { from_shot: "shot_02", to_shot: "shot_03", link_type: "gaze_bridge", description: "视线延续到门边确认" },
        ],
        character_assets: ["成年金毛，蜂蜜金长毛，棕色眼睛", "中国青年女性，白色针织衫，深蓝牛仔裤"],
        semantic_visualizations: [{ trigger: "紧张", visual_form: "胸前柔和脉冲线与耳侧抖动线", interaction: "随呼吸收缩，不遮挡面部" }],
        storyboard_image_prompt: "4格2×2连续故事板。钥匙发出清脆声，金毛耳朵竖起，胸前脉冲线由弱变强；路径 C:\\story\\key。不要五格。",
        image_to_video_prompt: "10秒，实际3个镜头。0-3秒缓慢推进，金毛耳朵竖起；3-6.5秒跟随它小步后退；6.5-10秒贴近门边确认，胸前脉冲线随呼吸跳动。不要让角色开口说话。",
      },
      {
        segment_id: "segment_002",
        source_index: 2,
        narration: "主人蹲下拥抱它，它终于放心。",
        target_duration_seconds: 10,
        estimated_narration_duration: 2.5,
        panel_count: 5,
        layout: "four_plus_panorama",
        pacing_mode: "slow",
        actual_shot_count: 3,
        shot_time_ranges: [
          { shot_id: "shot_01", start_seconds: 0, end_seconds: 3, action_beat: "主人蹲下伸手" },
          { shot_id: "shot_02", start_seconds: 3, end_seconds: 6, action_beat: "金毛试探靠近" },
          { shot_id: "shot_03", start_seconds: 6, end_seconds: 10, action_beat: "拥抱后共同放松" },
        ],
        panoramic_anchor_role: "底部全宽画面承担关系和解与客厅空间收束",
        continuity_links: [
          { from_shot: "shot_01", to_shot: "shot_02", link_type: "gesture_bridge", description: "伸手方向引导金毛靠近" },
          { from_shot: "shot_02", to_shot: "shot_03", link_type: "contact_bridge", description: "鼻尖触手延续到拥抱" },
        ],
        character_assets: ["成年金毛，蜂蜜金长毛，棕色眼睛", "中国青年女性，白色针织衫，深蓝牛仔裤"],
        semantic_visualizations: [{ trigger: "放心", visual_form: "胸前脉冲线逐渐化为暖金色柔光", interaction: "光线沿拥抱接触处扩散" }],
        storyboard_image_prompt: "top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel。四个小格表现靠近、蹲下、试探、拥抱；底部全宽格表现客厅全貌与暖光收束。不要上2下3等宽。",
        image_to_video_prompt: "10秒，实际3个镜头。0-3秒镜头从门口平稳横移，女人蹲下张开手臂；3-6秒金毛迟疑后贴近；6-10秒拥抱收束，尾巴轻摆，暖光在接触处扩散。无对白。",
      },
    ],
  };
}

function makeSse(id: string, content: string): string {
  return `id: ${id}\nevent: message\ndata: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function chunkBytes(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < bytes.length) {
    const size = sizes[sizeIndex++ % sizes.length];
    chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + size)));
    offset += size;
  }
  return chunks;
}

function consumeSse(chunks: Uint8Array[]): { content: string; firstEventMs: number; eventCount: number } {
  const decoder = new SseEventStreamDecoder();
  const started = performance.now();
  let firstEventMs = -1;
  let content = "";
  let eventCount = 0;
  for (const chunk of chunks) {
    const events = decoder.push(chunk);
    for (const event of events) {
      if (firstEventMs < 0) firstEventMs = performance.now() - started;
      eventCount++;
      const parsed = JSON.parse(event.data);
      content += parsed.choices?.[0]?.delta?.content ?? "";
    }
  }
  for (const event of decoder.finish()) {
    if (firstEventMs < 0) firstEventMs = performance.now() - started;
    eventCount++;
    const parsed = JSON.parse(event.data);
    content += parsed.choices?.[0]?.delta?.content ?? "";
  }
  return { content, firstEventMs, eventCount };
}

const pkg = fixturePackage();
const rendered = renderStoryboardDirectorPackage(pkg);
const stable = parseStructuredAgentOutput(rendered, true);
assert.equal(stable.status, "valid");
assert.equal(stable.kind, "storyboard_director");
assert.equal(stable.source, "stable_json");
assert.equal(stable.segments.length, 2);
assert.deepEqual(stable.segments.map((segment) => [segment.panel_count, segment.layout]), [
  [4, "two_by_two"],
  [5, "four_plus_panorama"],
]);
assert.equal(stable.segments[0].image_prompt.includes("C:\\story\\key"), true);
assert.equal(stable.segments[1].actual_shot_count, 3);

const renderedHtml = renderToStaticMarkup(React.createElement(MessageContent, {
  text: rendered,
  messageId: "render-fixture",
  isUser: false,
  isStreaming: false,
}));
assert.equal(renderedHtml.includes("稳定协议已解析"), false, "protocol diagnostics must stay out of agent replies");
assert.equal(renderedHtml.includes("<details"), false, "machine JSON diagnostics must remain hidden from users");

const session = new IncrementalStructuredOutputSession();
for (const char of rendered) {
  session.append(char);
  assert.notEqual(session.snapshot().status, "valid", "streaming content must not commit early");
}
const completed = session.finish();
assert.equal(completed.status, "valid");

const pieces = [rendered.slice(0, 37), rendered.slice(37, 311), rendered.slice(311)];
const sseText = [makeSse("evt-1", pieces[0]), makeSse("evt-2", pieces[1]), makeSse("evt-2", pieces[1]), makeSse("evt-3", pieces[2])].join("");
const encoded = new TextEncoder().encode(sseText);
const oneByte = consumeSse(chunkBytes(encoded, [1]));
assert.equal(oneByte.content, rendered, "one-byte chunks and duplicate event ids must reconstruct exactly once");
assert.equal(oneByte.eventCount, 3);

const randomChunks = consumeSse(chunkBytes(encoded, [7, 1, 19, 3, 64, 2, 11]));
assert.equal(randomChunks.content, rendered, "random chunks must preserve Chinese, fences, escapes and JSON");
assert.equal(parseStructuredAgentOutput(randomChunks.content, true).status, "valid");

const reordered = {
  segments: pkg.segments,
  input: pkg.input,
  director_mode: pkg.director_mode,
  artifact_type: pkg.artifact_type,
  schema_version: pkg.schema_version,
};
assert.equal(parseStructuredAgentOutput(`\`\`\`json\n${JSON.stringify(reordered)}\n\`\`\``, true).status, "valid");

const legacyFrame = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown> & { segments: Array<Record<string, unknown>> };
for (const segment of legacyFrame.segments) {
  segment.frame_count = segment.panel_count;
  delete segment.panel_count;
  delete segment.layout;
  delete segment.pacing_mode;
  delete segment.actual_shot_count;
  delete segment.panoramic_anchor_role;
}
const parsedLegacyFrame = parseStructuredAgentOutput(`\`\`\`json\n${JSON.stringify(legacyFrame)}\n\`\`\``, true);
assert.equal(parsedLegacyFrame.status, "valid");
assert.deepEqual(parsedLegacyFrame.segments.map((segment) => segment.panel_count), [4, 5]);

const legacyBlocks = [
  "**段落 1**：狗狗听见钥匙声。",
  "```text",
  "4格2×2故事板，金毛耳朵竖起，胸前出现脉冲线。",
  "```",
  "```text",
  "10秒实际2镜头，先推进再跟随，金毛后退并发抖。",
  "```",
].join("\n");
const legacyParsed = parseStructuredAgentOutput(legacyBlocks, true);
assert.equal(legacyParsed.status, "valid");
assert.equal(legacyParsed.source, "legacy_text_blocks");
assert.equal(legacyParsed.segments[0].panel_count, 4);

const partial = "第一段完整。第二段输";
const resumed = "第二段输出完成。第三段完整。";
assert.equal(mergeContinuationText(partial, resumed), "第一段完整。第二段输出完成。第三段完整。");

const malicious = [
  "我声称 schema_version 是 storyboard_director_output.v1。",
  "```json",
  JSON.stringify({ schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION, artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE, segments: [{ image_to_video_prompt: "偷换字段" }] }),
  "```",
].join("\n");
assert.equal(parseStructuredAgentOutput(malicious, true).status, "invalid", "pseudo JSON must never map into cards");

const agentPackage = {
  platform: { output_schema_version: AGENT_PROMPT_PACKAGE_VERSION },
  regression_cases: [{ id: "case-1", input: "测试" }],
  output_contract: { type: "object" },
  preset_fields: [],
  system_prompt: "你是一个通过需求账本维护上下文的智能体工程师。",
  change_summary: ["保留早期要求"],
  agent: { version: "5.1", name: "智能体工程师", id: "agent-engineer" },
  artifact_type: "agent_prompt_package",
  schema_version: AGENT_PROMPT_PACKAGE_VERSION,
};
const parsedAgentPackage = parseStructuredAgentOutput(`\`\`\`json\n${JSON.stringify(agentPackage)}\n\`\`\``, true);
assert.equal(parsedAgentPackage.status, "valid");
assert.equal(parsedAgentPackage.kind, "agent_prompt_package");
assert.equal(parsedAgentPackage.segments.length, 0);

if (stable.status === "valid") {
  const firstCommit = publishStructuredAgentOutputOnce("mock-message-1", stable);
  const duplicateCommit = publishStructuredAgentOutputOnce("mock-message-1", stable);
  assert.ok(firstCommit);
  assert.equal(duplicateCommit, null, "same completed message must commit once");
}

const parseStarted = performance.now();
const parsedAgain = parseStructuredAgentOutput(oneByte.content, true);
const completeParseMs = performance.now() - parseStarted;
assert.equal(parsedAgain.status, "valid");
assert.ok(oneByte.firstEventMs >= 0);
assert.ok(completeParseMs < 500, `local parse should remain interactive, got ${completeParseMs.toFixed(2)}ms`);

console.log(JSON.stringify({
  ok: true,
  tests: 14,
  first_chunk_render_ms: Number(oneByte.firstEventMs.toFixed(3)),
  complete_parse_ms: Number(completeParseMs.toFixed(3)),
  reconstructed_characters: oneByte.content.length,
  stable_segments: stable.status === "valid" ? stable.segments.length : 0,
}, null, 2));
