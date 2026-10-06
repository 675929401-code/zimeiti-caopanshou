import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiInfoPage } from "@/features/youcai-public-info/youcai-info-page";

export const metadata: Metadata = {
  title: "关于我们",
  description: "了解漫剧工作台的 AI 创作理念、工作流与产品能力。",
};

export default function AboutPage() {
  return <AppRouteShell><YoucaiInfoPage kind="about" /></AppRouteShell>;
}
