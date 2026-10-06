import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiAccountPage } from "@/features/youcai-account/youcai-account-page";

export const metadata: Metadata = {
  title: "个人中心",
  description: "在漫剧工作台内查看统一账号的会员、积分、余额与个人资产状态。",
};

export default function ManjuProfilePage() {
  return (
    <AppRouteShell>
      <YoucaiAccountPage />
    </AppRouteShell>
  );
}
