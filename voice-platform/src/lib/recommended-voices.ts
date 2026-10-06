// 火山引擎官方控制台"推荐音色"与"上周热门音色"配置
// 数据来源：https://console.volcengine.com/speech/new/voices
// 更新日期：2026-07-19
//
// 推荐音色逻辑：火山控制台首页展示的8个官方推荐音色，覆盖情感阅读/陪聊/电台/角色扮演/视频配音/教学
// 上周热门音色：基于用户实际使用量排序的真人类音色（ICL接近真人/多情感/口语化）

export interface RecommendedVoice {
  speakerId: string;
  name: string;
  avatar?: string;
  tags: string[];
  description: string;
  highlight: string; // 突出特点描述
}

// ============ 推荐音色（控制台首页展示）============
export const RECOMMENDED_VOICES: RecommendedVoice[] = [
  {
    speakerId: 'zh_female_vv_uranus_bigtts',
    name: 'Vivi 2.0',
    tags: ['情感阅读', '有声阅读', '客服'],
    description: '语调平稳、咬字柔和、自带治愈安抚力的女声音色',
    highlight: '咬字柔和、自带治愈安抚力',
  },
  {
    speakerId: 'zh_female_xiaohe_uranus_bigtts',
    name: '小何 2.0',
    tags: ['陪聊', '情感阅读', '客服'],
    description: '声线甜美有活力的妹妹，活泼开朗，笑容明媚',
    highlight: '甜美活力、活泼开朗',
  },
  {
    speakerId: 'zh_male_m191_uranus_bigtts',
    name: '云舟 2.0',
    tags: ['电台', '有声阅读'],
    description: '声音磁性的男生，成熟理性，做事有条理，让人信赖',
    highlight: '磁性沉稳、成熟理性',
  },
  {
    speakerId: 'zh_male_taocheng_uranus_bigtts',
    name: '小天 2.0',
    tags: ['陪聊', '角色扮演'],
    description: '眉目清朗男大，清澈温润有朝气，开朗真诚',
    highlight: '清澈温润、开朗真诚',
  },
  {
    speakerId: 'zh_male_shaonianzixin_uranus_bigtts',
    name: '少年梓辛 2.0',
    tags: ['有声阅读', '情感陪伴'],
    description: '少年感十足的清爽男生，温柔亲切，阳光开朗',
    highlight: '少年感、温柔阳光',
  },
  {
    speakerId: 'zh_female_meilinvyou_uranus_bigtts',
    name: '魅力女友 2.0',
    tags: ['视频配音', '直播'],
    description: '性感妩媚的御姐，成熟有魅力，风情十足',
    highlight: '性感妩媚、风情御姐',
  },
  {
    speakerId: 'zh_male_liufei_uranus_bigtts',
    name: '刘飞 2.0',
    tags: ['陪聊', '电台'],
    description: '逻辑清晰、理性稳重的男性',
    highlight: '逻辑清晰、理性稳重',
  },
  {
    speakerId: 'zh_female_yingyujiaoxue_uranus_bigtts',
    name: 'Tina老师 2.0',
    tags: ['教学场景', '有声阅读'],
    description: '磁性知性的青年讲师，温柔耐心，专业靠谱',
    highlight: '磁性知性、专业靠谱',
  },
];

