import type { WorkspaceModelSurface } from "@/lib/workspace-model-policy";

export type WorkspaceProjectId =
  | "image"
  | "cover"
  | "storyboard"
  | "video"
  | "film"
  | "publish-center"
  | "digital-human"
  | "voice"
  | "commerce"
  | "manju"
  | "tools"
  | "presets"
  | "cover-templates";

export type WorkspaceEmbeddedTab = "storyboard-presets" | "cover-styles";

export type WorkspaceSpecializedTarget =
  | "digital-human"
  | "voice-studio"
  | "commerce"
  | "manju-workbench"
  | "plugins";

export type WorkspaceProjectGroup = "内容生产" | "专项能力" | "配置与模板";

export interface WorkspaceProjectNavigationEntry {
  id: WorkspaceProjectId;
  label: string;
  description: string;
  group: WorkspaceProjectGroup;
  surfaceIds?: WorkspaceModelSurface[];
  specializedTarget?: WorkspaceSpecializedTarget;
  embeddedTab?: WorkspaceEmbeddedTab;
}

/** Single source for the workspace project tree: sidebar and content page both read this. */
export const WORKSPACE_PROJECT_GROUPS: readonly WorkspaceProjectGroup[] = ["内容生产", "专项能力", "配置与模板"];

export const WORKSPACE_PROJECT_NAVIGATION: readonly WorkspaceProjectNavigationEntry[] = [
  { id: "cover", label: "封面制作", description: "画面与标题", group: "内容生产", surfaceIds: ["cover-studio"] },
  { id: "storyboard", label: "AI 分镜工作台", description: "分镜图与图生视频", group: "内容生产", surfaceIds: ["storyboard-image", "storyboard-video"] },
  { id: "video", label: "AI 视频创作", description: "主站视频制作", group: "内容生产", surfaceIds: ["video-page"] },
  { id: "film", label: "影视工坊", description: "关键帧与镜头视频", group: "内容生产", surfaceIds: ["film-studio-image", "film-studio-video"] },
  { id: "publish-center", label: "发布中心", description: "发布配图与视频", group: "内容生产", surfaceIds: ["publish-center-image", "publish-center-video"] },
  { id: "commerce", label: "带货 Agent", description: "普通视频生成与多参考复刻", group: "专项能力", surfaceIds: ["commerce-generation-video", "commerce-video"] },
  { id: "voice", label: "智音工坊", description: "音色与 TTS 引擎", group: "专项能力", specializedTarget: "voice-studio" },
  { id: "manju", label: "漫剧工作台", description: "漫剧生产能力", group: "专项能力", specializedTarget: "manju-workbench" },
  { id: "tools", label: "内容工具箱", description: "提取与插件能力", group: "专项能力", specializedTarget: "plugins" },
  { id: "presets", label: "分镜角色预设", description: "角色图审核与发布", group: "配置与模板", embeddedTab: "storyboard-presets" },
  { id: "cover-templates", label: "封面模板管理", description: "拆解规则与封面提示词", group: "配置与模板", embeddedTab: "cover-styles" },
];
