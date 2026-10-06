import { storageManager } from "@/storage/object";
import { createHash } from "node:crypto";
import type { ShortDramaAuthorizationContext } from "./permissions";
import { ShortDramaProjectRepository } from "./repository";
import { ShortDramaProductionError, ShortDramaProductionRepository } from "./production-repository";

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 1024 * 1024;

export interface OwnedFilmDownload {
  bytes: Buffer;
  contentType: "video/mp4" | "application/x-subrip; charset=utf-8";
  extension: "mp4" | "srt";
}

export async function readOwnedFilmExport(
  auth: ShortDramaAuthorizationContext,
  projectId: string,
  assetId: string,
): Promise<Buffer> {
  return (await readOwnedFilmDownload(auth, projectId, assetId, "export")).bytes;
}

export async function readOwnedFilmDownload(
  auth: ShortDramaAuthorizationContext,
  projectId: string,
  assetId: string,
  expectedRole?: "export" | "subtitle",
): Promise<OwnedFilmDownload> {
  const project = await new ShortDramaProjectRepository(auth.db).getProject(auth.userId, projectId);
  if (!project) throw new ShortDramaProductionError(404, "PROJECT_NOT_FOUND", "项目不存在");
  const repository = ShortDramaProductionRepository.fromAuth(auth);
  const snapshot = await repository.listProduction(auth.userId, projectId);
  const asset = snapshot.assets.find((item) => item.id === assetId
    && (item.assetRole === "export" || item.assetRole === "subtitle")
    && (!expectedRole || item.assetRole === expectedRole) && !item.shotId);
  const job = snapshot.jobs.find((item) => item.id === asset?.jobId && item.stage === "final_assembly" && item.state === "succeeded");
  if (!asset || !job || asset.provider !== "tencent_cos" || !asset.objectKey
    || asset.stableUri !== `object://tencent_cos/${encodeURIComponent(asset.objectKey)}`) {
    throw new ShortDramaProductionError(404, "FILM_EXPORT_NOT_FOUND", "未找到当前项目已完成的整片");
  }
  const isSubtitle = asset.assetRole === "subtitle";
  if (isSubtitle && (asset.metadata.format !== "srt"
    || asset.mimeType?.split(";", 1)[0].trim().toLowerCase() !== "application/x-subrip"
    || !snapshot.assets.some((item) => item.assetRole === "export" && !item.shotId && item.jobId === job.id
      && item.metadata.subtitleAssetId === asset.id && item.provider === "tencent_cos" && item.objectKey
      && item.stableUri === `object://tencent_cos/${encodeURIComponent(item.objectKey)}`))) {
    throw new ShortDramaProductionError(404, "FILM_SUBTITLE_NOT_FOUND", "未找到当前已完成成片对应的字幕");
  }
  const maximumBytes = isSubtitle ? MAX_SUBTITLE_BYTES : MAX_DOWNLOAD_BYTES;
  const expectedSize = asset.byteSize;
  if (!Number.isSafeInteger(expectedSize) || !expectedSize || expectedSize <= 0) {
    throw new ShortDramaProductionError(404, "FILM_EXPORT_UNAVAILABLE", "整片文件暂不可用");
  }
  if (expectedSize > maximumBytes) throw new ShortDramaProductionError(413, "FILM_EXPORT_TOO_LARGE", "文件超过当前下载大小限制");
  const bytes = await storageManager.read(asset.objectKey, "tencent_cos");
  if (bytes.length !== expectedSize || bytes.length > maximumBytes) {
    throw new ShortDramaProductionError(502, "FILM_EXPORT_SIZE_MISMATCH", "整片文件读取不完整，请稍后重试");
  }
  if (asset.checksumSha256 && createHash("sha256").update(bytes).digest("hex") !== asset.checksumSha256) {
    throw new ShortDramaProductionError(502, "FILM_EXPORT_CHECKSUM_MISMATCH", "整片文件校验未通过，请稍后重试");
  }
  if (isSubtitle) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!/^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\r?\n/u.test(text.trimStart())) throw new Error("INVALID_SRT");
    } catch {
      throw new ShortDramaProductionError(502, "FILM_SUBTITLE_INVALID", "字幕文件格式校验未通过，请稍后重试");
    }
  }
  return { bytes, contentType: isSubtitle ? "application/x-subrip; charset=utf-8" : "video/mp4", extension: isSubtitle ? "srt" : "mp4" };
}
