import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  defaultStoryboardAgentConfig,
  parseStoryboardAgentConfig,
  STORYBOARD_AGENT_SETTING_KEY,
  type StoryboardAgentConfig,
} from "@/lib/storyboard-workbench";

export async function loadStoryboardAgentConfig(client: SupabaseClient) {
  const { data, error } = await client
    .from("platform_settings")
    .select("setting_value")
    .eq("setting_key", STORYBOARD_AGENT_SETTING_KEY)
    .maybeSingle();
  if (error) {
    console.warn("[storyboard-agent] Using built-in prompt:", error.message);
    return defaultStoryboardAgentConfig();
  }
  return parseStoryboardAgentConfig(data?.setting_value);
}

export async function saveStoryboardAgentConfig(client: SupabaseClient, config: StoryboardAgentConfig) {
  const { error } = await client.from("platform_settings").upsert({
    setting_key: STORYBOARD_AGENT_SETTING_KEY,
    setting_value: JSON.stringify(config),
    updated_at: new Date().toISOString(),
  }, { onConflict: "setting_key" });
  if (error) throw new Error(error.message);
}