// ============ 上周热门音色（说话像真人感比较强的）============
// 选择标准：ICL接近真人 + saturn COT强指令 + 抖音同款/多情感等高使用率音色
export const WEEKLY_HOT_VOICES: RecommendedVoice[] = [
  // ICL 接近真人音色（重点推荐）
  {
    speakerId: 'ICL_uranus_zh_female_chunzhenshaonv_tob',
    name: '纯真少女',
    tags: ['接近真人', '角色扮演'],
    description: '纯真无邪的少女音色，吐字清晰自然',
    highlight: '纯真无邪、清新自然',
  },
  {
    speakerId: 'ICL_uranus_zh_female_wenrounvshen_tob',
    name: '温柔女神',
    tags: ['接近真人', '视频配音'],
    description: '温柔女神，音线柔和治愈',
    highlight: '温柔治愈、女神音线',
  },
  {
    speakerId: 'ICL_uranus_zh_female_zhixinjiejie_tob',
    name: '知心姐姐',
    tags: ['接近真人', '角色扮演'],
    description: '知心大姐姐，温暖陪伴',
    highlight: '温暖陪伴、知心大姐姐',
  },
  {
    speakerId: 'ICL_uranus_zh_female_yuanqitianmei_tob',
    name: '元气甜妹',
    tags: ['接近真人', '角色扮演'],
    description: '元气满满的甜妹，活泼有活力',
    highlight: '元气甜美、活力满满',
  },
  {
    speakerId: 'ICL_uranus_zh_female_tiaopigongzhu_tob',
    name: '调皮公主',
    tags: ['接近真人', '角色扮演'],
    description: '调皮活泼的小公主，俏皮灵动',
    highlight: '调皮俏皮、灵动公主',
  },
  {
    speakerId: 'ICL_uranus_zh_female_heainainai_tob',
    name: '和蔼奶奶',
    tags: ['接近真人', '视频配音'],
    description: '和蔼慈祥的奶奶声音，温暖亲切',
    highlight: '和蔼慈祥、温暖亲切',
  },
  {
    speakerId: 'ICL_uranus_zh_female_linjuayi_tob',
    name: '邻居阿姨',
    tags: ['接近真人', '角色扮演'],
    description: '邻家阿姨，唠嗑家常般亲切',
    highlight: '唠嗑家常、邻家亲切',
  },
  // saturn COT 强指令音色
  {
    speakerId: 'saturn_zh_female_keainvsheng_tob',
    name: '可爱女生',
    tags: ['COT强指令', '角色扮演'],
    description: '可爱女生，支持强指令COT控制',
    highlight: '强指令、情感细腻',
  },
  {
    speakerId: 'saturn_zh_female_aojiaonvyou_tob',
    name: '傲娇女友',
    tags: ['COT强指令', '角色扮演'],
    description: '傲娇女友风格，支持强指令情感演绎',
    highlight: '傲娇情感、COT演绎',
  },
  {
    speakerId: 'saturn_zh_female_wumeiyujie_tob',
    name: '妩媚御姐',
    tags: ['COT强指令', '角色扮演'],
    description: '妩媚御姐，强指令控制情感细节',
    highlight: '妩媚御姐、强指令',
  },
  {
    speakerId: 'saturn_zh_male_cixingnansang_tob',
    name: '磁性男嗓',
    tags: ['COT强指令', '角色扮演'],
    description: '磁性男嗓，COT指令控制情感曲线',
    highlight: '磁性男嗓、情感控制',
  },
  // 抖音同款/多情感高使用率
  {
    speakerId: 'zh_female_popo_uranus_bigtts',
    name: '婆婆 2.0',
    tags: ['抖音同款', '豆包同款', '剪映同款'],
    description: '和蔼可亲的婆婆声音，抖音爆款',
    highlight: '抖音爆款、婆婆音色',
  },
  {
    speakerId: 'zh_male_naiqimengwa_uranus_bigtts',
    name: '奶气萌娃 2.0',
    tags: ['剪映同款', '豆包同款'],
    description: '奶声奶气的萌娃声音，亲子首选',
    highlight: '奶气萌娃、亲子同款',
  },
  {
    speakerId: 'zh_male_gaolengchenwen_uranus_bigtts',
    name: '高冷沉稳 2.0',
    tags: ['猫箱同款'],
    description: '高冷沉稳的男声，适合悬疑/解说',
    highlight: '高冷沉稳、猫箱同款',
  },
  {
    speakerId: 'zh_male_ruyayichen_uranus_bigtts',
    name: '儒雅青年 2.0',
    tags: ['番茄小说同款', '豆包同款', '剪映同款'],
    description: '儒雅有礼的青年男声，有声书首选',
    highlight: '儒雅青年、有声书同款',
  },
  {
    speakerId: 'zh_female_meilinvyou_uranus_bigtts',
    name: '魅力女友 2.0',
    tags: ['抖音同款', '视频配音'],
    description: '魅力女友，直播/口播爆款',
    highlight: '魅力女友、直播爆款',
  },
];
