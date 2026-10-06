import { NextRequest, NextResponse } from "next/server";
import type { StorageProviderType } from "@/storage/object";
import { storageManager } from "@/storage/object";
import { shortDramaErrorResponse, ShortDramaHttpError } from "@/lib/short-drama/http";
import { authorizeShortDramaRequest } from "@/lib/short-drama/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PreviewAssetRow {
  id: string;
  project_id: string;
  asset_role: string;
  provider: string;
  object_key: string;
  mime_type: string | null;
  created_at: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLE_PRIORITY: Record<string, number> = {
  export: 4,
  video: 3,
  image: 2,
  storyboard: 2,
};

function parseProjectIds(request: NextRequest): string[] {
  const ids = [...new Set(
    (request.nextUrl.searchParams.get("ids") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )];
  if (ids.length === 0 || ids.length > 100 || ids.some((id) => !UUID_PATTERN.test(id))) {
    throw new ShortDramaHttpError(400, "INVALID_PROJECT_IDS", "项目预览请求必须包含 1–100 个有效项目编号");
  }
  return ids;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const projectIds = parseProjectIds(request);
    const result = await auth.db
      .from("short_drama_assets")
      .select("id, project_id, asset_role, provider, object_key, mime_type, created_at")
      .eq("user_id", auth.userId)
      .in("project_id", projectIds)
      .in("asset_role", Object.keys(ROLE_PRIORITY))
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(5_000);
    if (result.error) throw result.error;

    const selected = new Map<string, PreviewAssetRow>();
    for (const row of (result.data || []) as PreviewAssetRow[]) {
      const current = selected.get(row.project_id);
      if (!current || (ROLE_PRIORITY[row.asset_role] || 0) > (ROLE_PRIORITY[current.asset_role] || 0)) {
        selected.set(row.project_id, row);
      }
    }

    const previews = await Promise.all([...selected.values()].map(async (asset) => {
      let previewUrl = "";
      if (asset.object_key && asset.provider) {
        try {
          previewUrl = await storageManager.getSignedUrl(
            asset.object_key,
            { expireTime: 15 * 60 },
            asset.provider as StorageProviderType,
          );
        } catch {
          previewUrl = "";
        }
      }
      return {
        projectId: asset.project_id,
        assetId: asset.id,
        assetRole: asset.asset_role,
        mimeType: asset.mime_type || "",
        previewUrl,
        createdAt: asset.created_at,
      };
    }));

    return NextResponse.json({ previews }, {
      status: 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return shortDramaErrorResponse(error, "projects:previews");
  }
}
