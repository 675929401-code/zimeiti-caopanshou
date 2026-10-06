export type FilmStudioIconKey = "flame" | "clapperboard" | "book-open" | "file-up";

export type FilmStudioAccent = "coral" | "cyan" | "slate" | "amber";

export interface FilmStudioEntryCard {
  readonly key: "爽剧" | "通用短剧" | "正剧" | "上传剧本";
  readonly title: string;
  readonly description: string;
  readonly href: string | null;
  readonly status: "available" | "coming-soon";
  readonly accent: FilmStudioAccent;
  readonly icon: FilmStudioIconKey;
}

export const FILM_STUDIO_ENTRY_CARDS = [
  {
    key: "爽剧",
    title: "爽剧",
    description: "基于专业爽点模型的网络短剧，支持上百集剧本创作，推荐9:16竖屏创作视频",
    href: "/youcai/tools/film-studio/create/drama-script",
    status: "available",
    accent: "coral",
    icon: "flame",
  },
  {
    key: "通用短剧",
    title: "短剧",
    description: "通用剧本，支持原创或小说改编，支持千万字长篇小说改剧本，推荐16:9横屏创作视频",
    href: "/youcai/tools/film-studio/create/general-script",
    status: "available",
    accent: "cyan",
    icon: "clapperboard",
  },
  {
    key: "正剧",
    title: "正剧",
    description: "即将上线 · 单集 10+ 分钟的传统剧本",
    href: null,
    status: "coming-soon",
    accent: "slate",
    icon: "book-open",
  },
  {
    key: "上传剧本",
    title: "上传剧本",
    description: "上传已有剧本，AI改写标准格式，支持TXT、MD、DOCX格式，支持10万字剧本处理",
    href: "/youcai/tools/film-studio/create/upload-script",
    status: "available",
    accent: "amber",
    icon: "file-up",
  },
] as const satisfies readonly FilmStudioEntryCard[];

export const FILM_STUDIO_WORKFLOW = ["剧本", "角色", "场景", "道具", "分镜", "视频"] as const;
