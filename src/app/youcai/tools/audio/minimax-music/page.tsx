import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { MusicPreparationWorkbench } from "@/features/official-model-tools/music-preparation-workbench";

export const metadata: Metadata = {
  title: "音乐创作",
  description: "生成歌词、编曲方案与音乐制作说明。",
};

export default function MusicPage() {
  return (
    <AppRouteShell>
      <MusicPreparationWorkbench />
    </AppRouteShell>
  );
}

