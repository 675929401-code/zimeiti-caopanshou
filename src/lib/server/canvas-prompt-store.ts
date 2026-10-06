import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CANVAS_PROMPT_PRESETS_SETTING_KEY,
  createDefaultCanvasPromptPresetStore,
  parseCanvasPromptPresetStore,
  type CanvasPromptPresetStore,
} from "@/lib/canvas-prompt-presets";

export async function loadCanvasPromptPresetStore(client: SupabaseClient): Promise<CanvasPromptPresetStore> {
  const { data, error } = await client
    .from("platform_settings")
    .select("setting_value")
    .eq("setting_key", CANVAS_PROMPT_PRESETS_SETTING_KEY)
    .maybeSingle();

  if (error) {
    console.warn("[canvas-prompts] Falling back to built-in presets:", error.message);
    return createDefaultCanvasPromptPresetStore();
  }
  return parseCanvasPromptPresetStore(data?.setting_value);
}

export async function saveCanvasPromptPresetStore(client: SupabaseClient, store: CanvasPromptPresetStore) {
  const { error } = await client.from("platform_settings").upsert({
    setting_key: CANVAS_PROMPT_PRESETS_SETTING_KEY,
    setting_value: JSON.stringify(store),
    updated_at: new Date().toISOString(),
  }, { onConflict: "setting_key" });

  if (error) throw new Error(error.message);
}
