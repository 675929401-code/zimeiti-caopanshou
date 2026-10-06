import { NextRequest, NextResponse } from "next/server";
import { withAuth, type ApiHandler, type AuthUser } from "@/lib/api-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAgentNavigationKey,
} from "@/lib/agent-category-access";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";

type AppSupabaseClient = Parameters<ApiHandler>[1];
type AgentFavoritesDatabase = {
  public: {
    Tables: {
      agents: {
        Row: { id: string; name: string; category: string; user_access: string | null; is_active: boolean | null; deleted_at: string | null };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      categories: {
        Row: { id: string; name: string; visibility: string | null; is_active: boolean | null };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      agent_favorites: {
        Row: { id: string; user_id: string; agent_id: string; created_at: string };
        Insert: { id?: string; user_id: string; agent_id: string; created_at?: string };
        Update: Partial<{ user_id: string; agent_id: string; created_at: string }>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
type AgentFavoritesClient = SupabaseClient<AgentFavoritesDatabase>;

function asAgentFavoritesClient(client: AppSupabaseClient): AgentFavoritesClient {
  return client as unknown as AgentFavoritesClient;
}

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization, Cookie",
};

async function canUseAgent(
  supabase: AgentFavoritesClient,
  user: AuthUser,
  agentId: string,
  allowedNavigationKeys: ReadonlySet<string>,
) {
  const { data: agent, error } = await supabase
    .from("agents")
    .select("id,name,category,user_access,is_active,deleted_at")
    .eq("id", agentId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!agent) return false;
  if (agent.user_access === "hidden" || agent.is_active === false) return false;

  const { data: category, error: categoryError } = await supabase
    .from("categories")
    .select("id,name,visibility,is_active")
    .eq("name", agent.category)
    .maybeSingle();
  if (categoryError) throw categoryError;
  if (!category || category.is_active === false || category.visibility === "private") return false;
  const navigationKey = getAgentNavigationKey(agent);
  if (!navigationKey) return false;
  return allowedNavigationKeys.has(navigationKey);
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, supabase) => {
    const { data, error } = await asAgentFavoritesClient(supabase)
      .from("agent_favorites")
      .select("agent_id,created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[agent-favorites] read failed:", error.message);
      return NextResponse.json({ error: "收藏暂时无法读取" }, { status: 503, headers: RESPONSE_HEADERS });
    }
    return NextResponse.json({ favorites: data || [], count: data?.length || 0 }, { headers: RESPONSE_HEADERS });
  });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user, supabase) => {
    const db = asAgentFavoritesClient(supabase);
    const body = await request.json().catch(() => null);
    const agentId = typeof body?.agent_id === "string" ? body.agent_id.trim() : "";
    if (!agentId || agentId.length > 255) {
      return NextResponse.json({ error: "智能体标识无效" }, { status: 400, headers: RESPONSE_HEADERS });
    }
    try {
      const permission = await readMemberPermissionSnapshot(user.id, { knownRole: user.role });
      if (permission.authorityStatus !== "ready" || !permission.integrityValid) {
        return NextResponse.json(
          {
            error: "会员权限校验暂不可用，本次未保存收藏",
            code: permission.authorityStatus === "invalid"
              ? "MEMBER_PERMISSION_INTEGRITY_INVALID"
              : "MEMBER_PERMISSION_AUTHORITY_UNAVAILABLE",
          },
          { status: 503, headers: RESPONSE_HEADERS },
        );
      }
      if (!(await canUseAgent(db, user, agentId, new Set(permission.agentNavigationKeys)))) {
        return NextResponse.json({ error: "该智能体不可收藏" }, { status: 404, headers: RESPONSE_HEADERS });
      }
      const { error } = await db
        .from("agent_favorites")
        .upsert({ user_id: user.id, agent_id: agentId }, { onConflict: "user_id,agent_id", ignoreDuplicates: true });
      if (error) throw error;
      return NextResponse.json({ success: true, agent_id: agentId }, { headers: RESPONSE_HEADERS });
    } catch (error) {
      console.error("[agent-favorites] save failed:", error instanceof Error ? error.message : error);
      return NextResponse.json({ error: "收藏尚未保存，请稍后重试" }, { status: 503, headers: RESPONSE_HEADERS });
    }
  });
}

export async function DELETE(request: NextRequest) {
  return withAuth(request, async (user, supabase) => {
    const db = asAgentFavoritesClient(supabase);
    const agentId = new URL(request.url).searchParams.get("agent_id")?.trim() || "";
    if (!agentId || agentId.length > 255) {
      return NextResponse.json({ error: "智能体标识无效" }, { status: 400, headers: RESPONSE_HEADERS });
    }
    const { error } = await db
      .from("agent_favorites")
      .delete()
      .eq("user_id", user.id)
      .eq("agent_id", agentId);
    if (error) {
      console.error("[agent-favorites] delete failed:", error.message);
      return NextResponse.json({ error: "取消收藏失败，请稍后重试" }, { status: 503, headers: RESPONSE_HEADERS });
    }
    return NextResponse.json({ success: true, agent_id: agentId }, { headers: RESPONSE_HEADERS });
  });
}
