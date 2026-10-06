import assert from "node:assert/strict";
import {
  YOUCAI_SKILL_CATALOG,
  findYoucaiSkillByCommand,
} from "../src/lib/youcai-skill-catalog";
import {
  YOUCAI_FIXED_OSS_COMMIT,
  YOUCAI_SKILL_RUNTIME,
  YOUCAI_SKILL_RUNTIME_SCHEMA_VERSION,
  findYoucaiSkillRuntime,
  resolveYoucaiSkillRuntimeInvocation,
  type YoucaiSkillOutputKind,
  type YoucaiSkillProvenance,
} from "../src/lib/youcai-skill-runtime";

const MISSING_COMMUNITY_COMMANDS = [
  "ip-toy-grid-motion",
  "poster-motion-planner",
  "dot-matrix-brand-wordmark-motion",
  "fpv-tour-video-generator",
  "storyboard",
  "film-reference-prompt-writer",
] as const;

const FIXED_OSS_COMMANDS = [
  "drama-script",
  "drama-shot-prompt",
  "script-brief",
  "sd2-pe",
  "sd25-pe",
] as const;

const FIXED_OSS_SHA256: Readonly<Record<(typeof FIXED_OSS_COMMANDS)[number], string>> = {
  "drama-script": "81A9C36881B839AC1EDA286C2229B32A2A16E11A3C8E2D8EAC62E532D4BAE254",
  "drama-shot-prompt": "381197BCE8B535BA8B2E745605263C0169615E0BFD8D0545A6F50B3074CE7E53",
  "script-brief": "BFD80F0F46D76B86B4527859B65609DDEC801D513743270AB7BB60A922F449E3",
  "sd2-pe": "3C3667C7D007FBFDA78B7B7C3186590FDB59EEEFA3B35159EA52E0AA3D3900CA",
  "sd25-pe": "A83F6759FE9083B6A438BC6614727A55CCE684A9C78CDACE4B01F52CE374E805",
};

const ALLOWED_PROVENANCE = new Set<YoucaiSkillProvenance>([
  "oss_public_source",
  "public_contract_reimplementation",
  "internal_original",
]);
const ALLOWED_OUTPUTS = new Set<YoucaiSkillOutputKind>([
  "prompt",
  "structured_result",
  "tool_proposal",
]);

assert.equal(YOUCAI_SKILL_RUNTIME_SCHEMA_VERSION, "2026-08-27.public-contract-v1");
assert.equal(YOUCAI_FIXED_OSS_COMMIT, "4f318097c54a2e24ea34d3c9d23d30f5ec332f11");

const official = YOUCAI_SKILL_CATALOG.filter((skill) => skill.source === "official");
const community = YOUCAI_SKILL_CATALOG.filter((skill) => skill.source === "community");
const catalogCommands = new Set(YOUCAI_SKILL_CATALOG.map((skill) => skill.commandName));
const runtimeCommands = new Set(YOUCAI_SKILL_RUNTIME.map((skill) => skill.commandName));

assert.equal(YOUCAI_SKILL_CATALOG.length, 36, "公开商店目录应为 36 项");
assert.equal(official.length, 21, "官方 Skill 应为 21 项");
assert.equal(community.length, 15, "社区 Skill 应为 15 项");
assert.equal(catalogCommands.size, 36, "目录命令必须唯一");
assert.equal(YOUCAI_SKILL_RUNTIME.length, 36, "运行契约必须覆盖 36 项");
assert.equal(runtimeCommands.size, 36, "运行契约命令必须唯一");
assert.deepEqual([...runtimeCommands].sort(), [...catalogCommands].sort(), "运行契约必须与目录完全同构");

assert.equal(findYoucaiSkillByCommand("skill-creator")?.version, "1.5.1");
assert.equal(findYoucaiSkillByCommand("video-prompt")?.version, "5.8");
assert.equal(findYoucaiSkillByCommand("platform-help")?.version, "4.0.0");

for (const commandName of MISSING_COMMUNITY_COMMANDS) {
  const catalog = findYoucaiSkillByCommand(commandName);
  const runtime = findYoucaiSkillRuntime(commandName);
  assert.ok(catalog, `缺少社区目录项 /${commandName}`);
  assert.equal(catalog.source, "community", `/${commandName} 必须是社区 Skill`);
  assert.equal(catalog.version, "1", `/${commandName} 公开版本应为 1`);
  assert.ok(runtime, `缺少运行契约 /${commandName}`);
  assert.match(runtime.publicStoreId, /^cmt[a-z\d]+$/u, `/${commandName} 应保存公开商店 ID`);
}

