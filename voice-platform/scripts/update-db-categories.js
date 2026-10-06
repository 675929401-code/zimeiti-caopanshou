/**
 * 数据库音色分类更新脚本
 * 将数据库中的 Voice.category 字段更新为新分类体系
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// 分类映射规则（与 recategorize-voices.js 一致）
const CATEGORY_RULES = [
  {
    category: '多语种',
    test: (v) => {
      // 明确排除中文（zh 和 zh-cn 都是中文）
      if (v.language === 'zh' || v.language === 'zh-cn') return false;
      // 非中文语言归入多语种
      if (v.language && v.language !== 'zh' && v.language !== 'zh-cn') return true;
      // speakerId 以 en_ 开头（非 ICL_uranus_zh_）
      return v.speakerId.startsWith('en_') && !v.speakerId.includes('_zh_');
    }
  },
  {
    category: '热门推荐',
    test: (v) => {
      let tags = [];
      try { tags = JSON.parse(v.tags || '[]'); } catch {}
      // 检查 specialTags - 从 tags 或 description 中推断
      const text = `${v.name} ${v.description || ''} ${tags.join(' ')}`;
      return text.includes('抖音同款') && text.includes('剪映同款');
    }
  },
  {
    category: '影视解说',
    test: (v) => {
      let tags = [];
      try { tags = JSON.parse(v.tags || '[]'); } catch {}
      const text = `${v.name} ${v.description || ''} ${tags.join(' ')}`;
      return ['解说', '播报', '电台', '有声', '播客', '新闻', '磁性', '渊博', '广告解说', '译制片', '深夜'].some(k => text.includes(k));
    }
  },
  {
    category: '角色动漫',
    test: (v) => {
      let tags = [];
      try { tags = JSON.parse(v.tags || '[]'); } catch {}
      const text = `${v.name} ${tags.join(' ')}`;
      return ['角色', '童声', '萌娃', '动漫', '古风', '霸总', '御姐', '四郎', '熊二', '唐僧', '庄周', '鲁班', '樱桃丸子', '娇喘', '擎苍', '灿灿', '林潇', '玲玲', '春日部', '少御', '天才'].some(k => text.includes(k));
    }
  },
  {
    category: '情感治愈',
    test: (v) => {
      let tags = [];
      try { tags = JSON.parse(v.tags || '[]'); } catch {}
      const text = `${v.name} ${v.description || ''} ${tags.join(' ')}`;
      return ['温柔', '治愈', '鸡汤', '撒娇', '甜美', '贴心', '柔美', '温暖', '情感', '淑女', '清新', '清澈', '悦耳', '心灵', '妈妈', '婆婆'].some(k => text.includes(k));
    }
  },
  {
    category: '商业播报',
    test: (v) => {
      let tags = [];
      try { tags = JSON.parse(v.tags || '[]'); } catch {}
      const text = `${v.name} ${v.description || ''} ${tags.join(' ')}`;
      return ['知性', '成熟', '稳重', '儒雅', '品牌', '宣传', '商业', '专业', '客服', '高冷', '沉稳', '企业', '魅力苏菲', '东方浩然', '渊博'].some(k => text.includes(k));
    }
  },
  { category: '短视频配音', test: () => true }
];

async function main() {
  console.log('🔄 开始更新数据库音色分类...\n');

  const allVoices = await prisma.voice.findMany();
  console.log(`数据库中共 ${allVoices.length} 个音色\n`);

  const stats = {};
  let updated = 0;

  for (const voice of allVoices) {
    let newCategory = voice.category;

    for (const rule of CATEGORY_RULES) {
      if (rule.test(voice)) {
        newCategory = rule.category;
        break;
      }
    }

    stats[newCategory] = (stats[newCategory] || 0) + 1;

    if (newCategory !== voice.category) {
      await prisma.voice.update({
        where: { id: voice.id },
        data: { category: newCategory },
      });
      updated++;
      console.log(`  ${voice.name}: ${voice.category} → ${newCategory}`);
    }
  }

  console.log(`\n✅ 更新完成！共更新 ${updated} 个音色分类\n`);
  console.log('新分类统计：');
  Object.entries(stats).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count} 个`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
