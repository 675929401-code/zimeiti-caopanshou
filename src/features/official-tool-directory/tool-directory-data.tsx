import type { LucideIcon } from "lucide-react";
import {
  AudioWaveform, Bot, Captions, Clapperboard, FileText, Film, ImageIcon, Images,
  Mic2, Music2, Palette, Scissors, Sparkles, Upload, UserRound, Video, Wand2,
} from "lucide-react";

export type ToolCategory = "text" | "image" | "audio" | "video";
export type ToolAvailability = "available" | "coming";
export type ToolTag = "热门" | "推荐" | "新增" | "优惠";
export type OfficialThirdLevelToolPath = `/tools/${ToolCategory}/${string}`;

export interface ToolDirectoryCard {
  title: string;
  description: string;
  Icon: LucideIcon;
  availability: ToolAvailability;
  href?: string;
  tags: readonly ToolTag[];
  accent: string;
  eyebrow: string;
  price: string;
  promotion?: string;
  officialPath?: OfficialThirdLevelToolPath;
}

export interface ToolCategoryConfig {
  label: string;
  description: string;
  Icon: LucideIcon;
  accent: string;
  bannerTitle: string;
  bannerSubtitle: string;
  bannerImage: string;
  tools: readonly ToolDirectoryCard[];
}

export const CATEGORY_TABS: readonly { category: ToolCategory; label: string; href: string; Icon: LucideIcon }[] = [
  { category: "text", label: "文本创作", href: "/tools/text", Icon: FileText },
  { category: "image", label: "视觉创作", href: "/tools/image", Icon: ImageIcon },
  { category: "audio", label: "音频创作", href: "/tools/audio", Icon: Music2 },
  { category: "video", label: "视频创作", href: "/tools/video", Icon: Video },
];

export const OFFICIAL_THIRD_LEVEL_TOOL_PATHS = [
  "/tools/text/drama-script", "/tools/text/general-script", "/tools/text/image-prompt",
  "/tools/text/script-brief", "/tools/text/text-chat", "/tools/text/upload-script",
  "/tools/image/character-sheet", "/tools/image/image-chat", "/tools/image/image-edit",
  "/tools/image/jimeng-face-pretty", "/tools/image/jimeng-tilesr", "/tools/image/kling-image",
  "/tools/image/openrouter-image", "/tools/image/qwen-image", "/tools/image/storyboard",
  "/tools/image/volcengine-image", "/tools/audio/minimax-music", "/tools/audio/volcengine-audio",
  "/tools/audio/minimax-tts", "/tools/audio/mimo-tts", "/tools/audio/mimo-voice-design",
  "/tools/audio/mimo-voice-clone", "/tools/video/video-chat", "/tools/video/seedance-video",
  "/tools/video/minimax-video", "/tools/video/kling-video", "/tools/video/jimeng-dreamactor-m20",
  "/tools/video/jimeng-omnihuman-v15", "/tools/video/happyhorse-t2v",
  "/tools/video/happyhorse-i2v", "/tools/video/happyhorse-r2v", "/tools/video/wanx-t2v",
  "/tools/video/wanx-i2v", "/tools/video/wanx-r2v", "/tools/video/happyhorse-video-edit",
  "/tools/video/pippit-video", "/tools/video/pippit-video-2", "/tools/video/wanx-video-edit",
  "/tools/video/volcengine-video", "/tools/video/pippit-marketing",
  "/tools/video/aliyun-super-resolve", "/tools/video/aliyun-erase-subtitles",
  "/tools/video/aliyun-video-cover", "/tools/video/video-edit",
] as const satisfies readonly OfficialThirdLevelToolPath[];

const visual = {
  blue: "linear-gradient(135deg, #eef4ff 0%, #dbeafe 44%, #c4b5fd 100%)",
  violet: "linear-gradient(135deg, #111827 0%, #312e81 52%, #7c3aed 100%)",
  cyan: "linear-gradient(135deg, #effaff 0%, #bfdbfe 50%, #a5f3fc 100%)",
  night: "linear-gradient(135deg, #07111f 0%, #172554 52%, #0f766e 110%)",
  warm: "linear-gradient(135deg, #fff7ed 0%, #fed7aa 50%, #ddd6fe 100%)",
  pink: "linear-gradient(135deg, #fdf2f8 0%, #fbcfe8 44%, #c4b5fd 100%)",
} as const;

