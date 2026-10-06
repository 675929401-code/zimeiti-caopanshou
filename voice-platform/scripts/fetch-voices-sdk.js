/**
 * 火山引擎 ListSpeakers API - 使用官方SDK
 * 
 * 使用 @volcengine/openapi 的 VisualAPI（语音服务）调用 ListSpeakers
 */

const { VisualAPI } = require('@volcengine/openapi');

const ACCESS_KEY = process.env.VOLC_ACCESS_KEY || '';
const SECRET_KEY = process.env.VOLC_SECRET_KEY || '';

if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('❌ 缺少 AK/SK！请设置 VOLC_ACCESS_KEY 和 VOLC_SECRET_KEY 环境变量');
  process.exit(1);
}

async function main() {
  console.log('🚀 火山引擎全量音色同步工具（官方SDK版）');
  console.log('==========================================');
  console.log(`AccessKey: ${ACCESS_KEY.slice(0, 12)}...${ACCESS_KEY.slice(-4)}`);
  console.log('');

  // 初始化 VisualAPI 客户端
  const visualAPI = new VisualAPI({
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    region: 'cn-beijing',
  });

  // 尝试直接 fetch 调用（使用SDK的签名能力）
  const allSpeakers = [];

  for (const resourceId of ['seed-tts-2.0', 'seed-icl-2.0']) {
    console.log(`\n📋 正在获取 ${resourceId} 的音色列表...`);
    
    let page = 1;
    const limit = 100;
    let total = 0;
    
    do {
      try {
        // 使用 SDK 的 fetchOpenAPI 方法（自动签名）
        const response = await visualAPI.fetchOpenAPI({
          Action: 'ListSpeakers',
          Version: '2025-05-20',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          query: {
            Action: 'ListSpeakers',
            Version: '2025-05-20',
          },
          body: {
            ResourceIDs: [resourceId],
            Page: page,
            Limit: limit,
          },
        });

        const data = await response.json();

        if (data.ResponseMetadata?.Error) {
          throw new Error(`API错误: ${data.ResponseMetadata.Error.Message} (Code: ${data.ResponseMetadata.Error.Code})`);
        }

        const result = data.Result;
        if (!result || !result.Speakers || result.Speakers.length === 0) {
          console.log(`  第 ${page} 页无数据，停止`);
          break;
        }

        total = result.Total || 0;
        allSpeakers.push(...result.Speakers.map(s => ({ ...s, _resourceId: resourceId })));
        console.log(`  第 ${page} 页: ${result.Speakers.length} 个音色 (累计 ${allSpeakers.length}/${total})`);

        page++;
        await new Promise(r => setTimeout(r, 300));
        
        if (page > 30) {
          console.log(`  ⚠️ 已获取30页，停止`);
          break;
        }
      } catch (err) {
        console.log(`  ❌ ${resourceId} 第 ${page} 页失败: ${err.message}`);
        break;
      }
    } while (allSpeakers.filter(s => s._resourceId === resourceId).length < total);

    console.log(`  ✅ ${resourceId}: 共获取 ${allSpeakers.filter(s => s._resourceId === resourceId).length} 个音色`);
  }

  console.log(`\n📊 总计获取 ${allSpeakers.length} 个音色`);

  if (allSpeakers.length === 0) {
    console.log('❌ 未获取到任何音色，退出');
    process.exit(1);
  }

  // 输出音色列表
  console.log('\n📝 音色列表预览（前10个）:');
  allSpeakers.slice(0, 10).forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.VoiceType} | ${s.Name} | ${s.Gender} | ${s._resourceId}`);
  });

  // 同步到数据库
  await syncToDatabase(allSpeakers);
}

async function syncToDatabase(speakers) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  let created = 0, updated = 0, skipped = 0;

  console.log(`\n💾 同步 ${speakers.length} 个音色到数据库...`);

  for (const speaker of speakers) {
    const voiceType = speaker.VoiceType || '';
    if (!voiceType) { skipped++; continue; }

    const name = speaker.Name || voiceType;
    
    // 解析分类
    let category = '通用场景';
    let tags = [];
    if (speaker.Categories && speaker.Categories.length > 0) {
      const cats = speaker.Categories.flatMap(c => c.Categories || []);
      if (cats.length > 0) {
        category = cats[0];
        tags = cats;
      }
    }
    if (speaker.NormalLabels) tags.push(...speaker.NormalLabels);
    if (speaker.SpecialLabels) tags.push(...speaker.SpecialLabels);

    // 解析语言
    let language = 'zh-cn';
    if (speaker.Languages && speaker.Languages.length > 0) {
      language = speaker.Languages[0].Language || 'zh-cn';
    }

    // 解析性别
    let gender = null;
    if (speaker.Gender === '女') gender = 'female';
    else if (speaker.Gender === '男') gender = 'male';
    else gender = speaker.Gender?.toLowerCase() || null;

    // 确定类型
    let type = 'official';
    if (voiceType.startsWith('ICL_') || voiceType.startsWith('icl_')) {
      type = 'icl';
    }

    const voiceData = {
      speakerId: voiceType,
      name,
      description: speaker.Description || '',
      type,
      category,
      tags: JSON.stringify([...new Set(tags)]),
      language,
      gender,
      avatar: speaker.Avatar || null,
      isActive: true,
    };

    try {
      await prisma.voice.upsert({
        where: { speakerId: voiceData.speakerId },
        create: voiceData,
        update: {
          name: voiceData.name,
          description: voiceData.description,
          category: voiceData.category,
          tags: voiceData.tags,
          language: voiceData.language,
          gender: voiceData.gender,
          avatar: voiceData.avatar,
        },
      });
      
      // 检查是新增还是更新（简单判断：createdAt < 1秒前算更新）
      updated++;
    } catch (err) {
      console.log(`  ⚠️ 跳过 ${voiceType}: ${err.message.slice(0, 80)}`);
      skipped++;
    }
  }

  const dbCount = await prisma.voice.count();
  console.log(`\n============================`);
  console.log(`✅ 同步完成！`);
  console.log(`   数据库总音色数: ${dbCount}`);
  console.log(`   处理: ${created + updated} | 跳过: ${skipped}`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('❌ 致命错误:', err.message);
  process.exit(1);
});
