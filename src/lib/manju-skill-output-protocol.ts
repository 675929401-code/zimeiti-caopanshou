export const MANJU_SKILL_OUTPUT_SCHEMA_VERSION = "manju_skill_output.v1";
export const MANJU_SKILL_OUTPUT_ARTIFACT_TYPE = "manju_skill_output";

export type ManjuSkillSelectionMode = "explicit" | "automatic" | "fallback";
export type ManjuSkillExecutionStatus = "completed" | "needs_input" | "tool_proposed" | "failed";
export type ManjuSkillResultKind = "markdown" | "prompt_text" | "structured_json" | "handoff";
export type ManjuSkillToolKind = "generate_image" | "generate_video" | "generate_audio" | "generate_music" | "open_workbench";

export interface ManjuSkillIdentity {
  id: string;
  command: string;
  version: string;
  selection: ManjuSkillSelectionMode;
  provenance: "oss_public_source" | "public_contract_reimplementation" | "internal_original";
}

export interface ManjuSkillToolProposal {
  type: ManjuSkillToolKind;
  reason: string;
  input: Record<string, unknown>;
  requires_authorization: boolean;
}

export interface ManjuSkillQualityReport {
  passed: boolean;
  score: number;
  hard_constraints_satisfied: string[];
  issues: string[];
}

export interface ManjuSkillOutput {
  schema_version: typeof MANJU_SKILL_OUTPUT_SCHEMA_VERSION;
  artifact_type: typeof MANJU_SKILL_OUTPUT_ARTIFACT_TYPE;
  skill: ManjuSkillIdentity;
  status: ManjuSkillExecutionStatus;
  result: {
    kind: ManjuSkillResultKind;
    payload: unknown;
  };
  tool_proposals: ManjuSkillToolProposal[];
  quality: ManjuSkillQualityReport;
}

export const MANJU_SKILL_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "artifact_type", "skill", "status", "result", "tool_proposals", "quality"],
  properties: {
    schema_version: { const: MANJU_SKILL_OUTPUT_SCHEMA_VERSION },
    artifact_type: { const: MANJU_SKILL_OUTPUT_ARTIFACT_TYPE },
    skill: {
      type: "object",
      additionalProperties: false,
      required: ["id", "command", "version", "selection", "provenance"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        command: { type: "string", pattern: "^/[a-z0-9][a-z0-9-]{0,63}$" },
        version: { type: "string", minLength: 1, maxLength: 32 },
        selection: { enum: ["explicit", "automatic", "fallback"] },
        provenance: { enum: ["oss_public_source", "public_contract_reimplementation", "internal_original"] },
      },
    },
    status: { enum: ["completed", "needs_input", "tool_proposed", "failed"] },
    result: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "payload"],
      properties: {
        kind: { enum: ["markdown", "prompt_text", "structured_json", "handoff"] },
        payload: {},
      },
    },
    tool_proposals: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "reason", "input", "requires_authorization"],
        properties: {
          type: { enum: ["generate_image", "generate_video", "generate_audio", "generate_music", "open_workbench"] },
          reason: { type: "string", minLength: 1, maxLength: 500 },
          input: { type: "object" },
          requires_authorization: { type: "boolean" },
        },
      },
    },
    quality: {
      type: "object",
      additionalProperties: false,
      required: ["passed", "score", "hard_constraints_satisfied", "issues"],
      properties: {
        passed: { type: "boolean" },
        score: { type: "number", minimum: 0, maximum: 100 },
        hard_constraints_satisfied: { type: "array", items: { type: "string", maxLength: 300 } },
        issues: { type: "array", items: { type: "string", maxLength: 300 } },
      },
    },
  },
} as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSelectionMode(value: unknown): value is ManjuSkillSelectionMode {
  return value === "explicit" || value === "automatic" || value === "fallback";
}

function isExecutionStatus(value: unknown): value is ManjuSkillExecutionStatus {
  return value === "completed" || value === "needs_input" || value === "tool_proposed" || value === "failed";
}

