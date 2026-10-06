/**
 * 火山引擎 TTS 官方音色库
 * 数据来源：https://www.volcengine.com/docs/6561/1257544
 * 
 * API 路由规则：
 * - uranus_bigtts (4个TTS 2.0核心音色) → POST /v3/tts/unidirectional + X-Api-Resource-Id: seed-tts-2.0
 * - mars/moon/saturn/ICL (所有1.0音色) → POST /v3/tts/create + model: seed-audio-1.0
 * - 复刻音色 → POST /v3/tts/unidirectional + X-Api-Resource-Id: seed-icl-2.0
 */

export interface VoiceMeta {
  id: string;           // voice_type ID (官方)
  name: string;         // 显示名称
  gender: 'female' | 'male';
  scene: string;        // 场景分类
  tags: string[];       // 特殊标签
  apiType: 'tts2' | 'audio1' | 'icl'; // 对应哪个API
  language: string;     // 语种
  emotionSupport?: boolean; // 是否支持情感参数
}

/** 场景分类 */
export const SCENES = [
  { id: 'all', label: '全部' },
  { id: 'general', label: '通用场景' },
  { id: 'roleplay', label: '角色扮演' },
  { id: 'dubbing', label: '视频配音' },
  { id: 'audiobook', label: '有声阅读' },
  { id: 'service', label: '客服场景' },
  { id: 'education', label: '教育场景' },
  { id: 'multilingual', label: '多语种' },
] as const;

// ═══════════════════════════════════════════════════
// TTS 2.0 核心音色 (uranus_bigtts) - 走 /v3/tts/unidirectional
// ═══════════════════════════════════════════════════
const TTS2_VOICES: VoiceMeta[] = [
  { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'tts2', language: 'zh', emotionSupport: true },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'tts2', language: 'zh', emotionSupport: true },
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'tts2', language: 'zh', emotionSupport: true },
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'tts2', language: 'zh', emotionSupport: true },
];

