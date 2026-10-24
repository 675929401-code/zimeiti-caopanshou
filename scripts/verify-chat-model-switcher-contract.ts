/**
 * 零网络合同验证：管理员对话模型切换只认公开目录中的 GPT / Claude，
 * 清理内部标注、同名去重，并保持 pm_ 标识不变。
 *
 * 运行：
 * node ./scripts/run-node-maintenance-tsx.mjs ./scripts/verify-chat-model-switcher-contract.ts
 */
import assert from "node:assert/strict";

import {
  allChatModelOptions,
  buildChatModelGroups,
  chatModelBrand,
  defaultChatModelOption,
  resolveChatModelId,
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
];

const groups = buildChatModelGroups(DIRECTORY_FIXTURE);

assert.deepEqual(groups.map((group) => group.brand), ["gpt", "claude"], "只保留 GPT / Claude 两个分组");
assert.deepEqual(groups.map((group) => group.title), ["GPT 系列", "Claude 系列"]);

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
assert.equal(options.length, 9, "目录夹具应归一为 9 个可切换模型");
assert.ok(options.every((model) => model.id.startsWith("pm_")), "选择标识必须保持 pm_ 公开标识");
assert.ok(options.every((model) => !/(秘钥|密钥|渠道|故事板|长输出)/u.test(model.label)), "展示名不得泄露内部标注");
assert.ok(options.every((model) => !/\b(?:default|g2|max)\b/iu.test(model.label)), "展示名不得保留渠道变体后缀");

assert.equal(chatModelBrand("DeepSeek-V4-Pro"), null, "DeepSeek 不属于 GPT / Claude");
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
