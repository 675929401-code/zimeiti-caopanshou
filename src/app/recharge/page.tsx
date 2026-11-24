import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { RechargeCompatPage } from "@/features/official-compat/official-compat-pages";

export const metadata: Metadata = {
  title: "我的余额",
  description: "查看当前积分和现金余额。",
};

export default function RechargePage() {
  return <AppRouteShell><RechargeCompatPage /></AppRouteShell>;
}
