import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiInfoPage } from "@/features/youcai-public-info/youcai-info-page";

export const metadata: Metadata = {
  title: "商务合作",
  description: "探索 AI 模型、品牌内容、团队工作流与创作生态合作。",
};

export default function BusinessPage() {
  return <AppRouteShell><YoucaiInfoPage kind="business" /></AppRouteShell>;
}
