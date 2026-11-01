export type MediaHistoryGalleryImage = {
  url: string;
  title?: string;
  label?: string;
  width?: number;
  height?: number;
  assetId?: string;
  storageKey?: string;
};

/** History IDs use the index in the validated gallery, as does the hide RPC. */
export function parseMediaHistoryGallery(content: unknown): { images: MediaHistoryGalleryImage[] } | null {
  if (typeof content !== "string" || !content.includes("image_gallery")) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.type !== "image_gallery" || !Array.isArray(parsed.images)) return null;
    const images = parsed.images.filter((image): image is MediaHistoryGalleryImage => (
      Boolean(image) && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string"
    ));
    return images.length ? { images } : null;
  } catch {
    return null;
  }
}
