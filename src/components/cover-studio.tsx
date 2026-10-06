"use client";

import {
  Check,
  ChevronDown,
  Download,
  History,
  Home,
  ImagePlus,
  LogIn,
  Palette,
  RefreshCw,
  Sparkles,
  Star,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { UserThemeSwitcher } from "@/components/user-theme-switcher";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoverRatio } from "@/lib/cover-templates";
import { useApp } from "@/contexts/app-context";
import {
  clearCompletedCoverHistory, coverHistoryStableKey, detachCoverGenerationTracking, fetchCoverAccountHistory, mergeCoverAccountHistory, fetchCoverResultBlob, parseCoverGenerationModels, runCoverGeneration,
  type CoverGenerationModel, type CoverGenerationState, type CoverGenerationTask,
} from "@/lib/cover-generation-attempt";
import { buildCoverBackgroundPrompt } from "@/lib/cover-composition";

const TOKEN_KEY = "auth_token";
const draftKey = (userId: string) => `ai-cover-director-draft-v5:${userId}`;
const FAVORITE_TEMPLATES_KEY = "ai-cover-director-favorite-templates-v1";
const COVER_REFERENCE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_COVER_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024;
const COVER_DRAFT_ASSET_DB_NAME = "ai-cover-director-draft-assets-v1";

function createTaskStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}
function coverDownloadExtension(url: string): "png" | "jpg" | "webp" {
  const dataType = /^data:image\/(png|jpe?g|webp)[;,]/iu.exec(url)?.[1]?.toLowerCase();
  if (dataType === "jpeg" || dataType === "jpg") return "jpg";
  if (dataType === "webp") return "webp";
  if (dataType === "png") return "png";
  try {
    const extension = new URL(url, window.location.href).pathname.split(".").pop()?.toLowerCase();
    if (extension === "jpeg" || extension === "jpg") return "jpg";
    if (extension === "webp") return "webp";
    if (extension === "png") return "png";
  } catch {
    // Invalid URLs are handled by the browser when the link is activated.
  }
  return "png";
}

