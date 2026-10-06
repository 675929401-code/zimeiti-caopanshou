import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { OfficialInspirationGallery } from "@/features/official-inspiration/official-inspiration-gallery";

export const metadata: Metadata = {
  title: "灵感广场",
  description: "浏览本站精选公共素材，学习提示词技巧，激发创作灵感。",
};

export default function InspirationPage() {
  return (
    <AppRouteShell>
      <OfficialInspirationGallery />
    </AppRouteShell>
  );
}
