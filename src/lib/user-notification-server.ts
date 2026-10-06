import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export type UserNotificationDelivery =
  | { ok: true; notificationId: string; alreadyExisted: boolean; createdAt: string | null }
  | { ok: false; code: string };

export async function enqueueUserNotificationOnce(input: {
  userId: string;
  type: string;
  title: string;
  content: string;
  dedupeKey: string;
  camiCode?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<UserNotificationDelivery> {
  try {
    const database = getSupabaseAdminClient();
    const { data, error } = await database.rpc("enqueue_user_notification_once", {
      p_user_id: input.userId,
      p_type: input.type,
      p_title: input.title,
      p_content: input.content,
      p_cami_code: input.camiCode || null,
      p_metadata: {
        ...(input.metadata || {}),
        dedupe_key: input.dedupeKey,
      },
    });
    if (error) {
      const missing = ["PGRST202", "42883"].includes(String(error.code || ""));
      return { ok: false, code: missing ? "USER_NOTIFICATION_MIGRATION_NOT_READY" : "USER_NOTIFICATION_ENQUEUE_FAILED" };
    }
    const receipt = data as Record<string, unknown> | null;
    if (receipt?.success !== true || typeof receipt.notification_id !== "string") {
      return { ok: false, code: typeof receipt?.code === "string" ? receipt.code : "USER_NOTIFICATION_RECEIPT_INVALID" };
    }
    return {
      ok: true,
      notificationId: receipt.notification_id,
      alreadyExisted: receipt.already_existed === true,
      createdAt: typeof receipt.created_at === "string" ? receipt.created_at : null,
    };
  } catch {
    return { ok: false, code: "USER_NOTIFICATION_ENQUEUE_FAILED" };
  }
}

export function walletNotificationCopy(input: {
  kind: "cash_topup" | "credit_topup" | "credit_set";
  delta: number;
  balanceAfter: number;
  description: string;
}) {
  if (input.kind === "cash_topup") {
    return {
      type: "wallet_cash",
      title: "现金礼包已到账",
      content: `管理员已为你充值 ¥${input.delta.toFixed(2)}，当前现金余额 ¥${input.balanceAfter.toFixed(2)}。${input.description ? `\n说明：${input.description}` : ""}`,
    };
  }
  if (input.kind === "credit_topup") {
    return {
      type: "wallet_credit",
      title: "积分礼包已到账",
      content: `管理员已为你发放 ${input.delta.toLocaleString("zh-CN")} 积分，当前积分余额 ${input.balanceAfter.toLocaleString("zh-CN")}。${input.description ? `\n说明：${input.description}` : ""}`,
    };
  }
  return {
    type: "wallet_adjustment",
    title: "积分余额已调整",
    content: `管理员已将你的积分余额调整为 ${input.balanceAfter.toLocaleString("zh-CN")}（本次变动 ${input.delta >= 0 ? "+" : ""}${input.delta.toLocaleString("zh-CN")}）。${input.description ? `\n说明：${input.description}` : ""}`,
  };
}
