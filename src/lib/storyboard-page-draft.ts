const DRAFT_VERSION = 1;
const MAX_CARDS = 40;
const MAX_TEXT = 20_000;

export interface StoryboardPageDraft {
  ratio?: string;
  imageResolution?: string;
  videoResolution?: string;
  videoDuration?: number;
  imageModelId?: string;
  videoModelId?: string;
  cards: Array<{ order: number; narration?: string; imagePrompt?: string; videoPrompt?: string }>;
}

const text = (value: unknown, max = MAX_TEXT) => typeof value === "string" ? value.slice(0, max) : undefined;

export function readStoryboardPageDraft(storage: Storage | null, key: string): StoryboardPageDraft | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null") as { version?: unknown; draft?: unknown } | null;
    if (!parsed || parsed.version !== DRAFT_VERSION || !parsed.draft || typeof parsed.draft !== "object") return null;
    const row = parsed.draft as Record<string, unknown>;
    const cards = Array.isArray(row.cards) ? row.cards.map(value => {
      if (!value || typeof value !== "object") return null;
      const card = value as Record<string, unknown>;
      const order = Number(card.order);
      if (!Number.isSafeInteger(order) || order < 1 || order > MAX_CARDS) return null;
      return {
        order,
        ...(text(card.narration) !== undefined ? { narration: text(card.narration) } : {}),
        ...(text(card.imagePrompt) !== undefined ? { imagePrompt: text(card.imagePrompt) } : {}),
        ...(text(card.videoPrompt) !== undefined ? { videoPrompt: text(card.videoPrompt) } : {}),
      };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, MAX_CARDS) : [];
    if (!cards.length) return null;
    return {
      cards,
      ...(text(row.ratio, 32) ? { ratio: text(row.ratio, 32) } : {}),
      ...(text(row.imageResolution, 32) ? { imageResolution: text(row.imageResolution, 32) } : {}),
      ...(text(row.videoResolution, 32) ? { videoResolution: text(row.videoResolution, 32) } : {}),
      ...(typeof row.videoDuration === "number" && Number.isFinite(row.videoDuration) ? { videoDuration: row.videoDuration } : {}),
      ...(text(row.imageModelId, 200) ? { imageModelId: text(row.imageModelId, 200) } : {}),
      ...(text(row.videoModelId, 200) ? { videoModelId: text(row.videoModelId, 200) } : {}),
    };
  } catch {
    return null;
  }
}

export function writeStoryboardPageDraft(storage: Storage | null, key: string, draft: StoryboardPageDraft): void {
  if (!storage || !draft.cards.length) return;
  try {
    storage.setItem(key, JSON.stringify({ version: DRAFT_VERSION, savedAt: Date.now(), draft }));
  } catch {
    // Prompt drafts are best-effort; storage quota must not break the workbench.
  }
}
