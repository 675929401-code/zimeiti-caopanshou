/**
 * 火山引擎 ListSpeakers API - 全量音色获取并同步到数据库
 * 
 * 关键修复：SecretKey使用base64原始字符串（不解码）
 * Service: speech_saas_prod, Region: cn-beijing
 */

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ACCESS_KEY = process.env.VOLC_ACCESS_KEY?.trim() ?? '';
const SECRET_KEY = process.env.VOLC_SECRET_KEY_B64?.trim() ?? '';
if (!ACCESS_KEY || !SECRET_KEY) {
  throw new Error('VOLC_ACCESS_KEY and VOLC_SECRET_KEY_B64 are required');
}

const REGION = 'cn-beijing';
const SERVICE = 'speech_saas_prod';
const HOST = 'open.volcengineapi.com';
const QUERY = 'Action=ListSpeakers&Version=2025-05-20';

function sha256Hex(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

async function listSpeakers(resourceId, page = 1, limit = 100) {
  const now = new Date();
  const dateTime = now.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
  const date = dateTime.slice(0, 8);

  const bodyStr = JSON.stringify({
    ResourceIDs: [resourceId],
    Page: page,
    Limit: limit,
  });
  const bodyHash = sha256Hex(bodyStr);

  const canonicalHeaders = 
    'content-type:application/json; charset=utf-8\n' +
    `host:${HOST}\n` +
    `x-content-sha256:${bodyHash}\n` +
    `x-date:${dateTime}\n`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';

  const canonicalRequest = [
    'POST', '/', QUERY, canonicalHeaders, signedHeaders, bodyHash,
  ].join('\n');

  const credentialScope = `${date}/${REGION}/${SERVICE}/request`;

  const stringToSign = [
    'HMAC-SHA256', dateTime, credentialScope, sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(SECRET_KEY, date);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');

  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${HOST}/?${QUERY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Host': HOST,
      'X-Date': dateTime,
      'X-Content-Sha256': bodyHash,
      'Authorization': authorization,
    },
    body: bodyStr,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`JSON parse error: ${text.slice(0, 300)}`);
  }

  if (data.ResponseMetadata?.Error) {
    throw new Error(`API Error: ${data.ResponseMetadata.Error.Message} (Code: ${data.ResponseMetadata.Error.Code})`);
  }

  return data.Result;
}

async function fetchAllSpeakers(resourceId, label) {
  const allSpeakers = [];
  let page = 1;
  const limit = 100;
  let total = 0;

  console.log(`\n--- Fetching ${label} (${resourceId}) ---`);

  do {
    const result = await listSpeakers(resourceId, page, limit);
    
    if (!result || !result.Speakers || result.Speakers.length === 0) {
      console.log(`  Page ${page}: no data, stopping`);
      break;
    }

    total = result.Total || 0;
    allSpeakers.push(...result.Speakers.map(s => ({ ...s, _resourceId: resourceId })));
    console.log(`  Page ${page}: ${result.Speakers.length} speakers (total ${allSpeakers.length}/${total})`);

    page++;
    await new Promise(r => setTimeout(r, 300));
    if (page > 50) {
      console.log('  Safety limit: 50 pages');
      break;
    }
  } while (allSpeakers.filter(s => s._resourceId === resourceId).length < total);

  return allSpeakers;
}

