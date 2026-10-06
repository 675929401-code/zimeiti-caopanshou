import { createHash } from "node:crypto";
import { validateUploadBuffer } from "@/lib/file-upload-security";
import { safeFetch } from "@/lib/safe-fetch";
import { storageManager } from "@/storage/object";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const MAX_EXTRACTION_VIDEO_BYTES = 256 * 1024 * 1024;

function ownedFileName(clientRequestId: string, index: number, extension: string) {
  const digest = createHash("sha256")
    .update(`${clientRequestId}\u0000${index}`)
    .digest("hex")
    .slice(0, 24);
  return `extract-${digest}.${extension}`;
}

export async function persistExtractionVideo(input: {
  sourceUrl: string;
  userId: string;
  clientRequestId: string;
  index: number;
}): Promise<{ assetId: string }> {
  const downloaded = await safeFetch(input.sourceUrl, {
    timeoutMs: 120_000,
    maxBytes: MAX_EXTRACTION_VIDEO_BYTES,
    maxRedirects: 4,
    allowedContentTypes: ["video/*", "application/octet-stream"],
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://www.douyin.com/",
      Accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.5",
      "Accept-Encoding": "identity",
    },
  });
  const validated = validateUploadBuffer(downloaded.buffer, downloaded.contentType);
  if (!validated.contentType.startsWith("video/")) {
    throw new Error("EXTRACTION_RESULT_NOT_VIDEO");
  }
  const fileName = ownedFileName(input.clientRequestId, input.index, validated.extension);
  const uploaded = await storageManager.upload(
    downloaded.buffer,
    fileName,
    validated.contentType,
    {
      category: "video",
      prefix: "videos/extracted/",
      fileName,
      userId: input.userId,
      source: "toolbox-video-extraction",
      meta: { clientRequestId: input.clientRequestId, itemIndex: String(input.index) },
      requireOwnershipRecord: true,
    },
  );
  const db = getSupabaseClient();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lookup = await db
      .from("user_files")
      .select("id")
      .eq("user_id", input.userId)
      .eq("storage_key", uploaded.key)
      .maybeSingle();
    if (!lookup.error && lookup.data?.id) return { assetId: String(lookup.data.id) };
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 75 * (attempt + 1)));
  }
  throw new Error("EXTRACTION_OWNERSHIP_RECORD_MISSING");
}
