import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { RechargeCompatPage } from "@/features/official-compat/official-compat-pages";

export const metadata: Metadata = {
  title: "积分充值",
  description: "使用自媒体操盘手现有支付、积分与卡密能力。",
};

export default function RechargePage() {
  return <AppRouteShell><RechargeCompatPage /></AppRouteShell>;
}
