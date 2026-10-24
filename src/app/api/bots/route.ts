import { NextRequest, NextResponse } from "next/server";
import { getBotsCache, setBotsCache } from "@/lib/bots-cache";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { normalizeAgentPresetFields } from "@/lib/agent-preset-schema";
import { toPublicModelId } from "@/lib/public-model-dto";
import {
  getAgentNavigationKey,
} from "@/lib/agent-category-access";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { publicStoryboardDirectorOutputStyle } from "@/lib/storyboard-director-public-output-style";

type AgentRecord = Record<string, unknown>;
type CategoryRecord = { id: string; name: string; visibility?: string | null; is_active?: boolean | null };

const AGENT_SELECT =
  "id,name,description,avatar,source,bot_id,model,category,sort_order,cost_per_message,base_fee,is_active,preset_fields,user_access,model_id,cover_url,enable_think_tags,deep_thinking_type,enable_web_search,guide_message,response_format,token_billing_enabled,output_style";

async function getData() {
  try {
    const supabase = getSupabaseClient();
    const agentResult = await supabase
      .from("agents")
      .select(AGENT_SELECT)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true });

    if (agentResult.error) throw agentResult.error;

    const categoryResult = await supabase.from("categories").select("id, name, visibility, is_active");
    return {
      agents: (agentResult.data || []) as AgentRecord[],
      categories: (categoryResult.data || []) as CategoryRecord[],
      source: "supabase" as const,
    };
  } catch (error) {
    console.error("[bots] Supabase data source unavailable:", error);
    throw error;
  }
}

function formatAgent(agent: AgentRecord) {
  const outputStyle = publicStoryboardDirectorOutputStyle(agent.id, agent.output_style);
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || "",
    icon_url: agent.avatar || "",
    source: agent.source,
    bot_id: agent.bot_id || "",
    model: agent.model || "",
    category: agent.category || "通用",
    sort_order: agent.sort_order || 0,
    cost_per_message: agent.cost_per_message || 0,
    base_fee: agent.base_fee || 0,
    is_active: agent.is_active !== false,
    preset_fields: normalizeAgentPresetFields(agent.preset_fields || []),
    user_access: agent.user_access || "available",
    model_id: agent.model_id || null,
    model_public_id: agent.source === "llm" && agent.model_id ? toPublicModelId("chat", String(agent.model_id)) : null,
    cover_url: agent.cover_url || "",
    enable_think_tags: agent.enable_think_tags || false,
    deep_thinking_type: agent.deep_thinking_type ?? 0,
    enable_web_search: agent.enable_web_search ?? false,
    guide_message: agent.guide_message || "",
    response_format: agent.response_format || null,
    token_billing_enabled: !!agent.token_billing_enabled,
    deleted_at: agent.deleted_at || null,
    model_billing: null,
    ...(outputStyle ? { output_style: outputStyle } : {}),
  };
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const token = getTokenFromHeaders(request.headers);
    const cacheKey = token ? null : `bots:${url.search}:anon`;
    const cached = cacheKey ? getBotsCache(cacheKey) : null;
    if (cached) {
      return NextResponse.json(cached, { headers: { "X-Cache": "HIT" } });
    }

    const { agents, categories } = await getData();
    const categoryByName = new Map(categories.map((category) => [category.name, category]));
    const internalCategoryNames = new Set(
      categories
        .filter((category) => category.visibility === "private" || category.name.trim() === "自用")
        .map((category) => category.name)
    );

    let isAdmin = false;
    let allowedNavigationKeys: Set<string> | null = null;
    if (token) {
      const payload = await verifyToken(token);
      if (payload?.userId) {
        if (payload.role === "admin") {
          const authorization = await authorizeAdminCapability(request, "internal_tools.manage", {
            operation: "hidden_agent_catalog_read",
            requireStepUp: true,
          });
          isAdmin = authorization.ok;
        }
        const permission = await readMemberPermissionSnapshot(payload.userId, { knownRole: payload.role });
        if (permission.authorityStatus !== "ready" || !permission.integrityValid) {
          throw new Error(`MEMBER_PERMISSION_${permission.authorityStatus.toUpperCase()}`);
        }
        allowedNavigationKeys = new Set(permission.agentNavigationKeys);
      }
    }

    const visibleAgents = agents.filter((agent) => {
      if (agent.deleted_at != null) return false;
      const category = String(agent.category || "通用");
      const categoryRecord = categoryByName.get(category);
      if (!isAdmin && (!categoryRecord || categoryRecord.is_active === false || internalCategoryNames.has(category))) return false;
      if (!isAdmin && agent.user_access === "hidden") return false;
      if (allowedNavigationKeys !== null) {
        const navigationKey = getAgentNavigationKey({
          id: String(agent.id || ""),
          name: String(agent.name || ""),
          category,
        });
        if (!navigationKey || !allowedNavigationKeys.has(navigationKey)) return false;
      }
      return true;
    });

    const formattedAgents = visibleAgents.map(formatAgent);
    // The legacy default keeps both aliases for external callers. The main
    // client asks for one canonical array so the same 70 records are not sent
    // twice during chat bootstrap.
    const result = url.searchParams.get("shape") === "agents"
      ? { agents: formattedAgents, navigationKeys: allowedNavigationKeys ? [...allowedNavigationKeys] : null }
      : { bots: formattedAgents, agents: formattedAgents, navigationKeys: allowedNavigationKeys ? [...allowedNavigationKeys] : null };
    if (cacheKey) setBotsCache(cacheKey, result);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching agents:", error);
    return NextResponse.json({ error: "Realtime agent data unavailable" }, { status: 503 });
  }
}
