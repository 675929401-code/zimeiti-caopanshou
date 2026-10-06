import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { ImageWorkbench } from "@/components/image-workbench";

export const metadata: Metadata = {
  title: "图片创作",
  description: "沿用主站真实生图模型、文件持久化、积分和历史记录链路。",
};

export default function ImageChatPage() {
  return (
    <AppRouteShell>
      <ImageWorkbench />
    </AppRouteShell>
  );
}