async function syncToDatabase(speakers) {
  let upserted = 0, skipped = 0;

  console.log(`\n--- Syncing ${speakers.length} voices to database ---`);

  for (const speaker of speakers) {
    const voiceType = speaker.VoiceType || '';
    if (!voiceType) { skipped++; continue; }

    let category = '通用场景';
    let tags = [];
    if (speaker.Categories?.length > 0) {
      const cats = speaker.Categories.flatMap(c => c.Categories || []);
      if (cats.length > 0) { category = cats[0]; tags = cats; }
    }
    if (speaker.NormalLabels) tags.push(...speaker.NormalLabels);
    if (speaker.SpecialLabels) tags.push(...speaker.SpecialLabels);

    let language = 'zh-cn';
    if (speaker.Languages?.length > 0) {
      language = speaker.Languages[0].Language || 'zh-cn';
    }

    let gender = null;
    if (speaker.Gender === '女') gender = 'female';
    else if (speaker.Gender === '男') gender = 'male';

    let type = 'official';
    if (voiceType.startsWith('ICL_') || voiceType.startsWith('icl_')) type = 'icl';

    try {
      await prisma.voice.upsert({
        where: { speakerId: voiceType },
        create: {
          speakerId: voiceType,
          name: speaker.Name || voiceType,
          description: speaker.Description || '',
          type,
          category,
          tags: JSON.stringify([...new Set(tags)]),
          language,
          gender,
          avatar: speaker.Avatar || null,
          isActive: true,
        },
        update: {
          name: speaker.Name || voiceType,
          description: speaker.Description || '',
          category,
          tags: JSON.stringify([...new Set(tags)]),
          language,
          gender,
          avatar: speaker.Avatar || null,
        },
      });
      upserted++;
    } catch (err) {
      console.log(`  Skip ${voiceType}: ${err.message.slice(0, 60)}`);
      skipped++;
    }
  }

  const dbCount = await prisma.voice.count();
  console.log(`\n✅ Done! DB total: ${dbCount}, upserted: ${upserted}, skipped: ${skipped}`);
  return dbCount;
}

async function main() {
  console.log('=== 火山引擎全量音色同步 ===');
  console.log(`AK: ${ACCESS_KEY.slice(0, 12)}...${ACCESS_KEY.slice(-4)}`);
  console.log(`SK: ${SECRET_KEY.slice(0, 8)}...${SECRET_KEY.slice(-4)} (base64原值)`);

  // 获取前数据库数量
  const beforeCount = await prisma.voice.count();
  console.log(`\n数据库当前音色数: ${beforeCount}`);

  // 1. seed-tts-2.0 (官方音色)
  const ttsSpeakers = await fetchAllSpeakers('seed-tts-2.0', '官方TTS音色');

  // 2. seed-icl-2.0 (复刻音色)
  let iclSpeakers = [];
  try {
    iclSpeakers = await fetchAllSpeakers('seed-icl-2.0', 'ICL复刻音色');
  } catch (err) {
    console.log(`\nICL fetch failed: ${err.message}`);
  }

  // 3. 可能的其他resource
  let extraSpeakers = [];
  for (const resId of ['seed-tts', 'speech_tts', 'tts']) {
    try {
      const test = await listSpeakers(resId, 1, 3);
      if (test?.Speakers?.length > 0) {
        console.log(`\n  Found additional resource: ${resId} (total: ${test.Total})`);
        extraSpeakers = await fetchAllSpeakers(resId, `额外资源(${resId})`);
      }
    } catch {
      // ignore
    }
  }

  const allSpeakers = [...ttsSpeakers, ...iclSpeakers, ...extraSpeakers];
  
  // 去重
  const unique = new Map();
  allSpeakers.forEach(s => {
    const id = s.VoiceType;
    if (id && !unique.has(id)) unique.set(id, s);
  });
  
  console.log(`\n=== 汇总 ===`);
  console.log(`  seed-tts-2.0: ${ttsSpeakers.length}`);
  console.log(`  seed-icl-2.0: ${iclSpeakers.length}`);
  console.log(`  额外资源: ${extraSpeakers.length}`);
  console.log(`  合计(含重复): ${allSpeakers.length}`);
  console.log(`  去重后: ${unique.size}`);

  // 预览前20个
  console.log('\nPreview (first 20):');
  [...unique.values()].slice(0, 20).forEach((s, i) => {
    const lang = s.Languages?.[0]?.Language || '?';
    console.log(`  ${i+1}. ${s.VoiceType} | ${s.Name} | ${s.Gender || '?'} | ${lang} | ${s._resourceId}`);
  });

  // 保存JSON备份
  const fs = require('fs');
  const backupPath = 'scripts/voices-full-backup.json';
  fs.writeFileSync(backupPath, JSON.stringify([...unique.values()], null, 2));
  console.log(`\n备份已保存: ${backupPath}`);

  // 同步到数据库
  await syncToDatabase([...unique.values()]);
  
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
