/**
 * 火山引擎 ListSpeakers API 调用脚本
 * 
 * 通过 V4 签名认证调用 ListSpeakers API，获取全量音色并同步到数据库
 * 
 * 使用方法:
 *   1. 设置环境变量 VOLC_ACCESS_KEY 和 VOLC_SECRET_KEY
 *   2. 运行: node scripts/fetch-all-voices.js
 */

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ============ 配置区域 ============
// 凭据只允许从运行环境读取，禁止在源码中提供硬编码回退值。
const ACCESS_KEY = process.env.VOLC_ACCESS_KEY?.trim() ?? '';
const SECRET_KEY = process.env.VOLC_SECRET_KEY?.trim() ?? '';

const REGION = 'cn-beijing';
const SERVICE = 'speech_saas_prod';
const HOST = 'open.volcengineapi.com';
// ================================

if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('❌ 缺少火山引擎 AK/SK！');
  console.error('');
  console.error('请设置环境变量:');
  console.error('  export VOLC_ACCESS_KEY="你的AccessKey"');
  console.error('  export VOLC_SECRET_KEY="你的SecretKey"');
  console.error('');
  console.error('获取方式:');
  console.error('  1. 登录火山引擎控制台 https://console.volcengine.com/iam/keymanage/');
  console.error('  2. 创建 Access Key，获取 AccessKey ID 和 Secret Access Key');
  console.error('  3. 确保账号已开通语音合成服务');
  process.exit(1);
}

// SHA256 哈希
function sha256(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

// HMAC-SHA256
function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

// 获取 V4 签名日期 (YYYYMMDD 格式，UTC)
function getDate() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

// 获取 V4 签名日期时间 (YYYYMMDDTHHmmssZ 格式，UTC)
function getDateTime() {
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', 'T') + 'Z';
}

// 生成 V4 签名
function signV4(method, canonicalUri, canonicalQueryString, payload) {
  const dateTime = getDateTime();
  const date = dateTime.slice(0, 8);
  const payloadHash = sha256(payload);

  // 1. 构造 CanonicalRequest
  const canonicalHeaders = 
    `content-type:application/json; charset=utf-8\n` +
    `host:${HOST}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${dateTime}\n`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // 2. 构造 StringToSign
  const credentialScope = `${date}/${REGION}/${SERVICE}/request`;
  const stringToSign = [
    'HMAC-SHA256',
    dateTime,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  // 3. 计算签名
  const kDate = hmacSha256(SECRET_KEY, date);
  const kRegion = hmacSha256(kDate, REGION);
  const kService = hmacSha256(kRegion, SERVICE);
  const kSigning = hmacSha256(kService, 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  // 4. 构造 Authorization
  const authorization = 
    `HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    dateTime,
    payloadHash,
  };
}

// 调用 ListSpeakers API
async function listSpeakers(resourceId, page = 1, limit = 100) {
  const action = 'ListSpeakers';
  const version = '2025-05-20';
  const canonicalUri = '/';
  const canonicalQueryString = `Action=${action}&Version=${version}`;
  const payload = JSON.stringify({
    ResourceIDs: [resourceId],
    Page: page,
    Limit: limit,
  });

  const { authorization, dateTime, payloadHash } = signV4('POST', canonicalUri, canonicalQueryString, payload);

  const url = `https://${HOST}/?${canonicalQueryString}`;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Host': HOST,
    'X-Date': dateTime,
    'X-Content-Sha256': payloadHash,
    'Authorization': authorization,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
  });

  const text = await response.text();
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`JSON解析失败: ${text.slice(0, 500)}`);
  }

  if (data.ResponseMetadata?.Error) {
    throw new Error(`API错误: ${data.ResponseMetadata.Error.Message || JSON.stringify(data.ResponseMetadata.Error)}`);
  }

  return data.Result;
}

