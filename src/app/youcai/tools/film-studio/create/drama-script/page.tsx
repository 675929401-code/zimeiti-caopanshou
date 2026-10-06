import type { Metadata } from "next";
import { YoucaiDramaScriptWizard } from "@/features/youcai-drama-script/youcai-drama-script-wizard";

export const metadata: Metadata = {
  title: "爽剧剧本创作",
  description: "主题、类型、基调、集数与详细需求的两阶段爽剧创作向导。",
};

export default function FilmStudioDramaScriptPage() {
  return <YoucaiDramaScriptWizard />;
}
