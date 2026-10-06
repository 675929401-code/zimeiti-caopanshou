export type CommerceTab = 'home' | 'agent' | 'image' | 'video' | 'canvas' | 'assets';
export type MaterialKind = 'image' | 'video' | 'audio';
export type MaterialSlot = { id: string; label: string; min: number; max: number; kinds: MaterialKind[] };
export type CommerceSkill = { id: string; name: string; description: string; category: string; slots: MaterialSlot[]; canvasOnly?: boolean; promptRequired?: boolean };
const slot = (id: string, label: string, min: number, max: number, kinds: MaterialKind[] = ['image']): MaterialSlot => ({ id, label, min, max, kinds });

// Publicly observable input roles are re-expressed here. These are our UI
// contracts, not copies of the competitor's private prompts or executable code.
export const IMAGE_SKILLS: CommerceSkill[] = [
  { id: 'default', name: '图片创作', description: '使用文字与参考图，创作你想要的画面', category: '通用', slots: [slot('reference', '参考图片', 0, 9)], promptRequired: true },
  { id: 'face-turnaround', name: '脸部三视图', description: '生成人物正面、侧面与四分之三侧面', category: '人物', slots: [slot('face', '人脸', 1, 3)] },
  { id: 'character-sheet', name: '人物四视图', description: '保持同一人物，生成全身多角度形象', category: '人物', slots: [slot('model', '模特', 1, 5)] },
  { id: 'change-face', name: '模特换脸', description: '保留身体与场景，替换人物面部', category: '人物', slots: [slot('model', '模特', 1, 1), slot('face', '人脸', 1, 1)] },
  { id: 'face-fusion', name: '人脸融合', description: '结合两张人脸参考，设计新的人物形象', category: '人物', slots: [slot('face1', '人脸 1', 1, 1), slot('face2', '人脸 2', 1, 1)] },
  { id: 'change-cloth', name: '服装上身', description: '替换模特身上的服装衣物', category: '商品', slots: [slot('model', '模特', 1, 1), slot('cloth', '上身 / 全身装', 0, 3), slot('pants', '下装', 0, 1)] },
  { id: 'product-use', name: '商品使用', description: '展示模特手持、佩戴或使用商品', category: '商品', slots: [slot('model', '模特', 1, 1), slot('product', '商品', 1, 5)] },
  { id: 'white-background', name: '商品白底图', description: '提取商品主体，制作干净的白底商品图', category: '商品', slots: [slot('product', '商品', 1, 9)] },
  { id: 'clothing-redesign', name: '服装改款', description: '根据服装参考调整面料和印花', category: '商品', slots: [slot('cloth', '服装', 1, 1), slot('material', '面料', 0, 1), slot('print', '印花', 0, 1)] },
  { id: 'background-change', name: '人物入景', description: '把人物放入参考场景，协调光线与透视', category: '人物', slots: [slot('model', '模特', 1, 1), slot('background', '背景', 1, 1)] },
  { id: 'portrait-realism', name: '人物真人感', description: '细化肤质、光线和人物真实感', category: '人物', slots: [slot('model', '模特', 1, 9)] },
  { id: 'image-refine', name: '图片精修', description: '调整画面细节、材质与光影', category: '商品', slots: [slot('product', '图片', 1, 1)] },
  { id: 'script-storyboard', name: '脚本故事版', description: '用脚本和参考图组织故事分镜', category: '画布', canvasOnly: true, promptRequired: true, slots: [slot('reference', '参考图片', 1, 9)] },
  { id: 'storyboard-replace', name: '一键替换分镜', description: '保留分镜结构，替换画面中的主体', category: '画布', canvasOnly: true, slots: [slot('grid', '宫格图', 1, 1), slot('reference', '参考素材', 1, 6)] },
  { id: 'video-first-frame', name: '视频参考首帧', description: '制作适合图生视频的参考首帧', category: '画布', canvasOnly: true, slots: [slot('reference', '参考图片', 1, 9)] },
  { id: 'product-consistency', name: '产品一致性', description: '整理同一商品的多角度视觉参考', category: '画布', canvasOnly: true, slots: [slot('product', '商品', 1, 9)] },
];
export const DIRECTOR_GROUPS: Record<string, string[]> = {
  '电商带货': ['口播带货', '促销转化', '场景种草', '痛点解决', '功能演示'],
  '同城到店': ['门店发现', '到店实录', '招牌体验', '同城团购'],
  '品牌广告': ['品牌主张', '品牌故事', '生活方式', '创意概念'],
  '剧情短片': ['对话短剧', '反转短剧', '悬念短剧', '情绪短片', '产品植入'],
};
export const VIDEO_SLOTS: MaterialSlot[] = [slot('reference', '添加参考图片/视频', 0, 12, ['image', 'video']), slot('sound', '添加声音', 0, 3, ['audio'])];
export const SCENARIOS = [
  { id: 'replicate', name: '深度复刻', description: '参考原片动作与镜头，替换人物或商品', image: '/commerce/replicate.jpg', prompt: '根据参考视频的动作与镜头，使用我的商品或人物素材制作新视频。', stages: ['选择参考视频', '添加商品或人物，可选背景和声音', '补充说明，核对时长与画幅', '确认费用并生成', '查看成片或继续剪辑'] },
  { id: 'detail', name: '商详套图', description: '一组参考，制作商品详情套图', image: '/commerce/detail.jpg', prompt: '请根据商品参考，制作一套商品详情图，包含主视觉、核心卖点、细节、使用场景和规格。', stages: ['上传商品参考', '核对商品信息', '确认分屏结构', '逐屏生成', '检查与导出'] },
  { id: 'ecommerce', name: '电商带货', description: '制作商品展示与带货视频', image: '/commerce/ecommerce.jpg', prompt: '我要为商品制作一条带货视频，请先整理受众、卖点和脚本，再规划画面与口播。', stages: ['整理商品信息', '选择编导风格', '确认脚本', '生成画面与视频', '配音与导出'] },
  { id: 'local', name: '同城到店', description: '策划门店探访与团购内容', image: '/commerce/local.jpg', prompt: '请为我的门店策划同城到店视频，突出真实环境、招牌体验和到店理由。', stages: ['上传门店素材', '整理到店信息', '确认脚本', '制作镜头', '检查与导出'] },
  { id: 'brand', name: '品牌广告', description: '围绕品牌表达创意与故事', image: '/commerce/brand.jpg', prompt: '请制作一条品牌广告，先明确品牌主张、受众和视觉基调，再给出创意与镜头方案。', stages: ['填写品牌信息', '确认创意方向', '规划镜头', '生成素材', '检查与导出'] },
  { id: 'drama', name: '剧情短片', description: '用角色、故事和镜头表达创意', image: '/commerce/drama.jpg', prompt: '我要制作一段剧情短片，请先明确人物、情节和产品出现的方式，再规划镜头。', stages: ['确定人物与故事', '确认脚本', '规划镜头', '生成素材', '剪辑与导出'] },

];
export const DETAIL_PANELS = ['商品主视觉', '核心卖点', '材质与细节', '使用场景', '规格与说明', '购买理由'];
export const TOOL_ITEMS = ['画布', '剪辑台', '画质增强', '水印擦除', '字幕擦除', '人脸打码', '图片精修', '数字人视频', '爆款视频二创', '语音合成'] as const;
export const COMMERCE_DRAFT_VERSION = 1;
