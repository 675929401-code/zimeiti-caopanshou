import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { STORYBOARD_AGENT_VERSION } from "@/lib/storyboard-workbench";
import { loadStoryboardAgentConfig, saveStoryboardAgentConfig } from "@/lib/server/storyboard-agent-store";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

const UpdateSchema = z.object({ prompt: z.string().trim().min(100).max(20000) });

export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeAdminCapability(request, "prompts.view", {
      operation: "storyboard_prompt_read",
      requireStepUp: true,
    });
    if (!authorization.ok) return authorization.response;
    return NextResponse.json(await loadStoryboardAgentConfig(getSupabaseAdminClient()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "提示词加载失败" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const authorization = await authorizeAdminCapability(request, "prompts.edit", {
      operation: "storyboard_prompt_update",
      requireStepUp: true,
    });
    if (!authorization.ok) return authorization.response;
    const { prompt } = UpdateSchema.parse(await request.json());
    const config = { version: STORYBOARD_AGENT_VERSION, prompt, updatedAt: new Date().toISOString() };
    await saveStoryboardAgentConfig(getSupabaseAdminClient(), config);
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "提示词保存失败" }, { status: 500 });
  }
}
