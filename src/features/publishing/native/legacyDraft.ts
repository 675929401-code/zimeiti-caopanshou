import type { PublishingDraft } from "@/lib/publishing-contract";
import type { PublishingV2DraftInput } from "@/lib/publishing-v2-contract";

/** Build an independent V2 copy. Legacy IDs, revisions, targets and storage are never mutated. */
export function legacyDraftToNative(draft: PublishingDraft, collectionId: string | null): PublishingV2DraftInput {
  const isVideo = (asset: PublishingDraft["assets"][number]) => asset.type.startsWith("video/") || /\.mp4$/i.test(asset.fileName);
  const hasVideo = draft.assets.some(isVideo);
  return {
    schemaVersion: 2,
    collectionId,
    contentType: hasVideo ? "video" : "image",
    title: draft.title,
    body: draft.body,
    topics: [...draft.topics],
    targets: [],
    media: draft.assets.map<PublishingV2DraftInput["media"][number]>(asset => ({
      id: crypto.randomUUID(),
      role: isVideo(asset) ? "video" : hasVideo ? "cover" : "image",
      fileName: asset.fileName,
      size: asset.size,
      type: asset.type,
      lastModified: asset.lastModified,
      ...(asset.hash ? { hash: asset.hash } : {}),
      source: "local_file",
      requiresReselection: true,
    })),
  };
}
