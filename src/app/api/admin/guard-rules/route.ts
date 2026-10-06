/**
 * 防护规则管理 API — 管理员自定义关键词的增删改查
 */
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { clearRulesCache } from "@/lib/prompt-guard";

/** 验证管理员权限 */
async function verifyAdmin(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "未登录", status: 401 };
  }
  const payload = await verifyAdminToken(authHeader.slice(7));
  if (!payload || payload.role !== "admin") {
    return { error: "无权限", status: 403 };
  }
  return { payload };
}

/** GET — 获取所有规则 */
export async function GET(request: Request) {
  try {
    const auth = await verifyAdmin(request);
    if ("error" in auth) {
      return new Response(JSON.stringify({ error: auth.error }), { status: auth.status });
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from("prompt_guard_rules")
      .select("*")
      .order("category", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    return new Response(JSON.stringify({ rules: data }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}

/** POST — 新增规则 */
export async function POST(request: Request) {
  try {
    const auth = await verifyAdmin(request);
    if ("error" in auth) {
      return new Response(JSON.stringify({ error: auth.error }), { status: auth.status });
    }

    const body = await request.json();
    const { keyword, risk_level, description } = body;

    if (!keyword || typeof keyword !== "string" || keyword.trim().length === 0) {
      return new Response(JSON.stringify({ error: "关键词不能为空" }), { status: 400 });
    }

    const validRiskLevels = ["high", "medium"];
    if (!validRiskLevels.includes(risk_level)) {
      return new Response(JSON.stringify({ error: "风险等级必须为 high 或 medium" }), { status: 400 });
    }

    const client = getSupabaseClient();

    // 检查是否已存在相同关键词
    const { data: existing } = await client
      .from("prompt_guard_rules")
      .select("id")
      .eq("keyword", keyword.trim())
      .maybeSingle();

    if (existing) {
      return new Response(JSON.stringify({ error: "该关键词已存在" }), { status: 409 });
    }

    const { data, error } = await client
      .from("prompt_guard_rules")
      .insert({
        keyword: keyword.trim(),
        risk_level,
        description: description || null,
        category: "custom",
        is_enabled: true,
      })
      .select()
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    // 清除缓存
    clearRulesCache();

    return new Response(JSON.stringify({ rule: data }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}

/** PUT — 更新规则（开关/关键词/风险等级） */
export async function PUT(request: Request) {
  try {
    const auth = await verifyAdmin(request);
    if ("error" in auth) {
      return new Response(JSON.stringify({ error: auth.error }), { status: auth.status });
    }

    const body = await request.json();
    const { id, keyword, risk_level, is_enabled, description } = body;

    if (!id) {
      return new Response(JSON.stringify({ error: "缺少规则 ID" }), { status: 400 });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (keyword !== undefined) updates.keyword = keyword.trim();
    if (risk_level !== undefined) {
      if (!["high", "medium"].includes(risk_level)) {
        return new Response(JSON.stringify({ error: "风险等级必须为 high 或 medium" }), { status: 400 });
      }
      updates.risk_level = risk_level;
    }
    if (is_enabled !== undefined) updates.is_enabled = is_enabled;
    if (description !== undefined) updates.description = description;

    const client = getSupabaseClient();
    const { data, error } = await client
      .from("prompt_guard_rules")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    // 清除缓存
    clearRulesCache();

    return new Response(JSON.stringify({ rule: data }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}

/** DELETE — 删除规则 */
export async function DELETE(request: Request) {
  try {
    const auth = await verifyAdmin(request);
    if ("error" in auth) {
      return new Response(JSON.stringify({ error: auth.error }), { status: auth.status });
    }

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(JSON.stringify({ error: "缺少规则 ID" }), { status: 400 });
    }

    const client = getSupabaseClient();
    const { error } = await client
      .from("prompt_guard_rules")
      .delete()
      .eq("id", id);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    // 清除缓存
    clearRulesCache();

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
