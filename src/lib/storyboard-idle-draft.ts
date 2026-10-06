export const STORYBOARD_IDLE_DRAFT_KEY = "storyboard_workbench_idle_draft_v3";

const ID = /^[A-Za-z0-9_-]{1,160}$/u;
const RATIO = new Set(["16:9", "9:16", "1:1"]);
const MAX_CARDS = 20;
const MAX_TEXT = 50_000;
const MAX_SHORT_TEXT = 240;

export type StoryboardIdleDraft = {
  version: 1;
  savedAt: number;
  id: string;
  createdAt: number;
  title: string;
  ratio: "16:9" | "9:16" | "1:1";
  imageResolution: string;
  videoResolution: string;
  videoDuration: number;
  imageModelId: string;
  videoModelId: string;
  cards: Array<{
    id: string;
    order: number;
    label: string;
    narration: string;
    imagePrompt: string;
    imageExactText: string;
    videoPrompt: string;
    referenceCount: number;
  }>;
};

function safeShort(value: unknown) {
  return typeof value === "string" && value.length <= MAX_SHORT_TEXT ? value : null;
}

function safePrompt(value: unknown) {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : null;
}

export function parseStoryboardIdleDraft(raw: string | null): StoryboardIdleDraft | null {
  if (!raw || raw.length > 2_000_000) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoryboardIdleDraft>;
    if (!value || value.version !== 1 || !Number.isFinite(value.savedAt) || !Number.isFinite(value.createdAt)
      || typeof value.id !== "string" || !ID.test(value.id)
      || !RATIO.has(String(value.ratio)) || !Array.isArray(value.cards)
      || value.cards.length < 1 || value.cards.length > MAX_CARDS) return null;
    const title = safeShort(value.title);
    const imageResolution = safeShort(value.imageResolution);
    const videoResolution = safeShort(value.videoResolution);
    const imageModelId = safeShort(value.imageModelId);
    const videoModelId = safeShort(value.videoModelId);
    const videoDuration = Number(value.videoDuration);
    if (title === null || imageResolution === null || videoResolution === null || imageModelId === null || videoModelId === null
      || !Number.isFinite(videoDuration) || videoDuration <= 0 || videoDuration > 600) return null;
    const seen = new Set<string>();
    const cards: StoryboardIdleDraft["cards"] = [];
    for (const [index, card] of value.cards.entries()) {
      const id = typeof card?.id === "string" ? card.id : "";
      const label = safeShort(card?.label);
      const narration = safePrompt(card?.narration);
      const imagePrompt = safePrompt(card?.imagePrompt);
      const imageExactText = safeShort(card?.imageExactText);
      const videoPrompt = safePrompt(card?.videoPrompt);
      if (!ID.test(id) || seen.has(id) || label === null || narration === null || imagePrompt === null
        || imageExactText === null || videoPrompt === null) return null;
      seen.add(id);
      cards.push({
        id,
        order: index + 1,
        label,
        narration,
        imagePrompt,
        imageExactText,
        videoPrompt,
        referenceCount: Math.max(0, Math.min(9, Number.isInteger(card.referenceCount) ? Number(card.referenceCount) : 0)),
      });
    }
    return {
      version: 1,
      savedAt: Number(value.savedAt),
      id: value.id,
      createdAt: Number(value.createdAt),
      title,
      ratio: value.ratio as StoryboardIdleDraft["ratio"],
      imageResolution,
      videoResolution,
      videoDuration,
      imageModelId,
      videoModelId,
      cards,
    };
  } catch {
    return null;
  }
}

export function serializeStoryboardIdleDraft(input: Omit<StoryboardIdleDraft, "version" | "savedAt">, savedAt = Date.now()) {
  const hasText = input.cards.some((card) => Boolean(
    card.label.trim() || card.narration.trim() || card.imagePrompt.trim() || card.imageExactText.trim()
    || card.videoPrompt.trim() || card.referenceCount > 0
  ));
  if (!hasText && input.cards.length === 3 && input.title === "未命名分镜项目") return null;
  return JSON.stringify({ version: 1, savedAt, ...input });
}
