/**
 * 技能管理 API
 *
 * 与 plugins API 同模式：管理员 CRUD + 智能体关联
 *
 * GET  - 列出所有技能（支持 ?agent_id=xxx 获取某智能体关联的技能）
 * POST - 创建技能
 * PUT  - 更新技能
 * DELETE - 删除技能
 */

import { getSupabaseClient } from "@/storage/database/supabase-client";
import { NextRequest, NextResponse } from "next/server";
import { invalidateSkillCache } from "@/lib/skill-registry";
import {
  ADMIN_SKILL_SOURCE_PERMISSIONS,
  ADMIN_SKILL_WRITE_PERMISSIONS,
  adminSkillSourceRequested,
} from "@/lib/admin-governance";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

const SKILL_METADATA_COLUMNS = [
  "id",
  "name",
  "display_name",
  "description",
  "icon",
  "category",
  "skill_type",
  "is_active",
  "sort_order",
  "created_at",
  "updated_at",
].join(",");

function toSkillMetadata(skill: Record<string, unknown>) {
  return {
    id: skill.id,
    name: skill.name,
    display_name: skill.display_name,
    description: skill.description,
    icon: skill.icon,
    category: skill.category,
    skill_type: skill.skill_type,
    is_active: skill.is_active,
    sort_order: skill.sort_order,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
  };
}

// ── GET: 获取技能列表 ──

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const includeSource = adminSkillSourceRequested(searchParams);
  const authorization = await authorizeAdminCapability(
    request,
    includeSource ? ADMIN_SKILL_SOURCE_PERMISSIONS.skills : "agents.view",
    {
      requireStepUp: includeSource,
      operation: includeSource ? "skill_source_view" : "skill_metadata_view",
    },
  );
  if (!authorization.ok) return authorization.response;

  try {
    const client = getSupabaseClient();
    const agentId = searchParams.get("agent_id");
    const sourceAccess = includeSource ? "visible" : "protected";

    // 如果指定了 agent_id，返回该智能体关联的技能（含关联状态）
    if (agentId) {
      // 先获取所有技能
      const { data: allSkills, error: skillsError } = await client
        .from("skills")
        .select(includeSource ? "*" : SKILL_METADATA_COLUMNS)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });

      if (skillsError) {
        return NextResponse.json({ error: "获取技能列表失败" }, { status: 500 });
      }

      // 获取该智能体已关联的技能
      const { data: agentSkills, error: asError } = await client
        .from("agent_skills")
        .select("skill_id, is_enabled, sort_order")
        .eq("agent_id", agentId);

      if (asError) {
        return NextResponse.json({ error: "获取智能体技能关联失败" }, { status: 500 });
      }

      // 合并：每个技能标记是否已关联
      const linkedSkillIds = new Set((agentSkills || []).map((as: { skill_id: string }) => as.skill_id));
      const skillsWithStatus = (allSkills || []).map((skill: Record<string, unknown>) => ({
        ...(includeSource ? skill : toSkillMetadata(skill)),
        linked: linkedSkillIds.has(skill.id as string),
        is_enabled: agentSkills?.find((as: { skill_id: string; is_enabled: boolean }) => as.skill_id === skill.id)?.is_enabled ?? true,
      }));

      return NextResponse.json({
        skills: skillsWithStatus,
        sourceAccess,
      });
    }

    // 未指定 agent_id：返回所有技能
    const { data, error } = await client
      .from("skills")
      .select(includeSource ? "*" : SKILL_METADATA_COLUMNS)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "获取技能列表失败" }, { status: 500 });
    }

    return NextResponse.json({
      skills: includeSource ? data : (data || []).map((skill: Record<string, unknown>) => toSkillMetadata(skill)),
      sourceAccess,
    });
  } catch (err) {
    console.error("Skills GET error:", err);
    return NextResponse.json({ error: "获取技能列表失败" }, { status: 500 });
  }
}

