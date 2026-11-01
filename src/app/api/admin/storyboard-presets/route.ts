import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { StoryboardPresetError } from "@/lib/storyboard-preset-assets";
import { loadStoryboardPresetCatalog, mutateStoryboardPresetCatalog, type StoryboardPresetMutation } from "@/lib/server/storyboard-preset-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof StoryboardPresetError ? error.message : "预设库操作未确认，请刷新查询", code: error instanceof StoryboardPresetError ? error.code : "PRESET_OPERATION_UNAVAILABLE" }, { status: error instanceof StoryboardPresetError ? error.status : 503, headers });
}
async function readBody(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "请求体为空", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 32 * 1024) {
        await reader.cancel();
        throw new StoryboardPresetError("PRESET_INPUT_INVALID", "预设操作请求过大", 413);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
export async function GET(request: NextRequest) {
  const auth = await authorizeAdminCapability(request, "platform.settings.manage", { requireStepUp: true, operation: "storyboard_presets_read", auditAllowed: true });
  if (!auth.ok) return auth.response;
  try { return NextResponse.json({ catalog: (await loadStoryboardPresetCatalog(getSupabaseAdminClient())).catalog }, { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const auth = await authorizeAdminCapability(request, "platform.settings.manage", { requireStepUp: true, operation: "storyboard_presets_mutate", auditAllowed: true });
  if (!auth.ok) return auth.response;
  try {
    const text = await readBody(request);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new StoryboardPresetError("PRESET_INPUT_INVALID", "请求不是有效JSON", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["action", "expectedRevision", "presetId", "draft"].includes(key))) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "预设操作参数无效", 400);
    return NextResponse.json(await mutateStoryboardPresetCatalog(auth.user.id, body as StoryboardPresetMutation), { headers });
  } catch (error) { return failure(error); }
}
