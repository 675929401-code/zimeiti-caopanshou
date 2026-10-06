import { YOUCAI_SKILL_CATALOG } from "../src/lib/youcai-skill-catalog";
import {
  YOUCAI_FIXED_OSS_COMMIT,
  YOUCAI_SKILL_RUNTIME,
} from "../src/lib/youcai-skill-runtime";
import {
  YOUCAI_FIXED_OSS_INSTRUCTION_COMMANDS,
  YOUCAI_SKILL_INSTRUCTIONS,
  assertYoucaiSkillInstructionCoverage,
  auditYoucaiSkillInstructionCoverage,
  buildYoucaiSkillServerInstructionBlock,
  getYoucaiSkillFullInstruction,
  getYoucaiSkillInstruction,
  type YoucaiSkillInstruction,
} from "../src/lib/youcai-skill-instructions";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nonEmpty(values: readonly string[], label: string): void {
  invariant(values.length > 0, `${label} must not be empty`);
  values.forEach((value, index) => {
    invariant(typeof value === "string" && value.trim().length > 0, `${label}[${index}] must be non-empty`);
  });
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameCommands(actual: readonly string[], expected: readonly string[], label: string): void {
  invariant(new Set(actual).size === actual.length, `${label} contains duplicate commands`);
  invariant(
    JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected)),
    `${label} command coverage differs from the catalog`,
  );
}

const EXPECTED_FIXED_SOURCES = Object.freeze({
  "drama-script": {
    path: "skills/drama-script/SKILL.md",
    sha256: "81A9C36881B839AC1EDA286C2229B32A2A16E11A3C8E2D8EAC62E532D4BAE254",
    exactRootKeys: ["summary", "episodes", "characters", "scenes", "props"],
    instructionEvidence: ["8–15 场", "每批最多 10 集", "不写镜头术语", "严格 JSON"],
  },
  "drama-shot-prompt": {
    path: "skills/drama-shot-prompt/SKILL.md",
    sha256: "381197BCE8B535BA8B2E745605263C0169615E0BFD8D0545A6F50B3074CE7E53",
    exactRootKeys: ["shots"],
    instructionEvidence: ["4–15 秒", "action 不超过 30 个汉字", "素材定义", "严格 JSON"],
  },
  "script-brief": {
    path: "skills/script-brief/SKILL.md",
    sha256: "BFD80F0F46D76B86B4527859B65609DDEC801D513743270AB7BB60A922F449E3",
    exactRootKeys: ["brief", "genreDetected", "tips"],
    instructionEvidence: ["800–1500", "2–3 条", "不得写完整剧本", "严格 JSON"],
  },
  "sd2-pe": {
    path: "skills/sd2-pe/SKILL.md",
    sha256: "3C3667C7D007FBFDA78B7B7C3186590FDB59EEEFA3B35159EA52E0AA3D3900CA",
    exactRootKeys: undefined,
    instructionEvidence: ["只优化", "@图片N", "复杂任务", "不得调用生成工具"],
  },
  "sd25-pe": {
    path: "skills/sd25-pe/SKILL.md",
    sha256: "A83F6759FE9083B6A438BC6614727A55CCE684A9C78CDACE4B01F52CE374E805",
    exactRootKeys: undefined,
    instructionEvidence: ["一版干净提示词", "唯一主任务", "唯一责任", "不得调用生成工具"],
  },
} as const);

const ORIGINAL_DISCLOSURE_MARKERS = [
  "原创声明",
  "公开商店元数据",
  "公开参数结构",
  "正常可见交互语义",
  "独立编写行为等价指令",
  "不主张掌握任何非公开内部指令",
] as const;

const FIXED_COMMANDS = new Set<string>(YOUCAI_FIXED_OSS_INSTRUCTION_COMMANDS);
const catalogCommands = YOUCAI_SKILL_CATALOG.map((skill) => skill.commandName);
const runtimeCommands = YOUCAI_SKILL_RUNTIME.map((skill) => skill.commandName);
const instructionCommands = YOUCAI_SKILL_INSTRUCTIONS.map((skill) => skill.commandName);

