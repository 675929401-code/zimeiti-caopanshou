import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiReferralPage } from "@/features/youcai-billing/youcai-billing-pages";

export const metadata: Metadata = {
  title: "推荐计划",
  description: "管理邀请码、邀请记录与推荐福利。",
};

export default function ReferralPage() {
  return (
    <AppRouteShell>
      <YoucaiReferralPage />
    </AppRouteShell>
  );
}
