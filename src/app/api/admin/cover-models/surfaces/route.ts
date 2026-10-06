/**
 * Admin: update a cover (image) model's workspace surface distribution (WYSIWYG pool).
 * POST { id: string, surfaces: string[] }
 * Surfaces: "storyboard-workbench" (AI分镜工作台-生图), "image-workbench" (图片工作台).
 * Unset/empty config keeps legacy fail-open visibility; an explicit array enables strict filtering.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";

export async function POST(req: NextRequest) {
  const token = getTokenFromHeaders(req.headers);
  const admin = token ? await verifyAdminToken(token) : null;
  if (!admin) return NextResponse.json({ error: "\u65e0\u6743\u9650" }, { status: 403 });
  return NextResponse.json({
    error: "工作台模型发布已迁入统一能力门禁，请使用 /api/admin/workspace-models",
    code: "WORKSPACE_MODEL_ROUTING_MOVED",
  }, { status: 410 });
}

export async function GET(req: NextRequest) {
  const token = getTokenFromHeaders(req.headers);
  const admin = token ? await verifyAdminToken(token) : null;
  if (!admin) return NextResponse.json({ error: "无权限" }, { status: 403 });
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from('cover_models').select('id,api_protocol_config').eq('is_active', true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const map: Record<string, string[]> = {};
  for (const row of data || []) {
    const ws = row.api_protocol_config && Array.isArray(row.api_protocol_config.workspace_surfaces) ? row.api_protocol_config.workspace_surfaces : [];
    map[String(row.id)] = ws;
  }
  return NextResponse.json({ success: true, map });
}
