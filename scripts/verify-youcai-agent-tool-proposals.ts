import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  MANJU_SKILL_OUTPUT_ARTIFACT_TYPE,
  MANJU_SKILL_OUTPUT_SCHEMA_VERSION,
  type ManjuSkillOutput,
} from "../src/lib/manju-skill-output-protocol";
import { parseStructuredAgentOutput } from "../src/lib/structured-agent-output";
import {
  YOUCAI_AGENT_WORKBENCH_ROUTES,
  YOUCAI_MUSIC_PREFILL_KEY,
  YOUCAI_VIDEO_PREFILL_KEY,
} from "../src/lib/youcai-agent-routing";
import {
  IMAGE_WORKBENCH_TRANSFER_KEY,
  IMAGE_WORKBENCH_TRANSFER_SESSION_KEY,
} from "../src/lib/image-workbench-transfer";

const root = process.cwd();
const sourcePath = path.join(root, "src/features/official-core-routes/official-agent-route.tsx");
const stylePath = path.join(root, "src/features/official-core-routes/official-agent-route.module.css");
const source = readFileSync(sourcePath, "utf8");
const styles = readFileSync(stylePath, "utf8");

function sourceSlice(startToken: string, endToken: string): string {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0, `missing source start token: ${startToken}`);
  assert.ok(end > start, `missing source end token: ${endToken}`);
  return source.slice(start, end);
}

const payload: ManjuSkillOutput = {
  schema_version: MANJU_SKILL_OUTPUT_SCHEMA_VERSION,
  artifact_type: MANJU_SKILL_OUTPUT_ARTIFACT_TYPE,
  skill: {
    id: "verify-image-prompt",
    command: "/image-prompt",
    version: "1.0.0",
    selection: "explicit",
    provenance: "public_contract_reimplementation",
  },
  status: "tool_proposed",
  result: { kind: "prompt_text", payload: "四类媒体提示词已经整理" },
  tool_proposals: [
    { type: "generate_image", reason: "把图片提示词带入图片工作台", input: { image_prompt: "蓝紫色电影场景" }, requires_authorization: true },
    { type: "generate_video", reason: "把镜头动作带入视频工作台", input: { video_prompt: "镜头缓慢前推" }, requires_authorization: true },
    { type: "generate_audio", reason: "把旁白要求交给音频工作台", input: { audio_prompt: "温暖青年男声" }, requires_authorization: true },
    { type: "generate_music", reason: "把配乐要求带入音乐工作台", input: { music_prompt: "轻快木吉他" }, requires_authorization: true },
    { type: "open_workbench", reason: "打开图片工作台继续编辑", input: { target: "image" }, requires_authorization: false },
  ],
  quality: {
    passed: true,
    score: 92,
    hard_constraints_satisfied: ["只输出工具提案"],
    issues: [],
  },
};

const visibleCopy = "已完成可编辑提示词。";
const machineEnvelope = `<!-- manju_skill_output:v1\n${JSON.stringify(payload)}\n-->`;
const parsed = parseStructuredAgentOutput(`${visibleCopy}\n\n${machineEnvelope}`, true);
assert.equal(parsed.status, "valid", "complete manju_skill_output must parse");
assert.ok(parsed.status === "valid" && parsed.kind === "manju_skill_output");
assert.equal(parsed.visible_text, visibleCopy, "machine envelope must be removed from visible text");
assert.equal((parsed.machine_payload as ManjuSkillOutput).tool_proposals.length, 5);

const incomplete = parseStructuredAgentOutput(`${visibleCopy}\n<!-- manju_skill_output:v1\n{`, false);
assert.equal(incomplete.status, "incomplete", "streaming machine envelope must stay uncommitted");

