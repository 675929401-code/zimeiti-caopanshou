import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialToolDirectory } from "@/features/official-tool-directory/official-tool-directory";

export const metadata: Metadata = {
  title: "AI 图片工具",
  description: "生图、编辑、角色与分镜图片工具目录。",
};

export default function ImageToolsPage() {
  return (
    <AppRouteShell>
      <OfficialToolDirectory category="image" />
    </AppRouteShell>
  );
}


