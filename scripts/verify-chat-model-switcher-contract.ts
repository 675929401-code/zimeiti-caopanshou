/**
 * 零网络合同验证：对话模型切换只认公开目录中的 GPT / Claude / DeepSeek，
 * 清理内部标注、同名去重，并保持 pm_ 标识不变。
 *
 * 运行：
 * node ./scripts/run-node-maintenance-tsx.mjs ./scripts/verify-chat-model-switcher-contract.ts
 */
import assert from "node:assert/strict";
import { chatModelSwitcherDisplayGroups } from "../src/lib/chat-model-switcher-display";

import {
  allChatModelOptions,
  buildChatModelGroups,
  chatModelSelectionScope,
  chatModelSelectionStorageKey,
  chatModelBrand,
  defaultChatModelOption,
  resolveChatModelId,
  newConversationChatModelSelection,
  selectedChatModelLabel,
} from "../src/lib/chat-model-catalog";

// 取自 127.0.0.1:5000/api/chat-models 的真实公开显示名，仅作为归一化夹具。
const DIRECTORY_FIXTURE = [
  { id: "pm_claude_opus_55", displayName: "Claude Opus 5.5" },
  { id: "pm_claude_sonnet_55", displayName: "Claude Sonnet 5.5" },
  { id: "pm_gpt_54", displayName: "GPT-5.4" },
  { id: "pm_gpt_55", displayName: "GPT-5.5" },
  { id: "pm_gpt_56_terra", displayName: "GPT-5.6-Terra" },
  { id: "pm_gpt_56_sol", displayName: "GPT-5.6-Sol" },
  { id: "pm_gpt_56_sol_storyboard", displayName: "GPT-5.6-Sol · 故事板长输出" },
  { id: "pm_gpt_56_terra_key2", displayName: "GPT-5.6-Terra· 秘钥2" },
  { id: "pm_deepseek_r1", displayName: "DeepSeek-R1 (官方直连)" },
  { id: "pm_claude_sonnet_46", displayName: "claude-sonnet-4-6" },
  { id: "pm_deepseek_v31", displayName: "DeepSeek-V3.1 (官方直连)" },
  { id: "pm_claude_sonnet_46_max", displayName: "claude-sonnet-4-6 Max" },
  { id: "pm_claude_opus_48_default", displayName: "claude-opus-4-8 default" },
  { id: "pm_claude_opus_48_g2", displayName: "claude-opus-4-8 G2" },
  { id: "pm_gpt_61_sol", displayName: "GPT-6.1 Sol" },
  { id: "pm_deepseek_v4_pro", displayName: "DeepSeek-V4-Pro (官方直连)" },
  { id: "pm_deepseek_v4_flash", displayName: "DeepSeek-V4-Flash (官方直连)" },
  { id: "pm_deepseek_v41_flash", displayName: "DeepSeek-V4.1-Flash (官方直连)" },
];

const groups = buildChatModelGroups(DIRECTORY_FIXTURE);

assert.deepEqual(groups.map((group) => group.brand), ["gpt", "claude", "deepseek"], "按 GPT / Claude / DeepSeek 排列分组");
assert.deepEqual(groups.map((group) => group.title), ["GPT 系列", "Claude 系列", "DeepSeek 系列"]);

assert.deepEqual(
  groups[0].models.map((model) => model.label),
  ["GPT-5.4", "GPT-5.5", "GPT-5.6-Terra", "GPT-5.6-Sol", "GPT-6.1 Sol"],
  "GPT 组应清理故事板/秘钥等内部标注并去重",
);

assert.deepEqual(
  groups[1].models.map((model) => model.label),
  ["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Sonnet 4.6", "Claude Opus 4.8"],
  "Claude 组应去重渠道变体并统一展示名",
);

const options = allChatModelOptions(groups);
assert.equal(options.length, 14, "目录夹具应归一为 14 个可切换模型");
assert.ok(options.every((model) => model.id.startsWith("pm_")), "选择标识必须保持 pm_ 公开标识");
assert.ok(options.every((model) => !/(秘钥|密钥|渠道|故事板|长输出)/u.test(model.label)), "展示名不得泄露内部标注");
assert.ok(options.every((model) => !/\b(?:default|g2|max)\b/iu.test(model.label)), "展示名不得保留渠道变体后缀");

