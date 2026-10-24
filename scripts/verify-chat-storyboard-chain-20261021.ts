/* eslint-disable @typescript-eslint/no-non-null-assertion -- isolated renderer contract uses a fixed fixture selector */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { buildHomepageStoryboardDraftDetail } from "../src/lib/agent-workbench-handoff";
import { renderMarkdown, renderStreamingText, clearStreamingCache } from "../src/lib/markdown-renderer";
import { STORYBOARD_DIRECTOR_ARTIFACT_TYPE, STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION, STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION } from "../src/lib/storyboard-director-protocol";

function fixturePackage() {
  return {
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    director_mode: "cinematic",
    input: {
      schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
      segmented_script: "1.【雨夜里，女孩看见小狗追逐蓝色羽毛。】",
      director_mode: "cinematic" as const,
      animation_style: "电影级温暖3D动画",
      aspect_ratio: "16:9" as const,
      target_duration_seconds: 10 as const,
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

const fixture = fixturePackage();
const message = { id: "current-message", role: "assistant" as const, content: JSON.stringify(fixture) };
assert.ok(buildHomepageStoryboardDraftDetail(message, fixture.input));

const root = process.cwd();
const contentSource = readFileSync(`${root}/src/components/chat/message-content.tsx`, "utf8");
const itemSource = readFileSync(`${root}/src/components/chat/message-item.tsx`, "utf8");
const handoffSource = readFileSync(`${root}/src/components/chat/structured-storyboard-handoff.tsx`, "utf8");
assert.match(contentSource, /hasStoryboardPromptPushCapability/u);
assert.match(contentSource, /data-video-task-send/iu);
assert.match(itemSource, /hasStoryboardPromptPushCapability/u);
assert.match(itemSource, /StructuredStoryboardHandoff/iu);
assert.match(handoffSource, /chat-storyboard-film-handoff/iu);
assert.match(handoffSource, /推送至分镜工作台/u);

async function main() {
  const selector = contentSource.match(/target\.querySelectorAll\(\s*"([^"]+)"/u)?.[1];
  assert.ok(selector);
  const browser = await chromium.launch({ headless: true });
  let checks = 0;
  try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  const markdown = "```prompt\nFrame 1: hello\n```";
  for (const [phase, html] of [["final", renderMarkdown(markdown)], ["streaming", renderStreamingText(markdown, "chat-chain-fixture")]] as const) {
    for (const handoffEnabled of [true, false]) {
      const domResult: { before: number; after: number; copy: number; text?: string | null } = await page.evaluate(({ html: sourceHtml, actionSelector, enabled }) => {
        const target = document.createElement("div");
        target.innerHTML = sourceHtml;
        const before = target.querySelectorAll(actionSelector).length;
        if (enabled) target.querySelectorAll(actionSelector).forEach(action => action.remove());
        return {
          before,
          after: target.querySelectorAll(actionSelector).length,
          copy: target.querySelectorAll(".copy-code-button").length,
          text: target.querySelector("code")?.textContent,
        };
      }, { html, actionSelector: selector, enabled: handoffEnabled });
      assert.equal(domResult.before, 2, phase);
      assert.equal(domResult.after, handoffEnabled ? 0 : 2, phase);
      assert.equal(domResult.copy, 1, phase);
      assert.equal(domResult.text?.trim(), "Frame 1: hello", phase);
      checks += 1;
    }
  }
  } finally {
    clearStreamingCache("chat-chain-fixture");
    await browser.close();
  }

  const result = {
    ok: true,
    checks: checks + 6,
    network: "blocked",
    scope: "stable storyboard fixture, capability-aware chat source contract, and renderer DOM action removal; no provider or database calls",
  };
  writeFileSync(`${root}/.codex-evidence/storyboard-platform-chain-20261021/chat-check.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
