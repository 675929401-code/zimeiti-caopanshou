import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient, getSupabaseClient } from "@/storage/database/supabase-client";
import { invalidateBotsCache } from "@/lib/bots-cache";
import {
  generateAvatarUrlForAgent,
  replaceGeneratedAvatarIfUnclaimed,
  shouldGenerateAvatar,
} from "@/lib/auto-avatar/generator";
import {
  AgentAvatarGenerationPolicyError,
  parseAgentAvatarGenerationRequest,
  type AgentAvatarGenerationRequest,
} from "@/lib/server/agent-avatar-generation-policy";
import { appendAdminGovernanceAudit } from "@/lib/server/admin-governance-authority";

type AgentRow = {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
};

type GenerationClaim = {
  requestKey: string;
  fingerprint: string;
};

function policyFailure(error: unknown): NextResponse | null {
  if (!(error instanceof AgentAvatarGenerationPolicyError)) return null;
  return NextResponse.json(
    { success: false, error: error.message, code: error.code },
    { status: error.status, headers: { "Cache-Control": "no-store" } },
  );
}

function stylePrompt(scope: AgentAvatarGenerationRequest): string | undefined {
  return scope.style !== "主站3D卡通"
    ? `Requested optional style: ${scope.style}. ${scope.customPrompt}`.trim()
    : scope.customPrompt || undefined;
}

