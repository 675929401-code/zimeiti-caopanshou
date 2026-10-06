import "server-only";

import { readAsset } from "../../commerce/server/assets";
import type { MaterialKind, ProductionDraft, ProductionMaterial } from "../domain/contracts";

function kindForMime(type: string): MaterialKind | null {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return null;
}

export function canonicalizeProductionMaterials(owner: string, draft: ProductionDraft): ProductionDraft {
  const materials = draft.materials.map((material): ProductionMaterial => {
    if (material.source === "local-session") {
      if (material.assetId) throw new Error("本轮临时素材不能冒充资产库素材");
      return { ...material, assetId: undefined, sha256: undefined, size: undefined, mimeType: undefined };
    }
    if (!material.assetId) throw new Error("资产库素材缺少稳定资产标识");
    const asset = readAsset(material.assetId, owner);
    if (!asset) throw new Error(`素材“${material.name}”不存在或不属于当前账号`);
    const kind = kindForMime(asset.type);
    if (!kind || kind !== material.kind) throw new Error(`素材“${material.name}”的媒体类型已经变化`);
    return {
      instanceId: material.instanceId,
      assetId: asset.id,
      name: asset.name,
      kind,
      role: material.role,
      source: "asset-library",
      mimeType: asset.type,
      size: asset.size,
      sha256: asset.sha256,
    };
  });
  return { ...draft, materials };
}