async function readCoverReferenceAsDataUrl(sourceUrl: string, label: string) {
  const response = await fetch(sourceUrl, { cache: "force-cache" });
  if (!response.ok) throw new Error(`${label}读取失败，请重新选择后再试`);
  const blob = await response.blob();
  if (!COVER_REFERENCE_IMAGE_TYPES.has(blob.type)) throw new Error(`${label}格式无效，请重新选择`);
  if (!blob.size || blob.size > MAX_COVER_REFERENCE_IMAGE_BYTES) throw new Error(`${label}大小不符合要求，请重新选择`);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${label}读取失败，请重新选择后再试`));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

type StudioRatio = CoverRatio | "16:9" | "9:16";
type AnimationStyleId = "pet-3d" | "pixar-3d" | "clay-soft" | "storybook" | "anime-soft" | "cinematic-real" | "photo-real";
type CoverModeId = "cartoon" | "funny-cartoon";
type SubjectModeId = "semantic" | "product";
type MaterialSourceId = "text" | "template" | "upload";
type LayoutTemplateId = `gaoding-${string}`;
type CoverPatternId = "question-hook" | "warm-emotion" | "contrast-suspense" | "number-list" | "alert-knowledge";
type HookMode = "反常识" | "数字暗号" | "危险提醒" | "情绪补偿" | "身份代入";

interface AnimationStyle {
  id: AnimationStyleId;
  name: string;
  badge: string;
  visualHint: string;
  renderStyle: string;
  palette: string;
}

interface CoverPattern {
  id: CoverPatternId;
  name: string;
  badge: string;
  hook: HookMode;
  titleHint: string;
  sceneLogic: string;
  composition: string;
}

interface LayoutTemplate {
  id: LayoutTemplateId;
  name: string;
  source: string;
  layoutHint: string;
  previewImage?: string;
  prompt: string;
}

interface CoverResult extends Omit<CoverGenerationTask, "source"> {
  source: "生成" | "上传";
}

const VIRAL_TITLE_RULE = "标题遵循抖音封面爆款逻辑：先抛痛点/反常识/危险提醒，再制造答案缺口；12-18字内优先，分两行，大词要狠，避免平铺直叙。";
const COVER_FLAGSHIP_MODELS = [
  {
    key: "gpt-image-25",
    id: "pm_PZ3hS353YQNbfRnz2_9Ro0aX",
    rawCatalogId: "gpt-image-25-sunburst-chA",
    label: "GPT Image 2.5 Sunburst",
    shortLabel: "GPT Image 2.5",
    role: "综合首选",
    aliases: ["GPT Image 2.5 Sunburst", "GPT-Image-2.5 Sunburst"],
  },
  {
    key: "nano-banana-2",
    id: "pm_sHaGkgaNoH1ZgQzpHW2dEUyF",
    rawCatalogId: "gemini-3-1-flash-image-chA",
    label: "Nano Banana 2",
    shortLabel: "Banana",
    role: "参考图优先",
    aliases: ["Nano Banana 2"],
  },
  {
    key: "seedream-50-pro",
    id: "pm_7y8qxRpEQYgNuYBVvqL4MJgs",
    rawCatalogId: "cover-model-seedream-5-pro",
    label: "豆包 Seedream 5.0 Pro",
    shortLabel: "豆包 5.0",
    role: "中文封面",
    aliases: ["豆包 Seedream 5.0 Pro"],
  },
] as const;

function normalizeCoverModelName(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[·|｜/_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function coverFlagship(model: Pick<CoverGenerationModel, "id" | "name">) {
  const normalizedName = normalizeCoverModelName(model.name);
  return COVER_FLAGSHIP_MODELS.find((item) => item.id === model.id || item.aliases.some((alias) => {
    const normalizedAlias = normalizeCoverModelName(alias);
    return normalizedName === normalizedAlias || normalizedName.startsWith(`${normalizedAlias} `);
  }));
}

function sortCoverGenerationModels(models: CoverGenerationModel[]) {
  return [...models].sort((left, right) => {
    const leftFlagship = coverFlagship(left);
    const rightFlagship = coverFlagship(right);
    const leftIndex = leftFlagship ? COVER_FLAGSHIP_MODELS.findIndex((item) => item.key === leftFlagship.key) : -1;
    const rightIndex = rightFlagship ? COVER_FLAGSHIP_MODELS.findIndex((item) => item.key === rightFlagship.key) : -1;
    const leftPriority = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
    const rightPriority = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
    return leftPriority - rightPriority || left.name.localeCompare(right.name, "zh-CN");
  });
}

function defaultCoverModelId(models: CoverGenerationModel[]) {
  const gpt = models.find((model) => coverFlagship(model)?.key === COVER_FLAGSHIP_MODELS[0].key);
  if (gpt?.available) return gpt.id;
  return COVER_FLAGSHIP_MODELS
    .map((flagship) => models.find((model) => coverFlagship(model)?.key === flagship.key && model.available))
    .find(Boolean)?.id
    || models.find((model) => model.available)?.id
    || gpt?.id
    || models[0]?.id
    || "";
}
const TASK_LABELS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function getTaskLabel(taskNo: number) {
  return TASK_LABELS[taskNo - 1] ?? String(taskNo);
}

function beijingHistoryDayLabel(createdAt: string, now = new Date()) {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return "进行中";
  const dayNumber = (timestamp: number) => Math.floor((timestamp + 8 * 60 * 60 * 1000) / 86_400_000);
  const daysAgo = dayNumber(now.getTime()) - dayNumber(parsed);
  if (daysAgo === 0) return "今天";
  if (daysAgo === 1) return "昨天";
  if (daysAgo === 2) return "前天";
  return null;
}

const RATIO_OPTIONS = ["16:9", "9:16", "4:3", "3:4"] as const;
const SIZE_PRESETS: Record<StudioRatio, { width: number; height: number; label: string }> = {
  "16:9": { width: 1920, height: 1080, label: "横屏视频" },
  "9:16": { width: 1080, height: 1920, label: "竖屏视频" },
  "4:3": { width: 1440, height: 1080, label: "横版封面" },
  "3:4": { width: 1080, height: 1440, label: "抖音封面" },
};

const COVER_ANIMATION_STYLES: AnimationStyle[] = [
  {
    id: "pet-3d",
    name: "3D动画萌宠",
    badge: "默认对标",
    visualHint: "商业级3D宠物角色，表情夸张，毛发柔软",
    renderStyle: "高质量 3D 动画萌宠角色，商业级卡通质感，眼睛有情绪，动作夸张但可信，适合抖音宠物爆款封面",
    palette: "奶油金、番茄红、亮黄色、深棕描边",
  },
  {
    id: "pixar-3d",
    name: "皮克斯质感",
    badge: "电影感",
    visualHint: "圆润角色，戏剧表情，电影级暖光",
    renderStyle: "皮克斯感 3D 动画电影角色，圆润可爱，表情戏强，柔和体积光和电影级景深",
    palette: "暖金、珊瑚红、天空蓝、奶白高光",
  },
  {
    id: "clay-soft",
    name: "黏土动画",
    badge: "手作感",
    visualHint: "黏土材质，软萌触感，定格动画氛围",
    renderStyle: "可爱黏土定格动画风格，手作材质，柔软圆润，表面有细腻黏土纹理",
    palette: "暖黄、番茄红、浅绿、奶白",
  },
  {
    id: "storybook",
    name: "手绘绘本",
    badge: "温暖",
    visualHint: "绘本笔触，温柔色块，亲密陪伴感",
    renderStyle: "高完成度手绘绘本插画，柔和笔触，温暖亲密，角色表情清楚，适合情绪类宠物封面",
    palette: "蜂蜜黄、柔红、草绿、暖白",
  },
  {
    id: "anime-soft",
    name: "日系治愈",
    badge: "清新",
    visualHint: "日系动画光感，干净画面，情绪细腻",
    renderStyle: "日系治愈动画风格，干净线条，柔和高光，细腻表情，温暖生活场景",
    palette: "浅蓝、樱粉、暖黄、白色描边",
  },
  {
    id: "cinematic-real",
    name: "写实电影",
    badge: "真实感",
    visualHint: "真实宠物摄影质感，电影布光，情绪抓拍",
    renderStyle: "写实电影级宠物摄影质感，真实毛发，清晰眼神，戏剧化布光，社交媒体封面冲击力",
    palette: "琥珀光、深棕、亮黄标题、红色警示点缀",
  },
  {
    id: "photo-real",
    name: "真实摄影",
    badge: "真实风格",
    visualHint: "真实人物/产品/场景抓拍，强标题排版，短视频封面感",
    renderStyle: "真实摄影风格，主体人物、产品、宠物或现场场景都自然可信，皮肤、材质、光线和空间关系真实，但标题和贴纸仍保持抖音封面冲击力",
    palette: "自然暖光、真实肤色、亮黄标题、红色重点贴纸",
  },
];

const COVER_PATTERNS: CoverPattern[] = [
  {
    id: "question-hook",
    name: "悬念疑问",
    badge: "默认对标",
    hook: "反常识",
    titleHint: "大字疑问 + 反常行为 + 停留追问",
    sceneLogic: "先把反常动作放大，再用主人反应和问号贴纸制造答案缺口",
    composition: "标题占上方 32%，主体靠中下，留出粗描边文字安全区",
  },
  {
    id: "warm-emotion",
    name: "治愈陪伴",
    badge: "情绪向",
    hook: "情绪补偿",
    titleHint: "一句共情 + 温暖陪伴 + 泪点画面",
    sceneLogic: "把宠物依赖、主人陪伴和暖光情绪放在同一个动作里",
    composition: "标题居上或左上，画面中心放情绪动作，背景暗处保持干净",
  },
  {
    id: "contrast-suspense",
    name: "悬念反差",
    badge: "强钩子",
    hook: "身份代入",
    titleHint: "为什么 + 养过才懂 + 反问",
    sceneLogic: "用暗光、被发现的瞬间和异常动作制造强停留",
    composition: "标题大面积压顶，主体在右下或中心，局部高光强化悬念",
  },
  {
    id: "number-list",
    name: "清单拆解",
    badge: "系列感",
    hook: "数字暗号",
    titleHint: "3 个/7 种 + 小圆图标 + 标号",
    sceneLogic: "主画面负责吸引，小圆图标负责告诉用户这里有多个答案",
    composition: "主标题在顶部，小图环绕主体，数字贴纸要醒目",
  },
  {
    id: "alert-knowledge",
    name: "知识警示",
    badge: "提醒型",
    hook: "危险提醒",
    titleHint: "可要注意了 + 警告符号 + 解决线索",
    sceneLogic: "突出可能被误解的动作，用警示符号和放大镜给出解决线索",
    composition: "标题左上大字，危险动作放在前景，右侧留人物反应",
  },
];

const REMOVED_GAODING_TEMPLATE_NUMBERS = new Set([24, 34, 36, 61, 68, 73, 79, 81]);
const GAODING_TEMPLATE_NUMBERS = Array.from({ length: 119 }, (_, index) => index + 1).filter(
  (item) => !REMOVED_GAODING_TEMPLATE_NUMBERS.has(item),
);

const GAODING_SCREENSHOT_TEMPLATES: LayoutTemplate[] = GAODING_TEMPLATE_NUMBERS.map((templateNumber) => {
  const number = String(templateNumber).padStart(3, "0");
  return {
    id: `gaoding-${number}`,
    name: `版式 ${String(templateNumber).padStart(2, "0")}`,
    source: "稿定设计公开模板详情页参考截图",
    layoutHint: "按图学习标题层级、主体位置、色块和贴纸关系",
    previewImage: `/cover-references/gaoding-templates/gaoding-${number}.jpg?v=trim-20260812`,
    prompt: "把所选参考图作为固定模板：必须保持参考图的版式风格、主配色、字体粗细与描边逻辑、标题区域比例、主体位置、色块、信息条、贴纸密度和留白关系；只允许替换中文标题、主体封面素材和与新文案直接相关的辅助信息。不得复制原图人物、商品、原文案、品牌、Logo或水印。",
  };
});
const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: "gaoding-teacher-interview",
    name: "教资大字人像",
    source: "用户提供单张封面截图 / 稿定设计式排版",
    layoutHint: "超大标题 + 右侧人像 + 白描边贴纸 + 场景背景",
    previewImage: "/cover-references/teacher-interview-template.png",
    prompt: "参考用户提供的单张教资面试封面截图，只学习版式结构不复刻原图：竖版短视频封面，课堂或黑板背景轻微虚化；右侧放半身真人/主体人物，人物有明显白色粗描边和蓝色投影边，表情自然并有手势动作；左上到中部放三到四行超大中文标题，白字黑色厚阴影，关键字使用蓝底黄字或蓝字白描边突出；左下加入对白气泡/贴纸信息块，配眼睛、箭头、强调符号等小装饰；整体高对比、大字压迫感强、信息一眼读懂，适合教育、职场、考试、干货类爆款封面。",
  },
  ...GAODING_SCREENSHOT_TEMPLATES,
  {
    id: "gaoding-yellow-black",
    name: "黄黑大字冲击",
    source: "搞定设计参考 / 教育职场",
    layoutHint: "黄底黑字 + 强标题 + 人物/主体右侧",
    prompt: "参考搞定设计常见黄黑大字封面结构，只学习版式不复刻原图：画面以高饱和黄色或橙黄色作为主背景，顶部或左上放超粗黑色/白色中文大标题，标题带红色或黑色描边；主体人物或核心物体放在右侧或中下区域；加入少量红色重点贴纸、箭头、感叹号和信息条，整体像知识干货/职场教育爆款封面，强对比、强停留。",
  },
  {
    id: "gaoding-person-career",
    name: "人像职场封面",
    source: "搞定设计参考 / 职场账号",
    layoutHint: "半身人像 + 竖向标题 + 标签条",
    prompt: "参考搞定设计职场类人像封面结构，只学习版式不复刻原图：画面中心或右侧放单人半身人像，人物表情自信或惊讶；左侧或顶部放两到三行大标题；标题旁加入岗位、Offer、经验、方法等短标签信息条；背景为浅色办公室、校园或纯色块，局部有蓝色/黄色高亮框，适合职场、求职、留学、教育类内容。",
  },
  {
    id: "gaoding-blue-edu",
    name: "蓝白教育信息卡",
    source: "搞定设计参考 / 教育培训",
    layoutHint: "蓝白分区 + 大问题 + 信息列表",
    prompt: "参考搞定设计蓝白教育封面结构，只学习版式不复刻原图：画面以蓝白分区为主，顶部放清晰大问题标题，中部或底部放 2-4 条信息列表卡片；使用圆角蓝色标签、白色信息块、学校/书本/地图/证书等辅助元素；人物可有可无，整体干净、可信、信息层级强，适合教育、留学、考试、知识科普封面。",
  },
  {
    id: "gaoding-note-list",
    name: "便签清单拆解",
    source: "搞定设计参考 / 干货清单",
    layoutHint: "白底便签 + 手绘贴纸 + 清单编号",
    prompt: "参考搞定设计便签清单类封面结构，只学习版式不复刻原图：画面以白底或浅米色为主，中间放便签纸、手账卡片或列表面板；标题使用红色/黑色大字，旁边加入手绘箭头、下划线、圆圈、猫狗小贴纸或表情符号；用 1、2、3 或打勾符号表达步骤和清单，整体轻松、可读、适合方法论和避坑类封面。",
  },
  {
    id: "gaoding-dark-impact",
    name: "深色反差冲击",
    source: "搞定设计参考 / 强情绪话题",
    layoutHint: "深色背景 + 聚光主体 + 反差标题",
    prompt: "参考搞定设计深色冲击类封面结构，只学习版式不复刻原图：画面使用深色背景、黑色或深蓝底，主体人物/物体用聚光或边缘光突出；标题使用白色、黄色或红色超粗字体，形成强反差；加入少量红色警示、问号、爆点标签和斜切色块，适合争议、反差、警示、焦虑话题封面。",
  },
  {
    id: "gaoding-white-info",
    name: "白底信息海报",
    source: "搞定设计参考 / 信息说明",
    layoutHint: "白底留白 + 大标题 + 多信息块",
    prompt: "参考搞定设计白底信息类封面结构，只学习版式不复刻原图：画面保持大面积白底和整洁留白，顶部放醒目黑色或蓝色标题；中下方排列多个信息块、图标、流程箭头或对比栏目；可加入一个小人物或产品主体，但不要拥挤；整体专业、理性、清晰，适合政策、说明、流程、知识总结类封面。",
  },
];
const REAL_LAYOUT_TEMPLATES = LAYOUT_TEMPLATES.filter((item) => item.previewImage);

function clearLegacyCoverEditorDraft(ownerId: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(draftKey(ownerId));
    localStorage.removeItem(draftKey("anonymous"));
  } catch {
    // A blocked browser store must not prevent a clean editor session.
  }
  try {
    window.indexedDB?.deleteDatabase(COVER_DRAFT_ASSET_DB_NAME);
  } catch {
    // The legacy reference cache can be cleared by a later session if IndexedDB is unavailable.
  }
}

function getAutoPattern(text: string) {
  const clean = compactText(text);
  const number = detectNumber(clean);
  if (/[0-9一二三四五六七八九十]+(?=个|种|条|件|类|步|点)/.test(clean) || /表现|步骤|清单|方法|技巧|原因/.test(clean)) return COVER_PATTERNS.find((item) => item.id === "number-list") ?? COVER_PATTERNS[0];
  if (/注意|危险|不能|不要|误区|风险|警惕|错|洗脚|啃草/.test(clean)) return COVER_PATTERNS.find((item) => item.id === "alert-knowledge") ?? COVER_PATTERNS[0];
  if (/治愈|陪伴|想你|忘了|依赖|幸福|孤独|温暖|只认你/.test(clean)) return COVER_PATTERNS.find((item) => item.id === "warm-emotion") ?? COVER_PATTERNS[0];
  if (/为什么|竟然|突然|反常|奇怪|暗示|暗号/.test(clean)) return COVER_PATTERNS.find((item) => item.id === "question-hook") ?? COVER_PATTERNS[0];
  if (number) return COVER_PATTERNS.find((item) => item.id === "number-list") ?? COVER_PATTERNS[0];
  return COVER_PATTERNS[0];
}
function getSizePreset(value: StudioRatio) {
  return SIZE_PRESETS[value] ?? SIZE_PRESETS["3:4"];
}
function compactText(input: string) {
  return input
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/(?:复制此链接|打开(?:抖音|小红书|快手|微博|B站)?搜索|直接观看视频)[^。！？!?]*/gu, " ")
    .replace(/#[^#\s]{1,28}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectSubject(text: string) {
  if (/狗|小狗|狗狗|金毛|泰迪|柯基|柴犬|犬/.test(text)) return "狗狗";
  if (/猫|小猫|猫咪|狸花|布偶|英短/.test(text)) return "猫咪";
  if (/孩子|宝宝|儿童|学生/.test(text)) return "孩子";
  if (/老人|父母|妈妈|爸爸|伴侣|夫妻|朋友/.test(text)) return "人物关系";
  if (/教资|面试|考试|老师|课堂|培训|留学/.test(text)) return "教资面试";
  if (/账号|运营|流量|短视频|抖音|涨粉|爆款/.test(text)) return "短视频账号";
  if (/副业|赚钱|变现|收入|项目/.test(text)) return "副业项目";
  if (/职场|求职|简历|offer|老板|同事|公司/.test(text)) return "职场人";
  if (/营销|卖点|种草|成交|转化|客户|用户|产品|工具|软件|课程|品牌/.test(text)) return "营销人物";
  if (/情绪|焦虑|内耗|关系|成长|人生|选择|治愈/.test(text)) return "情绪人物";
  return "核心主体";
}
function makeSubjectDirective(text: string, subjectMode: SubjectModeId = "semantic") {
  if (subjectMode === "product" || /产品图封面|产品封面|商品封面|商品主图|产品主视觉|商品图|产品图/.test(text)) return "主体语义：这是产品图封面任务。上传了产品参考图时，以参考图里的产品外观作为主视觉；没有产品参考图时，只设计通用产品使用场景、包装轮廓或卖点氛围，不虚构具体品牌和精确外观。";
  if (/狗|小狗|狗狗|金毛|泰迪|柯基|柴犬|犬/.test(text)) return "主体语义：这是狗狗/犬类内容，封面主体要设计成狗，围绕品种感、毛发、眼神、动作和生活场景表达标题观点。";
  if (/猫|小猫|猫咪|狸花|布偶|英短/.test(text)) return "主体语义：这是猫咪内容，封面主体要设计成猫，围绕毛色、眼神、姿态、爪子动作和居家场景表达标题观点。";
  if (/孩子|宝宝|儿童|学生/.test(text)) return "主体语义：这是孩子/学生内容，封面主体要设计成符合年龄段和情绪状态的人物，并用表情、动作、学习或生活场景表达标题观点。";
  if (/老人|父母|妈妈|爸爸|伴侣|夫妻|朋友|情绪|焦虑|内耗|关系|成长|人生|选择|治愈/.test(text)) return "主体语义：这是人物情感或关系内容，封面主体要设计成符合观点的人物形象，明确年龄段、气质、穿着、表情、动作和生活场景。";
  if (/职场|求职|简历|offer|老板|同事|公司/.test(text)) return "主体语义：这是职场内容，封面主体要设计成职场人物或办公场景，用穿着、表情、文件、手机、会议元素表达机会、压力或反差。";
  if (/营销|卖点|种草|成交|转化|客户|用户|产品|工具|软件|课程|品牌|私域|直播|带货/.test(text)) return "主体语义：这是营销文案，默认设计使用者、客户、创作者或消费场景人物，用人物情绪、使用动作、结果对比和场景道具表达卖点；产品不作为主视觉，除非用户选择产品图封面或上传明确产品图。";
  if (/账号|运营|流量|短视频|抖音|涨粉|爆款|拍摄|剪辑|选题|封面/.test(text)) return "主体语义：这是短视频运营内容，封面主体要设计成创作者、手机数据界面、内容看板或账号增长场景，突出点击、停留、涨粉或转化。";
  return "主体语义：先判断文案核心是在讲人、动物、产品、场景还是事件，再设计最能表达观点的新主体；主体随文案变化，不固定套某一种人物或宠物。";
}
function detectNumber(text: string) {
  const match = text.match(/[0-9一二三四五六七八九十]+(?=个|种|条|件|类|步|点)/);
  return match?.[0] ?? "";
}


function extractCoreSummary(text: string) {
  const clean = compactText(text);
  if (!clean) return "等待输入文案后提取核心表达";
  const subject = detectSubject(clean);
  if (/啃草/.test(clean)) return `${subject}啃草并不只是嘴馋，背后可能是身体、情绪或安全感信号。`;
  if (/爪|搭/.test(clean)) return `${subject}把爪搭上来，不只是撒娇，而是在确认关系、邀请互动或索取陪伴。`;
  if (/洗脚/.test(clean)) return `日常照顾${subject}时，一个看似普通的动作可能藏着被忽略的风险和误区。`;
  if (/做梦|礼物/.test(clean)) return `${subject}真正想要的不是普通物品，而是能满足安全感和陪伴感的礼物。`;
  if (/幸福|表现/.test(clean)) return `${subject}是否幸福，可以从几个具体动作和反应里直接看出来。`;
  return clean.length > 72 ? `${clean.slice(0, 72)}...` : clean;
}

function makeVisualFocus(text: string, pattern: CoverPattern) {
  const subject = detectSubject(text);
  if (/教资|面试|试讲|板书|考官/.test(text)) return `一位教资面试考生站在教室黑板前试讲，手势自然但略紧张，黑板上有简洁板书，前景用计时器、考官第一印象贴纸、红色错点标记和箭头突出开场、板书、互动节奏。`;
  if (/账号|运营|流量|短视频|抖音|涨粉|爆款/.test(text)) return `一位创作者拿着手机查看短视频数据，屏幕上有播放量曲线、点赞气泡和爆款提示贴纸，画面突出标题所说的关键变化和机会点。`;
  if (/职场|求职|简历|offer|老板|同事|公司/.test(text)) return `一位职场人站在办公室或面试场景中，表情带紧张和顿悟，旁边有简历、Offer、会议便签、红色提醒贴纸和对比箭头。`;
  if (/副业|赚钱|变现|收入|项目/.test(text)) return `一位普通人在桌面前整理副业项目资料，手机账单、收入曲线、清单便签和警示贴纸围绕主体，画面突出机会与风险的反差。`;
  if (/啃草/.test(text)) return `${subject}趴在草地前景啃草，眼神带一点被误解的委屈，旁边有放大镜、警示贴纸和草叶特写。`;
  if (/爪|搭/.test(text)) return `${subject}抬起爪子搭在主人手臂或桌边，眼神期待又认真，前景加入爪印、发光问号和动作局部放大贴纸。`;
  if (/洗脚/.test(text)) return `${subject}坐在浴室或客厅垫子上伸出爪子，水花、毛巾和警示符号形成强前景。`;
  if (/做梦|礼物/.test(text)) return `${subject}从梦境云朵中靠近发光礼物，周围有玩具、星星和温暖卧室光效。`;
  if (/幸福|表现/.test(text)) return `${subject}开心出现在温暖家中，周围环绕多个圆形小图标展示不同幸福动作。`;
  if (/猫|狗|宠物|金毛|泰迪|柯基|柴犬|犬/.test(text)) return `${subject}作为画面主角，动作、眼神和前景道具直接解释标题，场景可以是草地、家中、宠物用品或互动瞬间。`;
  if (pattern.id === "number-list") return `${subject}居中作为主视觉，周围漂浮多个圆形动作小图，每个小图都展示一个能解释标题的细节。`;
  return `根据文案语义设计核心主体，把人、动物、产品、场景或事件中最能表达标题观点的对象放在视觉中心，用表情、动作、道具、环境和局部放大贴纸形成一眼能懂的画面。`;
}
function makeTitle(text: string, pattern: CoverPattern, coverMode: CoverModeId = "cartoon") {
  if (!compactText(text)) return "";
  const subject = detectSubject(text);
  const number = detectNumber(text);
  const petName = subject === "狗狗" ? "狗" : subject;
  const isPet = /猫|狗|宠物|金毛|泰迪|柯基|柴犬/.test(text);
  const isEduInterview = /教资|面试|试讲|板书|考官/.test(text);
  const isShortVideo = /账号|运营|流量|短视频|抖音|涨粉|爆款|拍摄|剪辑|选题|封面/.test(text);
  if (coverMode === "funny-cartoon" && isPet) {
    if (/摇尾巴|尾巴.*摇|摇.*尾巴/.test(text)) return `狗狗摇尾巴\n真是在开心?`;
    if (/不会说话|永远爱|无条件的爱|无条件.*爱|纯粹.*爱/.test(text)) return `小狗不说话\n心思全写脸上`;
    if (pattern.id === "number-list") return number ? `${subject}的${number}个怪动作\n你看懂几个?` : `${subject}这些怪动作\n到底几个意思?`;
    if (pattern.id === "alert-knowledge") return `${subject}突然这样\n你礼貌吗?`;
    if (pattern.id === "warm-emotion") return `小狗又在\n对你做心软测试`;
    if (pattern.id === "contrast-suspense") return `${subject}突然这样\n它想干嘛?`;
    return `${subject}这个表情\n到底几个意思?`;
  }
  if (isPet && /摇尾巴|尾巴.*摇|摇.*尾巴/.test(text)) return `狗狗摇尾巴\n不只是在开心`;
  if (isPet && /不会说话|永远爱|无条件的爱|无条件.*爱|纯粹.*爱/.test(text)) return `小狗不会说话\n却用一生爱你`;
  if (isEduInterview && pattern.id === "number-list") return number ? `试讲总卡壳?\n先看这${number}点` : `试讲总卡壳?\n先找真正原因`;
  if (isEduInterview && pattern.id === "alert-knowledge") return `教资面试\n别踩这个坑`;
  if (isEduInterview) return `为什么试讲\n总拿低分?`;
  if (isShortVideo && pattern.id === "number-list") return number ? `别急着拍\n先看这${number}点` : `别急着拍\n先找点击理由`;
  if (isShortVideo && pattern.id === "alert-knowledge") return `账号没流量\n先查这件事`;
  if (isShortVideo) return `为什么你的视频\n没人点?`;
  if (pattern.id === "warm-emotion") return isPet ? `它忘了很多\n却没忘你` : `${subject}最怕的\n不是没机会`;
  if (pattern.id === "contrast-suspense") return isPet ? `为什么养${petName}\n会被治愈?` : `${subject}背后\n藏着什么?`;
  if (pattern.id === "number-list") {
    if (number) return isPet ? `${subject}的${number}个\n邀请暗号是什么?` : `${subject}的${number}个\n爆款信号`;
    return isPet ? `${subject}这些动作\n都在对你说话` : `这些关键信号\n你看懂了吗?`;
  }
  if (pattern.id === "alert-knowledge") {
    if (/啃草/.test(text)) return `${subject}啃草\n可要注意了`;
    if (/爪|搭/.test(text)) return `${subject}突然搭爪\n可要注意了`;
    if (!isPet) return `${subject}这件事\n千万别忽略`;
    return `${subject}这个动作\n可要注意了`;
  }
  if (/洗脚/.test(text)) return `天天给${subject}洗脚\n可以吗?`;
  if (/啃草/.test(text)) return `${subject}啃草\n真是嘴馋吗?`;
  if (/爪|搭/.test(text)) return `${subject}把爪搭上来\n是在暗示什么?`;
  if (/做梦|礼物/.test(text)) return `${subject}做梦都想要的\n礼物`;
  if (/幸福|表现/.test(text)) return number ? `${subject}幸福的\n${number}种表现` : `${subject}幸福吗?\n动作不会骗人`;
  return isPet ? `${subject}这个动作\n到底在说什么?` : `这件事背后\n藏着什么?`;
}

function makeSubtitle(text: string, pattern: CoverPattern, coverMode: CoverModeId = "cartoon") {
  if (!compactText(text)) return "";
  const subject = detectSubject(text);
  if (coverMode === "funny-cartoon" && /猫|狗|宠物|金毛|泰迪|柯基|柴犬|犬/.test(text)) return `先看${subject}的表情，再揭开它的小心思`;
  if (/摇尾巴|尾巴.*摇|摇.*尾巴/.test(text)) return "方向、速度和幅度，都藏着真实情绪";
  if (/不会说话|永远爱|无条件的爱|无条件.*爱|纯粹.*爱/.test(text)) return "它不会表达，却把每一次靠近都留给你";
  if (/教资|面试|试讲|板书|考官/.test(text)) return "开场、板书、互动节奏，决定考官第一印象";
  if (/账号|运营|流量|短视频|抖音|涨粉|爆款/.test(text)) return "把用户停留点放大，封面才有点击理由";
  if (pattern.id === "warm-emotion") return `${subject}真正依赖你时，会把答案藏在动作里`;
  if (pattern.id === "number-list") return "看懂这些动作，封面一眼就有点击欲";
  if (pattern.id === "alert-knowledge") return "先抓住异常动作，再给出解决线索";
  return "先制造疑问，再用表情和细节把答案摆出来";
}

function buildVisualPrompt(text: string, animationStyle: AnimationStyle, pattern: CoverPattern, ratio: StudioRatio, title: string, subtitle: string, layoutTemplate?: LayoutTemplate | null, hasReferenceImage = false, subjectMode: SubjectModeId = "semantic") {
  const isProductCover = subjectMode === "product";
  const subject = isProductCover ? "产品主视觉" : detectSubject(text);
  const summary = extractCoreSummary(text);
  const visualFocus = isProductCover
    ? "以产品或产品使用场景作为视觉中心。上传产品图时保留产品外观、材质、颜色、包装和关键细节；未上传产品图时，用通用包装轮廓、使用者动作、卖点场景和结果对比表达，不虚构具体品牌外观。"
    : makeVisualFocus(text, pattern);
  const materials = (isProductCover ? ["产品主视觉", "使用场景人物", "卖点贴纸", "结果对比", "光效强调", "模板标题区"] : makeMaterials(text, pattern)).join("、");
  const safeTitle = title.replace(/\n/g, " / ");
  const titleLines = title.split("\n").join(" | ");
  const subjectDirective = makeSubjectDirective(text, subjectMode);
  const subjectStyle = isProductCover
    ? `产品主视觉是${animationStyle.renderStyle}。上传了产品图时以产品参考图为准；没有产品图时只生成通用产品氛围和使用场景，不编造具体品牌、型号和精确外观。`
    : animationStyle.id === "pet-3d"
      ? `${subject} 是高质量 3D 动画萌宠角色，商业级卡通质感，表情夸张、眼睛有情绪、毛发柔软、身体动作能直接解释标题悬念。`
      : `${subject} 是${animationStyle.renderStyle}，表情、眼神和身体动作必须能直接解释标题悬念。`;
  return [
    `任务：根据视频文案生成一张完整的抖音爆款封面图，不是背景图。`,
    `文案核心摘要：${summary}`,
    `标题提炼规则：${VIRAL_TITLE_RULE}`,
    `封面点击钩子：${pattern.hook}。目标是让用户停留、好奇、想点击，标题必须服务点击，不是普通总结。`,
    `封面主标题：${safeTitle}`,
    `标题分行：${titleLines}`,
    `副标题/辅助信息：${subtitle}`,
    hasReferenceImage ? `用户已上传封面素材：${subjectMode === "product" ? "以上传产品图作为封面主视觉，围绕产品卖点做标题提炼、模板排版、贴纸、光效和使用场景强化。" : "以用户上传图作为封面主体素材，只做文案拆解、爆款标题提炼、模板排版、贴纸、光效和留白强化。"}` : `用户未上传封面素材：${subjectDirective} 当前选择的素材风格决定真实摄影、卡通、3D、绘本或动漫质感；主体由当前文案决定，模板只提供版式。`,
    `主标题和副标题必须逐字使用上述原文，只允许按给定标题分行换行。不得同义替换、扩写、缩写、增删任何汉字，不得自行改成另一句。中文标题要大、清晰、醒目、可读。`,
    layoutTemplate ? `标题排版：严格遵循所选模板的版式规则：${layoutTemplate.layoutHint}。标题区域、字体粗细、描边、颜色层级和分行节奏要像原生设计，只替换为当前中文标题。` : `标题排版：参考抖音宠物爆款封面，上方 30%-36% 为标题区，超粗中文字体，白色或亮黄色填充，深棕/红色厚描边，轻微立体阴影，标题可以略微倾斜但必须易读。`,
    layoutTemplate ? `模板文字规则：${layoutTemplate.prompt}` : ``,
    layoutTemplate ? `模板隔离要求：模板只学习标题位置、字体层级、色块、贴纸、留白、信息层级和视觉节奏；严禁复刻模板截图里的原人物、脸型、发型、衣服、手势、商品、背景、原标题、水印或品牌。没有用户上传主体图时，必须按当前文案原创一个全新主体，人物身份、五官、服装和场景都要明显不同于模板截图。` : ``,
    `主体画面：${visualFocus}`,
    `主体素材风格：${subjectStyle}${layoutTemplate ? "。这只控制上传素材修饰或新主体素材的质感，不得改变模板本身的排版设计。" : ""}`,
    `封面素材：${materials}。素材要围绕标题服务，不要随机堆砌。`,
    layoutTemplate ? `模板封面版式：${layoutTemplate.name}。提取模板的画面比例、标题区块位置、字号层级、描边投影、色块关系、贴纸密度、留白和信息条节奏；主体内容按当前文案语义设计。` : `构图方式：${pattern.composition}，${ratio} 比例，强缩略图冲击力，主体在中下区域，标题和主体不互相遮挡。`,
    layoutTemplate ? `模板执行方式：从当前文案出发重新设计一张新封面。${hasReferenceImage ? "主体使用上传素材；" : "主体按文案语义原创设计；"}模板负责排版布局、标题层级、色块关系和装饰节奏。` : `色彩光效：${animationStyle.palette}，高饱和、高对比，暖色轮廓光，局部金色光效，社交媒体缩略图级清晰度。`,
    layoutTemplate ? `文字融合要求：中文主标题必须像原生设计排版一样融入模板，有正确层级、描边、投影、留白和遮挡关系；禁止像后期贴字一样硬塞在画面上。` : `色彩光效：${animationStyle.palette}，高饱和、高对比，暖色轮廓光，局部金色光效，社交媒体缩略图级清晰度。`,
    layoutTemplate ? `模板风格锁定：只锁定主配色、背景明暗、标题区域比例、描边逻辑和装饰密度；主体内容必须完全服务当前文案。最终图是按模板重新设计的新封面，不是在模板截图上换字。` : ``,
    `画面要求：一眼看懂标题提出的问题和主体动作之间的关系，有问号/警示/放大镜/箭头/圆形细节贴纸，但不要做成杂乱海报。`,
    `输出限制：最终成图必须包含上述中文标题；不要水印、不要平台 Logo、不要无关文字、不要多余英文、不要边框。`,
  ].join("\n");
}

function buildFunnyCartoonPrompt(text: string, animationStyle: AnimationStyle, pattern: CoverPattern, ratio: StudioRatio, title: string, subtitle: string, hasReferenceImage = false) {
  const basePrompt = buildVisualPrompt(text, animationStyle, pattern, ratio, title, subtitle, null, hasReferenceImage, "semantic");
  const subject = detectSubject(text);
  const isPet = /猫|狗|宠物|金毛|泰迪|柯基|柴犬|犬/.test(text);
  return [
    basePrompt,
    `卡通搞怪风格加固：参考高点击率短视频的反差封面逻辑，但不要复刻任何具体账号、头像、原图或水印。整体要像成熟商业封面，不是普通可爱插画。`,
    `视觉定位：${subject}是画面绝对主角，必须有夸张表情和明确动作，表情可以震惊、委屈、炸毛、尴尬、得意、求救、偷看、被抓包或突然失控，动作要和标题形成强反差笑点。`,
    `标题风格：主标题使用超粗中文大字，粉紫/亮黄/白色为主，深紫、深棕或红色厚描边，带立体阴影和轻微斜切；标题上方或左上占画面 30%-38%，短、狠、像抖音爆款提问。`,
    `搞怪钩子：优先制造“反常识 + 情绪反差 + 一眼有梗”的画面，${isPet ? "比如宠物做出人类化反应、夸张误会、突然被发现或与主人互动引发戏剧冲突" : "根据文案主体设计夸张误会、突然被发现、前后反差或结果失控的戏剧瞬间"}。`,
    `场景拆解：${isPet ? "室内暖光客厅、卧室、餐桌、宠物玩具区、窗边阳光、草地或公园" : "选择最能解释文案冲突的生活、职场、学习、消费或户外场景"}；背景要有电影级暖光、强聚光、浅景深和局部光束，不能平淡。`,
    `道具与贴纸：加入问号、惊叹号、爱心、表情球、放大镜、箭头、运动线、发光贴纸、局部小道具，但密度适中，服务标题笑点，不要堆满。`,
    `角色要求：${isPet ? "宠物必须是原创 3D 卡通角色，眼睛大、毛发柔软、嘴型和眉眼夸张" : "主体必须按文案原创设计，表情、动作、服装和道具共同解释反差笑点"}，不能照搬截图里的主体姿势、画面构图或原文字。`,
    `成图目标：用户刷到缩略图时，先被${isPet ? "宠物" : "主体"}的搞怪表情或动作吸引，再被标题问题钩住，并能立刻理解内容主题。`,
  ].join("\n");
}

function buildCoverPrompt(text: string, animationStyle: AnimationStyle, pattern: CoverPattern, ratio: StudioRatio, title: string, subtitle: string, coverMode: CoverModeId, layoutTemplate: LayoutTemplate, hasReferenceImage: boolean, subjectMode: SubjectModeId, materialSource: MaterialSourceId) {
  const usesBuiltInTemplate = materialSource === "template";
  const usesUploadedReference = materialSource === "upload";
  const effectiveSubjectMode = usesUploadedReference ? subjectMode : "semantic";
  const modeLabel = coverMode === "funny-cartoon" ? "卡通搞怪" : "卡通风格";
  const materialLabel = usesBuiltInTemplate ? "参考模板" : usesUploadedReference ? "上传参考图" : "文案直出";
  const titleSemantics = [title.replace(/\n/gu, " / "), subtitle].filter(Boolean).join("；");
  const templateDirective = usesBuiltInTemplate
    ? `参考模板：${layoutTemplate.name}。只学习${layoutTemplate.layoutHint}、主体位置、阅读动线和自然留白；原模板的文字框、横条和底栏只学习占比，底图必须用连续场景或自然纹理替代，不能留下空框；不得复刻原人物、商品、品牌、Logo、水印或原文案。`
    : `构图方式：${pattern.composition}，${ratio} 比例，主体和动作在缩略图中一眼可辨。`;
  const funnyDirective = coverMode === "funny-cartoon"
    ? `卡通搞怪加固：${detectSubject(text)}是绝对主角，用震惊、委屈、炸毛、得意、偷看或被抓包等夸张表情与动作制造反差笑点；用运动线、漫画爆点和高对比光色强化反应，不生成任何符号或文字。`
    : `视觉钩子：${pattern.hook}；${makeVisualFocus(text, pattern)}`;
  const materialDirective = usesUploadedReference && hasReferenceImage
    ? effectiveSubjectMode === "product"
      ? "参考来源：用户上传图。它是唯一参考源；严格保留产品外观、材质、颜色、包装和关键细节，再重构使用场景、光效和构图。不得混入任何参考模板图。"
      : "参考来源：用户上传图。它是唯一参考源；保留主体身份和关键外观，只重构场景、动作、光效与封面构图。不得复制图中文字、Logo或水印，也不得混入参考模板图。"
    : usesBuiltInTemplate
      ? `参考来源：参考模板 ${layoutTemplate.name}。模板只提供版式与视觉关系，主体和内容必须按当前文案重新设计。`
    : usesUploadedReference
      ? "参考来源：等待用户上传参考图。上传完成前禁止提交生成，也不得回退为参考模板或混入其他参考图。"
    : effectiveSubjectMode === "product"
      ? "生成方式：AI自动生成。当前为产品图封面，但没有产品参考图；只生成通用产品轮廓、使用场景和卖点氛围，不虚构品牌、型号或精确包装。"
      : `生成方式：AI自动生成。${makeSubjectDirective(text, effectiveSubjectMode)}`;
  const directorSource = coverMode === "funny-cartoon"
    ? buildFunnyCartoonPrompt(text, animationStyle, pattern, ratio, title, subtitle, false)
    : buildVisualPrompt(text, animationStyle, pattern, ratio, title, subtitle, usesBuiltInTemplate ? layoutTemplate : null, usesUploadedReference && hasReferenceImage, effectiveSubjectMode);
  const directorDetails = directorSource.split("\n")
    .filter((line) => /^(?:主体画面|主体素材风格|封面素材|构图方式|模板封面版式|模板执行方式|模板风格锁定|卡通搞怪风格加固|视觉定位|搞怪钩子|场景拆解|道具与贴纸|角色要求|成图目标)：/u.test(line))
    .join("\n");
  return [
    buildCoverBackgroundPrompt({
      brief: text,
      visualStyle: usesBuiltInTemplate || usesUploadedReference
        ? `${animationStyle.renderStyle}；服从参考来源的空间节奏与主配色，重新设计连续、完整的场景`
        : coverMode === "funny-cartoon"
          ? `${animationStyle.renderStyle}；夸张鼻眼嘴和身体反应，桃粉、珊瑚橙、亮黄、青蓝形成喜剧高对比，主体占据中下部`
          : `${animationStyle.renderStyle}；暖金、橙棕和奶油色的情绪叙事，眼神与动作体现主体关系，画面有生活故事感`,
      layoutHint: usesBuiltInTemplate ? layoutTemplate.layoutHint : pattern.composition,
      coverModeId: coverMode,
      materialSourceId: materialSource,
    }),
    `封面制作模式：${modeLabel}。`,
    `参考方式：${materialLabel}。`,
    `主体路线：${effectiveSubjectMode === "product" ? "产品图封面" : "语义人物/场景"}。`,
    materialDirective,
    funnyDirective,
    directorDetails,
    templateDirective,
    `封面语义：${extractCoreSummary(text)}`,
    `标题语义仅用于决定主体动作和留白，不得把文字画进底图：${titleSemantics || "尚未提炼标题"}。`,
    `素材清单：${(effectiveSubjectMode === "product" ? ["产品主视觉", "使用场景", "卖点贴纸区域", "结果对比区域", "光效强调"] : makeMaterials(text, pattern)).join("、")}。`,
    "交付边界：模型只生成无字底图，标题、副标题和可见字符全部由应用程序后续逐字排版。",
  ].join("\n");
}

function syncCoverCopySemantics(prompt: string, title: string, subtitle: string) {
  const semantics = [title.replace(/\n/gu, " / "), subtitle].map((item) => item.trim()).filter(Boolean).join("；") || "尚未提炼标题";
  const nextLine = `标题语义仅用于决定主体动作和留白，不得把文字画进底图：${semantics}。`;
  return /^标题语义仅用于决定主体动作和留白，不得把文字画进底图：.*$/mu.test(prompt)
    ? prompt.replace(/^标题语义仅用于决定主体动作和留白，不得把文字画进底图：.*$/mu, nextLine)
    : `${prompt.trim()}\n${nextLine}`.trim();
}

function coverAnalysisFingerprint(input: {
  briefText: string;
  ratio: StudioRatio;
  coverModeId: CoverModeId;
  layoutTemplateId: LayoutTemplateId;
  animationStyleId: AnimationStyleId;
  subjectModeId: SubjectModeId;
  materialSourceId: MaterialSourceId;
  referenceImage: string;
  referenceImageName: string;
}) {
  const activeMaterialSource = input.materialSourceId;
  const activeLayoutTemplateId = activeMaterialSource === "template" ? input.layoutTemplateId : "none";
  const activeSubjectMode: SubjectModeId = activeMaterialSource === "upload" ? input.subjectModeId : "semantic";
  const referenceSignature = activeMaterialSource === "upload" && input.referenceImage
    ? `${input.referenceImageName}:${input.referenceImage.length}:${input.referenceImage.slice(-48)}`
    : "none";
  return JSON.stringify([
    input.briefText.trim(), input.ratio,
    input.coverModeId, activeLayoutTemplateId, input.animationStyleId,
    activeSubjectMode, activeMaterialSource, referenceSignature,
  ]);
}

function makeMaterials(text: string, pattern: CoverPattern) {
  const subject = detectSubject(text);
  if (/教资|面试|试讲|板书|考官/.test(text)) return ["试讲人物主视觉", "黑板板书", "考官第一印象贴纸", "计时器", "红色错点标记", "黄色重点标题"];
  if (/账号|运营|流量|短视频|抖音|涨粉|爆款/.test(text)) return ["创作者主视觉", "手机数据曲线", "播放量气泡", "爆款标签", "对比箭头", "强标题贴纸"];
  if (/职场|求职|简历|offer|老板|同事|公司/.test(text)) return ["职场人物主视觉", "简历或会议便签", "Offer标签", "红色提醒贴纸", "对比箭头"];
  if (pattern.id === "number-list") return [`${subject}主视觉`, "3 个圆形动作小图", "数字贴纸", "彩色箭头", "暖色光效"];
  if (pattern.id === "alert-knowledge") return [`${subject}异常动作`, "警示三角", "放大镜局部", "主人惊讶表情", "前景草叶或家居道具"];
  if (pattern.id === "warm-emotion") return [`${subject}依偎动作`, "主人拥抱", "暖灯光束", "窗边夜色", "柔焦玩具"];
  if (pattern.id === "contrast-suspense") return [`${subject}反常动作`, "单束聚光", "暗色房间", "被发现的表情", "发光线索"];
  return [`${subject}夸张表情`, "主人反应", "爪子/草/玩具前景", "警示或问号贴纸", "金色描边光效"];
}

const COVER_MODEL_CATALOG_TTL_MS = 30_000;
let sharedCoverModelCatalog: { expiresAt: number; promise: Promise<CoverGenerationModel[]> } | null = null;

function readCoverModelCatalog(force = false) {
  const now = Date.now();
  if (!force && sharedCoverModelCatalog && sharedCoverModelCatalog.expiresAt > now) return sharedCoverModelCatalog.promise;
  const promise = fetch("/api/cover-models?surface=cover-studio")
    .then(async (response) => {
      if (!response.ok) throw new Error("模型列表暂时不可用");
      const data = await response.json() as { models?: unknown };
      return parseCoverGenerationModels(data.models);
    })
    .catch((error) => {
      sharedCoverModelCatalog = null;
      throw error;
    });
  sharedCoverModelCatalog = { expiresAt: now + COVER_MODEL_CATALOG_TTL_MS, promise };
  return promise;
}

export function CoverStudio() {
  const { state } = useApp();
  return <CoverStudioForAccount key={state.auth.user?.id || "anonymous"} />;
}

function CoverStudioForAccount() {
  const { state: appState, checkAuth } = useApp();
  const currentUserId = appState.auth.user?.id || "";
  const currentUserIdRef = useRef(currentUserId);
  useEffect(() => { currentUserIdRef.current = currentUserId; }, [currentUserId]);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const taskCounterRef = useRef(0);
  const submissionInFlightRef = useRef<string | null>(null);
  const displayRenewalRef = useRef(new Map<string, number>());
  const [generationBusy, setGenerationBusy] = useState(false);
  const [cancelTaskBusyId, setCancelTaskBusyId] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [failureHistoryNotice, setFailureHistoryNotice] = useState("");
  const [failureActionBusy, setFailureActionBusy] = useState(false);
  const [historyNextPage, setHistoryNextPage] = useState<number | null>(null);
  const [historyClearing, setHistoryClearing] = useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const historyRequestRef = useRef(0);
  const cloudHistoryRef = useRef<CoverGenerationTask[]>([]);
  const [ratio, setRatio] = useState<StudioRatio>("3:4");
  const [coverModeId, setCoverModeId] = useState<CoverModeId>("cartoon");
  const [layoutTemplateId, setLayoutTemplateId] = useState<LayoutTemplateId>("gaoding-teacher-interview");
  const [animationStyleId, setAnimationStyleId] = useState<AnimationStyleId>("pet-3d");
  const [subjectModeId, setSubjectModeId] = useState<SubjectModeId>("semantic");
  const [materialSourceId, setMaterialSourceId] = useState<MaterialSourceId>("text");
  const [briefText, setBriefText] = useState("");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [analysisFingerprint, setAnalysisFingerprint] = useState("");
  const [selectedResultId, setSelectedResultId] = useState("");
  const [referenceImage, setReferenceImage] = useState("");
  const [referenceImageName, setReferenceImageName] = useState("");
  const [favoriteTemplateIds, setFavoriteTemplateIds] = useState<LayoutTemplateId[]>([]);
  const [favoriteTemplatesReady, setFavoriteTemplatesReady] = useState(false);
  const [templateViewId, setTemplateViewId] = useState<"all" | "favorites">("all");
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);
  const [templatePreview, setTemplatePreview] = useState<LayoutTemplate | null>(null);
  const [templateSearch, setTemplateSearch] = useState("");
  const [auxiliaryCopyOpen, setAuxiliaryCopyOpen] = useState(false);
  const [promptAdvancedOpen, setPromptAdvancedOpen] = useState(false);
  const [results, setResults] = useState<CoverResult[]>([]);
  const [previewResult, setPreviewResult] = useState<CoverResult | null>(null);
  const previewDialogRef = useRef<HTMLDivElement | null>(null);
  const [models, setModels] = useState<CoverGenerationModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!previewResult) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      previewDialogRef.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();
    });
    const handlePreviewKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPreviewResult(null);
        return;
      }
      if (event.key !== "Tab" || !previewDialogRef.current) return;
      const focusable = [...previewDialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handlePreviewKeys);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handlePreviewKeys);
      window.requestAnimationFrame(() => returnFocus?.focus());
    };
  }, [previewResult]);

  useEffect(() => {
    if (!templateLibraryOpen && !templatePreview) return;
    const handleTemplateLibraryKeys = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (templatePreview) setTemplatePreview(null);
      else setTemplateLibraryOpen(false);
    };
    window.addEventListener("keydown", handleTemplateLibraryKeys);
    return () => window.removeEventListener("keydown", handleTemplateLibraryKeys);
  }, [templateLibraryOpen, templatePreview]);

  useEffect(() => {
    if (!historyPanelOpen) return;
    const handleHistoryKeys = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setHistoryPanelOpen(false);
    };
    window.addEventListener("keydown", handleHistoryKeys);
    return () => window.removeEventListener("keydown", handleHistoryKeys);
  }, [historyPanelOpen]);

  const [notice, setNotice] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  const animationStyle = COVER_ANIMATION_STYLES.find((item) => item.id === animationStyleId) ?? COVER_ANIMATION_STYLES[0];
  const layoutTemplate = LAYOUT_TEMPLATES.find((item) => item.id === layoutTemplateId) ?? REAL_LAYOUT_TEMPLATES[0] ?? LAYOUT_TEMPLATES[0];
  const pattern = useMemo(() => getAutoPattern(briefText), [briefText]);
  const favoriteTemplates = useMemo(
    () => favoriteTemplateIds
      .map((id) => REAL_LAYOUT_TEMPLATES.find((item) => item.id === id))
      .filter((item): item is LayoutTemplate => Boolean(item)),
    [favoriteTemplateIds],
  );
  const visibleLayoutTemplates = useMemo(() => {
    const source = templateViewId === "favorites" ? favoriteTemplates : REAL_LAYOUT_TEMPLATES;
    const keyword = templateSearch.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return source;
    return source.filter((item) => `${item.name} ${item.source} ${item.layoutHint}`.toLocaleLowerCase("zh-CN").includes(keyword));
  }, [favoriteTemplates, templateSearch, templateViewId]);
  const isReferenceCreation = materialSourceId !== "text";
  const usesBuiltInTemplate = materialSourceId === "template";
  const usesUploadedReference = materialSourceId === "upload";
  const hasReferenceMaterial = usesUploadedReference && Boolean(referenceImage);
  const activeModel = models.find((model) => model.id === modelId);
  const flagshipModels = COVER_FLAGSHIP_MODELS.flatMap((flagship) => {
    const model = models.find((item) => coverFlagship(item)?.key === flagship.key);
    return model ? [{ flagship, model }] : [];
  });
  const cartoonStyles = useMemo(() => COVER_ANIMATION_STYLES.filter((item) => item.id !== "photo-real" && item.id !== "cinematic-real"), []);
  const activeStyleOptions = isReferenceCreation ? COVER_ANIMATION_STYLES : cartoonStyles;
  const currentAnalysisFingerprint = useMemo(() => coverAnalysisFingerprint({
    briefText,
    ratio,
    coverModeId,
    layoutTemplateId,
    animationStyleId,
    subjectModeId,
    materialSourceId,
    referenceImage,
    referenceImageName,
  }), [animationStyleId, briefText, coverModeId, layoutTemplateId, materialSourceId, ratio, referenceImage, referenceImageName, subjectModeId]);
  const planNeedsRebuild = Boolean(briefText.trim()) && analysisFingerprint !== currentAnalysisFingerprint;

  function selectCoverMode(nextMode: CoverModeId) {
    setCoverModeId(nextMode);
    if (!isReferenceCreation && (animationStyleId === "photo-real" || animationStyleId === "cinematic-real")) setAnimationStyleId("pet-3d");
    setNotice(nextMode === "funny-cartoon" ? "已切换为卡通搞怪：系统会按文案放大反差和笑点" : "已切换为卡通风格：系统会按文案生成温暖、有质感的画面");
  }

  const loadBalance = useCallback(async (token: string) => {
    const response = await fetch("/api/cash/balance", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return setBalance(null);
    const data = await response.json() as { balance?: number };
    setBalance(Number(data.balance ?? 0));
  }, []);

  useEffect(() => {
    let active = true;
    void readCoverModelCatalog()
      .then((next) => {
        if (!active) return;
        const ordered = sortCoverGenerationModels(next);
        setModels(ordered);
        setModelId((currentModelId) => {
          if (ordered.some((model) => model.id === currentModelId)) return currentModelId;
          return defaultCoverModelId(ordered);
        });
      })
      .catch(() => setNotice("模型列表暂时不可用，仍可先完成封面拆解"));

    const token = localStorage.getItem(TOKEN_KEY);
    if (token && currentUserId && currentUserId !== "anonymous") void loadBalance(token);

    const favoriteRaw = localStorage.getItem(FAVORITE_TEMPLATES_KEY);
    if (favoriteRaw) {
      try {
        const ids = JSON.parse(favoriteRaw) as unknown;
        if (Array.isArray(ids)) {
          setFavoriteTemplateIds(
            ids.filter((id): id is LayoutTemplateId => typeof id === "string" && REAL_LAYOUT_TEMPLATES.some((item) => item.id === id)),
          );
        }
      } catch {
        localStorage.removeItem(FAVORITE_TEMPLATES_KEY);
      }
    }
    setFavoriteTemplatesReady(true);
    return () => {
      active = false;
    };
  }, [currentUserId, loadBalance]);

  useEffect(() => {
    clearLegacyCoverEditorDraft(currentUserId || "anonymous");
  }, [currentUserId]);

  const showGenerationState = useCallback((saved: CoverGenerationState, selectLatest = false) => {
    const candidates = saved.pending ? [saved.pending.task, ...saved.history] : [...saved.history];
    const tasks = [...new Map(candidates.map((task) => [coverHistoryStableKey(task), task])).values()]
      .sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
    setResults(tasks);
    taskCounterRef.current = Math.max(0, ...tasks.map((task) => task.taskNo));
    const latest = saved.pending?.task || saved.history[0];
    setSelectedResultId(previous => selectLatest ? latest?.id || "" : (tasks.some(task => task.id === previous) ? previous : ""));
  }, []);

  const loadAccountHistory = useCallback(async (page = 1, signal?: AbortSignal, selectLatest = false) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token || !currentUserId || currentUserId === "anonymous") return;
    const sequence = ++historyRequestRef.current;
    setHistoryLoading(true); setHistoryError("");
    try {
      const loaded = await fetchCoverAccountHistory(token, page, signal);
      if (signal?.aborted || sequence !== historyRequestRef.current || currentUserIdRef.current !== currentUserId) return;
      const next = page === 1 ? loaded.records : [...cloudHistoryRef.current, ...loaded.records];
      cloudHistoryRef.current = [...new Map(next.map((record) => [coverHistoryStableKey(record), record])).values()]
        .sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
      showGenerationState(mergeCoverAccountHistory(localStorage, currentUserId, cloudHistoryRef.current), selectLatest);
      setHistoryNextPage(loaded.nextPage);
      setFailureHistoryNotice(loaded.failureHistory.ready
        ? loaded.failureHistory.message || ""
        : loaded.failureHistory.message || "失败历史暂时不可读取");
    } catch (error) {
      if (!signal?.aborted && sequence === historyRequestRef.current) setHistoryError(error instanceof Error ? error.message : "封面历史暂时无法读取");
    } finally { if (sequence === historyRequestRef.current) setHistoryLoading(false); }
  }, [currentUserId, showGenerationState]);

  useEffect(() => {
    const controller = new AbortController();
    if (!currentUserId || currentUserId === "anonymous") {
      setResults([]);
      return () => controller.abort();
    }
    try {
      detachCoverGenerationTracking(localStorage, currentUserId);
      showGenerationState({ version: 1, pending: null, history: [] });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "封面任务记录暂不可读取");
      return () => controller.abort();
    }
    void loadAccountHistory(1, controller.signal, false);
    return () => controller.abort();
  }, [currentUserId, showGenerationState, loadAccountHistory]);

  useEffect(() => {
    if (historyLoading || !results.some((item) => ["running", "unknown", "display_pending"].includes(item.status))) return;
    const timer = window.setTimeout(() => {
      const token = localStorage.getItem(TOKEN_KEY) || "";
      const active = results.filter((item) => (item.status === "running" || item.status === "unknown")
        && item.clientIdempotencyKey && item.clientTraceId).slice(0, 12);
      void Promise.allSettled(active.map((item) => fetch(`/api/cover/attempt?${new URLSearchParams({
        clientIdempotencyKey: item.clientIdempotencyKey!,
        clientTraceId: item.clientTraceId!,
      })}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })))
        .finally(() => void loadAccountHistory());
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [historyLoading, loadAccountHistory, results]);

  const handleResultImageError = useCallback((resultId: string) => {
    const message = "安全展示地址已失效，系统正在重新获取；若仍失败，请稍后刷新历史或下载原文件";
    setResults(previous => previous.map(item => item.id === resultId
      ? { ...item, status: "display_pending", url: undefined, error: message }
      : item));
    setPreviewResult(previous => previous?.id === resultId
      ? { ...previous, status: "display_pending", url: undefined, error: message }
      : previous);
    const now = Date.now();
    const previousRenewal = displayRenewalRef.current.get(resultId) || 0;
    if (now - previousRenewal < 10_000) return;
    displayRenewalRef.current.set(resultId, now);
    setNotice(message);
    void loadAccountHistory();
  }, [loadAccountHistory]);

  const selectedHistoryTask = results.find(item => item.id === selectedResultId);

  async function loadFailureForRetry(record: CoverResult) {
    if (!record.failureRecordId || failureActionBusy || generationBusy) return;
    if (!record.canLoadForRetry) return setNotice(record.retryBlockReason || "请先完成账务对账，当前记录不可重新提交");
    if (record.billing?.state !== "not_charged" && record.billing?.state !== "exempt") {
      return setNotice("只有明确未扣费的失败记录可以载入；已扣费、未知或未确认退款的记录不可重试");
    }
    setFailureActionBusy(true);
    try {
      const freshModels = await readCoverModelCatalog(true);
      setModels(freshModels);
      const currentModel = freshModels.find((model) => model.id === record.publicModelId);
      if (!currentModel?.available) throw new Error(currentModel?.availabilityMessage || "原模型当前不可用，不能载入重试");
      if (!currentModel.priceReady || currentModel.price == null) throw new Error("原模型当前价格未就绪，不能载入重试");
      const plan = record.renderPlan;
      const restoredMode: CoverModeId = plan?.coverModeId === "funny-cartoon" || record.prompt.includes("封面制作模式：卡通搞怪")
        ? "funny-cartoon" : "cartoon";
      const restoredSource: MaterialSourceId = plan?.materialSourceId
        ?? (record.prompt.includes("参考方式：参考模板") ? "template"
          : record.requiresReferenceReupload || record.prompt.includes("参考方式：上传参考图") ? "upload" : "text");
      const restoredSubject: SubjectModeId = plan?.subjectModeId === "product" ? "product" : "semantic";
      const restoredBrief = record.briefText || (plan ? `${plan.title}\n${plan.subtitle}` : briefText);
      setModelId(currentModel.id);
      const restoredRatio = plan?.aspectRatio || record.ratio;
      if (["16:9", "9:16", "4:3", "3:4"].includes(restoredRatio)) setRatio(restoredRatio);
      if (plan) {
        setLayoutTemplateId(plan.layoutTemplateId as LayoutTemplateId);
        setAnimationStyleId(plan.animationStyleId as AnimationStyleId);
        setTitle(plan.title);
        setSubtitle(plan.subtitle);
      }
      setBriefText(restoredBrief);
      setCoverModeId(restoredMode);
      setMaterialSourceId(restoredSource);
      setSubjectModeId(restoredSubject);
      setPrompt(record.prompt);
      clearReferenceMaterial();
      setAnalysisFingerprint(plan && restoredSource !== "upload" ? coverAnalysisFingerprint({
        briefText: restoredBrief,
        ratio: plan.aspectRatio,
        coverModeId: restoredMode,
        layoutTemplateId: plan.layoutTemplateId as LayoutTemplateId,
        animationStyleId: plan.animationStyleId as AnimationStyleId,
        subjectModeId: restoredSubject,
        materialSourceId: restoredSource,
        referenceImage: "",
        referenceImageName: "",
      }) : "");
      setNotice(
        "失败参数已载入，尚未调用模型。原报价 ¥" + Number(record.quotedPriceYuan || 0).toFixed(2)
          + "，当前价格 ¥" + currentModel.price.toFixed(2) + "。"
          + (restoredSource === "upload" ? "原参考图仅保存安全哈希，请重新上传并再次拆解。" : restoredSource === "template" ? "参考模板会从平台模板库重新读取。" : "")
          + (plan ? "原文案、模式、版式和排版参数已恢复。" : "旧记录缺少完整排版快照，请重新拆解后再生成。"),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "失败参数暂时无法载入");
    } finally {
      setFailureActionBusy(false);
    }
  }

  async function hideFailureHistory(record: CoverResult) {
    if (!record.failureRecordId || failureActionBusy || !currentUserId) return;
    setFailureActionBusy(true);
    try {
      const response = await fetch("/api/cover/history", {
        method: "DELETE",
        headers: { Authorization: "Bearer " + (localStorage.getItem(TOKEN_KEY) || ""), "Content-Type": "application/json" },
        body: JSON.stringify({ failureRecordId: record.failureRecordId, confirmation: "REMOVE_COVER_FAILURE_HISTORY" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) throw new Error(data.error || "封面失败记录隐藏未完成");
      cloudHistoryRef.current = cloudHistoryRef.current.filter((item) => item.failureRecordId !== record.failureRecordId);
      showGenerationState(mergeCoverAccountHistory(localStorage, currentUserId, cloudHistoryRef.current));
      setNotice("失败记录已隐藏；账单和请求审计证据仍保留");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "封面失败记录隐藏未完成");
    } finally {
      setFailureActionBusy(false);
    }
  }

  function loadSelectedHistoryParameters() {
    if (!selectedHistoryTask?.renderPlan) return setNotice("当前历史记录没有可复用的排版参数");
    const plan = selectedHistoryTask.renderPlan;
    const restoredMode: CoverModeId = plan.coverModeId === "funny-cartoon" || selectedHistoryTask.prompt?.includes("封面制作模式：卡通搞怪")
      ? "funny-cartoon" : "cartoon";
    const restoredSource: MaterialSourceId = plan.materialSourceId
      ?? (selectedHistoryTask.prompt?.includes("参考方式：上传参考图") ? "upload"
        : selectedHistoryTask.prompt?.includes("参考方式：参考模板") ? "template" : "text");
    const restoredSubject: SubjectModeId = plan.subjectModeId === "product" ? "product" : "semantic";
    const restoredBrief = selectedHistoryTask.briefText || `${plan.title}\n${plan.subtitle}`;
    setRatio(plan.aspectRatio);
    setLayoutTemplateId(plan.layoutTemplateId as LayoutTemplateId);
    setAnimationStyleId(plan.animationStyleId as AnimationStyleId);
    setCoverModeId(restoredMode);
    setMaterialSourceId(restoredSource);
    setSubjectModeId(restoredSubject);
    clearReferenceMaterial();
    setTitle(plan.title);
    setSubtitle(plan.subtitle);
    setBriefText(restoredBrief);
    if (selectedHistoryTask.prompt) setPrompt(selectedHistoryTask.prompt);
    setAnalysisFingerprint(restoredSource === "upload" ? "" : coverAnalysisFingerprint({
      briefText: restoredBrief,
      ratio: plan.aspectRatio,
      coverModeId: restoredMode,
      layoutTemplateId: plan.layoutTemplateId as LayoutTemplateId,
      animationStyleId: plan.animationStyleId as AnimationStyleId,
      subjectModeId: restoredSubject,
      materialSourceId: restoredSource,
      referenceImage: "",
      referenceImageName: "",
    }));
    setNotice(restoredSource === "upload"
      ? "已载入历史参数；出于隐私保护，上传参考图不会留在浏览器，请重新选择图片后生成"
      : `已载入历史参数：${restoredMode === "funny-cartoon" ? "卡通搞怪" : "卡通风格"} / ${restoredSource === "template" ? "参考模板" : "文案直出"}；可继续调整后生成`);
  }

  useEffect(() => {
    if (!briefText.trim()) {
      setTitle("");
      setSubtitle("");
      setPrompt("");
      setAnalysisFingerprint("");
    }
  }, [briefText]);

  function analyzeBrief() {
    if (!briefText.trim()) return setNotice("请先输入需要拆解的完整文案");
    const nextTitle = makeTitle(briefText, pattern, coverModeId);
    const nextSubtitle = makeSubtitle(briefText, pattern, coverModeId);
    setTitle(nextTitle);
    setSubtitle(nextSubtitle);
    setAuxiliaryCopyOpen(false);
    setPromptAdvancedOpen(false);
    setPrompt(buildCoverPrompt(
      briefText,
      animationStyle,
      pattern,
      ratio,
      nextTitle,
      nextSubtitle,
      coverModeId,
      layoutTemplate,
      hasReferenceMaterial,
      subjectModeId,
      materialSourceId,
    ));
    setAnalysisFingerprint(coverAnalysisFingerprint({
      briefText,
      ratio,
      coverModeId,
      layoutTemplateId,
      animationStyleId,
      subjectModeId,
      materialSourceId,
      referenceImage,
      referenceImageName,
    }));
    setNotice("文案已拆解；主文案可以直接修改，辅助短句与画面描述按需展开");
  }

  useEffect(() => {
    if (!favoriteTemplatesReady) return;
    localStorage.setItem(FAVORITE_TEMPLATES_KEY, JSON.stringify(favoriteTemplateIds));
  }, [favoriteTemplateIds, favoriteTemplatesReady]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function changeAnimationStyle(nextId: AnimationStyleId) {
    setAnimationStyleId(nextId);
  }

  function changeSubjectMode(nextMode: SubjectModeId) {
    setSubjectModeId(nextMode);
    setNotice(nextMode === "product" ? "已切换为产品图封面：上传产品图时会优先使用产品外观" : "已切换为语义人物/场景：营销文案默认先设计人物和使用场景");
  }

  function openTemplateLibrary() {
    setTemplateLibraryOpen(true);
  }

  function selectLayoutTemplate(nextId: LayoutTemplateId) {
    const nextTemplate = REAL_LAYOUT_TEMPLATES.find((item) => item.id === nextId);
    setLayoutTemplateId(nextId);
    setTemplateLibraryOpen(false);
    if (nextTemplate) setNotice(`已选择模板：${nextTemplate.name}`);
  }

  function toggleFavoriteTemplate(nextId: LayoutTemplateId) {
    const nextTemplate = REAL_LAYOUT_TEMPLATES.find((item) => item.id === nextId);
    const isAlreadyFavorite = favoriteTemplateIds.includes(nextId);
    setNotice(nextTemplate ? `${isAlreadyFavorite ? "已取消收藏" : "已收藏模板"}：${nextTemplate.name}` : isAlreadyFavorite ? "已取消收藏" : "已收藏模板");
    setFavoriteTemplateIds((current) => {
      if (current.includes(nextId)) {
        return current.filter((item) => item !== nextId);
      }
      return [nextId, ...current].slice(0, 12);
    });
  }

  function clearReferenceMaterial() {
    setReferenceImage("");
    setReferenceImageName("");
  }

  function selectMaterialSource(nextSource: MaterialSourceId) {
    setMaterialSourceId(nextSource);
    if (nextSource === "text") {
      if (animationStyleId === "photo-real" || animationStyleId === "cinematic-real") setAnimationStyleId("pet-3d");
      setSubjectModeId("semantic");
      setNotice("已选择文案直出：系统只根据文案生成画面，不发送参考图片");
      return;
    }
    if (activeModel && !activeModel.supportsReferenceInput) {
      const compatibleModel = models.find((model) => model.available && model.priceReady && model.supportsReferenceInput);
      if (compatibleModel) setModelId(compatibleModel.id);
    }
    setNotice(nextSource === "template"
      ? `已选择参考模板：${layoutTemplate.name}；只学习版式和视觉关系`
      : referenceImage ? "已选择上传参考图：本次只发送你的图片" : "请选择一张 PNG、JPEG 或 WebP 参考图（不超过 5MB）");
  }

  function chooseUploadReference() {
    setMaterialSourceId("upload");
    uploadRef.current?.click();
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!COVER_REFERENCE_IMAGE_TYPES.has(file.type)) return setNotice("参考图只支持 PNG、JPEG 或 WebP 格式");
    if (file.size <= 0) return setNotice("参考图为空，请重新选择文件");
    if (file.size > MAX_COVER_REFERENCE_IMAGE_BYTES) return setNotice("参考图不能超过 5MB，请压缩后重新选择");
    const reader = new FileReader();
    reader.onerror = () => setNotice("参考图读取失败，请重新选择文件");
    reader.onload = () => {
      setMaterialSourceId("upload");
      setReferenceImage(String(reader.result ?? ""));
      setReferenceImageName(file.name);
      setSelectedResultId("");
      setNotice("参考图已上传：本次只使用这张图片作为参考，不会同时发送参考模板图");
    };
    reader.readAsDataURL(file);
  }
  const applyTaskRunState = useCallback((saved: CoverGenerationState, originalTaskId: string) => {
    const updated = saved.pending?.task || saved.history[0];
    if (!updated || currentUserIdRef.current !== currentUserId) return;
    setResults((previous) => [updated, ...previous.filter((item) => item.id !== originalTaskId
      && item.id !== updated.id
      && (!updated.clientTraceId || item.clientTraceId !== updated.clientTraceId))]
      .sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0)));
    setSelectedResultId((selectedId) => selectedId === originalTaskId || selectedId === updated.id ? updated.id : selectedId);
  }, [currentUserId]);

  async function generateImage() {
    if (submissionInFlightRef.current || historyClearing) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token || !currentUserId || currentUserId === "anonymous") {
      setLoginOpen(true);
      return;
    }
    if (!briefText.trim()) return setNotice("请先输入封面文案");
    if (!prompt.trim() || planNeedsRebuild) return setNotice("请先点击“拆解文案”，确认拆解结果后再生成");
    if (!title.trim()) return setNotice("请在拆解结果中填写封面标题");
    if (!activeModel) return setNotice("请选择当前可用的生图模型");
    if (activeModel.available !== true) return setNotice(activeModel.availabilityMessage || "当前模型配置尚未完成，请选择其他模型");
    if (activeModel.priceReady !== true) return setNotice("当前模型价格尚未配置，不能提交生成");
    if (usesUploadedReference && !referenceImage) return setNotice("请先上传参考图，或切换为文案直出 / 参考模板");
    if ((usesBuiltInTemplate || usesUploadedReference) && !activeModel.supportsReferenceInput) return setNotice("当前创作依据需要支持参考图的模型，请先切换模型");
    const submissionGateId = `cover-submit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    submissionInFlightRef.current = submissionGateId;
    setGenerationBusy(true);
    let handedOff = false;
    let submissionAnnounced = false;
    const releaseSubmissionGate = () => {
      if (submissionInFlightRef.current !== submissionGateId) return;
      submissionInFlightRef.current = null;
      setGenerationBusy(false);
    };
    const submissionPrompt = syncCoverCopySemantics(prompt, title, subtitle);
    setPrompt(submissionPrompt);
    const taskNo = taskCounterRef.current + 1;
    const taskId = `cover-task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task: CoverGenerationTask = {
      id: taskId,
      ratio,
      title,
      subtitle,
      prompt: submissionPrompt,
      briefText,
      source: "生成",
      createdAt: new Date().toISOString(),
      status: "running",
      taskNo,
      renderPlan: {
        title, subtitle, aspectRatio: ratio, layoutTemplateId, animationStyleId, coverModeId, materialSourceId,
        subjectModeId: typeof subjectModeId === "string" ? subjectModeId : "semantic",
      },
    };
    try {
      const templateReference = usesBuiltInTemplate && layoutTemplate.previewImage
        ? await readCoverReferenceAsDataUrl(layoutTemplate.previewImage, "模板参考图")
        : "";
      const referenceImageUrls = usesBuiltInTemplate
        ? [templateReference].filter(Boolean)
        : usesUploadedReference && hasReferenceMaterial
          ? [referenceImage]
          : [];
      const taskStorage = createTaskStorage();
      setResults((previous) => [task, ...previous.filter((item) => item.id !== task.id)]);
      setSelectedResultId(task.id);
      taskCounterRef.current = taskNo;
      const launched = runCoverGeneration({
        userId: currentUserId, token, task, storage: taskStorage,
        onState: (saved) => {
          applyTaskRunState(saved, task.id);
          if (!submissionAnnounced) {
            submissionAnnounced = true;
            setNotice(`任务${getTaskLabel(taskNo)}已提交；你可以继续调整参数并创建新任务`);
          }
          releaseSubmissionGate();
        },
        payload: activeModel ? {
          prompt: submissionPrompt,
          mode: "local",
          modelId: activeModel.id,
          style: `${coverModeId === "funny-cartoon" ? "卡通搞怪" : "卡通风格"} · ${usesBuiltInTemplate ? "参考模板" : usesUploadedReference ? "上传参考图" : "文案直出"} · ${animationStyle.name}`,
          aspectRatio: ratio,
          resolution: activeModel.resolution,
          coverText: "",
          referenceImageUrls,
          referenceUsage: "general",
          historySurface: "cover-studio",
        } : undefined,
      });
      handedOff = true;
      setNotice(`正在安全创建任务${getTaskLabel(taskNo)}…`);
      void launched.then((result) => {
        if (currentUserIdRef.current !== currentUserId) return;
        applyTaskRunState(result.state, task.id);
        setNotice(result.message);
        void loadBalance(token);
        void loadAccountHistory();
      }).catch((error) => {
        if (currentUserIdRef.current !== currentUserId) return;
        const message = error instanceof Error ? error.message : "封面任务提交失败";
        setResults((previous) => previous.map((item) => item.id === task.id
          ? { ...item, status: "failed", error: message }
          : item));
        setNotice(message);
        void loadAccountHistory();
      }).finally(releaseSubmissionGate);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "封面任务准备失败，请检查参考素材");
    } finally {
      if (!handedOff) releaseSubmissionGate();
    }
  }

  async function cancelCoverTask(task: CoverResult) {
    if (!task.clientIdempotencyKey || !task.clientTraceId || cancelTaskBusyId) return;
    const token = localStorage.getItem(TOKEN_KEY) || "";
    setCancelTaskBusyId(task.id);
    try {
      const response = await fetch("/api/cover/attempt", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", clientIdempotencyKey: task.clientIdempotencyKey, clientTraceId: task.clientTraceId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) throw new Error(data.error || "终止任务失败，请稍后重试");
      setResults((previous) => previous.map((item) => item.id === task.id
        ? { ...item, status: "cancelled", attemptState: "cancelled", cancellable: false, error: data.message || "任务已终止" }
        : item));
      setNotice(data.message || "任务已终止，编辑区可以继续创建新任务");
      void loadAccountHistory();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "终止任务失败，请稍后重试");
    } finally {
      setCancelTaskBusyId("");
    }
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (!loginName.trim() || !loginPassword) return setNotice("请输入账号和密码");
    setLoginBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginName, password: loginPassword }),
      });
      const data = await response.json() as { token?: string; error?: string };
      if (!response.ok || !data.token) throw new Error(data.error || "登录失败");
      localStorage.setItem(TOKEN_KEY, data.token);
      await checkAuth();
      setLoginOpen(false);
      setNotice("账号已连接，可以生成封面");
      void loadBalance(data.token);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoginBusy(false);
    }
  }

  async function downloadSelected() {
    if (!currentPreview?.url || downloadBusy) return;
    setDownloadBusy(true);
    try {
      const blob = await fetchCoverResultBlob(currentPreview, localStorage.getItem(TOKEN_KEY) || "");
      const objectUrl = URL.createObjectURL(blob);
      const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : coverDownloadExtension(currentPreview.url);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `cover-${currentPreview.ratio.replace(":", "x")}.${extension}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      setNotice("封面下载已开始");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "封面下载失败");
    } finally {
      setDownloadBusy(false);
    }
  }

  const currentPreview = selectedResultId ? results.find((item) => item.id === selectedResultId) ?? null : null;
  const latestPreviewResult = previewResult ? results.find((item) => item.id === previewResult.id) ?? null : null;
  const previewModeId: CoverModeId = currentPreview?.renderPlan?.coverModeId === "funny-cartoon"
    || (!currentPreview?.renderPlan?.coverModeId && currentPreview?.prompt?.includes("封面制作模式：卡通搞怪"))
    ? "funny-cartoon" : currentPreview?.renderPlan?.coverModeId ?? coverModeId;
  const previewSourceId: MaterialSourceId = currentPreview?.renderPlan?.materialSourceId
    ?? (currentPreview?.prompt?.includes("参考方式：上传参考图") ? "upload"
      : currentPreview?.prompt?.includes("参考方式：参考模板") ? "template" : materialSourceId);
  const previewRouteLabel = previewSourceId === "template" ? "参考模板"
    : previewSourceId === "upload" ? "上传参考图"
      : previewModeId === "funny-cartoon" ? "卡通搞怪" : "卡通风格";
  const currentAttemptState = currentPreview?.attemptState;
  const isCurrentPreviewProcessing = currentPreview?.status === "running"
    || (currentPreview?.status === "unknown" && ["claimed", "dispatched", "delivery_pending"].includes(currentAttemptState || ""));
  const currentRenderPhase = currentAttemptState === "delivery_pending" ? 3
    : currentAttemptState === "dispatched" ? 2 : 1;
  const currentRenderPhaseLabel = currentRenderPhase === 3 ? "排版与交付"
    : currentRenderPhase === 2 ? "模型生成中" : "任务已提交";
  const currentRenderPhaseDescription = currentRenderPhase === 3
    ? "底图已返回，平台正在完成文字排版与结果保存"
    : currentRenderPhase === 2
      ? "请求已发送至模型，正在等待真实生成结果"
      : "任务已安全创建，正在准备模型请求";
  const currentStatusLabel = currentAttemptState === "delivery_pending"
    ? "排版交付中"
    : currentAttemptState === "dispatched"
      ? "模型生成中"
      : currentAttemptState === "claimed"
        ? "任务已提交"
        : currentPreview?.status === "done"
    ? "已完成"
    : currentPreview?.status === "display_pending"
      ? "展示同步中"
      : currentPreview?.status === "unknown"
        ? "结果待确认"
        : currentPreview?.status === "cancelled"
          ? "已终止"
          : currentPreview?.status === "failed"
          ? "生成失败"
          : currentPreview?.status === "running" ? "生成中" : "等待提交";
  const selectedModeLabel = coverModeId === "funny-cartoon"
    ? "卡通搞怪"
    : "卡通风格";
  const groupedResults = useMemo(() => {
    const labels = ["进行中", "今天", "昨天", "前天"];
    const groups = new Map<string, CoverResult[]>();
    for (const item of results) {
      const label = item.status === "running" || item.status === "unknown"
        ? "进行中"
        : beijingHistoryDayLabel(item.createdAt);
      if (!label) continue;
      groups.set(label, [...(groups.get(label) || []), item]);
    }
    return labels.flatMap((label) => groups.has(label) ? [{ label, items: groups.get(label)! }] : []);
  }, [results]);
  async function removeCompletedHistory() {
    if (!currentUserId || historyClearing || generationBusy) return;
    setHistoryClearing(true); ++historyRequestRef.current;
    try {
      const response = await fetch("/api/cover/history", { method: "DELETE", headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ clearAll: true, confirmation: "REMOVE_COVER_HISTORY" }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) throw new Error(data.error || "封面历史移除未完成");
      clearCompletedCoverHistory(localStorage, currentUserId);
      cloudHistoryRef.current = cloudHistoryRef.current.filter((item) => item.status === "failed" && Boolean(item.failureRecordId));
      showGenerationState(mergeCoverAccountHistory(localStorage, currentUserId, cloudHistoryRef.current));
      setClearHistoryOpen(false); setHistoryError("");
      setNotice("已完成封面历史已移除，失败审计、成图文件和消费记录仍保留");
    } catch (error) { setHistoryError(error instanceof Error ? error.message : "封面历史移除未完成"); }
    finally { setHistoryClearing(false); setHistoryLoading(false); }
  }
  return (
    <div className="cover-rebuild-shell">
      <header className="cover-rebuild-topbar">
        <div className="cover-rebuild-nav">
          <Link className="cover-rebuild-back" href="/" title="返回主页">
            <Home size={15} />
            <span>返回主页</span>
          </Link>
        </div>
        <div className="cover-rebuild-brand" aria-label="封面制作"><strong>封面制作</strong></div>
        <div className="cover-rebuild-actions">
          <UserThemeSwitcher />
        </div>
      </header>

      <main className={`cover-rebuild-workspace${isReferenceCreation ? " has-reference-dock" : ""}`}>
        <section className="cover-setup-deck" aria-label="封面生成参数">
          <div className="cover-setup-grid">
          <section className="cover-card cover-model-card cover-setup-card">
            <div className="cover-card-title">
              <WandSparkles size={18} />
              <div><strong>生图模型</strong><span>选择本次封面的图像引擎</span></div>
            </div>
            {flagshipModels.length > 0 && (
              <div className="cover-flagship-models" aria-label="旗舰封面模型">
                {flagshipModels.map(({ flagship, model }) => (
                  <button
                    key={model.id}
                    className={model.id === modelId ? "is-active" : ""}
                    type="button"
                    disabled={!model.available}
                    onClick={() => setModelId(model.id)}
                    title={model.available ? `${flagship.label} · ${flagship.role}` : model.availabilityMessage || "当前未开放"}
                  >
                    <span><strong>{flagship.shortLabel}</strong><em>{flagship.role}</em></span>
                    <small>{model.supportsReferenceInput ? "支持参考图" : "文本生图"}{model.available ? " · 可生成" : ` · ${model.availabilityMessage || "当前未开放"}`}</small>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="cover-card cover-mode-card cover-setup-card">
            <div className="cover-card-title">
              <Sparkles size={18} />
              <div><strong>画面风格</strong><span>确定视觉气质与情绪强度</span></div>
            </div>
            <div className="cover-mode-switch">
              <button className={coverModeId === "cartoon" ? "is-active" : ""} type="button" onClick={() => selectCoverMode("cartoon")}>
                <strong>卡通风格</strong><small>温暖、有质感</small>
              </button>
              <button className={coverModeId === "funny-cartoon" ? "is-active" : ""} type="button" onClick={() => selectCoverMode("funny-cartoon")}>
                <strong>卡通搞怪</strong><small>夸张、有反差</small>
              </button>
            </div>
            <label className="cover-output-field cover-quality-select-field">
              <span>画面质感（可选）</span>
              <span className="cover-select-shell">
                <Palette size={14} />
                <select value={animationStyleId} onChange={(event) => changeAnimationStyle(event.target.value as AnimationStyleId)}>
                  {activeStyleOptions.map((item) => <option key={item.id} value={item.id}>{item.name}｜{item.badge}</option>)}
                </select>
                <ChevronDown size={15} />
              </span>
            </label>
          </section>

          <section className="cover-card cover-source-card cover-setup-card">
            <div className="cover-card-title">
              <ImagePlus size={18} />
              <div><strong>创作依据</strong><span>决定画面从哪里获得视觉线索</span></div>
            </div>
            <div className="cover-source-options" role="group" aria-label="创作依据">
              <button className={materialSourceId === "text" ? "is-active" : ""} type="button" onClick={() => selectMaterialSource("text")}>
                <strong>文案直出</strong><small>无需参考图</small>
              </button>
              <button className={usesBuiltInTemplate ? "is-active" : ""} type="button" onClick={() => selectMaterialSource("template")}>
                <strong>参考模板</strong><small>学习版式</small>
              </button>
              <button className={usesUploadedReference ? "is-active" : ""} type="button" onClick={() => selectMaterialSource("upload")}>
                <strong>上传参考图</strong><small>保留主体</small>
              </button>
            </div>
            <p className="cover-source-note">三种依据严格单选，提交时只发送当前选中的参考内容。</p>
          </section>

          <section className="cover-card cover-ratio-card cover-setup-card">
            <div className="cover-card-title">
              <ImagePlus size={18} />
              <div><strong>封面尺寸</strong><span>所选比例会直接用于拆解与生成</span></div>
            </div>
            <div className="cover-segmented cover-ratio-picker" aria-label="封面比例">
              {RATIO_OPTIONS.map((item) => (
                <button key={item} className={ratio === item ? "is-active" : ""} type="button" onClick={() => setRatio(item)}>{item}<span>{getSizePreset(item).label}</span></button>
              ))}
            </div>
            <div className="cover-selected-parameter">
              <span>{selectedModeLabel} · {usesBuiltInTemplate ? layoutTemplate.name : usesUploadedReference ? "上传参考图" : "文案直出"}</span>
              <strong>{ratio} · {activeModel?.name || "请选择模型"}</strong>
            </div>
          </section>
          </div>
          <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handleUpload} />
        </section>

        {usesBuiltInTemplate && (
          <section className="cover-reference-dock" aria-label="当前参考模板">
            <span className="cover-reference-dock-kicker">当前参考</span>
            <span className="cover-reference-dock-preview"><img src={layoutTemplate.previewImage} alt={`${layoutTemplate.name}模板预览`} /></span>
            <div>
              <strong>{layoutTemplate.name}</strong>
              <span>{layoutTemplate.layoutHint}</span>
            </div>
            <small>只学习版式、色块、留白与信息层级，不复制原人物或原文案。</small>
            <button type="button" onClick={openTemplateLibrary}>浏览模板库</button>
          </section>
        )}

        {usesUploadedReference && (
          <section className="cover-reference-dock is-upload" aria-label="上传参考图">
            <span className="cover-reference-dock-kicker">当前参考</span>
            {referenceImage
              ? <span className="cover-reference-dock-preview"><img src={referenceImage} alt="已上传参考图预览" /></span>
              : <span className="cover-reference-dock-empty"><Upload size={20} /></span>}
            <div>
              <strong>{referenceImage ? referenceImageName || "已上传参考图" : "上传一张参考图"}</strong>
              <span>PNG / JPEG / WebP，文件不超过 5MB</span>
            </div>
            <label className="cover-reference-purpose">
              <span>参考用途</span>
              <select aria-label="参考图用途" value={subjectModeId} onChange={(event) => changeSubjectMode(event.target.value as SubjectModeId)}>
                <option value="semantic">人物 / 宠物 / 场景</option>
                <option value="product">产品图</option>
              </select>
            </label>
            <button type="button" onClick={chooseUploadReference}>{referenceImage ? "更换图片" : "选择图片"}</button>
            {referenceImage && <button className="is-quiet" type="button" onClick={clearReferenceMaterial}>移除</button>}
          </section>
        )}

        <aside className="cover-director-panel">
          <section className="cover-card cover-brief-card cover-priority-card">
            <div className="cover-card-title">
              <ImagePlus size={18} />
              <div><strong>输入文案</strong><span>粘贴完整选题或口播稿</span></div>
            </div>
            <textarea aria-label="输入文案" value={briefText} onChange={(event) => setBriefText(event.target.value)} placeholder="把视频文案、选题、口播稿贴在这里" />
            <button className="cover-secondary-button cover-analyze-button" type="button" disabled={!briefText.trim()} onClick={analyzeBrief}>
              <Sparkles size={16} />拆解文案
            </button>
            <div className={`cover-decomposition-editor ${prompt && !planNeedsRebuild ? "is-ready" : ""}`}>
              <div className="cover-decomposition-heading">
                <strong>拆解结果</strong>
                <em>{!briefText.trim() ? "等待文案" : planNeedsRebuild ? "需要重新拆解" : "已就绪"}</em>
              </div>
              <textarea className="cover-copy-result-editor" aria-label="拆解结果" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="点击“拆解文案”后，这里会自动生成 1–3 行封面文案；你可以直接修改" />
              <div className="cover-decomposition-tools">
                <button className={auxiliaryCopyOpen ? "is-open" : ""} type="button" aria-expanded={auxiliaryCopyOpen} onClick={() => setAuxiliaryCopyOpen((open) => !open)}>
                  辅助短句（可选）{subtitle ? " · 已生成" : ""}<ChevronDown size={14} />
                </button>
                <button className={promptAdvancedOpen ? "is-open" : ""} type="button" aria-expanded={promptAdvancedOpen} onClick={() => setPromptAdvancedOpen((open) => !open)}>
                  画面描述（高级）<ChevronDown size={14} />
                </button>
              </div>
              {auxiliaryCopyOpen && (
                <label className="cover-optional-copy-editor"><span>辅助短句</span><input value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder="用于角标或底部补充，也可以留空" /></label>
              )}
              {promptAdvancedOpen && (
                <label className="cover-prompt-editor"><span>画面描述（高级）</span><textarea aria-label="拆解后的画面描述" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="系统会自动生成；仅在需要精细控制主体、构图或留白时修改" /></label>
              )}
            </div>
            <button className="cover-primary-button cover-generate-submit" type="button" disabled={generationBusy || planNeedsRebuild || !briefText.trim() || !title.trim() || !prompt.trim() || !activeModel?.available || !activeModel.priceReady || (usesUploadedReference && !referenceImage) || ((usesBuiltInTemplate || usesUploadedReference) && !activeModel.supportsReferenceInput)} onClick={() => void generateImage()}>
              <WandSparkles size={17} />{generationBusy ? "正在创建任务" : "生成封面"}
            </button>
            <div className="cover-cost-line">
              <span>预计消耗</span><strong>{activeModel?.available && activeModel.priceReady && activeModel.price != null ? `¥${activeModel.price.toFixed(2)}` : "价格待确认"}</strong><span>{balance === null ? "" : `余额 ¥${balance.toFixed(2)}`}</span>
            </div>
          </section>
        </aside>

        <section className={`cover-rebuild-stage cover-stage-mode-${previewModeId} cover-stage-source-${previewSourceId}`}>
          <div className="cover-stage-toolbar cover-result-header">
            <div className="cover-result-toolbar-title">
              <strong>生成结果</strong>
              <span className={`is-${currentPreview?.status || "idle"}`}>{currentStatusLabel}</span>
              <em>{previewRouteLabel}</em>
            </div>
            <div className="cover-result-actions">
              {currentPreview?.cancellable && (
                <button className="is-danger" type="button" disabled={cancelTaskBusyId === currentPreview.id} onClick={() => void cancelCoverTask(currentPreview)}>
                  <X size={15} />{cancelTaskBusyId === currentPreview.id ? "正在终止" : "终止任务"}
                </button>
              )}
              <button type="button" onClick={() => setHistoryPanelOpen(true)}><History size={15} />历史记录{results.length ? ` ${results.length}` : ""}</button>
              <button type="button" disabled={!currentPreview?.url || downloadBusy} onClick={() => void downloadSelected()}><Download size={15} />{downloadBusy ? "准备中" : "下载"}</button>
            </div>
          </div>

          {historyPanelOpen && (
            <div className="cover-history-backdrop" role="presentation" onClick={() => setHistoryPanelOpen(false)}>
              <aside className="cover-history-drawer" role="dialog" aria-modal="true" aria-label="封面历史记录" onClick={(event) => event.stopPropagation()}>
                <header>
                  <div><strong>历史记录</strong><span>查看任务、复用参数或处理失败记录</span></div>
                  <button type="button" aria-label="关闭历史记录" onClick={() => setHistoryPanelOpen(false)}><X size={18} /></button>
                </header>
                <div className="cover-task-strip" aria-label="生成任务状态">
                  {groupedResults.length ? groupedResults.map((group) => (
                    <div className="cover-task-day-group" key={group.label}>
                      <span className="cover-task-day-label">{group.label}</span>
                      {group.items.map((item) => (
                        <button
                          key={item.id}
                          className={`${item.id === currentPreview?.id ? "is-active" : ""} is-${item.status}`}
                          type="button"
                          onClick={() => setSelectedResultId(item.id)}
                        >
                          <strong>{item.failureRecordId ? "失败记录" : "任务" + getTaskLabel(item.taskNo)}</strong>
                          <span>{item.status === "running" ? "生成中" : item.status === "unknown" ? "待确认" : item.status === "display_pending" ? "展示同步中" : item.status === "cancelled" ? "已终止" : item.status === "failed" ? "失败" : "完成"}</span>
                        </button>
                      ))}
                    </div>
                  )) : <span className="cover-task-empty">尚未提交任务</span>}
                </div>
                <div className="cover-history-actions">
                  <button type="button" disabled={historyLoading || historyClearing || !currentUserId} onClick={() => void loadAccountHistory()}>{historyLoading ? "同步中…" : "刷新历史"}</button>
                  {historyNextPage && <button type="button" disabled={historyLoading || historyClearing} onClick={() => void loadAccountHistory(historyNextPage)}>加载更多</button>}
                  <button type="button" disabled={!selectedHistoryTask?.renderPlan || generationBusy} onClick={loadSelectedHistoryParameters}>复用参数</button>
                  {selectedHistoryTask?.cancellable && <button className="is-danger" type="button" disabled={Boolean(cancelTaskBusyId)} onClick={() => void cancelCoverTask(selectedHistoryTask)}>{cancelTaskBusyId === selectedHistoryTask.id ? "正在终止" : "终止任务"}</button>}
                  <button type="button" disabled={generationBusy || historyClearing || !results.some((item) => item.status === "done" && item.cloudStored)} onClick={() => setClearHistoryOpen(true)}>移除已完成</button>
                </div>
                {historyError && <p role="alert" className="cover-history-message is-error">{historyError}</p>}
                {failureHistoryNotice && <p role="status" className="cover-history-message is-warning">{failureHistoryNotice}</p>}
                {selectedHistoryTask?.failureRecordId && (
                  <section className="cover-history-failure">
                    <div><strong>失败记录 · {new Date(selectedHistoryTask.createdAt).toLocaleString("zh-CN", { hour12: false })}</strong><span>{selectedHistoryTask.modelName} · {selectedHistoryTask.ratio}</span></div>
                    <p>{selectedHistoryTask.error}</p>
                    <small>原报价 ¥{Number(selectedHistoryTask.quotedPriceYuan || 0).toFixed(2)} · {selectedHistoryTask.billing?.state === "not_charged" ? "明确未扣费" : selectedHistoryTask.billing?.state === "exempt" ? "未扣费" : selectedHistoryTask.billing?.state === "charged" ? "存在已扣费记录" : "账务待确认"}</small>
                    {selectedHistoryTask.requiresReferenceReupload && <small>原参考图需重新上传。</small>}
                    {selectedHistoryTask.retryBlockReason && <small>{selectedHistoryTask.retryBlockReason}</small>}
                    <div>
                      <button type="button" disabled={failureActionBusy || !selectedHistoryTask.canLoadForRetry || generationBusy} onClick={() => void loadFailureForRetry(selectedHistoryTask)}>{failureActionBusy ? "核对中…" : "载入参数"}</button>
                      <button type="button" disabled={failureActionBusy} onClick={() => void hideFailureHistory(selectedHistoryTask)}>隐藏记录</button>
                    </div>
                  </section>
                )}
                {clearHistoryOpen && <section role="alertdialog" aria-label="移除封面历史" className="cover-history-confirm">
                  <p>移除当前账号的已完成记录。成图文件和消费记录仍保留。</p>
                  <div><button type="button" disabled={historyClearing} onClick={() => setClearHistoryOpen(false)}>取消</button><button type="button" disabled={historyClearing} onClick={() => void removeCompletedHistory()}>{historyClearing ? "正在移除…" : "确认移除"}</button></div>
                </section>}
              </aside>
            </div>
          )}

          <div className="cover-result-stage cover-single-stage">
            <div className={`cover-main-preview is-ratio-${(currentPreview?.ratio ?? ratio).replace(":", "x")}${isCurrentPreviewProcessing ? " is-running" : ""}${currentPreview?.status === "failed" ? " is-failed" : ""}${!currentPreview ? " is-idle" : ""}`}>
              {currentPreview?.url ? (
                <button className="cover-result-image-button" type="button" aria-label="放大查看封面" onClick={() => setPreviewResult(currentPreview)}>
                  <img src={currentPreview.url} alt={`任务${getTaskLabel(currentPreview.taskNo)}封面结果`} onError={() => handleResultImageError(currentPreview.id)} />
                </button>
              ) : isCurrentPreviewProcessing ? (
                <div className="cover-rendering-state" aria-live="polite">
                  <div className="cover-rendering-card">
                    <span className="cover-rendering-icon" aria-hidden="true">
                      <ImagePlus size={24} />
                    </span>
                    <strong>任务{getTaskLabel(currentPreview.taskNo)}正在生成</strong>
                    <span>{currentRenderPhaseDescription}</span>
                    <div
                      className={`cover-rendering-progress is-phase-${currentRenderPhase}`}
                      role="progressbar"
                      aria-label="封面生成阶段"
                      aria-valuemin={1}
                      aria-valuemax={3}
                      aria-valuenow={currentRenderPhase}
                      aria-valuetext={`${currentRenderPhaseLabel}，第 ${currentRenderPhase} 阶段，共 3 阶段`}
                    >
                      <i aria-hidden="true" />
                    </div>
                    <ol className="cover-rendering-steps" aria-label="生成进度">
                      {["任务已提交", "模型生成中", "排版与交付"].map((label, index) => {
                        const step = index + 1;
                        return <li key={label} className={step === currentRenderPhase ? "is-active" : step < currentRenderPhase ? "is-done" : ""}><b>{step}</b><span>{label}</span></li>;
                      })}
                    </ol>
                    <small>{currentPreview.ratio} · {getSizePreset(currentPreview.ratio).label} · 可在历史记录中继续查看</small>
                  </div>
                </div>
              ) : currentPreview?.status === "display_pending" ? (
                <div className="cover-main-state" aria-live="polite">
                  <RefreshCw size={34} />
                  <strong>图片已保存，正在同步展示</strong>
                  <span>{currentPreview.error || "系统会自动重新获取安全展示地址"}</span>
                </div>
              ) : currentPreview?.status === "failed" || currentPreview?.status === "unknown" || currentPreview?.status === "cancelled" ? (
                <div className="cover-main-state">
                  <X size={34} />
                  <strong>{currentPreview.failureRecordId ? "失败记录" : "任务" + getTaskLabel(currentPreview.taskNo)}{currentPreview.status === "unknown" ? "结果待确认" : currentPreview.status === "cancelled" ? "已终止" : "生成失败"}</strong>
                  <span>{currentPreview.error || "请调整参数后重新提交"}</span>
                </div>
              ) : (
                <div className="cover-main-state cover-empty-state">
                  <span className="cover-empty-icon" aria-hidden="true"><ImagePlus size={36} /></span>
                  <strong>还没有生成封面</strong>
                  <span>在左侧输入文案、完成拆解并确认封面文字后，即可在这里查看结果。</span>
                </div>
              )}
              <div className="cover-main-meta">
                <strong>{currentPreview ? (currentPreview.failureRecordId ? "失败记录" : "任务" + getTaskLabel(currentPreview.taskNo)) + " · " + currentPreview.title.replace(/\n/g, " ") : title.replace(/\n/g, " ")}</strong>
                <span>{currentPreview ? `${currentPreview.ratio} / ${Number.isNaN(Date.parse(currentPreview.createdAt)) ? currentPreview.createdAt : new Date(currentPreview.createdAt).toLocaleString("zh-CN", { hour12: false })}${currentPreview.outputWidth ? ` / 成品 ${currentPreview.outputWidth}×${currentPreview.outputHeight}` : ""}` : `${ratio} / ${getSizePreset(ratio).label}`}</span>
              </div>
            </div>
          </div>

        </section>
      </main>

      {notice && <div className="cover-toast">{notice}</div>}

      {latestPreviewResult && (
        <div className="cover-preview-backdrop" role="presentation" onClick={() => setPreviewResult(null)}>
          <div ref={previewDialogRef} className="cover-preview-dialog" role="dialog" aria-modal="true" aria-label="封面大图预览" onClick={(event) => event.stopPropagation()}>
            <button className="cover-dialog-close" type="button" title="关闭" aria-label="关闭封面大图预览" onClick={() => setPreviewResult(null)}><X size={18} /></button>
            <div className="cover-preview-image-wrap">
              {latestPreviewResult.url
                ? <img src={latestPreviewResult.url} alt="封面预览" onError={() => handleResultImageError(latestPreviewResult.id)} />
                : <div className="cover-main-state" role="status"><RefreshCw size={34} /><strong>大图展示地址正在续签</strong><span>{latestPreviewResult.error || "请稍后再试，原文件与历史记录不会丢失"}</span></div>}
            </div>
            <div className="cover-preview-meta">
              <strong>{latestPreviewResult.title.replace(/\n/g, " ")}</strong>
              <span>{latestPreviewResult.ratio} / {latestPreviewResult.source} / {latestPreviewResult.createdAt}</span>
            </div>
          </div>
        </div>
      )}

      {templateLibraryOpen && (
        <div className="cover-modal-backdrop cover-template-library-backdrop" role="presentation" onClick={() => setTemplateLibraryOpen(false)}>
          <section className="cover-template-library-dialog" role="dialog" aria-modal="true" aria-label="选择模板版式" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>选择模板版式</strong>
                <span>模板只提供版式与视觉关系，标题和主体由当前文案自动替换</span>
              </div>
              <button className="cover-dialog-close" type="button" aria-label="关闭模板选择" onClick={() => setTemplateLibraryOpen(false)}><X size={18} /></button>
            </header>
            <div className="cover-template-library-toolbar">
              <label className="cover-template-search">
                <span className="sr-only">搜索模板</span>
                <input value={templateSearch} onChange={(event) => setTemplateSearch(event.target.value)} placeholder="搜索模板名称或版式" />
              </label>
              <div className="cover-template-view-tabs" role="tablist" aria-label="模板视图">
                <button className={templateViewId === "all" ? "is-active" : ""} type="button" role="tab" aria-selected={templateViewId === "all"} onClick={() => setTemplateViewId("all")}>全部模板</button>
                <button className={templateViewId === "favorites" ? "is-active" : ""} type="button" role="tab" aria-selected={templateViewId === "favorites"} onClick={() => setTemplateViewId("favorites")}>我的收藏</button>
              </div>
              <span>{visibleLayoutTemplates.length} 个版式 · 当前 {layoutTemplate.name}</span>
            </div>
            {visibleLayoutTemplates.length ? (
              <div className="cover-template-library-grid" role="list" aria-label={templateViewId === "favorites" ? "收藏模板" : "全部模板"}>
                {visibleLayoutTemplates.map((item) => {
                  const isFavorite = favoriteTemplateIds.includes(item.id);
                  return (
                    <div key={item.id} className="cover-template-library-item">
                      <button
                        className={`cover-template-library-option${item.id === layoutTemplateId ? " is-active" : ""}`}
                        type="button"
                        aria-label={`放大预览${item.name}`}
                        onClick={() => setTemplatePreview(item)}
                      >
                        <img src={item.previewImage} alt={`${item.name}参考封面`} loading="lazy" />
                        <em className="cover-template-preview-badge">点击预览</em>
                        <span><strong>{item.name}</strong><small>{item.layoutHint}</small></span>
                        {item.id === layoutTemplateId && <Check size={15} />}
                      </button>
                      <button
                        type="button"
                        className={`cover-template-favorite-toggle${isFavorite ? " is-active" : ""}`}
                        aria-label={isFavorite ? `取消收藏${item.name}` : `收藏${item.name}`}
                        aria-pressed={isFavorite}
                        onClick={() => toggleFavoriteTemplate(item.id)}
                      ><Star size={14} /></button>
                    </div>
                  );
                })}
              </div>
            ) : <div className="cover-template-favorites-empty">{templateSearch ? "没有匹配的模板，请换一个关键词" : "暂无收藏模板，可在全部模板中点星标收藏"}</div>}
          </section>
        </div>
      )}

      {templatePreview && (
        <div className="cover-modal-backdrop cover-template-preview-backdrop" role="presentation" onClick={() => setTemplatePreview(null)}>
          <section className="cover-template-preview-dialog" role="dialog" aria-modal="true" aria-label={`${templatePreview.name}大图预览`} onClick={(event) => event.stopPropagation()}>
            <button className="cover-dialog-close" type="button" autoFocus aria-label="关闭模板大图预览" onClick={() => setTemplatePreview(null)}><X size={18} /></button>
            <div className="cover-template-preview-image">
              <img src={templatePreview.previewImage} alt={`${templatePreview.name}模板大图`} />
            </div>
            <div className="cover-template-preview-copy">
              <span>模板版式预览</span>
              <h2>{templatePreview.name}</h2>
              <p>{templatePreview.layoutHint}</p>
              <small>只学习文字层级、留白与视觉关系；生成时会替换为当前文案和主体。</small>
              <button type="button" onClick={() => { setTemplatePreview(null); selectLayoutTemplate(templatePreview.id); }}>
                <Check size={16} /> 使用此模板
              </button>
            </div>
          </section>
        </div>
      )}

      {loginOpen && (
        <div className="cover-modal-backdrop" role="presentation">
          <form className="cover-login-dialog" onSubmit={handleLogin}>
            <button className="cover-dialog-close" type="button" title="关闭" onClick={() => setLoginOpen(false)}><X size={18} /></button>
            <div className="cover-dialog-icon"><LogIn size={21} /></div>
            <h2>连接主站账号</h2>
            <label className="cover-output-field"><span>账号</span><input autoFocus value={loginName} onChange={(event) => setLoginName(event.target.value)} autoComplete="username" /></label>
            <label className="cover-output-field"><span>密码</span><input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoComplete="current-password" /></label>
            <button className="cover-primary-button" type="submit" disabled={loginBusy}>{loginBusy ? "连接中" : "连接并继续"}</button>
          </form>
        </div>
      )}
    </div>
  );
}
