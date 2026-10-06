// 音色数据常量 - 严格对齐火山官方"豆包语音合成模型2.0"音色列表
// 数据来源：https://volcengine.com/docs/6517/1257544
// 更新日期：2026-07-19
//
// 模型版本说明：
// - uranus 系列：豆包语音合成 2.0 标准版音色（resource_id = seed-tts-2.0, model = seed-tts-2.0-standard）
// - saturn 系列：豆包语音合成 2.0 旗舰版音色（resource_id = seed-tts-2.0, model = seed-tts-2.0-expressive）
// - ICL_uranus_*_tob：声音复刻 2.0 预设角色音色（合成用 resource_id = seed-tts-2.0, model = seed-tts-2.0-expressive）
// - en_*_uranus：多语种英文音色

export interface VoiceData {
  speakerId: string;
  name: string;
  description: string;
  type: string;          // official / cloned / designed
  category: string;      // 场景分类
  tags: string[];
  language: string;      // 主要语种
  gender: string;
  resourceId?: string;   // 对应的 X-Api-Resource-Id（默认 seed-tts-2.0）
  supportsCommand?: boolean; // 是否支持指令遵循（context_texts）
  specialTags?: string[];    // 特殊标签（抖音同款/豆包同款等）
  dialects?: string[];       // 支持的方言（仅 zh_female_vv_uranus_bigtts 支持）
}

