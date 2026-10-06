import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialToolDirectory } from "@/features/official-tool-directory/official-tool-directory";

export const metadata: Metadata = {
  title: "AI 音频工具",
  description: "语音、克隆、音色设计与音乐方案工具目录。",
};

export default function AudioToolsPage() {
  return (
    <AppRouteShell>
      <OfficialToolDirectory category="audio" />
    </AppRouteShell>
  );
}
