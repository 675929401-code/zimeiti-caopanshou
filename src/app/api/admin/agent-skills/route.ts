/**
 * 智能体-技能关联 API
 *
 * POST  - 为智能体添加技能（批量）
 * PUT   - 更新关联状态（启用/禁用/排序）
 * DELETE - 移除智能体的技能
 */

import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";
import { invalidateSkillCache } from "@/lib/skill-registry";

async function requireAdmin(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const payload = await verifyAdminToken(token);
    if (payload && payload.role === "admin") return payload.userId;
    return null;
  } catch {
    return null;
  }
}

// ── GET: 获取智能体关联的技能ID列表 ──

export async function GET(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agent_id");

    if (!agentId) {
      return NextResponse.json({ error: "agent_id 参数不能为空" }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from("agent_skills")
      .select("skill_id")
      .eq("agent_id", agentId)
      .eq("is_enabled", true);

    if (error) {
      return NextResponse.json({ error: `查询失败: ${error.message}` }, { status: 500 });
    }

    const skill_ids = (data || []).map((row: { skill_id: string }) => row.skill_id);
    return NextResponse.json({ skill_ids });
  } catch (err) {
    console.error("AgentSkills GET error:", err);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}

// ── POST: 为智能体添加技能（支持批量） ──

export async function POST(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { agent_id, skill_ids } = body;

    if (!agent_id) {
      return NextResponse.json({ error: "agent_id 不能为空" }, { status: 400 });
    }

    const client = getSupabaseClient();

    if (skill_ids && Array.isArray(skill_ids)) {
      // 批量设置：先删旧的，再插新的（全量覆盖模式）
      await client.from("agent_skills").delete().eq("agent_id", agent_id);

      if (skill_ids.length > 0) {
        const rows = skill_ids.map((skill_id: string, index: number) => ({
          agent_id,
          skill_id,
          is_enabled: true,
          sort_order: index * 10,
        }));

        const { error } = await client.from("agent_skills").insert(rows);
        if (error) {
          return NextResponse.json({ error: `关联技能失败: ${error.message}` }, { status: 500 });
        }
      }

      // 清除缓存
      invalidateSkillCache(agent_id);

      return NextResponse.json({ success: true, agent_id, skill_ids });
    }

    // 单个添加
    const { skill_id } = body;
    if (!skill_id) {
      return NextResponse.json({ error: "skill_id 不能为空" }, { status: 400 });
    }

    const { data, error } = await client
      .from("agent_skills")
      .upsert({ agent_id, skill_id, is_enabled: true }, { onConflict: "agent_id,skill_id" })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: `关联技能失败: ${error.message}` }, { status: 500 });
    }

    invalidateSkillCache(agent_id);
    return NextResponse.json({ success: true, link: data });
  } catch (err) {
    console.error("AgentSkills POST error:", err);
    return NextResponse.json({ error: "关联技能失败" }, { status: 500 });
  }
}

// ── PUT: 更新关联 ──

export async function PUT(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { agent_id, skill_id, is_enabled, sort_order } = body;

    if (!agent_id || !skill_id) {
      return NextResponse.json({ error: "agent_id 和 skill_id 不能为空" }, { status: 400 });
    }

    const client = getSupabaseClient();
    const updateData: Record<string, unknown> = {};
    if (is_enabled !== undefined) updateData.is_enabled = is_enabled;
    if (sort_order !== undefined) updateData.sort_order = sort_order;

    const { data, error } = await client
      .from("agent_skills")
      .update(updateData)
      .eq("agent_id", agent_id)
      .eq("skill_id", skill_id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: `更新关联失败: ${error.message}` }, { status: 500 });
    }

    invalidateSkillCache(agent_id);
    return NextResponse.json({ success: true, link: data });
  } catch (err) {
    console.error("AgentSkills PUT error:", err);
    return NextResponse.json({ error: "更新关联失败" }, { status: 500 });
  }
}

// ── DELETE: 移除关联 ──

export async function DELETE(request: NextRequest) {
  const userId = await requireAdmin(request);
  if (!userId) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const agent_id = searchParams.get("agent_id");
    const skill_id = searchParams.get("skill_id");

    if (!agent_id) {
      return NextResponse.json({ error: "agent_id 不能为空" }, { status: 400 });
    }

    const client = getSupabaseClient();
    let query = client.from("agent_skills").delete().eq("agent_id", agent_id);

    if (skill_id) {
      query = query.eq("skill_id", skill_id);
    }

    const { error } = await query;

    if (error) {
      return NextResponse.json({ error: `移除关联失败: ${error.message}` }, { status: 500 });
    }

    invalidateSkillCache(agent_id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("AgentSkills DELETE error:", err);
    return NextResponse.json({ error: "移除关联失败" }, { status: 500 });
  }
}
