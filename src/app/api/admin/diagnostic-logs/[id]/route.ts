/**
 * 诊断日志详情 API（管理员）
 *
 * GET:  查看单条诊断日志详情
 * PUT:  更新诊断日志状态/备注
 */
import { authorizeAdminToken } from "@/lib/admin-auth";
import { redactOperationText } from "@/lib/operation-flight-recorder";
import { getSupabaseClient } from "@/storage/database/supabase-client";

async function authorize(request: Request) {
  const header = request.headers.get("authorization");
  return authorizeAdminToken(header?.startsWith("Bearer ") ? header.slice(7) : null);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authorization = await authorize(request);
    if (!authorization.ok) return Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/iu.test(id)) return Response.json({ error: "日志 ID 无效" }, { status: 400 });
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("diagnostic_logs")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return new Response(JSON.stringify({ error: "未找到" }), { status: 404 });
    }

    return new Response(
      JSON.stringify(data),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[admin/diagnostic-logs/detail] 查询异常:", err);
    return new Response(JSON.stringify({ error: "服务器异常" }), { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authorization = await authorize(request);
    if (!authorization.ok) return Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/iu.test(id)) return Response.json({ error: "日志 ID 无效" }, { status: 400 });
    const body = await request.json();

    const updateData: Record<string, unknown> = {};
    if (body.status) {
      const validStatuses = ["pending", "processing", "resolved", "ignored"];
      if (!validStatuses.includes(body.status)) {
        return new Response(
          JSON.stringify({ error: `status 不合法，允许值: ${validStatuses.join(", ")}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      updateData.status = body.status;
      if (body.status === "resolved") {
        updateData.resolved_at = new Date().toISOString();
      } else {
        updateData.resolved_at = null;
      }
    }
    if (body.admin_notes !== undefined) {
      if (typeof body.admin_notes !== "string" || body.admin_notes.length > 2000) {
        return Response.json({ error: "管理员备注最多 2000 字" }, { status: 400 });
      }
      updateData.admin_notes = redactOperationText(body.admin_notes, 2000) || null;
    }

    if (Object.keys(updateData).length === 0) {
      return new Response(
        JSON.stringify({ error: "无更新内容" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from("diagnostic_logs")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    return new Response(
      JSON.stringify({ success: true, data }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[admin/diagnostic-logs/detail] 更新异常:", err);
    return new Response(JSON.stringify({ error: "服务器异常" }), { status: 500 });
  }
}
