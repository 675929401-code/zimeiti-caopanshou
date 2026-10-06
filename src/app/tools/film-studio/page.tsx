import type { Metadata } from "next";
import { ShortDramaPortal } from "@/features/short-drama/short-drama-portal";

export const metadata: Metadata = {
  title: "影视创作工坊",
  description: "从剧本、角色、场景和道具到分镜与成片的项目工作台。",
};

export default function FilmStudioPage() {
  return <ShortDramaPortal />;
}
