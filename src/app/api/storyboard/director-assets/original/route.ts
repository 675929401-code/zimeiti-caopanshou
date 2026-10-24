import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import {
  parseStoryboardDirectorOriginalAssetQuery,
  resolveStoryboardDirectorOriginalAsset,
  storyboardDirectorOriginalAssetDependencies,
  StoryboardDirectorOriginalAssetError,
} from "@/lib/server/storyboard-director-original-asset";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

/** Read the original owned image only; no adoption, library write, generation or billing. */
export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    try {
      const query = parseStoryboardDirectorOriginalAssetQuery(request.nextUrl.searchParams);
      const candidate = await resolveStoryboardDirectorOriginalAsset({ userId: user.id, ...query },
        storyboardDirectorOriginalAssetDependencies(authenticatedDb));
      return NextResponse.json({ candidate }, { headers });
    } catch (error) {
      if (error instanceof StoryboardDirectorOriginalAssetError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
      }
      // Never forward database/provider errors, request snapshots or credentials.
      return NextResponse.json({ error: "原生成图核对暂时不可用，请稍后再试。", code: "DIRECTOR_ORIGINAL_ASSET_LOOKUP_UNAVAILABLE" }, { status: 503, headers });
    }
  });
}
