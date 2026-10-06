import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiRechargePage as RechargePageContent } from "@/features/youcai-billing/youcai-billing-pages";

export const metadata: Metadata = {
  title: "积分充值",
  description: "在漫剧工作台内查看统一账户的积分与余额，并通过统一支付系统完成充值。",
};

export default function YoucaiRechargePage() {
  return (
    <AppRouteShell>
      <RechargePageContent />
    </AppRouteShell>
  );
}
