import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiHelpCenter } from "@/features/youcai-help/youcai-help-center";

export const metadata: Metadata = {
  title: "AI 帮助中心",
  description: "探索 AI 创作教程、知识百科和平台资讯。",
};

export default function ArticlesPage() {
  return <AppRouteShell><YoucaiHelpCenter /></AppRouteShell>;
}
