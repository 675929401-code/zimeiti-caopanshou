import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api-middleware";

const STAGES = new Set(["registration", "activation"]);

function requestKey(request: Request, body: Record<string, unknown>) {
  const value = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(value) ? value : null;
}

function rewardFailure(receipt: Record<string, unknown> | null) {
  const code = typeof receipt?.code === "string" ? receipt.code : "INVITATION_REWARD_FAILED";
  const messages: Record<string, string> = {
    INVITATION_REWARD_NOT_ELIGIBLE: "该奖励节点尚未满足条件",
    INVITATION_REWARD_ALREADY_SENT: "该奖励节点已经发放，不能重复修改",
    INVITATION_REWARD_DRAFT_REQUIRED: "请先保存奖励额度，再确认推送",
    INVITATION_REWARD_AMOUNT_REQUIRED: "积分和现金不能同时为 0；如不发放请选择“暂不发”",
    INVITATION_REWARD_NOT_FOUND: "邀请奖励节点不存在",
    INVITATION_REWARD_RECORD_NOT_FOUND: "邀请关系不存在",
  };
  const status = code.includes("NOT_FOUND") ? 404 : code.includes("ALREADY") ? 409 : 400;
  return NextResponse.json({ error: messages[code] || "邀请奖励操作未通过业务校验", code }, { status });
}

// PUT saves a manual draft or explicitly skips one eligible reward stage.
export async function PUT(request: Request) {
  return withAdminAuth(request, async (admin, database) => {
    const adminDatabase = database as any;
    const body = await request.json() as Record<string, unknown>;
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    const stage = typeof body.stage === "string" ? body.stage.trim() : "";
    const decision = body.decision === "skip" ? "skip" : "draft";
    const credits = Number(body.credits ?? 0);
    const cashAmount = Number(body.cashAmount ?? 0);
    const note = typeof body.note === "string" ? body.note : "";
    if (!recordId || !STAGES.has(stage) || !Number.isFinite(credits) || !Number.isFinite(cashAmount)
      || credits < 0 || cashAmount < 0 || note.length > 2000) {
      return NextResponse.json({ error: "邀请奖励参数无效" }, { status: 400 });
    }
    const { data, error } = await adminDatabase.rpc("save_invitation_reward_decision_atomic", {
      p_admin_id: admin.id,
      p_invitation_record_id: recordId,
      p_reward_stage: stage,
      p_credits: credits,
      p_cash_amount: cashAmount,
      p_note: note,
      p_decision: decision,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01"].includes(String(error.code || ""));
      return NextResponse.json({
        error: missing ? "邀请礼包迁移尚未就绪，本次未保存" : "邀请礼包保存失败",
        code: missing ? "INVITATION_REWARD_MIGRATION_NOT_READY" : "INVITATION_REWARD_SAVE_FAILED",
      }, { status: 503 });
    }
    const receipt = data as Record<string, unknown> | null;
    if (receipt?.success !== true) return rewardFailure(receipt);
    return NextResponse.json({ success: true, reward: receipt });
  });
}

// POST credits the inviter and pushes one receipt. The invitee welcome node is
// intentionally excluded here: it is fulfilled only by the atomic package API
// so membership, permissions, wallet and notification cannot drift apart.
export async function POST(request: Request) {
  return withAdminAuth(request, async (admin, database) => {
    const adminDatabase = database as any;
    const body = await request.json() as Record<string, unknown>;
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    const stage = typeof body.stage === "string" ? body.stage.trim() : "";
    const key = requestKey(request, body);
    if (!recordId || !STAGES.has(stage) || !key) {
      return NextResponse.json({ error: "缺少有效的邀请奖励操作编号" }, { status: 400 });
    }
    const { data, error } = await adminDatabase.rpc("send_invitation_reward_atomic", {
      p_admin_id: admin.id,
      p_invitation_record_id: recordId,
      p_reward_stage: stage,
      p_idempotency_key: key,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01"].includes(String(error.code || ""));
      return NextResponse.json({
        error: missing ? "邀请礼包迁移尚未就绪，本次未发放" : "奖励结果尚未确认，请保留原操作编号核对，禁止换编号重复发送",
        code: missing ? "INVITATION_REWARD_MIGRATION_NOT_READY" : "INVITATION_REWARD_OUTCOME_UNKNOWN",
      }, { status: 503 });
    }
    const receipt = data as Record<string, unknown> | null;
    if (receipt?.success !== true) return rewardFailure(receipt);
    return NextResponse.json({ success: true, idempotencyKey: key, reward: receipt });
  });
}
