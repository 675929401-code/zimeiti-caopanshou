import type { Metadata } from "next";
import ToolboxPage from "@/app/tools/utility/page";
import { AppRouteShell } from "@/components/app-route-shell";

export const metadata: Metadata = {
  title: "实用工具箱",
  description: "在漫剧工作台分支内使用分段、提取与排版工具。",
};

export default function YoucaiUtilityToolsPage() {
  return (
    <AppRouteShell>
      <ToolboxPage />
    </AppRouteShell>
  );
}