// ============ 豆包语音合成 2.0 标准版（uranus）============
export const OFFICIAL_VOICES: VoiceData[] = [
  // ========== 通用场景 ==========
  { speakerId: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', description: '多语种情感阅读女声，支持中/日/印尼/墨西哥西语及四川/陕西/东北方言', type: 'official', category: '情感治愈', tags: ['情感阅读', '多语种', '方言'], language: 'zh-cn', gender: 'female', supportsCommand: true, dialects: ['sichuan', 'shaanxi', 'dongbei'] },
  { speakerId: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0', description: '陪聊情感女声，温柔自然', type: 'official', category: '情感治愈', tags: ['陪聊', '情感', '温柔'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0', description: '电台有声男声，沉稳大气', type: 'official', category: '影视解说', tags: ['电台', '有声', '沉稳'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0', description: '阳光活力男声', type: 'official', category: '短视频配音', tags: ['阳光', '活力'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0', description: '成熟稳重的男声，适合商业场景', type: 'official', category: '商业播报', tags: ['成熟', '稳重', '商业'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_sophie_uranus_bigtts', name: '魅力苏菲 2.0', description: '魅力女声，适合品牌宣传', type: 'official', category: '商业播报', tags: ['魅力', '品牌', '宣传'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声 2.0', description: '清新自然的女声', type: 'official', category: '情感治愈', tags: ['清新', '自然'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹 2.0', description: '撒娇学妹风格女声', type: 'official', category: '情感治愈', tags: ['撒娇', '学妹'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 2.0', description: '甜美可爱的女声', type: 'official', category: '情感治愈', tags: ['甜美', '可爱'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子 2.0', description: '甜美活泼的女声', type: 'official', category: '情感治愈', tags: ['甜美', '活泼'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 2.0', description: '亲切自然的邻家女孩声音', type: 'official', category: '短视频配音', tags: ['邻家', '亲切'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_meilinvyou_uranus_bigtts', name: '魅力女友 2.0', description: '魅力女友风格女声', type: 'official', category: '短视频配音', tags: ['魅力', '女友', '视频配音'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_wenroumama_uranus_bigtts', name: '温柔妈妈 2.0', description: '温柔慈爱的妈妈声音', type: 'official', category: '情感治愈', tags: ['温柔', '妈妈', '家庭'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_jieshuoxiaoming_uranus_bigtts', name: '解说小明 2.0', description: '专业解说风格的男声', type: 'official', category: '影视解说', tags: ['解说', '专业'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_tvbnv_uranus_bigtts', name: 'TVB女声 2.0', description: '港剧风格女声', type: 'official', category: '短视频配音', tags: ['TVB', '港剧', '粤语'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_yizhipiannan_uranus_bigtts', name: '译制片男 2.0', description: '译制片风格的男声', type: 'official', category: '影视解说', tags: ['译制片', '经典'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_qiaopinv_uranus_bigtts', name: '俏皮女声 2.0', description: '俏皮可爱的女声', type: 'official', category: '短视频配音', tags: ['俏皮', '可爱'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_linjiananhai_uranus_bigtts', name: '邻家男孩 2.0', description: '亲切自然的邻家男孩声音', type: 'official', category: '短视频配音', tags: ['邻家', '男孩'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_ruyaqingnian_uranus_bigtts', name: '儒雅青年 2.0', description: '儒雅有礼的青年男声', type: 'official', category: '商业播报', tags: ['儒雅', '青年'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['番茄小说同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_wennuanahu_uranus_bigtts', name: '温暖阿虎 2.0', description: '温暖亲切的男声', type: 'official', category: '情感治愈', tags: ['温暖', '亲切'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_naiqimengwa_uranus_bigtts', name: '奶气萌娃 2.0', description: '奶声奶气的萌娃声音', type: 'official', category: '角色动漫', tags: ['萌娃', '童声'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['剪映同款', '豆包同款'] },
  { speakerId: 'zh_female_popo_uranus_bigtts', name: '婆婆 2.0', description: '和蔼可亲的婆婆声音', type: 'official', category: '热门推荐', tags: ['婆婆', '和蔼'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐 2.0', description: '高冷御姐风格女声', type: 'official', category: '热门推荐', tags: ['高冷', '御姐'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_aojiaobazong_uranus_bigtts', name: '傲娇霸总 2.0', description: '傲娇霸道总裁男声', type: 'official', category: '角色动漫', tags: ['傲娇', '霸总'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_lanyinmianbao_uranus_bigtts', name: '懒音绵宝 2.0', description: '懒洋洋绵宝男声', type: 'official', category: '短视频配音', tags: ['懒音', '绵宝'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_fanjuanqingnian_uranus_bigtts', name: '反卷青年 2.0', description: '反卷风格青年男声', type: 'official', category: '短视频配音', tags: ['反卷', '青年'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_wenroushunv_uranus_bigtts', name: '温柔淑女 2.0', description: '温柔淑女风格女声', type: 'official', category: '情感治愈', tags: ['温柔', '淑女'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['番茄小说同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_huolixiaoge_uranus_bigtts', name: '活力小哥 2.0', description: '活力四射的小哥声音', type: 'official', category: '短视频配音', tags: ['活力', '小哥'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_mengyatou_uranus_bigtts', name: '萌丫头 2.0', description: '萌萌哒丫头声音', type: 'official', category: '短视频配音', tags: ['萌', '丫头'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_tiexinnvsheng_uranus_bigtts', name: '贴心女声 2.0', description: '贴心温暖的女声', type: 'official', category: '情感治愈', tags: ['贴心', '温暖'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_jitangmei_uranus_bigtts', name: '鸡汤妹妹 2.0', description: '治愈系鸡汤女声', type: 'official', category: '情感治愈', tags: ['鸡汤', '治愈'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款'] },
  { speakerId: 'zh_male_cixingjieshuonan_uranus_bigtts', name: '磁性解说男声 2.0', description: '磁性嗓音解说男声', type: 'official', category: '热门推荐', tags: ['磁性', '解说'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['抖音同款', '剪映同款'] },
  { speakerId: 'zh_male_liangsangmengzai_uranus_bigtts', name: '亮嗓萌仔 2.0', description: '响亮嗓音萌仔', type: 'official', category: '短视频配音', tags: ['亮嗓', '萌'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_kailangjiejie_uranus_bigtts', name: '开朗姐姐 2.0', description: '开朗活泼的姐姐声音', type: 'official', category: '短视频配音', tags: ['开朗', '姐姐'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_gaolengchenwen_uranus_bigtts', name: '高冷沉稳 2.0', description: '高冷沉稳的男声', type: 'official', category: '商业播报', tags: ['高冷', '沉稳'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['猫箱同款'] },
  { speakerId: 'zh_male_shenyeboke_uranus_bigtts', name: '深夜播客 2.0', description: '深夜播客风格男声', type: 'official', category: '热门推荐', tags: ['播客', '深夜'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_kailangdidi_uranus_bigtts', name: '开朗弟弟 2.0', description: '开朗可爱的弟弟声音', type: 'official', category: '热门推荐', tags: ['开朗', '弟弟'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['抖音同款', '剪映同款'] },
  { speakerId: 'zh_female_chanmeinv_uranus_bigtts', name: '谄媚女声 2.0', description: '谄媚风格女声', type: 'official', category: '热门推荐', tags: ['谄媚', '女声'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '剪映同款'] },
  { speakerId: 'zh_female_qinqienv_uranus_bigtts', name: '亲切女声 2.0', description: '亲切和蔼的女声', type: 'official', category: '短视频配音', tags: ['亲切', '和蔼'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['豆包同款'] },
  { speakerId: 'zh_male_kuailexiaodong_uranus_bigtts', name: '快乐小东 2.0', description: '快乐活泼的男声', type: 'official', category: '短视频配音', tags: ['快乐', '活泼'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['豆包同款'] },
  { speakerId: 'zh_male_kailangxuezhang_uranus_bigtts', name: '开朗学长 2.0', description: '开朗阳光的学长声音', type: 'official', category: '短视频配音', tags: ['开朗', '学长'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['豆包同款'] },
  { speakerId: 'zh_male_youyoujunzi_uranus_bigtts', name: '悠悠君子 2.0', description: '悠悠君子风格男声', type: 'official', category: '商业播报', tags: ['君子', '儒雅'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['豆包同款'] },
  { speakerId: 'zh_female_wenjingmaomao_uranus_bigtts', name: '文静毛毛 2.0', description: '文静可爱的女声', type: 'official', category: '短视频配音', tags: ['文静', '可爱'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['豆包同款'] },
  { speakerId: 'zh_female_zhixingnv_uranus_bigtts', name: '知性女声 2.0', description: '知性优雅的女声', type: 'official', category: '商业播报', tags: ['知性', '优雅'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_qingshuangnanda_uranus_bigtts', name: '清爽男大 2.0', description: '清爽大学生男声', type: 'official', category: '短视频配音', tags: ['清爽', '大学生'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['豆包同款'] },
  { speakerId: 'zh_male_yuanboxiaoshu_uranus_bigtts', name: '渊博小叔 2.0', description: '渊博知识型男声', type: 'official', category: '影视解说', tags: ['渊博', '知识'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_yangguangqingnian_uranus_bigtts', name: '阳光青年 2.0', description: '阳光积极的青年男声', type: 'official', category: '短视频配音', tags: ['阳光', '青年'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_qingchezizi_uranus_bigtts', name: '清澈梓梓 2.0', description: '清澈纯净的女声', type: 'official', category: '情感治愈', tags: ['清澈', '纯净'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_tianmeiyueyue_uranus_bigtts', name: '甜美悦悦 2.0', description: '甜美悦耳的女声', type: 'official', category: '情感治愈', tags: ['甜美', '悦耳'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_xinlingjitang_uranus_bigtts', name: '心灵鸡汤 2.0', description: '治愈心灵鸡汤女声', type: 'official', category: '情感治愈', tags: ['鸡汤', '治愈'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_wenrouxiaoge_uranus_bigtts', name: '温柔小哥 2.0', description: '温柔体贴的男声', type: 'official', category: '情感治愈', tags: ['温柔', '体贴'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_roumeinvyou_uranus_bigtts', name: '柔美女友 2.0', description: '柔美女友风格女声', type: 'official', category: '情感治愈', tags: ['柔美', '女友'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_dongfanghaoran_uranus_bigtts', name: '东方浩然 2.0', description: '东方浩然正气男声', type: 'official', category: '商业播报', tags: ['浩然', '正气'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_wenrouxiaoya_uranus_bigtts', name: '温柔小雅 2.0', description: '温柔典雅的女声', type: 'official', category: '情感治愈', tags: ['温柔', '典雅'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_tiancaitongsheng_uranus_bigtts', name: '天才童声 2.0', description: '天才儿童声音', type: 'official', category: '热门推荐', tags: ['天才', '童声'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_zhishuaiyingzi_uranus_bigtts', name: '直率英子 2.0', description: '直率英子女声', type: 'official', category: '热门推荐', tags: ['直率', '英子'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_guanggaojieshuo_uranus_bigtts', name: '广告解说 2.0', description: '广告解说风格男声', type: 'official', category: '影视解说', tags: ['广告', '解说'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['剪映同款'] },

  // ========== 角色扮演 ==========
  { speakerId: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0', description: '知性优雅的角色女声', type: 'official', category: '热门推荐', tags: ['知性', '角色'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_silang_uranus_bigtts', name: '四郎 2.0', description: '四郎角色男声', type: 'official', category: '热门推荐', tags: ['四郎', '角色'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_qingcang_uranus_bigtts', name: '擎苍 2.0', description: '擎苍角色男声', type: 'official', category: '热门推荐', tags: ['擎苍', '角色'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['番茄小说同款', '豆包同款', '抖音同款', '剪映同款'] },
  { speakerId: 'zh_male_xionger_uranus_bigtts', name: '熊二 2.0', description: '熊二角色男声', type: 'official', category: '热门推荐', tags: ['熊二', '角色'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_female_yingtaowanzi_uranus_bigtts', name: '樱桃丸子 2.0', description: '樱桃丸子角色女声', type: 'official', category: '热门推荐', tags: ['樱桃丸子', '角色'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_female_gufengshaoyu_uranus_bigtts', name: '古风少御 2.0', description: '古风少御角色女声', type: 'official', category: '角色动漫', tags: ['古风', '少御'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['番茄小说同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_lubanqihao_uranus_bigtts', name: '鲁班七号 2.0', description: '鲁班七号角色男声', type: 'official', category: '热门推荐', tags: ['鲁班', '角色'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_female_jiaochuannv_uranus_bigtts', name: '娇喘女声 2.0', description: '娇喘风格角色女声', type: 'official', category: '热门推荐', tags: ['娇喘', '女声'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '剪映同款'] },
  { speakerId: 'zh_female_linxiao_uranus_bigtts', name: '林潇 2.0', description: '林潇角色女声', type: 'official', category: '热门推荐', tags: ['林潇', '角色'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_female_lingling_uranus_bigtts', name: '玲玲姐姐 2.0', description: '玲玲姐姐角色女声', type: 'official', category: '热门推荐', tags: ['玲玲', '姐姐'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_female_chunribu_uranus_bigtts', name: '春日部姐姐 2.0', description: '春日部姐姐角色女声', type: 'official', category: '热门推荐', tags: ['春日部', '姐姐'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_tangseng_uranus_bigtts', name: '唐僧 2.0', description: '唐僧角色男声', type: 'official', category: '角色动漫', tags: ['唐僧', '角色'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['抖音同款', '豆包同款'] },
  { speakerId: 'zh_male_zhuangzhou_uranus_bigtts', name: '庄周 2.0', description: '庄周角色男声', type: 'official', category: '热门推荐', tags: ['庄周', '角色'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['抖音同款', '剪映同款'] },
  { speakerId: 'zh_male_zhubajie_uranus_bigtts', name: '猪八戒 2.0', description: '猪八戒角色男声', type: 'official', category: '角色动漫', tags: ['猪八戒', '角色'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['豆包同款', '剪映同款'] },
  { speakerId: 'zh_female_ganmaodianyin_uranus_bigtts', name: '感冒电音姐姐 2.0', description: '感冒电音风格角色女声', type: 'official', category: '热门推荐', tags: ['感冒', '电音'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '剪映同款'] },
  { speakerId: 'zh_female_nvleishen_uranus_bigtts', name: '女雷神 2.0', description: '女雷神角色女声', type: 'official', category: '角色动漫', tags: ['雷神', '角色'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['剪映同款', '豆包同款'] },
  { speakerId: 'zh_female_wuzetian_uranus_bigtts', name: '武则天 2.0', description: '武则天角色女声', type: 'official', category: '角色动漫', tags: ['武则天', '角色'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['剪映同款'] },
  { speakerId: 'zh_female_gujie_uranus_bigtts', name: '顾姐 2.0', description: '顾姐角色女声', type: 'official', category: '热门推荐', tags: ['顾姐', '角色'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '剪映同款'] },

  // ========== 角色扮演 saturn COT（最强语音指令能力）==========
  { speakerId: 'saturn_zh_female_aojiaonvyou_tob', name: '傲娇女友 COT', description: '傲娇女友，支持强语音指令COT', type: 'official', category: '短视频配音', tags: ['傲娇', '女友', 'COT', '强指令'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_bingjiaojiejie_tob', name: '病娇姐姐 COT', description: '病娇姐姐，支持COT', type: 'official', category: '短视频配音', tags: ['病娇', '姐姐', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_chengshujiejie_tob', name: '成熟姐姐 COT', description: '成熟姐姐，支持COT', type: 'official', category: '商业播报', tags: ['成熟', '姐姐', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_keainvsheng_tob', name: '可爱女生 COT', description: '可爱女生，支持COT', type: 'official', category: '短视频配音', tags: ['可爱', '女生', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_nuanxinxuejie_tob', name: '暖心学姐 COT', description: '暖心学姐，支持COT', type: 'official', category: '短视频配音', tags: ['暖心', '学姐', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_tiexinnvyou_tob', name: '贴心女友 COT', description: '贴心女友，支持COT', type: 'official', category: '情感治愈', tags: ['贴心', '女友', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_wenrouwenya_tob', name: '温柔文雅 COT', description: '温柔文雅，支持COT', type: 'official', category: '情感治愈', tags: ['温柔', '文雅', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_wumeiyujie_tob', name: '妩媚御姐 COT', description: '妩媚御姐，支持COT', type: 'official', category: '角色动漫', tags: ['妩媚', '御姐', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_xingganyujie_tob', name: '性感御姐 COT', description: '性感御姐，支持COT', type: 'official', category: '角色动漫', tags: ['性感', '御姐', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_aoqilingren_tob', name: '傲气凌人 COT', description: '傲气凌人，支持COT', type: 'official', category: '短视频配音', tags: ['傲气', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_male_cixingnansang_tob', name: '磁性男嗓 COT', description: '磁性男嗓，支持COT', type: 'official', category: '影视解说', tags: ['磁性', '男嗓', 'COT'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_male_cujingnanyou_tob', name: '醋精男友 COT', description: '醋精男友，支持COT', type: 'official', category: '短视频配音', tags: ['醋精', '男友', 'COT'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_male_fengfashaonian_tob', name: '风发少年 COT', description: '风发少年，支持COT', type: 'official', category: '短视频配音', tags: ['少年', 'COT'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_male_fuheigongzi_tob', name: '腹黑公子 COT', description: '腹黑公子，支持COT', type: 'official', category: '短视频配音', tags: ['腹黑', '公子', 'COT'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_male_shuanglangshaonian_tob', name: '爽朗少年 COT', description: '爽朗少年，支持COT', type: 'official', category: '短视频配音', tags: ['爽朗', '少年', 'COT'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_male_tiancaitongzhuo_tob', name: '天才同桌 COT', description: '天才同桌，支持COT', type: 'official', category: '角色动漫', tags: ['天才', '同桌', 'COT'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },

  // ========== 视频配音（saturn 旗舰版）==========
  { speakerId: 'zh_male_dayi_saturn_bigtts', name: '大壹 2.0旗舰', description: '大壹视频配音男声（saturn旗舰版）', type: 'official', category: '短视频配音', tags: ['大壹', '视频配音', '旗舰'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'zh_female_mizai_saturn_bigtts', name: '黑猫侦探社咪仔 2.0旗舰', description: '黑猫侦探社咪仔视频配音女声（saturn旗舰版）', type: 'official', category: '短视频配音', tags: ['咪仔', '视频配音', '旗舰'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'zh_female_jitangnv_saturn_bigtts', name: '鸡汤女 2.0旗舰', description: '鸡汤女视频配音女声（saturn旗舰版）', type: 'official', category: '情感治愈', tags: ['鸡汤', '视频配音', '旗舰'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'zh_female_meilinvyou_saturn_bigtts', name: '魅力女友 2.0旗舰', description: '魅力女友视频配音女声（saturn旗舰版）', type: 'official', category: '短视频配音', tags: ['魅力', '女友', '旗舰'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'zh_female_santongyongns_saturn_bigtts', name: '流畅女声 2.0旗舰', description: '流畅女声视频配音（saturn旗舰版）', type: 'official', category: '短视频配音', tags: ['流畅', '视频配音', '旗舰'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'zh_male_ruyayichen_saturn_bigtts', name: '儒雅逸辰 2.0旗舰', description: '儒雅逸辰视频配音男声（saturn旗舰版）', type: 'official', category: '商业播报', tags: ['儒雅', '逸辰', '旗舰'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },

  // ========== 视频配音（uranus）==========
  { speakerId: 'zh_female_peiqi_uranus_bigtts', name: '佩奇猪 2.0', description: '佩奇猪视频配音女声', type: 'official', category: '热门推荐', tags: ['佩奇', '视频配音'], language: 'zh-cn', gender: 'female', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_sunwukong_uranus_bigtts', name: '猴哥 2.0', description: '猴哥视频配音男声', type: 'official', category: '短视频配音', tags: ['猴哥', '视频配音'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_male_dayi_uranus_bigtts', name: '大壹 2.0', description: '大壹视频配音男声', type: 'official', category: '短视频配音', tags: ['大壹', '视频配音'], language: 'zh-cn', gender: 'male', supportsCommand: true },
  { speakerId: 'zh_female_mizai_uranus_bigtts', name: '黑猫侦探社咪仔 2.0', description: '黑猫侦探社咪仔视频配音女声', type: 'official', category: '短视频配音', tags: ['咪仔', '视频配音'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_jitangnv_uranus_bigtts', name: '鸡汤女 2.0', description: '鸡汤女视频配音女声', type: 'official', category: '情感治愈', tags: ['鸡汤', '视频配音'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_liuchangnv_uranus_bigtts', name: '流畅女声 2.0', description: '流畅女声视频配音', type: 'official', category: '短视频配音', tags: ['流畅', '视频配音'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_male_ruyayichen_uranus_bigtts', name: '儒雅逸辰 2.0', description: '儒雅逸辰视频配音男声', type: 'official', category: '商业播报', tags: ['儒雅', '逸辰'], language: 'zh-cn', gender: 'male', supportsCommand: true },

  // ========== 教育场景 ==========
  { speakerId: 'zh_female_yingyujiaoxue_uranus_bigtts', name: 'Tina老师 2.0', description: 'Tina老师教育女声，支持中英双语及英式英语', type: 'official', category: '短视频配音', tags: ['教育', '英语', '双语'], language: 'zh-cn', gender: 'female', supportsCommand: true },

  // ========== 客服场景 ==========
  { speakerId: 'zh_female_kefunvsheng_uranus_bigtts', name: '暖阳女声 2.0', description: '暖阳女声客服女声', type: 'official', category: '商业播报', tags: ['客服', '暖阳'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  // 客服 saturn COT 版
  { speakerId: 'saturn_zh_female_qingyingduoduo_cs_tob', name: '轻盈朵朵 COT', description: '轻盈朵朵，客服COT', type: 'official', category: '商业播报', tags: ['客服', '轻盈', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_wenwanshanshan_cs_tob', name: '温婉珊珊 COT', description: '温婉珊珊，客服COT', type: 'official', category: '商业播报', tags: ['客服', '温婉', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_female_reqingaina_cs_tob', name: '热情艾娜 COT', description: '热情艾娜，客服COT', type: 'official', category: '商业播报', tags: ['客服', '热情', 'COT'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'saturn_zh_male_qingxinmumu_cs_tob', name: '清新沐沐 COT', description: '清新沐沐，客服COT', type: 'official', category: '情感治愈', tags: ['客服', '清新', 'COT'], language: 'zh-cn', gender: 'male', resourceId: 'seed-tts-2.0', supportsCommand: true },

  // ========== 有声阅读 ==========
  { speakerId: 'zh_female_xiaoxue_uranus_bigtts', name: '儿童绘本 2.0', description: '儿童绘本有声阅读女声', type: 'official', category: '影视解说', tags: ['儿童', '绘本', '有声'], language: 'zh-cn', gender: 'female', supportsCommand: true },
  { speakerId: 'zh_female_xueayi_saturn_bigtts', name: '儿童绘本 2.0旗舰', description: '儿童绘本有声阅读女声（saturn旗舰版）', type: 'official', category: '影视解说', tags: ['儿童', '绘本', '旗舰'], language: 'zh-cn', gender: 'female', resourceId: 'seed-tts-2.0', supportsCommand: true },
  { speakerId: 'zh_male_baqiqingshu_uranus_bigtts', name: '霸气青叔 2.0', description: '霸气青叔有声阅读男声', type: 'official', category: '影视解说', tags: ['青叔', '霸气', '有声'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['番茄小说同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_male_xuanyijieshuo_uranus_bigtts', name: '悬疑解说 2.0', description: '悬疑解说有声阅读男声', type: 'official', category: '热门推荐', tags: ['悬疑', '解说', '有声'], language: 'zh-cn', gender: 'male', supportsCommand: true, specialTags: ['抖音同款', '豆包同款', '剪映同款'] },
  { speakerId: 'zh_female_shaoergushi_uranus_bigtts', name: '少儿故事 2.0', description: '少儿故事有声阅读女声', type: 'official', category: '影视解说', tags: ['少儿', '故事', '有声'], language: 'zh-cn', gender: 'female', supportsCommand: true },

  // ========== 角色扮演 ICL 预设（resource_id = seed-icl-2.0）==========
  { speakerId: 'ICL_uranus_zh_female_kefuwanjun_tob', name: '客服婉君 2.0', description: '客服婉君角色女声', type: 'official', category: '商业播报', tags: ['客服', '婉君', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_aojiaonvyou_tob', name: '傲娇女友 2.0', description: '傲娇女友角色女声', type: 'official', category: '短视频配音', tags: ['傲娇', '女友', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['豆包同款', '猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_aomanjiaosheng_tob', name: '傲慢娇声 2.0', description: '傲慢娇声角色女声', type: 'official', category: '短视频配音', tags: ['傲慢', '娇声', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_xiemeinvwang_tob', name: '邪魅女王 2.0', description: '邪魅女王角色女声', type: 'official', category: '短视频配音', tags: ['邪魅', '女王', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_bingjiaojiejie_tob', name: '病娇姐姐 2.0', description: '病娇姐姐角色女声', type: 'official', category: '短视频配音', tags: ['病娇', '姐姐', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['豆包同款', '猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_bingjiaomengmei_tob', name: '病娇萌妹 2.0', description: '病娇萌妹角色女声', type: 'official', category: '短视频配音', tags: ['病娇', '萌妹', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_chengshuwenrou_tob', name: '成熟温柔 2.0', description: '成熟温柔角色女声', type: 'official', category: '情感治愈', tags: ['成熟', '温柔', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_chengshujiejie_tob', name: '成熟姐姐 2.0', description: '成熟姐姐角色女声', type: 'official', category: '商业播报', tags: ['成熟', '姐姐', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['豆包同款', '猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_chunzhenshaonv_tob', name: '纯真少女 2.0', description: '纯真少女角色女声', type: 'official', category: '短视频配音', tags: ['纯真', '少女', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['豆包同款'] },
  { speakerId: 'ICL_uranus_zh_female_chunchenvsheng_tob', name: '纯澈女生 2.0', description: '纯澈女生角色女声', type: 'official', category: '短视频配音', tags: ['纯澈', '女生', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_wumeikeren_tob', name: '妩媚可人 2.0', description: '妩媚可人角色女声', type: 'official', category: '短视频配音', tags: ['妩媚', '可人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_guaiqiaokeer_tob', name: '乖巧可儿 2.0', description: '乖巧可儿客服女声', type: 'official', category: '商业播报', tags: ['乖巧', '可儿', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_heainainai_tob', name: '和蔼奶奶 2.0', description: '和蔼奶奶角色女声', type: 'official', category: '短视频配音', tags: ['奶奶', '和蔼', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_huopodiaoman_tob', name: '活泼刁蛮 2.0', description: '活泼刁蛮角色女声', type: 'official', category: '短视频配音', tags: ['活泼', '刁蛮', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_huoponvhai_tob', name: '活泼女孩 2.0', description: '活泼女孩角色女声', type: 'official', category: '短视频配音', tags: ['活泼', '女孩', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_jiaohannvwang_tob', name: '娇憨女王 2.0', description: '娇憨女王角色女声', type: 'official', category: '短视频配音', tags: ['娇憨', '女王', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_jiaoruoluoli_tob', name: '娇弱萝莉 2.0', description: '娇弱萝莉角色女声', type: 'official', category: '短视频配音', tags: ['娇弱', '萝莉', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['猫箱同款'] },
  { speakerId: 'ICL_uranus_zh_female_jiaxiaozi_tob', name: '假小子 2.0', description: '假小子角色女声', type: 'official', category: '角色动漫', tags: ['假小子', '角色', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true, specialTags: ['豆包同款', '猫箱同款'] },

  // ========== ICL 接近真人角色（补充）==========
  { speakerId: 'ICL_uranus_zh_female_wenrounvshen_tob', name: '温柔女神 2.0', description: '温柔女神，接近真人', type: 'official', category: '情感治愈', tags: ['温柔', '女神', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_zhixinjiejie_tob', name: '知心姐姐 2.0', description: '知心姐姐，接近真人', type: 'official', category: '短视频配音', tags: ['知心', '姐姐', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_yuanqitianmei_tob', name: '元气甜妹 2.0', description: '元气甜妹，接近真人', type: 'official', category: '情感治愈', tags: ['元气', '甜妹', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_bingruoshaonv_tob', name: '病弱少女 2.0', description: '病弱少女，接近真人', type: 'official', category: '短视频配音', tags: ['病弱', '少女', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_jinglingxiangdao_tob', name: '精灵向导 2.0', description: '精灵向导，接近真人', type: 'official', category: '短视频配音', tags: ['精灵', '向导', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_tianmeijiaoqiao_tob', name: '甜美娇俏 2.0', description: '甜美娇俏，接近真人', type: 'official', category: '情感治愈', tags: ['甜美', '娇俏', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_qinglenggaoya_tob', name: '清冷高雅 2.0', description: '清冷高雅，接近真人', type: 'official', category: '短视频配音', tags: ['清冷', '高雅', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_xingganmeihuo_tob', name: '性感魅惑 2.0', description: '性感魅惑，接近真人', type: 'official', category: '短视频配音', tags: ['性感', '魅惑', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_qingxinshaonv_tob', name: '倾心少女 2.0', description: '倾心少女，接近真人', type: 'official', category: '短视频配音', tags: ['倾心', '少女', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_rouguhunshi_tob', name: '柔骨魂师 2.0', description: '柔骨魂师，接近真人', type: 'official', category: '短视频配音', tags: ['柔骨', '魂师', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_ruanmengtuanzi_tob', name: '软萌团子 2.0', description: '软萌团子，接近真人', type: 'official', category: '短视频配音', tags: ['软萌', '团子', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_tianmeihuopo_tob', name: '甜美活泼 2.0', description: '甜美活泼，接近真人', type: 'official', category: '情感治愈', tags: ['甜美', '活泼', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_tiaopigongzhu_tob', name: '调皮公主 2.0', description: '调皮公主，接近真人', type: 'official', category: '短视频配音', tags: ['调皮', '公主', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_xiemeiyujie_tob', name: '邪魅御姐 2.0', description: '邪魅御姐，接近真人', type: 'official', category: '角色动漫', tags: ['邪魅', '御姐', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_linjuayi_tob', name: '邻居阿姨 2.0', description: '邻居阿姨，接近真人', type: 'official', category: '短视频配音', tags: ['邻居', '阿姨', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },

  // ========== ICL 接近真人客服（补充）==========
  { speakerId: 'ICL_uranus_zh_female_kailangtingting_tob', name: '开朗婷婷 2.0', description: '开朗婷婷，接近真人', type: 'official', category: '短视频配音', tags: ['开朗', '婷婷', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_kaixinxiaohong_tob', name: '开心小鸿 2.0', description: '开心小鸿，接近真人', type: 'official', category: '短视频配音', tags: ['开心', '小鸿', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_lingdongxinxin_tob', name: '灵动欣欣 2.0', description: '灵动欣欣，接近真人', type: 'official', category: '短视频配音', tags: ['灵动', '欣欣', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_lixingyuanzi_tob', name: '理性圆子 2.0', description: '理性圆子，接近真人', type: 'official', category: '短视频配音', tags: ['理性', '圆子', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_nuanxinqianqian_tob', name: '暖心茜茜 2.0', description: '暖心茜茜，接近真人', type: 'official', category: '短视频配音', tags: ['暖心', '茜茜', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_qingtianmeimei_tob', name: '清甜莓莓 2.0', description: '清甜莓莓，接近真人', type: 'official', category: '短视频配音', tags: ['清甜', '莓莓', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_qingtiantaotao_tob', name: '清甜桃桃 2.0', description: '清甜桃桃，接近真人', type: 'official', category: '短视频配音', tags: ['清甜', '桃桃', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_qingxixiaoxue_tob', name: '清晰小雪 2.0', description: '清晰小雪，接近真人', type: 'official', category: '短视频配音', tags: ['清晰', '小雪', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_ruanmengtangtang_tob', name: '软萌糖糖 2.0', description: '软萌糖糖，接近真人', type: 'official', category: '短视频配音', tags: ['软萌', '糖糖', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_tianmeixiaoju_tob', name: '甜美小橘 2.0', description: '甜美小橘，接近真人', type: 'official', category: '情感治愈', tags: ['甜美', '小橘', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
  { speakerId: 'ICL_uranus_zh_female_tianmeixiaoyu_tob', name: '甜美小雨 2.0', description: '甜美小雨，接近真人', type: 'official', category: '情感治愈', tags: ['甜美', '小雨', '接近真人', 'ICL'], language: 'zh-cn', gender: 'female', resourceId: 'seed-icl-2.0', supportsCommand: true },
];

// ============ 场景分类 ============
export const CATEGORIES = ['热门推荐', '影视解说', '角色动漫', '情感治愈', '短视频配音', '商业播报'];

export const CATEGORY_GROUPS: Record<string, { label: string; icon: string }> = {
  '热门推荐': { label: '热门推荐', icon: '🔥' },
  '影视解说': { label: '影视解说', icon: '🎬' },
  '角色动漫': { label: '角色动漫', icon: '🎭' },
  '情感治愈': { label: '情感治愈', icon: '💝' },
  '短视频配音': { label: '短视频配音', icon: '📱' },
  '商业播报': { label: '商业播报', icon: '💼' },
};

// ============ 资源 ID（X-Api-Resource-Id）枚举 ============
// 注意：所有 TTS 合成（含 ICL 预设角色）统一用 seed-tts-2.0
// seed-icl-2.0 仅用于声音复刻/声音设计接口，不用于语音合成
export const RESOURCE_IDS = [
  { value: 'seed-tts-2.0', label: '语音合成 2.0（所有音色统一使用）' },
  { value: 'seed-tts-1.0', label: '语音合成 1.0（旧版音色）' },
  { value: 'seed-tts-1.0-concurr', label: '语音合成 1.0 并发版' },
  { value: 'seed-icl-2.0', label: '声音复刻 2.0（仅克隆/设计接口）' },
  { value: 'seed-icl-1.0', label: '声音复刻 1.0' },
  { value: 'seed-icl-1.0-concurr', label: '声音复刻 1.0 并发版' },
] as const;

// ============ 模型版本（req_params.model）============
export const MODEL_VERSIONS = [
  { value: 'auto', label: '自动匹配（推荐）' },
  { value: 'seed-tts-2.0-standard', label: '标准版（uranus 音色必选）' },
  { value: 'seed-tts-2.0-expressive', label: '表现力增强版（saturn/ICL 音色，支持语音指令）' },
] as const;

// ============ 音频格式 ============
export const AUDIO_FORMATS = [
  { value: 'mp3', label: 'MP3' },
  { value: 'wav', label: 'WAV（无损）' },
  { value: 'pcm', label: 'PCM（裸数据，流式推荐）' },
  { value: 'ogg_opus', label: 'OGG Opus' },
] as const;

// ============ 采样率 ============
export const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000] as const;

// ============ 明确语种 explicit_language ============
export const EXPLICIT_LANGUAGES = [
  { value: '', label: '不指定（默认中英混）' },
  { value: 'zh-cn', label: '中文（中英混）' },
  { value: 'en', label: '仅英文' },
  { value: 'ja', label: '仅日文' },
  { value: 'es-mx', label: '仅墨西哥西班牙语' },
  { value: 'id', label: '仅印尼语' },
  { value: 'pt-br', label: '仅巴西葡萄牙语' },
  { value: 'ko', label: '仅韩语（仅 ICL 2.0 model_type=5）' },
  { value: 'de', label: '仅德语（仅 DIT 复刻）' },
  { value: 'fr', label: '仅法语（仅 DIT 复刻）' },
  { value: 'crosslingual', label: '多语种前端（ICL 1.0）' },
] as const;

// ============ 明确方言 explicit_dialect（仅 zh_female_vv_uranus_bigtts 支持）============
export const EXPLICIT_DIALECTS = [
  { value: '', label: '不指定' },
  { value: 'dongbei', label: '东北话' },
  { value: 'shaanxi', label: '陕西话' },
  { value: 'sichuan', label: '四川话' },
] as const;

// ============ 情感枚举（仅部分音色支持，需根据音色动态显示）============
export const EMOTIONS = [
  { value: '', label: '不指定' },
  { value: 'happy', label: '开心' },
  { value: 'sad', label: '悲伤' },
  { value: 'angry', label: '生气' },
  { value: 'surprised', label: '惊讶' },
  { value: 'neutral', label: '中性' },
] as const;

// ============ 工具函数 ============
export function filterVoices(voices: VoiceData[], search: string, category: string, gender: string): VoiceData[] {
  return voices.filter((v) => {
    if (search && !v.name.includes(search) && !v.speakerId.includes(search)) return false;
    if (category && category !== '全部' && v.category !== category) return false;
    if (gender && gender !== '全部' && v.gender !== gender) return false;
    return true;
  });
}

export function getVoicesByCategory(voices: VoiceData[], category: string): VoiceData[] {
  return voices.filter((v) => v.category === category);
}

// 根据音色ID判断对应的 resource_id
// 实测结论（2026-07-19）：所有 TTS 2.0 音色（包括 ICL 预设角色）均使用 seed-tts-2.0
// seed-icl-2.0 仅用于声音复刻(voice_clone)和声音设计(voice_design)接口，不用于合成
export function getResourceIdBySpeaker(speakerId: string): string {
  // 所有官方音色（uranus/saturn/ICL预设角色）统一用 seed-tts-2.0
  return 'seed-tts-2.0';
}

// 根据音色ID判断默认的 model（用户未指定 model 时使用）
// 实测结论（2026-07-19）：
//   - uranus 系列 (_uranus_bigtts) 仅支持 seed-tts-2.0-standard，用 expressive 会返回空音频
//   - saturn 系列 (_saturn_bigtts / saturn_zh_*_tob) 支持 seed-tts-2.0-expressive
//   - ICL 预设角色 (ICL_*) 支持 seed-tts-2.0-expressive
export function getDefaultModelBySpeaker(speakerId: string): string {
  if (speakerId.endsWith('_uranus_bigtts')) {
    return 'seed-tts-2.0-standard';
  }
  // saturn_bigtts / saturn_zh_*_tob / ICL_* 都支持 expressive
  return 'seed-tts-2.0-expressive';
}

// 判断音色是否支持语音指令 context_texts
// 支持：TTS2.0（uranus/saturn_bigtts）+ ICL2.0（ICL_/saturn_zh_xxx_tob）+ 表现力增强版
export function isCommandSupported(speakerId: string): boolean {
  return (
    speakerId.endsWith('_uranus_bigtts') ||
    speakerId.endsWith('_saturn_bigtts') ||
    speakerId.startsWith('ICL_uranus_') ||
    speakerId.startsWith('saturn_zh_')
  );
}

// 判断音色是否支持方言（仅 zh_female_vv_uranus_bigtts）
export function isDialectSupported(speakerId: string): boolean {
  return speakerId === 'zh_female_vv_uranus_bigtts';
}

// 判断音色是否支持 COT/QA（仅 saturn 新版 saturn_zh_xxx_tob）
export function isCotSupported(speakerId: string): boolean {
  return speakerId.startsWith('saturn_zh_');
}