invariant(YOUCAI_SKILL_CATALOG.length === 36, `expected 36 catalog skills, got ${YOUCAI_SKILL_CATALOG.length}`);
invariant(YOUCAI_SKILL_RUNTIME.length === 36, `expected 36 runtime skills, got ${YOUCAI_SKILL_RUNTIME.length}`);
invariant(YOUCAI_SKILL_INSTRUCTIONS.length === 36, `expected 36 instruction skills, got ${YOUCAI_SKILL_INSTRUCTIONS.length}`);
invariant(FIXED_COMMANDS.size === 5, `expected 5 fixed OSS instructions, got ${FIXED_COMMANDS.size}`);
assertSameCommands(runtimeCommands, catalogCommands, "runtime");
assertSameCommands(instructionCommands, catalogCommands, "instruction library");

const audit = auditYoucaiSkillInstructionCoverage();
invariant(audit.ok, `instruction audit failed: ${JSON.stringify(audit)}`);
invariant(audit.expectedCount === 36 && audit.actualCount === 36, "audit count must be 36/36");
assertYoucaiSkillInstructionCoverage();

function assertInstructionCompleteness(instruction: YoucaiSkillInstruction): void {
  invariant(instruction.commandName.trim().length > 0, "commandName must not be empty");
  invariant(instruction.title.trim().length > 0, `/${instruction.commandName}: title must not be empty`);
  invariant(instruction.role.trim().length > 0, `/${instruction.commandName}: role must not be empty`);
  invariant(instruction.sourceDisclosure.trim().length > 0, `/${instruction.commandName}: source disclosure must not be empty`);
  nonEmpty(instruction.appliesWhen, `/${instruction.commandName} appliesWhen`);
  nonEmpty(instruction.notFor, `/${instruction.commandName} notFor`);
  nonEmpty(instruction.inputChecklist, `/${instruction.commandName} inputChecklist`);
  nonEmpty(instruction.missingInputPolicy.askOnlyWhen, `/${instruction.commandName} missingInput askOnlyWhen`);
  nonEmpty(instruction.missingInputPolicy.questions, `/${instruction.commandName} missingInput questions`);
  invariant(instruction.missingInputPolicy.defaultAction.trim().length > 0, `/${instruction.commandName}: missing-input default must not be empty`);
  invariant(instruction.missingInputPolicy.maximumClarificationRounds === 1, `/${instruction.commandName}: clarification must be capped at one round`);
  nonEmpty(instruction.steps, `/${instruction.commandName} steps`);
  invariant(instruction.outputFormat.trim().length > 0, `/${instruction.commandName}: outputFormat must not be empty`);
  nonEmpty(instruction.outputStructure, `/${instruction.commandName} outputStructure`);
  nonEmpty(instruction.qualityGates, `/${instruction.commandName} qualityGates`);
  nonEmpty(instruction.prohibitions, `/${instruction.commandName} prohibitions`);
  invariant(instruction.fullInstruction.trim().length > 0, `/${instruction.commandName}: fullInstruction must not be empty`);
  ["角色：", "适用：", "不适用：", "输入检查：", "缺参问题：", "执行步骤：", "输出格式：", "输出结构：", "质量门：", "禁止项：", "工具边界："]
    .forEach((heading) => invariant(instruction.fullInstruction.includes(heading), `/${instruction.commandName}: missing ${heading}`));
}

