import type { Metadata } from "next";
import StoryboardWorkbenchPage from "@/app/storyboard-workbench/page";
import { AppRouteShell } from "@/components/app-route-shell";

export const metadata: Metadata = {
  title: "分镜工作台",
  description: "组织角色、场景、道具、分镜与视频任务。",
};

export default function YoucaiStoryboardWorkbenchPage() {
  return (
    <AppRouteShell>
      <StoryboardWorkbenchPage />
    </AppRouteShell>
  );
}