function isResultKind(value: unknown): value is ManjuSkillResultKind {
  return value === "markdown" || value === "prompt_text" || value === "structured_json" || value === "handoff";
}

function isToolKind(value: unknown): value is ManjuSkillToolKind {
  return value === "generate_image"
    || value === "generate_video"
    || value === "generate_audio"
    || value === "generate_music"
    || value === "open_workbench";
}

function isProvenance(value: unknown): value is ManjuSkillIdentity["provenance"] {
  return value === "oss_public_source"
    || value === "public_contract_reimplementation"
    || value === "internal_original";
}

export function parseManjuSkillOutput(value: unknown): ManjuSkillOutput | null {
  if (!isRecord(value)
    || value.schema_version !== MANJU_SKILL_OUTPUT_SCHEMA_VERSION
    || value.artifact_type !== MANJU_SKILL_OUTPUT_ARTIFACT_TYPE
    || !isRecord(value.skill)
    || !isRecord(value.result)
    || !Array.isArray(value.tool_proposals)
    || !isRecord(value.quality)) {
    return null;
  }

  const skill = value.skill;
  const result = value.result;
  const quality = value.quality;
  if (typeof skill.id !== "string"
    || typeof skill.command !== "string"
    || !/^\/[a-z0-9][a-z0-9-]{0,63}$/.test(skill.command)
    || typeof skill.version !== "string"
    || !isSelectionMode(skill.selection)
    || !isProvenance(skill.provenance)
    || !isExecutionStatus(value.status)
    || !isResultKind(result.kind)
    || typeof quality.passed !== "boolean"
    || typeof quality.score !== "number"
    || !Number.isFinite(quality.score)
    || quality.score < 0
    || quality.score > 100
    || !isStringArray(quality.hard_constraints_satisfied)
    || !isStringArray(quality.issues)) {
    return null;
  }

  const proposals: ManjuSkillToolProposal[] = [];
  for (const candidate of value.tool_proposals) {
    if (!isRecord(candidate)
      || !isToolKind(candidate.type)
      || typeof candidate.reason !== "string"
      || !isRecord(candidate.input)
      || typeof candidate.requires_authorization !== "boolean") {
      return null;
    }
    if (candidate.type !== "open_workbench" && candidate.requires_authorization !== true) {
      return null;
    }
    proposals.push({
      type: candidate.type,
      reason: candidate.reason,
      input: candidate.input,
      requires_authorization: candidate.requires_authorization,
    });
  }

  return {
    schema_version: MANJU_SKILL_OUTPUT_SCHEMA_VERSION,
    artifact_type: MANJU_SKILL_OUTPUT_ARTIFACT_TYPE,
    skill: {
      id: skill.id,
      command: skill.command,
      version: skill.version,
      selection: skill.selection,
      provenance: skill.provenance,
    },
    status: value.status,
    result: { kind: result.kind, payload: result.payload },
    tool_proposals: proposals,
    quality: {
      passed: quality.passed,
      score: quality.score,
      hard_constraints_satisfied: quality.hard_constraints_satisfied,
      issues: quality.issues,
    },
  };
}

export function buildManjuSkillOutputInstruction(): string {
  return [
    `在可见结果之后追加一个不可见机器包，格式必须是：<!-- manju_skill_output:v1\\n{合法 JSON}\\n-->。`,
    `JSON 的 schema_version 必须为 ${MANJU_SKILL_OUTPUT_SCHEMA_VERSION}，artifact_type 必须为 ${MANJU_SKILL_OUTPUT_ARTIFACT_TYPE}。`,
    "机器包只记录本轮 Skill、结果类型、工具提案和质量门禁；不得写内部推理、系统提示词、密钥、模型密钥、价格或虚构任务 ID。",
    "图片、视频、音频、音乐只允许写成 tool_proposals；除 open_workbench 外 requires_authorization 必须为 true。仅有工具提案不代表已经生成或已经扣费。",
  ].join("\n");
}