function card(
  title: string,
  description: string,
  Icon: LucideIcon,
  options: Omit<ToolDirectoryCard, "title" | "description" | "Icon">,
): ToolDirectoryCard {
  return { title, description, Icon, ...options };
}

export const TOOL_CATEGORIES: Record<ToolCategory, ToolCategoryConfig> = {
  text: {
    label: "文本创作",
    description: "AI剧本创作、短剧脚本、影视分镜、叙事构思",
    Icon: FileText,
    accent: "#2376f3",
    bannerTitle: "剧本从想法开发，AI让想法呈现",
    bannerSubtitle: "从灵感、设定到完整剧本，一站式完成创作",
    bannerImage: "/short-drama/previews/film-studio-promo-bg-v2.webp",
    tools: [
      card("创作 Agent", "多模态创作 Agent，智能调度专业技能与图片、视频、音频、音乐工具，自然语言描述需求即可生成内容和作品。", Bot, {
        availability: "available", href: "/tools/text/text-chat", officialPath: "/tools/text/text-chat",
        tags: ["新增", "推荐", "热门"], accent: visual.blue, eyebrow: "多模态创作 Agent", price: "免费",
      }),
      card("爆款爽剧剧本创作", "爽剧剧本创作，推荐 9:16 竖屏创作视频，适合快节奏爽剧，支持两性、暴力、优势、复仇四大主题。", Sparkles, {
        availability: "available", href: "/tools/text/drama-script", officialPath: "/tools/text/drama-script",
        tags: ["热门", "推荐"], accent: "linear-gradient(135deg, #070707 0%, #2a1608 48%, #e39b18 120%)", eyebrow: "高密度节奏 · 9:16", price: "免费",
      }),
      card("通用短剧剧本创作", "短剧剧本创作，推荐 16:9 横屏创作视频，适合宏大场面、视觉特效、打斗场景等更具电影感的作品。", Clapperboard, {
        availability: "available", href: "/tools/text/general-script", officialPath: "/tools/text/general-script",
        tags: ["热门", "推荐"], accent: visual.night, eyebrow: "通用创作 · 16:9", price: "免费",
      }),
      card("图片提示词生成", "支持两种模式：输入主题生成 AI 绘画提示词，或上传图片反推提示词，适配常用图片模型。", Wand2, {
        availability: "available", href: "/tools/text/image-prompt", officialPath: "/tools/text/image-prompt",
        tags: [], accent: visual.cyan, eyebrow: "AI 绘画提示词", price: "免费",
      }),
      card("上传剧本改写创作", "上传已有剧本文档，自动改写为规范格式，并可继续进入影视项目完成后续创作，支持 TXT、MD、DOCX。", Upload, {
        availability: "available", href: "/tools/text/upload-script", officialPath: "/tools/text/upload-script",
        tags: [], accent: "linear-gradient(135deg, #05070d 0%, #101f36 56%, #1d4ed8 130%)", eyebrow: "文档解析 · AI 改写", price: "免费",
      }),
      card("剧本需求扩写", "AI 将一句话故事想法扩展为含角色设定、故事框架、方向选择的剧本创作需求，可用于创作专业优质剧本。", FileText, {
        availability: "available", href: "/tools/text/drama-script", officialPath: "/tools/text/script-brief",
        tags: ["新增"], accent: visual.blue, eyebrow: "一句话扩写", price: "免费",
      }),
    ],
  },
  image: {
    label: "视觉创作",
    description: "概念设计、角色原画、场景绘制、视觉分镜",
    Icon: ImageIcon,
    accent: "#df35c7",
    bannerTitle: "描述即生成，想象即呈现",
    bannerSubtitle: "从文字与参考图出发，快速完成视觉表达",
    bannerImage: "/short-drama/previews/inspiration-moon-observatory-v1.webp",
    tools: [
      card("图片生成 - 对话式", "对话式图片生成，可使用多种图片模型，支持快捷指令、多轮迭代编辑和聊天式出图。", Bot, {
        availability: "available", href: "/tools/image/image-chat", officialPath: "/tools/image/image-chat",
        tags: ["热门", "推荐", "优惠"], accent: visual.blue, eyebrow: "对话式图片生成", price: "低至 2 积分/次",
      }),
      card("图片编辑", "支持点选、框选、文字指令和参考图编辑，适合局部修改、构图调整与整体风格重塑。", Palette, {
        availability: "available", href: "/tools/image/image-chat", officialPath: "/tools/image/image-edit",
        tags: ["新增"], accent: visual.cyan, eyebrow: "精准图片编辑", price: "低至 4 积分/次", promotion: "限时8折",
      }),
      card("图片生成 - 可灵", "支持文生图、多图参考与组图分镜，适合快速完成创意画面和系列视觉内容。", ImageIcon, {
        availability: "available", href: "/tools/image/image-chat", officialPath: "/tools/image/kling-image",
        tags: ["热门", "推荐", "优惠"], accent: visual.night, eyebrow: "图片生成 · 可灵", price: "低至 1 积分/次", promotion: "限时3.3折",
      }),
      card("图片生成 - AI创意", "多模型可选，支持高质量文生图、参考图编辑和多图生成，适合自由创意探索。", Sparkles, {
        availability: "available", href: "/tools/image/openrouter-image", officialPath: "/tools/image/openrouter-image",
        tags: ["热门", "推荐"], accent: "linear-gradient(135deg, #263b57 0%, #93a78e 54%, #c79b64 120%)", eyebrow: "多模型创意", price: "低至 3 积分/次", promotion: "限时7.5折",
      }),
      card("图片生成 - 千问", "千问图像生成与编辑，支持文生图、1-3 张参考图精确编辑和最高 6 张批量输出。", Images, {
        availability: "available", href: "/tools/image/image-chat", officialPath: "/tools/image/qwen-image",
        tags: ["新增", "推荐", "优惠"], accent: visual.violet, eyebrow: "图片生成 · 千问", price: "低至 2 积分/次", promotion: "限时6.7折",
      }),
      card("图片生成 - Seedream", "支持文生图、图生图和多种模型尺寸，可生成单图或系列组图。", ImageIcon, {
        availability: "available", href: "/tools/image/image-chat", officialPath: "/tools/image/volcengine-image",
        tags: ["推荐", "优惠"], accent: visual.blue, eyebrow: "Seedream 图像生成", price: "低至 2 积分/次", promotion: "限时6.7折",
      }),
      card("角色设定图生成", "生成角色立绘、肖像特写、表情九宫格、三视图，支持文生图和参考图两种方式。", UserRound, {
        availability: "available", href: "/storyboard-workbench", officialPath: "/tools/image/character-sheet",
        tags: ["新增", "推荐"], accent: visual.blue, eyebrow: "角色设定图", price: "3 积分/次",
      }),
      card("故事板/分镜生成", "根据分镜故事提示词生成分镜故事板格图，支持多格选择、参考图和自动识别分镜数量。", Images, {
        availability: "available", href: "/storyboard-workbench", officialPath: "/tools/image/storyboard",
        tags: ["新增"], accent: visual.cyan, eyebrow: "分镜故事板", price: "3 积分/次",
      }),
      card("即梦AI-智能超清", "将图片提升到 4K/8K，支持细节生成程度调节，全面提升画面质感。", Wand2, {
        availability: "coming", officialPath: "/tools/image/jimeng-tilesr", tags: ["热门", "推荐"],
        accent: visual.cyan, eyebrow: "图片智能超清", price: "5 积分/次", promotion: "限时7.1折",
      }),
      card("即梦AI-智能美颜", "一键智能美颜，支持皮肤优化、肤色美白、瘦脸、五官调整、祛斑祛痘和多人脸处理。", Sparkles, {
        availability: "coming", officialPath: "/tools/image/jimeng-face-pretty", tags: [],
        accent: visual.pink, eyebrow: "照片智能美颜", price: "2 积分/次",
      }),
    ],
  },
  audio: {
    label: "音频创作",
    description: "配音合成、音效设计、背景音乐、角色语音",
    Icon: Music2,
    accent: "#f4511e",
    bannerTitle: "下一代音频生成引擎",
    bannerSubtitle: "一条 Prompt，生成影视级音频作品",
    bannerImage: "/short-drama/previews/hero-pipeline-v1.webp",
    tools: [
      card("音乐创作", "AI 歌曲创作、纯音乐生成与翻唱，支持歌词生成和编辑，辅助完成完整音乐创作。", Music2, {
        availability: "coming", officialPath: "/tools/audio/minimax-music", tags: ["热门", "推荐"],
        accent: visual.blue, eyebrow: "AI 音乐创作", price: "10 积分/次", promotion: "限时6.7折",
      }),
      card("音频生成", "支持文本、参考音频和参考图片创作，多角色对话、音效与配乐一体化输出。", AudioWaveform, {
        availability: "coming", officialPath: "/tools/audio/volcengine-audio", tags: ["新增"],
        accent: visual.night, eyebrow: "多模态音频生成", price: "5 积分/分钟", promotion: "限时5折",
      }),
      card("语音合成", "多种音色可选，支持发音字典、精确控制多音字，输入文字即可生成专业配音。", Mic2, {
        availability: "available", href: "/voice-studio/workspace", officialPath: "/tools/audio/minimax-tts",
        tags: [], accent: visual.blue, eyebrow: "文字转语音", price: "2 积分/次",
      }),
      card("语音合成（预置音色）", "多种预置音色，支持情绪、方言、角色扮演和唱歌等风格控制，可用自然语言表达精细调节。", Mic2, {
        availability: "available", href: "/voice-studio/workspace", officialPath: "/tools/audio/mimo-tts",
        tags: [], accent: visual.blue, eyebrow: "预置音色", price: "免费", promotion: "限时免费",
      }),
    ],
  },
  video: {
    label: "视频创作",
    description: "AI视频生成、动态分镜、影像合成、特效制作",
    Icon: Video,
    accent: "#10ad8a",
    bannerTitle: "SEEDANCE 2.0 创作福利",
    bannerSubtitle: "多种创作模式，满足不同视频生产需求",
    bannerImage: "/short-drama/previews/hero-pipeline-v1.webp",
    tools: [
      card("对话式视频创作", "通过对话统一使用多种视频模型，按模型能力完成文生视频、图生视频与参考生视频。", Bot, { availability: "available", href: "/tools/video/video-chat", officialPath: "/tools/video/video-chat", tags: ["热门", "推荐", "优惠"], accent: visual.blue, eyebrow: "对话式视频创作", price: "按实际工具计费" }),
      card("视频生成 - Seedance", "支持最长 30 秒、多模态参考与联网搜索，适合广告、短片和连续镜头创作。", Video, { availability: "available", href: "/tools/video/seedance-video", officialPath: "/tools/video/seedance-video", tags: ["新增", "热门"], accent: visual.night, eyebrow: "Seedance 视频创作", price: "低至 2 积分/秒" }),
      card("视频生成 - MiniMax H3", "多模态视频模型，支持不同清晰度、首尾帧与全能参考，适合电影级镜头表达。", Film, { availability: "available", href: "/tools/video/minimax-video", officialPath: "/tools/video/minimax-video", tags: ["新增"], accent: visual.violet, eyebrow: "MiniMax H3", price: "低至 5 积分/秒" }),
      card("视频生成 - 可灵", "支持文生视频、首帧与首尾帧生视频、智能分镜，适合多类型短视频制作。", Video, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/kling-video", tags: ["热门", "推荐", "优惠"], accent: visual.night, eyebrow: "视频生成 · 可灵", price: "低至 3 积分/秒" }),
      card("视频生成 - 即梦动作模仿2.0", "输入图片和模板视频，将图片人物按照模板动作与表情驱动，支持多人互动。", UserRound, { availability: "coming", officialPath: "/tools/video/jimeng-dreamactor-m20", tags: ["热门", "推荐"], accent: visual.blue, eyebrow: "动作模仿 2.0", price: "8 积分/秒" }),
      card("视频生成 - OmniHuman1.5", "输入单张图片与音频生成高质量人物、宠物和动漫等任意主体的动作与语音视频。", UserRound, { availability: "coming", officialPath: "/tools/video/jimeng-omnihuman-v15", tags: ["热门", "推荐"], accent: visual.blue, eyebrow: "全能数字人 1.5", price: "9 积分/秒" }),
      card("视频生成 - HappyHorse文生视频", "仅凭文字描述生成连贯动态视频，适合快速完成概念短片和动态演示。", Video, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/happyhorse-t2v", tags: ["推荐", "优惠"], accent: visual.cyan, eyebrow: "HappyHorse 文生视频", price: "低至 3 积分/秒" }),
      card("视频生成 - HappyHorse图生视频", "输入图片引导生成短视频，适合让角色、产品与场景自然运动。", Images, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/happyhorse-i2v", tags: ["推荐", "优惠"], accent: visual.blue, eyebrow: "HappyHorse 图生视频", price: "低至 3 积分/秒" }),
      card("视频生成 - HappyHorse参考生视频", "支持角色引用与多参考图，用参考素材保持人物和场景的一致性。", Images, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/happyhorse-r2v", tags: ["推荐", "优惠"], accent: visual.blue, eyebrow: "HappyHorse 参考生视频", price: "低至 3 积分/秒" }),
      card("视频生成 - 万相文生视频", "基于文本生成高质量视频，支持音频驱动、多镜头叙事和多种宽高比。", Video, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/wanx-t2v", tags: ["优惠"], accent: visual.cyan, eyebrow: "万相文生视频", price: "低至 1 积分/秒" }),
      card("视频生成 - 万相图生视频", "支持首帧、首尾帧、视频续写与音频驱动，多模态输入方式丰富。", Images, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/wanx-i2v", tags: ["优惠"], accent: visual.blue, eyebrow: "万相图生视频", price: "低至 1 积分/秒" }),
      card("视频生成 - 万相参考生视频", "通过参考图片、参考视频和参考音色生成角色与场景一致的视频。", Images, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/wanx-r2v", tags: ["优惠"], accent: visual.blue, eyebrow: "万相参考生视频", price: "低至 1 积分/秒" }),
      card("视频编辑 - HappyHorse", "参考图片与文本指令修改视频风格、主体或局部内容，适合创意再编辑。", Scissors, { availability: "coming", officialPath: "/tools/video/happyhorse-video-edit", tags: ["推荐", "优惠"], accent: visual.cyan, eyebrow: "HappyHorse 视频编辑", price: "60 积分/次" }),
      card("智能生视频 Agent", "输入文字指令，自动规划脚本并生成视频，支持多图、视频、多语言和多风格。", Bot, { availability: "coming", officialPath: "/tools/video/pippit-video", tags: ["新增", "优惠"], accent: visual.blue, eyebrow: "智能生视频 Agent", price: "2 积分/秒" }),
      card("智能生视频 Agent 2.0", "基于新一代视频模型，输入文字指令自动规划脚本并生成最长 60 秒视频。", Bot, { availability: "coming", officialPath: "/tools/video/pippit-video-2", tags: ["新增", "推荐"], accent: visual.night, eyebrow: "智能生视频 Agent 2.0", price: "25 积分/秒" }),
      card("视频编辑 - 万相", "通过文字指令与多参考图片修改视频风格、主体或局部内容。", Scissors, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/wanx-video-edit", tags: ["优惠"], accent: visual.violet, eyebrow: "万相视频编辑", price: "低至 3 积分/秒" }),
      card("视频生成 - Seedance1.5", "支持文生视频、图生视频和首尾帧视频生成，适合通用短片与镜头创作。", Video, { availability: "available", href: "/tools/video/kling-video", officialPath: "/tools/video/volcengine-video", tags: ["推荐", "优惠"], accent: visual.violet, eyebrow: "Seedance 1.5", price: "低至 2 积分/秒" }),
      card("营销成片 Agent", "输入商品图片和名称，自动生成营销短视频，支持添加模特图参考。", Sparkles, { availability: "coming", officialPath: "/tools/video/pippit-marketing", tags: ["新增"], accent: visual.warm, eyebrow: "营销成片 Agent", price: "200 积分/次" }),
      card("视频超分辨率", "AI 视频超分辨率，将视频分辨率放大并增强画面细节。", Wand2, { availability: "coming", officialPath: "/tools/video/aliyun-super-resolve", tags: ["新增", "优惠", "推荐", "热门"], accent: visual.cyan, eyebrow: "视频超分辨率", price: "低至 5 积分/分钟" }),
      card("视频去字幕", "处理视频画面中的固定位置硬字幕，适合素材清理和二次编辑。", Captions, { availability: "available", href: "/tools/video/aliyun-erase-subtitles", officialPath: "/tools/video/aliyun-erase-subtitles", tags: ["新增"], accent: visual.cyan, eyebrow: "视频去字幕", price: "免费" }),
      card("视频封面生成", "从视频素材中生成多张封面候选，适合快速完成视频封面选择。", ImageIcon, { availability: "coming", officialPath: "/tools/video/aliyun-video-cover", tags: ["新增"], accent: visual.blue, eyebrow: "视频封面生成", price: "1 积分/分钟" }),
      card("在线视频编辑器", "视频裁剪拼接、音视频合成、视频转音频，提供常用在线编辑能力。", Scissors, { availability: "available", href: "/tools/video/video-edit", officialPath: "/tools/video/video-edit", tags: [], accent: visual.blue, eyebrow: "在线视频编辑器", price: "免费" }),
    ],
  },
};
