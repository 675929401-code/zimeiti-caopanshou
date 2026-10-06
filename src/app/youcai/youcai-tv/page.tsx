import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialTvPage } from "@/features/official-public-pages/official-tv-page";

export const metadata: Metadata = {
  title: "漫剧 TV",
  description: "创作者成品短剧展示与作品发布入口。",
};

export default function YoucaiTvPage() {
  return <AppRouteShell><OfficialTvPage /></AppRouteShell>;
}
