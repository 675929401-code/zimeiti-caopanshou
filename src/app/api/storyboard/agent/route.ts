import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { STORYBOARD_AGENT_VERSION } from "@/lib/storyboard-workbench";
import {
  StoryboardAgentPromptUpdateSchema,
  STORYBOARD_AGENT_PROMPT_MIN_LENGTH,
  STORYBOARD_AGENT_PROMPT_MAX_LENGTH,
} from "@/lib/storyboard-agent-prompt-contract";
import { loadStoryboardAgentConfig, saveStoryboardAgentConfig } from "@/lib/server/storyboard-agent-store";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

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
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "请求体必须是有效的 JSON", code: "STORYBOARD_AGENT_PROMPT_INVALID_JSON" }, { status: 400 });
    }
    const validation = StoryboardAgentPromptUpdateSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({
        error: validation.error.issues[0]?.message || "提示词格式无效",
        code: "STORYBOARD_AGENT_PROMPT_INVALID",
        minLength: STORYBOARD_AGENT_PROMPT_MIN_LENGTH,
        maxLength: STORYBOARD_AGENT_PROMPT_MAX_LENGTH,
      }, { status: 400 });
    }
    const { prompt } = validation.data;
    const config = { version: STORYBOARD_AGENT_VERSION, prompt, updatedAt: new Date().toISOString() };
    await saveStoryboardAgentConfig(getSupabaseAdminClient(), config);
    return NextResponse.json(config);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "提示词保存失败" }, { status: 500 });
  }
}
