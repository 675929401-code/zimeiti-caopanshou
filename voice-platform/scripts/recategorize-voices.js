/**
 * 音色分类重构脚本
 * 基于剪映分类模式，将173个音色重新归入7大科学分类
 *
 * 新分类体系：
 * 1. 🔥 热门推荐 - 抖音/剪映/豆包多平台同款，最受欢迎
 * 2. 🎬 影视解说 - 解说/播报/电台/有声/新闻/磁性
 * 3. 🎭 角色动漫 - 角色扮演/童声/萌娃/动漫/古风
 * 4. 💝 情感治愈 - 温柔/治愈/撒娇/甜美/贴心/情感
 * 5. 📱 短视频配音 - 阳光/活力/开朗/俏皮/邻家/女友
 * 6. 💼 商业播报 - 知性/成熟/稳重/客服/品牌/专业
 * 7. 🌐 多语种 - 英文/方言/外语
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'lib', 'voices-data.ts');
const content = fs.readFileSync(filePath, 'utf-8');

// 分类规则（按优先级从高到低）
const CATEGORY_RULES = [
  {
    category: '多语种',
    test: (v) => {
      return v.speakerId.startsWith('en_') ||
             v.speakerId.includes('_en_') ||
             v.speakerId.startsWith('ICL_uranus_en_') ||
             (v.language && v.language !== 'zh-cn');
    }
  },
  {
    category: '热门推荐',
    test: (v) => {
      // 同时拥有抖音同款+剪映同款 的才是真热门
      const tags = v.specialTags || [];
      return tags.includes('抖音同款') && tags.includes('剪映同款');
    }
  },
  {
    category: '影视解说',
    test: (v) => {
      const text = `${v.name} ${v.description} ${(v.tags || []).join(' ')}`.toLowerCase();
      const keywords = ['解说', '播报', '电台', '有声', '播客', '新闻', '磁性', '渊博', '广告解说', '译制片', '深夜'];
      return keywords.some(k => text.includes(k));
    }
  },
  {
    category: '角色动漫',
    test: (v) => {
      const text = `${v.name} ${(v.tags || []).join(' ')}`;
      const keywords = ['角色', '童声', '萌娃', '动漫', '古风', '霸总', '御姐', '四郎', '熊二', '唐僧', '庄周', '鲁班', '樱桃丸子', '娇喘', '擎苍', '灿灿', '林潇', '玲玲', '春日部', '少御', '天才'];
      return keywords.some(k => text.includes(k));
    }
  },
  {
    category: '情感治愈',
    test: (v) => {
      const text = `${v.name} ${v.description} ${(v.tags || []).join(' ')}`;
      const keywords = ['温柔', '治愈', '鸡汤', '撒娇', '甜美', '贴心', '柔美', '温暖', '情感', '淑女', '清新', '清澈', '悦耳', '心灵', '妈妈', '婆婆', '治愈系', '撒娇', '甜妹', '柔美'];
      return keywords.some(k => text.includes(k));
    }
  },
  {
    category: '商业播报',
    test: (v) => {
      const text = `${v.name} ${v.description} ${(v.tags || []).join(' ')}`;
      const keywords = ['知性', '成熟', '稳重', '儒雅', '品牌', '宣传', '商业', '专业', '客服', '高冷', '沉稳', '播报', '企业', '魅力苏菲', '东方浩然', '渊博'];
      return keywords.some(k => text.includes(k));
    }
  },
  // 默认分类
  {
    category: '短视频配音',
    test: () => true
  }
];

// 解析 voices-data.ts 中的每个音色对象
function parseVoices(content) {
  const voices = [];
  // 匹配 { speakerId: 'xxx', ... } 对象
  const regex = /\{\s*speakerId:\s*'([^']+)',\s*name:\s*'([^']+)',\s*description:\s*'([^']*)',\s*type:\s*'([^']*)',\s*category:\s*'([^']*)',\s*tags:\s*\[([^\]]*)\],\s*language:\s*'([^']*)',\s*gender:\s*'([^']*)'/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const [, speakerId, name, description, type, oldCategory, tagsStr, language, gender] = match;
    const tags = tagsStr.split(',').map(t => t.trim().replace(/'/g, '')).filter(Boolean);

    // 尝试提取 specialTags
    const fullBlock = content.substring(match.index, match.index + 500);
    const specialTagsMatch = fullBlock.match(/specialTags:\s*\[([^\]]*)\]/);
    const specialTags = specialTagsMatch
      ? specialTagsMatch[1].split(',').map(t => t.trim().replace(/'/g, '')).filter(Boolean)
      : [];

    voices.push({
      speakerId, name, description, type, oldCategory, tags, language, gender, specialTags,
      matchStart: match.index,
      matchEnd: match.index + match[0].length,
      fullMatch: match[0],
    });
  }
  return voices;
}

const voices = parseVoices(content);
console.log(`解析到 ${voices.length} 个音色`);

// 应用新分类
const categoryCount = {};
const updates = [];

for (const voice of voices) {
  for (const rule of CATEGORY_RULES) {
    if (rule.test(voice)) {
      voice.newCategory = rule.category;
      categoryCount[rule.category] = (categoryCount[rule.category] || 0) + 1;
      break;
    }
  }

  if (voice.newCategory !== voice.oldCategory) {
    updates.push({
      name: voice.name,
      oldCategory: voice.oldCategory,
      newCategory: voice.newCategory,
      speakerId: voice.speakerId,
    });
  }
}

console.log('\n新分类统计：');
Object.entries(categoryCount).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
  console.log(`  ${cat}: ${count} 个`);
});

console.log(`\n需要更新分类的音色：${updates.length} 个`);
console.log('\n前20个变更：');
updates.slice(0, 20).forEach(u => {
  console.log(`  ${u.name}: ${u.oldCategory} → ${u.newCategory}`);
});

// 生成更新后的文件内容
let updatedContent = content;
// 从后往前替换，避免偏移问题
for (let i = voices.length - 1; i >= 0; i--) {
  const voice = voices[i];
  if (voice.newCategory !== voice.oldCategory) {
    const oldStr = `category: '${voice.oldCategory}'`;
    const newStr = `category: '${voice.newCategory}'`;
    // 只在当前音色的匹配范围内替换
    const before = updatedContent.substring(0, voice.matchStart);
    const block = updatedContent.substring(voice.matchStart);
    const updatedBlock = block.replace(oldStr, newStr);
    updatedContent = before + updatedBlock;
  }
}

// 写回文件
fs.writeFileSync(filePath, updatedContent, 'utf-8');
console.log('\n✅ voices-data.ts 已更新');

// 生成数据库更新SQL
const sqlPath = path.join(__dirname, 'update-categories.sql');
const sqlLines = ['-- 音色分类重构 SQL', '-- 更新日期: 2026-07-20', ''];

for (const voice of voices) {
  if (voice.newCategory !== voice.oldCategory) {
    sqlLines.push(`UPDATE "Voice" SET category = '${voice.newCategory}' WHERE "speakerId" = '${voice.speakerId}';`);
  }
}

sqlLines.push('');
sqlLines.push('-- 分类统计：');
Object.entries(categoryCount).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
  sqlLines.push(`-- ${cat}: ${count} 个`);
});

fs.writeFileSync(sqlPath, sqlLines.join('\n'), 'utf-8');
console.log(`✅ 数据库更新SQL已生成: ${sqlPath}`);
console.log(`   共 ${updates.length} 条 UPDATE 语句`);

// 同时更新 preview 文本映射
const previewTexts = {
  '热门推荐': '大家好，欢迎来到智音工坊！今天给大家带来一款超好用的AI配音工具，快来试试吧！',
  '影视解说': '故事的转折往往出人意料。在这个看似平静的小镇上，一场暗流涌动的风暴正在酝酿。',
  '角色动漫': '哼，凡人，你终于来了！本姑娘已经等你很久了，还不快快报上名来！',
  '情感治愈': '你知道吗，有时候生活就是这样，给你关上一扇门的同时，也会为你打开一扇窗。',
  '短视频配音': '哈喽大家好呀！今天给大家分享一个超实用的小技巧，记得点赞收藏哦！',
  '商业播报': '您好，欢迎致电智音客服中心。我是您的专属客服顾问，很高兴为您服务。',
  '多语种': 'Hello, welcome to Zhiyin Workshop. I hope my voice brings you a wonderful experience.',
};

console.log('\n📝 新分类预览文本：');
Object.entries(previewTexts).forEach(([cat, text]) => {
  console.log(`  ${cat}: ${text.substring(0, 30)}...`);
});
