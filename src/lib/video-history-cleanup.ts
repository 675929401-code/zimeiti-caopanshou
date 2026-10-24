import path from "node:path";

import { resolveAppRuntimeDir } from "@/lib/runtime-paths";
import { removeVideoThumbnailCacheFiles } from "@/lib/video-thumbnail-cache";

/**
 * Clearing history hides the rows but used to leave their rendered covers on
 * disk forever. Removing them keeps the feature loop closed:按需生成的封面随
 * 历史一起清理，重新生成时再按需抽取。
 */
export async function removeVideoHistoryThumbnails(taskIds: readonly string[]): Promise<number> {
  if (!taskIds.length) return 0;
  return removeVideoThumbnailCacheFiles(path.join(resolveAppRuntimeDir(), "video-thumbnails"), taskIds);
}
