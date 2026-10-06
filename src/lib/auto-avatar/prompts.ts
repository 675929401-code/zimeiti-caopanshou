/**
 * 自动头像 — 提示词工程模块
 *
 * 职责：根据智能体名称 + 描述，构建主站统一的 3D 卡通职业人物头像提示词。
 * 纯函数，无副作用，无外部依赖，便于独立测试。
 *
 * 固定风格（用户指定）：
 *   精致 3D 卡通人物为主体，
 *   明亮柔和的多色背景，圆润材质与友好表情，
 *   根据智能体描述适配职业动作和实体道具，
 *   绝对禁止文字
 */

// ── 固定风格前缀 ──
const STYLE_PREFIX =
  "Premium stylized 3D cartoon avatar matching a cohesive Chinese AI agent marketplace, " +
  "one friendly adult Chinese professional as the clear focal point, half-body portrait, " +
  "slightly chibi proportions, softly rounded facial features, large expressive eyes, neat modern hairstyle, " +
  "polished animation-film rendering with smooth clay-like materials and subtle realistic fabric texture, " +
  "bright soft studio lighting, warm approachable expression, colorful pastel background with two or three balanced hues, " +
  "one or two clear profession-related physical props held naturally, uncluttered composition";

// ── 固定质量后缀 ──
const QUALITY_SUFFIX =
  "square 1:1, 1024x1024 avatar composition, character centered with head and hands fully inside safe margins, " +
  "clear silhouette readable at 128px, high detail, clean edges, no border, no logo, no watermark, " +
  "no photorealism, no cyberpunk, no dark neon scene, no horror, no dramatic movie lighting, no floating UI screens, " +
  "ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS, NO NUMBERS";

/**
 * 根据智能体名称和描述构建主站 3D 卡通头像提示词
 */
export function buildAvatarPrompt(name: string, description: string): string {
  const parts: string[] = [STYLE_PREFIX];

  // 名称 → 人物角色定位
  if (name?.trim()) {
    parts.push(`visually representing the professional function of ${name.trim()}, without rendering the name as text`);
  }

  // 描述 → 场景适配 + 科技道具
  // The name often carries the most precise job keyword; combine it with the
  // description so specialist agents do not collapse into the same generic role.
  const semanticText = [name, description].filter(Boolean).join(" ");
  const { scene, props } = extractSceneFromDescription(semanticText);
  if (scene) {
    parts.push(`scene: ${scene}`);
  }
  if (props) {
    parts.push(`physical props: ${props}`);
  }

  parts.push(QUALITY_SUFFIX);

  return parts.join(". ") + ".";
}

/**
 * 从描述中提取场景和科技道具
 * 参照 DESIGN.md 角色描述映射规则
 */