assert.equal(chatModelBrand("DeepSeek-V4-Pro"), "deepseek", "DeepSeek 必须显示在独立品牌组");
assert.equal(chatModelBrand("GLM-5.2"), null, "GLM 不属于 GPT / Claude");
assert.equal(chatModelBrand("GPT-6.1 Sol"), "gpt");
assert.equal(chatModelBrand("claude-opus-4-8"), "claude");

const defaultModel = defaultChatModelOption(groups);
assert.equal(defaultModel?.label, "GPT-5.6-Terra", "默认展示项应与服务端自由对话默认模型一致");
assert.equal(defaultChatModelOption([]), null, "空目录不应虚构默认模型");

assert.equal(resolveChatModelId("pm_missing", groups), null, "目录中不存在的选择必须失效");
assert.equal(
  resolveChatModelId("pm_claude_sonnet_46", groups),
  "pm_claude_sonnet_46",
  "目录中存在的选择必须原样保留",
);
assert.equal(selectedChatModelLabel(groups, null), "GPT-5.6-Terra", "无显式选择时显示服务端默认模型");
assert.equal(
  selectedChatModelLabel(groups, "pm_claude_opus_55"),
  "Claude Opus 5.5",
  "显式选择时显示所选模型",
);

const report = {
  ok: true,
  gpt: groups[0].models.map((model) => model.label),
  claude: groups[1].models.map((model) => model.label),
  defaultModel: defaultModel?.label,
  optionCount: options.length,
};
console.log(JSON.stringify(report, null, 2));

