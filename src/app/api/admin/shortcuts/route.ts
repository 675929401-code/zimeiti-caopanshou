import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

// GET - 获取所有快捷图标（含未启用的）
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("shortcut_icons")
      .select("*")
      .order("sort_order", { ascending: true });

    if (error) return NextResponse.json({ error: "获取快捷图标失败" }, { status: 500 });
    return NextResponse.json({ shortcuts: data || [] });
  } catch {
    return NextResponse.json({ error: "获取快捷图标失败" }, { status: 500 });
  }
}

// POST - 创建快捷图标
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  try {
    const body = await request.json();
    const { title, icon_svg, icon_color, link_type, link_value, sort_order, is_active } = body;

    if (!title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    if (!icon_svg) return NextResponse.json({ error: "图标不能为空" }, { status: 400 });
    if (!link_value) return NextResponse.json({ error: "链接不能为空" }, { status: 400 });

    const client = getSupabaseClient();

    // 如果未指定 sort_order，取当前最大值 +1
    let nextSort = sort_order;
    if (nextSort === undefined || nextSort === null) {
      const { data: maxRow } = await client
        .from("shortcut_icons")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1)
        .single();
      nextSort = (maxRow?.sort_order ?? 0) + 1;
    }

    const { data, error } = await client
      .from("shortcut_icons")
      .insert({
        title,
        icon_svg,
        icon_color: icon_color || "#7C5CFF",
        link_type: link_type || "internal",
        link_value,
        sort_order: nextSort,
        is_active: is_active !== undefined ? is_active : true,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: `创建失败: ${error.message}` }, { status: 500 });
    return NextResponse.json({ success: true, shortcut: data });
  } catch {
    return NextResponse.json({ error: "创建快捷图标失败" }, { status: 500 });
  }
}

// PUT - 更新快捷图标（单个字段或整体更新）
export async function PUT(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  try {
    const body = await request.json();
    const { id, title, icon_svg, icon_color, link_type, link_value, sort_order, is_active } = body;

    if (!id) return NextResponse.json({ error: "ID不能为空" }, { status: 400 });

    const client = getSupabaseClient();
    const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) fields.title = title;
    if (icon_svg !== undefined) fields.icon_svg = icon_svg;
    if (icon_color !== undefined) fields.icon_color = icon_color;
    if (link_type !== undefined) fields.link_type = link_type;
    if (link_value !== undefined) fields.link_value = link_value;
    if (sort_order !== undefined) fields.sort_order = sort_order;
    if (is_active !== undefined) fields.is_active = is_active;

    const { data, error } = await client
      .from("shortcut_icons")
      .update(fields)
      .eq("id", id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: `更新失败: ${error.message}` }, { status: 500 });
    return NextResponse.json({ success: true, shortcut: data });
  } catch {
    return NextResponse.json({ error: "更新快捷图标失败" }, { status: 500 });
  }
}

// DELETE - 删除快捷图标
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  try {
    const { searchParams } = new URL(request.url);
    let id = searchParams.get("id");

    if (!id) {
      try {
        const body = await request.json();
        if (body.id) id = body.id;
      } catch { /* ignore */ }
    }

    if (!id) return NextResponse.json({ error: "ID不能为空" }, { status: 400 });

    const client = getSupabaseClient();
    const { error } = await client.from("shortcut_icons").delete().eq("id", id);

    if (error) return NextResponse.json({ error: `删除失败: ${error.message}` }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "删除快捷图标失败" }, { status: 500 });
  }
}