// ═══════════════════════════════════════════════════
// 精品克隆音色 (saturn_bigtts) - 走 /v3/tts/create
// ═══════════════════════════════════════════════════
const SATURN_VOICES: VoiceMeta[] = [
  // 视频配音
  { id: 'zh_female_xueayi_saturn_bigtts', name: '儿童绘本', gender: 'female', scene: 'dubbing', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_dayi_saturn_bigtts', name: '大壹', gender: 'male', scene: 'dubbing', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_mizai_saturn_bigtts', name: '黑猫侦探社咪', gender: 'female', scene: 'dubbing', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_jitangnv_saturn_bigtts', name: '鸡汤女', gender: 'female', scene: 'dubbing', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_meilinvyou_saturn_bigtts', name: '魅力女友', gender: 'female', scene: 'dubbing', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_santongyongns_saturn_bigtts', name: '流畅女声', gender: 'female', scene: 'dubbing', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_ruyayichen_saturn_bigtts', name: '儒雅逸辰', gender: 'male', scene: 'dubbing', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  // 角色扮演 (saturn _tob)
  { id: 'saturn_zh_female_keainvsheng_tob', name: '可爱女生', gender: 'female', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_tiaopigongzhu_tob', name: '调皮公主', gender: 'female', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_male_shuanglangshaonian_tob', name: '爽朗少年', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_male_tiancaitongzhuo_tob', name: '天才同桌', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_cancan_tob', name: '知性灿灿', gender: 'female', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
];

// ═══════════════════════════════════════════════════
// 通用场景 (mars/moon) - 走 /v3/tts/create
// ═══════════════════════════════════════════════════
const GENERAL_VOICES: VoiceMeta[] = [
  // 女声
  { id: 'ICL_zh_female_wenrounvshen_239eff5e8ffa_tob', name: '温柔女神', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_vv_mars_bigtts', name: 'Vivi', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_qinqienvsheng_moon_bigtts', name: '亲切女声', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_cancan_mars_bigtts', name: '灿灿', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_shuangkuaisisi_moon_bigtts', name: '爽快思思', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_tianmeitaozi_mars_bigtts', name: '甜美桃子', gender: 'female', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_qingxinnvsheng_mars_bigtts', name: '清新女声', gender: 'female', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_zhixingnvsheng_mars_bigtts', name: '知性女声', gender: 'female', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_linjianvhai_moon_bigtts', name: '邻家女孩', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_kailangjiejie_mars_bigtts', name: '开朗姐姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_tianmeiyueyue_moon_bigtts', name: '甜美悦悦', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_xinlingjitang_mars_bigtts', name: '心灵鸡汤', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_gaolengyujie_moon_bigtts', name: '高冷御姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_meilinvyou_moon_bigtts', name: '魅力女友', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_sajiaonvyou_moon_bigtts', name: '柔美女友', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_yuanqinvyou_mars_bigtts', name: '撒娇学妹', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_wenrouxiaoya_moon_bigtts', name: '温柔小雅', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_qiaopinvsheng_mars_bigtts', name: '俏皮女声', gender: 'female', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_shaoergushi_mars_bigtts', name: '少儿故事', gender: 'female', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_yingtaowanzi_mars_bigtts', name: '樱桃丸子', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_peiqi_mars_bigtts', name: '佩奇猪', gender: 'female', scene: 'general', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_wuzetian_mars_bigtts', name: '武则天', gender: 'female', scene: 'general', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_gujie_mars_bigtts', name: '顾姐', gender: 'female', scene: 'general', tags: ['抖音同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_popo_mars_bigtts', name: '婆婆', gender: 'female', scene: 'general', tags: ['豆包同款', '抖音同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_ganmaodianyin_mars_bigtts', name: '感冒电音姐姐', gender: 'female', scene: 'general', tags: ['抖音同款', '剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_naying_mars_bigtts', name: '直率英子', gender: 'female', scene: 'general', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_leidian_mars_bigtts', name: '女雷神', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_jiaochuan_mars_bigtts', name: '娇喘女声', gender: 'female', scene: 'general', tags: ['抖音同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_flattery_mars_bigtts', name: '谄媚女声', gender: 'female', scene: 'general', tags: ['抖音同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_kefunvsheng_mars_bigtts', name: '暖阳女声', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  // 男声
  { id: 'zh_male_yuanboxiaoshu_moon_bigtts', name: '渊博小叔', gender: 'male', scene: 'general', tags: ['豆包同款', '剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_yangguangqingnian_moon_bigtts', name: '阳光青年', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_tianmeixiaoyuan_moon_bigtts', name: '甜美小源', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_qingchezizi_moon_bigtts', name: '清澈梓梓', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_jieshuoxiaoming_moon_bigtts', name: '解说小明', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_linjiananhai_moon_bigtts', name: '邻家男孩', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_wenrouxiaoge_mars_bigtts', name: '温柔小哥', gender: 'male', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_wennuanahu_moon_bigtts', name: '温暖阿虎', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_shaonianzixin_moon_bigtts', name: '少年梓辛', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_qingshuangnanda_mars_bigtts', name: '清爽男大', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_aojiaobazong_moon_bigtts', name: '傲娇霸总', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_shenyeboke_moon_bigtts', name: '深夜播客', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_dongfanghaoran_moon_bigtts', name: '东方浩然', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_xudong_conversation_wvae_bigtts', name: '快乐小东', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_naiqimengwa_mars_bigtts', name: '奶气萌娃', gender: 'male', scene: 'general', tags: ['豆包同款', '剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_sunwukong_mars_bigtts', name: '猴哥', gender: 'male', scene: 'dubbing', tags: ['抖音同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_xionger_mars_bigtts', name: '熊二', gender: 'male', scene: 'dubbing', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_tangseng_mars_bigtts', name: '唐僧', gender: 'male', scene: 'dubbing', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_zhubajie_mars_bigtts', name: '猪八戒', gender: 'male', scene: 'dubbing', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_chunhui_mars_bigtts', name: '广告解说', gender: 'male', scene: 'dubbing', tags: ['剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_jieshuonansheng_mars_bigtts', name: '磁性解说', gender: 'male', scene: 'dubbing', tags: ['抖音同款', '剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_silang_mars_bigtts', name: '四郎', gender: 'male', scene: 'dubbing', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_livelybro_mars_bigtts', name: '开朗弟弟', gender: 'male', scene: 'general', tags: ['抖音同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_lanxiaoyang_mars_bigtts', name: '懒音绵宝', gender: 'male', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_dongmanhaimian_mars_bigtts', name: '亮嗓萌仔', gender: 'male', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_tiancaitongsheng_mars_bigtts', name: '天才童声', gender: 'male', scene: 'dubbing', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_ruyaqingnian_mars_bigtts', name: '儒雅青年', gender: 'male', scene: 'audiobook', tags: ['番茄小说同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_baqiqingshu_mars_bigtts', name: '霸气青叔', gender: 'male', scene: 'audiobook', tags: ['番茄小说同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_qingcang_mars_bigtts', name: '擎苍', gender: 'male', scene: 'audiobook', tags: ['番茄小说同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_changtianyi_mars_bigtts', name: '悬疑解说', gender: 'male', scene: 'audiobook', tags: ['豆包同款', '抖音同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_fanjuanqingnian_mars_bigtts', name: '反卷青年', gender: 'male', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_yangguangqingnian_mars_bigtts', name: '活力小哥', gender: 'male', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_hupunan_mars_bigtts', name: '沪普男', gender: 'male', scene: 'dubbing', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_lubanqihao_mars_bigtts', name: '鲁班七号', gender: 'male', scene: 'dubbing', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_zhuangzhou_mars_bigtts', name: '庄周', gender: 'male', scene: 'dubbing', tags: ['抖音同款', '剪映同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_yangmi_mars_bigtts', name: '林潇', gender: 'female', scene: 'dubbing', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_linzhiling_mars_bigtts', name: '玲玲姐姐', gender: 'female', scene: 'dubbing', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  // 女声有声阅读
  { id: 'zh_female_gufengshaoyu_mars_bigtts', name: '古风少御', gender: 'female', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_wenroushunv_mars_bigtts', name: '温柔淑女', gender: 'female', scene: 'audiobook', tags: ['番茄小说同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_gushi_mars_bigtts', name: '故事女声', gender: 'female', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  // 方言
  { id: 'zh_female_yueyunv_mars_bigtts', name: '粤语小溏', gender: 'female', scene: 'general', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_yuzhouzixuan_moon_bigtts', name: '豫州子轩', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_daimengchuanmei_moon_bigtts', name: '呆萌川妹', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_guangxiyuanzhou_moon_bigtts', name: '广西远舟', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_wanwanxiaohe_moon_bigtts', name: '湾湾小何', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_beijingxiaoye_moon_bigtts', name: '北京小爷', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_jingqiangkanye_moon_bigtts', name: '京腔侃爷', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_zhoujielun_emo_v2_mars_bigtts', name: '双节棍小哥', gender: 'male', scene: 'general', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh', emotionSupport: true },
  // 女声多情感
  { id: 'zh_female_tianxinxiaomei_emo_v2_mars_bigtts', name: '甜心小美', gender: 'female', scene: 'general', tags: ['剪映同款'], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_female_gaolengyujie_emo_v2_mars_bigtts', name: '高冷御姐(情感)', gender: 'female', scene: 'general', tags: ['剪映同款'], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_female_roumeinvyou_emo_v2_mars_bigtts', name: '柔美女友(情感)', gender: 'female', scene: 'general', tags: [], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts', name: '爽快思思(情感)', gender: 'female', scene: 'general', tags: [], apiType: 'audio1', language: 'zh', emotionSupport: true },
  // 男声多情感
  { id: 'zh_male_lengkugege_emo_v2_mars_bigtts', name: '冷酷哥哥(情感)', gender: 'male', scene: 'general', tags: [], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_male_aojiaobazong_emo_v2_mars_bigtts', name: '傲娇霸总(情感)', gender: 'male', scene: 'general', tags: ['剪映同款'], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_male_yourougongzi_emo_v2_mars_bigtts', name: '优柔公子(情感)', gender: 'male', scene: 'general', tags: ['剪映同款'], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_male_ruyayichen_emo_v2_mars_bigtts', name: '儒雅男友(情感)', gender: 'male', scene: 'general', tags: ['剪映同款'], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_male_junlangnanyou_emo_v2_mars_bigtts', name: '俊朗男友(情感)', gender: 'male', scene: 'general', tags: ['剪映同款'], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_male_beijingxiaoye_emo_v2_mars_bigtts', name: '北京小爷(情感)', gender: 'male', scene: 'general', tags: [], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_male_yangguangqingnian_emo_v2_mars_bigtts', name: '阳光青年(情感)', gender: 'male', scene: 'general', tags: [], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_male_shenyeboke_emo_v2_mars_bigtts', name: '深夜播客(情感)', gender: 'male', scene: 'general', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh', emotionSupport: true },
  { id: 'zh_female_sophie_uranus_bigtts', name: '魅力苏菲', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_meilinvyou_uranus_bigtts', name: '魅力女友', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_wenroumama_uranus_bigtts', name: '温柔妈妈', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_tvbnv_uranus_bigtts', name: 'TVB女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_qiaopinv_uranus_bigtts', name: '俏皮女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_popo_uranus_bigtts', name: '婆婆', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_gufengshaoyu_uranus_bigtts', name: '古风少御', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_mengyatou_uranus_bigtts', name: '萌丫头', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_tiexinnvsheng_uranus_bigtts', name: '贴心女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_jitangmei_uranus_bigtts', name: '鸡汤妹妹', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_kailangjiejie_uranus_bigtts', name: '开朗姐姐', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_jiaochuannv_uranus_bigtts', name: '娇喘女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_ganmaodianyin_uranus_bigtts', name: '感冒电音姐姐', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_chanmeinv_uranus_bigtts', name: '谄媚女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_qinqienv_uranus_bigtts', name: '亲切女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_wenjingmaomao_uranus_bigtts', name: '文静毛毛', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_zhixingnv_uranus_bigtts', name: '知性女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_qingchezizi_uranus_bigtts', name: '清澈梓梓', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_tianmeiyueyue_uranus_bigtts', name: '甜美悦悦', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_xinlingjitang_uranus_bigtts', name: '心灵鸡汤', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_roumeinvyou_uranus_bigtts', name: '柔美女友', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_wenrouxiaoya_uranus_bigtts', name: '温柔小雅', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_kefunvsheng_uranus_bigtts', name: '暖阳女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_zhishuaiyingzi_uranus_bigtts', name: '直率英子', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_yingtaowanzi_uranus_bigtts', name: '樱桃丸子', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_lingling_uranus_bigtts', name: '玲玲姐姐', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_chunribu_uranus_bigtts', name: '春日部姐姐', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_linxiao_uranus_bigtts', name: '林潇', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_nvleishen_uranus_bigtts', name: '女雷神', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_wenroushunv_uranus_bigtts', name: '温柔淑女', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_gujie_uranus_bigtts', name: '顾姐', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_peiqi_uranus_bigtts', name: '佩奇猪', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_mizai_uranus_bigtts', name: '黑猫侦探咪仔', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_jitangnv_uranus_bigtts', name: '鸡汤女', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_liuchangnv_uranus_bigtts', name: '流畅女声', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_xiaoxue_uranus_bigtts', name: '儿童绘本', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_shaoergushi_uranus_bigtts', name: '少儿故事', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_yingyujiaoxue_uranus_bigtts', name: 'Tina老师', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_jieshuoxiaoming_uranus_bigtts', name: '解说小明', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_yizhipiannan_uranus_bigtts', name: '译制片男', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_linjiananhai_uranus_bigtts', name: '邻家男孩', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_wennuanahu_uranus_bigtts', name: '温暖阿虎', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_naiqimengwa_uranus_bigtts', name: '奶气萌娃', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_fanjuanqingnian_uranus_bigtts', name: '反卷青年', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_huolixiaoge_uranus_bigtts', name: '活力小哥', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_cixingjieshuonan_uranus_bigtts', name: '磁性解说男声', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_liangsangmengzai_uranus_bigtts', name: '亮嗓萌仔', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_gaolengchenwen_uranus_bigtts', name: '高冷沉稳', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_shenyeboke_uranus_bigtts', name: '深夜播客', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_kailangdidi_uranus_bigtts', name: '开朗弟弟', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_kuailexiaodong_uranus_bigtts', name: '快乐小东', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_kailangxuezhang_uranus_bigtts', name: '开朗学长', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_youyoujunzi_uranus_bigtts', name: '悠悠君子', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_qingshuangnanda_uranus_bigtts', name: '清爽男大', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_yuanboxiaoshu_uranus_bigtts', name: '渊博小叔', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_yangguangqingnian_uranus_bigtts', name: '阳光青年', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_wenrouxiaoge_uranus_bigtts', name: '温柔小哥', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_dongfanghaoran_uranus_bigtts', name: '东方浩然', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_guanggaojieshuo_uranus_bigtts', name: '广告解说', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_shaonianzixin_uranus_bigtts', name: '少年梓辛', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_ruyayichen_uranus_bigtts', name: '儒雅逸辰', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_dayi_uranus_bigtts', name: '大壹', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_baqiqingshu_uranus_bigtts', name: '霸气青叔', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_xuanyijieshuo_uranus_bigtts', name: '悬疑解说', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_tiancaitongsheng_uranus_bigtts', name: '天才童声', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_aojiaobazong_uranus_bigtts', name: '傲娇霸总', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_lanyinmianbao_uranus_bigtts', name: '懒音绵宝', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_sunwukong_uranus_bigtts', name: '猴哥', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_zhubajie_uranus_bigtts', name: '猪八戒', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_tangseng_uranus_bigtts', name: '唐僧', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_zhuangzhou_uranus_bigtts', name: '庄周', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_female_wuzetian_uranus_bigtts', name: '武则天', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_silang_uranus_bigtts', name: '四郎', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_qingcang_uranus_bigtts', name: '擎苍', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_lubanqihao_uranus_bigtts', name: '鲁班七号', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'zh_male_xionger_uranus_bigtts', name: '熊二', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'zh' },
  { id: 'saturn_zh_female_aojiaonvyou_tob', name: '傲娇女友', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_bingjiaojiejie_tob', name: '病娇姐姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_chengshujiejie_tob', name: '成熟姐姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_nuanxinxuejie_tob', name: '暖心学姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_tiexinnvyou_tob', name: '贴心女友', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_wenrouwenya_tob', name: '温柔文雅', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_wumeiyujie_tob', name: '妩媚御姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_xingganyujie_tob', name: '性感御姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_aoqilingren_tob', name: '傲气凌人', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_male_cixingnansang_tob', name: '磁性男嗓', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_male_cijingnanyou_tob', name: '醋精男友', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_male_fengfashaonian_tob', name: '风发少年', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_male_fuheigongzi_tob', name: '腹黑公子', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_chunzhenshaonv_tob', name: '纯真少女', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_wenrounvshen_tob', name: '温柔女神', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_zhixinjiejie_tob', name: '知心姐姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_yuanqitianmei_tob', name: '元气甜妹', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_aomanjiaosheng_tob', name: '傲慢娇声', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_xiemeinvwang_tob', name: '邪魅女王', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_bingjiaomengmei_tob', name: '病娇萌妹', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_bingruoshaonv_tob', name: '病弱少女', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_chengshuwenrou_tob', name: '成熟温柔', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_chunchenvsheng_tob', name: '纯澈女生', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_wumeikeren_tob', name: '妩媚可人', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_huopodiaoman_tob', name: '活泼刁蛮', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_huoponvhai_tob', name: '活泼女孩', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_jiaohannvwang_tob', name: '娇憨女王', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_jiaoruoluoli_tob', name: '娇弱萝莉', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_jiaxiaozi_tob', name: '假小子', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_jinglingxiangdao_tob', name: '精灵向导', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_tianmeijiaoqiao_tob', name: '甜美娇俏', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_qinglenggaoya_tob', name: '清冷高雅', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_xingganmeihuo_tob', name: '性感魅惑', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_qingxinshaonv_tob', name: '倾心少女', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_rouguhunshi_tob', name: '柔骨魂师', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_ruanmengtuanzi_tob', name: '软萌团子', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_tianmeihuopo_tob', name: '甜美活泼', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_tiaopigongzhu_tob', name: '调皮公主', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_xiemeiyujie_tob', name: '邪魅御姐', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_heainainai_tob', name: '和蔼奶奶', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_linjuayi_tob', name: '邻居阿姨', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_kefuwanjun_tob', name: '客服婉君', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_qingyingduoduo_cs_tob', name: '轻盈朵朵', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_wenwanshanshan_cs_tob', name: '温婉珊珊', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_female_reqingaina_cs_tob', name: '热情艾娜', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'saturn_zh_male_qingxinmumu_cs_tob', name: '清新沐沐', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_guaiqiaokeer_tob', name: '乖巧可儿', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_kailangtingting_tob', name: '开朗婷婷', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_kaixinxiaohong_tob', name: '开心小鸿', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_lingdongxinxin_tob', name: '灵动欣欣', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_lixingyuanzi_tob', name: '理性圆子', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_nuanxinqianqian_tob', name: '暖心茜茜', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_qingtianmeimei_tob', name: '清甜莓莓', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_qingtiantaotao_tob', name: '清甜桃桃', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_qingxixiaoxue_tob', name: '清晰小雪', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_ruanmengtangtang_tob', name: '软萌糖糖', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_tianmeixiaoju_tob', name: '甜美小橘', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_uranus_zh_female_tianmeixiaoyu_tob', name: '甜美小雨', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'en_male_tim_uranus_bigtts', name: 'Tim', gender: 'male', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'en' },
  { id: 'en_female_dacey_uranus_bigtts', name: 'Dacey', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'en' },
  { id: 'en_female_stokie_uranus_bigtts', name: 'Stokie', gender: 'female', scene: 'general', tags: ['TTS2.0'], apiType: 'tts2', language: 'en' },
  { id: 'ICL_uranus_en_female_charlie_tob', name: 'Charlie', gender: 'female', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'en' },
  { id: 'ICL_uranus_en_male_ethan_tob', name: 'Ethan', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'en' },
  { id: 'ICL_uranus_en_male_alastor_tob', name: 'Alastor', gender: 'male', scene: 'general', tags: ['豆包同款'], apiType: 'audio1', language: 'en' },
// ═══════════════════════════════════════════════════
// 角色扮演 (ICL _tob) - 走 /v3/tts/create
];
// ═══════════════════════════════════════════════════
const ROLEPLAY_VOICES: VoiceMeta[] = [
  // 豆包同款
  { id: 'ICL_zh_female_chunzhenshaonv_e588402fb8ad_tob', name: '纯真少女', gender: 'female', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_xiaonaigou_edf58cf28b8b_tob', name: '奶气小生', gender: 'male', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_jinglingxiangdao_1beb294a9e3e_tob', name: '精灵向导', gender: 'female', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_menyoupingxiaoge_ffed9fc2fee7_tob', name: '闷油瓶小哥', gender: 'male', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_anrenqinzhu_cd62e63dcdab_tob', name: '黯刃秦主', gender: 'male', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_bingruoshaonv_tob', name: '病弱少女', gender: 'female', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_huoponvhai_tob', name: '活泼女孩', gender: 'female', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  // 常用角色
  { id: 'ICL_zh_female_aojiaonvyou_tob', name: '傲娇女友', gender: 'female', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_bingjiaojiejie_tob', name: '病娇姐姐', gender: 'female', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_wumeiyujie_tob', name: '妩媚御姐', gender: 'female', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_tiexinnvyou_tob', name: '贴心女友', gender: 'female', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_xingganyujie_tob', name: '性感御姐', gender: 'female', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_chengshujiejie_tob', name: '成熟姐姐', gender: 'female', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_keainvsheng_tob', name: '可爱女生', gender: 'female', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_nuanxinxuejie_tob', name: '暖心学姐', gender: 'female', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_bingjiaodidi_tob', name: '病娇弟弟', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_bingjiaogege_tob', name: '病娇哥哥', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_lengkugege_v1_tob', name: '冷酷哥哥', gender: 'male', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_badaozongcai_v1_tob', name: '霸道总裁', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_guaogongzi_v1_tob', name: '孤傲公子', gender: 'male', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_tiexinnanyou_tob', name: '贴心男友', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_sajiaonanyou_tob', name: '撒娇男友', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_wenrounanyou_tob', name: '温柔男友', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_huoponanyou_tob', name: '活泼男友', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_shenmifashi_tob', name: '神秘法师', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_youmoshushu_tob', name: '幽默叔叔', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_shaonianjiangjun_tob', name: '少年将军', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_jiaxiaozi_tob', name: '假小子', gender: 'female', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_ruyazongcai_tob', name: '儒雅总裁', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_gaolengzongcai_tob', name: '高冷总裁', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_lengjunshangsi_tob', name: '冷峻上司', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_lengjungaozhi_tob', name: '冷峻高智', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_chengshuzongcai_tob', name: '成熟总裁', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_cujingnanyou_tob', name: '醋精男友', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_asmryexiu_tob', name: '枕边低语', gender: 'male', scene: 'roleplay', tags: ['抖音同款'], apiType: 'audio1', language: 'zh' },
  // 猫箱系列
  { id: 'ICL_zh_male_lvchaxiaoge_tob', name: '绿茶小哥', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_jiaoruoluoli_tob', name: '娇弱萝莉', gender: 'female', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_lengdanshuli_tob', name: '冷淡疏离', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_hanhoudunshi_tob', name: '憨厚敦实', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_huopodiaoman_tob', name: '活泼刁蛮', gender: 'female', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_guzhibingjiao_tob', name: '固执病娇', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_sajiaonianren_tob', name: '撒娇粘人', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_aomanjiaosheng_tob', name: '傲慢娇声', gender: 'female', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_xiaoshasuixing_tob', name: '潇洒随性', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_guiyishenmi_tob', name: '诡异神秘', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_ruyacaijun_tob', name: '儒雅才俊', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_bingjiaomengmei_tob', name: '病娇萌妹', gender: 'female', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_chunzhenxuedi_tob', name: '纯真学弟', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_yourougongzi_tob', name: '优柔公子', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_tiaopigongzhu_tob', name: '调皮公主', gender: 'female', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_xuebanantongzhuo_tob', name: '学霸男同桌', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_youmodaye_tob', name: '幽默大爷', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_wenrounantongzhuo_tob', name: '温柔男同桌', gender: 'male', scene: 'roleplay', tags: ['豆包同款', '猫箱同款'], apiType: 'audio1', language: 'zh' },
  // 更多猫箱角色
  { id: 'ICL_zh_male_bingjiaonanyou_tob', name: '病娇男友', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_yiqishaonian_tob', name: '意气少年', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_rexueshaonian_tob', name: '热血少年', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_zhongerqingnian_tob', name: '中二青年', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_fuheigongzi_tob', name: '腹黑公子', gender: 'male', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_jiaohannvwang_tob', name: '娇憨女王', gender: 'female', scene: 'roleplay', tags: ['猫箱同款'], apiType: 'audio1', language: 'zh' },
];

// ═══════════════════════════════════════════════════
// 客服场景 (ICL _cs_tob) - 走 /v3/tts/create
// ═══════════════════════════════════════════════════
const SERVICE_VOICES: VoiceMeta[] = [
  { id: 'ICL_zh_female_lixingyuanzi_cs_tob', name: '理性圆子', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_qingtiantaotao_cs_tob', name: '清甜桃桃', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_qingxixiaoxue_cs_tob', name: '清晰小雪', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_kailangtingting_cs_tob', name: '开朗婷婷', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_qingxinmumu_cs_tob', name: '清新沐沐', gender: 'male', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_shuanglangxiaoyang_cs_tob', name: '爽朗小阳', gender: 'male', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_wenwanshanshan_cs_tob', name: '温婉珊珊', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_tianmeixiaoyu_cs_tob', name: '甜美小雨', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_reqingaina_cs_tob', name: '热情艾娜', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_chenwenmingzai_cs_tob', name: '沉稳明仔', gender: 'male', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_ruanmengtuanzi_cs_tob', name: '软萌团子', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_guaiqiaokeer_cs_tob', name: '乖巧可儿', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_nuanxinqianqian_cs_tob', name: '暖心茜茜', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_lingdongxinxin_cs_tob', name: '灵动欣欣', gender: 'female', scene: 'service', tags: [], apiType: 'audio1', language: 'zh' },
];

// ═══════════════════════════════════════════════════
// 多语种 - 走 /v3/tts/create
// ═══════════════════════════════════════════════════
const MULTI_VOICES: VoiceMeta[] = [
  // 英语
  { id: 'en_female_lauren_moon_bigtts', name: 'Lauren', gender: 'female', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'en_male_chris_moon_bigtts', name: 'Gotham Hero', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'en_female_nara_moon_bigtts', name: 'Nara', gender: 'female', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'en_male_bruce_moon_bigtts', name: 'Bruce', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'en_male_michael_moon_bigtts', name: 'Michael', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'en_male_adam_mars_bigtts', name: 'Adam', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'en_female_amanda_mars_bigtts', name: 'Amanda', gender: 'female', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'en_male_jackson_mars_bigtts', name: 'Jackson', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'en_female_emily_mars_bigtts', name: 'Emily', gender: 'female', scene: 'multilingual', tags: ['豆包同款'], apiType: 'audio1', language: 'en' },
  { id: 'en_female_dacey_conversation_wvae_bigtts', name: 'Daisy', gender: 'female', scene: 'multilingual', tags: ['豆包同款'], apiType: 'audio1', language: 'en' },
  { id: 'en_male_charlie_conversation_wvae_bigtts', name: 'Owen', gender: 'male', scene: 'multilingual', tags: ['豆包同款'], apiType: 'audio1', language: 'en' },
  { id: 'en_female_sarah_new_conversation_wvae_bigtts', name: 'Luna', gender: 'female', scene: 'multilingual', tags: ['豆包同款'], apiType: 'audio1', language: 'en' },
  // 英语角色扮演
  { id: 'ICL_en_male_michael_tob', name: 'Michael', gender: 'male', scene: 'roleplay', tags: ['豆包同款'], apiType: 'audio1', language: 'en' },
  { id: 'ICL_en_male_zayne_tob', name: 'Zayne', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'ICL_en_male_cc_jigsaw_tob', name: 'Jigsaw', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'en' },
  { id: 'ICL_en_male_cc_chucky_tob', name: 'Chucky', gender: 'male', scene: 'roleplay', tags: [], apiType: 'audio1', language: 'en' },
  // 情感英语
  { id: 'en_female_candice_emo_v2_mars_bigtts', name: 'Candice', gender: 'female', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en', emotionSupport: true },
  { id: 'en_female_skye_emo_v2_mars_bigtts', name: 'Serena', gender: 'female', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en', emotionSupport: true },
  { id: 'en_male_glen_emo_v2_mars_bigtts', name: 'Glen', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en', emotionSupport: true },
  { id: 'en_male_sylus_emo_v2_mars_bigtts', name: 'Sylus', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'en', emotionSupport: true },
  // 日语
  { id: 'multi_zh_male_youyoujunzi_moon_bigtts', name: 'ひかる', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'ja' },
  { id: 'multi_female_maomao_conversation_wvae_bigtts', name: 'つき', gender: 'female', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'ja' },
  // 西语
  { id: 'multi_male_M100_conversation_wvae_bigtts', name: 'Daníel', gender: 'male', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'es' },
  { id: 'multi_female_sophie_conversation_wvae_bigtts', name: 'Sofía', gender: 'female', scene: 'multilingual', tags: [], apiType: 'audio1', language: 'es' },
];

// ═══════════════════════════════════════════════════
// 有声阅读/配音 (mars/moon)
// ═══════════════════════════════════════════════════
const AUDIOBOOK_VOICES: VoiceMeta[] = [
  { id: 'ICL_zh_male_neiliancaijun_e991be511569_tob', name: '内敛才俊', gender: 'male', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_yangyang_v1_tob', name: '温暖少年', gender: 'male', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_buyan_v1_tob', name: '醇厚低音', gender: 'male', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_male_flc_v1_tob', name: '儒雅公子', gender: 'male', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'ICL_zh_female_qiuling_v1_tob', name: '倾心少女', gender: 'female', scene: 'audiobook', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_M100_conversation_wvae_bigtts', name: '悠悠君子', gender: 'male', scene: 'dubbing', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_maomao_conversation_wvae_bigtts', name: '文静毛毛', gender: 'female', scene: 'dubbing', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_sophie_conversation_wvae_bigtts', name: '魅力苏菲', gender: 'female', scene: 'dubbing', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_jason_conversation_wvae_bigtts', name: '开朗学长', gender: 'male', scene: 'dubbing', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_jitangmeimei_mars_bigtts', name: '鸡汤妹妹', gender: 'female', scene: 'dubbing', tags: ['抖音同款', '豆包同款'], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_tiexinnvsheng_mars_bigtts', name: '贴心女声', gender: 'female', scene: 'dubbing', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_female_mengyatou_mars_bigtts', name: '萌丫头', gender: 'female', scene: 'dubbing', tags: [], apiType: 'audio1', language: 'zh' },
  { id: 'zh_male_haoyuxiaoge_mars_bigtts', name: '浩宇小哥', gender: 'male', scene: 'dubbing', tags: ['豆包同款'], apiType: 'audio1', language: 'zh' },
];

// ═══════════════════════════════════════════════════
// 教育场景
// ═══════════════════════════════════════════════════
const EDUCATION_VOICES: VoiceMeta[] = [
  { id: 'zh_female_yingyujiaoyu_mars_bigtts', name: 'Tina老师', gender: 'female', scene: 'education', tags: [], apiType: 'audio1', language: 'zh' },
];

// ═══════════════════════════════════════════════════
// 合并所有音色
// ═══════════════════════════════════════════════════
export const ALL_VOICES: VoiceMeta[] = [
  ...TTS2_VOICES,
  ...SATURN_VOICES,
  ...GENERAL_VOICES,
  ...ROLEPLAY_VOICES,
  ...SERVICE_VOICES,
  ...MULTI_VOICES,
  ...AUDIOBOOK_VOICES,
  ...EDUCATION_VOICES,
];

/** 按场景筛选 */
export function filterByScene(scene: string): VoiceMeta[] {
  if (scene === 'all') return ALL_VOICES;
  return ALL_VOICES.filter((v) => v.scene === scene);
}

/** 按性别筛选 */
export function filterByGender(gender: string): VoiceMeta[] {
  if (gender === 'all') return ALL_VOICES;
  return ALL_VOICES.filter((v) => v.gender === gender);
}

/** 搜索音色 */
export function searchVoices(query: string): VoiceMeta[] {
  if (!query.trim()) return ALL_VOICES;
  const q = query.toLowerCase();
  return ALL_VOICES.filter(
    (v) => v.name.toLowerCase().includes(q) || v.id.toLowerCase().includes(q) || v.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

/** 判断音色应走哪个 API */
export function getApiType(voiceId: string): 'tts2' | 'audio1' | 'icl' {
  if (voiceId.includes('_uranus_bigtts')) return 'tts2';
  if (voiceId.startsWith('vc_') || voiceId.startsWith('ICL_zh_female_') || voiceId.startsWith('ICL_zh_male_')) {
    if (voiceId.endsWith('_tob')) return 'audio1';
    return 'icl';
  }
  return 'audio1';
}

/** 兼容旧命名 */
export const VOLC_VOICES = ALL_VOICES;

/** 示例文本（快速填入合成框） */
export const EXAMPLE_TEXTS: Array<{ id: string; label: string; text: string }> = [
  { id: 'greeting', label: '问候', text: '你好！很高兴认识你，我是你的AI语音助手。' },
  { id: 'story', label: '故事', text: '从前有一座山，山上有座庙，庙里有个老和尚在给小和尚讲故事。' },
  { id: 'news', label: '新闻', text: '据最新消息，今日沪深两市高开高走，创业板指涨幅超过2%。' },
  { id: 'service', label: '客服', text: '您好，欢迎致电客服中心。请问有什么可以帮助您的？' },
  { id: 'poetry', label: '诗词', text: '床前明月光，疑是地上霜。举头望明月，低头思故乡。' },
  { id: 'dialog', label: '对话', text: '女子（温柔语气）说：你好啊，今天过得怎么样？男子（沉稳语气）说：还不错，刚做完运动。' },
];

/** 语音指令预设 */
export const INSTRUCTION_PRESETS: Array<{ id: string; label: string; instruction: string }> = [
  { id: 'sad', label: '伤心', instruction: '你可以用特别特别痛心的语气说话吗？' },
  { id: 'cute', label: '撒娇', instruction: '请用撒娇可爱的语气说话。' },
  { id: 'angry', label: '生气', instruction: '用愤怒的语气说话。' },
  { id: 'whisper', label: '低语', instruction: '用轻声低语的方式说话，像在耳边。' },
  { id: 'story', label: '讲故事', instruction: '用讲故事的语调说话，缓慢而有节奏。' },
  { id: 'radio', label: '电台', instruction: '用情感电台DJ的风格说话。' },
  { id: 'dialect', label: '方言', instruction: '用方言口音说话。' },
  { id: 'ad', label: '广告', instruction: '用广告营销的语气说话，热情有力。' },
];
