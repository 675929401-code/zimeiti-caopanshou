import type { Metadata } from "next";
import { CoverWorkbench } from "@/components/cover-workbench";
import { AppRouteShell } from "@/components/app-route-shell";

export const metadata: Metadata = {
  title: "封面设计",
  description: "制作和编辑视频封面，并管理常用封面素材。",
};

export default function YoucaiCoverPage() {
  return (
    <AppRouteShell>
      <CoverWorkbench />
    </AppRouteShell>
  );
}
