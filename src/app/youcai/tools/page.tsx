import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialCreationCenter } from "@/features/official-tool-directory/official-creation-center";

export const metadata: Metadata = {
  title: "AI 创作中心",
  description: "直接描述创意，或选择文本、视觉、音频、视频、影视工坊与画布开始创作。",
};

export default function ToolsPage() {
  return (
    <AppRouteShell>
      <OfficialCreationCenter />
    </AppRouteShell>
  );
}
