export type VideoStyleCategory = "live-action" | "2d" | "3d";

export interface VideoStylePreset {
  readonly id: string;
  readonly label: string;
  readonly category: VideoStyleCategory;
  readonly promptValue: string;
  readonly generationPrompt: string;
}

type VideoStyleSeed = readonly [
  id: string,
  label: string,
  category: VideoStyleCategory,
  promptValue: string,
];

const STYLE_SEEDS: readonly VideoStyleSeed[] = [
  ["cinematic", "电影质感", "live-action", "电影级光影，高对比度，浅景深，自然光影"],
  ["korean-drama", "韩剧质感", "live-action", "韩剧都市柔光，自然跟拍，通透肤色，暖色调"],
  ["japanese-drama", "日剧质感", "live-action", "日式青春胶片，自然生活感，低饱和柔和色调"],
  ["ancient-romance", "古装唯美", "live-action", "古装唯美柔光，雅致妆发，诗意色调，浅景深"],
  ["palace-drama", "古装权谋", "live-action", "宫廷权谋正剧，低饱和冷色，硬朗侧光，压迫氛围"],
  ["wuxia", "武侠江湖", "live-action", "写实武侠电影，东方山水，动作张力，风沙与衣袂动态"],
  ["suspense", "悬疑冷调", "live-action", "国产悬疑冷调，深阴影，潮湿反光，紧张压迫构图"],
  ["hongkong-90s", "港风复古", "live-action", "九十年代港片，霓虹街景，青红对比，颗粒胶片"],
  ["retro-film", "复古胶片", "live-action", "复古电影摄影，暖棕色调，胶片颗粒，轻微褪色晕光"],
  ["rural-period-realism", "年代乡土写实", "live-action", "中国年代乡土写实，自然日光，土黄青灰，纪实构图"],
  ["cyberpunk", "赛博朋克", "live-action", "霓虹赛博电影，蓝紫红对比，湿地反射，全息机械细节"],
  ["war-epic", "战争史诗", "live-action", "真人史诗战争，宏大战场，烟尘体积光，低饱和土灰"],
  ["western-wilderness", "荒野西部", "live-action", "荒野西部电影，边境小镇，沙土色，宽银幕长阴影"],
  ["classic-black-white", "经典黑白", "live-action", "经典黑白电影，高反差单色，银盐颗粒，硬朗轮廓光"],
  ["horror-film", "恐怖电影", "live-action", "真人恐怖电影，低照度冷色，危险局部光，幽闭压迫构图"],
  ["retro-atomic-punk", "复古原子科幻", "live-action", "复古未来原子朋克，五十年代太空美学，流线金属设备"],

  ["chinese-anime", "国漫二次元", "2d", "高质量国漫二次元，东方人物，清晰线稿，细腻赛璐璐"],
  ["anime-japanese", "日系手绘动画", "2d", "日系手绘二维动画，清透自然光，柔和赛璐璐，生活感"],
  ["shanghai-animation", "上美画风", "2d", "中国经典美术片，传统工笔，民族色彩，装饰性造型"],
  ["american-cartoon-2d", "美式卡通动画", "2d", "美式二维卡通，粗线条，明快高饱和，夸张表情动作"],
  ["ink-wash", "水墨风格", "2d", "中国水墨动画，宣纸纹理，墨色晕染，大面积留白"],
  ["pixel-art", "像素风格", "2d", "精致像素艺术，有限协调色板，清晰像素网格，复古游戏美术"],
  ["dark-comic", "暗黑漫画", "2d", "暗黑二维漫画，锋利线稿，重墨阴影，冷色高反差"],
  ["black-white-comic", "黑白漫画", "2d", "黑白二维漫画，墨线网点，动态线，高反差分镜构图"],
  ["cinematic-painterly", "电影厚涂", "2d", "电影感二维厚涂，半写实人物，综合色块，概念艺术构图"],
  ["shonen-anime", "热血漫", "2d", "高质量二维热血漫，力量线稿，冲击构图，鲜明赛璐璐"],
  ["crayon-illustration", "儿童蜡笔", "2d", "儿童蜡笔手绘，纸张纹理，稚拙圆润造型，明快暖色"],
  ["shadow-puppet", "皮影剪纸", "2d", "中国皮影剪纸，侧面剪影，镂空纹样，暖黄背光"],

  ["3d-chinese", "3D国风动画", "3d", "高品质国风三维动画，东方服饰，传统建筑山水，电影级渲染"],
  ["3d-cartoon", "3D卡通动画", "3d", "高品质三维卡通，圆润角色，明快配色，柔和全局光照"],
  ["3d-american", "美式3D动画", "3d", "欧美院线级三维动画，夸张可信比例，丰富表情，精细材质"],
  ["clay-motion", "粘土动画", "3d", "粘土定格动画，手工捏塑，哑光表面，微缩布景"],
  ["stop-motion", "定格动画", "3d", "实体模型定格动画，木偶纸艺，手工接缝，棚拍硬光"],
  ["ue5-realistic", "高端写实3D", "3d", "高端写实三维CG，PBR材质，全局光照，高精度建模"],
  ["stylized-3d", "风格化3D", "3d", "高品质风格化三维，半写实比例，艺术化材质，电影布光"],
  ["cel-shaded-3d", "动漫三渲二", "3d", "动漫三渲二，二维赛璐璐明暗，干净描边，三维空间镜头"],
  ["miniature-3d", "3D微缩景观", "3d", "三维卡通微缩景观，移轴构图，模型化建筑，柔和景深"],
  ["designer-toy-3d", "盲盒潮玩", "3d", "潮玩盲盒三维，夸张头身比，树脂喷涂，产品级棚拍"],
  ["victorian-dark-fantasy", "维多利亚暗黑奇幻", "3d", "维多利亚暗黑奇幻三维，哥特建筑，蒸汽黄铜，冷雾暗金"],
] as const;