function requestFingerprint(scope: AgentAvatarGenerationRequest): string {
  const normalized = {
    mode: scope.mode,
    agentIds: scope.mode === "batch" ? scope.agentIds : [],
    singleAgentId: scope.singleAgentId,
    singleName: scope.singleAgent?.name || "",
    singleDescription: scope.singleAgent?.description || "",
    style: scope.style,
    customPrompt: scope.customPrompt,
    confirmedAgentCount: scope.confirmedAgentCount,
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Atomically claims a paid generation request through the governance audit
 * table's unique (actor_id, request_key) boundary. The RPC returns the existing
 * row on conflict, so only the caller whose random token is stored may proceed.
 */
async function claimPaidGeneration(
  request: NextRequest,
  actorId: string,
  scope: AgentAvatarGenerationRequest,
): Promise<GenerationClaim> {
  const fingerprint = requestFingerprint(scope);
  const requestKey = `agent-avatar:${crypto.createHash("sha256").update(scope.idempotencyKey).digest("hex")}`;
  const claimToken = crypto.randomUUID();
  const client = getSupabaseAdminClient();
  const readClaim = async (id?: string) => {
    let query = client
      .from("admin_governance_audit")
      .select("id,metadata")
      .eq("actor_id", actorId);
    query = id ? query.eq("id", id) : query.eq("request_key", requestKey);
    const { data, error } = await query.maybeSingle();
    return { data, error };
  };
  const assertClaimOwner = (metadataValue: unknown): void => {
    const metadata = (metadataValue || {}) as Record<string, unknown>;
    if (metadata.claimToken === claimToken) return;
    if (metadata.fingerprint !== fingerprint) {
      throw new AgentAvatarGenerationPolicyError(
        "同一幂等键对应了不同的头像生成范围",
        "AVATAR_GENERATION_IDEMPOTENCY_CONFLICT",
        409,
      );
    }
    throw new AgentAvatarGenerationPolicyError(
      "该头像生成请求已领取；为防止重复扣费，本次未再次执行",
      "AVATAR_GENERATION_ALREADY_CLAIMED",
      409,
    );
  };

  const existing = await readClaim();
  if (existing.error) {
    throw new AgentAvatarGenerationPolicyError(
      "暂时无法检查头像生成幂等边界",
      "AVATAR_GENERATION_CLAIM_UNAVAILABLE",
      503,
    );
  }
  if (existing.data) assertClaimOwner(existing.data.metadata);

  const { data: claimId, error: claimError } = await client.rpc("append_admin_governance_audit", {
    p_actor_id: actorId,
    p_actor_level: "admin",
    p_target_user_id: "",
    p_permission_key: "agents.manage",
    p_action: "agent_avatar_paid_generation_claim",
    p_result: "allowed",
    p_reason_code: "PAID_GENERATION_CONFIRMED",
    p_resource: "agent_avatar_generation",
    p_request_path: request.nextUrl.pathname,
    p_request_method: request.method,
    p_request_key: requestKey,
    p_request_ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip")
      || "unknown",
    p_user_agent: request.headers.get("user-agent") || "",
    p_metadata: {
      claimToken,
      fingerprint,
      mode: scope.mode,
      requestedCount: scope.confirmedAgentCount,
      targetIds: scope.mode === "batch" ? scope.agentIds : scope.singleAgentId ? [scope.singleAgentId] : [],
    },
  });
  if (claimError || !claimId) {
    // A concurrent winner can make the immutable audit RPC reject its
    // ON-CONFLICT update. Re-read the unique row and classify that as a safe
    // replay/conflict instead of treating it as permission to retry.
    const concurrent = await readClaim();
    if (!concurrent.error && concurrent.data) assertClaimOwner(concurrent.data.metadata);
    throw new AgentAvatarGenerationPolicyError(
      "暂时无法建立头像生成幂等边界",
      "AVATAR_GENERATION_CLAIM_UNAVAILABLE",
      503,
    );
  }

  const { data: claimed, error: readError } = await readClaim(String(claimId));
  if (readError || !claimed) {
    throw new AgentAvatarGenerationPolicyError(
      "无法确认头像生成幂等边界",
      "AVATAR_GENERATION_CLAIM_UNAVAILABLE",
      503,
    );
  }
  assertClaimOwner(claimed.metadata);
  return { requestKey, fingerprint };
}

async function recordGenerationResult(
  request: NextRequest,
  actorId: string,
  claim: GenerationClaim,
  result: "success" | "failure",
  metadata: Record<string, unknown>,
): Promise<void> {
  await appendAdminGovernanceAudit({
    actorId,
    actorLevel: "admin",
    permissionKey: "agents.manage",
    action: "agent_avatar_paid_generation_result",
    result,
    reasonCode: result === "success" ? "GENERATION_COMPLETED" : "GENERATION_FAILED",
    resource: "agent_avatar_generation",
    request,
    requestKey: `${claim.requestKey}:result`,
    metadata: { fingerprint: claim.fingerprint, ...metadata },
  });
}

// POST /api/admin/agents/batch-avatar
// The global admin governance boundary maps this write route to agents.manage
// with step-up. This handler adds the paid-operation scope and idempotency claim.
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/iu, "");
  if (!token) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const actor = await verifyAdminToken(token);
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可用" }, { status: 403 });
  }

  let scope: AgentAvatarGenerationRequest;
  try {
    const body = await request.json() as Record<string, unknown>;
    scope = parseAgentAvatarGenerationRequest(body, request.headers.get("idempotency-key"));
  } catch (error) {
    const failure = policyFailure(error);
    if (failure) return failure;
    return NextResponse.json(
      { success: false, error: "头像生成请求格式无效", code: "AVATAR_GENERATION_REQUEST_INVALID" },
      { status: 400 },
    );
  }

  const prompt = stylePrompt(scope);

  try {
    if (scope.mode === "single" && scope.singleAgent) {
      if (scope.singleAgentId) {
        const { data: current, error: currentError } = await getSupabaseClient()
          .from("agents")
          .select("id,avatar")
          .eq("id", scope.singleAgentId)
          .maybeSingle();
        if (currentError) {
          return NextResponse.json(
            { success: false, error: "读取当前头像失败", code: "AGENT_AVATAR_READ_FAILED" },
            { status: 500 },
          );
        }
        if (!current) {
          return NextResponse.json(
            { success: false, error: "智能体不存在", code: "AGENT_NOT_FOUND" },
            { status: 404 },
          );
        }
        if (!shouldGenerateAvatar(current.avatar)) {
          return NextResponse.json({
            success: false,
            error: "当前头像已由人工设置，自动任务不会覆盖。请先手动清除头像后再生成。",
            code: "MANUAL_AVATAR_PRESERVED",
          }, { status: 409 });
        }
      }

      const claim = await claimPaidGeneration(request, actor.userId, scope);
      try {
        const avatarUrl = await generateAvatarUrlForAgent(
          scope.singleAgent.name,
          scope.singleAgent.description || scope.singleAgent.name,
          `single-avatar-${scope.singleAgentId || "new"}`,
          prompt,
          { ownerUserId: actor.userId, source: "agent-avatar-generated" },
        );
        if (!avatarUrl) throw new Error("头像生成未返回有效图片，请检查后台启用的头像生图模型");

        if (scope.singleAgentId) {
          const commit = await replaceGeneratedAvatarIfUnclaimed(scope.singleAgentId, avatarUrl);
          if (commit === "manual-preserved") {
            await recordGenerationResult(request, actor.userId, claim, "failure", {
              code: "MANUAL_AVATAR_PRESERVED",
              generatedCount: 1,
              savedCount: 0,
            });
            return NextResponse.json({
              success: false,
              error: "生成期间头像已被人工设置，本次生成结果未覆盖人工头像。",
              code: "MANUAL_AVATAR_PRESERVED",
            }, { status: 409 });
          }
          if (commit !== "updated") throw new Error(commit === "missing" ? "智能体不存在" : "数据库更新失败");
          invalidateBotsCache();
        }

        await recordGenerationResult(request, actor.userId, claim, "success", {
          generatedCount: 1,
          savedCount: scope.singleAgentId ? 1 : 0,
        });
        return NextResponse.json({
          success: true,
          message: "头像生成成功",
          idempotencyKey: scope.idempotencyKey,
          results: [{
            id: scope.singleAgentId || "new",
            name: scope.singleAgent.name,
            avatarUrl,
            success: true,
            saved: Boolean(scope.singleAgentId),
          }],
        }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        await recordGenerationResult(request, actor.userId, claim, "failure", {
          generatedCount: 0,
          savedCount: 0,
          code: "AVATAR_GENERATION_FAILED",
        });
        return NextResponse.json({
          success: false,
          error: message,
          code: "AVATAR_GENERATION_FAILED",
          results: [{
            id: scope.singleAgentId || "new",
            name: scope.singleAgent.name,
            avatarUrl: "",
            success: false,
            error: message,
          }],
        }, { status: 502, headers: { "Cache-Control": "no-store" } });
      }
    }

    const { data, error: dbError } = await getSupabaseClient()
      .from("agents")
      .select("id,name,description,avatar")
      .eq("is_active", true)
      .in("id", scope.agentIds);
    if (dbError) {
      return NextResponse.json(
        { success: false, error: "查询智能体失败", code: "AGENT_AVATAR_SCOPE_READ_FAILED" },
        { status: 500 },
      );
    }
    const rows = (data || []) as AgentRow[];
    const byId = new Map(rows.map((agent) => [agent.id, agent]));
    const missingIds = scope.agentIds.filter((id) => !byId.has(id));
    if (missingIds.length > 0) {
      return NextResponse.json({
        success: false,
        error: "部分智能体不存在或未启用，本次未开始生成",
        code: "AGENT_AVATAR_SCOPE_NOT_FOUND",
        missingIds,
      }, { status: 404 });
    }
    const agents = scope.agentIds.map((id) => byId.get(id) as AgentRow);
    const claim = await claimPaidGeneration(request, actor.userId, scope);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        sendEvent({
          type: "start",
          total: agents.length,
          confirmedAgentCount: scope.confirmedAgentCount,
          idempotencyKey: scope.idempotencyKey,
        });
        let successCount = 0;
        let failCount = 0;
        let skippedCount = 0;

        for (let index = 0; index < agents.length; index += 1) {
          const agent = agents[index];
          if (!shouldGenerateAvatar(agent.avatar)) {
            skippedCount += 1;
            sendEvent({
              type: "progress",
              index,
              total: agents.length,
              agentId: agent.id,
              name: agent.name,
              success: false,
              skipped: true,
              code: "MANUAL_AVATAR_PRESERVED",
              error: "已有人工头像，自动任务已跳过",
            });
            continue;
          }

          try {
            const avatarUrl = await generateAvatarUrlForAgent(
              agent.name,
              agent.description || agent.name,
              `batch-avatar-${agent.id}`,
              prompt,
              { ownerUserId: actor.userId, source: "agent-avatar-generated" },
            );
            if (!avatarUrl) throw new Error("头像生成未返回有效图片，请检查后台启用的头像生图模型");

            const commit = await replaceGeneratedAvatarIfUnclaimed(agent.id, avatarUrl);
            if (commit !== "updated") {
              if (commit === "manual-preserved") skippedCount += 1;
              else failCount += 1;
              sendEvent({
                type: "progress",
                index,
                total: agents.length,
                agentId: agent.id,
                name: agent.name,
                success: false,
                skipped: commit === "manual-preserved",
                code: commit === "manual-preserved" ? "MANUAL_AVATAR_PRESERVED" : "AUTO_AVATAR_COMMIT_FAILED",
                error: commit === "manual-preserved" ? "生成期间已设置人工头像，自动任务已跳过" : "数据库更新失败",
              });
            } else {
              invalidateBotsCache();
              successCount += 1;
              sendEvent({
                type: "progress",
                index,
                total: agents.length,
                agentId: agent.id,
                name: agent.name,
                avatarUrl,
                success: true,
                saved: true,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            console.error(`[BatchAvatar] generation failed for ${agent.id}:`, message);
            failCount += 1;
            sendEvent({
              type: "progress",
              index,
              total: agents.length,
              agentId: agent.id,
              name: agent.name,
              success: false,
              code: "AVATAR_GENERATION_FAILED",
              error: message,
            });
          }

          if (index < agents.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }

        const completed = failCount === 0;
        await recordGenerationResult(request, actor.userId, claim, completed ? "success" : "failure", {
          requestedCount: agents.length,
          successCount,
          failCount,
          skippedCount,
        });
        sendEvent({
          type: "done",
          total: agents.length,
          successCount,
          failCount,
          skippedCount,
          message: `头像生成完成：${successCount} 成功，${skippedCount} 个人工头像已跳过，${failCount} 失败`,
        });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const failure = policyFailure(error);
    if (failure) return failure;
    const message = error instanceof Error ? error.message : "未知错误";
    console.error("[BatchAvatar] request failed:", message);
    return NextResponse.json(
      { success: false, error: "批量头像生成失败", code: "AVATAR_GENERATION_REQUEST_FAILED" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
