import { NextRequest, NextResponse } from "next/server";
import { getAdminWalletRequestKey, mutateAdminWallet, parseAdminBalanceValue } from "@/lib/admin-wallet-mutation";
import { withAdminAuth } from "@/lib/api-middleware";
import { getAccountGovernanceInfo } from "@/lib/account-governance";
import { enqueueUserNotificationOnce, walletNotificationCopy } from "@/lib/user-notification-server";
import { getAuditRequestIp } from "@/lib/billing-audit";

/* POST /api/admin/cash - admin cash balance top-up */
export async function POST(req: NextRequest) {
  return withAdminAuth(req, async (admin, client) => {
    try {
      const body = await req.json();
      const { userId, amount, description, idempotencyKey: bodyIdempotencyKey } = body;
      const notifyUser = body.notifyUser === true;
      const numericAmount = parseAdminBalanceValue(amount, 2);
      const requestKey = getAdminWalletRequestKey(req.headers.get("idempotency-key"), bodyIdempotencyKey);
      if (typeof userId !== 'string' || !userId.trim() || numericAmount === null || numericAmount <= 0
        || (description !== undefined && (typeof description !== 'string' || description.length > 1000))) {
        return NextResponse.json({ error: "参数无效" }, { status: 400 });
      }
      if (!requestKey) {
        return NextResponse.json({ error: "缺少有效的 Idempotency-Key" }, { status: 400 });
      }

      const operationKey = `admin-cash:${admin.id}:${requestKey}`;
      const { data: targetUser, error: targetError } = await client
        .from("users")
        .select("username, display_name, phone, email, last_sign_in_at, allowed_categories")
        .eq("id", userId)
        .maybeSingle();
      if (targetError || !targetUser) {
        return NextResponse.json({ error: "用户不存在" }, { status: 404 });
      }
      if (getAccountGovernanceInfo(targetUser).isFixture) {
        return NextResponse.json({ error: "测试/E2E/验收账号禁止现金充值，请使用隔离测试库" }, { status: 400 });
      }

      const result = await mutateAdminWallet({
        userId: userId.trim(), adminId: admin.id, kind: 'cash_topup', amount: numericAmount,
        description: description?.trim() || "管理员充值", operationKey,
        requestIp: getAuditRequestIp(req), requestRoute: "/api/admin/cash",
      });

      if (!result.success) {
        const { status, ...body } = result;
        return NextResponse.json({ ...body, idempotencyKey: requestKey }, { status });
      }

      let notification: Awaited<ReturnType<typeof enqueueUserNotificationOnce>> | null = null;
      if (notifyUser) {
        const copy = walletNotificationCopy({
          kind: "cash_topup",
          delta: result.delta,
          balanceAfter: result.balanceAfter,
          description: description?.trim() || "管理员充值",
        });
        notification = await enqueueUserNotificationOnce({
          userId: userId.trim(),
          type: copy.type,
          title: copy.title,
          content: copy.content,
          dedupeKey: `wallet-notification:${operationKey}`,
          metadata: {
            source: "admin_wallet",
            wallet_kind: "cash_topup",
            operation_id: result.operationId || null,
            balance_after: result.balanceAfter,
            delta: result.delta,
          },
        });
        if (!notification.ok) {
          return NextResponse.json({
            ...result,
            success: false,
            outcome: "committed_notification_pending",
            code: notification.code,
            error: "现金已安全入账，但本次明确要求的通知尚未送达；请使用原操作核对重试，系统不会重复入账",
            canRetryWithSameKey: true,
            idempotencyKey: requestKey,
          }, { status: 503 });
        }
      }

      return NextResponse.json({
        ...result,
        balance: result.balanceAfter,
        idempotencyKey: requestKey,
        notificationDelivery: !notifyUser ? "not_requested" : notification?.alreadyExisted ? "existing" : "created",
        notificationId: notification?.ok ? notification.notificationId : null,
      });
    } catch {
      return NextResponse.json({ error: "充值请求处理失败，请保留原幂等键核对后重试" }, { status: 500 });
    }
  });
}
