import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { ReferralRouteGate } from "@/features/public-auth/public-auth-page";

export const metadata: Metadata = {
  title: "推荐计划",
  description: "使用自媒体操盘手现有邀请码、邀请记录与福利能力。",
};

export default function ReferralPage() {
  return <AppRouteShell><ReferralRouteGate /></AppRouteShell>;
}
