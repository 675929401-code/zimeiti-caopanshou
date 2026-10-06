import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import {
  parseStoryboardImageReadQuery,
  resolveOwnedStoryboardImageUrl,
  StoryboardImageReadError,
} from "@/lib/storyboard-image-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    try {
      const query = parseStoryboardImageReadQuery(request);
      const image = await resolveOwnedStoryboardImageUrl({
        db: authenticatedDb,
        userId: user.id,
        ...query,
      });
      return response(image);
    } catch (error) {
      if (error instanceof StoryboardImageReadError) {
        return response({ error: error.message, code: error.code }, error.status);
      }
      console.error("[storyboard/image] read failed", error instanceof Error ? error.name : "UnknownError");
      return response({ error: "图片暂时无法读取，请稍后重试", code: "IMAGE_READ_UNAVAILABLE" }, 503);
    }
  });
}