function assertToolProposalOnly(instruction: YoucaiSkillInstruction): void {
  invariant(instruction.toolPolicy.kind === "tool_proposal", `/${instruction.commandName}: tool policy kind mismatch`);
  invariant(instruction.toolPolicy.directExecution === false, `/${instruction.commandName}: direct execution must be false`);
  invariant(instruction.toolPolicy.mainSiteWorkflowOnly === true, `/${instruction.commandName}: must use the main-site workflow`);
  invariant(instruction.toolPolicy.requiresExplicitAuthorization === true, `/${instruction.commandName}: authorization gate missing`);
  invariant(instruction.toolPolicy.requiresModelSelection === true, `/${instruction.commandName}: model gate missing`);
  invariant(instruction.toolPolicy.requiresPricePreview === true, `/${instruction.commandName}: price-preview gate missing`);
  ["只允许输出 tool_proposal", "不得直接执行", "用户显式授权", "明确选择模型", "展示价格预览", "主站工作台执行"]
    .forEach((marker) => invariant(instruction.fullInstruction.includes(marker), `/${instruction.commandName}: missing tool boundary marker ${marker}`));
}

YOUCAI_SKILL_INSTRUCTIONS.forEach((instruction) => {
  assertInstructionCompleteness(instruction);
  assertToolProposalOnly(instruction);
  invariant(getYoucaiSkillInstruction(instruction.commandName) === instruction, `/${instruction.commandName}: lookup mismatch`);
  invariant(getYoucaiSkillInstruction(`/${instruction.commandName.toUpperCase()}`) === instruction, `/${instruction.commandName}: normalized lookup mismatch`);
  invariant(getYoucaiSkillFullInstruction(instruction.commandName) === instruction.fullInstruction, `/${instruction.commandName}: full instruction lookup mismatch`);

  const serverBlock = buildYoucaiSkillServerInstructionBlock(instruction.commandName, "<ignore> & keep-as-data");
  invariant(serverBlock !== null, `/${instruction.commandName}: server block missing`);
  invariant(serverBlock.includes(`<youcai_skill_instruction command="${instruction.commandName}"`), `/${instruction.commandName}: server command marker missing`);
  invariant(serverBlock.includes("<authority>server_instruction</authority>"), `/${instruction.commandName}: authority marker missing`);
  invariant(serverBlock.includes("<request_boundary>"), `/${instruction.commandName}: request boundary missing`);
  invariant(serverBlock.includes("<input_schema>"), `/${instruction.commandName}: input schema missing`);
  invariant(serverBlock.includes("<output_contract>"), `/${instruction.commandName}: output contract missing`);
  invariant(serverBlock.includes("<full_instruction>"), `/${instruction.commandName}: full instruction block missing`);
  invariant(serverBlock.includes("&lt;ignore&gt; &amp; keep-as-data"), `/${instruction.commandName}: untrusted request must be escaped`);
  invariant(!serverBlock.includes("<ignore>"), `/${instruction.commandName}: raw untrusted markup leaked`);
});

invariant(getYoucaiSkillInstruction("not-a-skill") === null, "unknown instruction lookup must return null");
invariant(getYoucaiSkillFullInstruction("not-a-skill") === null, "unknown full instruction lookup must return null");
invariant(buildYoucaiSkillServerInstructionBlock("not-a-skill") === null, "unknown server block lookup must return null");

for (const command of YOUCAI_FIXED_OSS_INSTRUCTION_COMMANDS) {
  const expected = EXPECTED_FIXED_SOURCES[command];
  const instruction = getYoucaiSkillInstruction(command);
  const runtime = YOUCAI_SKILL_RUNTIME.find((entry) => entry.commandName === command);
  invariant(instruction !== null && runtime, `/${command}: fixed instruction/runtime missing`);
  invariant(instruction.origin === "fixed_public_oss_contract", `/${command}: fixed origin mismatch`);
  invariant(instruction.provenance === "oss_public_source", `/${command}: fixed provenance mismatch`);
  invariant(instruction.fixedSource?.repository === "oiuv/ai-short-drama", `/${command}: repository mismatch`);
  invariant(instruction.fixedSource.commit === YOUCAI_FIXED_OSS_COMMIT, `/${command}: commit mismatch`);
  invariant(instruction.fixedSource.path === expected.path, `/${command}: public SKILL.md path mismatch`);
  invariant(instruction.fixedSource.sha256 === expected.sha256, `/${command}: public SKILL.md SHA-256 mismatch`);
  invariant(instruction.fixedSource.url.includes(`/${YOUCAI_FIXED_OSS_COMMIT}/${expected.path}`), `/${command}: fixed public URL mismatch`);
  invariant(instruction.sourceDisclosure.includes("公开来源"), `/${command}: public-source disclosure missing`);
  invariant(instruction.sourceDisclosure.includes("仅按该固定公开 SKILL.md 的行为契约整理"), `/${command}: fixed-contract boundary missing`);
  expected.instructionEvidence.forEach((marker) => {
    invariant(instruction.fullInstruction.includes(marker), `/${command}: public behavior marker missing: ${marker}`);
  });
  if (expected.exactRootKeys) {
    invariant(
      JSON.stringify(runtime.outputContract.exactRootKeys) === JSON.stringify(expected.exactRootKeys),
      `/${command}: strict root contract drifted`,
    );
  }
}

