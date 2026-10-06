import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { loadCanvasPromptPresetStore } from "@/lib/server/canvas-prompt-store";

export async function GET() {
  try {
    const store = await loadCanvasPromptPresetStore(getSupabaseAdminClient());
    const presets = store.presets
      .filter((preset) => preset.enabled)
      .map(({ id, name, summary, category, accent, version }) => ({
        id,
        name,
        summary,
        category,
        accent,
        version,
      }));
    return NextResponse.json({ presets });
  } catch (error) {
    console.error("[canvas-prompts] Public list failed:", error);
    return NextResponse.json({ error: "提示词方案加载失败" }, { status: 500 });
  }
}
