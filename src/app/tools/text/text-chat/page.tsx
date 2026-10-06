import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialAgentRoute } from "@/features/official-core-routes/official-agent-route";

export const metadata: Metadata = {
  title: "全能 AI 创作 Agent",
  description: "连接主站文案、图片、音频与视频能力的创作编排入口。",
};

export default function TextChatPage() {
  return (
    <AppRouteShell>
      <OfficialAgentRoute modelCatalogEndpoint="/api/chat-models" />
    </AppRouteShell>
  );
}
