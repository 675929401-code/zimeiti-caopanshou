import type { Metadata } from "next";
import { AppRouteShell } from "@/components/app-route-shell";
import { ImagePromptWorkbench } from "@/features/official-model-tools/image-prompt-workbench";

export const metadata: Metadata = {
  title: "图片提示词生成",
  description: "把画面描述整理成可直接用于生图模型的结构化提示词。",
};

export default function ImagePromptPage() {
  return (
    <AppRouteShell>
      <ImagePromptWorkbench />
    </AppRouteShell>
  );
}