const requiredSourceContracts: Array<[string, string]> = [
  ["structured parser", "parseStructuredAgentOutput(rawText, !message.isStreaming)"],
  ["typed skill output", "structuredOutput.machine_payload as ManjuSkillOutput"],
  ["machine envelope defense", "hideManjuSkillEnvelope(readableText)"],
  ["pending confirmation section", "data-testid=\"agent-tool-proposals\""],
  ["per-proposal action", "data-testid={`agent-tool-proposal-action-${index}`}"],
  ["safe handoff callback", "handleToolProposalHandoff"],
  ["image prefill", "appendImageWorkbenchPromptTransfer(prefill)"],
  ["video prefill", "storeYoucaiVideoPrefill(prefill)"],
  ["music prefill", "storeYoucaiMusicPrefill(prefill)"],
  ["audio route", "AUDIO_WORKBENCH_ROUTE = \"/voice-studio/workspace\""],
  ["no-generation disclosure", "当前未生成、未创建任务、未扣费"],
  ["model and price confirmation", "选择已发布模型、查看价格并主动提交"],
];
for (const [label, token] of requiredSourceContracts) {
  assert.ok(source.includes(token), `missing source contract: ${label}`);
}

for (const key of [
  "prompt",
  "brief",
  "text",
  "content",
  "description",
  "image_prompt",
  "video_prompt",
  "audio_prompt",
  "music_prompt",
  "script",
  "lyrics",
  "narration",
]) {
  assert.ok(source.includes(`\"${key}\"`), `missing proposal input allowlist key: ${key}`);
}
for (const forbidden of ["proposal.input.route", "proposal.input.href", "proposal.input.url", "window.open("]) {
  assert.ok(!source.includes(forbidden), `unsafe proposal navigation contract found: ${forbidden}`);
}

const handoffSource = sourceSlice("const handleToolProposalHandoff", "function handleMessageAction");
assert.ok(!/fetch\s*\(/u.test(handoffSource), "handoff must not call any network endpoint");
assert.ok(!/(?:generate|billing|payment|charge|deduct)[^\n]{0,80}fetch\s*\(/iu.test(handoffSource), "handoff must not submit generation or billing");
assert.ok(handoffSource.includes("router.push(meta.route)"), "handoff must use the scoped in-app router");

const requiredStyleContracts = [
  ".toolProposalSection",
  ".toolProposalGrid",
  ".toolProposalCard",
  ".toolProposalSafety",
  ".toolProposalCard > button:disabled",
  "grid-template-columns: repeat(2, minmax(0, 1fr))",
  "grid-template-columns: 1fr",
];
for (const token of requiredStyleContracts) {
  assert.ok(styles.includes(token), `missing tool proposal style contract: ${token}`);
}

assert.deepEqual(YOUCAI_AGENT_WORKBENCH_ROUTES, {
  image: "/tools/image/image-chat",
  video: "/video",
  music: "/tools/audio/minimax-music",
});
assert.equal(IMAGE_WORKBENCH_TRANSFER_SESSION_KEY, "agent_hub_image_workbench_transfer_session_v1");
assert.equal(IMAGE_WORKBENCH_TRANSFER_KEY, "agent_hub_image_workbench_transfer_v1");
assert.equal(YOUCAI_VIDEO_PREFILL_KEY, "video_smart_import_text");
assert.equal(YOUCAI_MUSIC_PREFILL_KEY, "youcai_music_brief_prefill_v1");

for (const routeFile of [
  "src/app/youcai/tools/image/image-chat/page.tsx",
  "src/app/youcai/video/page.tsx",
  "src/app/youcai/tools/audio/minimax-music/page.tsx",
  "src/app/youcai/voice-studio/workspace/page.tsx",
]) {
  assert.ok(existsSync(path.join(root, routeFile)), `verified in-app route is missing: ${routeFile}`);
}

console.log(JSON.stringify({
  ok: true,
  proposalTypes: payload.tool_proposals.map((proposal) => proposal.type),
  machineEnvelopeHidden: parsed.visible_text === visibleCopy,
  verifiedRoutes: {
    ...YOUCAI_AGENT_WORKBENCH_ROUTES,
    audio: "/voice-studio/workspace",
  },
  zeroNetwork: true,
  zeroPaidGeneration: true,
  buildRestart: false,
}, null, 2));
