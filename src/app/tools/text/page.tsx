import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialToolDirectory } from "@/features/official-tool-directory/official-tool-directory";

export const metadata: Metadata = {
  title: "AI 文本工具",
  description: "文案、剧本与提示词创作工具目录。",
};

export default function TextToolsPage() {
  return (
    <AppRouteShell>
      <OfficialToolDirectory category="text" />
    </AppRouteShell>
  );
}
