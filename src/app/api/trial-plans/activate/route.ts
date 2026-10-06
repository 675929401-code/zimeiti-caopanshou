import { NextResponse } from "next/server";

// 用户自助激活已经下线。所有试用、正式会员与 VIP 套餐都必须由管理员
// 通过统一的原子套餐链路开通，避免绕过人工审批、权限快照、到账审计和通知。
export async function POST() {
  return NextResponse.json({
    error: "套餐由管理员核对后开通，请等待到账通知",
    code: "TRIAL_SELF_ACTIVATION_RETIRED",
    next: "admin_member_package_assignment",
  }, {
    status: 410,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}
