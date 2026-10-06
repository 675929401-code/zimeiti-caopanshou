import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { ImageWorkbench } from "@/components/image-workbench";

export const metadata: Metadata = {
  title: "图片创作",
  description: "使用图片模型完成文生图、参考图创作和作品管理。",
};

export default function ImageChatPage() {
  return (
    <AppRouteShell>
      <ImageWorkbench />
    </AppRouteShell>
  );
}