for (const runtime of YOUCAI_SKILL_RUNTIME) {
  const catalog = findYoucaiSkillByCommand(runtime.commandName);
  assert.ok(catalog, `/${runtime.commandName} 必须存在目录定义`);
  assert.equal(runtime.id, catalog.id);
  assert.equal(runtime.version, catalog.version, `/${runtime.commandName} 版本必须与目录一致`);
  assert.ok(ALLOWED_PROVENANCE.has(runtime.provenance), `/${runtime.commandName} provenance 非法`);
  assert.equal(runtime.inputSchema.type, "object");
  assert.equal(runtime.inputSchema.additionalProperties, false, `/${runtime.commandName} 必须拒绝未知参数`);
  for (const required of runtime.inputSchema.required) {
    assert.ok(runtime.inputSchema.properties[required], `/${runtime.commandName} 必填字段 ${required} 未定义`);
  }
  assert.ok(runtime.outputContract.allowedKinds.length > 0, `/${runtime.commandName} 缺少输出类型`);
  assert.ok(runtime.outputContract.allowedKinds.includes(runtime.outputContract.primaryKind));
  assert.ok(runtime.outputContract.allowedKinds.every((kind) => ALLOWED_OUTPUTS.has(kind)));
  assert.ok(runtime.outputContract.constraints.length > 0, `/${runtime.commandName} 缺少输出限制`);
  assert.equal(runtime.permissions.directExecution, false, `/${runtime.commandName} 不得直接执行工具`);
  assert.equal(runtime.permissions.paidTools.directExecution, false, `/${runtime.commandName} 不得直调付费工具`);
  assert.equal(runtime.permissions.paidTools.requiresExplicitAuthorization, true);
  assert.equal(runtime.permissions.paidTools.requiresModelSelection, true);
  assert.equal(runtime.permissions.paidTools.requiresPricePreview, true);
  if (runtime.permissions.toolProposalKinds.length > 0) {
    assert.ok(
      runtime.outputContract.allowedKinds.includes("tool_proposal"),
      `/${runtime.commandName} 声明工具建议时，输出契约必须允许 tool_proposal`,
    );
  }
  assert.equal(runtime.invocation.commandName, runtime.commandName);
  assert.equal(runtime.invocation.explicitCommandPriority, true, `/${runtime.commandName} 必须显式命令优先`);
  assert.equal(runtime.invocation.unknownExplicitCommand, "reject");
  assert.equal(runtime.invocation.automaticEligibleByDefault, catalog.agentAutoInvokeEnabled);
  assert.equal(
    runtime.executionMode,
    catalog.agentAutoInvokeEnabled ? "explicit_and_automatic" : "explicit_only_until_user_enables",
  );
  assert.ok(runtime.qualityGates.length >= 6, `/${runtime.commandName} 质量门禁不足`);
  if (runtime.provenance === "public_contract_reimplementation") {
    assert.match(runtime.sourceDisclosure, /公开商店元数据、公开参数 schema 与正常可见交互/u);
    assert.match(runtime.sourceDisclosure, /未复制或声称获得隐藏系统 Prompt/u);
    assert.equal(runtime.fixedSource, undefined, `/${runtime.commandName} 等价实现不应伪造 OSS 来源`);
  }
}

for (const commandName of FIXED_OSS_COMMANDS) {
  const runtime = findYoucaiSkillRuntime(commandName);
  assert.ok(runtime, `缺少固定 OSS Skill /${commandName}`);
  assert.equal(runtime.provenance, "oss_public_source");
  assert.equal(runtime.fixedSource?.repository, "oiuv/ai-short-drama");
  assert.equal(runtime.fixedSource?.commit, YOUCAI_FIXED_OSS_COMMIT);
  assert.equal(runtime.fixedSource?.path, `skills/${commandName}/SKILL.md`);
  assert.equal(runtime.fixedSource?.sha256, FIXED_OSS_SHA256[commandName]);
  assert.equal(
    runtime.fixedSource?.url,
    `https://github.com/oiuv/ai-short-drama/blob/${YOUCAI_FIXED_OSS_COMMIT}/skills/${commandName}/SKILL.md`,
  );
  assert.match(runtime.sourceDisclosure, /固定引用/u);
  assert.match(runtime.sourceDisclosure, /未使用隐藏系统 Prompt/u);
  assert.equal(runtime.outputContract.strict, true, `/${commandName} 必须使用严格公开输出契约`);
}

