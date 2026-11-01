import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { StoryboardWorkbench } from "@/components/storyboard-workbench";

export const metadata: Metadata = {
  title: "分镜工作台",
  description: "组织角色、场景、道具、分镜与视频任务。",
};

export default function YoucaiStoryboardWorkbenchPage() {
  return (
    <AppRouteShell>
      <StoryboardWorkbench />
    </AppRouteShell>
  );
}
