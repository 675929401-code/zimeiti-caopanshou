type PersistableStoryboardCard = {
  referenceImageUrls: string[];
  imageUrl?: string;
  videoSourceImageUrl?: string;
  videoUrl?: string;
  videoContentUrl?: string;
};

type PersistableStoryboardRun = {
  cards: PersistableStoryboardCard[];
};

function stableLocalMediaUrl(value: string | undefined) {
  const normalized = String(value || "").trim();
  if (!normalized || /^(?:blob|data):/iu.test(normalized)) return undefined;
  return normalized;
}

/**
 * localStorage is only a lightweight submitted-history index. Binary payloads
 * belong in owned object storage (or IndexedDB while an upload is in progress).
 */
export function createStoryboardPersistenceSnapshot<T extends PersistableStoryboardRun>(run: T): T {
  return {
    ...run,
    cards: run.cards.map((card) => ({
      ...card,
      referenceImageUrls: card.referenceImageUrls
        .map((url) => stableLocalMediaUrl(url))
        .filter((url): url is string => Boolean(url)),
      imageUrl: stableLocalMediaUrl(card.imageUrl),
      videoSourceImageUrl: stableLocalMediaUrl(card.videoSourceImageUrl),
      videoUrl: stableLocalMediaUrl(card.videoUrl),
      videoContentUrl: stableLocalMediaUrl(card.videoContentUrl),
    })),
  } as T;
}