assert.deepEqual(groups[2].models.map((model) => model.id), ["pm_deepseek_r1", "pm_deepseek_v31", "pm_deepseek_v4_pro", "pm_deepseek_v4_flash", "pm_deepseek_v41_flash"], "DeepSeek 保留目录顺序与公开 ID");
const originalCatalog = JSON.stringify(groups);
const displayed = chatModelSwitcherDisplayGroups(groups);
assert.deepEqual(displayed.map(group => group.brand), ["gpt", "claude", "deepseek"], "only the DeepSeek family is trimmed; other groups keep their order");
assert.strictEqual(displayed[0], groups[0], "GPT group, models and order are preserved by reference");
assert.strictEqual(displayed[1], groups[1], "Claude group, models and order are preserved by reference");
assert.deepEqual(displayed[2].models.map(model => model.id), ["pm_deepseek_v41_flash"], "only the exact DeepSeek Flash variant is offered");
for (const id of ["pm_gpt_56_terra", "pm_claude_opus_55"]) assert.equal(resolveChatModelId(id, groups), id, "GPT and Claude conversation choices remain unchanged");
assert.equal(defaultChatModelOption(groups)?.id, "pm_gpt_56_terra", "presentation must not migrate the existing free-chat default");
assert.equal(resolveChatModelId("pm_deepseek_r1", groups), "pm_deepseek_r1", "hidden menu options remain valid existing conversation choices");
assert.equal(selectedChatModelLabel(groups, "pm_deepseek_r1"), "DeepSeek-R1 (官方直连)", "a retained old choice must not pretend to use 4.1 or default");
assert.equal(JSON.stringify(groups), originalCatalog, "presentation must never edit the complete catalog");
const versioned = buildChatModelGroups([
  { id: "pm_gpt_41", displayName: "GPT-4.1" }, { id: "pm_claude_41", displayName: "Claude Sonnet 4.1" },
  { id: "pm_ds_41", displayName: "DeepSeek-V4.1" }, { id: "pm_ds_41_pro", displayName: "DeepSeek 4.1 Pro" },
  { id: "pm_ds_41_flash", displayName: "DeepSeek-V4.1-Flash" }, { id: "pm_ds_41_channel", displayName: "DeepSeek-V4.1-Flash（官方直连）" },
  { id: "pm_ds_41_plus", displayName: "DeepSeek-V4.1-Flash-Plus" },
  { id: "pm_ds_410", displayName: "DeepSeek-V4.10-Flash" }, { id: "pm_ds_141", displayName: "DeepSeek-V14.1-Flash" },
  { id: "pm_ds_4", displayName: "DeepSeek-V4-Flash" },
]);
const frozen = structuredClone(versioned);
for (const group of frozen) { Object.freeze(group.models); Object.freeze(group); } Object.freeze(frozen);
assert.deepEqual(allChatModelOptions(chatModelSwitcherDisplayGroups(frozen)).map(model => model.id), ["pm_gpt_41", "pm_claude_41", "pm_ds_41_flash", "pm_ds_41_channel"], "non-DeepSeek options remain; only exact DeepSeek V4.1 Flash including channel annotations survives within DeepSeek");
const unchangedNonDeepSeek = { brand: "gpt" as const, title: "GPT 系列", models: [{ id: "pm_non_ds", label: "DeepSeek-V4.1-Flash", brand: "gpt" as const }] };
assert.strictEqual(chatModelSwitcherDisplayGroups([unchangedNonDeepSeek])[0], unchangedNonDeepSeek, "the presentation filter never edits a non-DeepSeek group based on its labels");
assert.deepEqual(chatModelSwitcherDisplayGroups([{ brand: "deepseek", title: "DeepSeek 系列", models: [{ id: "pm_legacy", label: "DeepSeek-R1", brand: "deepseek" }] }]), [], "no allowed menu model means an empty visible menu, never a fabricated ID");
assert.deepEqual(chatModelSwitcherDisplayGroups([groups[0], groups[1], { brand: "deepseek", title: "DeepSeek 系列", models: [{ id: "pm_legacy", label: "DeepSeek-R1", brand: "deepseek" }] }]), [groups[0], groups[1]], "an unpublished Flash never removes GPT or Claude options");
const scope = chatModelSelectionScope("account-a", "conversation-a", "agent-a");
assert.ok(scope);
for (const other of [
  chatModelSelectionScope("account-b", "conversation-a", "agent-a"),
  chatModelSelectionScope("account-a", "conversation-b", "agent-a"),
  chatModelSelectionScope("account-a", "conversation-a", "agent-b"),
  chatModelSelectionScope("account-a", null, "agent-a"),
]) assert.notEqual(scope, other, "账户、会话、目标智能体任一变化必须隔离选择");
assert.equal(chatModelSelectionScope(null, "conversation-a", "agent-a"), null);
assert.equal(chatModelSelectionScope("account-a", "conversation-a", null), null);
assert.ok(chatModelSelectionStorageKey(scope).startsWith("chat_model_selection_v2:"));
assert.notEqual(chatModelSelectionScope("a:b", "c", "d"), chatModelSelectionScope("a", "b:c", "d"), "作用域编码不得因分隔符碰撞");

// A submitted draft moves only to its exact newly created conversation.
const draftTransfer = {
  mode: "new-conversation", ownerId: "account-a", currentOwnerId: "account-a",
  createdConversationId: "created-conversation", currentConversationId: "created-conversation",
  targetAgentId: "creative-agent", currentTargetAgentId: "creative-agent", modelId: "pm_claude_opus_55",
};
const transferred = newConversationChatModelSelection(draftTransfer);
assert.deepEqual(transferred, {
  scope: chatModelSelectionScope("account-a", "created-conversation", "creative-agent"),
  id: "pm_claude_opus_55",
}, "首条消息所选模型应落到实际创建的会话作用域");
assert.equal(resolveChatModelId(transferred?.id, groups), "pm_claude_opus_55", "目录恢复应保留已提交的草稿选择，而非默认 GPT");
for (const mismatch of [
  { mode: "retry" }, { currentOwnerId: "account-b" }, { ownerId: undefined },
  { createdConversationId: undefined }, { currentConversationId: "unrelated-conversation" },
  { currentTargetAgentId: "another-agent" }, { modelId: undefined },
]) assert.equal(newConversationChatModelSelection({ ...draftTransfer, ...mismatch }), null, "账户、目标、创建回执或任务类型不同不得迁移选择");
