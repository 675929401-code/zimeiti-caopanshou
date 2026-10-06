import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialAgentRoute } from "@/features/official-core-routes/official-agent-route";

export const metadata: Metadata = {
  title: "全能 AI 创作 Agent",
  description: "调用专业技能、联网搜索和多模态工具，完成文案、图片、音频、音乐或视频创作。",
};

export default function TextChatPage() {
  return (
    <AppRouteShell>
      <OfficialAgentRoute />
    </AppRouteShell>
  );
}