// 获取全量音色（分页）
async function fetchAllSpeakers(resourceId) {
  const allSpeakers = [];
  let page = 1;
  const limit = 100;
  let total = 0;

  console.log(`\n📋 正在获取 ${resourceId} 的音色列表...`);

  do {
    const result = await listSpeakers(resourceId, page, limit);
    
    if (!result || !result.Speakers) {
      console.log(`  ⚠️ 第 ${page} 页无数据`);
      break;
    }

    total = result.Total || 0;
    allSpeakers.push(...result.Speakers);
    console.log(`  第 ${page} 页: 获取 ${result.Speakers.length} 个音色 (累计 ${allSpeakers.length}/${total})`);

    page++;
    // 防止无限循环
    if (page > 50) {
      console.log(`  ⚠️ 已获取50页，停止翻页`);
      break;
    }
    // 间隔避免频率限制
    await new Promise(r => setTimeout(r, 200));
  } while (allSpeakers.length < total);

  console.log(`  ✅ ${resourceId} 共获取 ${allSpeakers.length} 个音色`);
  return allSpeakers;
}

// 将火山API返回的音色数据映射为数据库格式
function mapSpeakerToVoice(speaker, resourceId) {
  const voiceType = speaker.VoiceType || '';
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
  
  // 合并标签
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
  
  // 确定音色类型
  let type = 'official';
  if (voiceType.startsWith('ICL_') || voiceType.startsWith('icl_')) {
    type = 'icl';
  }
  
  // 描述
  const description = speaker.Description || '';
  
  // 头像
  const avatar = speaker.Avatar || null;

  return {
    speakerId: voiceType,
    name,
    description,
    type,
    category,
    tags: JSON.stringify([...new Set(tags)]), // 去重
    language,
    gender,
    avatar,
    isActive: true,
  };
}

// 同步到数据库
async function syncToDatabase(speakers, resourceId) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  console.log(`\n💾 正在同步 ${speakers.length} 个音色到数据库...`);

  for (const speaker of speakers) {
    const voiceData = mapSpeakerToVoice(speaker, resourceId);
    
    if (!voiceData.speakerId) {
      skipped++;
      continue;
    }

    try {
      const result = await prisma.voice.upsert({
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
          isActive: true,
        },
      });
      
      if (result.createdAt === result.updatedAt) {
        created++;
      } else {
        updated++;
      }
    } catch (err) {
      console.log(`  ⚠️ 跳过 ${voiceData.speakerId}: ${err.message}`);
      skipped++;
    }
  }

  console.log(`  ✅ 新增: ${created} | 更新: ${updated} | 跳过: ${skipped}`);
  return { created, updated, skipped };
}

// 主函数
async function main() {
  console.log('🚀 火山引擎全量音色同步工具');
  console.log('============================');
  console.log(`AccessKey: ${ACCESS_KEY.slice(0, 8)}...${ACCESS_KEY.slice(-4)}`);
  console.log(`Region: ${REGION}`);
  console.log(`Service: ${SERVICE}`);

  try {
    // 获取 TTS 2.0 音色
    const ttsSpeakers = await fetchAllSpeakers('seed-tts-2.0');
    
    // 获取 ICL 2.0 音色
    let iclSpeakers = [];
    try {
      iclSpeakers = await fetchAllSpeakers('seed-icl-2.0');
    } catch (err) {
      console.log(`\n⚠️ ICL音色获取失败（可能未开通）: ${err.message}`);
    }

    // 合并所有音色
    const allSpeakers = [...ttsSpeakers, ...iclSpeakers];
    console.log(`\n📊 总计获取 ${allSpeakers.length} 个音色`);

    // 同步到数据库
    const result = await syncToDatabase(allSpeakers, 'mixed');

    // 统计
    const dbCount = await prisma.voice.count();
    console.log(`\n============================`);
    console.log(`✅ 同步完成！`);
    console.log(`   数据库总音色数: ${dbCount}`);
    console.log(`   本次新增: ${result.created}`);
    console.log(`   本次更新: ${result.updated}`);
    console.log(`   跳过: ${result.skipped}`);
  } catch (error) {
    console.error(`\n❌ 同步失败: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
