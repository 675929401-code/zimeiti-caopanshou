import {
  GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
  parseGeneralScriptResult,
  type GeneralScriptResult,
} from "@/lib/short-drama/general-script-contract";
import {
  DEFAULT_GENERAL_SCRIPT_DRAFT,
  type GeneralScriptDraft,
} from "./types";
import { readBrowserWorkbenchIdentity, workbenchUserStorageKey } from "@/lib/workbench-user-storage";

const DRAFT_STORAGE_KEY = "general_script_draft_v1";
const HANDOFF_STORAGE_KEY = "short_drama_general_script_handoff_v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function safeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function userDraftKey(ownerUserId?: string): string | null {
  const userId = ownerUserId || readBrowserWorkbenchIdentity()?.userId;
  return userId ? workbenchUserStorageKey(DRAFT_STORAGE_KEY, userId) : null;
}

export function loadGeneralScriptDraft(ownerUserId?: string): GeneralScriptDraft {
  if (typeof window === "undefined") return { ...DEFAULT_GENERAL_SCRIPT_DRAFT };
  const key = userDraftKey(ownerUserId);
  if (!key) return { ...DEFAULT_GENERAL_SCRIPT_DRAFT };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { ...DEFAULT_GENERAL_SCRIPT_DRAFT };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      return { ...DEFAULT_GENERAL_SCRIPT_DRAFT };
    }

    let lastResult: GeneralScriptResult | null = null;
    if (parsed.lastResult !== null && parsed.lastResult !== undefined) {
      try {
        lastResult = parseGeneralScriptResult(parsed.lastResult);
      } catch {
        lastResult = null;
      }
    }

    const operation = parsed.operation === "continue" || parsed.operation === "rewrite"
      ? parsed.operation
      : "generate";
    const creationMode = parsed.creationMode === "adaptation" ? "adaptation" : "original";
    const audienceValues = ["all_ages", "children", "teen", "adult"];
    const targetAudience = audienceValues.includes(safeString(parsed.targetAudience))
      ? safeString(parsed.targetAudience) as GeneralScriptDraft["targetAudience"]
      : "all_ages";
    const toneValues = [
      "emotional",
      "suspense",
      "comedy",
      "inspiring",
      "warm",
      "serious",
      "custom",
    ];
    const tone = toneValues.includes(safeString(parsed.tone))
      ? safeString(parsed.tone) as GeneralScriptDraft["tone"]
      : "emotional";

    return {
      schemaVersion: 1,
      profileId: parsed.profileId === "pet-silent-narration"
        ? "pet-silent-narration"
        : "general-script",
      operation,
      creationMode,
      targetAudience,
      tone,
      customTone: safeString(parsed.customTone),
      genre: safeString(parsed.genre, "剧情"),
      animationStyle: safeString(parsed.animationStyle, "商业级 3D 卡通动画"),
      videoSize: (
        ["9:16", "16:9", "1:1", "4:3"].includes(safeString(parsed.videoSize))
          ? safeString(parsed.videoSize)
          : "9:16"
      ) as GeneralScriptDraft["videoSize"],
      episodesToGenerate: Math.min(20, Math.max(1, safeInteger(parsed.episodesToGenerate, 5))),
      totalEpisodes: safeString(parsed.totalEpisodes),
      isFinale: safeBoolean(parsed.isFinale, false),
      title: safeString(parsed.title),
      brief: safeString(parsed.brief),
      sourceMaterial: safeString(parsed.sourceMaterial),
      requirements: safeString(parsed.requirements),
      existingResultText: safeString(parsed.existingResultText),
      rewriteEpisodeNumbers: safeString(parsed.rewriteEpisodeNumbers),
      rewriteInstruction: safeString(parsed.rewriteInstruction),
      clientRequestId: safeString(parsed.clientRequestId),
      lastExecutionMode: parsed.lastExecutionMode === "fixture" || parsed.lastExecutionMode === "real"
        ? parsed.lastExecutionMode
        : null,
      lastResult,
      updatedAt: safeString(parsed.updatedAt),
    };
  } catch {
    return { ...DEFAULT_GENERAL_SCRIPT_DRAFT };
  }
}

export function saveGeneralScriptDraft(draft: GeneralScriptDraft, ownerUserId?: string): boolean {
  if (typeof window === "undefined") return false;
  const key = userDraftKey(ownerUserId);
  if (!key) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    // Private browsing and storage quotas must not break the editor.
    return false;
  }
}

export function clearGeneralScriptDraft(ownerUserId?: string): void {
  if (typeof window === "undefined") return;
  const key = userDraftKey(ownerUserId);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage access failures.
  }
}

export function saveGeneralScriptHandoff(result: GeneralScriptResult, ownerUserId?: string): void {
  if (typeof window === "undefined") return;
  const userId = ownerUserId || readBrowserWorkbenchIdentity()?.userId;
  if (!userId) return;
  try {
    window.localStorage.setItem(
      workbenchUserStorageKey(HANDOFF_STORAGE_KEY, userId),
      JSON.stringify({
        schemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
        source: "/tools/text/general-script",
        savedAt: new Date().toISOString(),
        result,
      }),
    );
  } catch {
    // Navigation remains available even if the optional handoff cache fails.
  }
}
