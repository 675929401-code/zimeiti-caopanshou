import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialCanvasRoute } from "@/features/official-core-routes/official-canvas-route";

export const metadata: Metadata = {
  title: "无限画布",
  description: "可视化编排 AI 工具，节点式搭建自定义创作工作流。",
};

export default function CanvasEntryPage() {
  return (
    <AppRouteShell>
      <OfficialCanvasRoute />
    </AppRouteShell>
  );
}
