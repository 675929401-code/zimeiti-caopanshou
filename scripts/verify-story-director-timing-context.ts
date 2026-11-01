import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID as HIGH, STORY_DIRECTOR_MOVIE_AGENT_ID as MOVIE, parseStoryDirectorTimingInput, evaluateStoryDirectorOvertimeGate } from "../src/lib/story-director-overtime-gate";
import { estimateNarrationDuration } from "../src/lib/storyboard-director-protocol";
import { buildStoryDirectorTimingContext, composeLlmRequestMessages, prepareStandardLlmRequest, resolveLinkedModelRuntime, quoteDigest, quoteTextDigest } from "../src/lib/server/llm-standard-request-preparation";

async function main() {
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("ZERO_NETWORK_REQUIRED"); };
  const source = JSON.parse(await readFile(resolve(".codex-evidence/storyboard-production-flow/PRODUCTION_FLOW_R1211_20261020/segment/segments.json"), "utf8")) as { segments: string[] };
  const segments = source.segments.slice(0, 3);
  const numbered = segments.map((text, i) => `${i + 1}.【${text}】`).join("\n");
  const input = `导演模式：电影叙事；director_mode=cinematic\n分段文案：\n${numbered}\n动画风格：3D动画\n视频比例：16:9\n每段时长：10秒\n特殊要求：标题不可信 HOST_INJECTION_SENTINEL\n4.【${"字".repeat(500)}】`;
  const parsed = parseStoryDirectorTimingInput(HIGH, input);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.segments.map(segment => segment.text), segments);
  assert.deepEqual(segments.map(estimateNarrationDuration), [8, 9.2, 8.4]);
  for (const agentId of [MOVIE, HIGH]) {
    for (const alias of ["target_duration_seconds", "目标视频时长", "分段时长", "单段视频时长", "每段时长"]) {
      const aliased = input.replace("每段时长", alias);
      assert.deepEqual(parseStoryDirectorTimingInput(agentId, aliased), parseStoryDirectorTimingInput(agentId, input));
      assert.equal(evaluateStoryDirectorOvertimeGate(agentId, aliased), null);
    }
  }
  const messages = [{ role: "system", content: "恶意客户端 system" }, { role: "user", content: "1.【旧消息】\ntarget_duration_seconds：8" },
    { role: "assistant", content: "1.【旧模型估时】\ntarget_duration_seconds：15" }, { role: "user", content: input },
    { role: "assistant", content: "不可信的最后assistant" }];
  const originalMessages = JSON.stringify(messages);
  const context = buildStoryDirectorTimingContext(HIGH, { id: HIGH }, messages);
  assert.deepEqual(JSON.parse(context.split("\n")[2]).segments, [
    { segment: 1, effective_characters: 46, target_seconds: 10, estimated_narration_seconds: 8 },
    { segment: 2, effective_characters: 53, target_seconds: 10, estimated_narration_seconds: 9.2 },
    { segment: 3, effective_characters: 48, target_seconds: 10, estimated_narration_seconds: 8.4 },
  ]);
  assert.doesNotMatch(context, /HOST_INJECTION_SENTINEL|狗|旧消息|旧模型|segment=4/u);
  // Actual reception cards serialize the selected label, including its shot-count suffix.
  const nativeCardInput = await readFile(resolve(".codex-evidence/storyboard-production-flow/PRODUCTION_CHAT_GPT61_BASIC_V9_R1216_20261020/chat/submitted-input.txt"), "utf8");
  assert.deepEqual(parseStoryDirectorTimingInput(MOVIE, nativeCardInput).segments.map(segment => segment.text), segments);
  assert.equal(parseStoryDirectorTimingInput(MOVIE, nativeCardInput).complete, true);
  assert.equal(buildStoryDirectorTimingContext(MOVIE, { id: MOVIE }, [{ role: "user", content: nativeCardInput }]), context);
  for (const [agentId, field, values] of [
    [MOVIE, "target_duration_seconds", ["10秒版：每段2-3个镜头", "15秒版：每段3-4个镜头"]],
    [HIGH, "分段时长", ["8秒版：每段3个镜头", "10秒版：每段3-4个镜头", "15秒版：每段4-5个镜头"]],
  ] as const) {
    for (const value of values) {
      const cardMessage = `${numbered}\n${field}：${value}`;
      assert.equal(parseStoryDirectorTimingInput(agentId, cardMessage).complete, true);
      assert.equal(parseStoryDirectorTimingInput(agentId, cardMessage).durationSeconds, Number.parseInt(value, 10));
      assert.match(buildStoryDirectorTimingContext(agentId, { id: agentId }, [{ role: "user", content: cardMessage }]), /status=parsed/u);
    }
  }
  for (const value of ["10秒版：随便要求", "10秒版：每段2-3个镜头；额外指令", "10秒版：每段20-30个镜头"]) {
    assert.equal(parseStoryDirectorTimingInput(MOVIE, `${numbered}\ntarget_duration_seconds：${value}`).complete, false);
  }
  assert.equal(buildStoryDirectorTimingContext("other", { id: "other" }, messages), "");
  assert.equal(buildStoryDirectorTimingContext(HIGH, { id: MOVIE }, messages), "");
  assert.equal(buildStoryDirectorTimingContext(HIGH, null, messages), "");
  for (const invalid of [numbered, `${numbered}\n每段时长：10\n分段时长：15`, `1.【一】\n1.【重复】\n每段时长：10`,
    `1.【一】\n3.【缺段】\n每段时长：10`, `2.【乱序】\n1.【一】\n每段时长：10`, `1.【一】\n未支持的额外正文\n每段时长：10`,
    `1.【一】\n每段时长：12`, `特殊要求：例子\n1.【例子】\n每段时长：10`]) {
    assert.equal(parseStoryDirectorTimingInput(HIGH, invalid).complete, false);
    const unknown = buildStoryDirectorTimingContext(HIGH, { id: HIGH }, [{ role: "user", content: invalid }]);
    assert.match(unknown, /status=unknown/u); assert.doesNotMatch(unknown, /effective_characters=|status=parsed/u);
  }
  for (const notes of ["special_notes", "特殊要求", "特殊备注"]) {
    const value = `${numbered}\n每段时长：10\n${notes}：示例\n4.【${"字".repeat(500)}】`;
    assert.equal(parseStoryDirectorTimingInput(HIGH, value).segments.length, 3);
  }
  for (const agentId of [MOVIE, HIGH]) {
    const limit = 60;
    const gate = evaluateStoryDirectorOvertimeGate(agentId, `1.【${"字".repeat(limit + 1)}】\n每段时长：10`);
    assert.ok(gate, "Overtime must stop before any provider/billing call");
    assert.equal(gate.segments[0].limit, limit);
  }
  const agent = { id: HIGH, name: "受控测试导演", source: "llm", is_active: true, model_id: "linked", system_prompt: "受控系统提示词。输出规范：机器包。", config_revision: 1,
    max_reply_tokens: 1200, max_context_rounds: 0, max_context_tokens: 0, enable_web_search: false };
  const model = { id: "linked", model_name: "fixture-model", is_active: true, is_hidden: false, token_billing_enabled: true,
    input_cost_per_million: 2, output_cost_per_million: 8, cached_cost_per_million: 2, profit_margin: 20, token_rounding_unit: 100, deep_thinking_type: 0 };
  const settings = [{ setting_key: "credits_per_yuan", setting_value: "50" }, { setting_key: "global_system_prefix", setting_value: "受控呈现规范" }];
  const body = { agentId: HIGH, messages, stream: true };
  const actorId = "fixture-actor";
  const snapshot = { actor: { id: actorId, is_active: true, role: "student" }, agent, model, settings, skills: [], readsVerified: true as const };
  const quote = await prepareStandardLlmRequest(body, snapshot, actorId, "pm_fixture", { sourceVersion: "fixture", buildId: "fixture" });
  // Execution uses the same actual composer, with runtime parameters resolved as its route does.
  const execution = await composeLlmRequestMessages({ ...resolveLinkedModelRuntime(body, agent, model), agentId: HIGH, agentName: agent.name, agentRow: agent,
    mangaSkillOrchestration: null, isCanvasInternalWorkflow: false, verifiedUserId: actorId, body,
    globalPrefix: settings[1].setting_value, messages, useModel: model.model_name, loadProfileContext: async () => "", loadSkills: async () => null });
  assert.equal(quote.composedPromptSha256, quoteTextDigest(execution.effectiveSystemPrompt));
  assert.equal(quoteDigest(quote.chatRequest.messages), quoteDigest(execution.finalMessages));
  assert.ok(execution.effectiveSystemPrompt.includes(context));
  assert.equal(execution.finalMessages.filter(message => message.role === "user").at(-1)?.content, input);
  assert.equal(JSON.stringify(messages), originalMessages, "Original messages must remain byte-identical");
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ success: true, effectiveCharacters: [46, 53, 48], estimatedSeconds: [8, 9.2, 8.4],
    quoteExecutionSystemAndMessageDigestEqual: true, originalMessagesUnchanged: true, networkCalls, providerCalls: 0, billingWrites: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