function extractSceneFromDescription(description: string): { scene: string; props: string } {
  if (!description?.trim()) return { scene: "bright modern creative studio with a soft multicolor backdrop", props: "a notebook and a small idea token" };

  const text = description.trim();

  // 关键词 → (场景, 科技道具) 映射
  const SCENE_MAP: Array<{ keywords: string[]; scene: string; props: string }> = [
    { keywords: ["对标账号拆解", "账号拆解"], scene: "bright creator research studio with teal, coral and warm yellow accents", props: "a magnifying glass, several blank creator profile cards and a small camera" },
    { keywords: ["课程架构优化", "课程架构", "课程纠错"], scene: "bright education design studio with coral, blue and warm yellow accents", props: "an ascending stack of blank lesson cards, an open workbook and a sorting token" },
    { keywords: ["网站功能推广", "网站推广"], scene: "bright digital product presentation studio with mint, coral and soft blue accents", props: "a miniature website storefront, blank feature cards and a small megaphone" },
    { keywords: ["智能体命名包装", "智能体命名", "命名包装"], scene: "bright naming and branding studio with lavender, coral and warm yellow accents", props: "several blank name tags, a small robot figurine and color swatches" },
    { keywords: ["总分总文案", "总分总"], scene: "bright structured writing studio with coral, teal and warm yellow accents", props: "three stacked blank idea cards leading to one summary card and a writing pen" },
    { keywords: ["观点冲突文案", "观点冲突"], scene: "bright editorial debate studio with coral, blue and soft green accents", props: "two contrasting blank opinion cards, a small microphone and a balance token" },
    { keywords: ["故事反转文案", "故事反转"], scene: "warm story writing studio with coral, lavender and golden accents", props: "an open blank storybook, a curved turning-arrow token and a writing pen" },
    { keywords: ["场景共鸣文案", "场景共鸣"], scene: "warm everyday-life storytelling studio with peach, mint and soft blue accents", props: "a miniature daily-life scene, a heart-shaped token and blank speech cards" },
    { keywords: ["清单干货文案", "清单干货"], scene: "bright practical knowledge desk with mint, coral and warm yellow accents", props: "a blank checklist clipboard, practical tool tokens and a writing pen" },
    { keywords: ["营销日历", "内容日历"], scene: "bright content planning studio with mint, coral and warm yellow accents", props: "a blank monthly calendar board and several colorful timeline cards" },
    { keywords: ["营销活动", "活动策划"], scene: "cheerful campaign planning studio with coral, blue and golden accents", props: "a small megaphone, blank event cards and a milestone flag without text" },
    { keywords: ["成交异议", "异议化解"], scene: "friendly customer decision studio with sage, coral and soft blue accents", props: "blank question cards, a small shield and a magnifying glass" },
    { keywords: ["私域承接", "线索承接"], scene: "bright customer journey studio with mint, orange and soft blue accents", props: "connected blank contact cards, a small funnel model and a handshake token" },
    { keywords: ["营销AB", "AB测试", "营销实验"], scene: "bright experiment studio with coral, teal and lavender accents", props: "two contrasting blank test cards, colored test tokens and a small measuring gauge" },
    { keywords: ["经营复盘", "营销复盘"], scene: "bright business review desk with blue, coral and warm yellow accents", props: "a blank performance report, chart blocks and a magnifying glass" },
    { keywords: ["资产盘点", "IP资产"], scene: "bright organized strategy studio with mint, coral and warm yellow accents", props: "a tidy case folder, skill tokens and a small open toolbox" },
    { keywords: ["对标差异化", "差异化拆解"], scene: "bright comparison studio with teal, coral and lavender accents", props: "two blank comparison boards, a magnifying glass and a compass" },
    { keywords: ["账号门面", "主页设计"], scene: "polished creator branding studio with coral, mint and soft blue accents", props: "a blank profile card, color swatches and three blank pinned-video cards" },
    { keywords: ["信任证据", "证据体系"], scene: "bright credibility workshop with sage, coral and golden accents", props: "an organized evidence folder, a magnifying glass and a verification seal without text" },
    { keywords: ["产品阶梯", "商业阶梯"], scene: "bright product strategy studio with blue, coral and warm yellow accents", props: "three ascending display blocks and small blank product boxes" },
    { keywords: ["定位验证", "验证实验"], scene: "bright testing studio with mint, orange and soft blue accents", props: "several blank experiment cards, indicator tokens and a small compass" },
    { keywords: ["餐饮", "火锅", "烧烤", "餐厅", "美食"], scene: "bright modern restaurant kitchen with coral, teal and warm amber accents", props: "a small steaming hot-pot bowl and a serving ladle" },
    { keywords: ["服装", "鞋包", "穿搭", "女装", "男装"], scene: "stylish bright clothing boutique with coral, mint and soft blue accents", props: "fabric swatches and a miniature clothing rack" },
    { keywords: ["建材", "装修", "瓷砖", "门窗", "盖瓦", "家居"], scene: "clean home-improvement showroom with teal, warm yellow and brick-red accents", props: "a tile sample, a measuring tape and a small house model" },
    { keywords: ["小店", "零售", "便利店", "商超", "小卖部"], scene: "friendly neighborhood shop with mint, coral and warm yellow accents", props: "a small shopping basket and neatly arranged product boxes without labels" },
    { keywords: ["美业", "美发", "美甲", "美容", "造型"], scene: "bright elegant beauty salon with peach, mint and lavender accents", props: "professional scissors and a compact color swatch fan" },
    { keywords: ["汽车", "洗车", "修车", "汽修", "养车"], scene: "clean cheerful auto service studio with blue, orange and mint accents", props: "a small car model and a professional wrench" },
    { keywords: ["家政", "保洁", "维修", "安装", "接单"], scene: "bright tidy home-service workspace with blue, coral and green accents", props: "a compact toolbox and a clean spray bottle without a label" },
    { keywords: ["教培", "亲子", "招生", "课程", "培训"], scene: "welcoming modern classroom with blue, yellow and coral accents", props: "an open blank workbook and colorful learning cards" },
    { keywords: ["酒店", "民宿", "文旅", "住宿", "客房"], scene: "warm boutique hotel reception with teal, coral and golden accents", props: "a blank key card and a miniature guest-room model" },
    { keywords: ["宠物", "兽医", "洗护", "养宠"], scene: "bright friendly pet-care studio with mint, coral and warm yellow accents", props: "a pet grooming brush and a paw-shaped token" },
    { keywords: ["猎手", "品控", "质检", "审核", "证据"], scene: "bright editorial desk with a sage and coral backdrop", props: "a clipboard with check marks and a magnifying glass" },
    { keywords: ["炼金", "升维", "优化", "提升"], scene: "cheerful creative workshop with gold and teal accents", props: "a polishing tool and a glowing idea gem" },
    { keywords: ["军师", "策划", "战略", "规划", "定位"], scene: "bright planning studio with teal, coral and warm yellow backdrop", props: "a compass and several blank profile cards" },
    { keywords: ["引擎", "成交", "转化", "销售", "投流", "千川"], scene: "clean marketing studio with blue, coral and warm yellow backdrop", props: "a small megaphone and rising chart tokens without text" },
    { keywords: ["架构", "铸造", "搭建", "构建"], scene: "bright maker studio with green and amber accents", props: "colorful building blocks and a small framework model" },
    { keywords: ["锻造", "爆款", "创作", "创意"], scene: "cheerful idea studio with coral and golden accents", props: "a lightbulb token and a creator notebook" },
    { keywords: ["解码", "画像", "分析", "数据"], scene: "bright research desk with mint, lilac and coral backdrop", props: "a magnifying glass and simple audience figurines" },
    { keywords: ["霸屏", "流量", "推广", "营销", "带货", "植入"], scene: "friendly content studio with coral, teal and warm yellow backdrop", props: "a small product box and an open story notebook" },
    { keywords: ["导演", "影像", "视频", "拍摄"], scene: "colorful film studio with warm soft lighting", props: "a compact movie camera and a clapperboard with no writing" },
    { keywords: ["速构", "生成", "制作", "工厂"], scene: "bright production workshop with mint and orange accents", props: "a small 3D model and assembly blocks" },
    { keywords: ["领航", "导师", "指导", "教练"], scene: "welcoming learning studio with blue and yellow accents", props: "a compass and a milestone flag with no text" },
    { keywords: ["文档", "说明书", "手册", "教程"], scene: "cozy modern library with green and peach accents", props: "an open blank book and organized index cards" },
    { keywords: ["品牌", "形象", "设计", "视觉"], scene: "bright design studio with coral, teal and yellow accents", props: "color swatches and blank packaging mockups" },
    { keywords: ["起盘", "开店", "电商", "店铺"], scene: "friendly miniature storefront with warm yellow and teal accents", props: "a tiny shop model and a planning notebook" },
    { keywords: ["星盘", "命理", "占卜", "运势"], scene: "soft whimsical observatory with violet and golden accents", props: "a star map disc and a small telescope" },
    { keywords: ["文案", "写作", "撰写", "文字"], scene: "cozy writer studio with coral and blue accents", props: "a pen and an open blank notebook" },
    { keywords: ["客服", "问答", "咨询", "对话"], scene: "friendly communication desk with mint and yellow accents", props: "a headset and blank speech tokens" },
    { keywords: ["翻译", "语言", "多语"], scene: "bright language studio with blue and coral accents", props: "two blank speech cards and a small globe" },
    { keywords: ["编程", "代码", "开发", "程序"], scene: "cheerful maker desk with teal and purple accents", props: "a small robot and colorful logic blocks" },
    { keywords: ["绘画", "画图", "插图", "美术"], scene: "bright art studio with a balanced multicolor palette", props: "a paintbrush and color swatches" },
    { keywords: ["音乐", "音频", "配音"], scene: "warm sound studio with coral and blue accents", props: "headphones and a studio microphone" },
    { keywords: ["搜索", "检索", "查找"], scene: "bright discovery desk with green and yellow accents", props: "a magnifying glass and blank index cards" },
  ];

  // 遍历映射表，匹配关键词
  for (const { keywords, scene, props } of SCENE_MAP) {
    if (keywords.some(kw => text.includes(kw))) {
      return { scene, props };
    }
  }

  // 默认：从描述中提取视觉关键词构建通用场景
  const visualKeywords = extractVisualKeywords(text);
  if (visualKeywords.length > 0) {
    return {
      scene: `bright modern creative studio with a soft multicolor backdrop, related to ${visualKeywords.slice(0, 3).join(" and ")}`,
      props: `${visualKeywords[0] || "creative work"} related small physical objects`,
    };
  }

  return { scene: "bright modern creative studio with a soft multicolor backdrop", props: "a notebook and a small idea token" };
}

/**
 * 从描述文本中提取视觉关键词
 *
 * 中文：按标点分词取前5个片段
 * 英文：过滤停用词取前8个
 */
function extractVisualKeywords(description: string): string[] {
  if (!description?.trim()) return [];

  const text = description.trim().slice(0, 120);

  if (/[\u4e00-\u9fa5]/.test(text)) {
    return text
      .split(/[，。、；：！？\s,;:!?]+/)
      .filter((s) => s.length >= 2 && s.length <= 20)
      .slice(0, 5);
  }

  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "and", "but", "or", "not", "so", "it", "its", "this", "that",
    "i", "you", "he", "she", "we", "they", "my", "your", "his",
  ]);

  return text
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w.toLowerCase()))
    .slice(0, 8);
}
