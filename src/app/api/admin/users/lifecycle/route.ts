import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type LifecycleEvent = {
  id: string;
  kind: "registered" | "invited_registration" | "offline_payment" | "activation" | "card_assigned" | "card_redeemed" | "reward";
  title: string;
  detail: string;
  occurredAt: string;
  status: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  // 运营档案同时包含会员身份、线下收款、激活费用、奖励与资产事件。
  // 中央代理先校验 members.view；这里再要求 billing.view，避免只有会员
  // 查看权限的岗位读取资金与交易明细。
  const memberAccess = await authorizeAdminCapability(request, "members.view", {
    operation: "member_lifecycle_identity_read",
  });
  if (!memberAccess.ok) return memberAccess.response;
  const billingAccess = await authorizeAdminCapability(request, "billing.view", {
    operation: "member_lifecycle_billing_read",
  });
  if (!billingAccess.ok) return billingAccess.response;

  const userId = new URL(request.url).searchParams.get("userId")?.trim() || "";
  if (!UUID_PATTERN.test(userId)) return NextResponse.json({ error: "学员ID无效" }, { status: 400 });

  try {
    const db = getSupabaseAdminClient();
    const [userResult, activationResult, cardResult, invitationResult, rewardResult, offlinePaymentResult] = await Promise.all([
      db.from("users").select("id,created_at,last_sign_in_at,member_status").eq("id", userId).maybeSingle(),
      db.from("member_activation_events").select("id,member_status,activation_method,activation_reference,activation_fee,activation_note,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      db.from("cami_codes").select("id,code,plan_name,assigned_to,assigned_at,used_by,used_at").or(`assigned_to.eq.${userId},used_by.eq.${userId}`).order("created_at", { ascending: false }).limit(50),
      db.from("invitation_records").select("id,inviter_id,invitee_id,invited_at,invitee_activated,activated_at,activation_method,activation_fee").or(`inviter_id.eq.${userId},invitee_id.eq.${userId}`).order("invited_at", { ascending: false }).limit(100),
      db.from("invitation_reward_grants").select("id,reward_stage,status,credits,cash_amount,note,eligibility_at,drafted_at,sent_at,created_at").eq("recipient_user_id", userId).order("created_at", { ascending: false }).limit(100),
      db.from("offline_payment_receipts").select("id,payment_channel,business_type,amount,currency,paid_at,merchant_reference,note,status,created_at,voided_at,void_reason").eq("user_id", userId).order("paid_at", { ascending: false }).limit(100),
    ]);
    const firstError = [userResult, activationResult, cardResult, invitationResult, rewardResult, offlinePaymentResult].find((result) => result.error)?.error;
    if (firstError) throw firstError;
    if (!userResult.data) return NextResponse.json({ error: "学员不存在" }, { status: 404 });

    const events: LifecycleEvent[] = [];
    if (userResult.data.created_at) events.push({
      id: `registered:${userId}`,
      kind: "registered",
      title: "账号注册",
      detail: "学员账号已创建",
      occurredAt: userResult.data.created_at,
      status: "completed",
    });
    for (const record of invitationResult.data || []) {
      if (String(record.invitee_id) !== userId) continue;
      events.push({
        id: `invitation:${record.id}`,
        kind: "invited_registration",
        title: "邀请码归因完成",
        detail: `邀请人 ${record.inviter_id}${record.invitee_activated ? " · 已完成正式会员激活" : " · 注册未激活"}`,
        occurredAt: record.invited_at,
        status: record.invitee_activated ? "activated" : "registered",
      });
    }
    for (const receipt of offlinePaymentResult.data || []) {
      const channel = receipt.payment_channel === "wechat" ? "微信转账" : receipt.payment_channel === "alipay" ? "支付宝转账" : receipt.payment_channel === "bank_transfer" ? "银行转账" : receipt.payment_channel === "cash" ? "现金" : "其他渠道";
      events.push({
        id: `offline-payment:${receipt.id}`,
        kind: "offline_payment",
        title: receipt.status === "voided" ? "线下收款凭证已作废" : "线下会员学费已核验",
        detail: `${channel} · ¥${Number(receipt.amount || 0).toFixed(2)}${receipt.merchant_reference ? ` · 流水号 ${receipt.merchant_reference}` : ""}${receipt.note ? ` · ${receipt.note}` : ""}${receipt.void_reason ? ` · 作废原因：${receipt.void_reason}` : ""}`,
        occurredAt: receipt.status === "voided" && receipt.voided_at ? receipt.voided_at : receipt.paid_at || receipt.created_at,
        status: receipt.status,
      });
    }
    for (const event of activationResult.data || []) events.push({
      id: `activation:${event.id}`,
      kind: "activation",
      title: event.member_status === "active" ? "正式会员激活" : `会员状态变更为 ${event.member_status}`,
      detail: `${event.activation_method === "admin_manual" ? "管理员人工确认" : event.activation_method === "cami" ? "会员卡密激活" : event.activation_method || "状态调整"}${event.activation_fee != null ? ` · 实收 ¥${Number(event.activation_fee).toFixed(2)}` : ""}${event.activation_note ? ` · ${event.activation_note}` : ""}`,
      occurredAt: event.created_at,
      status: event.member_status,
    });
    for (const card of cardResult.data || []) {
      if (String(card.assigned_to || "") === userId && card.assigned_at) events.push({
        id: `card-assigned:${card.id}`,
        kind: "card_assigned",
        title: "会员卡已推送",
        detail: card.plan_name || card.code || "会员卡",
        occurredAt: card.assigned_at,
        status: card.used_at ? "redeemed" : "waiting",
      });
      if (String(card.used_by || "") === userId && card.used_at) events.push({
        id: `card-redeemed:${card.id}`,
        kind: "card_redeemed",
        title: "会员卡已兑换",
        detail: card.plan_name || card.code || "会员卡",
        occurredAt: card.used_at,
        status: "completed",
      });
    }
    for (const reward of rewardResult.data || []) {
      const occurredAt = reward.sent_at || reward.drafted_at || reward.eligibility_at || reward.created_at;
      if (!occurredAt) continue;
      const amount = [Number(reward.credits || 0) > 0 ? `${Number(reward.credits).toLocaleString()} 积分` : "", Number(reward.cash_amount || 0) > 0 ? `¥${Number(reward.cash_amount).toFixed(2)} 现金` : ""].filter(Boolean).join("、");
      events.push({
        id: `reward:${reward.id}`,
        kind: "reward",
        title: `${reward.reward_stage === "activation" ? "正式会员邀请奖励" : reward.reward_stage === "invitee_welcome" ? "新人会员套餐" : "邀请注册奖励"}${reward.status === "sent" ? "已到账" : reward.status === "skipped" ? "已决定不发" : reward.status === "draft" ? "待确认推送" : "待决定"}`,
        detail: `${amount || "尚未设置额度"}${reward.note ? ` · ${reward.note}` : ""}`,
        occurredAt,
        status: reward.status,
      });
    }
    events.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));

    return NextResponse.json({
      events,
      summary: {
        memberStatus: userResult.data.member_status || "inactive",
        invitationCount: (invitationResult.data || []).filter((record: any) => String(record.inviter_id) === userId).length,
        receivedRewardCount: (rewardResult.data || []).filter((reward: any) => reward.status === "sent").length,
        cardCount: (cardResult.data || []).length,
        offlinePaymentCount: (offlinePaymentResult.data || []).filter((receipt: any) => receipt.status === "confirmed").length,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "会员生命周期读取失败" }, { status: 500 });
  }
}
