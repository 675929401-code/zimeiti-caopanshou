import {
  STORYBOARD_DIRECTOR_INPUT_ALIASES,
  normalizeStoryboardDirectorInput,
  type StoryboardDirectorInput,
  type StoryboardDirectorMode,
} from "@/lib/storyboard-director-protocol";

export interface StoryboardDirectorIntake {
  input: StoryboardDirectorInput;
  fieldSources: Partial<Record<keyof StoryboardDirectorInput, "submitted" | "default">>;
  missingFields: string[];
  referenceProjectId?: string;
}

const CARD_KEYS = [
  "segmented_script", "target_duration_seconds", "video_model_profile", "aspect_ratio",
  "animation_style", "owner_gender", "dog_breed", "special_notes", "visual_asset_mode",
] as const;

/**
 * Read only the original user card, never the model's echoed input. Both the
 * historic Chinese labels and stable sendText IDs are supported. Multiline
 * script/notes end only at another recognised field header, not at a colon in
 * the user's prose. Missing choices are reported rather than inferred by a model.
 */
export function parseStoryboardDirectorIntake(
  text: string,
  options: { directorMode?: StoryboardDirectorMode; defaults?: Partial<StoryboardDirectorInput> } = {},
): StoryboardDirectorIntake | null {
  let referenceProjectId: string | undefined;
  let invalidAssetReceipt = false;
  const cardText = text.replace(/```director_assets_receipt\s*\n([\s\S]*?)\n```/g, (_match, json: string) => {
    try {
      const receipt = JSON.parse(json);
      if (referenceProjectId || !receipt || typeof receipt.projectId !== "string"
        || !/^[A-Za-z0-9:_-]{8,160}$/.test(receipt.projectId)) invalidAssetReceipt = true;
      else referenceProjectId = receipt.projectId;
    } catch { invalidAssetReceipt = true; }
    return "";
  });
  const aliases = new Map<string, string>();
  for (const [key, values] of Object.entries(STORYBOARD_DIRECTOR_INPUT_ALIASES)) {
    for (const alias of values) aliases.set(alias.toLowerCase(), key);
  }
  const source: Record<string, unknown> = {};
  const fieldSources: StoryboardDirectorIntake["fieldSources"] = {};
  const duplicateFields = new Set<string>();
  let activeKey: string | undefined;
  let activeLines: string[] = [];
  const flush = () => {
    if (!activeKey) return;
    const value = activeLines.join("\n").trim();
    if (Object.hasOwn(source, activeKey)) duplicateFields.add(activeKey);
    source[activeKey] = value;
    fieldSources[activeKey as keyof StoryboardDirectorInput] = "submitted";
  };
  for (const line of cardText.replace(/\r\n?/g, "\n").split("\n")) {
    const header = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?([^:：\n]{1,80}?)(?:\*\*)?\s*[:：]\s*(.*)$/);
    const key = header ? aliases.get(header[1].trim().replace(/^\*\*|\*\*$/g, "").toLowerCase()) : undefined;
    if (key) {
      flush();
      activeKey = key;
      activeLines = [header![2]];
    } else if (activeKey) {
      activeLines.push(line);
    }
  }
  flush();
  // A bare script or a follow-up such as "继续" is not a card snapshot.
  if (!source.segmented_script || Object.keys(source).length < 2) return null;
  for (const [key, value] of Object.entries(options.defaults || {})) {
    if (!Object.hasOwn(source, key) && value !== undefined) {
      source[key] = value;
      fieldSources[key as keyof StoryboardDirectorInput] = "default";
    }
  }
  if (!source.director_mode) {
    source.director_mode = options.directorMode || "high_energy";
    fieldSources.director_mode = "default";
  }
  if (!Object.hasOwn(source, "special_notes")) {
    source.special_notes = "";
    fieldSources.special_notes = "default";
  }
  const missingFields: string[] = CARD_KEYS.filter(key => key !== "special_notes" && !String(source[key] ?? "").trim());
  for (const key of duplicateFields) missingFields.push(`duplicate:${key}`);
  if (invalidAssetReceipt) missingFields.push("invalid:director_assets_receipt");
  if (source.aspect_ratio && !/^(?:16:9|9:16)$/.test(String(source.aspect_ratio).trim())) missingFields.push("invalid:aspect_ratio");
  if (source.target_duration_seconds && !/^(?:8|10|15)(?:\D|$)/.test(String(source.target_duration_seconds).trim())) missingFields.push("invalid:target_duration_seconds");
  return { input: normalizeStoryboardDirectorInput(source), fieldSources, missingFields,
    ...(referenceProjectId ? { referenceProjectId } : {}) };
}
