import { NextRequest, NextResponse } from "next/server";
import { supabaseRestApi } from "@/lib/supabase-rest";
import { withAdminAuth } from "@/lib/api-middleware";

/** GET /api/admin/prompt-versions?agent_id=xxx
 *  获取指定智能体的提示词版本历史（按时间倒序）
 */
export async function GET(request: NextRequest) {
  return withAdminAuth(request, async () => {

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agent_id");
  if (!agentId) {
    return NextResponse.json({ error: "缺少 agent_id" }, { status: 400 });
  }

  const { data, error } = await supabaseRestApi({
    method: "GET",
    path: "prompt_versions",
    query: {
      agent_id: `eq.${agentId}`,
      select: "id,prompt,created_at",
      order: "created_at.desc",
      limit: "200",
    },
  });

  if (error) {
    console.error("[prompt-versions] query error:", error);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }

  // 转换为前端兼容格式
  const rows = (data as Array<{ id: string; prompt: string; created_at: string }>) || [];
  const versions = rows.map((v) => ({
    id: v.id,
    ts: new Date(v.created_at).getTime(),
    prompt: v.prompt,
  }));

  return NextResponse.json({ versions });
  });
}

/** POST /api/admin/prompt-versions
 *  保存新版本 { agent_id, prompt, max_versions? }
 *  保留 max_versions 条（默认10），超出自动删除最旧的（FIFO覆盖）
 */
export async function POST(request: NextRequest) {
  return withAdminAuth(request, async () => {

  const body = await request.json();
  const { agent_id, prompt, max_versions = 10 } = body;
  if (!agent_id || !prompt?.trim()) {
    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  }

  // 检查是否和最新版本相同（避免重复保存）
  const { data: latestData } = await supabaseRestApi({
    method: "GET",
    path: "prompt_versions",
    query: {
      agent_id: `eq.${agent_id}`,
      select: "prompt",
      order: "created_at.desc",
      limit: "1",
    },
  });

  const latestRows = latestData as Array<{ prompt: string }> | null;
  if (latestRows && latestRows.length > 0 && latestRows[0].prompt === prompt) {
    return NextResponse.json({ message: "与最新版本相同，跳过", skipped: true });
  }

  // 插入新版本
  const { data, error } = await supabaseRestApi({
    method: "POST",
    path: "prompt_versions",
    body: { agent_id, prompt },
  });

  if (error) {
    console.error("[prompt-versions] insert error:", error);
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }

  // FIFO 覆盖：查出该智能体所有版本（按时间升序），超出上限则删除最旧的
  const { data: allData } = await supabaseRestApi({
    method: "GET",
    path: "prompt_versions",
    query: {
      agent_id: `eq.${agent_id}`,
      select: "id",
      order: "created_at.asc",
    },
  });

  const allRows = (allData as Array<{ id: string }>) || [];
  if (allRows.length > max_versions) {
    // 删除最旧的版本（前面的就是最旧的，因为按 created_at 升序排列）
    const idsToDelete = allRows.slice(0, allRows.length - max_versions).map((r) => r.id);
    if (idsToDelete.length > 0) {
      // 逐条删除（Supabase REST API 不支持 id=in.(...) 这种格式用 eq）
      for (const oldId of idsToDelete) {
        await supabaseRestApi({
          method: "DELETE",
          path: "prompt_versions",
          query: { id: `eq.${oldId}` },
        });
      }
      console.log(`[prompt-versions] FIFO覆盖: 删除了 ${idsToDelete.length} 条旧版本 (agent=${agent_id})`);
    }
  }

  const inserted = (data as Array<{ id: string; created_at: string }>)?.[0];
  return NextResponse.json({
    version: inserted
      ? {
          id: inserted.id,
          ts: new Date(inserted.created_at).getTime(),
          prompt,
        }
      : null,
  });
  });
}

/** DELETE /api/admin/prompt-versions?id=xxx 或 ?agent_id=xxx
 *  删除单条版本 或 清空某智能体的所有版本
 */
export async function DELETE(request: NextRequest) {
  return withAdminAuth(request, async () => {

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const agentId = searchParams.get("agent_id");

  if (id) {
    const { error } = await supabaseRestApi({
      method: "DELETE",
      path: "prompt_versions",
      query: { id: `eq.${id}` },
    });
    if (error) {
      console.error("[prompt-versions] delete error:", error);
      return NextResponse.json({ error: "删除失败" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  if (agentId) {
    const { error } = await supabaseRestApi({
      method: "DELETE",
      path: "prompt_versions",
      query: { agent_id: `eq.${agentId}` },
    });
    if (error) {
      console.error("[prompt-versions] clear error:", error);
      return NextResponse.json({ error: "清空失败" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "缺少 id 或 agent_id" }, { status: 400 });
  });
}
