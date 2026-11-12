const DRAFT_VERSION = 1;
const MAX_CARDS = 40;
const MAX_TEXT = 20_000;
const MAX_URLS = 12;

export interface VideoPageDraftCard {
  localId: number;
  prompt?: string;
  negativePrompt?: string;
  durationSeconds?: number | null;
  aspectRatio?: string;
  resolution?: string;
  referenceImageUrl?: string;
  referenceImageUrls?: string[];
  referenceAudioUrls?: string[];
  sourceVideoUrl?: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  audioUrl?: string;
  fps?: number;
  seed?: string;
  generateAudio?: boolean;
  followsSourceDuration?: boolean;
  modelId?: string;
  modelName?: string;
  taskLabel?: string;
  theme?: string;
  batchTopic?: string;
}

const text = (value: unknown, max = MAX_TEXT) => typeof value === "string" ? value.slice(0, max) : undefined;
const url = (value: unknown) => {
  const valueText = text(value, 4_000);
  return valueText && /^(?:https?:\/\/|\/)/u.test(valueText) ? valueText : undefined;
};
const urls = (value: unknown) => Array.isArray(value) ? value.map(url).filter((item): item is string => Boolean(item)).slice(0, MAX_URLS) : undefined;

function normalize(value: unknown): VideoPageDraftCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const localId = Number(row.localId);
  if (!Number.isSafeInteger(localId) || localId < 1) return null;
  return {
    localId,
    ...(text(row.prompt) !== undefined ? { prompt: text(row.prompt) } : {}),
    ...(text(row.negativePrompt) !== undefined ? { negativePrompt: text(row.negativePrompt) } : {}),
    ...(typeof row.durationSeconds === "number" && Number.isFinite(row.durationSeconds) ? { durationSeconds: row.durationSeconds } : {}),
    ...(text(row.aspectRatio, 32) ? { aspectRatio: text(row.aspectRatio, 32) } : {}),
    ...(text(row.resolution, 32) ? { resolution: text(row.resolution, 32) } : {}),
    ...(url(row.referenceImageUrl) ? { referenceImageUrl: url(row.referenceImageUrl) } : {}),
    ...(urls(row.referenceImageUrls)?.length ? { referenceImageUrls: urls(row.referenceImageUrls) } : {}),
    ...(urls(row.referenceAudioUrls)?.length ? { referenceAudioUrls: urls(row.referenceAudioUrls) } : {}),
    ...(url(row.sourceVideoUrl) ? { sourceVideoUrl: url(row.sourceVideoUrl) } : {}),
    ...(url(row.firstFrameUrl) ? { firstFrameUrl: url(row.firstFrameUrl) } : {}),
    ...(url(row.lastFrameUrl) ? { lastFrameUrl: url(row.lastFrameUrl) } : {}),
    ...(url(row.audioUrl) ? { audioUrl: url(row.audioUrl) } : {}),
    ...(typeof row.fps === "number" && Number.isFinite(row.fps) ? { fps: row.fps } : {}),
    ...(text(row.seed, 256) ? { seed: text(row.seed, 256) } : {}),
    ...(typeof row.generateAudio === "boolean" ? { generateAudio: row.generateAudio } : {}),
    ...(typeof row.followsSourceDuration === "boolean" ? { followsSourceDuration: row.followsSourceDuration } : {}),
    ...(text(row.modelId, 200) ? { modelId: text(row.modelId, 200) } : {}),
    ...(text(row.modelName, 300) ? { modelName: text(row.modelName, 300) } : {}),
    ...(text(row.taskLabel, 300) ? { taskLabel: text(row.taskLabel, 300) } : {}),
    ...(text(row.theme, 300) ? { theme: text(row.theme, 300) } : {}),
    ...(text(row.batchTopic, 500) ? { batchTopic: text(row.batchTopic, 500) } : {}),
  };
}

export function readVideoPageDraft(storage: Storage | null, key: string): VideoPageDraftCard[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null") as { version?: unknown; cards?: unknown } | null;
    if (!parsed || parsed.version !== DRAFT_VERSION || !Array.isArray(parsed.cards)) return [];
    return parsed.cards.slice(0, MAX_CARDS).map(normalize).filter((item): item is VideoPageDraftCard => Boolean(item));
  } catch {
    return [];
  }
}

export function writeVideoPageDraft(storage: Storage | null, key: string, cards: VideoPageDraftCard[]): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ version: DRAFT_VERSION, savedAt: Date.now(), cards: cards.slice(0, MAX_CARDS) }));
  } catch {
    // Drafts are best-effort; a full quota must not block the workbench.
  }
}
