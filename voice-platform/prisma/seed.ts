import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// 火山引擎"豆包语音合成模型2.0"完整音色库
// 规则：名称简洁（无版本后缀），重名保留能力最强版（COT>旗舰>uranus>ICL）
// 分类精简为5类：通用场景/角色扮演/经典人物/客服/多语种

interface VoiceSeed {
  speakerId: string;
  name: string;
  description: string;
  type: string;        // official / icl
  category: string;    // 通用场景/角色扮演/经典人物/客服/多语种
  tags: string[];
  language: string;
  gender: string;
  isRealVoice?: boolean;
  tier?: string;       // 能力层级：cot(最强) / flagship(旗舰) / standard(标准)
}

const voices: VoiceSeed[] = [
  // ========== 通用场景 - 女声 ==========
  { speakerId: 'zh_female_vv_uranus_bigtts', name: 'Vivi', description: '多语种情感阅读女声，支持中英日及方言', type: 'official', category: '通用场景', tags: ['情感阅读', '多语种', '方言', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_xiaohe_uranus_bigtts', name: '小何', description: '陪聊情感女声，温柔自然', type: 'official', category: '通用场景', tags: ['陪聊', '情感', '温柔'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_sophie_uranus_bigtts', name: '魅力苏菲', description: '魅力女声，适合品牌宣传', type: 'official', category: '通用场景', tags: ['魅力', '品牌'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声', description: '清新自然的女声', type: 'official', category: '通用场景', tags: ['清新', '自然'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源', description: '甜美可爱的女声', type: 'official', category: '通用场景', tags: ['甜美', '可爱'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子', description: '甜美活泼的女声', type: 'official', category: '通用场景', tags: ['甜美', '活泼'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思', description: '爽快干练的女声', type: 'official', category: '通用场景', tags: ['爽快', '干练'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩', description: '邻家女孩般亲切自然', type: 'official', category: '通用场景', tags: ['邻家', '亲切'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_meilinvyou_uranus_bigtts', name: '魅力女友', description: '魅力女友音色', type: 'official', category: '通用场景', tags: ['女友', '魅力'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_wenroumama_uranus_bigtts', name: '温柔妈妈', description: '温柔妈妈音色，适合治愈/亲子', type: 'official', category: '通用场景', tags: ['温柔', '妈妈', '治愈'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_tvbnv_uranus_bigtts', name: 'TVB女声', description: 'TVB港剧风格女声', type: 'official', category: '通用场景', tags: ['TVB', '港剧', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_qiaopinv_uranus_bigtts', name: '俏皮女声', description: '俏皮活泼的女声', type: 'official', category: '通用场景', tags: ['俏皮', '活泼'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_popo_uranus_bigtts', name: '婆婆', description: '老年女性音色，适合长辈角色', type: 'official', category: '通用场景', tags: ['老年', '长辈', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐', description: '高冷霸气的御姐女声', type: 'official', category: '通用场景', tags: ['高冷', '御姐', '霸气'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_gufengshaoyu_uranus_bigtts', name: '古风少御', description: '古风少御女声，适合古风配音', type: 'official', category: '通用场景', tags: ['古风', '少御'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_mengyatou_uranus_bigtts', name: '萌丫头', description: '萌萌的丫头音色', type: 'official', category: '通用场景', tags: ['萌', '可爱'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_tiexinnvsheng_uranus_bigtts', name: '贴心女声', description: '贴心温暖的女声，适合治愈/电台', type: 'official', category: '通用场景', tags: ['贴心', '温暖', '治愈'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_jitangmei_uranus_bigtts', name: '鸡汤妹妹', description: '鸡汤妹妹，适合情感语录/心灵鸡汤', type: 'official', category: '通用场景', tags: ['鸡汤', '情感', '语录'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_kailangjiejie_uranus_bigtts', name: '开朗姐姐', description: '开朗活泼的姐姐音色', type: 'official', category: '通用场景', tags: ['开朗', '姐姐'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_jiaochuannv_uranus_bigtts', name: '娇喘女声', description: '娇喘女声音色', type: 'official', category: '通用场景', tags: ['娇喘', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_ganmaodianyin_uranus_bigtts', name: '感冒电音姐姐', description: '感冒电音风格女声', type: 'official', category: '通用场景', tags: ['感冒', '电音', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_chanmeinv_uranus_bigtts', name: '谄媚女声', description: '谄媚风格的女声', type: 'official', category: '通用场景', tags: ['谄媚', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_qinqienv_uranus_bigtts', name: '亲切女声', description: '亲切自然的女声', type: 'official', category: '通用场景', tags: ['亲切', '自然'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_wenjingmaomao_uranus_bigtts', name: '文静毛毛', description: '文静温柔的女声', type: 'official', category: '通用场景', tags: ['文静', '温柔'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_zhixingnv_uranus_bigtts', name: '知性女声', description: '知性大气的女声', type: 'official', category: '通用场景', tags: ['知性', '大气'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_qingchezizi_uranus_bigtts', name: '清澈梓梓', description: '清澈干净的少女音', type: 'official', category: '通用场景', tags: ['清澈', '少女'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_tianmeiyueyue_uranus_bigtts', name: '甜美悦悦', description: '甜美的悦悦女声', type: 'official', category: '通用场景', tags: ['甜美', '悦悦'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_xinlingjitang_uranus_bigtts', name: '心灵鸡汤', description: '心灵鸡汤女声，适合情感语录', type: 'official', category: '通用场景', tags: ['心灵鸡汤', '情感'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_roumeinvyou_uranus_bigtts', name: '柔美女友', description: '柔美的女友音色', type: 'official', category: '通用场景', tags: ['柔美', '女友'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_wenrouxiaoya_uranus_bigtts', name: '温柔小雅', description: '温柔的小雅女声', type: 'official', category: '通用场景', tags: ['温柔', '小雅'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_kefunvsheng_uranus_bigtts', name: '暖阳女声', description: '暖阳般温暖的女声', type: 'official', category: '通用场景', tags: ['暖阳', '温暖'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿', description: '知性灿灿女声', type: 'official', category: '通用场景', tags: ['知性', '灿灿'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹', description: '撒娇学妹女声', type: 'official', category: '通用场景', tags: ['撒娇', '学妹'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_zhishuaiyingzi_uranus_bigtts', name: '直率英子', description: '直率英子女声，抖音爆款', type: 'official', category: '通用场景', tags: ['直率', '英子', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_yingtaowanzi_uranus_bigtts', name: '樱桃丸子', description: '樱桃丸子女声，可爱俏皮', type: 'official', category: '通用场景', tags: ['樱桃丸子', '可爱', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_lingling_uranus_bigtts', name: '玲玲姐姐', description: '玲玲姐姐女声', type: 'official', category: '通用场景', tags: ['玲玲', '姐姐', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_chunribu_uranus_bigtts', name: '春日部姐姐', description: '春日部姐姐女声', type: 'official', category: '通用场景', tags: ['春日部', '姐姐', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_linxiao_uranus_bigtts', name: '林潇', description: '林潇女声，江湖侠气', type: 'official', category: '通用场景', tags: ['林潇', '侠气', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_nvleishen_uranus_bigtts', name: '女雷神', description: '女雷神音色，霸气', type: 'official', category: '通用场景', tags: ['雷神', '霸气'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_wenroushunv_uranus_bigtts', name: '温柔淑女', description: '温柔淑女女声', type: 'official', category: '通用场景', tags: ['温柔', '淑女'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_gujie_uranus_bigtts', name: '顾姐', description: '顾姐女声，干练大气', type: 'official', category: '通用场景', tags: ['顾姐', '干练', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_peiqi_uranus_bigtts', name: '佩奇猪', description: '佩奇猪女声，动画角色', type: 'official', category: '经典人物', tags: ['佩奇', '动画', '抖音同款'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_mizai_uranus_bigtts', name: '黑猫侦探咪仔', description: '黑猫侦探社咪仔女声', type: 'official', category: '通用场景', tags: ['黑猫侦探', '咪仔'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_jitangnv_uranus_bigtts', name: '鸡汤女', description: '鸡汤女声，情感语录', type: 'official', category: '通用场景', tags: ['鸡汤', '情感'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_liuchangnv_uranus_bigtts', name: '流畅女声', description: '流畅自然的女声', type: 'official', category: '通用场景', tags: ['流畅', '自然'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_xiaoxue_uranus_bigtts', name: '儿童绘本', description: '儿童绘本女声，适合亲子内容', type: 'official', category: '通用场景', tags: ['儿童', '绘本', '亲子'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_shaoergushi_uranus_bigtts', name: '少儿故事', description: '少儿故事女声，适合儿童内容', type: 'official', category: '通用场景', tags: ['少儿', '故事', '儿童'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_yingyujiaoxue_uranus_bigtts', name: 'Tina老师', description: 'Tina老师女声，中英双语教学', type: 'official', category: '通用场景', tags: ['Tina', '老师', '英语'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_female_xueayi_saturn_bigtts', name: '儿童绘本旗舰版', description: '儿童绘本女声，适合亲子内容（saturn旗舰版，2025年11月上新）', type: 'official', category: '通用场景', tags: ['儿童', '绘本', '亲子', '旗舰'], language: 'zh-cn', gender: 'female', tier: 'flagship' },

  // ========== 通用场景 - 男声 ==========
  { speakerId: 'zh_male_m191_uranus_bigtts', name: '云舟', description: '电台有声男声，沉稳大气', type: 'official', category: '通用场景', tags: ['电台', '有声', '沉稳'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_taocheng_uranus_bigtts', name: '小天', description: '阳光活力男声', type: 'official', category: '通用场景', tags: ['阳光', '活力'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_liufei_uranus_bigtts', name: '刘飞', description: '成熟稳重的男声，适合商业场景', type: 'official', category: '通用场景', tags: ['成熟', '稳重', '商业'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_jieshuoxiaoming_uranus_bigtts', name: '解说小明', description: '解说男声，适合短视频/影视解说', type: 'official', category: '通用场景', tags: ['解说', '小明', '短视频'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_yizhipiannan_uranus_bigtts', name: '译制片男', description: '译制片风格男声', type: 'official', category: '通用场景', tags: ['译制片', '配音'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_linjiananhai_uranus_bigtts', name: '邻家男孩', description: '邻家男孩般亲切的男声', type: 'official', category: '通用场景', tags: ['邻家', '男孩'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_wennuanahu_uranus_bigtts', name: '温暖阿虎', description: '温暖阳光的男声阿虎', type: 'official', category: '通用场景', tags: ['温暖', '阳光'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_naiqimengwa_uranus_bigtts', name: '奶气萌娃', description: '奶气可爱的萌娃男声', type: 'official', category: '通用场景', tags: ['奶气', '萌娃', '可爱'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_fanjuanqingnian_uranus_bigtts', name: '反卷青年', description: '反卷青年男声，随性自然', type: 'official', category: '通用场景', tags: ['反卷', '青年'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_huolixiaoge_uranus_bigtts', name: '活力小哥', description: '活力十足的小哥男声', type: 'official', category: '通用场景', tags: ['活力', '小哥'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_cixingjieshuonan_uranus_bigtts', name: '磁性解说男声', description: '磁性解说男声，适合影视/广告解说', type: 'official', category: '通用场景', tags: ['磁性', '解说', '抖音同款'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_liangsangmengzai_uranus_bigtts', name: '亮嗓萌仔', description: '亮嗓的萌仔男声', type: 'official', category: '通用场景', tags: ['亮嗓', '萌仔'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_gaolengchenwen_uranus_bigtts', name: '高冷沉稳', description: '高冷沉稳的男声', type: 'official', category: '通用场景', tags: ['高冷', '沉稳'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_shenyeboke_uranus_bigtts', name: '深夜播客', description: '深夜播客男声，适合情感/治愈电台', type: 'official', category: '通用场景', tags: ['深夜', '播客', '治愈'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_kailangdidi_uranus_bigtts', name: '开朗弟弟', description: '开朗活泼的弟弟男声', type: 'official', category: '通用场景', tags: ['开朗', '弟弟', '抖音同款'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_kuailexiaodong_uranus_bigtts', name: '快乐小东', description: '快乐的小东男声', type: 'official', category: '通用场景', tags: ['快乐', '小东'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_kailangxuezhang_uranus_bigtts', name: '开朗学长', description: '开朗的学长男声', type: 'official', category: '通用场景', tags: ['开朗', '学长'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_youyoujunzi_uranus_bigtts', name: '悠悠君子', description: '悠悠君子般儒雅的男声', type: 'official', category: '通用场景', tags: ['儒雅', '君子'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_qingshuangnanda_uranus_bigtts', name: '清爽男大', description: '清爽的男大音色', type: 'official', category: '通用场景', tags: ['清爽', '男大'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_yuanboxiaoshu_uranus_bigtts', name: '渊博小叔', description: '渊博的小叔男声，成熟有阅历', type: 'official', category: '通用场景', tags: ['渊博', '小叔', '阅历'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_yangguangqingnian_uranus_bigtts', name: '阳光青年', description: '阳光活力的青年男声', type: 'official', category: '通用场景', tags: ['阳光', '青年'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_wenrouxiaoge_uranus_bigtts', name: '温柔小哥', description: '温柔的小哥男声', type: 'official', category: '通用场景', tags: ['温柔', '小哥'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_dongfanghaoran_uranus_bigtts', name: '东方浩然', description: '东方浩然男声，大气磅礴', type: 'official', category: '通用场景', tags: ['大气', '磅礴'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_guanggaojieshuo_uranus_bigtts', name: '广告解说', description: '广告解说男声，适合商业广告', type: 'official', category: '通用场景', tags: ['广告', '解说'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_shaonianzixin_uranus_bigtts', name: '少年梓辛', description: '少年梓辛男声，清澈少年音', type: 'official', category: '通用场景', tags: ['少年', '梓辛', '清澈'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_ruyayichen_uranus_bigtts', name: '儒雅逸辰', description: '儒雅逸辰男声，适合视频配音', type: 'official', category: '通用场景', tags: ['儒雅', '逸辰'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_dayi_uranus_bigtts', name: '大壹', description: '大壹男声，视频配音', type: 'official', category: '通用场景', tags: ['大壹', '视频配音'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_baqiqingshu_uranus_bigtts', name: '霸气青叔', description: '霸气青叔男声，适合有声书/解说', type: 'official', category: '通用场景', tags: ['霸气', '青叔', '有声书'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_xuanyijieshuo_uranus_bigtts', name: '悬疑解说', description: '悬疑解说男声，适合悬疑/影视解说', type: 'official', category: '通用场景', tags: ['悬疑', '解说', '抖音同款'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_tiancaitongsheng_uranus_bigtts', name: '天才童声', description: '天才童声男声，儿童音色', type: 'official', category: '通用场景', tags: ['童声', '儿童'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_aojiaobazong_uranus_bigtts', name: '傲娇霸总', description: '傲娇霸总男声', type: 'official', category: '通用场景', tags: ['傲娇', '霸总'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_lanyinmianbao_uranus_bigtts', name: '懒音绵宝', description: '懒音绵宝男声，慵懒风格', type: 'official', category: '通用场景', tags: ['懒音', '绵宝', '慵懒'], language: 'zh-cn', gender: 'male', tier: 'standard' },

  // ========== 经典人物（独立分类，名称简洁）==========
  { speakerId: 'zh_male_sunwukong_uranus_bigtts', name: '猴哥', description: '孙悟空，西游记角色', type: 'official', category: '经典人物', tags: ['孙悟空', '西游记'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_zhubajie_uranus_bigtts', name: '猪八戒', description: '猪八戒，西游记角色', type: 'official', category: '经典人物', tags: ['猪八戒', '西游记'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_tangseng_uranus_bigtts', name: '唐僧', description: '唐僧，西游记角色', type: 'official', category: '经典人物', tags: ['唐僧', '西游记'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_zhuangzhou_uranus_bigtts', name: '庄周', description: '庄周，道家哲学角色', type: 'official', category: '经典人物', tags: ['庄周', '道家'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_female_wuzetian_uranus_bigtts', name: '武则天', description: '武则天，霸气女皇', type: 'official', category: '经典人物', tags: ['武则天', '女皇', '霸气'], language: 'zh-cn', gender: 'female', tier: 'standard' },
  { speakerId: 'zh_male_silang_uranus_bigtts', name: '四郎', description: '四郎，杨四郎角色', type: 'official', category: '经典人物', tags: ['四郎', '杨四郎'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_qingcang_uranus_bigtts', name: '擎苍', description: '擎苍，武将角色', type: 'official', category: '经典人物', tags: ['擎苍', '武将'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_lubanqihao_uranus_bigtts', name: '鲁班七号', description: '鲁班七号，游戏角色', type: 'official', category: '经典人物', tags: ['鲁班七号', '游戏'], language: 'zh-cn', gender: 'male', tier: 'standard' },
  { speakerId: 'zh_male_xionger_uranus_bigtts', name: '熊二', description: '熊二，动画角色', type: 'official', category: '经典人物', tags: ['熊二', '动画', '熊出没'], language: 'zh-cn', gender: 'male', tier: 'standard' },

  // ========== 角色扮演（ICL接近真人 + saturn COT最强指令）==========
  // saturn COT版（最强语音指令能力，优先保留）
  { speakerId: 'saturn_zh_female_aojiaonvyou_tob', name: '傲娇女友', description: '傲娇女友，支持强语音指令COT', type: 'official', category: '角色扮演', tags: ['傲娇', '女友', 'COT', '强指令'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_bingjiaojiejie_tob', name: '病娇姐姐', description: '病娇姐姐，支持COT', type: 'official', category: '角色扮演', tags: ['病娇', '姐姐', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_chengshujiejie_tob', name: '成熟姐姐', description: '成熟姐姐，支持COT', type: 'official', category: '角色扮演', tags: ['成熟', '姐姐', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_keainvsheng_tob', name: '可爱女生', description: '可爱女生，支持COT', type: 'official', category: '角色扮演', tags: ['可爱', '女生', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_nuanxinxuejie_tob', name: '暖心学姐', description: '暖心学姐，支持COT', type: 'official', category: '角色扮演', tags: ['暖心', '学姐', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_tiexinnvyou_tob', name: '贴心女友', description: '贴心女友，支持COT', type: 'official', category: '角色扮演', tags: ['贴心', '女友', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_wenrouwenya_tob', name: '温柔文雅', description: '温柔文雅，支持COT', type: 'official', category: '角色扮演', tags: ['温柔', '文雅', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_wumeiyujie_tob', name: '妩媚御姐', description: '妩媚御姐，支持COT', type: 'official', category: '角色扮演', tags: ['妩媚', '御姐', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_xingganyujie_tob', name: '性感御姐', description: '性感御姐，支持COT', type: 'official', category: '角色扮演', tags: ['性感', '御姐', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_aoqilingren_tob', name: '傲气凌人', description: '傲气凌人，支持COT', type: 'official', category: '角色扮演', tags: ['傲气', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_male_cixingnansang_tob', name: '磁性男嗓', description: '磁性男嗓，支持COT', type: 'official', category: '角色扮演', tags: ['磁性', '男嗓', 'COT'], language: 'zh-cn', gender: 'male', tier: 'cot' },
  { speakerId: 'saturn_zh_male_cijingnanyou_tob', name: '醋精男友', description: '醋精男友，支持COT', type: 'official', category: '角色扮演', tags: ['醋精', '男友', 'COT'], language: 'zh-cn', gender: 'male', tier: 'cot' },
  { speakerId: 'saturn_zh_male_fengfashaonian_tob', name: '风发少年', description: '风发少年，支持COT', type: 'official', category: '角色扮演', tags: ['少年', 'COT'], language: 'zh-cn', gender: 'male', tier: 'cot' },
  { speakerId: 'saturn_zh_male_fuheigongzi_tob', name: '腹黑公子', description: '腹黑公子，支持COT', type: 'official', category: '角色扮演', tags: ['腹黑', '公子', 'COT'], language: 'zh-cn', gender: 'male', tier: 'cot' },
  // 2025年10月新增COT角色音色
  { speakerId: 'saturn_zh_male_shuanglangshaonian_tob', name: '爽朗少年', description: '爽朗少年，支持COT', type: 'official', category: '角色扮演', tags: ['爽朗', '少年', 'COT'], language: 'zh-cn', gender: 'male', tier: 'cot' },
  { speakerId: 'saturn_zh_male_tiancaitongzhuo_tob', name: '天才同桌', description: '天才同桌，支持COT', type: 'official', category: '角色扮演', tags: ['天才', '同桌', 'COT'], language: 'zh-cn', gender: 'male', tier: 'cot' },

  // ========== 视频配音（saturn旗舰版，2025年10月上新）==========
  { speakerId: 'zh_male_dayi_saturn_bigtts', name: '大壹旗舰版', description: '大壹视频配音男声（saturn旗舰版）', type: 'official', category: '视频配音', tags: ['大壹', '视频配音', '旗舰'], language: 'zh-cn', gender: 'male', tier: 'flagship' },
  { speakerId: 'zh_female_mizai_saturn_bigtts', name: '黑猫侦探社咪仔旗舰版', description: '黑猫侦探社咪仔视频配音女声（saturn旗舰版）', type: 'official', category: '视频配音', tags: ['咪仔', '视频配音', '旗舰'], language: 'zh-cn', gender: 'female', tier: 'flagship' },
  { speakerId: 'zh_female_jitangnv_saturn_bigtts', name: '鸡汤女旗舰版', description: '鸡汤女视频配音女声（saturn旗舰版）', type: 'official', category: '视频配音', tags: ['鸡汤', '视频配音', '旗舰'], language: 'zh-cn', gender: 'female', tier: 'flagship' },
  { speakerId: 'zh_female_meilinvyou_saturn_bigtts', name: '魅力女友旗舰版', description: '魅力女友视频配音女声（saturn旗舰版）', type: 'official', category: '视频配音', tags: ['魅力', '女友', '旗舰'], language: 'zh-cn', gender: 'female', tier: 'flagship' },
  { speakerId: 'zh_female_santongyongns_saturn_bigtts', name: '流畅女声旗舰版', description: '流畅女声视频配音（saturn旗舰版）', type: 'official', category: '视频配音', tags: ['流畅', '视频配音', '旗舰'], language: 'zh-cn', gender: 'female', tier: 'flagship' },
  { speakerId: 'zh_male_ruyayichen_saturn_bigtts', name: '儒雅逸辰旗舰版', description: '儒雅逸辰视频配音男声（saturn旗舰版）', type: 'official', category: '视频配音', tags: ['儒雅', '逸辰', '旗舰'], language: 'zh-cn', gender: 'male', tier: 'flagship' },

  // ICL角色音色（接近真人，无COT版对应的保留）
  { speakerId: 'ICL_uranus_zh_female_chunzhenshaonv_tob', name: '纯真少女', description: '纯真少女，接近真人', type: 'icl', category: '角色扮演', tags: ['纯真', '少女', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_wenrounvshen_tob', name: '温柔女神', description: '温柔女神，接近真人', type: 'icl', category: '角色扮演', tags: ['温柔', '女神', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_zhixinjiejie_tob', name: '知心姐姐', description: '知心姐姐，接近真人', type: 'icl', category: '角色扮演', tags: ['知心', '姐姐', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_yuanqitianmei_tob', name: '元气甜妹', description: '元气甜妹，接近真人', type: 'icl', category: '角色扮演', tags: ['元气', '甜妹', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_aomanjiaosheng_tob', name: '傲慢娇声', description: '傲慢娇声，接近真人', type: 'icl', category: '角色扮演', tags: ['傲慢', '娇声', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_xiemeinvwang_tob', name: '邪魅女王', description: '邪魅女王，接近真人', type: 'icl', category: '角色扮演', tags: ['邪魅', '女王', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_bingjiaomengmei_tob', name: '病娇萌妹', description: '病娇萌妹，接近真人', type: 'icl', category: '角色扮演', tags: ['病娇', '萌妹', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_bingruoshaonv_tob', name: '病弱少女', description: '病弱少女，接近真人', type: 'icl', category: '角色扮演', tags: ['病弱', '少女', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_chengshuwenrou_tob', name: '成熟温柔', description: '成熟温柔，接近真人', type: 'icl', category: '角色扮演', tags: ['成熟', '温柔', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_chunchenvsheng_tob', name: '纯澈女生', description: '纯澈女生，接近真人', type: 'icl', category: '角色扮演', tags: ['纯澈', '女生', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_wumeikeren_tob', name: '妩媚可人', description: '妩媚可人，接近真人', type: 'icl', category: '角色扮演', tags: ['妩媚', '可人', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_huopodiaoman_tob', name: '活泼刁蛮', description: '活泼刁蛮，接近真人', type: 'icl', category: '角色扮演', tags: ['活泼', '刁蛮', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_huoponvhai_tob', name: '活泼女孩', description: '活泼女孩，接近真人', type: 'icl', category: '角色扮演', tags: ['活泼', '女孩', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_jiaohannvwang_tob', name: '娇憨女王', description: '娇憨女王，接近真人', type: 'icl', category: '角色扮演', tags: ['娇憨', '女王', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_jiaoruoluoli_tob', name: '娇弱萝莉', description: '娇弱萝莉，接近真人', type: 'icl', category: '角色扮演', tags: ['娇弱', '萝莉', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_jiaxiaozi_tob', name: '假小子', description: '假小子，接近真人', type: 'icl', category: '角色扮演', tags: ['假小子', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_jinglingxiangdao_tob', name: '精灵向导', description: '精灵向导，接近真人', type: 'icl', category: '角色扮演', tags: ['精灵', '向导', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_tianmeijiaoqiao_tob', name: '甜美娇俏', description: '甜美娇俏，接近真人', type: 'icl', category: '角色扮演', tags: ['甜美', '娇俏', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_qinglenggaoya_tob', name: '清冷高雅', description: '清冷高雅，接近真人', type: 'icl', category: '角色扮演', tags: ['清冷', '高雅', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_xingganmeihuo_tob', name: '性感魅惑', description: '性感魅惑，接近真人', type: 'icl', category: '角色扮演', tags: ['性感', '魅惑', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_qingxinshaonv_tob', name: '倾心少女', description: '倾心少女，接近真人', type: 'icl', category: '角色扮演', tags: ['倾心', '少女', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_rouguhunshi_tob', name: '柔骨魂师', description: '柔骨魂师，接近真人', type: 'icl', category: '角色扮演', tags: ['柔骨', '魂师', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_ruanmengtuanzi_tob', name: '软萌团子', description: '软萌团子，接近真人', type: 'icl', category: '角色扮演', tags: ['软萌', '团子', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_tianmeihuopo_tob', name: '甜美活泼', description: '甜美活泼，接近真人', type: 'icl', category: '角色扮演', tags: ['甜美', '活泼', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_tiaopigongzhu_tob', name: '调皮公主', description: '调皮公主，接近真人', type: 'icl', category: '角色扮演', tags: ['调皮', '公主', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_xiemeiyujie_tob', name: '邪魅御姐', description: '邪魅御姐，接近真人', type: 'icl', category: '角色扮演', tags: ['邪魅', '御姐', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_heainainai_tob', name: '和蔼奶奶', description: '和蔼奶奶，接近真人', type: 'icl', category: '角色扮演', tags: ['和蔼', '奶奶', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_linjuayi_tob', name: '邻居阿姨', description: '邻居阿姨，接近真人', type: 'icl', category: '角色扮演', tags: ['邻居', '阿姨', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },

  // ========== 客服场景 ==========
  { speakerId: 'ICL_uranus_zh_female_kefuwanjun_tob', name: '客服婉君', description: '客服婉君，接近真人', type: 'icl', category: '客服', tags: ['客服', '婉君', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'saturn_zh_female_qingyingduoduo_cs_tob', name: '轻盈朵朵', description: '轻盈朵朵，客服COT', type: 'official', category: '客服', tags: ['客服', '轻盈', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_wenwanshanshan_cs_tob', name: '温婉珊珊', description: '温婉珊珊，客服COT', type: 'official', category: '客服', tags: ['客服', '温婉', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_female_reqingaina_cs_tob', name: '热情艾娜', description: '热情艾娜，客服COT', type: 'official', category: '客服', tags: ['客服', '热情', 'COT'], language: 'zh-cn', gender: 'female', tier: 'cot' },
  { speakerId: 'saturn_zh_male_qingxinmumu_cs_tob', name: '清新沐沐', description: '清新沐沐，客服COT', type: 'official', category: '客服', tags: ['客服', '清新', 'COT'], language: 'zh-cn', gender: 'male', tier: 'cot' },
  { speakerId: 'ICL_uranus_zh_female_guaiqiaokeer_tob', name: '乖巧可儿', description: '乖巧可儿，接近真人', type: 'icl', category: '客服', tags: ['乖巧', '可儿', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_kailangtingting_tob', name: '开朗婷婷', description: '开朗婷婷，接近真人', type: 'icl', category: '客服', tags: ['开朗', '婷婷', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_kaixinxiaohong_tob', name: '开心小鸿', description: '开心小鸿，接近真人', type: 'icl', category: '客服', tags: ['开心', '小鸿', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_lingdongxinxin_tob', name: '灵动欣欣', description: '灵动欣欣，接近真人', type: 'icl', category: '客服', tags: ['灵动', '欣欣', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_lixingyuanzi_tob', name: '理性圆子', description: '理性圆子，接近真人', type: 'icl', category: '客服', tags: ['理性', '圆子', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_nuanxinqianqian_tob', name: '暖心茜茜', description: '暖心茜茜，接近真人', type: 'icl', category: '客服', tags: ['暖心', '茜茜', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_qingtianmeimei_tob', name: '清甜莓莓', description: '清甜莓莓，接近真人', type: 'icl', category: '客服', tags: ['清甜', '莓莓', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_qingtiantaotao_tob', name: '清甜桃桃', description: '清甜桃桃，接近真人', type: 'icl', category: '客服', tags: ['清甜', '桃桃', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_qingxixiaoxue_tob', name: '清晰小雪', description: '清晰小雪，接近真人', type: 'icl', category: '客服', tags: ['清晰', '小雪', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_ruanmengtangtang_tob', name: '软萌糖糖', description: '软萌糖糖，接近真人', type: 'icl', category: '客服', tags: ['软萌', '糖糖', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_tianmeixiaoju_tob', name: '甜美小橘', description: '甜美小橘，接近真人', type: 'icl', category: '客服', tags: ['甜美', '小橘', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_zh_female_tianmeixiaoyu_tob', name: '甜美小雨', description: '甜美小雨，接近真人', type: 'icl', category: '客服', tags: ['甜美', '小雨', '接近真人'], language: 'zh-cn', gender: 'female', isRealVoice: true, tier: 'standard' },

  // ========== 多语种 ==========
  { speakerId: 'en_male_tim_uranus_bigtts', name: 'Tim', description: '美式英语男声', type: 'official', category: '多语种', tags: ['英语', '美式'], language: 'en', gender: 'male', tier: 'standard' },
  { speakerId: 'en_female_dacey_uranus_bigtts', name: 'Dacey', description: '美式英语女声', type: 'official', category: '多语种', tags: ['英语', '美式'], language: 'en', gender: 'female', tier: 'standard' },
  { speakerId: 'en_female_stokie_uranus_bigtts', name: 'Stokie', description: '美式英语女声', type: 'official', category: '多语种', tags: ['英语', '美式'], language: 'en', gender: 'female', tier: 'standard' },
  { speakerId: 'ICL_uranus_en_female_charlie_tob', name: 'Charlie', description: '美式英语女声，接近真人', type: 'icl', category: '多语种', tags: ['英语', '美式', '接近真人'], language: 'en', gender: 'female', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_en_male_ethan_tob', name: 'Ethan', description: '澳洲英语男声，接近真人', type: 'icl', category: '多语种', tags: ['英语', '澳洲', '接近真人'], language: 'en', gender: 'male', isRealVoice: true, tier: 'standard' },
  { speakerId: 'ICL_uranus_en_male_alastor_tob', name: 'Alastor', description: '英式英语男声，接近真人', type: 'icl', category: '多语种', tags: ['英语', '英式', '接近真人'], language: 'en', gender: 'male', isRealVoice: true, tier: 'standard' },
];

async function main() {
  console.log(`开始seed，共 ${voices.length} 个音色`);

  const adminPassword = await bcrypt.hash('admin123456', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@voicestudio.com' },
    update: {},
    create: { email: 'admin@voicestudio.com', password: adminPassword, name: '管理员', role: 'ADMIN' },
  });
  console.log(`管理员: ${admin.email}`);

  await prisma.voice.deleteMany({});
  console.log('已清空旧音色');

  for (const v of voices) {
    const allTags = [...v.tags];
    if (v.isRealVoice) allTags.push('接近真人');
    if (v.tier === 'cot') allTags.push('强指令');
    await prisma.voice.create({
      data: {
        speakerId: v.speakerId,
        name: v.name,
        description: v.description,
        type: v.type,
        category: v.category,
        tags: JSON.stringify(allTags),
        language: v.language,
        gender: v.gender,
        isActive: true,
      },
    });
  }
  console.log(`已插入 ${voices.length} 个音色`);

  const existingConfigs = await prisma.apiConfig.count();
  if (existingConfigs === 0) {
    await prisma.apiConfig.create({
      data: {
        name: '火山引擎主Key',
        apiKey: process.env.VOLCENGINE_API_KEY_1?.trim() ?? '',
        resourceId: 'seed-tts-2.0',
        isActive: true,
      },
    });
    console.log('已创建API Key配置');
  }

  console.log('seed完成');
}

main()
  .catch((e) => { console.error('seed失败:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
