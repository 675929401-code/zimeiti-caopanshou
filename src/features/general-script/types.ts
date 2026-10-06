import {
  GENERAL_SCRIPT_PROFILE_ID,
  PET_SILENT_NARRATION_PROFILE_ID,
  type GeneralScriptApiSuccess,
  type GeneralScriptAudience,
  type GeneralScriptCreationMode,
  type GeneralScriptOperation,
  type GeneralScriptProfileId,
  type GeneralScriptResult,
  type GeneralScriptTone,
  type GeneralScriptVideoSize,
} from "@/lib/short-drama/general-script-contract";

export interface GeneralScriptDraft {
  schemaVersion: 1;
  profileId: GeneralScriptProfileId;
  operation: GeneralScriptOperation;
  creationMode: GeneralScriptCreationMode;
  targetAudience: GeneralScriptAudience;
  tone: GeneralScriptTone;
  customTone: string;
  genre: string;
  animationStyle: string;
  videoSize: GeneralScriptVideoSize;
  episodesToGenerate: number;
  totalEpisodes: string;
  isFinale: boolean;
  title: string;
  brief: string;
  sourceMaterial: string;
  requirements: string;
  existingResultText: string;
  rewriteEpisodeNumbers: string;
  rewriteInstruction: string;
  clientRequestId: string;
  lastExecutionMode: "fixture" | "real" | null;
  lastResult: GeneralScriptResult | null;
  updatedAt: string;
}

type GeneralScriptProfileDefaults = Pick<
  GeneralScriptDraft,
  "genre" | "episodesToGenerate" | "totalEpisodes" | "isFinale"
>;

const GENERAL_SCRIPT_DEFAULTS: GeneralScriptProfileDefaults = {
  genre: "剧情",
  episodesToGenerate: 5,
  totalEpisodes: "",
  isFinale: false,
};

const PET_SILENT_NARRATION_DEFAULTS: GeneralScriptProfileDefaults = {
  genre: "宠物动画口播",
  episodesToGenerate: 1,
  totalEpisodes: "1",
  isFinale: true,
};

export type GeneralScriptUiResult = GeneralScriptApiSuccess;

export const DEFAULT_GENERAL_SCRIPT_DRAFT: GeneralScriptDraft = {
  schemaVersion: 1,
  profileId: GENERAL_SCRIPT_PROFILE_ID,
  operation: "generate",
  creationMode: "original",
  targetAudience: "all_ages",
  tone: "emotional",
  customTone: "",
  genre: GENERAL_SCRIPT_DEFAULTS.genre,
  animationStyle: "商业级 3D 卡通动画",
  videoSize: "9:16",
  episodesToGenerate: GENERAL_SCRIPT_DEFAULTS.episodesToGenerate,
  totalEpisodes: GENERAL_SCRIPT_DEFAULTS.totalEpisodes,
  isFinale: GENERAL_SCRIPT_DEFAULTS.isFinale,
  title: "",
  brief: "",
  sourceMaterial: "",
  requirements: "",
  existingResultText: "",
  rewriteEpisodeNumbers: "",
  rewriteInstruction: "",
  clientRequestId: "",
  lastExecutionMode: null,
  lastResult: null,
  updatedAt: "",
};

export function hasMeaningfulDraft(draft: GeneralScriptDraft): boolean {
  return Boolean(
    draft.title.trim()
    || draft.brief.trim()
    || draft.sourceMaterial.trim()
    || draft.requirements.trim()
    || draft.existingResultText.trim()
    || draft.lastResult,
  );
}

export function applyProfileDefaultsToEmptyDraft(
  draft: GeneralScriptDraft,
  profileId: GeneralScriptProfileId,
): GeneralScriptDraft {
  if (hasMeaningfulDraft(draft)) {
    return { ...draft, profileId };
  }

  const defaults = profileId === PET_SILENT_NARRATION_PROFILE_ID
    ? PET_SILENT_NARRATION_DEFAULTS
    : GENERAL_SCRIPT_DEFAULTS;
  return {
    ...draft,
    profileId,
    ...defaults,
  };
}

export function createDefaultGeneralScriptDraft(
  profileId: GeneralScriptProfileId = GENERAL_SCRIPT_PROFILE_ID,
): GeneralScriptDraft {
  return applyProfileDefaultsToEmptyDraft(
    { ...DEFAULT_GENERAL_SCRIPT_DRAFT },
    profileId,
  );
}
