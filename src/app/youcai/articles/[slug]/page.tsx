import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { YoucaiHelpCenter } from "@/features/youcai-help/youcai-help-center";

export const metadata: Metadata = {
  title: "帮助文章",
  description: "查看 AI 创作功能的使用教程与常见问题。",
};

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <AppRouteShell><YoucaiHelpCenter slug={slug} /></AppRouteShell>;
}