const CATEGORY_GENERATION_PREFIX: Record<VideoStyleCategory, string> = {
  "live-action": "真人写实影视画面",
  "2d": "高质量二维动画画面",
  "3d": "高质量三维动画画面",
};

export const VIDEO_STYLE_CATEGORIES: ReadonlyArray<{
  readonly id: VideoStyleCategory;
  readonly label: string;
}> = [
  { id: "live-action", label: "真人 · 16 种" },
  { id: "2d", label: "2D 动画 · 12 种" },
  { id: "3d", label: "3D 动画 · 11 种" },
];

export const VIDEO_STYLES: readonly VideoStylePreset[] = STYLE_SEEDS.map(([
  id,
  label,
  category,
  promptValue,
]) => ({
  id,
  label,
  category,
  promptValue,
  generationPrompt: `${CATEGORY_GENERATION_PREFIX[category]}。${promptValue}。保持角色外观、服装、道具、场景材质、色彩和光线连续，画面干净，无水印与无关文字。`,
}));

export const DEFAULT_VIDEO_STYLE = VIDEO_STYLES[0].promptValue;

export function getVideoStylesByCategory(category: VideoStyleCategory): readonly VideoStylePreset[] {
  return VIDEO_STYLES.filter((style) => style.category === category);
}

export function getVideoStyleByPromptValue(promptValue: string): VideoStylePreset | undefined {
  const normalized = promptValue.trim();
  return VIDEO_STYLES.find((style) => style.promptValue === normalized);
}

export function getVideoStyleLabel(promptValue: string): string {
  return getVideoStyleByPromptValue(promptValue)?.label || promptValue.trim() || "未选择";
}

export function resolveVideoStylePrompt(promptValue: string): string {
  const normalized = promptValue.trim();
  return getVideoStyleByPromptValue(normalized)?.generationPrompt || normalized;
}
