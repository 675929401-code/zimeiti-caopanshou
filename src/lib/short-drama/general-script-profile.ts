import {
  DRAMA_SCRIPT_PROFILE_SOURCE as dramaScriptSource,
  GENERAL_SCRIPT_PROFILE_SOURCE as profileSource,
  PET_SILENT_NARRATION_PROFILE_SOURCE as petSilentNarrationSource,
} from "./general-script-profile-data";
import {
  DRAMA_SCRIPT_PROFILE_ID,
  GENERAL_SCRIPT_CONTRACT_VERSION,
  GENERAL_SCRIPT_PROFILE_ID,
  GENERAL_SCRIPT_PROFILE_VERSION,
  GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
  PET_SILENT_NARRATION_PROFILE_ID,
  type GeneralScriptProfileId,
  type GeneralScriptRequest,
} from "./general-script-contract";

interface GeneralScriptPromptProfileSource {
  id: string;
  version: string;
  contractVersion: string;
  locale: string;
  status: string;
  description: string;
  variables: readonly string[];
  systemPromptSections: readonly string[];
}

export interface GeneralScriptPromptProfile {
  id: GeneralScriptProfileId;
  version: typeof GENERAL_SCRIPT_PROFILE_VERSION;
  contractVersion: typeof GENERAL_SCRIPT_CONTRACT_VERSION;
  resultSchemaVersion: typeof GENERAL_SCRIPT_RESULT_SCHEMA_VERSION;
  locale: "zh-CN";
  status: "active";
  description: string;
  variables: string[];
  systemPrompt: string;
}

function loadProfile(
  input: unknown,
  expectedId: GeneralScriptProfileId,
): GeneralScriptPromptProfile {
  const source = input as GeneralScriptPromptProfileSource;
  if (
    source.id !== expectedId
    || source.version !== GENERAL_SCRIPT_PROFILE_VERSION
    || source.contractVersion !== GENERAL_SCRIPT_CONTRACT_VERSION
    || source.locale !== "zh-CN"
    || source.status !== "active"
    || !Array.isArray(source.variables)
    || !Array.isArray(source.systemPromptSections)
    || source.systemPromptSections.length === 0
  ) {
    throw new Error("通用编剧 Prompt Profile 与代码合同不一致");
  }

  return {
    id: expectedId,
    version: GENERAL_SCRIPT_PROFILE_VERSION,
    contractVersion: GENERAL_SCRIPT_CONTRACT_VERSION,
    resultSchemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
    locale: "zh-CN",
    status: "active",
    description: source.description,
    variables: [...source.variables],
    systemPrompt: source.systemPromptSections.join("\n\n"),
  };
}

export const GENERAL_SCRIPT_PROMPT_PROFILE = loadProfile(
  profileSource,
  GENERAL_SCRIPT_PROFILE_ID,
);

export const DRAMA_SCRIPT_PROMPT_PROFILE = loadProfile(
  dramaScriptSource,
  DRAMA_SCRIPT_PROFILE_ID,
);

export const PET_SILENT_NARRATION_PROMPT_PROFILE = loadProfile(
  petSilentNarrationSource,
  PET_SILENT_NARRATION_PROFILE_ID,
);

export function getGeneralScriptPromptProfile(
  profileId: GeneralScriptProfileId,
): GeneralScriptPromptProfile {
  if (profileId === PET_SILENT_NARRATION_PROFILE_ID) {
    return PET_SILENT_NARRATION_PROMPT_PROFILE;
  }
  if (profileId === DRAMA_SCRIPT_PROFILE_ID) {
    return DRAMA_SCRIPT_PROMPT_PROFILE;
  }
  return GENERAL_SCRIPT_PROMPT_PROFILE;
}

function operationInstruction(request: GeneralScriptRequest): string {
  if (request.operation === "continue") {
    return "在已有最大集数之后续写，并返回已有内容与新内容合并后的完整项目。";
  }
  if (request.operation === "rewrite") {
    return "只重写指定集，保留其他集，然后返回更新后的完整项目。";
  }
  return "从第 1 集开始创建一个新项目。";
}

export function buildGeneralScriptUserPrompt(request: GeneralScriptRequest): string {
  const profile = getGeneralScriptPromptProfile(request.profile.id);
  const payload = {
    operation: request.operation,
    operationInstruction: operationInstruction(request),
    settings: request.settings,
    content: request.content,
    existingResult: request.existingResult ?? null,
    rewriteEpisodeNumbers: request.rewriteEpisodeNumbers,
    rewriteInstruction: request.rewriteInstruction,
  };

  return [
    profile.id === DRAMA_SCRIPT_PROFILE_ID
      ? "请执行以下专业爽剧编剧任务。"
      : "请执行以下通用短剧编剧任务。",
    "Prompt Profile：" + profile.id + "@" + profile.version,
    "输入 JSON：",
    JSON.stringify(payload),
    "只返回符合 " + GENERAL_SCRIPT_RESULT_SCHEMA_VERSION + " 的 JSON 对象。",
  ].join("\n\n");
}
