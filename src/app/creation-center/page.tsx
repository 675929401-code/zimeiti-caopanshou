import type { Metadata } from "next";
import { CreationCenterPage } from "@/components/creation-center/creation-center-page";

export const metadata: Metadata = {
  title: "AI创作中心",
  description: "智能体操盘手的对话、生图、视频、故事板与创作工具聚合入口。",
};

export default function Page() {
  return <CreationCenterPage />;
}