// ── POST: 创建技能 ──

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, ADMIN_SKILL_WRITE_PERMISSIONS.skills, {
    requireStepUp: true,
    operation: "skills_manage",
  });
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json();
    const {
      name, display_name, description, icon, category,
      skill_type, config, tool_definition, trigger_signals,
      is_active, sort_order,
    } = body;

    if (!name || !display_name || !tool_definition) {
      return NextResponse.json(
        { error: "名称、显示名称和工具定义为必填项" },
        { status: 400 }
      );
    }

    // 校验 tool_definition 格式
    if (!tool_definition.function?.name || !tool_definition.function?.parameters) {
      return NextResponse.json(
        { error: "tool_definition 必须包含 function.name 和 function.parameters" },
        { status: 400 }
      );
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from("skills")
      .insert({
        name,
        display_name,
        description: description || "",
        icon: icon || "🔧",
        category: category || "general",
        skill_type: skill_type || "coze_workflow",
        config: config || {},
        tool_definition,
        trigger_signals: trigger_signals || "",
        is_active: is_active ?? true,
        sort_order: sort_order || 0,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: `技能标识符 "${name}" 已存在` }, { status: 409 });
      }
      return NextResponse.json({ error: `创建技能失败: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      skill: toSkillMetadata(data as Record<string, unknown>),
      sourceAccess: "protected",
    });
  } catch (err) {
    console.error("Skills POST error:", err);
    return NextResponse.json({ error: "创建技能失败" }, { status: 500 });
  }
}

// ── PUT: 更新技能 ──

export async function PUT(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, ADMIN_SKILL_WRITE_PERMISSIONS.skills, {
    requireStepUp: true,
    operation: "skills_manage",
  });
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json();
    const { id, name, display_name, description, icon, category,
      skill_type, config, tool_definition, trigger_signals,
      is_active, sort_order } = body;

    if (!id) {
      return NextResponse.json({ error: "技能 ID 不能为空" }, { status: 400 });
    }

    const client = getSupabaseClient();
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (name !== undefined) updateData.name = name;
    if (display_name !== undefined) updateData.display_name = display_name;
    if (description !== undefined) updateData.description = description;
    if (icon !== undefined) updateData.icon = icon;
    if (category !== undefined) updateData.category = category;
    if (skill_type !== undefined) updateData.skill_type = skill_type;
    if (config !== undefined) updateData.config = config;
    if (tool_definition !== undefined) updateData.tool_definition = tool_definition;
    if (trigger_signals !== undefined) updateData.trigger_signals = trigger_signals;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (sort_order !== undefined) updateData.sort_order = sort_order;

    const { data, error } = await client
      .from("skills")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: `更新技能失败: ${error.message}` }, { status: 500 });
    }

    // 清除技能缓存
    invalidateSkillCache();

    return NextResponse.json({
      success: true,
      skill: toSkillMetadata(data as Record<string, unknown>),
      sourceAccess: "protected",
    });
  } catch (err) {
    console.error("Skills PUT error:", err);
    return NextResponse.json({ error: "更新技能失败" }, { status: 500 });
  }
}

// ── DELETE: 删除技能 ──

export async function DELETE(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, ADMIN_SKILL_WRITE_PERMISSIONS.skills, {
    requireStepUp: true,
    operation: "skills_manage",
  });
  if (!authorization.ok) return authorization.response;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "技能 ID 不能为空" }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 先删除关联关系
    await client.from("agent_skills").delete().eq("skill_id", id);

    // 再删除技能
    const { error } = await client.from("skills").delete().eq("id", id);

    if (error) {
      return NextResponse.json({ error: `删除技能失败: ${error.message}` }, { status: 500 });
    }

    // 清除缓存
    invalidateSkillCache();

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Skills DELETE error:", err);
    return NextResponse.json({ error: "删除技能失败" }, { status: 500 });
  }
}
