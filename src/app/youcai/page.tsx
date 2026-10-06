import type { Metadata } from "next";
import { OfficialHomePage } from "@/features/official-home/official-home-page";
import { MANJU_WORKBENCH_DEFAULT_TITLE } from "@/lib/manju-workbench-brand";

export const metadata: Metadata = {
  title: MANJU_WORKBENCH_DEFAULT_TITLE,
  description: "文本、图像、音频、视频全流程 AI 创作平台。",
};

export default function YoucaiHomePage() {
  return <OfficialHomePage />;
}
