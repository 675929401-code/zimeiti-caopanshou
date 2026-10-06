// 删除纯外语音色，保留中英混合音色
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 获取所有多语种分类的音色
  const multilingual = await prisma.voice.findMany({
    where: { category: '多语种' },
    select: { id: true, speakerId: true, language: true, name: true }
  });
  
  console.log(`多语种分类总计: ${multilingual.length}条`);
  
  // 筛选纯外语：speakerId不以zh_开头，且language不是zh/zh-cn
  const pureForeign = multilingual.filter(v => {
    const sid = v.speakerId || '';
    const lang = v.language || '';
    const isChinese = sid.startsWith('zh_') || sid.startsWith('ICL_uranus_zh_') || lang === 'zh' || lang === 'zh-cn';
    return !isChinese;
  });
  
  const keep = multilingual.filter(v => !pureForeign.includes(v));
  
  console.log(`将删除（纯外语）: ${pureForeign.length}条`);
  console.log(`将保留（中英混合）: ${keep.length}条`);
  keep.forEach(v => console.log(`  保留: ${v.speakerId} - ${v.name} (lang=${v.language})`));
  
  // 执行删除
  const idsToDelete = pureForeign.map(v => v.id);
  if (idsToDelete.length > 0) {
    // 同时删除关联的收藏
    await prisma.favorite.deleteMany({ where: { voiceId: { in: idsToDelete } } });
    const result = await prisma.voice.deleteMany({ where: { id: { in: idsToDelete } } });
    console.log(`\n已删除: ${result.count}条纯外语音色`);
  }
  
  // 统计删除后的分类分布
  const allCategories = await prisma.voice.groupBy({
    by: ['category'],
    _count: true,
    orderBy: { _count: { category: 'desc' } }
  });
  
  console.log('\n=== 删除后分类分布 ===');
  allCategories.forEach(c => console.log(`  ${c.category}: ${c._count.category}条`));
  
  const total = await prisma.voice.count();
  console.log(`\n总计: ${total}条音色`);
}

main().then(() => prisma.$disconnect()).catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
