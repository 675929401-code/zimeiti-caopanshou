export type ShortDramaProjectKind = "爽剧" | "通用短剧" | "旁白动画" | "宠物故事" | "正剧" | "导入项目";
export type ShortDramaProjectStatus = "draft" | "processing" | "ready" | "failed";

export interface ShortDramaProjectSummary {
  id: string;
  title: string;
  kind: ShortDramaProjectKind;
  status: ShortDramaProjectStatus;
  currentStage: string;
  progress: number;
  episodeCount: number | null;
  aspectRatio: string;
  updatedAt: string | null;
  href: string;
}

export type ShortDramaProjectViewState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; projects: ShortDramaProjectSummary[] };

export type InspirationCategory = "全部" | "无对白叙事" | "风格实验" | "商业短片" | "知识故事";

export interface InspirationExample {
  id: string;
  title: string;
  category: Exclude<InspirationCategory, "全部">;
  summary: string;
  method: string;
  style: string;
  ratio: "9:16" | "16:9" | "1:1";
  imagePath: string;
  imageAlt: string;
  primaryHref: string;
}