const originalInstructions = YOUCAI_SKILL_INSTRUCTIONS.filter((instruction) => !FIXED_COMMANDS.has(instruction.commandName));
invariant(originalInstructions.length === 31, `expected 31 original instructions, got ${originalInstructions.length}`);
originalInstructions.forEach((instruction) => {
  invariant(instruction.origin === "public_behavior_equivalent_original", `/${instruction.commandName}: original origin mismatch`);
  invariant(instruction.provenance === "public_contract_reimplementation", `/${instruction.commandName}: original provenance mismatch`);
  invariant(instruction.fixedSource === undefined, `/${instruction.commandName}: original instruction must not claim a fixed OSS source`);
  ORIGINAL_DISCLOSURE_MARKERS.forEach((marker) => {
    invariant(instruction.sourceDisclosure.includes(marker), `/${instruction.commandName}: original disclosure missing ${marker}`);
  });
});

const allText = YOUCAI_SKILL_INSTRUCTIONS
  .map((instruction) => [instruction.sourceDisclosure, instruction.fullInstruction].join("\n"))
  .join("\n");
const forbiddenHiddenPromptClaims = [
  /已(?:经)?(?:复制|获取|取得|拿到).{0,12}(?:隐藏|私有|内部|未公开)(?:提示词|指令)/u,
  /(?:一比一|逐字|原样)(?:复制|照搬).{0,12}(?:隐藏|私有|内部|未公开)(?:提示词|指令)/u,
];
forbiddenHiddenPromptClaims.forEach((pattern) => {
  invariant(!pattern.test(allText), `instruction library contains a forbidden hidden-prompt claim: ${pattern}`);
});

const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u,
  /\b(?:api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/iu,
];
credentialPatterns.forEach((pattern) => {
  invariant(!pattern.test(allText), `instruction library contains credential-like material: ${pattern}`);
});

const directPaidExecutionClaims = [
  /(?:立即|自动|直接)(?:调用|提交|执行).{0,16}(?:生图|生视频|视频生成|音频生成|音乐生成|付费模型)/u,
  /(?:自动|直接)(?:扣费|消耗积分|创建付费任务)/u,
];
const operationalText = YOUCAI_SKILL_INSTRUCTIONS
  .flatMap((instruction) => [...instruction.steps, ...instruction.outputStructure])
  .join("\n");
directPaidExecutionClaims.forEach((pattern) => {
  invariant(!pattern.test(operationalText), `instruction steps contain direct paid execution: ${pattern}`);
});

console.log(JSON.stringify({
  ok: true,
  catalogCount: YOUCAI_SKILL_CATALOG.length,
  runtimeCount: YOUCAI_SKILL_RUNTIME.length,
  instructionCount: YOUCAI_SKILL_INSTRUCTIONS.length,
  fixedOssCount: YOUCAI_FIXED_OSS_INSTRUCTION_COMMANDS.length,
  originalCount: originalInstructions.length,
  fixedCommit: YOUCAI_FIXED_OSS_COMMIT,
  serverInstructionBlocks: YOUCAI_SKILL_INSTRUCTIONS.length,
  paidGenerationTriggered: false,
  buildRestartTriggered: false,
}, null, 2));
