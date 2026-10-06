import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialToolDirectory } from "@/features/official-tool-directory/official-tool-directory";

export const metadata: Metadata = {
  title: "AI 视频工具",
  description: "文生视频、图生视频、参考视频与视频处理工具目录。",
};

export default function VideoToolsPage() {
  return (
    <AppRouteShell>
      <OfficialToolDirectory category="video" />
    </AppRouteShell>
  );
}


