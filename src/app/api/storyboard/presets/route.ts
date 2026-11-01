import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { StoryboardPresetError } from "@/lib/storyboard-preset-assets";
import { listPublishedStoryboardPresets, resolvePublishedStoryboardPresetReference } from "@/lib/server/storyboard-preset-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    try {
      const params = request.nextUrl.searchParams;
      if (params.has("presetId")) {
        if (["role", "q", "offset", "limit"].some((key) => params.has(key))) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "预设引用和目录查询不能混用", 400);
        return NextResponse.json({ preset: await resolvePublishedStoryboardPresetReference({ presetId: params.get("presetId") || "", ...(params.has("revision") ? { revision: Number(params.get("revision")) } : {}) }) }, { headers });
      }
      if (params.has("revision")) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "预设版本必须同时提供预设标识", 400);
      return NextResponse.json(await listPublishedStoryboardPresets({ role: params.get("role") || "", q: params.get("q") || "", offset: Number(params.get("offset") ?? "0"), limit: Number(params.get("limit") ?? "60") }), { headers });
    } catch (error) {
      return NextResponse.json({ error: error instanceof StoryboardPresetError ? error.message : "预设图片暂时无法读取", code: error instanceof StoryboardPresetError ? error.code : "PRESET_READ_UNAVAILABLE" }, { status: error instanceof StoryboardPresetError ? error.status : 503, headers });
    }
  });
}