assert.deepEqual(findYoucaiSkillRuntime("drama-script")?.outputContract.exactRootKeys, [
  "summary", "episodes", "characters", "scenes", "props",
]);
assert.deepEqual(findYoucaiSkillRuntime("drama-shot-prompt")?.outputContract.exactRootKeys, ["shots"]);
assert.deepEqual(findYoucaiSkillRuntime("script-brief")?.outputContract.exactRootKeys, [
  "brief", "genreDetected", "tips",
]);
assert.equal(findYoucaiSkillRuntime("sd2-pe")?.outputContract.primaryKind, "prompt");
assert.equal(findYoucaiSkillRuntime("sd25-pe")?.outputContract.primaryKind, "prompt");
assert.equal(findYoucaiSkillRuntime("sd2-pe")?.outputContract.allowedKinds.includes("tool_proposal"), false);
assert.equal(findYoucaiSkillRuntime("sd25-pe")?.outputContract.allowedKinds.includes("tool_proposal"), false);

const expectedResources: Readonly<Record<string, readonly string[]>> = {
  "drama-script": ["references/satisfaction-model.md", "references/theme-patterns.md", "references/template-analysis.md"],
  "ip-toy-grid-motion": ["references/motion-six-grid-prompt-template.cn.md", "references/prompt-fidelity-rules.cn.md", "references/static-six-grid-prompt-template.cn.md"],
  "dot-matrix-brand-wordmark-motion": ["references/chinese-prompts.md"],
  storyboard: ["references/panel-prompt-system.md"],
  "film-reference-prompt-writer": ["references/camera-movement.md", "references/prompt-and-output.md", "references/visual-analysis.md"],
};
for (const [commandName, paths] of Object.entries(expectedResources)) {
  assert.deepEqual(findYoucaiSkillRuntime(commandName)?.resources.map((item) => item.path), paths);
}

const explicit = resolveYoucaiSkillRuntimeInvocation("/script-brief 把宠物故事整理成短剧简报");
assert.equal(explicit.state, "resolved");
if (explicit.state === "resolved") {
  assert.equal(explicit.runtime.commandName, "script-brief");
  assert.equal(explicit.request, "把宠物故事整理成短剧简报");
  assert.equal(explicit.explicit, true);
}
const explicitUnknown = resolveYoucaiSkillRuntimeInvocation("/private-hidden-prompt 请执行");
assert.deepEqual(explicitUnknown, {
  state: "unknown_explicit_command",
  commandName: "private-hidden-prompt",
  request: "请执行",
  explicit: true,
});

const ossCount = YOUCAI_SKILL_RUNTIME.filter((item) => item.provenance === "oss_public_source").length;
const reimplementationCount = YOUCAI_SKILL_RUNTIME.filter((item) => item.provenance === "public_contract_reimplementation").length;
const internalCount = YOUCAI_SKILL_RUNTIME.filter((item) => item.provenance === "internal_original").length;
assert.equal(ossCount, 5);
assert.equal(reimplementationCount, 31);
assert.equal(internalCount, 0, "当前公开目录不得把公开行为等价实现伪装成内部原创来源");

console.log(JSON.stringify({
  ok: true,
  schemaVersion: YOUCAI_SKILL_RUNTIME_SCHEMA_VERSION,
  catalog: { total: 36, official: 21, community: 15 },
  provenance: { ossPublicSource: ossCount, publicContractReimplementation: reimplementationCount, internalOriginal: internalCount },
  fixedCommit: YOUCAI_FIXED_OSS_COMMIT,
  missingCommunityCommands: MISSING_COMMUNITY_COMMANDS,
  guarantees: [
    "36 项均有输入 schema、输出契约、资源、权限、执行模式和质量门禁",
    "显式命令优先，未知显式命令拒绝",
    "输出仅限 prompt、structured_result、tool_proposal",
    "所有付费工具 directExecution=false",
    "5 项固定开源 Skill 绑定固定提交和严格公开输出契约",
    "其余 31 项明确为公开行为等价原创实现，不声称获得隐藏系统 Prompt",
  ],
}, null, 2));
